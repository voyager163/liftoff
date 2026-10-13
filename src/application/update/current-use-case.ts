import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { findProjectRoot } from '../../adapters/filesystem/project-discovery.js';
import {
  createUpdateTransactionApprovalStore, type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import {
  inspectProfileTransitionTransaction,
  inspectReviewedUpdateTransaction
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import { ProjectFileTransactionError } from '../../adapters/filesystem/project-transaction.js';
import { errorMessage } from '../../adapters/filesystem/errors.js';
import { commandShellForPlatform, formatShellCommand } from '../../adapters/process/shell-command.js';
import { detectCredentialLeaks } from '../../governance-activation/credentials.js';
import type { TelemetrySemanticOutcome } from '../../telemetry/contract.js';
import type { ExecutionContext } from '../context.js';
import {
  applyProfileTransitionPlan,
  recoverProfileTransitionJournal,
  recoverProfileTransitionPlan
} from '../profile-transition/execution.js';
import {
  findProfileTransitionPlan,
  prepareProfileTransitionPlan,
  readConfiguredProfileTransitionTarget
} from '../profile-transition/plan.js';
import {
  createProfileTransitionTransactionAuthorityStore
} from '../profile-transition/transaction-authority.js';
import { currentUpdateReportSchemaVersion, currentUpdateRequestIssue, type CurrentUpdateRequest } from './current-request.js';
import { UpdatePreviewError } from './preview.js';
import { UpdatePlanError } from './inspection.js';
import {
  readConfiguredModernUpdateRoute,
  readRecordedModernUpdateSelection
} from './modern-update-selection.js';
import {
  applyModernSuccessorUpdate, previewModernSuccessorUpdate, recoverModernSuccessorUpdate, ModernUpdateRecoveryError
} from './use-case.js';

export async function updateCurrentProject(request: CurrentUpdateRequest, context: ExecutionContext): Promise<number> {
  request = { ...request };
  const mode = request.recover ? 'recover' : request.check ? 'check' : 'apply';
  let projectRoot = path.resolve(context.cwd, request.project ?? '.');
  let executionRequested = false, externalMetadataWriteRequested = false, uncertain = false;
  let committed: boolean | null = false;
  const command = (...args: string[]) => formatShellCommand({
    executable: 'liftoff', args: ['update', '--project', projectRoot, ...args]
  }, commandShellForPlatform(process.platform));
  const emit = (status: string, detail: object, code: number, semantic: TelemetrySemanticOutcome): number => {
    const report = {
      schemaVersion: currentUpdateReportSchemaVersion, kind: 'liftoff-current-project-update', command: 'update',
      mode, projectRoot, status, targetManifestVersion: 8, executionRequested, externalMetadataWriteRequested,
      publicationCommitted: committed, projectFileEffectsUncertain: uncertain,
      localComplete: false, activationComplete: false, lifecycleComplete: false, providerOperationsAuthorized: false,
      boundary: 'Managed core maintenance or one separately selected exact local governance-profile transition only. ' +
        'Configuration and original history remain protected. ' +
        'Core currency and saved progress do not establish local readiness. No application migration, framework execution, ' +
        'directory relocation, provider operation or telemetry enrollment is authorized.',
      ...detail
    };
    let text = `${JSON.stringify(report, null, 2)}\n`;
    if (detectCredentialLeaks([{ source: 'generated-artifact', label: 'update command output', text }]).status === 'compromised') {
      // Preserve effect accounting, but never re-emit an untrusted error or result field.
      const safe = {
        schemaVersion: currentUpdateReportSchemaVersion, kind: report.kind, command: 'update', mode, status: 'failed',
        projectRoot: null, targetManifestVersion: 8, executionRequested, externalMetadataWriteRequested,
        publicationCommitted: committed, projectFileEffectsUncertain: uncertain, operationComplete: false,
        coreUpdateComplete: false, localComplete: false, activationComplete: false, lifecycleComplete: false,
        providerOperationsAuthorized: false, reasonCode: 'credential-output-withheld',
        diagnostics: ['Credential-shaped update output was withheld; inspect the protected transaction checkpoint.']
      };
      text = `${JSON.stringify(safe, null, 2)}\n`;
      status = 'failed'; code = 1; semantic = 'failure';
    }
    if (request.jsonMode) context.presentation.rawStdout(text);
    else {
      context.presentation.status(code === 1 ? 'error' : code === 2 ? 'warning' : 'success', 'Project update', status);
      context.presentation.rawStdout(text);
    }
    context.outcome?.record(semantic);
    return code;
  };
  const selection = { kind: 'recorded-project-intent' } as const;
  const options: UpdatePreviewOptions = {
    ...context.updatePreview,
    env: context.updatePreview?.env ?? context.env,
    clock: context.updatePreview?.clock ?? context.updateNow
  };
  try {
    const issue = currentUpdateRequestIssue(request);
    if (issue) return emit('blocked', { diagnostics: [issue], operationComplete: false, coreUpdateComplete: false }, 1, 'failure');
    if (!request.project && !request.recover) {
      const found = await findProjectRoot(context.cwd);
      if (!found) {
        return emit('blocked', {
          diagnostics: ['No Liftoff manifest found; use an exact project path. Non-Liftoff adoption is a separate operation.'],
          operationComplete: false, coreUpdateComplete: false
        }, 1, 'failure');
      }
      projectRoot = found;
    }
    projectRoot = await realpath(projectRoot);
    const now = options.clock?.() ?? new Date();
    const profileAuthority = createProfileTransitionTransactionAuthorityStore(
      projectRoot,
      options
    );
    if (request.recover) {
      const fingerprint = request.approvePlan;
      if (!fingerprint) throw new Error('Explicit recovery fingerprint is required.');
      executionRequested = true;
      externalMetadataWriteRequested = true;
      committed = null;
      uncertain = true;
      const observedProfileRecovery =
        await inspectProfileTransitionTransaction(
          projectRoot,
          { authorityStore: profileAuthority }
        );
      if (observedProfileRecovery.status !== 'absent') {
        committed = observedProfileRecovery.committed;
        if (observedProfileRecovery.status === 'blocked' ||
            observedProfileRecovery.planFingerprint !== fingerprint) {
          uncertain = true;
          return emit('profile-transition-recovery-blocked', {
            transition: {
              kind: 'governance-profile',
              fingerprint: observedProfileRecovery.planFingerprint ?? null
            },
            recovery: observedProfileRecovery,
            operationComplete: false,
            coreUpdateComplete: false,
            reasonCode: 'profile-transition-recovery-mismatch',
            diagnostics: [
              observedProfileRecovery.reason ??
                'The pending profile-transition journal is not attributable to the selected fingerprint.'
            ],
            remedy: 'Preserve the profile-transition journal and recover only its exact recorded fingerprint.'
          }, 1, 'failure');
        }
      }
      const profilePlan = await findProfileTransitionPlan(
        projectRoot,
        fingerprint,
        now,
        options,
        true
      );
      if (observedProfileRecovery.status !== 'absent') {
        const result = profilePlan
          ? await recoverProfileTransitionPlan(
            projectRoot,
            fingerprint,
            { now, storage: options }
          )
          : await recoverProfileTransitionJournal(
            projectRoot,
            fingerprint,
            { storage: options }
          );
        committed = result.committed;
        uncertain = result.status === 'blocked' ||
          result.rollbackFailures.length > 0 ||
          result.cleanupFailures.length > 0 ||
          result.readbackFailures.length > 0;
        const complete = !uncertain &&
          (result.status === 'rolled-back' || result.status === 'committed');
        return emit(
          complete ? 'profile-transition-recovered' : result.status,
          {
            transition: {
              kind: 'governance-profile',
              ...(profilePlan
                ? {
                  source: profilePlan.source,
                  target: profilePlan.target
                }
                : {}),
              fingerprint
            },
            result,
            operationComplete: complete,
            coreUpdateComplete: false,
            remedy: complete
              ? `Recovery completed. Run ${command('--check')} before approving further work.`
              : 'Preserve the exact profile-transition journal and resolve only its reported recovery blocker.'
          },
          complete ? 2 : 1,
          complete ? 'attention-required' : 'failure'
        );
      }
      const result = await recoverModernSuccessorUpdate({ projectRoot, planFingerprint: fingerprint }, options);
      if ('outcome' in result && result.outcome) {
        committed = result.outcome.committed || result.observedCommitted === true;
        uncertain = result.outcome.status === 'blocked' || result.outcome.rollbackFailures.length > 0 || result.outcome.cleanupFailures.length > 0;
      } else if ('recovery' in result && result.recovery) {
        committed = result.recovery.committed;
        uncertain = result.recovery.status === 'blocked';
      }
      const complete = result.status === 'recovered' && !uncertain;
      return emit(result.status, {
        result, operationComplete: complete, coreUpdateComplete: false,
        remedy: `Recovery does not apply a new plan. Run ${command('--check')} before approving further work.`
      }, complete ? 2 : 1, complete ? 'attention-required' : 'failure');
    }
    const profileRecovery = await inspectProfileTransitionTransaction(
      projectRoot,
      { authorityStore: profileAuthority }
    );
    if (profileRecovery.status !== 'absent') {
      committed = profileRecovery.committed;
      uncertain = profileRecovery.status === 'blocked';
      return emit('profile-transition-recovery-required', {
        transition: {
          kind: 'governance-profile',
          fingerprint: profileRecovery.planFingerprint ?? null
        },
        recovery: profileRecovery,
        operationComplete: false,
        coreUpdateComplete: false,
        remedy: `Review the saved profile-transition journal, then select ${command(
          '--recover',
          '--approve-plan',
          profileRecovery.planFingerprint ?? '<saved-fingerprint>'
        )}.`
      }, 1, profileRecovery.status === 'blocked' ? 'failure' : 'attention-required');
    }
    const approvalStore = createUpdateTransactionApprovalStore(projectRoot, options);
    const recovery = await inspectReviewedUpdateTransaction(projectRoot, { approvalStore });
    if (recovery.status !== 'absent') {
      committed = recovery.committed; uncertain = recovery.status === 'blocked';
      return emit('recovery-required', {
        recovery, operationComplete: false, coreUpdateComplete: false,
        remedy: `Review the saved journal, then select ${command('--recover', '--approve-plan', recovery.planFingerprint ?? '<saved-fingerprint>')}.`
      }, 1, recovery.status === 'blocked' ? 'failure' : 'attention-required');
    }
    const profileTarget = await readConfiguredProfileTransitionTarget(
      projectRoot
    );
    const routed = await readConfiguredModernUpdateRoute(projectRoot);
    if (profileTarget && routed) {
      return emit('multiple-transitions-required', {
        operationComplete: false,
        coreUpdateComplete: false,
        reasonCode: 'separate-transition-selection-required',
        diagnostics: [
          'Configuration requests more than one identity transition. Review and complete one exact profile, workflow or plugin selection at a time.'
        ],
        remedy: `Keep only one requested transition, then run ${command('--check')}.`
      }, 1, 'failure');
    }
    if (routed?.kind === 'workflow-transition') {
      const selectionArgs = [
        ...(routed.agents === undefined
          ? []
          : [
              '--agents',
              routed.agents.length ? routed.agents.join(',') : 'none'
            ]),
        ...(routed.defaultAgent === undefined
          ? []
          : ['--default-agent', routed.defaultAgent])
      ];
      const remedy = formatShellCommand({
        executable: 'liftoff',
        args: [
          'workflow',
          'set',
          routed.target,
          '--project',
          projectRoot,
          ...selectionArgs,
          '--check'
        ]
      }, commandShellForPlatform(process.platform));
      return emit('workflow-transition-required', {
        transition: routed,
        operationComplete: false,
        coreUpdateComplete: false,
        reasonCode: 'workflow-transition-required',
        diagnostics: [
          'Ordinary update and --force cannot change the recorded development workflow.'
        ],
        remedy: `Use the distinct reviewed workflow-transition command: ${remedy}.`
      }, 1, 'attention-required');
    }
    if (routed?.kind === 'plugin-transition') {
      return emit('plugin-transition-unsupported', {
        transition: routed,
        operationComplete: false,
        coreUpdateComplete: false,
        reasonCode: 'plugin-transition-unsupported',
        diagnostics: [
          `Configuration changes ${routed.fields.join(', ')} without a workflow transition. Ordinary update and --force cannot replace the recorded plugin selection.`
        ],
        remedy: 'Run liftoff assess for compatibility findings, then use a supported workflow transition or additive agent repair; no generic plugin-transition executor is available.'
      }, 1, 'failure');
    }
    const selectedProfilePlan = request.approvePlan === undefined
      ? null
      : await findProfileTransitionPlan(
          projectRoot,
          request.approvePlan,
          now,
          options
        );
    if (selectedProfilePlan) {
      if (request.force) {
        return emit('profile-transition-blocked', {
          operationComplete: false,
          coreUpdateComplete: false,
          reasonCode: 'profile-transition-force-forbidden',
          diagnostics: [
            '--force cannot authorize or alter a governance-profile transition.'
          ],
          remedy: `Apply the exact saved plan without --force: ${command(
            '--approve-plan',
            selectedProfilePlan.fingerprint
          )}.`
        }, 1, 'failure');
      }
      executionRequested = true;
      externalMetadataWriteRequested = true;
      committed = null;
      uncertain = true;
      const result = await applyProfileTransitionPlan(
        selectedProfilePlan,
        { now, storage: options }
      );
      committed = result.committed;
      uncertain = result.status === 'blocked' ||
        result.rollbackFailures.length > 0 ||
        result.cleanupFailures.length > 0 ||
        result.readbackFailures.length > 0;
      const complete = result.status === 'committed' && !uncertain;
      return emit(complete ? 'profile-transition-committed' : result.status, {
        transition: {
          kind: 'governance-profile',
          source: selectedProfilePlan.source,
          target: selectedProfilePlan.target,
          fingerprint: selectedProfilePlan.fingerprint,
          evidenceReusableForTarget:
            selectedProfilePlan.evidenceBoundary.reusableForTarget
        },
        result,
        operationComplete: complete,
        coreUpdateComplete: false,
        remedy: complete
          ? 'Local policy identity changed. Reassess the target profile and use a separate governance plan for any live provider enforcement.'
          : 'Preserve any pending profile-transition journal and use exact recovery.'
      }, complete ? 2 : 1, complete ? 'attention-required' : 'failure');
    }
    if (profileTarget) {
      if (request.force) {
        return emit('profile-transition-blocked', {
          operationComplete: false,
          coreUpdateComplete: false,
          reasonCode: 'profile-transition-force-forbidden',
          diagnostics: [
            '--force cannot convert a configured governance-profile change into ordinary maintenance.'
          ],
          remedy: `Run ${command('--check')} and approve the exact profile-transition fingerprint without --force.`
        }, 1, 'failure');
      }
      if (!request.check) {
        return emit('profile-transition-review-required', {
          transition: {
            kind: 'governance-profile',
            target: profileTarget
          },
          operationComplete: false,
          coreUpdateComplete: false,
          reasonCode: 'profile-transition-preview-required',
          diagnostics: [
            'Governance-profile transitions require an immutable preview before exact approval.'
          ],
          remedy: `Run ${command('--check')}.`
        }, 1, 'attention-required');
      }
      externalMetadataWriteRequested = true;
      const prepared = await prepareProfileTransitionPlan(
        projectRoot,
        profileTarget,
        { now, storage: options }
      );
      return emit('profile-transition-review-required', {
        transition: {
          kind: 'governance-profile',
          source: prepared.plan.source,
          target: prepared.plan.target,
          fingerprint: prepared.plan.fingerprint,
          effects: prepared.plan.effects,
          controls: prepared.plan.controls,
          evidenceBoundary: prepared.plan.evidenceBoundary,
          planStoragePath: prepared.path
        },
        operationComplete: true,
        coreUpdateComplete: false,
        remedy: `Review the exact effects, then select ${command(
          '--approve-plan',
          prepared.plan.fingerprint
        )}.`
      }, 2, 'attention-required');
    }
    if (request.check) {
      externalMetadataWriteRequested = true;
      const preview = await previewModernSuccessorUpdate(projectRoot, selection, options);
      const work = preview.plans.some(plan => plan.writeCount > 0);
      const deferred = Boolean(preview.configurationReview?.deferredFields.length);
      return emit(work ? 'update-available' : deferred ? 'partial' : 'current', {
        scope: preview.scope, plans: preview.plans, configurationReview: preview.configurationReview,
        revalidation: preview.revalidation, receipt: { status: 'issued', path: preview.location.receiptPath },
        operationComplete: true, coreUpdateComplete: !work && !deferred
      }, work || deferred ? 2 : 0, work || deferred ? 'attention-required' : 'success');
    }
    await readRecordedModernUpdateSelection(projectRoot);
    executionRequested = true; externalMetadataWriteRequested = true; committed = null; uncertain = true;
    const result = await applyModernSuccessorUpdate({
      projectRoot, selection, force: request.force,
      ...(request.approvePlan === undefined ? {} : { approvePlan: request.approvePlan })
    }, context, options);
    if ('outcome' in result && result.outcome) {
      committed = result.outcome.committed;
      uncertain = result.outcome.status === 'blocked' || result.outcome.rollbackFailures.length > 0 ||
        result.outcome.cleanupFailures.length > 0 || ('cleanupFailures' in result && result.cleanupFailures.length > 0);
    } else if ('recovery' in result && result.recovery) {
      committed = result.recovery.committed; uncertain = result.recovery.status === 'blocked';
    } else {
      committed = 'committed' in result ? result.committed : false; uncertain = false;
    }
    const deferred = 'configurationReview' in result && Boolean(result.configurationReview?.deferredFields.length);
    const complete = (result.status === 'current' || result.status === 'committed') && !uncertain && !deferred;
    const attention = !uncertain && (result.status === 'committed-incomplete' ||
      (deferred && (result.status === 'current' || result.status === 'committed')) || result.status === 'recovery-required');
    const declined = result.status === 'approval-blocked' && result.approval.status === 'declined';
    const required = result.status === 'approval-blocked' && result.approval.status === 'required';
    return emit(result.status, { result, operationComplete: complete, coreUpdateComplete: complete },
      complete ? 0 : attention ? 2 : 1, complete ? 'success' : declined ? 'cancelled' : attention || required ? 'attention-required' : 'failure');
  } catch (error) {
    if (error instanceof ModernUpdateRecoveryError) {
      committed = error.observedCommitted; uncertain = true;
    } else if (error instanceof ProjectFileTransactionError) {
      committed = false; uncertain = error.rollbackFailures.length > 0;
    }
    return emit('failed', {
      diagnostics: [errorMessage(error)], operationComplete: false, coreUpdateComplete: false,
      reasonCode: error instanceof UpdatePreviewError ? error.code : error instanceof UpdatePlanError ? error.reasonCode : 'update-failed',
      remedy: `Preserve any pending journal. Inspect selected recovery first; otherwise run ${command('--check')} for a fresh exact plan.`
    }, 1, 'failure');
  }
}
