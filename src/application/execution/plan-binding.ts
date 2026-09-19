import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { currentProjectMutationLease } from '../../adapters/filesystem/project-lock.js';
import { observedFileStamp, readObservedFile } from '../../adapters/filesystem/observed-file.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { reviewedUpdateTargetMode } from '../../adapters/filesystem/reviewed-update-transaction.js';
import {
  ApplicationFiles, applicationParts, assertApplicationNoLinkAncestors, canonicalApplicationRoot
} from '../repair/application-files.js';
import { applicationBounds } from '../repair/application-types.js';
import {
  reviewedBytesDigest, reviewedSnapshotDescriptors, validatePlanInputBinding, verifyImmutablePlanBinding, type PlanInputBinding
} from '../../domain/execution/immutable-plan.js';

export class PlanBindingError extends Error {
  constructor(message: string, readonly details?: { mismatchCategory?: string; cause?: unknown }) {
    super(message);
    this.name = 'PlanBindingError';
  }
}

export interface CaptureBindingOptions {
  projectRoot: string;
  sourceFiles?: readonly (string | readonly string[])[];
  destinationFiles?: readonly (string | readonly string[])[];
  directoryPaths?: readonly (string | readonly string[])[];
  configPath?: string;
  toolChainIdentity?: string;
  expiresAt?: string;
  maximumFileBytes?: number;
}

export async function captureReviewedTarget(projectRoot: string) {
  const root = await canonicalApplicationRoot(projectRoot);
  if (root.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(root)) {
    throw new PlanBindingError('Reviewed target requires a bounded canonical native path without control characters.');
  }
  const before = await lstat(root);
  return Object.freeze({
    root,
    async assertCurrent(): Promise<void> {
      const currentRoot = await canonicalApplicationRoot(projectRoot);
      const after = await lstat(currentRoot);
      if (root !== currentRoot || before.dev !== after.dev || before.ino !== after.ino ||
          before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid) {
        throw new PlanBindingError('Reviewed project target identity changed; request a fresh review.', { mismatchCategory: 'target-identity' });
      }
    }
  });
}

/** Reuse the released bounded reader, without the application recipe's exclusions. */
export async function captureReviewedSnapshots(
  projectRoot: string, paths: readonly (readonly string[])[], maximumBytes: number = applicationBounds.fileBytes
): Promise<ProjectFileSnapshot[]> {
  const target = await captureReviewedTarget(projectRoot);
  const reader = new ApplicationFiles(target.root);
  const snapshots: ProjectFileSnapshot[] = [];
  for (const parts of paths) snapshots.push(await reader.read(parts, maximumBytes));
  await reader.assertUnchanged();
  await target.assertCurrent();
  return snapshots;
}

export async function captureReviewedSnapshot(projectRoot: string, parts: string[], maximumBytes: number = applicationBounds.fileBytes): Promise<ProjectFileSnapshot> {
  return (await captureReviewedSnapshots(projectRoot, [parts], maximumBytes))[0]!;
}

export async function assertReviewedSnapshotsCurrent(projectRoot: string, snapshots: readonly ProjectFileSnapshot[]): Promise<void> {
  const current = await captureReviewedSnapshots(projectRoot, snapshots.map((snapshot) => snapshot.pathParts), applicationBounds.totalBytes);
  if (canonicalSha256(reviewedSnapshotDescriptors(snapshots)) !== canonicalSha256(reviewedSnapshotDescriptors(current))) {
    throw new PlanBindingError('Reviewed source or destination bytes/modes changed; request a fresh check.');
  }
}

export async function assertReviewedReadback(
  root: string, mutations: readonly ProjectFileMutation[], originals: readonly ProjectFileSnapshot[], label = 'Reviewed transaction'
): Promise<void> {
  const before = new Map(originals.map((entry) => [entry.pathParts.join('/'), entry]));
  const current = await captureReviewedSnapshots(root, mutations.map((mutation) => mutation.pathParts), applicationBounds.totalBytes);
  for (const [index, mutation] of mutations.entries()) {
    const actual = current[index]!;
    if (mutation.type === 'write'
      ? actual.content === undefined || reviewedBytesDigest(actual.content) !== reviewedBytesDigest(mutation.content) ||
        actual.mode !== reviewedUpdateTargetMode(mutation.mode, before.get(mutation.pathParts.join('/'))?.mode)
      : actual.content !== undefined) {
      throw new Error(`${label} committed, but ${mutation.pathParts.join('/')} changed before final byte/mode readback.`);
    }
  }
}

function parts(value: string | readonly string[], allowRoot = false): string[] {
  if (typeof value !== 'string') return applicationParts(value, allowRoot);
  if (allowRoot && value === '') return [];
  if (path.isAbsolute(value) || value.includes('\\') || value.split('/').some((part) => part === '..')) {
    throw new PlanBindingError('Plan binding path traversal detected; paths must be exact project-relative parts.');
  }
  return applicationParts(value.split('/'), allowRoot);
}

