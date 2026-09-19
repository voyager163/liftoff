import path from 'node:path';
import type {
  SkillDeliveryPlan,
  SkillDirectoryObservation,
  SkillScope
} from '../../domain/skills/contracts.js';
import {
  skillsDeliveryRecipe,
  validateSkillsExecutionIdentity
} from '../../domain/skills/identity.js';
import { canonicalJson, canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  applyReviewedUpdateTransaction,
  inspectReviewedUpdateTransaction,
  recoverReviewedUpdateTransaction,
  ReviewedUpdateTransactionError,
  type ReviewedUpdateApprovalStore,
  type ReviewedUpdateTransactionCheckpoint,
  type ReviewedUpdateTransactionInspection,
  type ReviewedUpdateTransactionDestination,
  type ReviewedUpdateTransactionOutcome
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import { ProjectMutationLockError, withProjectMutationLock, withUserScopeMutationLock } from '../../adapters/filesystem/project-lock.js';
import {
  reviewedAdoptionTransactionPathParts,
  reviewedRepairTransactionPathParts,
  reviewedSkillsTransactionPathParts,
  reviewedUpdateTransactionPathParts
} from '../../domain/project/reviewed-update-artifacts.js';
import {
  assertSkillDirectoryIdentities,
  captureSkillDirectories,
  captureSkillDirectoryIdentity,
  captureSkillFile
} from '../../adapters/skills/discovery.js';
import type { ProjectFileMutation } from '../../adapters/filesystem/project-transaction.js';
import { createSkillsOwnershipAuthorityStore, type UpdatePreviewOptions } from '../../adapters/filesystem/update-previews.js';
import {
  hasUsableApprovalTerminal,
  isUpdatePlanFingerprint,
  requestUpdateApproval,
  type UpdateApprovalContext
} from '../update/approval.js';
import {
  buildSkillMutations,
  captureCanonicalSkillInputs,
  checkedSkillCatalog,
  recheckSkillDeliveryPlan,
  skillPlanState
} from './planning.js';
import { loadOwnershipStore, recordSkillOwnershipAuthority, verifySkillOwnershipAuthority, type SkillOwnershipAuthorityStore } from './ownership.js';

export interface ExecutePlanOptions {
  approvePlan?: string;
  json?: boolean;
}

export interface SkillExecutionDependencies {
  approvalStore: ReviewedUpdateApprovalStore;
  approvalContext?: UpdateApprovalContext;
  presentPlan?: (plan: SkillDeliveryPlan) => void | Promise<void>;
  workspaceStorage?: UpdatePreviewOptions;
  onCheckpoint?: (checkpoint: ReviewedUpdateTransactionCheckpoint) => Promise<void>;
  onBeforeMutation?: (mutation: ProjectFileMutation, index: number) => Promise<void>;
}

export interface ExecutedSkillAction {
  skillId: string;
  relativeDestination: string;
  action: string;
  status: 'applied' | 'retained' | 'unapplied' | 'uncertain';
}

export interface SkillRecoveryDetails {
  status: 'not-required' | 'required' | 'blocked' | 'complete';
  journalPath: string;
  planFingerprint?: string;
  transactionDigest?: string;
  rollbackFailures: readonly string[];
  cleanupFailures: readonly string[];
  destinations: readonly ReviewedUpdateTransactionDestination[];
  directoryCleanup: 'not-attempted';
}

interface SkillExecutionFacts {
  /** Counts committed effects; interrupted per-path progress remains in recovery.destinations. */
  appliedCount: number;
  fileChangeCount: number;
  ownershipChangeCount: number;
  actions: readonly ExecutedSkillAction[];
  planFingerprint: string;
  recovery: SkillRecoveryDetails;
  message: string;
}

export type SkillExecutionResult = SkillExecutionFacts & (
  | { outcome: 'applied'; ok: true; committed: true; verified: true; uncertain: false }
  | { outcome: 'unchanged'; ok: true; committed: false; verified: true; uncertain: false }
  | { outcome: 'approval-required' | 'declined' | 'blocked'; ok: false; committed: false; verified: false; uncertain: false }
  | { outcome: 'failed'; ok: false; committed: boolean; verified: boolean; uncertain: boolean }
);

export interface SkillsRecoveryOutcome extends ReviewedUpdateTransactionOutcome {
  verified: boolean;
  uncertain: boolean;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function validateSkillsExecutionOptions(options: ExecutePlanOptions): void {
  if (Object.keys(options).some((key) => !['approvePlan', 'json'].includes(key)) ||
      options.json !== undefined && typeof options.json !== 'boolean') {
    throw new Error('Skills execution accepts only exact --approve-plan and JSON options; generic Yes, force, and interactive booleans are not approval.');
  }
  if (options.approvePlan !== undefined && !isUpdatePlanFingerprint(options.approvePlan)) {
    throw new Error('Skills --approve-plan must contain exactly 64 lowercase hexadecimal characters.');
  }
}

export function skillTransactionRecoveryDetails(
  plan: Pick<SkillDeliveryPlan, 'targetRoot' | 'fingerprint'>, outcome?: ReviewedUpdateTransactionOutcome,
  failures: readonly string[] = [], pending?: ReviewedUpdateTransactionInspection
): SkillRecoveryDetails {
  const rollbackFailures = [...outcome?.rollbackFailures ?? [], ...failures];
  const cleanupFailures = outcome?.cleanupFailures ?? [];
  const blocked = rollbackFailures.length > 0 || cleanupFailures.length > 0 || pending?.status === 'blocked';
  return {
    status: blocked ? 'blocked' : pending && pending.status !== 'absent' ? 'required'
      : outcome?.status === 'rolled-back' ? 'complete' : 'not-required',
    journalPath: path.join(plan.targetRoot, ...reviewedSkillsTransactionPathParts),
    planFingerprint: plan.fingerprint,
    ...(outcome?.transactionDigest || pending?.transactionDigest
      ? { transactionDigest: outcome?.transactionDigest ?? pending?.transactionDigest } : {}),
    rollbackFailures, cleanupFailures, destinations: pending?.destinations ?? [],
    directoryCleanup: 'not-attempted'
  };
}

function facts(plan: SkillDeliveryPlan, message: string): SkillExecutionFacts {
  return {
    appliedCount: 0, fileChangeCount: 0, ownershipChangeCount: 0, planFingerprint: plan.fingerprint,
    actions: plan.actions.map((action) => ({
      skillId: action.skillId, relativeDestination: action.relativeDestination, action: action.action, status: 'unapplied'
    })),
    recovery: skillTransactionRecoveryDetails(plan), message
  };
}

export async function assertNoPrivateSkillWorkspaces(
  plan: Pick<SkillDeliveryPlan, 'scope' | 'targetRoot'>, storage?: UpdatePreviewOptions
): Promise<void> {
  if (plan.scope !== 'project') return;
  const { inspectRepairVerificationWorkspaces } = await import('../repair/workspaces.js');
  const workspaces = await inspectRepairVerificationWorkspaces(plan.targetRoot, storage);
  if (workspaces.status !== 'absent') {
    throw new Error(`Retained or uninspectable private repair/adoption workspaces block skills changes. Inspect the original recovery scope: ${JSON.stringify(workspaces.issues)}`);
  }
}

async function assertDiscoveryCurrent(plan: SkillDeliveryPlan): Promise<void> {
  for (const discovery of plan.discovery) {
    const files = [];
    for (const file of discovery.files) files.push((await captureSkillFile(discovery.root, file.pathParts)).observation);
    const directories = await captureSkillDirectories(discovery.root, files.map((file) => file.pathParts));
    if (canonicalJson({ files, directories }) !== canonicalJson({ files: discovery.files, directories: discovery.directories })) {
      throw new Error('Personal/project discovery changed after review; preserve both scopes and review a fresh plan.');
    }
  }
}

export async function executeSkillDeliveryPlan(
  plan: SkillDeliveryPlan,
  options: ExecutePlanOptions,
  dependencies: SkillExecutionDependencies
): Promise<SkillExecutionResult> {
  validateSkillsExecutionOptions(options);
  const prepared = skillPlanState(plan);
  await recheckSkillDeliveryPlan(plan);
  if (plan.hasCollisions || plan.hasConflicts || plan.summary.blocked > 0) {
    return {
      ...facts(plan, 'Unresolved ownership, discovery, or transaction conflicts block this exact skills operation.'),
      outcome: 'blocked', ok: false, committed: false, verified: false, uncertain: false
    };
  }
  if (options.approvePlan !== undefined && options.approvePlan !== plan.fingerprint) {
    return {
      ...facts(plan, 'Approval fingerprint does not match the current operation, content, target, and review window. Review a fresh skills plan.'),
      outcome: 'blocked', ok: false, committed: false, verified: false, uncertain: false
    };
  }
  const initial = buildSkillMutations(plan);
  if (initial.mutations.length === 0) {
    return {
      ...facts(plan, 'Selected managed projections are unchanged; no files, ownership metadata, timestamps, locks, or approvals were written.'),
      actions: plan.actions.map((action) => ({
        skillId: action.skillId, relativeDestination: action.relativeDestination, action: action.action, status: 'retained'
      })),
      outcome: 'unchanged', ok: true, committed: false, verified: true, uncertain: false
    };
  }
  if (!dependencies?.approvalStore) throw new Error('Skills requires the registered private transaction approval store; no direct mutator fallback is available.');
  const context = dependencies.approvalContext;
  const interactive = options.json !== true && context !== undefined && hasUsableApprovalTerminal(context);
  if (options.approvePlan === undefined && interactive && dependencies.presentPlan === undefined) {
    throw new Error('The immutable skills plan must be displayed before requesting interactive approval.');
  }
  if (interactive && options.approvePlan === undefined) await dependencies.presentPlan!(plan);
  const approval = options.approvePlan === undefined && !interactive
    ? { status: 'required' as const }
    : await requestUpdateApproval({
      fingerprint: plan.fingerprint, approvePlan: options.approvePlan,
      message: `Apply this exact ${plan.scope}-scope skills ${plan.intent} plan?`
    }, context ?? { stderr: process.stderr });
  if (approval.status !== 'approved') {
    return {
      ...facts(plan, approval.status === 'declined' ? 'The skills operation was declined; no transaction ran.' : 'Review this plan and approve the selected operation; JSON and nonterminal input do not authorize writes.'),
      outcome: approval.status === 'declined' ? 'declined' : 'approval-required',
      ok: false, committed: false, verified: false, uncertain: false
    };
  }

  let transaction: ReviewedUpdateTransactionOutcome | undefined;
  let verified = false;
  let currentPlan = plan;
  const lock = plan.scope === 'user' ? withUserScopeMutationLock : withProjectMutationLock;
  try {
    return await lock(plan.targetRoot, async (lease) => {
      currentPlan = await recheckSkillDeliveryPlan(plan);
      const state = skillPlanState(currentPlan);
      const { mutations, store } = buildSkillMutations(currentPlan);
      await assertNoPrivateSkillWorkspaces(currentPlan, dependencies.workspaceStorage);
      await lease.assertHeld();
      const directoryIdentities = new Map<string, SkillDirectoryObservation>();
      const allowedCreatedDirectories = new Set<string>();
      const appliedPaths = new Set<string>();
      const checkGuards = async (): Promise<void> => {
        await lease.assertHeld();
        const now = (prepared.dependencies.now ?? (() => new Date()))();
        if (!Number.isFinite(now.getTime()) || now.getTime() < Date.parse(plan.validFrom) || now.getTime() >= Date.parse(plan.expiresAt)) {
          throw new Error('Skills plan expired before completion; further effects were stopped.');
        }
        const catalog = checkedSkillCatalog(prepared.dependencies.loadCatalog);
        if (canonicalSha256(catalog) !== plan.catalogDigest ||
            canonicalJson(await captureCanonicalSkillInputs(catalog, prepared.dependencies.catalogRoot)) !== canonicalJson(plan.catalogInputs)) {
          throw new Error('The canonical skills catalog changed after approval.');
        }
        await assertSkillDirectoryIdentities(plan.targetRoot, plan.directories);
        for (const directory of plan.directories.filter((entry) => entry.state === 'absent')) {
          const key = directory.pathParts.join('/');
          const current = await captureSkillDirectoryIdentity(plan.targetRoot, directory.pathParts);
          const original = directoryIdentities.get(key);
          if (original) {
            if (canonicalJson(current) !== canonicalJson(original)) throw new Error(`Created skill directory changed identity: ${key}`);
          } else if (current.state === 'directory') {
            if (!allowedCreatedDirectories.has(key)) throw new Error(`Skill directory appeared after review: ${key}`);
            directoryIdentities.set(key, current);
          }
        }
        for (const file of plan.files) {
          if (appliedPaths.has(file.pathParts.join('/')) ||
              file.pathParts.join('/') === reviewedSkillsTransactionPathParts.join('/')) continue;
          const current = (await captureSkillFile(plan.targetRoot, file.pathParts)).observation;
          if (canonicalJson(current) !== canonicalJson(file)) throw new Error(`Skill input identity changed after review: ${file.pathParts.join('/')}`);
        }
        await assertDiscoveryCurrent(plan);
        await assertNoPrivateSkillWorkspaces(plan, dependencies.workspaceStorage);
      };
      const checkpoint = async (entry: ReviewedUpdateTransactionCheckpoint): Promise<void> => {
        if (entry.phase === 'prepared') allowedCreatedDirectories.add('.liftoff');
        if (entry.phase === 'staged' && entry.index !== undefined) {
          const mutation = mutations[entry.index];
          for (let count = 1; count < mutation.pathParts.length; count += 1) {
            allowedCreatedDirectories.add(mutation.pathParts.slice(0, count).join('/'));
          }
        }
        if (entry.phase === 'after-mutation' && entry.index !== undefined) appliedPaths.add(mutations[entry.index].pathParts.join('/'));
        await checkGuards();
        if (entry.phase === 'prepared') {
          await recordSkillOwnershipAuthority(store, plan.fingerprint, plan.catalogDigest, state.dependencies.ownershipAuthority!);
        }
        await dependencies.onCheckpoint?.(entry);
        await checkGuards();
      };
      transaction = await applyReviewedUpdateTransaction(plan.targetRoot, mutations, {
        transactionKind: 'skills',
        skillsIdentity: validateSkillsExecutionIdentity({
          cliVersion: plan.cliVersion, skillsContractVersion: 1, recipe: skillsDeliveryRecipe,
          scope: plan.scope, intent: plan.intent, catalogDigest: plan.catalogDigest, hosts: plan.hosts, skillIds: plan.skillIds
        }),
        skillsDirectories: plan.directories.map((directory) => directory.state === 'absent'
          ? { pathParts: [...directory.pathParts], state: 'absent' }
          : {
            pathParts: [...directory.pathParts], state: 'directory',
            device: directory.device!, inode: directory.inode!, mode: directory.mode!
          }),
        planFingerprint: plan.fingerprint, approvalStore: dependencies.approvalStore,
        preconditions: state.snapshots.filter((snapshot) => ![
          reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts,
          reviewedAdoptionTransactionPathParts, reviewedSkillsTransactionPathParts
        ].some((parts) => parts.join('/') === snapshot.pathParts.join('/'))),
        validatePlan: async () => { await recheckSkillDeliveryPlan(plan); },
        onCheckpoint: checkpoint,
        onBeforeMutation: async (mutation, index) => {
          await checkGuards();
          await dependencies.onBeforeMutation?.(mutation, index);
          await checkGuards();
        }
      });
      await lease.assertHeld();
      for (const mutation of mutations) {
        const current = await captureSkillFile(plan.targetRoot, mutation.pathParts);
        const original = state.snapshots.find((snapshot) => snapshot.pathParts.join('/') === mutation.pathParts.join('/'));
        if (mutation.type === 'delete' ? current.snapshot.content !== undefined :
          current.snapshot.content === undefined ||
          !current.snapshot.content.equals(Buffer.from(mutation.content)) ||
          current.snapshot.mode !== (process.platform === 'win32' ? mutation.mode! & 0o200 ? 0o666 : 0o444 : mutation.mode ?? original?.mode)) {
          throw new Error(`Committed skills readback differs from the exact target: ${mutation.pathParts.join('/')}`);
        }
      }
      const recorded = await loadOwnershipStore(plan.scope, plan.targetRoot);
      if (canonicalJson(recorded) !== canonicalJson(store)) {
        throw new Error('Committed skills ownership readback differs from the exact approved inventory.');
      }
      await verifySkillOwnershipAuthority(recorded, state.dependencies.ownershipAuthority!);
      verified = true;
      if (!transaction.committed || transaction.cleanupFailures.length > 0) {
        throw new Error('Skills transaction did not finish its registered commit and cleanup boundary.');
      }
      return {
        ...facts(plan, 'Applied and independently read back the exact selected skills inventory. Native host discovery remains separately qualified.'),
        outcome: 'applied', ok: true, committed: true, verified: true, uncertain: false,
        appliedCount: plan.actions.filter((action) => action.ownershipChanged).length,
        fileChangeCount: mutations.filter((mutation) => mutation.pathParts.join('/') !== '.liftoff/skills-ownership.json').length,
        ownershipChangeCount: plan.summary.ownership,
        actions: plan.actions.map((action) => ({
          skillId: action.skillId, relativeDestination: action.relativeDestination, action: action.action,
          status: action.ownershipChanged ? 'applied' : 'retained'
        })),
        recovery: skillTransactionRecoveryDetails(plan, transaction)
      };
    });
  } catch (error) {
    const pending = await inspectReviewedUpdateTransaction(plan.targetRoot, {
      transactionKind: 'skills', skillsScope: plan.scope, approvalStore: dependencies.approvalStore
    });
    const committed = transaction?.committed === true || pending.committed;
    const failures = error instanceof ReviewedUpdateTransactionError ? error.rollbackFailures : [];
    const recoveryOutcome = transaction ?? (error instanceof ReviewedUpdateTransactionError && pending.status === 'absent' && failures.length === 0 ? {
      status: 'rolled-back' as const, committed: false, rollbackFailures: [], cleanupFailures: []
    } : undefined);
    if (recoveryOutcome?.committed && recoveryOutcome.cleanupFailures.length === 0 && verified) {
      recoveryOutcome.cleanupFailures.push(messageOf(error));
    }
    return {
      ...facts(currentPlan, messageOf(error)), outcome: 'failed', ok: false, committed, verified,
      uncertain: pending.status === 'blocked' || pending.status === 'interrupted' ||
        committed && !verified || failures.length > 0 || error instanceof ProjectMutationLockError,
      appliedCount: committed ? plan.actions.filter((action) => action.ownershipChanged).length : 0,
      fileChangeCount: committed ? initial.mutations.filter((mutation) => mutation.pathParts.join('/') !== '.liftoff/skills-ownership.json').length : 0,
      ownershipChangeCount: committed ? plan.summary.ownership : 0,
      actions: plan.actions.map((action) => ({
        skillId: action.skillId, relativeDestination: action.relativeDestination, action: action.action,
        status: committed ? 'applied' : pending.status === 'absent' ? 'unapplied' : 'uncertain'
      })),
      recovery: skillTransactionRecoveryDetails(plan, recoveryOutcome, failures, pending)
    };
  }
}

export async function recoverSkillDeliveryTransaction(
  targetRoot: string, scope: SkillScope, approvedFingerprint: string,
  approvalStore: ReviewedUpdateApprovalStore,
  ownershipAuthority?: SkillOwnershipAuthorityStore
): Promise<SkillsRecoveryOutcome> {
  if (!isUpdatePlanFingerprint(approvedFingerprint)) throw new Error('Skills recovery requires the complete original lowercase plan fingerprint.');
  const lock = scope === 'user' ? withUserScopeMutationLock : withProjectMutationLock;
  let result: ReviewedUpdateTransactionOutcome | undefined;
  let committed = false;
  let committedReadback = false;
  let outcome: ReviewedUpdateTransactionOutcome;
  try {
    outcome = await lock(targetRoot, async () => {
      const pending = await inspectReviewedUpdateTransaction(targetRoot, { transactionKind: 'skills', skillsScope: scope, approvalStore });
      committed = pending.committed;
      if (pending.status === 'absent') return { status: 'absent', committed: false, rollbackFailures: [], cleanupFailures: [] };
      if (pending.status === 'blocked' || pending.planFingerprint !== approvedFingerprint || pending.skillsIdentity?.scope !== scope) {
        return {
          status: 'blocked', committed: pending.committed,
          rollbackFailures: [pending.reason ?? 'Skills recovery approval, scope, or original private seal does not match.'],
          cleanupFailures: []
        };
      }
      const recovered = await recoverReviewedUpdateTransaction(targetRoot, {
        transactionKind: 'skills', skillsScope: scope, approvalStore,
        validateRecovery: async (fingerprint) => {
          if (fingerprint !== approvedFingerprint) throw new Error('Skills recovery cannot acquire a different plan identity.');
          if (pending.skillsIdentity?.intent === 'migrate') {
            const { assertSkillAliasRetirementStateAbsent } = await import('./registered-migration.js');
            await assertSkillAliasRetirementStateAbsent(targetRoot);
          }
        },
        onCommittedReadback: async () => {
          if (pending.skillsIdentity?.intent === 'migrate') {
            const { verifyRegisteredSkillMigration } = await import('./registered-migration.js');
            await verifyRegisteredSkillMigration(targetRoot, pending.skillsIdentity);
          } else {
            const store = await loadOwnershipStore(scope, targetRoot);
            const authority = ownershipAuthority ?? createSkillsOwnershipAuthorityStore(targetRoot, scope,
              scope === 'user' ? { homedir: targetRoot, env: {} } : {});
            await verifySkillOwnershipAuthority(store, authority);
          }
          committedReadback = true;
        }
      });
      result = { ...recovered, committed: committed || recovered.committed };
      return result;
    });
  } catch (error) {
    outcome = result ? {
      ...result, status: 'blocked', cleanupFailures: [...result.cleanupFailures, messageOf(error)]
    } : { status: 'blocked', committed, rollbackFailures: [messageOf(error)], cleanupFailures: [] };
  }
  return {
    ...outcome,
    verified: outcome.status === 'rolled-back' || outcome.committed && committedReadback,
    uncertain: outcome.status === 'blocked' || outcome.cleanupFailures.length > 0 || outcome.committed && !committedReadback
  };
}
