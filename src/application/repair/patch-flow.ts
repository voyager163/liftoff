import path from 'node:path';
import type { ExecutionContext } from '../context.js';
import { loadManifest } from '../project/manifest.js';
import type { LiftoffManifest } from '../../domain/project/contracts.js';
import { ProjectFileTransactionError, type ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { captureReviewedSnapshot as captureProjectFileSnapshot } from '../execution/plan-binding.js';
import { applyReviewedExecution, requestReviewedFileApproval } from '../execution/kernel.js';
import { withCooperatingExecutionLock } from '../execution/cross-writers.js';
import { reviewedPlanMatches } from '../../domain/execution/immutable-plan.js';
import { operationFailureOutcome } from '../../domain/execution/operation-outcome.js';
import { createScopedUserLocalRecordStore, type UpdatePreviewOptions } from '../../adapters/filesystem/update-previews.js';
import { commandShellForPlatform, formatShellCommand } from '../../adapters/process/shell-command.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { repairExecutionIdentity, repairSchemaVersions } from '../../domain/repair/identity.js';
import { liftoffVersion } from '../../version.js';
import { NodeCommandRunner, type CommandRunner } from '../../process-runner.js';
import type { UpdateApprovalResult } from '../update/approval.js';
import { inspectApplicationLayout } from './application-inventory.js';
import { applicationCandidateDigest, inspectApplicationPatch, verifyApplicationPatch } from './application-patch.js';
import type { ApplicationPatchCandidate, ApplicationVerificationResult } from './application-types.js';
import {
  buildRepairPreview, loadRepairPreview, mutationDescriptors, repairApprovalStore,
  repairHistoryFiles, repairHistoryRoot, snapshotDescriptors, type RepairPreview
} from './preview.js';
import { readRepairVerification, saveRepairVerification, type RepairVerificationReceipt } from './verification-receipt.js';
import { preserveRepairOriginals } from './backup.js';
import { repairHistoryMutations } from './history.js';
import { assertRepairReadback } from './readback.js';
import { repairCapabilities } from './capabilities.js';
import { emitRepairReport, type RepairNextAction, type RepairReport } from './report.js';
import { repairAgentActions, repairCommandAction, repairResumeActions } from './guidance.js';
import { requestRepairApproval } from './approval.js';
import type { RepairRequest } from './request.js';

interface BoundPatch {
  candidate: ApplicationPatchCandidate;
  metadata: ProjectFileSnapshot[];
  snapshots: ProjectFileSnapshot[];
}

async function inspectBoundPatch(
  root: string, patchPath: string, options?: { runner?: CommandRunner; env?: NodeJS.ProcessEnv }
): Promise<BoundPatch> {
  const metadataPaths = [['liftoff.manifest.json'], ['liftoff.config.json']];
  const metadata = await Promise.all(metadataPaths.map((parts) =>
    captureProjectFileSnapshot(root, parts, parts[0] === 'liftoff.manifest.json' ? 4 * 1024 * 1024 : undefined)));
  if (!metadata[0].content || metadata[0].content.length > 4 * 1024 * 1024) {
    throw new Error('Application repair requires a bounded existing manifest, not new or fabricated provenance.');
  }
  const manifest = await loadManifest(root);
  const candidate = await inspectApplicationPatch(root, manifest, patchPath, options);
  const after = await Promise.all(metadataPaths.map((parts) =>
    captureProjectFileSnapshot(root, parts, parts[0] === 'liftoff.manifest.json' ? 4 * 1024 * 1024 : undefined)));
  if (canonicalSha256(snapshotDescriptors(metadata)) !== canonicalSha256(snapshotDescriptors(after))) {
    throw new Error('Project manifest or desired state changed during application inspection; request a new review.');
  }
  const snapshots = [...new Map([...candidate.snapshots, ...metadata].map((entry) => [entry.pathParts.join('/'), entry])).values()];
  return { candidate, metadata, snapshots };
}

function previewFor(root: string, inspected: BoundPatch, now: Date): RepairPreview {
  return buildRepairPreview({
    projectRoot: root, recipe: 'application-layout-patch', applicationPatchPath: inspected.candidate.patchPath,
    snapshots: inspected.snapshots, mutations: inspected.candidate.mutations,
    scope: { application: inspected.candidate.scope, historyRoot: repairHistoryRoot, historyFiles: repairHistoryFiles },
    verificationPolicy: inspected.candidate.verificationPolicy, live: false, now
  });
}

export async function repairApplicationProject(input: {
  root: string;
  manifest: LiftoffManifest;
  request: RepairRequest;
  context: ExecutionContext;
  storage: UpdatePreviewOptions;
  saved?: RepairPreview;
}): Promise<number> {
  const { root, manifest, request, context, storage: initialStorage } = input;
  const now = () => context.updateNow?.() ?? new Date();
  const storage: UpdatePreviewOptions = { ...initialStorage, clock: () => now() };
  const identity = repairExecutionIdentity(liftoffVersion, 'application-layout-patch');
  let committed = false;
  let approval: UpdateApprovalResult | undefined;
  let verificationReceipt: RepairVerificationReceipt | null = null;
  let verificationResult: ApplicationVerificationResult | undefined;
  let backupPath: string | undefined;
  let historyPath: string | undefined;
  let effects: NonNullable<RepairReport['verificationEffects']> = {
    attempted: false, networkAuthorized: false, dependencyPreparationAuthorized: false, outcome: 'not-run',
    boundary: 'Approved project verification is not sandboxed. Earlier verifier/host effects are not undone by cancelling file approval; no planned application file transaction runs without its separate consent.'
  };
  const base = (): RepairReport => ({
    schemaVersion: repairSchemaVersions.report,
    operationKind: request.inspectLayout ? 'inspect-layout' : request.verifyPlan ? 'verify' : request.approvePlan ? 'apply' : 'check',
    requestedScope: 'application-layout', projectRoot: root, status: 'blocked', committed,
    repairScopeComplete: false, verification: verificationReceipt ? 'passed' : effects?.attempted ? 'incomplete' : 'not-run',
    capabilities: repairCapabilities, identity, message: '', blockers: [], nextActions: [],
    ...(approval ? { approval } : {}), verificationEffects: effects,
    ...(verificationReceipt ? { verificationReceipt } : {}), ...(verificationResult ? { verificationResult } : {}),
    ...(backupPath ? { backupPath } : {}), ...(historyPath ? { historyPath } : {})
  });
  const emit = (report: RepairReport) => emitRepairReport(context, request.json, report);
  const inventoryAction = () => repairCommandAction(root, ['--inspect-layout'], {
    id: 'application-inventory', label: 'Inspect current application files', scope: 'application-layout',
    description: 'Read-only exact source/target evidence. Resolve mappings and stage a patch outside the project.'
  });
  const recoverAction = () => repairCommandAction(root, ['--recover'], {
    id: 'repair-recover', label: 'Recover the recorded interrupted transaction', scope: 'repair-recovery',
    description: 'Only the sealed previously approved transaction can be recovered; no new patch is started.', approvalRequired: true
  });
  try {
    if (request.inspectLayout) {
      const inspected = await inspectApplicationLayout(root, manifest);
      emit({
        ...base(), status: inspected.report.complete ? 'inspected' : 'blocked', application: inspected.report,
        message: inspected.report.complete
          ? 'Application inventory is ready for explicit mapping and reference review. No patch, script or file transaction was executed.'
          : 'Application inventory is incomplete; unresolved scope cannot authorize a patch.',
        blockers: inspected.report.blockers,
        applicationSummary: [
          `${inspected.report.files.length} observed files; ${inspected.report.target?.artifacts.length ?? 0} exact current target identities; ${inspected.report.references.length} bounded reference locations.`,
          ...inspected.report.limitations
        ],
        nextActions: [...repairAgentActions(root, manifest), inventoryAction()]
      });
      return inspected.report.complete ? 0 : 2;
    }
    if (input.saved && input.saved.recipe.id !== 'application-layout-patch') {
      throw new Error('Application verification requires a reviewed application-layout-patch plan, not infrastructure approval.');
    }
    const patchPath = input.saved?.applicationPatchPath ??
      (request.applicationPatch ? path.resolve(context.cwd, request.applicationPatch) : undefined);
    if (!patchPath) throw new Error('Select an external application patch or its exact saved plan; no source mapping is inferred.');
    const inspectionOptions = { runner: context.runner, env: context.env };
    let inspected = await inspectBoundPatch(root, patchPath, inspectionOptions);
    let candidate = inspected.candidate;
    if (candidate.blockers.length) {
      emit({
        ...base(), message: 'The application patch is plan-only; its unresolved or unsafe scope was not executed.',
        application: candidate.report, blockers: candidate.blockers,
        nextActions: [inventoryAction(), ...repairAgentActions(root, manifest)]
      });
      return 2;
    }
    const preview = previewFor(root, inspected, input.saved ? new Date(input.saved.createdAt) : now());
    if (input.saved && !reviewedPlanMatches(input.saved, preview)) {
      throw new Error('Application inputs, modes, directories, staging, references or verification changed after preview. Request a fresh inspection and patch review.');
    }
    const receipt = input.saved ? undefined :
      await createScopedUserLocalRecordStore(root, 'repair-preview', storage).write(preview.fingerprint, preview);
    const assertCurrent = async () => {
      await loadRepairPreview(root, preview.fingerprint, now(), storage);
      const current = await inspectBoundPatch(root, patchPath, inspectionOptions);
      if (current.candidate.blockers.length ||
          !reviewedPlanMatches(preview, previewFor(root, current, new Date(preview.createdAt)))) {
        throw new Error('The displayed application plan changed or became blocked; no substitute plan was approved. Request a fresh inspection and review.');
      }
      return current;
    };
    const actions = (): RepairNextAction[] => [
      repairCommandAction(root, ['--application-patch', candidate.patchPath], {
        id: 'application-interactive', label: 'Review and approve interactively', scope: 'application-layout', approvalRequired: true,
        configPath: candidate.scope.patch.path, configDigest: candidate.scope.patch.digest?.replace(/^sha256:/u, ''),
        description: 'A genuine terminal asks separately about project checks, declared network and file commit. No fingerprint entry.'
      }),
      repairCommandAction(root, [
        '--verify-plan', preview.fingerprint,
        ...(candidate.verificationPolicy.effects.preparation ? ['--allow-dependency-preparation'] : []),
        ...(candidate.verificationPolicy.effects.network ? ['--allow-network'] : [])
      ], {
        id: 'application-automation-verify', label: 'Optional exact verification automation', scope: 'application-verification', approvalRequired: true,
        description: 'Only after separate approval of the displayed project-code and any declared network effects. No file transaction.'
      }),
      repairCommandAction(root, ['--approve-plan', preview.fingerprint], {
        id: 'application-automation-apply', label: 'Optional exact file automation', scope: 'application-layout', approvalRequired: true,
        description: 'Requires fresh matching successful verification and separate file-scope approval.'
      }),
      inventoryAction(), ...repairAgentActions(root, manifest)
    ];
    const detail = (): Pick<RepairReport, 'application' | 'applicationSummary' | 'operations' | 'fingerprint' | 'expiresAt' | 'validationPolicy' | 'validationSummary'> => ({
      application: candidate.report,
      applicationSummary: candidate.report.effects.map((entry) =>
        `${entry.sourcePathParts.join('/')} -> ${entry.targetPathParts.join('/')} (${entry.customization}; modes ${entry.beforeMode.toString(8)} -> ${entry.afterMode.toString(8)}; ${entry.references.length} reviewed reference dispositions)`),
      operations: mutationDescriptors(candidate.mutations), fingerprint: preview.fingerprint, expiresAt: preview.expiresAt,
      validationPolicy: candidate.verificationPolicy,
      validationSummary: [
        ...candidate.verificationPolicy.preparation.map((prep) =>
          `locked ${prep.provider} (${prep.packageSource}) in isolated copy/${prep.cwdPathParts.join('/') || '.'}; package count: ${prep.packageCount}; lifecycle hooks: disabled.`),
        ...candidate.verificationPolicy.commands.map((command) =>
          `${formatShellCommand(command, commandShellForPlatform(process.platform))} in isolated copy/${command.cwdPathParts.join('/') || '.'}; limit ${command.timeoutMs / 1000}s; declared network: ${command.network ? 'yes' : 'no'}.`),
        'These commands execute trusted project code. Staging and sanitized environment do not enforce host-filesystem or network isolation.',
        'Script execution, any declared dependency preparation or network effects and the final file transaction require separate approval. Tool installation and cloud/state/Git operations are not supplied by this recipe.'
      ]
    });
    if (!input.saved) {
      emit({
        ...base(), ...detail(), status: 'available', receiptPath: receipt?.path,
        message: 'Review this exact externally staged application patch. No verification command or application file transaction has run.',
        historyPath: path.join(root, ...repairHistoryRoot, preview.fingerprint), nextActions: actions()
      });
      if (request.check || request.json) return 2;
    }
    verificationReceipt = await readRepairVerification(preview, now(), storage);
    if (verificationReceipt && candidate.verificationPolicy.effects.network && !verificationReceipt.networkAuthorized) {
      throw new Error('Stored verification lacks the exact declared network authority. Request a fresh plan and independent verification.');
    }
    if (verificationReceipt && candidate.verificationPolicy.effects.preparation && !verificationReceipt.dependencyPreparationAuthorized) {
      throw new Error('Stored verification lacks the exact declared dependency preparation authority. Request a fresh plan and independent verification.');
    }
    if (request.approvePlan && !verificationReceipt) {
      emit({
        ...base(), ...detail(), message: 'File approval does not authorize project checks. Matching independently approved successful verification is required first.',
        nextActions: actions()
      });
      return 2;
    }
    if (!verificationReceipt) {
      let networkAuthorized = request.verifyPlan ? request.allowNetwork === true : false;
      let dependencyPreparationAuthorized = request.verifyPlan ? request.allowDependencyPreparation === true : false;
      if (!request.verifyPlan) {
        if (candidate.verificationPolicy.effects.preparation) {
          approval = await requestRepairApproval(request, preview.fingerprint,
            'Restore locked dependencies in an isolated copy, understanding that private packages and build tools can affect the host?', context);
          if (approval.status !== 'approved') {
            if (approval.status !== 'required') emit({
              ...base(), ...detail(), message: 'Dependency preparation consent was declined or cancelled. No preparation, project command or application file transaction ran.',
              nextActions: actions()
            });
            return 2;
          }
          dependencyPreparationAuthorized = true;
          await assertCurrent();
        }
        approval = await requestRepairApproval(request, preview.fingerprint,
          'Run the displayed exact project verification commands in staging, understanding that trusted code can affect the host and is not sandboxed?', context);
        if (approval.status !== 'approved') {
          if (approval.status !== 'required') emit({
            ...base(), ...detail(), message: 'Verification consent was declined or cancelled. No project command or application file transaction ran.',
            nextActions: actions()
          });
          return 2;
        }
        await assertCurrent();
        if (candidate.verificationPolicy.effects.network) {
          approval = await requestRepairApproval(request, preview.fingerprint,
            'Additionally allow the displayed declared network effects for these exact verification commands?', context);
          if (approval.status !== 'approved') {
            emit({ ...base(), ...detail(), message: 'Network consent was not granted. No verification command or application file transaction ran.', nextActions: actions() });
            return 2;
          }
          networkAuthorized = true;
          await assertCurrent();
        }
      }
      if (candidate.verificationPolicy.effects.preparation && !dependencyPreparationAuthorized) {
        emit({ ...base(), ...detail(), message: 'The exact verification requires separate dependency preparation consent before any command can run.', nextActions: actions() });
        return 2;
      }
      if (candidate.verificationPolicy.effects.network && !networkAuthorized) {
        emit({ ...base(), ...detail(), message: 'The exact verification requires separate declared-network consent before any command can run.', nextActions: actions() });
        return 2;
      }
      inspected = await assertCurrent();
      candidate = inspected.candidate;
      verificationResult = await withCooperatingExecutionLock(root, async () => {
        effects = { ...effects, attempted: true, networkAuthorized, dependencyPreparationAuthorized, outcome: 'incomplete' };
        verificationResult = await verifyApplicationPatch(root, candidate, context.runner ?? new NodeCommandRunner(), {
          preview, storage, env: context.env,
          allowProjectCode: true,
          allowDependencyPreparation: dependencyPreparationAuthorized,
          allowNetwork: networkAuthorized,
          assertCurrent: async () => { await assertCurrent(); }
        });
        return verificationResult;
      }, { currentCommand: 'repair', storage });
      if (verificationResult.status !== 'passed' || !verificationResult.inspectedProjectUnchanged || !verificationResult.cleanupComplete ||
          verificationResult.candidateDigest !== applicationCandidateDigest(candidate) ||
          verificationResult.verificationPolicyDigest !== preview.verificationDigest ||
          verificationResult.commands.length !== candidate.verificationPolicy.commands.length ||
          !verificationResult.commands.every((command) => command.passed) ||
          (verificationResult.preparation && !verificationResult.preparation.every((prep) => prep.status === 'passed'))) {
        emit({
          ...base(), ...detail(), status: effects.attempted ? 'partial' : 'blocked',
          message: 'Staged verification did not establish the approved checks. No planned application file transaction was applied; earlier authorized verifier effects are retained.',
          blockers: verificationResult.blockers, nextActions: actions()
        });
        return 2;
      }
      inspected = await assertCurrent();
      candidate = inspected.candidate;
      verificationReceipt = await saveRepairVerification(preview, now(), networkAuthorized, storage, dependencyPreparationAuthorized);
      effects.outcome = 'passed';
    }
    if (request.verifyPlan || !request.json) emit({
      ...base(), ...detail(), status: 'verified', verification: 'passed',
      message: effects.attempted
        ? 'The exact staged candidate passed only its declared checks. The application file transaction has not been applied.'
        : 'Previously approved checks match this unchanged candidate; no verification command was rerun. The application file transaction has not been applied.',
      nextActions: actions()
    });
    if (request.verifyPlan) return 0;
    if (request.approvePlan) {
      approval = await requestReviewedFileApproval({
        kind: 'repair', projectRoot: root, fingerprint: preview.fingerprint, approvePlan: request.approvePlan
      }, { stderr: context.stderr });
    } else {
      approval = await requestRepairApproval(request, preview.fingerprint,
        'Apply the displayed exact application file changes, private original-byte backup and immutable repair history?', context, root);
      if (approval.status !== 'approved') {
        emit({
          ...base(), ...detail(),
          message: 'File consent was not granted. No planned application file transaction was applied; earlier separately authorized verifier effects are not rolled back.',
          nextActions: actions()
        });
        return 2;
      }
    }
    inspected = await assertCurrent();
    candidate = inspected.candidate;
    verificationReceipt = await readRepairVerification(preview, now(), storage);
    if (!verificationReceipt) throw new Error('Matching verification is no longer available; no application file transaction was authorized.');
    const historySnapshots = await Promise.all(repairHistoryFiles.map((name) =>
      captureProjectFileSnapshot(root, [...repairHistoryRoot, preview.fingerprint, name])));
    if (historySnapshots.some((entry) => entry.content !== undefined)) {
      throw new Error('Repair history already exists and is immutable. Do not overwrite it; request a new reviewed patch.');
    }
    const mutatedPaths = new Set(candidate.mutations.map((entry) => entry.pathParts.join('/')));
    const backup = await preserveRepairOriginals(preview, inspected.snapshots.filter((entry) => mutatedPaths.has(entry.pathParts.join('/'))), storage);
    backupPath = backup.path;
    const historyMutations = repairHistoryMutations({
      preview, sourceManifest: inspected.metadata[0].content!, snapshots: inspected.snapshots,
      mutations: candidate.mutations, verificationPolicy: candidate.verificationPolicy, backupIndexKey: backup.indexKey
    });
    historyPath = path.join(root, ...repairHistoryRoot, preview.fingerprint);
    const mutations = [...historyMutations, ...candidate.mutations];
    const originals = [...inspected.snapshots, ...historySnapshots];
    const outcome = await applyReviewedExecution(root, mutations, {
      transactionKind: 'repair', repairIdentity: identity, planFingerprint: preview.fingerprint,
      approval: approval!, approvalStore: repairApprovalStore(root, storage), preconditions: originals, storage,
      validatePlan: async () => {
        await assertCurrent();
        if (!await readRepairVerification(preview, now(), storage)) {
          throw new Error('Application verification no longer matches the approved transaction.');
        }
      },
      verifyCommitted: async () => {
        await assertRepairReadback(root, mutations, originals);
        for (const snapshot of inspected.metadata) {
          const after = await captureProjectFileSnapshot(root, snapshot.pathParts, 4 * 1024 * 1024);
          if (canonicalSha256(snapshotDescriptors([after])) !== canonicalSha256(snapshotDescriptors([snapshot]))) {
            throw new Error('Application patch committed, but protected manifest/configuration changed during final inspection.');
          }
        }
      }
    });
    committed = outcome.committed;
    if (!committed) {
      emit({
        ...base(), ...detail(), status: 'partial', message: 'The application file transaction did not commit; approved verification effects and private originals remain recorded.',
        blockers: [...outcome.rollbackFailures, ...outcome.cleanupFailures], nextActions: [recoverAction()]
      });
      return 2;
    }
    emit({
      ...base(), ...detail(), operationKind: 'apply', status: outcome.operation.status === 'completed' ? 'applied' : 'partial',
      verification: outcome.operation.verification === 'passed' ? 'passed' : 'incomplete',
      repairScopeComplete: outcome.operation.status === 'completed',
      message: outcome.operation.status === 'completed'
        ? 'The exact reviewed application patch committed and its bytes/modes were read back. Original manifest provenance is unchanged; only the declared staged checks are verified.'
        : 'The application patch committed, but current byte/mode readback or cleanup is incomplete. Original history and later edits were preserved.',
      blockers: outcome.cleanupFailures,
      nextActions: outcome.cleanupFailures.length ? [recoverAction()] :
        [inventoryAction(), ...repairResumeActions(root, manifest), ...repairAgentActions(root, manifest)]
    });
    return outcome.cleanupFailures.length ? 2 : 0;
  } catch (error) {
    const failure = operationFailureOutcome({
      committed, attemptedEffects: effects.attempted,
      rollbackFailures: error instanceof ProjectFileTransactionError ? error.rollbackFailures : undefined
    });
    emit({
      ...base(), ...failure,
      message: committed
        ? 'The application patch committed, but current verification/readback or cleanup is incomplete. No blind restoration was attempted.'
        : 'The application file transaction did not complete. Any earlier approved verification effects and retained private backups are reported separately.',
      blockers: [error instanceof Error ? error.message : 'Unexpected application repair failure.'],
      nextActions: [inventoryAction(), ...repairAgentActions(root, manifest)]
    });
    return failure.status === 'partial' ? 2 : 1;
  }
}
