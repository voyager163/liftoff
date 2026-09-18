import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionContext } from '../../context.js';
import type { AdoptionPlan, AdoptionRecord } from '../../../domain/project-evolution/adoption/contracts.js';
import { adoptionExecutionIdentity } from '../../../domain/project-evolution/adoption/identity.js';
import { canonicalSha256, isRecord } from '../../../domain/governance/activation/canonical-json.js';
import { manifestPortablePath } from '../../../domain/project/manifest/current.js';
import { validateAdoptionRecord } from '../../../domain/project-evolution/adoption/record-reader.js';
import { createStructuredContinuation, type StructuredContinuationV1 } from '../../../protocol/continuation.js';
import { readProjectFile } from '../../../adapters/filesystem/project-files.js';
import { captureProjectFileSnapshot } from '../../../adapters/filesystem/project-transaction.js';
import { projectMutationLockPath, withProjectMutationLock } from '../../../adapters/filesystem/project-lock.js';
import {
  applyReviewedUpdateTransaction, inspectReviewedUpdateTransaction, recoverReviewedUpdateTransaction,
  type ReviewedUpdateTransactionOutcome
} from '../../../adapters/filesystem/reviewed-update-transaction.js';
import { createScopedUserLocalRecordStore, type UpdatePreviewOptions } from '../../../adapters/filesystem/update-previews.js';
import {
  reviewedAdoptionTransactionPathParts, reviewedRepairTransactionPathParts, reviewedSkillsTransactionPathParts, reviewedUpdateTransactionPathParts
} from '../../../domain/project/reviewed-update-artifacts.js';
import { NodeCommandRunner } from '../../../process-runner.js';
import { liftoffVersion } from '../../../version.js';
import { loadManifest } from '../../project/manifest.js';
import { requestUpdateApproval, hasUsableApprovalTerminal } from '../../update/approval.js';
import { findUpdateRepositoryBoundary } from '../../update/inspection.js';
import { ApplicationInspectionError, applicationDigest, applicationPathKey, canonicalApplicationRoot } from '../../repair/application-files.js';
import { applicationCandidateDigest } from '../../repair/application-patch-inspection.js';
import { preserveProjectOriginals } from '../../repair/backup.js';
import { verifyApplicationCandidate } from '../../repair/application-verification.js';
import type { ApplicationInventoryReport, ApplicationVerificationPolicy, ApplicationVerificationResult } from '../../repair/application-types.js';
import type { AssessmentResult } from '../../../domain/standards-assessment/types.js';
import {
  createAdoptionVerificationWorkspace, inspectRepairVerificationWorkspaces, recoverRepairVerificationWorkspaces
} from '../../repair/workspaces.js';
import { adoptionFileMode, adoptionHistoryPath, inspectAdoption, type AdoptionInspection, type AdoptionPlanningOptions } from './planning.js';
import {
  adoptionApprovalStore, adoptionPreview, assertAdoptionPreviewMatches, loadAdoptionPreview,
  readAdoptionVerification, saveAdoptionVerification, saveCommittedAdoption,
  assertAdoptionRecoveryTarget, saveAdoptionPreEffect,
  type AdoptionPreview, type AdoptionVerificationReceipt
} from './records.js';
import { prepareAdoptionFramework, type FrameworkPreparationResult } from './framework.js';
import { adoptionRequestIssue, type AdoptRequest } from './request.js';
export type { AdoptRequest } from './request.js';

