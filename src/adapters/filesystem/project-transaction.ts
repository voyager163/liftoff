import { chmod, lstat, readFile, rmdir } from 'node:fs/promises';
import { FileSystemError } from '../../domain/project/errors.js';
import { writeProjectFile, deleteProjectFile } from './project-files.js';
import { resolveProjectPath } from './project-paths.js';
import { withProjectMutationLock } from './project-lock.js';
import { errorCode, errorMessage } from './errors.js';

export type ProjectFileMutation =
  | { type: 'write'; pathParts: string[]; content: string | Buffer; mode?: number }
  | { type: 'delete'; pathParts: string[] };

export class ProjectFileTransactionError extends FileSystemError {
  constructor(
    message: string,
    public readonly rollbackFailures: readonly string[]
  ) {
    super(message);
    this.name = 'ProjectFileTransactionError';
  }
}

export interface ProjectFileSnapshot {
  pathParts: string[];
  content?: Buffer;
  mode?: number;
}

export async function captureProjectFileSnapshot(
  projectRoot: string,
  pathParts: string[]
): Promise<ProjectFileSnapshot> {
  const targetPath = await resolveProjectPath(projectRoot, pathParts);
  try {
    const details = await lstat(targetPath);
    if (!details.isFile()) {
      throw new FileSystemError(
        `Project update target must be a regular file: ${pathParts.join('/')}`
      );
    }
    return {
      pathParts,
      content: await readFile(targetPath),
      mode: details.mode & 0o7777
    };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { pathParts };
    }
    throw error;
  }
}

async function assertProjectFileSnapshot(
  projectRoot: string,
  snapshot: ProjectFileSnapshot
): Promise<void> {
  const current = await captureProjectFileSnapshot(projectRoot, snapshot.pathParts);
  if (
    (snapshot.content === undefined) !== (current.content === undefined) ||
    snapshot.mode !== current.mode ||
    snapshot.content?.equals(current.content!) === false
  ) {
    throw new FileSystemError(
      `Project update target changed after review: ${snapshot.pathParts.join('/')}`
    );
  }
}

async function assertAppliedMutationCurrent(
  projectRoot: string,
  mutation: ProjectFileMutation,
  expectedMode: number | undefined
): Promise<void> {
  const current = await captureProjectFileSnapshot(projectRoot, mutation.pathParts);
  if (mutation.type === 'delete') {
    if (current.content !== undefined) {
      throw new FileSystemError(
        `Project update target changed before rollback: ${mutation.pathParts.join('/')}`
      );
    }
    return;
  }
  if (
    current.content === undefined ||
    !current.content.equals(
      typeof mutation.content === 'string' ? Buffer.from(mutation.content, 'utf8') : mutation.content
    ) ||
    expectedMode !== undefined && current.mode !== expectedMode
  ) {
    throw new FileSystemError(
      `Project update target changed before rollback: ${mutation.pathParts.join('/')}`
    );
  }
}

async function missingMutationParents(
  projectRoot: string,
  pathParts: string[]
): Promise<string[][]> {
  const missing: string[][] = [];
  for (let index = 1; index < pathParts.length; index += 1) {
    const parentParts = pathParts.slice(0, index);
    const parentPath = await resolveProjectPath(projectRoot, parentParts);
    try {
      const details = await lstat(parentPath);
      if (!details.isDirectory() && !details.isSymbolicLink()) {
        throw new FileSystemError(
          `Artifact path parent is not a directory: ${parentParts.join('/')}`
        );
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        missing.push(parentParts);
        continue;
      }
      throw error;
    }
  }
  return missing;
}

