import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  withProjectMutationLock, withUserScopeMutationLock, type ProjectMutationLease
} from '../../adapters/filesystem/project-lock.js';
import {
  reviewedAdoptionTransactionPathParts, reviewedInstallationTransactionPathParts,
  reviewedRepairTransactionPathParts, reviewedSkillsTransactionPathParts, reviewedUpdateTransactionPathParts,
  type ReviewedTransactionKind
} from '../../domain/project/reviewed-update-artifacts.js';
import { createStructuredContinuation, type StructuredContinuationV1 } from '../../protocol/continuation.js';
import { ApplicationFiles, canonicalApplicationRoot } from '../repair/application-files.js';
import { inspectRepairVerificationWorkspaces, type RepairWorkspaceStorageOptions } from '../repair/workspaces.js';

export {
  reviewedAdoptionTransactionPathParts, reviewedInstallationTransactionPathParts,
  reviewedSkillsTransactionPathParts, withUserScopeMutationLock
};

export interface ExecutionExclusionOptions {
  currentCommand?: string;
  storage?: RepairWorkspaceStorageOptions;
  targetScope?: 'project' | 'user';
}

export class ConflictingTransactionError extends Error {
  constructor(message: string, readonly details: {
    kind: 'transaction' | 'initialization-lock' | 'verification-workspace' | 'unsafe-boundary';
    transactionKind?: ReviewedTransactionKind;
    conflictingPath?: string;
    continuation?: StructuredContinuationV1;
    recoveryCommand?: string;
    currentCommand?: string;
  }) {
    super(message);
    this.name = 'ConflictingTransactionError';
  }
}

const journals = [
  ['update', reviewedUpdateTransactionPathParts], ['repair', reviewedRepairTransactionPathParts],
  ['adoption', reviewedAdoptionTransactionPathParts], ['skills', reviewedSkillsTransactionPathParts],
  ['installation', reviewedInstallationTransactionPathParts]
] as const;

export function transactionRecoveryGuidance(
  root: string, kind: ReviewedTransactionKind, targetScope: 'project' | 'user' = 'project'
): { description: string; continuation?: StructuredContinuationV1; recoveryCommand?: string } {
  if (kind === 'installation' || targetScope === 'user') {
    return { description: 'Preserve the original record and inspect its exact owner and target with the owning command. No executable recovery is inferred from a directory alone.' };
  }
  const args = kind === 'skills' ? ['skills', 'inspect', '--scope', 'project', '--project', root] :
    kind === 'adoption' ? ['adopt', '--project', root, '--recover'] :
    kind === 'repair' ? ['repair', '--project', root, '--recover'] : ['update', '--project', root];
  try {
    const continuation = createStructuredContinuation({
      args, cwd: root, project: root, targetScope: 'project',
      scope: kind === 'skills' ? 'skills-inspection' : `${kind}-recovery`,
      requiredAuthority: kind === 'skills' ? [] : ['original-recorded-effect-recovery'],
      compatibilityIdentity: kind === 'repair' ? 'repair-contract-v1' : `${kind}-transaction-v1`
    });
    return {
      description: kind === 'skills'
        ? `Inspect the recorded skills transaction; this does not approve or perform recovery: ${continuation.displayCommand}.`
        : `Review only the original recorded effects with ${continuation.displayCommand}; then request a fresh check.`,
      continuation, recoveryCommand: continuation.displayCommand
    };
  } catch {
    return { description: 'Preserve the record. Its target cannot be represented by a supported executable continuation; use the owning command only after resolving that exact boundary.' };
  }
}

export async function assertNoConflictingTransactions(
  projectRoot: string, options: ExecutionExclusionOptions = {}
): Promise<void> {
  let root: string;
  try {
    root = await canonicalApplicationRoot(projectRoot);
    const reader = new ApplicationFiles(root);
    const check = async (parts: readonly string[]): Promise<boolean> => {
      await reader.observeParents(parts);
      try { await lstat(path.join(root, ...parts)); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return false;
      }
    };
    if (await check(['.liftoff-init.lock'])) {
      throw new ConflictingTransactionError(
        `A legacy Liftoff initialization lock exists in ${root}. Verify its owner has stopped; the existing entry was preserved.`,
        { kind: 'initialization-lock', conflictingPath: path.join(root, '.liftoff-init.lock'), currentCommand: options.currentCommand }
      );
    }
    for (const [kind, parts] of journals) {
      if (!await check(parts)) continue;
      const guidance = transactionRecoveryGuidance(root, kind, options.targetScope);
      const conflictingPath = path.join(root, ...parts);
      throw new ConflictingTransactionError(
        `An unfinished ${kind} transaction blocks new work: ${conflictingPath}. ${guidance.description}`,
        { kind: 'transaction', transactionKind: kind, conflictingPath,
          continuation: guidance.continuation, recoveryCommand: guidance.recoveryCommand, currentCommand: options.currentCommand }
      );
    }
    await reader.assertUnchanged();
  } catch (error) {
    if (error instanceof ConflictingTransactionError) throw error;
    throw new ConflictingTransactionError(
      `Unable to safely inspect the project transaction boundary; existing entries were preserved. ${error instanceof Error ? error.message : String(error)}`,
      { kind: 'unsafe-boundary', currentCommand: options.currentCommand }
    );
  }
  const workspaces = await inspectRepairVerificationWorkspaces(root, options.storage);
  if (workspaces.status !== 'absent') {
    const guidance = transactionRecoveryGuidance(root, 'repair', options.targetScope);
    throw new ConflictingTransactionError(
      `Active or retained private verification workspaces block conflicting writers in ${root}. ${guidance.description}`,
      { kind: 'verification-workspace', continuation: guidance.continuation,
        recoveryCommand: guidance.recoveryCommand, currentCommand: options.currentCommand }
    );
  }
}

export async function withCooperatingExecutionLock<T>(
  projectRoot: string, operation: (lease: ProjectMutationLease) => Promise<T>, options: ExecutionExclusionOptions = {}
): Promise<T> {
  await assertNoConflictingTransactions(projectRoot, options);
  return withProjectMutationLock(projectRoot, async (lease) => {
    await assertNoConflictingTransactions(projectRoot, options);
    await lease.assertHeld();
    const result = await operation(lease);
    await lease.assertHeld();
    return result;
  });
}

export async function withCooperatingUserScopeExecutionLock<T>(
  userRoot: string, operation: (lease: ProjectMutationLease) => Promise<T>, options: ExecutionExclusionOptions = {}
): Promise<T> {
  const scope = { ...options, targetScope: 'user' as const };
  await assertNoConflictingTransactions(userRoot, scope);
  return withUserScopeMutationLock(userRoot, async (lease) => {
    await assertNoConflictingTransactions(userRoot, scope);
    await lease.assertHeld();
    const result = await operation(lease);
    await lease.assertHeld();
    return result;
  });
}
