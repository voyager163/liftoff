import path from 'node:path';
import type { ExecutionContext } from '../context.js';
import { loadManifest } from '../project/manifest.js';
import { ProjectFileTransactionError } from '../../adapters/filesystem/project-transaction.js';
import { captureReviewedSnapshot as captureProjectFileSnapshot } from '../execution/plan-binding.js';
import { applyReviewedExecution, requestReviewedFileApproval } from '../execution/kernel.js';
import { withCooperatingExecutionLock } from '../execution/cross-writers.js';
import { reviewedPlanMatches } from '../../domain/execution/immutable-plan.js';
import { operationFailureOutcome } from '../../domain/execution/operation-outcome.js';
import { createScopedUserLocalRecordStore, type UpdatePreviewOptions } from '../../adapters/filesystem/update-previews.js';
import { repairExecutionIdentity, repairSchemaVersions } from '../../domain/repair/identity.js';
import { liftoffVersion } from '../../version.js';
import { NodeCommandRunner } from '../../process-runner.js';
import { inspectAzureBaselineSettings, azureBaselineProviderContract } from './baseline-settings.js';
import {
  baselineValidationPolicy, readBaselineVerification, saveBaselineVerification, validateAzureBaselineCandidate
} from './baseline-validation.js';
import {
  buildRepairPreview, loadRepairPreview, mutationDescriptors, repairApprovalStore, repairHistoryRoot,
  type RepairPreview
} from './preview.js';
import { repairHistoryMutations } from './history.js';
import { preserveRepairOriginals } from './backup.js';
import { assertRepairReadback } from './readback.js';
import { requestRepairApproval } from './approval.js';
import { repairCommandAction } from './guidance.js';
import { repairCapabilities } from './capabilities.js';
import { emitRepairReport, type RepairNextAction, type RepairReport } from './report.js';
import type { RepairRequest } from './request.js';
import type { UpdateApprovalResult } from '../update/approval.js';