export async function applyProjectFileTransaction(
  projectRoot: string,
  mutations: readonly ProjectFileMutation[],
  options: {
    onBeforeMutation?: (mutation: ProjectFileMutation, index: number) => Promise<void>;
    preconditions?: readonly ProjectFileSnapshot[];
  } = {}
): Promise<void> {
  return withProjectMutationLock(projectRoot, async (lease) => {
    const snapshots = new Map<string, ProjectFileSnapshot>();
    const preconditions = new Map<string, ProjectFileSnapshot>();
    const missingParents = new Map<string, string[]>();
    for (const snapshot of options.preconditions ?? []) {
      const key = snapshot.pathParts.join('\0');
      if (preconditions.has(key)) {
        throw new FileSystemError(
          `Project update contains duplicate preconditions for ${snapshot.pathParts.join('/')}.`
        );
      }
      preconditions.set(key, snapshot);
    }
    for (const mutation of mutations) {
      if (mutation.type === 'write' && mutation.mode !== undefined &&
          (!Number.isInteger(mutation.mode) || mutation.mode < 0 || mutation.mode > 0o7777)) {
        throw new FileSystemError(`Invalid project update mode for ${mutation.pathParts.join('/')}.`);
      }
      const key = mutation.pathParts.join('\0');
      if (snapshots.has(key)) {
        throw new FileSystemError(
          `Project update contains duplicate mutations for ${mutation.pathParts.join('/')}.`
        );
      }
      snapshots.set(
        key,
        preconditions.get(key) ??
          await captureProjectFileSnapshot(projectRoot, mutation.pathParts)
      );
      if (mutation.type === 'write') {
        for (const parentParts of await missingMutationParents(projectRoot, mutation.pathParts)) {
          missingParents.set(parentParts.join('\0'), parentParts);
        }
      }
    }
    for (const snapshot of preconditions.values()) {
      await assertProjectFileSnapshot(projectRoot, snapshot);
    }

    const applied: { mutation: ProjectFileMutation; mode?: number }[] = [];
    try {
      for (const [index, mutation] of mutations.entries()) {
        await options.onBeforeMutation?.(mutation, index);
        await lease.assertHeld();
        await assertProjectFileSnapshot(
          projectRoot,
          snapshots.get(mutation.pathParts.join('\0'))!
        );
        if (mutation.type === 'write') {
          const originalMode = snapshots.get(mutation.pathParts.join('\0'))!.mode;
          const createdMode = 0o666 & ~process.umask();
          const appliedMutation = {
            mutation,
            mode: originalMode ?? (mutation.mode === undefined ? undefined
              : process.platform === 'win32' ? (createdMode & 0o200 ? 0o666 : 0o444) : createdMode)
          };
          await writeProjectFile(projectRoot, mutation.pathParts, mutation.content);
          applied.push(appliedMutation);
          if (mutation.mode !== undefined) {
            await lease.assertHeld();
            await assertAppliedMutationCurrent(projectRoot, mutation, appliedMutation.mode);
            await chmod(await resolveProjectPath(projectRoot, mutation.pathParts), mutation.mode);
            appliedMutation.mode = process.platform === 'win32'
              ? (mutation.mode & 0o200 ? 0o666 : 0o444) : mutation.mode;
          }
        } else {
          await deleteProjectFile(projectRoot, mutation.pathParts);
          applied.push({ mutation });
        }
      }
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const { mutation, mode } of [...applied].reverse()) {
        const snapshot = snapshots.get(mutation.pathParts.join('\0'))!;
        try {
          await assertAppliedMutationCurrent(projectRoot, mutation, mode);
          if (snapshot.content === undefined) {
            await deleteProjectFile(projectRoot, mutation.pathParts);
          } else {
            await writeProjectFile(projectRoot, mutation.pathParts, snapshot.content);
            await chmod(
              await resolveProjectPath(projectRoot, mutation.pathParts),
              snapshot.mode!
            );
          }
        } catch (rollbackError) {
          rollbackFailures.push(
            `${mutation.pathParts.join('/')}: ${errorMessage(rollbackError)}`
          );
        }
      }
      const parents = [...missingParents.values()]
        .sort((left, right) => right.length - left.length);
      for (const parentParts of parents) {
        try {
          await rmdir(await resolveProjectPath(projectRoot, parentParts));
        } catch (rollbackError) {
          if (errorCode(rollbackError) !== 'ENOENT') {
            rollbackFailures.push(`${parentParts.join('/')}: ${errorMessage(rollbackError)}`);
          }
        }
      }
      const rollbackDetail = rollbackFailures.length === 0
        ? 'All applied changes were rolled back.'
        : `Rollback was incomplete:\n${rollbackFailures.map((failure) => `- ${failure}`).join('\n')}`;
      throw new ProjectFileTransactionError(
        `Project update failed: ${errorMessage(error)} ${rollbackDetail}`,
        rollbackFailures
      );
    }
  });
}
