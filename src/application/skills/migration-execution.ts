import {
  applyReviewedUpdateTransaction, inspectReviewedUpdateTransaction, ReviewedUpdateTransactionError,
  type ReviewedUpdateTransactionOutcome, type ReviewedUpdateTransactionCheckpoint
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import { withProjectMutationLock, ProjectMutationLockError } from '../../adapters/filesystem/project-lock.js';
import {
  reviewedAdoptionTransactionPathParts, reviewedRepairTransactionPathParts,
  reviewedSkillsTransactionPathParts, reviewedUpdateTransactionPathParts
} from '../../domain/project/reviewed-update-artifacts.js';
import { captureSkillFile } from '../../adapters/skills/discovery.js';
import { canonicalJson } from '../../domain/governance/activation/canonical-json.js';
import { hasUsableApprovalTerminal, requestUpdateApproval } from '../update/approval.js';
import { captureCanonicalSkillInputs, checkedSkillCatalog } from './planning.js';
import {
  assertNoPrivateSkillWorkspaces, skillTransactionRecoveryDetails, validateSkillsExecutionOptions,
  type ExecutePlanOptions, type SkillExecutionDependencies, type SkillExecutionResult
} from './execution.js';
import {
  assertSkillAliasRetirementStateAbsent, recheckRegisteredSkillMigration, registeredMigrationState, verifyRegisteredSkillMigration,
  type RegisteredSkillMigrationPlan
} from './registered-migration.js';

export interface SkillMigrationExecutionDependencies extends Omit<SkillExecutionDependencies, 'presentPlan'> {
  presentMigrationPlan?: (plan: RegisteredSkillMigrationPlan) => void | Promise<void>;
}

const journalPaths = [
  reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts,
  reviewedAdoptionTransactionPathParts, reviewedSkillsTransactionPathParts
].map((parts) => parts.join('/'));

export async function executeRegisteredSkillMigration(
  reviewed: RegisteredSkillMigrationPlan, options: ExecutePlanOptions, dependencies: SkillMigrationExecutionDependencies
): Promise<SkillExecutionResult> {
  validateSkillsExecutionOptions(options);
  let plan = await recheckRegisteredSkillMigration(reviewed);
  const recoveryScope = { targetRoot: plan.projectRoot, fingerprint: plan.fingerprint };
  const facts = (message: string) => ({
    appliedCount: 0, fileChangeCount: 0, ownershipChangeCount: 0, planFingerprint: plan.fingerprint,
    actions: plan.sources.map((source) => ({
      skillId: 'setup', relativeDestination: source.pathParts.join('/'), action: 'retire-registered-alias', status: 'unapplied' as const
    })),
    recovery: skillTransactionRecoveryDetails(recoveryScope), message
  });
  if (options.approvePlan !== undefined && options.approvePlan !== plan.fingerprint) {
    return {
      ...facts('Approval does not match this exact registered skill migration. An update or unrelated skills fingerprint cannot authorize it.'),
      outcome: 'blocked', ok: false, committed: false, verified: false, uncertain: false
    };
  }
  const context = dependencies.approvalContext;
  const interactive = !options.json && context !== undefined && hasUsableApprovalTerminal(context);
  if (options.approvePlan === undefined && !interactive) {
    return {
      ...facts('Preview only; this registered migration requires genuine terminal approval or its exact machine fingerprint.'),
      outcome: 'approval-required', ok: false, committed: false, verified: false, uncertain: false
    };
  }
  if (interactive && options.approvePlan === undefined) {
    if (!dependencies.presentMigrationPlan) throw new Error('Display the immutable migration before requesting approval.');
    await dependencies.presentMigrationPlan(plan);
  }
  const approval = await requestUpdateApproval({
    fingerprint: plan.fingerprint, approvePlan: options.approvePlan,
    message: 'Retire only these registered obsolete project aliases and preserve their exact history? Active native integrations will not be overwritten.'
  }, context ?? { stderr: process.stderr });
  if (approval.status !== 'approved') {
    return {
      ...facts('The registered skill migration was declined; no transaction ran.'),
      outcome: 'declined', ok: false, committed: false, verified: false, uncertain: false
    };
  }
  if (!dependencies.approvalStore) throw new Error('A registered private approval store is required; no direct mutation fallback exists.');
  let transaction: ReviewedUpdateTransactionOutcome | undefined;
  let verified = false;
  try {
    return await withProjectMutationLock(plan.projectRoot, async (lease) => {
      plan = await recheckRegisteredSkillMigration(reviewed);
      const prepared = registeredMigrationState(plan);
      const applied = new Set<string>();
      const guard = async () => {
        await lease.assertHeld();
        const now = (prepared.dependencies.now ?? (() => new Date()))();
        if (!Number.isFinite(now.getTime()) || now.getTime() < Date.parse(plan.validFrom) || now.getTime() >= Date.parse(plan.expiresAt)) {
          throw new Error('Registered skill migration expired before completion.');
        }
        await assertSkillAliasRetirementStateAbsent(plan.projectRoot);
        if (canonicalJson(await captureCanonicalSkillInputs(checkedSkillCatalog())) !== canonicalJson(plan.catalogInputs)) {
          throw new Error('Canonical inputs changed during registered skill migration.');
        }
        for (const file of plan.files) {
          const key = file.pathParts.join('/');
          if (applied.has(key) || key === reviewedSkillsTransactionPathParts.join('/')) continue;
          if (canonicalJson((await captureSkillFile(plan.projectRoot, file.pathParts)).observation) !== canonicalJson(file)) {
            throw new Error(`Registered skill migration input changed: ${key}`);
          }
        }
        await assertNoPrivateSkillWorkspaces({ scope: 'project', targetRoot: plan.projectRoot }, prepared.dependencies.storage);
      };
      const checkpoint = async (entry: ReviewedUpdateTransactionCheckpoint) => {
        if (entry.phase === 'after-mutation' && entry.index !== undefined) {
          applied.add(prepared.mutations[entry.index].pathParts.join('/'));
        }
        await guard();
        await dependencies.onCheckpoint?.(entry);
        await guard();
        if (entry.phase === 'committed') {
          await verifyRegisteredSkillMigration(plan.projectRoot, plan.identity);
          verified = true;
        }
      };
      transaction = await applyReviewedUpdateTransaction(plan.projectRoot, prepared.mutations, {
        transactionKind: 'skills', skillsIdentity: plan.identity,
        skillsDirectories: plan.directories.map((directory) => directory.state === 'absent'
          ? { pathParts: [...directory.pathParts], state: 'absent' }
          : {
            pathParts: [...directory.pathParts], state: 'directory',
            device: directory.device!, inode: directory.inode!, mode: directory.mode!
          }),
        approvalStore: dependencies.approvalStore, planFingerprint: plan.fingerprint,
        preconditions: prepared.preconditions.filter((snapshot) => !journalPaths.includes(snapshot.pathParts.join('/'))),
        validatePlan: async () => { await recheckRegisteredSkillMigration(reviewed); },
        onCheckpoint: checkpoint,
        onBeforeMutation: async (mutation, index) => {
          await guard();
          await dependencies.onBeforeMutation?.(mutation, index);
          await guard();
        }
      });
      await lease.assertHeld();
      verified = false;
      await verifyRegisteredSkillMigration(plan.projectRoot, plan.identity);
      verified = true;
      if (!transaction.committed || transaction.cleanupFailures.length > 0) {
        throw new Error('Registered migration commit or cleanup remains incomplete.');
      }
      return {
        ...facts('Retired the exact registered obsolete aliases and verified their preserved history. Existing native targets were not moved or overwritten.'),
        outcome: 'applied', ok: true, committed: true, verified: true, uncertain: false,
        appliedCount: plan.sources.length, fileChangeCount: prepared.mutations.length, ownershipChangeCount: plan.sources.length,
        actions: plan.sources.map((source) => ({
          skillId: 'setup', relativeDestination: source.pathParts.join('/'), action: 'retire-registered-alias', status: 'applied'
        })),
        recovery: skillTransactionRecoveryDetails(recoveryScope, transaction)
      };
    });
  } catch (error) {
    const pending = await inspectReviewedUpdateTransaction(plan.projectRoot, {
      transactionKind: 'skills', skillsScope: 'project', approvalStore: dependencies.approvalStore
    });
    const committed = transaction?.committed === true || pending.committed;
    const failures = error instanceof ReviewedUpdateTransactionError ? error.rollbackFailures : [];
    const recovered = transaction ?? (error instanceof ReviewedUpdateTransactionError && !failures.length && pending.status === 'absent'
      ? { status: 'rolled-back' as const, committed: false, rollbackFailures: [], cleanupFailures: [] } : undefined);
    const message = error instanceof Error ? error.message : String(error);
    if (recovered?.committed && recovered.cleanupFailures.length === 0) recovered.cleanupFailures.push(message);
    return {
      ...facts(message), outcome: 'failed', ok: false, committed, verified,
      uncertain: pending.status === 'blocked' || pending.status === 'interrupted' ||
        committed && !verified || failures.length > 0 || error instanceof ProjectMutationLockError,
      appliedCount: committed ? plan.sources.length : 0,
      fileChangeCount: committed ? plan.effects.length : 0,
      ownershipChangeCount: committed ? plan.sources.length : 0,
      actions: plan.sources.map((source) => ({
        skillId: 'setup', relativeDestination: source.pathParts.join('/'), action: 'retire-registered-alias',
        status: committed ? 'applied' : pending.status === 'absent' ? 'unapplied' : 'uncertain'
      })),
      recovery: skillTransactionRecoveryDetails(recoveryScope, recovered, failures, pending)
    };
  }
}