export async function repairAzureBaseline(input: {
  root: string; request: RepairRequest; context: ExecutionContext; storage: UpdatePreviewOptions;
  saved?: RepairPreview; broader: RepairNextAction[];
}): Promise<number> {
  const { root, request, context, broader } = input;
  const now = () => context.updateNow?.() ?? new Date();
  const storage = { ...input.storage, clock: now };
  const identity = repairExecutionIdentity(liftoffVersion, 'azure-baseline-settings');
  let committed = false, verified = false;
  let approval: UpdateApprovalResult | undefined;
  let backupPath: string | undefined;
  let effects: NonNullable<RepairReport['verificationEffects']> = {
    attempted: false, networkAuthorized: false, dependencyPreparationAuthorized: false, outcome: 'not-run',
    boundary: 'Private validation is not an OS/network sandbox. Its authorized effects are not undone by declining file approval. No live state, plan, apply or deployed-Azure compliance is claimed.'
  };
  const report = (): RepairReport => ({
    schemaVersion: repairSchemaVersions.report,
    operationKind: request.verifyPlan ? 'verify' : request.approvePlan ? 'apply' : 'check',
    requestedScope: 'local-infrastructure', projectRoot: root, status: 'blocked', committed,
    repairScopeComplete: false, verification: verified ? 'passed' : effects.attempted ? 'incomplete' : 'not-run',
    identity, capabilities: repairCapabilities, message: '', blockers: [], nextActions: broader,
    verificationEffects: effects, ...(approval ? { approval } : {}), ...(backupPath ? { backupPath } : {})
  });
  const emit = (value: RepairReport) => emitRepairReport(context, request.json, value);
  const inspect = async () => {
    const before = await captureProjectFileSnapshot(root, ['liftoff.manifest.json'], 4 * 1024 * 1024);
    const manifest = await loadManifest(root);
    const candidate = await inspectAzureBaselineSettings(root, manifest);
    const observed = await captureProjectFileSnapshot(root, ['liftoff.manifest.json'], 4 * 1024 * 1024);
    if (!before.content || !observed?.content?.equals(before.content) || before.mode !== observed.mode) {
      throw new Error('Manifest changed during baseline inspection; request a fresh review.');
    }
    return { candidate, manifest, originalManifest: before.content };
  };
  try {
    const inspected = await inspect();
    const { candidate, manifest, originalManifest } = inspected;
    if (candidate.blockers.length) {
      emit({ ...report(), message: 'Baseline inspection is blocked; no process or file transaction ran.', blockers: candidate.blockers });
      return 2;
    }
    if (!candidate.changes.length && !input.saved) {
      emit({
        ...report(), status: 'current', repairScopeComplete: true, verification: 'not-required',
        message: 'No baseline settings changes are required under the pinned provider contract. This is configuration inspection, not deployed-Azure verification.'
      });
      return 0;
    }
    const policy = await baselineValidationPolicy(root, context.env);
    const makePreview = (current: typeof inspected, validation: typeof policy, date: Date) => buildRepairPreview({
      projectRoot: root, recipe: 'azure-baseline-settings',
      snapshots: current.candidate.snapshots, mutations: current.candidate.mutations,
      scope: {
        layout: current.candidate.layout, changes: current.candidate.changes,
        directoryInventory: current.candidate.directoryInventory, statePaths: current.candidate.statePaths,
        providerContract: azureBaselineProviderContract,
        environments: current.manifest.project.workload.kind === 'components' ? [] : current.manifest.project.workload.environments
      },
      verificationPolicy: validation, live: false, now: date
    });
    const preview = makePreview(inspected, policy, input.saved ? new Date(input.saved.createdAt) : now());
    if (input.saved && !reviewedPlanMatches(input.saved, preview)) throw new Error('Baseline files, modes, directories, manifest, tool or exact effects changed after preview.');
    const assertCurrent = async () => {
      await loadRepairPreview(root, preview.fingerprint, now(), storage);
      const current = await inspect();
      if (current.candidate.blockers.length) throw new Error(current.candidate.blockers.join(' '));
      if (!reviewedPlanMatches(preview, makePreview(current, await baselineValidationPolicy(root, context.env), new Date(preview.createdAt)))) {
        throw new Error('Baseline files, modes, directories, manifest, tool or exact effects changed after preview.');
      }
    };
    const actions = [
      repairCommandAction(root, ['--verify-plan', preview.fingerprint, '--allow-dependency-preparation', '--allow-network'], {
        id: 'baseline-verify', label: 'Separately authorize exact private validation', approvalRequired: true,
        description: 'Authorizes only the displayed OpenTofu checks, locked provider preparation and network effects. No project file commit.'
      }),
      repairCommandAction(root, ['--approve-plan', preview.fingerprint], {
        id: 'baseline-apply', label: 'Separately approve verified file changes', approvalRequired: true,
        description: 'Requires fresh matching private validation. File approval never starts validation or provider downloads.'
      }),
      ...broader
    ];
    const detail = () => ({
      fingerprint: preview.fingerprint, expiresAt: preview.expiresAt,
      operations: mutationDescriptors(candidate.mutations), validationPolicy: policy,
      validationSummary: [
        policy.effects,
        `Identified OpenTofu executable: ${policy.tool.file.path}; SHA-256 ${policy.tool.file.digest}.`,
        ...candidate.changes.map((change) => `${change.resourceType}.${change.resourceName}.${change.attribute}: ${change.action} ${JSON.stringify(change.targetValue)}.`),
        'Only the displayed attribute value ranges or missing attributes change. No formatting runs; the validated bytes must remain exactly those reviewed before file approval.'
      ],
      nextActions: actions
    });
    if (!input.saved) {
      const receipt = await createScopedUserLocalRecordStore(root, 'repair-preview', storage).write(preview.fingerprint, preview);
      emit({ ...report(), ...detail(), status: 'available', receiptPath: receipt.path, message: 'Review the exact baseline correction. No process, provider download or project-file transaction has run.' });
      if (request.check || request.json) return 2;
    }
    verified = await readBaselineVerification(preview, now(), storage);
    if (request.approvePlan && !verified) {
      emit({ ...report(), ...detail(), message: 'File approval does not authorize validation. Independently approved matching successful private validation is required first.' });
      return 2;
    }
    if (!verified) {
      let dependencyPreparation = request.verifyPlan ? request.allowDependencyPreparation === true : false;
      let network = request.verifyPlan ? request.allowNetwork === true : false;
      if (!request.verifyPlan) {
        for (const message of [
          'Prepare the displayed locked OpenTofu provider dependencies in a private candidate?',
          'Run the displayed backend-disabled OpenTofu validation against the exact private candidate, without file approval?',
          'Additionally allow the displayed provider-download network effects for this exact validation?'
        ]) {
          approval = await requestRepairApproval(request, preview.fingerprint, message, context);
          if (approval.status !== 'approved') {
            emit({ ...report(), ...detail(), message: 'Separate validation consent was not granted. No provider preparation, validation or file transaction ran.' });
            return 2;
          }
          await assertCurrent();
        }
        dependencyPreparation = true;
        network = true;
      }
      if (!dependencyPreparation || !network) {
        emit({ ...report(), ...detail(), message: 'Exact validation requires separate dependency-preparation and network permissions before any command runs.' });
        return 2;
      }
      const result = await withCooperatingExecutionLock(root, async () => {
        effects = { ...effects, attempted: true, dependencyPreparationAuthorized: true, networkAuthorized: true, outcome: 'incomplete' };
        return validateAzureBaselineCandidate(root, candidate,
          manifest.project.workload.kind === 'components' ? [] : manifest.project.workload.environments,
          policy, preview, context.runner ?? new NodeCommandRunner(), {
            storage, env: context.env, allowValidation: true, allowDependencyPreparation: true, allowNetwork: true, assertCurrent
          });
      }, { currentCommand: 'repair', storage });
      if (!result.passed) {
        emit({
          ...report(), ...detail(), status: 'partial',
          message: 'Private baseline validation failed or cleanup is incomplete. No project-file transaction was authorized.',
          blockers: result.blockers,
          validationSummary: [...detail().validationSummary, ...result.commands.map((command) =>
            `OpenTofu ${command.operation}${command.environment ? ` (${command.environment})` : ''}: ${command.passed ? 'passed' : 'failed'}.`)]
        });
        return 2;
      }
      await assertCurrent();
      await saveBaselineVerification(preview, now(), storage);
      verified = true;
      effects = { ...effects, outcome: 'passed' };
    }
    if (request.verifyPlan || !request.json) {
      emit({ ...report(), ...detail(), status: 'verified', message: 'The exact reviewed bytes passed private backend-disabled validation and cleanup. The project-file transaction has not run.' });
    }
    if (request.verifyPlan) return 0;
    if (request.approvePlan) approval = await requestReviewedFileApproval({
      kind: 'repair', projectRoot: root, fingerprint: preview.fingerprint, approvePlan: request.approvePlan
    }, { stderr: context.stderr });
    else {
      approval = await requestRepairApproval(request, preview.fingerprint,
        'Apply only the reviewed, successfully validated baseline file changes, private originals and immutable history?', context, root);
      if (approval.status !== 'approved') {
        emit({ ...report(), ...detail(), message: 'File approval was not granted. Earlier separately authorized private validation ran; no project-file transaction committed.' });
        return 2;
      }
    }
    await assertCurrent();
    if (!await readBaselineVerification(preview, now(), storage)) throw new Error('Matching baseline validation is no longer available.');
    const changedPaths = new Set(candidate.mutations.map((entry) => entry.pathParts.join('/')));
    const backup = await preserveRepairOriginals(preview, candidate.snapshots.filter((entry) => changedPaths.has(entry.pathParts.join('/'))), storage);
    backupPath = backup.path;
    const history = repairHistoryMutations({
      preview, sourceManifest: originalManifest, snapshots: candidate.snapshots, mutations: candidate.mutations,
      verificationPolicy: policy, backupIndexKey: backup.indexKey
    });
    const historySnapshots = await Promise.all(history.map((entry) => captureProjectFileSnapshot(root, entry.pathParts)));
    if (historySnapshots.some((entry) => entry.content !== undefined)) throw new Error('Repair history is immutable and already exists.');
    const mutations = [...history, ...candidate.mutations], snapshots = [...candidate.snapshots, ...historySnapshots];
    const outcome = await applyReviewedExecution(root, mutations, {
      transactionKind: 'repair', repairIdentity: identity, planFingerprint: preview.fingerprint,
      approval: approval!, approvalStore: repairApprovalStore(root, storage), preconditions: snapshots, storage,
      validatePlan: async () => {
        await assertCurrent();
        if (!await readBaselineVerification(preview, now(), storage)) throw new Error('Baseline validation expired before commit.');
      },
      verifyCommitted: () => assertRepairReadback(root, mutations, snapshots)
    });
    committed = outcome.committed;
    if (!committed) throw new Error('The approved baseline transaction did not commit; use the registered repair recovery.');
    emit({
      ...report(), ...detail(), operationKind: 'apply', status: outcome.operation.status === 'completed' ? 'applied' : 'partial',
      verification: outcome.operation.verification === 'passed' ? 'passed' : 'incomplete',
      repairScopeComplete: outcome.operation.status === 'completed', historyPath: path.join(root, ...repairHistoryRoot, preview.fingerprint),
      message: outcome.operation.status === 'completed'
        ? 'Only the verified baseline attributes and registered history committed. Original provenance is preserved; deployed Azure is not qualified.'
        : 'The baseline file transaction committed, but current readback or cleanup remains incomplete. Original provenance and later edits were preserved; deployed Azure is not qualified.',
      blockers: outcome.cleanupFailures
    });
    return outcome.cleanupFailures.length ? 2 : 0;
  } catch (error) {
    const failure = operationFailureOutcome({
      committed, attemptedEffects: effects.attempted,
      rollbackFailures: error instanceof ProjectFileTransactionError ? error.rollbackFailures : undefined
    });
    emit({
      ...report(), ...failure,
      message: 'Baseline repair stopped. Concurrent edits and any earlier authorized private effects are preserved.',
      blockers: [error instanceof Error ? error.message : 'Unexpected baseline repair failure.']
    });
    return failure.status === 'partial' ? 2 : 1;
  }
}
