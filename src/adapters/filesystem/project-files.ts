import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import type { GeneratedArtifact } from '../../domain/project/contracts.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { replaceFileAtomically } from './atomic-write.js';
import { withProjectMutationLock } from './project-lock.js';
import { resolveProjectPath } from './project-paths.js';
import { errorCode, errorMessage } from './errors.js';

export async function assertNewOrEmptyDirectory(targetRoot: string): Promise<void> {
  try {
    const details = await stat(targetRoot);
    if (!details.isDirectory()) {
      throw new FileSystemError(`Target path exists and is not a directory: ${targetRoot}`);
    }
    const entries = await readdir(targetRoot);
    if (entries.length > 0) {
      throw new FileSystemError(`Target directory must be new or empty: ${targetRoot}`);
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return;
    }
    throw error;
  }
}

export async function writeArtifacts(targetRoot: string, artifacts: GeneratedArtifact[]): Promise<void> {
  await withProjectMutationLock(targetRoot, async (lease) => {
    await assertNewOrEmptyDirectory(targetRoot);
    await mkdir(targetRoot, { recursive: true });

    for (const artifact of artifacts) {
      await lease.assertHeld();
      await writeProjectFile(targetRoot, artifact.pathParts, artifact.content);
    }
  });
}

export async function readProjectFile(projectRoot: string, pathParts: string[]): Promise<Buffer | undefined> {
  const targetPath = await resolveProjectPath(projectRoot, pathParts);
  try {
    return await readFile(targetPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw new FileSystemError(`Unable to read ${pathParts.join('/')}: ${errorMessage(error)}`);
  }
}

export async function writeProjectFile(
  projectRoot: string,
  pathParts: string[],
  content: string | Buffer
): Promise<void> {
  const targetPath = await resolveProjectPath(projectRoot, pathParts);
  try {
    await replaceFileAtomically(targetPath, content);
  } catch (error) {
    throw new FileSystemError(`Unable to write ${pathParts.join('/')}: ${errorMessage(error)}`);
  }
}

export async function deleteProjectFile(projectRoot: string, pathParts: string[]): Promise<void> {
  const targetPath = await resolveProjectPath(projectRoot, pathParts);
  try {
    await unlink(targetPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return;
    }
    throw new FileSystemError(`Unable to delete ${pathParts.join('/')}: ${errorMessage(error)}`);
  }
}
