import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { FileSystemError } from '../../domain/project/errors.js';
import { errorCode, errorMessage } from './errors.js';

export function resolveTargetRoot(cwd: string, projectName: string): string {
  return path.resolve(cwd, projectName);
}

export async function findProjectRoot(startDir: string): Promise<string | undefined> {
  let current = path.resolve(startDir);
  while (true) {
    try {
      const marker = await lstat(path.join(current, 'liftoff.manifest.json'));
      if (!marker.isFile()) {
        throw new FileSystemError(
          'liftoff.manifest.json must be a regular file, not a directory, symlink, or junction.'
        );
      }
      return current;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') {
        throw new FileSystemError(`Unable to inspect ${current} for a Liftoff manifest: ${errorMessage(error)}`);
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
}