export async function captureInputBinding(options: CaptureBindingOptions): Promise<PlanInputBinding> {
  const maximumFileBytes = options.maximumFileBytes ?? applicationBounds.fileBytes;
  if (!Number.isSafeInteger(maximumFileBytes) || maximumFileBytes < 0 || maximumFileBytes > applicationBounds.totalBytes) {
    throw new PlanBindingError('Invalid plan binding file byte bound.');
  }
  const target = await captureReviewedTarget(options.projectRoot);
  const reader = new ApplicationFiles(target.root);
  const modes: Record<string, number> = {};
  const bindFiles = async (files: CaptureBindingOptions['sourceFiles'], absent: string) => {
    if ((files?.length ?? 0) > applicationBounds.files) throw new PlanBindingError('Plan binding exceeds the file count bound.');
    const identities: string[] = [];
    for (const file of files ?? []) {
      const snapshot = await reader.read(parts(file), maximumFileBytes);
      const name = snapshot.pathParts.join('/');
      if (snapshot.mode !== undefined) modes[name] = snapshot.mode;
      identities.push(`${name}:${snapshot.content === undefined ? absent : reviewedBytesDigest(snapshot.content)}`);
    }
    return canonicalSha256(identities.sort().join('\n'));
  };
  const sourceBytesDigest = await bindFiles(options.sourceFiles, 'missing');
  const destinationBytesDigest = options.destinationFiles === undefined ? undefined :
    await bindFiles(options.destinationFiles, 'absent');
  const lease = await currentProjectMutationLease(target.root);
  const directories = options.directoryPaths ?? [''];
  if (directories.length > applicationBounds.directories) throw new PlanBindingError('Plan binding exceeds the directory count bound.');
  const inventory: unknown[] = [];
  for (const directory of directories) {
    const observation = await reader.inventory(parts(directory, true));
    const entries: unknown[] = [];
    for (const entry of observation.entries) {
      const child = [...observation.pathParts, entry.name];
      const filename = path.join(target.root, ...child);
      if (lease && entry.kind === 'file' && filename === lease.path) {
        await lease.assertHeld();
        continue;
      }
      const details = await lstat(filename);
      const control = entry.kind === 'file' && /^\.liftoff-mutation-[a-f0-9]{64}\.lock$/u.test(entry.name)
        ? await reader.read(child) : undefined;
      entries.push({
        name: entry.name, kind: entry.kind, device: details.dev, inode: details.ino,
        mode: details.mode & 0o7777, size: details.size, mtimeMs: details.mtimeMs, ctimeMs: details.ctimeMs,
        ...(control?.content ? { controlDigest: reviewedBytesDigest(control.content) } : {})
      });
    }
    inventory.push({ ...observation, entries });
  }

  let configuration: Pick<PlanInputBinding, 'configPath' | 'configDigest' | 'configMode'> = {};
  let assertConfigurationCurrent: (() => Promise<void>) | undefined;
  if (options.configPath !== undefined) {
    const filename = path.resolve(options.configPath);
    const parent = path.dirname(filename);
    await assertApplicationNoLinkAncestors(parent);
    const boundary = await captureReviewedTarget(parent);
    const assertPathCurrent = async () => {
      await assertApplicationNoLinkAncestors(parent);
      await boundary.assertCurrent();
      return filename;
    };
    let present = false;
    try {
      const before = await lstat(filename);
      present = true;
      const observed = await readObservedFile(filename, {
        maximumBytes: applicationBounds.fileBytes, expected: before, assertPathCurrent
      });
      configuration = { configPath: filename, configDigest: reviewedBytesDigest(observed.content), configMode: observed.metadata.mode & 0o777 };
      assertConfigurationCurrent = async () => {
        await assertPathCurrent();
        if (observedFileStamp(await lstat(filename)) !== observedFileStamp(observed.metadata)) {
          throw new PlanBindingError('Configuration changed during bounded inspection.');
        }
      };
    } catch (error) {
      if (present || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await assertPathCurrent();
      configuration = { configPath: filename, configDigest: canonicalSha256('missing') };
      assertConfigurationCurrent = async () => {
        await assertPathCurrent();
        try { await lstat(filename); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        throw new PlanBindingError('Absent configuration appeared during bounded inspection.');
      };
    }
  }
  await reader.assertUnchanged();
  await assertConfigurationCurrent?.();
  await target.assertCurrent();
  await lease?.assertHeld();
  return validatePlanInputBinding({
    sourceBytesDigest, destinationBytesDigest, fileModes: modes,
    directoryInventoryDigest: canonicalSha256(inventory), targetIdentity: target.root,
    toolChainDigest: options.toolChainIdentity === undefined ? undefined : canonicalSha256(options.toolChainIdentity),
    ...configuration, expiresAt: options.expiresAt
  });
}

export async function assertInputBindingUnchanged(
  original: PlanInputBinding, options: CaptureBindingOptions, clock?: { nowIso?: string }
): Promise<void> {
  const outcome = verifyImmutablePlanBinding(original, await captureInputBinding(options), clock);
  if (!outcome.valid) throw new PlanBindingError(outcome.reason ?? 'Plan binding verification failed.', { mismatchCategory: outcome.mismatchCategory });
}
