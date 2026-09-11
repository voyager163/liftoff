import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { errorCode, errorMessage } from '../../adapters/filesystem/errors.js';
import { findProjectRoot } from '../../adapters/filesystem/project-discovery.js';
import { FileSystemError } from '../../domain/project/errors.js';
import type { UpdateGuidanceContext } from './command-guidance.js';

const unavailableContextCodes = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP']);

export async function resolveUpdateGuidanceContext(
  cwd: string,
  projectRoot: string,
  discoveredProjectRoot?: string
): Promise<UpdateGuidanceContext> {
  const requestedProjectRoot = path.resolve(projectRoot);
  const canonicalProjectRoot = await realpath(requestedProjectRoot);
  try {
    const invocationDirectory = await realpath(cwd);
    const discovered = discoveredProjectRoot ?? await findProjectRoot(cwd);
    if (discovered) {
      // Canonical equality must not hide a leaf alias rejected by the transaction boundary.
      const directory = await lstat(discovered);
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new FileSystemError(`Implicit project root must be a directory, not a symlink or junction: ${discovered}`);
      }
    }
    return {
      state: 'resolved',
      requestedProjectRoot,
      projectRoot: canonicalProjectRoot,
      invocationDirectory,
      ...(discovered ? { implicitProjectRoot: await realpath(discovered) } : {})
    };
  } catch (error) {
    if (!(error instanceof FileSystemError) && !unavailableContextCodes.has(errorCode(error) ?? '')) {
      throw error;
    }
    return { state: 'unresolved', detail: errorMessage(error) };
  }
}