export interface AdoptionReport {
  schemaVersion: 1;
  command: 'adopt';
  scope: 'project-adoption';
  projectRoot: string;
  status: 'planned' | 'blocked' | 'cancelled' | 'verified' | 'committed' | 'current' | 'incomplete' | 'recovered' | 'failed';
  committed: boolean;
  complete: boolean;
  message: string;
  plan?: AdoptionPlan;
  assessment?: AssessmentResult;
  inventory?: ApplicationInventoryReport;
  verificationPolicy?: ApplicationVerificationPolicy;
  previewPath?: string;
  verification?: ApplicationVerificationResult | AdoptionVerificationReceipt;
  frameworkPreparation?: FrameworkPreparationResult;
  backup?: { indexKey: string; path: string };
  transaction?: ReviewedUpdateTransactionOutcome;
  effects: { preparationCommands: number; projectCommands: number; networkAuthorized: boolean; frameworkCommands: number };
  blockers: string[];
  limitations: string[];
  nextActions: StructuredContinuationV1[];
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

async function assertAdoptionWriterIdle(root: string, storage: UpdatePreviewOptions, underLock = false): Promise<void> {
  for (const parts of [reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts, reviewedAdoptionTransactionPathParts, reviewedSkillsTransactionPathParts]) {
    try {
      await lstat(path.join(root, ...parts));
      throw new ApplicationInspectionError(`A recorded transaction blocks new adoption: ${parts.join('/')}. Recover only its original reviewed effects.`);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  if (!underLock) {
    try {
      await lstat(await projectMutationLockPath(root));
      throw new ApplicationInspectionError('A cooperating writer holds the project boundary. Adoption does not remove locks by PID or age.');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  const workspaces = await inspectRepairVerificationWorkspaces(root, storage);
  if (workspaces.status !== 'absent') throw new ApplicationInspectionError('Active, retained or untrusted private verification workspaces block a new adoption writer. Inspect exact registered recovery first.');
}

function nextActions(plan: AdoptionPlan): StructuredContinuationV1[] {
  const common = ['adopt', '--project', plan.projectRoot, '--profile', plan.component.profile.id,
    ...(plan.component.rootPathParts.length ? ['--component', path.join(...plan.component.rootPathParts)] : []),
    ...(plan.proposal ? ['--proposal', plan.proposal.path] : [])];
  const action = (args: string[], authority: string[]) => createStructuredContinuation({
    executable: 'liftoff', args, cwd: plan.projectRoot, project: plan.projectRoot,
    scope: 'project-adoption', targetScope: 'project',
    ...(plan.proposal ? { configPath: plan.proposal.path, configDigest: plan.proposal.digest } : {}),
    requiredAuthority: authority, compatibilityIdentity: canonicalSha256(adoptionExecutionIdentity(plan.cliVersion))
  });
  return [
    action([...common, '--check'], []),
    ...(plan.permissions.projectCode || plan.permissions.framework ? [action([...common, '--verify-plan', plan.fingerprint,
      ...(plan.permissions.dependencyPreparation ? ['--allow-dependency-preparation'] : []),
      ...(plan.permissions.network ? ['--allow-network'] : [])], [plan.permissions.framework ? 'exact-framework-code' : 'exact-project-code', ...(plan.permissions.dependencyPreparation ? ['dependency-preparation'] : []), ...(plan.permissions.network ? ['network'] : [])])] : []),
    ...(plan.permissions.fileTransaction ? [action([...common, '--approve-plan', plan.fingerprint], [
      'exact-file-transaction', ...(plan.permissions.projectCode ? ['matching-verification-receipt'] : [])
    ])] : [])
  ];
}

function recoveryAction(projectRoot: string): StructuredContinuationV1 {
  return createStructuredContinuation({
    executable: 'liftoff', args: ['adopt', '--project', projectRoot, '--recover'],
    cwd: projectRoot, project: projectRoot, scope: 'project-adoption', targetScope: 'project',
    requiredAuthority: ['original-recorded-recovery'],
    compatibilityIdentity: canonicalSha256(adoptionExecutionIdentity(liftoffVersion))
  });
}

async function currentAdoption(
  root: string, storage: UpdatePreviewOptions
): Promise<{ matches: boolean; differences: string[] } | null> {
  const marker = await captureProjectFileSnapshot(root, ['liftoff.manifest.json']);
  if (marker.content === undefined) return null;
  const manifest = await loadManifest(root);
  if (manifest.artifactVersion !== 8 || manifest.provenance.kind !== 'adopted') {
    throw new ApplicationInspectionError('This existing manifest is not an uninitialized adoption source. Use separately reviewed metadata update, repair or fresh-target migration.');
  }
  const recordId = manifest.provenance.recordId;
  const bytes = await readProjectFile(root, adoptionHistoryPath(recordId));
  if (!bytes) throw new ApplicationInspectionError('Adopted provenance has no exact committed adoption record; preserve it for attributable recovery.');
  const record: unknown = JSON.parse(bytes.toString('utf8'));
  const saved = await createScopedUserLocalRecordStore(root, 'adoption-checkpoint', storage).read(
    canonicalSha256({ kind: 'adoption-committed', recordId })
  );
  if (!isRecord(record) || record.schemaVersion !== 1 || record.kind !== 'liftoff-adoption-record' ||
    record.recordId !== recordId || record.projectRoot !== root || !Array.isArray(record.effects) ||
    !saved || !isRecord(saved.value) || saved.value.kind !== 'liftoff-adoption-committed' ||
    saved.value.recordId !== recordId || saved.value.recordDigest !== canonicalSha256(record) ||
    saved.value.manifestHash !== record.manifestHash || saved.value.fingerprint !== record.fingerprint) {
    throw new ApplicationInspectionError('Adoption completion lacks its matching external committed checkpoint. Project-local metadata cannot manufacture successful adoption.');
  }
  const differences: string[] = [];
  if (record.manifestHash !== applicationDigest(marker.content)) differences.push('liftoff.manifest.json');
  for (const effect of record.effects) {
    if (!isRecord(effect) || !isRecord(effect.after)) throw new ApplicationInspectionError('Recorded adoption effect is malformed.');
    const parts = manifestPortablePath(effect.pathParts, 'Recorded adoption effect');
    const after = effect.after;
    if (!(after.digest === null || typeof after.digest === 'string' && /^[a-f0-9]{64}$/u.test(after.digest)) ||
      !(after.mode === null || typeof after.mode === 'number' && Number.isInteger(after.mode) && after.mode >= 0 && after.mode <= 0o777)) {
      throw new ApplicationInspectionError('Recorded adoption effect has an invalid hash/mode identity.');
    }
    const file = await captureProjectFileSnapshot(root, parts);
    if ((file.content === undefined ? null : applicationDigest(file.content)) !== after.digest ||
      (file.mode ?? null) !== after.mode) differences.push(parts.join('/'));
  }
  return { matches: differences.length === 0, differences: [...new Set(differences)] };
}

async function checkpointCommittedAdoption(root: string, fingerprint: string, storage: UpdatePreviewOptions): Promise<void> {
  const manifest = await loadManifest(root);
  if (manifest.artifactVersion !== 8 || manifest.provenance.kind !== 'adopted') throw new ApplicationInspectionError('Committed adoption manifest identity is missing.');
  const content = await readProjectFile(root, adoptionHistoryPath(manifest.provenance.recordId));
  if (!content) throw new ApplicationInspectionError('Committed adoption history is missing.');
  const record = validateAdoptionRecord(JSON.parse(content.toString('utf8')) as unknown, {
    recordId: manifest.provenance.recordId, standards: manifest.standards, assessmentDigest: manifest.provenance.observationDigest
  });
  if (record.fingerprint !== fingerprint || record.projectRoot !== root) throw new ApplicationInspectionError('Committed adoption record is not the externally approved exact transaction.');
  for (const effect of record.effects) {
    const file = await captureProjectFileSnapshot(root, effect.pathParts);
    if ((file.content === undefined ? null : applicationDigest(file.content)) !== effect.after.digest ||
      (file.mode ?? null) !== effect.after.mode) {
      throw new ApplicationInspectionError(`Committed adoption readback changed at ${effect.pathParts.join('/')}. Newer bytes were preserved.`);
    }
  }
  await saveCommittedAdoption(record, storage);
}

export async function adoptProject(request: AdoptRequest, context: ExecutionContext): Promise<number> {
  let root = path.resolve(context.cwd, request.project ?? '.');
  const now = context.updateNow ?? (() => new Date());
  const storage: UpdatePreviewOptions = {
    ...context.updatePreview, env: context.updatePreview?.env ?? context.env,
    clock: context.updatePreview?.clock ?? now
  };
  let report: AdoptionReport = {
    schemaVersion: 1, command: 'adopt', scope: 'project-adoption', projectRoot: root, status: 'blocked',
    committed: false, complete: false, message: '', effects: { preparationCommands: 0, projectCommands: 0, networkAuthorized: false, frameworkCommands: 0 },
    blockers: [], limitations: [], nextActions: []
  };
  const emit = (next: Partial<AdoptionReport>): void => {
    report = { ...report, ...next };
    if (request.json) context.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      context.presentation.commandIdentity('adopt', 'Reviewed in-place project adoption');
      context.presentation.definitions('Adoption outcome', [
        { label: 'Project', value: root }, { label: 'Status', value: report.status },
        { label: 'Local commit', value: report.committed ? 'committed' : 'not committed' },
        { label: 'Verification commands', value: String(report.effects.projectCommands) },
        { label: 'Preparation commands', value: String(report.effects.preparationCommands) }
      ]);
      context.presentation.bullets('Outcome', [report.message, ...report.blockers]);
      if (report.nextActions.length) context.presentation.bullets('Separate next actions', report.nextActions.map((action) => action.displayCommand));
    }
  };
  const showPlan = (inspection: AdoptionInspection): void => {
    if (request.json) return;
    context.presentation.definitions('Immutable adoption plan', [
      { label: 'Fingerprint', value: inspection.plan.fingerprint },
      { label: 'Profile', value: `${inspection.plan.component.profile.id} @ ${inspection.plan.component.profile.revision}` },
      { label: 'Component', value: inspection.plan.component.rootPathParts.join('/') || '.' },
      { label: 'Expires', value: inspection.plan.expiresAt }
    ]);
    context.presentation.bullets('Exact effects', inspection.plan.effects.map((effect) =>
      `${effect.type} ${effect.pathParts.join('/')} [${effect.producer}]: ${effect.before.digest ?? 'absent'} mode ${effect.before.mode ?? 'absent'} -> ${effect.after.digest ?? 'absent'} mode ${effect.after.mode ?? 'absent'}`));
    context.presentation.bullets('Declared verification and preparation', [
      ...inspection.application.verificationPolicy.commands.map((command) => JSON.stringify(command)),
      ...inspection.application.verificationPolicy.preparation.map((preparation) => JSON.stringify(preparation)),
      ...(inspection.plan.frameworkPreparation.binding?.commands.map((command) => JSON.stringify(command)) ?? []),
      ...inspection.limitations
    ]);
  };
  const approve = async (fingerprint: string, message: string): Promise<boolean> => {
    if (request.json || !hasUsableApprovalTerminal(context)) return false;
    return (await requestUpdateApproval({ fingerprint, message }, {
      stdin: context.stdin, stderr: context.stderr,
      approveUpdatePlan: context.approveAdoptionPlan ?? context.approveRepairPlan ?? context.approveUpdatePlan
    })).status === 'approved';
  };
  try {
    const issue = adoptionRequestIssue(request);
    if (issue) throw new ApplicationInspectionError(issue);
    root = await canonicalApplicationRoot(root);
    report.projectRoot = root;
    if (storage.repositoryRoot === undefined) storage.repositoryRoot = await findUpdateRepositoryBoundary(root);
    const approvalStore = adoptionApprovalStore(root, storage);
    const pending = await inspectReviewedUpdateTransaction(root, { transactionKind: 'adoption', approvalStore });
    if (request.recover) {
      const recovered = await recoverReviewedUpdateTransaction(root, {
        transactionKind: 'adoption', approvalStore,
        validateRecovery: (fingerprint) => assertAdoptionRecoveryTarget(root, fingerprint, storage),
        onCommittedReadback: async () => {
          if (!pending.planFingerprint) throw new ApplicationInspectionError('Committed adoption recovery lacks an authenticated plan identity.');
          await checkpointCommittedAdoption(root, pending.planFingerprint, storage);
        }
      });
      const workspaces = await recoverRepairVerificationWorkspaces(root, storage);
      if (recovered.status === 'absent' && (await captureProjectFileSnapshot(root, ['liftoff.manifest.json'])).content !== undefined) {
        const existing = await currentAdoption(root, storage);
        if (existing && !existing.matches) throw new ApplicationInspectionError('No authenticated interrupted adoption remains, but recorded outputs differ. Recovery cannot rewrite newer bytes or manufacture a missing completion checkpoint.');
      }
      const complete = ['absent', 'rolled-back', 'committed'].includes(recovered.status) && recovered.rollbackFailures.length === 0 &&
        recovered.cleanupFailures.length === 0 && ['absent', 'complete'].includes(workspaces.status);
      emit({
        status: complete ? 'recovered' : 'incomplete', committed: recovered.committed, complete,
        transaction: recovered, message: 'Recovery handled only the original recorded adoption and registered private-workspace scope; no new adoption was started.' +
          (recovered.retainedDirectories?.length
            ? ` Created directories were retained without deletion authority: ${recovered.retainedDirectories.map((parts) => parts.join('/')).join(', ')}.`
            : ''),
        blockers: [...recovered.rollbackFailures, ...recovered.cleanupFailures, ...workspaces.issues.map((issue) => issue.message)]
      });
      return complete ? 0 : 2;
    }
    if (pending.status !== 'absent') {
      report.committed = pending.committed;
      report.nextActions = [recoveryAction(root)];
      throw new ApplicationInspectionError(`An existing adoption journal requires explicit --recover before new work. ${pending.reason ?? ''}`);
    }
    await assertAdoptionWriterIdle(root, storage);
    const already = await currentAdoption(root, storage);
    if (already) {
      emit({
        status: already.matches ? 'current' : 'incomplete', committed: true, complete: already.matches,
        message: already.matches ? 'The exact adoption is already committed and read back. No transaction was replayed.' :
          'Adoption is already recorded, with subsequent differences. No prior approval was reused and no files were restored.',
        blockers: already.differences
      });
      return already.matches ? 0 : 2;
    }
    const fingerprint = request.approvePlan ?? request.verifyPlan;
    let saved: AdoptionPreview | undefined = fingerprint ? await loadAdoptionPreview(root, fingerprint, now(), storage) : undefined;
    const planning: AdoptionPlanningOptions = {
      project: root, profile: request.profile ?? saved?.profile,
      component: request.component ?? (saved?.component.length ? path.join(...saved.component) : undefined),
      proposal: request.proposal ? path.resolve(context.cwd, request.proposal) : saved?.proposal ?? undefined,
      now: saved ? new Date(saved.createdAt) : now(), runner: context.runner, env: context.env, storage
    };
    let inspection = await inspectAdoption(planning);
    if (saved) assertAdoptionPreviewMatches(inspection.plan, saved);
    report = {
      ...report, plan: inspection.plan, assessment: inspection.assessment, inventory: inspection.inventory,
      verificationPolicy: inspection.plan.permissions.projectCode ? inspection.application.verificationPolicy : undefined,
      limitations: inspection.limitations, nextActions: nextActions(inspection.plan), blockers: inspection.blockers
    };
    showPlan(inspection);
    if (inspection.blockers.length) {
      emit({
        status: 'blocked', message: 'Adoption is not executable for the observed scope. No project code or transaction ran.',
        nextActions: [createStructuredContinuation({
          executable: 'liftoff', args: ['assess', '--project', root,
            '--profile', inspection.plan.component.profile.id,
            ...(inspection.plan.component.rootPathParts.length ? ['--component', path.join(...inspection.plan.component.rootPathParts)] : [])],
          cwd: root, project: root, scope: 'project-assessment', targetScope: 'project',
          requiredAuthority: [], compatibilityIdentity: canonicalSha256(adoptionExecutionIdentity(liftoffVersion))
        })]
      });
      return 2;
    }
    if (!saved) {
      saved = adoptionPreview(inspection.plan);
      const stored = await createScopedUserLocalRecordStore(root, 'adoption-preview', storage).write(saved.fingerprint, saved);
      report.previewPath = stored.path;
    }
    if (request.check || (!request.verifyPlan && !request.approvePlan && (request.json || !hasUsableApprovalTerminal(context)))) {
      emit({ status: 'planned', message: 'Exact adoption preview saved outside the project. Preparation, checks, framework initialization and file writes have not run.' });
      return 2;
    }
    let approvedPreview = saved;
    const revalidate = async (): Promise<AdoptionInspection> => {
      await loadAdoptionPreview(root, approvedPreview.fingerprint, now(), storage);
      const current = await inspectAdoption({ ...planning, now: new Date(approvedPreview.createdAt), approvedTools: inspection.application.verificationPolicy.toolchain });
      if (current.blockers.length) throw new ApplicationInspectionError(current.blockers.join(' '));
      assertAdoptionPreviewMatches(current.plan, approvedPreview);
      return current;
    };
    if (inspection.plan.permissions.framework) {
      if (request.approvePlan || !inspection.framework) {
        emit({ status: 'blocked', message: 'Official framework preparation must run under its separate exact code/network permission before the final file inventory can be approved.' });
        return 2;
      }
      const frameworkApproved = request.verifyPlan === inspection.plan.fingerprint ||
        await approve(inspection.plan.fingerprint, 'Run the displayed official framework initializer in registered private staging? Liftoff targets no real project writes here; trusted tool code still has host access and is not security-sandboxed.');
      if (!frameworkApproved) {
        emit({ status: 'cancelled', message: 'Official framework code was not approved; no real metadata or application transaction ran.' });
        return 2;
      }
      const frameworkNetworkApproved = request.allowNetwork === true ||
        await approve(inspection.plan.fingerprint, 'Permit the declared official framework network effects in private staging, without ambient credentials, tool installation or project writes?');
      if (!frameworkNetworkApproved) {
        emit({ status: 'blocked', message: 'Separate declared-network permission is required for official framework preparation.' });
        return 2;
      }
      const preparation = inspection.framework;
      const prepared = await withProjectMutationLock(root, async () => {
        await assertAdoptionWriterIdle(root, storage, true);
        await revalidate();
        return prepareAdoptionFramework(inspection.plan, preparation, {
          runner: context.runner, env: context.env, storage, allowCode: true, allowNetwork: true,
          assertCurrent: async () => { await revalidate(); }
        });
      });
      report.frameworkPreparation = prepared;
      report.effects.frameworkCommands += prepared.commandsExecuted;
      report.effects.networkAuthorized ||= prepared.networkAuthorized;
      if (prepared.status !== 'prepared') {
        emit({ status: 'blocked', message: 'Official framework preparation is incomplete. Its actual earlier approved effects remain visible; no real project transaction ran.', blockers: prepared.blockers });
        return 2;
      }
      inspection = await inspectAdoption({ ...planning, now: new Date(approvedPreview.createdAt) });
      if (inspection.blockers.length || !inspection.plan.permissions.fileTransaction) throw new ApplicationInspectionError('Prepared framework output did not establish an exact collision-free final file plan.');
      approvedPreview = adoptionPreview(inspection.plan);
      const stored = await createScopedUserLocalRecordStore(root, 'adoption-preview', storage).write(approvedPreview.fingerprint, approvedPreview);
      report = {
        ...report, plan: inspection.plan,
        verificationPolicy: inspection.plan.permissions.projectCode ? inspection.application.verificationPolicy : undefined,
        previewPath: stored.path, nextActions: nextActions(inspection.plan)
      };
      showPlan(inspection);
      if (request.verifyPlan) {
        emit({ status: 'planned', message: 'Official framework output was independently validated in private staging. Review the new exact-byte plan; application checks and final file approval remain separate and no real project files were written.' });
        return 2;
      }
    }
    let verification = await readAdoptionVerification(inspection.plan, now(), storage);
    if (inspection.plan.permissions.projectCode && !verification) {
      if (request.approvePlan) {
        emit({ status: 'blocked', message: 'Exact file approval does not authorize missing project-code verification, preparation or network effects.' });
        return 2;
      }
      const codeApproved = request.verifyPlan === inspection.plan.fingerprint ||
        await approve(inspection.plan.fingerprint, 'Run only the displayed bounded project checks in the registered private candidate?');
      if (!codeApproved) {
        emit({ status: 'cancelled', message: 'Project-code verification was not approved; no later file effects ran.' });
        return 2;
      }
      const prepareApproved = !inspection.plan.permissions.dependencyPreparation || request.allowDependencyPreparation === true ||
        await approve(inspection.plan.fingerprint, 'Prepare the displayed exact frozen dependencies in a fresh private environment/cache? No global tool installation or lifecycle hooks are authorized.');
      if (!prepareApproved) {
        emit({ status: 'blocked', message: 'Separate dependency preparation approval is required before checks. No preparation or transaction ran.' });
        return 2;
      }
      const networkApproved = !inspection.plan.permissions.network || request.allowNetwork === true ||
        await approve(inspection.plan.fingerprint, 'Permit only the displayed declared network effects for this exact preparation/check plan? Private staging is not a network sandbox.');
      if (!networkApproved) {
        emit({ status: 'blocked', message: 'Separate declared-network approval is required; no unapproved network/check/transaction ran.' });
        return 2;
      }
      const result = await withProjectMutationLock(root, async () => {
        await assertAdoptionWriterIdle(root, storage, true);
        await revalidate();
        return verifyApplicationCandidate(root, inspection.application, context.runner ?? new NodeCommandRunner(), {
          storage, env: context.env, allowProjectCode: true, allowDependencyPreparation: prepareApproved, allowNetwork: networkApproved,
          assertAuthority: async () => { await revalidate(); },
          assertCandidateCurrent: async () => {
            const current = await revalidate();
            if (applicationCandidateDigest(current.application) !== applicationCandidateDigest(inspection.application)) {
              throw new ApplicationInspectionError('The private adoption candidate changed after review.');
            }
          },
          inspectedProjectUnchanged: async () => {
            try { await revalidate(); return true; } catch { return false; }
          },
          createWorkspace: () => createAdoptionVerificationWorkspace(root, {
            planFingerprint: inspection.plan.fingerprint, adoptionIdentity: adoptionExecutionIdentity(liftoffVersion),
            patchStagingRoot: inspection.application.scope.staging.root,
            bindings: {
              inputDigest: inspection.plan.inspectionDigest, verificationPolicyDigest: inspection.plan.verificationDigest,
              providerDigest: canonicalSha256(inspection.application.verificationPolicy.preparation), toolchainDigest: inspection.plan.toolchainDigest
            },
            approvedScopes: { projectCode: true, dependencyPreparation: prepareApproved && inspection.plan.permissions.dependencyPreparation, network: networkApproved && inspection.plan.permissions.network, lifecycle: false }
          }, storage)
        });
      });
      report.verification = result;
      report.effects = {
        preparationCommands: result.preparation.reduce((count, entry) => count + entry.commands.length, 0),
        projectCommands: result.commands.length, networkAuthorized: report.effects.networkAuthorized || inspection.plan.permissions.network && networkApproved,
        frameworkCommands: report.effects.frameworkCommands
      };
      if (result.status !== 'passed') {
        emit({ status: 'blocked', message: 'Required staged checks did not complete. Earlier approved preparation/check effects remain visible; no file transaction ran.', blockers: result.blockers });
        return 2;
      }
      verification = await saveAdoptionVerification(inspection.plan, result, now(), storage);
      if (request.verifyPlan) {
        emit({ status: 'verified', message: 'Declared candidate checks passed with known process settlement. Review this result before separately approving the exact metadata/application transaction.' });
        return 2;
      }
      context.presentation.bullets('Verification completed', ['The exact declared private-candidate checks passed. This is not application-wide business proof, deployment or live enforcement.']);
    }
    if (request.verifyPlan) {
      emit({ status: verification ? 'verified' : 'planned', verification: verification ?? undefined, message: 'No additional checks are required or replayed. File effects still need their separate exact approval.' });
      return 2;
    }
    const fileApproved = request.approvePlan === inspection.plan.fingerprint ||
      await approve(inspection.plan.fingerprint, 'Apply only the displayed exact application/metadata/integration files and immutable adoption record now?');
    if (!fileApproved) {
      emit({ status: 'cancelled', message: 'File transaction was declined or unavailable. Earlier separately approved preparation/check effects are retained in this outcome; no further writes ran.' });
      return 2;
    }
    inspection = await revalidate();
    const rootMode = inspection.inventory.directoryInventory.find((directory) => directory.pathParts.length === 0)?.mode;
    if (rootMode === null || rootMode === undefined) throw new ApplicationInspectionError('Adoption has no exact observed project directory mode.');
    await saveAdoptionPreEffect(inspection.plan, rootMode, storage);
    const originalFiles = inspection.snapshots.filter((snapshot) => inspection.application.mutations.some((mutation) =>
      applicationPathKey(mutation.pathParts) === applicationPathKey(snapshot.pathParts)));
    const backup = originalFiles.length ? await preserveProjectOriginals(inspection.plan, originalFiles, 'adoption', storage) : null;
    if (backup) report.backup = backup;
    const manifestMutation = inspection.mutations.find((mutation) => applicationPathKey(mutation.pathParts) === 'liftoff.manifest.json');
    if (!manifestMutation || manifestMutation.type !== 'write') throw new ApplicationInspectionError('The reviewed adoption has no exact manifest producer.');
    const record: AdoptionRecord = {
      schemaVersion: 1, kind: 'liftoff-adoption-record', ...adoptionExecutionIdentity(liftoffVersion),
      recordId: inspection.plan.recordId, projectRoot: root, projectIdentity: inspection.plan.projectIdentity,
      fingerprint: inspection.plan.fingerprint, reviewedAt: inspection.plan.createdAt, standards: inspection.plan.standards,
      assessmentDigest: inspection.plan.assessmentDigest, source: inspection.plan.source, effects: inspection.plan.effects,
      verification: { status: verification ? 'passed' : 'not-required', digest: verification ? canonicalSha256(verification) : null },
      backup: backup ? { namespace: 'adoption-backup', indexKey: backup.indexKey } : null,
      authorization: { namespace: 'adoption-approval', fingerprint: inspection.plan.fingerprint, boundary: 'exact-transaction-digest' },
      manifestHash: applicationDigest(manifestMutation.content), activationEvidence: 'not-issued'
    };
    const mutations = [
      ...inspection.mutations.filter((mutation) => applicationPathKey(mutation.pathParts) !== 'liftoff.manifest.json'),
      { type: 'write' as const, pathParts: adoptionHistoryPath(record.recordId), content: `${JSON.stringify(record, null, 2)}\n`, mode: adoptionFileMode },
      manifestMutation
    ];
    const transaction = await applyReviewedUpdateTransaction(root, mutations, {
      transactionKind: 'adoption', adoptionIdentity: adoptionExecutionIdentity(liftoffVersion),
      adoptionDirectories: inspection.directories,
      planFingerprint: inspection.plan.fingerprint, approvalStore, preconditions: inspection.snapshots,
      validatePlan: async () => {
        await assertAdoptionWriterIdle(root, storage, true);
        const current = await revalidate();
        if (current.plan.permissions.projectCode) {
          const proof = await readAdoptionVerification(current.plan, now(), storage);
          if (!proof || proof.candidateDigest !== applicationCandidateDigest(current.application)) throw new ApplicationInspectionError('Exact verified candidate proof is missing or stale at the locked file boundary.');
        }
      },
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase === 'committed') await checkpointCommittedAdoption(root, inspection.plan.fingerprint, storage);
      }
    });
    report.committed = transaction.committed;
    report.transaction = transaction;
    if (!transaction.committed) {
      emit({ status: 'incomplete', message: 'The adoption transaction did not commit. Only attributable original effects may be recovered.', blockers: [...transaction.rollbackFailures, ...transaction.cleanupFailures] });
      return 2;
    }
    for (const mutation of mutations) {
      const current = await captureProjectFileSnapshot(root, mutation.pathParts);
      if (mutation.type === 'delete' ? current.content !== undefined :
        current.content === undefined || !current.content.equals(Buffer.isBuffer(mutation.content) ? mutation.content : Buffer.from(mutation.content, 'utf8')) ||
          mutation.mode !== undefined && current.mode !== mutation.mode) {
        throw new ApplicationInspectionError(`Committed adoption readback differs at ${mutation.pathParts.join('/')}; preserve the recorded checkpoint and newer bytes.`);
      }
    }
    await loadManifest(root);
    await saveCommittedAdoption(record, storage);
    emit({
      status: transaction.cleanupFailures.length ? 'incomplete' : 'committed',
      complete: transaction.cleanupFailures.length === 0, committed: true,
      message: 'Reviewed local adoption committed and read back. Source business behavior, broader standards, repository enforcement and cloud activation are not implied.',
      blockers: [...transaction.cleanupFailures], nextActions: transaction.cleanupFailures.length ? [recoveryAction(root)] : []
    });
    return transaction.cleanupFailures.length ? 2 : 0;
  } catch (error) {
    emit({
      status: report.committed ? 'incomplete' : 'failed', complete: false,
      message: report.committed ? 'Adoption committed, but final verification/checkpointing is incomplete; earlier effects remain recorded.' : 'Adoption stopped without authorizing further effects.',
      blockers: [error instanceof Error ? error.message : 'Adoption could not safely complete.'],
      ...(report.committed ? { nextActions: [recoveryAction(root)] } : {})
    });
    return report.committed ? 2 : 1;
  }
}
