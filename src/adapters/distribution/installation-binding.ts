import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { DistributionError } from '../../domain/distribution/errors.js';
import {
  reviewedAdoptionTransactionPathParts, reviewedInstallationTransactionPathParts, reviewedRepairTransactionPathParts,
  reviewedSkillsTransactionPathParts, reviewedUpdateTransactionPathParts
} from '../../domain/project/reviewed-update-artifacts.js';
import { withUserScopeMutationLock, type ProjectMutationLease } from '../filesystem/project-lock.js';
import { canonicalDestination, canonicalNativeRoot, ioCode, nativeDirectorySnapshot, type NativeDirectorySnapshot } from './native-files.js';
import { observeLauncher, type LauncherObservation } from './launcher-observation.js';

export interface InstallationPathBinding {
  path: string;
  state: 'absent' | 'directory' | 'launcher';
  directories: readonly NativeDirectorySnapshot[];
  launcher?: LauncherObservation;
}

export async function captureInstallationPath(target: string): Promise<InstallationPathBinding> {
  const directories: NativeDirectorySnapshot[] = [];
  let existing = path.dirname(target);
  for (;;) {
    try { directories.unshift(await nativeDirectorySnapshot(existing)); break; }
    catch (error) {
      if (ioCode(error) !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  await canonicalDestination(target, existing, true);
  try {
    const details = await lstat(target);
    if (details.isDirectory() && !details.isSymbolicLink()) {
      directories.push(await nativeDirectorySnapshot(target));
      return { path: target, state: 'directory', directories };
    }
    return { path: target, state: 'launcher', directories, launcher: await observeLauncher(target) };
  } catch (error) {
    if (ioCode(error) === 'ENOENT') return { path: target, state: 'absent', directories };
    throw error;
  }
}

export async function assertInstallationPaths(bindings: readonly InstallationPathBinding[]): Promise<void> {
  for (const expected of bindings) {
    if (canonicalSha256(await captureInstallationPath(expected.path)) !== canonicalSha256(expected)) {
      throw new DistributionError('An installation destination, launcher, directory identity, or mode changed after selection.', 'stale_plan');
    }
  }
}

export async function installationTransactionRoot(paths: readonly string[]): Promise<string> {
  if (!paths.length) throw new DistributionError('Installation mutation has no target boundary.');
  let common = path.dirname(paths[0]);
  for (const target of paths.slice(1)) {
    while (!within(common, target)) {
      const parent = path.dirname(common);
      if (parent === common) throw new DistributionError('Installation destinations have no bounded common native root.', 'unsafe_path');
      common = parent;
    }
  }
  for (;;) {
    try { return await canonicalNativeRoot(common); }
    catch (error) {
      if (ioCode(error) !== 'ENOENT') throw error;
      common = path.dirname(common);
    }
  }
}

export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function assertInstallationNotProjectOwned(target: string, homeRoot: string): Promise<void> {
  let current = path.dirname(target);
  while (current !== path.dirname(current)) {
    if (current === homeRoot) return;
    for (const marker of ['.git', 'liftoff.manifest.json']) {
      try {
        await lstat(path.join(current, marker));
        throw new DistributionError('Installation destinations cannot authorize changes inside a project or Git worktree.', 'unsafe_path');
      } catch (error) { if (ioCode(error) !== 'ENOENT' && ioCode(error) !== 'ENOTDIR') throw error; }
    }
    current = path.dirname(current);
  }
}

export async function assertNoInstallationTransaction(root: string, allowOwn = false): Promise<void> {
  for (const parts of [
    reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts, reviewedAdoptionTransactionPathParts,
    reviewedSkillsTransactionPathParts, ...allowOwn ? [] : [reviewedInstallationTransactionPathParts],
    ['.liftoff-init.lock']
  ]) {
    try {
      await lstat(path.join(root, ...parts));
      throw new DistributionError('An unfinished cooperating transaction blocks installation effects; recover the original command without discarding its record.', 'transaction_pending');
    } catch (error) { if (ioCode(error) !== 'ENOENT') throw error; }
  }
}

export async function withInstallationLocks<T>(
  roots: readonly string[], operation: (lease: ProjectMutationLease) => Promise<T>,
  options: { recoveryRoot?: string } = {}
): Promise<T> {
  const unique = [...new Set(roots)].sort();
  const leases: ProjectMutationLease[] = [];
  const lock = async (index: number): Promise<T> => {
    if (index === unique.length) return operation({ assertHeld: async () => { for (const lease of leases) await lease.assertHeld(); } });
    const root = unique[index];
    await assertNoInstallationTransaction(root, root === options.recoveryRoot);
    return withUserScopeMutationLock(root, async (lease) => {
      await assertNoInstallationTransaction(root, root === options.recoveryRoot);
      leases.push(lease);
      return lock(index + 1);
    });
  };
  return lock(0);
}
