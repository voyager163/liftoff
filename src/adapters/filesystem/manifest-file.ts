import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { FileSystemError } from '../../domain/project/errors.js';
import { errorMessage } from './errors.js';
import { readProjectFile } from './project-files.js';
import { parseStrictManifestJson } from '../../domain/project/manifest/json.js';

export async function readManifestFile(projectRoot: string): Promise<unknown> {
  try {
    const marker = await lstat(path.join(projectRoot, 'liftoff.manifest.json'));
    if (!marker.isFile()) {
      throw new FileSystemError('liftoff.manifest.json must be a regular file, not a directory, symlink, or junction.');
    }
    if (marker.size > 4 * 1024 * 1024) throw new FileSystemError('liftoff.manifest.json exceeds the 4 MiB contract bound.');
    const bytes = await readProjectFile(projectRoot, ['liftoff.manifest.json']);
    if (bytes === undefined) throw new Error('file does not exist');
    return parseStrictManifestJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new FileSystemError(`Unable to read liftoff.manifest.json: ${errorMessage(error)}`);
  }
}
