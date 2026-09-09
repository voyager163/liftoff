import path from 'node:path';
import {
  consumeUpdatePreviewReceipt,
  createUpdateTransactionApprovalStore,
  issueUpdatePreviewReceipt,
  loadUpdatePreviewReceipt,
  resolveUpdatePreviewLocation,
  type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import {
  applyReviewedUpdateTransaction,
  inspectReviewedUpdateTransaction,
  recoverReviewedUpdateTransaction
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import { findProjectRoot } from '../../adapters/filesystem/project-discovery.js';
import { manifestDisplayPath } from '../../domain/project/paths.js';
import type { ExecutionContext } from '../context.js';
import { loadManifest } from '../project/manifest.js';
import { requestUpdateApproval } from './approval.js';
import { inspectProjectUpdate, UpdatePlanError, type UpdateInspection } from './inspection.js';
import {
  buildUpdateReport, renderUpdateApprovalScope, renderUpdatePreview, renderUpdateSkipped,
  type UpdateMigrationSummary, type UpdateRevalidationSummary, type UpdateReportInput
} from './output.js';
import { assertAuthorizedUpdateMutations, preflightUpdate } from './planning.js';
import { matchUpdatePreviewReceipt, UpdatePreviewError } from './preview.js';
import { prepareUpdateReview, type ReviewedUpdatePlan } from './review-plan.js';
import { entryDisplay, maybeInjectUpdateFailure } from './reporting.js';
import {
  describeUpdateMigration, describeUpdateRevalidation, materializeUpdateMutations,
  runUpdateRevalidation, verifyHistoryBeforeReplacement
} from './migration-runtime.js';

export interface UpdateRequest {
  check: boolean;
  force: boolean;
  jsonMode: boolean;
  project?: string;
  approvePlan?: string;
}

function storeOptions(context: ExecutionContext, inspection?: UpdateInspection): UpdatePreviewOptions {
  return {
    ...context.updatePreview,
    env: context.updatePreview?.env ?? context.env,
    clock: context.updatePreview?.clock ?? context.updateNow,
    ...(inspection?.repositoryRoot ? { repositoryRoot: inspection.repositoryRoot } : {})
  };
}

function emit(
  context: ExecutionContext,
  jsonMode: boolean,
  report: UpdateReportInput,
  inspection?: UpdateInspection,
  review?: ReviewedUpdatePlan
): void {
  if (jsonMode) {
    context.presentation.rawStdout(`${JSON.stringify(buildUpdateReport(report, inspection, review?.writePlan), null, 2)}\n`);
  } else if (report.message) {
    if (report.status === 'blocked' || report.status === 'failed') {
      context.presentation.error(report.message, report.remedy);
    } else {
      context.presentation.status(report.status === 'partial' ? 'warning' : 'success', 'Project update', report.message);
      if (report.remedy) context.presentation.remedy(report.remedy);
    }
  }
}

export async function updateProject(request: UpdateRequest, context: ExecutionContext): Promise<number> {
  const { presentation } = context;
  const { check, force, jsonMode } = request;
  presentation.commandIdentity('update', 'Preview and explicitly approve scoped project updates');
  let projectRoot = request.project ? path.resolve(context.cwd, request.project) : context.cwd;
  let inspection: UpdateInspection | undefined;
  let selected: ReviewedUpdatePlan | undefined;
  let committed = false;
  let migration: UpdateMigrationSummary | undefined;
  let revalidation: UpdateRevalidationSummary | undefined;
  try {
    if (check && (force || request.approvePlan !== undefined)) {
      throw new UpdatePlanError(
        '--check cannot be combined with --force or --approve-plan.',
        'invalid-update-options', 'Run liftoff update --check before explicitly approving an apply plan.'
      );
    }
    const discovered = request.project ? projectRoot : await findProjectRoot(context.cwd);
    if (!discovered) {
      throw new UpdatePlanError(
        `No liftoff.manifest.json found in ${context.cwd} or any parent directory.`,
        'project-not-found', 'Run inside a Liftoff project or supply its path.'
      );
    }
    projectRoot = discovered;
    await loadManifest(projectRoot);
    const initialOptions = storeOptions(context);
    const approvalStore = createUpdateTransactionApprovalStore(projectRoot, initialOptions);
    const recovery = await inspectReviewedUpdateTransaction(projectRoot, { approvalStore });
    if (recovery.status !== 'absent') {
      if (check || recovery.status === 'blocked') {
        emit(context, jsonMode, {
          mode: check ? 'check' : 'apply', status: 'blocked',
          reasonCode: 'transaction-recovery-required', projectRoot, committed: recovery.committed,
          message: recovery.reason ?? 'An interrupted approved update requires bounded recovery.',
          remedy: 'Review the reported transaction and run liftoff update for recovery; then run a fresh check.'
        });
        return 1;
      }
      const outcome = await recoverReviewedUpdateTransaction(projectRoot, { approvalStore });
      emit(context, jsonMode, {
        mode: 'apply', status: outcome.status === 'blocked' ? 'failed' : 'partial',
        reasonCode: 'transaction-recovery', projectRoot, committed: outcome.committed,
        message: outcome.status === 'blocked'
          ? outcome.rollbackFailures.join('; ')
          : 'Recovered the previously approved transaction; no new update was started.',
        warnings: outcome.cleanupFailures,
        remedy: 'Run liftoff update --check before approving new work.'
      });
      return outcome.status === 'blocked' ? 1 : 2;
    }

    inspection = await inspectProjectUpdate(projectRoot, { runner: context.runner });
    projectRoot = inspection.projectRoot;
    const options = storeOptions(context, inspection);
    const reviewOptions = { runner: context.runner, now: context.updateNow?.() ?? new Date() };
    const normal = await prepareUpdateReview(inspection, false, reviewOptions);
    const forced = await prepareUpdateReview(inspection, true, reviewOptions);
    const variants = [normal, forced];
    const hasWork = inspection.hasDrift || variants.some((entry) => entry.requiresApproval);
    const plans = hasWork ? variants.map((entry) => entry.summary) : [];
    selected = force ? forced : normal;
    migration = describeUpdateMigration(inspection);
    committed = migration.status === 'committed';
    revalidation = describeUpdateRevalidation(selected);
    const base = {
      mode: check ? 'check' as const : 'apply' as const, projectRoot,
      plans, selectedPlanFingerprint: selected.descriptor.fingerprint, migration, revalidation
    };
    if (!selected.summary.eligible && (!check || !variants.some((entry) => entry.summary.eligible))) {
      emit(context, jsonMode, {
        ...base, status: 'blocked', reasonCode: 'incompatible-update',
        message: selected.summary.blockers.join('; '),
        remedy: inspection.reconciliation.remedy
      }, inspection, selected);
      return 1;
    }
    if (check) {
      const stored = hasWork
        ? await issueUpdatePreviewReceipt(projectRoot,
          variants.filter((entry) => entry.summary.eligible).map((entry) => entry.descriptor), options)
        : undefined;
      if (!jsonMode) {
        renderUpdatePreview(presentation, inspection, plans, migration, revalidation, stored?.location.receiptPath);
        if (!hasWork) {
          presentation.status('success', 'Liftoff core is current',
            `${inspection.summary.unchanged} managed-core artifacts match; project files are not compared`);
        } else {
          presentation.status('warning', 'Liftoff core maintenance available',
            `${inspection.summary.conflict + inspection.summary.retiredConflict} core conflict(s); review the exact plans before approval`);
        }
      }
      emit(context, jsonMode, {
        ...base,
        status: hasWork ? 'update-available' : 'current',
        reasonCode: hasWork ? 'review-required' : 'no-update',
        receipt: stored ? { status: 'issued', path: stored.location.receiptPath } : { status: 'not-required' }
      }, inspection, selected);
      return hasWork ? 2 : 0;
    }
    if (!selected.requiresApproval) {
      if (!jsonMode) renderUpdateSkipped(presentation, inspection, selected.writePlan);
      emit(context, jsonMode, {
        ...base, status: selected.writePlan.skipped.length ? 'partial' : 'current', reasonCode: 'no-update',
        message: selected.writePlan.skipped.length
          ? 'No safe update writes are required; listed conflicts remain protected.'
          : 'Liftoff core is current; project files were not changed.'
      }, inspection, selected);
      return 0;
    }

    const location = await resolveUpdatePreviewLocation(projectRoot, options);
    const stored = await loadUpdatePreviewReceipt(projectRoot, options);
    matchUpdatePreviewReceipt(stored.receipt, selected.descriptor);
    if (inspection.repositoryRoot) {
      const warning = 'If this worktree has uncommitted changes, consider committing or copying them before applying. Liftoff does not commit automatically.';
      if (jsonMode) presentation.rawStderr(`Warning: ${warning}\n`);
      else presentation.warning(warning);
    }
    renderUpdateApprovalScope(presentation, jsonMode, selected.summary, selected.writePlan, [
      ...(migration.operations ?? []).map((entry) => `${entry.type} ${JSON.stringify(entry.path)}`),
      ...revalidation.issues.map((issue) => `Known revalidation gap: ${issue}`),
      ...(revalidation.issues.length ? ['Approval may commit v2 while these known revalidation gaps remain blocked.'] : []),
      ...(revalidation.preview?.effects ?? []),
      ...(revalidation.preview?.phases ?? []).flatMap((phase) =>
        phase.commands.map((entry) =>
          `${entry.command.executable} ${entry.command.args.join(' ')} (directory: ${entry.cwdPathParts.join('/') || '.'})`
        )
      )
    ]);
    const approval = await requestUpdateApproval({
      fingerprint: selected.descriptor.fingerprint, approvePlan: request.approvePlan
    }, context);
    if (approval.status !== 'approved') {
      emit(context, jsonMode, {
        ...base, status: 'blocked', reasonCode: `approval-${approval.status}`,
        receipt: { status: 'matched', path: location.receiptPath }, approval,
        message: approval.status === 'required'
          ? 'Explicit approval of this exact update plan is required.'
          : approval.status === 'mismatch'
            ? 'The approved fingerprint does not match the current effective plan.'
            : 'Update approval was declined or cancelled; no project files changed.',
        remedy: 'Review liftoff update --check, then approve interactively or use --approve-plan with its exact fingerprint.'
      }, inspection, selected);
      return 1;
    }

    presentation.stage('Apply safe Liftoff core changes', projectRoot);
    await preflightUpdate(projectRoot, inspection.entries, force, inspection.oldByName);
    maybeInjectUpdateFailure(context.env, 'after-preflight');
    const materialized = materializeUpdateMutations(inspection, selected, context.updateNow?.() ?? new Date());
    const migrationPaths = inspection.historyMigration.status === 'eligible'
      ? [
          ...inspection.historyMigration.index.files.map((file) => file.copyPathParts),
          ...inspection.historyMigration.requiredRetirements.map((entry) => entry.pathParts),
          ['governance', 'history', inspection.historyMigration.index.snapshotId, 'index.json'],
          ['governance', 'activation-state.json'], ['governance', 'migration-state.json']
        ]
      : [];
    assertAuthorizedUpdateMutations(materialized.mutations, inspection.entries, inspection.provisioningPlans, [
      ...inspection.stateMigration.mutations.map((mutation) => mutation.pathParts),
      ...migrationPaths
    ]);
    const approvedFingerprint = selected.descriptor.fingerprint;
    const validateReview = async () => {
      const current = await prepareUpdateReview(
        await inspectProjectUpdate(projectRoot, { runner: context.runner }), force,
        { runner: context.runner, now: context.updateNow?.() ?? new Date() }
      );
      if (!current.summary.eligible || current.descriptor.fingerprint !== approvedFingerprint) {
        throw new UpdatePlanError(
          'The effective update plan changed after review.',
          'preview-mismatch', 'Run liftoff update --check again.'
        );
      }
    };
    const cleanupFailures: string[] = [];
    if (materialized.mutations.length) {
      const activeInspection = inspection;
      const outcome = await applyReviewedUpdateTransaction(projectRoot, materialized.mutations, {
        planFingerprint: approvedFingerprint,
        approvalStore: createUpdateTransactionApprovalStore(projectRoot, options),
        preconditions: selected.preconditions,
        validatePlan: validateReview,
        onBeforeMutation: async (mutation, index) => {
          maybeInjectUpdateFailure(context.env, `before-mutation:${index}`);
          maybeInjectUpdateFailure(context.env, `before-path:${mutation.pathParts.join('/')}`);
          await verifyHistoryBeforeReplacement(activeInspection, mutation);
        }
      });
      committed = outcome.committed;
      cleanupFailures.push(...outcome.cleanupFailures);
      if (!committed) {
        throw new UpdatePlanError(
          outcome.rollbackFailures.join('; ') || 'The approved update did not commit.',
          'transaction-failed', 'Review the recovery details before running a new check.'
        );
      }
      if (migration.status === 'available') migration = { ...migration, status: 'committed' };
    }
    if (selected.needsRevalidation && !cleanupFailures.length) {
      revalidation = await runUpdateRevalidation(inspection, selected, materialized.mutations, context,
        materialized.mutations.length ? undefined : validateReview);
    }
    await consumeUpdatePreviewReceipt(projectRoot, stored.receipt, options);
    const revalidationBlocked = revalidation.status === 'blocked';
    const partial = revalidationBlocked || selected.writePlan.skipped.length > 0 ||
      inspection.provisioningPlans.some((group) => group.blocked);
    emit(context, jsonMode, {
      ...base, migration, revalidation,
      status: cleanupFailures.length ? 'failed' : partial ? 'partial' : 'applied',
      reasonCode: cleanupFailures.length ? 'transaction-cleanup' :
        revalidationBlocked ? 'revalidation-blocked' : 'approved-update-applied',
      receipt: { status: 'consumed', path: location.receiptPath }, approval, committed,
      warnings: cleanupFailures
    }, inspection, selected);
    if (!jsonMode) {
      if (selected.writePlan.written.length) {
        presentation.bullets('Applied Liftoff core changes',
          selected.writePlan.written.map((entry) => `wrote ${entryDisplay(entry)}`));
      }
      if (selected.writePlan.retired.length) {
        presentation.bullets('Removed retired Liftoff aliases',
          selected.writePlan.retired.map((entry) => `removed ${manifestDisplayPath(entry.pathParts)}`));
      }
      renderUpdateSkipped(presentation, inspection, selected.writePlan);
      if (migration.status === 'committed') {
        presentation.status('success', 'Activation migration committed', 'Original v1 history remains preserved; active v2 readiness is reported separately.');
      }
      if (revalidationBlocked) {
        presentation.bullets('V2 revalidation is blocked and resumable', [
          ...revalidation.issues,
          ...(revalidation.nextPhase ? [`Next incomplete phase: ${revalidation.nextPhase}`] : []),
          'Repair the blocker, run liftoff update --check, and approve the remaining local work.'
        ]);
      }
      for (const failure of cleanupFailures) presentation.error(failure);
      if (!cleanupFailures.length && !revalidationBlocked) {
        presentation.completion('Updated project',
          `${selected.writePlan.written.length} core written, ${selected.writePlan.skipped.length} core skipped`,
          [], 'liftoff validate && liftoff doctor');
      }
    }
    return cleanupFailures.length ? 1 : revalidationBlocked ? 2 : 0;
  } catch (error) {
    const reasonCode = error instanceof UpdatePlanError ? error.reasonCode :
      error instanceof UpdatePreviewError ? error.code : 'update-failed';
    const message = error instanceof Error ? error.message : String(error);
    const remedy = error instanceof UpdatePlanError ? error.remedy :
      error instanceof UpdatePreviewError
        ? 'Repair any reported preview-storage issue, then run liftoff update --check before applying.'
        : 'Review the reported failure. Preserve concurrent edits and run a fresh check after repair.';
    emit(context, jsonMode, {
      mode: check ? 'check' : 'apply', status: 'failed', reasonCode, projectRoot,
      committed, message, remedy, migration, revalidation
    }, inspection, selected);
    return 1;
  }
}
