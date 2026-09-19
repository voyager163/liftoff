import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { FileSystemError } from '../../domain/project/errors.js';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import { errorCode, errorMessage } from './errors.js';

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function artifactPath(root: string, pathParts: string[]): string {
  const validated = validateArtifactPathParts(pathParts);
  const joinedPath = path.join(root, ...validated);
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(joinedPath);
  if (!isPathWithin(resolvedRoot, resolvedPath) || resolvedPath === resolvedRoot) {
    throw new FileSystemError(`Artifact path escapes project root: ${validated.join('/')}`);
  }
  return joinedPath;
}

export async function resolveProjectPath(projectRoot: string, pathParts: string[]): Promise<string> {
  const validated = validateArtifactPathParts(pathParts);
  const resolvedRoot = path.resolve(projectRoot);
  const targetPath = artifactPath(resolvedRoot, validated);

  let realRoot: string;
  try {
    realRoot = await realpath(resolvedRoot);
  } catch (error) {
    throw new FileSystemError(`Unable to resolve project root ${resolvedRoot}: ${errorMessage(error)}`);
  }

  let current = resolvedRoot;
  for (const [index, part] of validated.entries()) {
    current = path.join(current, part);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return targetPath;
      }
      throw new FileSystemError(`Unable to inspect artifact path ${validated.join('/')}: ${errorMessage(error)}`);
    }

    let resolvedExistingPath: string;
    try {
      resolvedExistingPath = await realpath(current);
    } catch (error) {
      throw new FileSystemError(`Unable to resolve artifact path ${validated.join('/')}: ${errorMessage(error)}`);
    }
    if (!isPathWithin(realRoot, resolvedExistingPath)) {
      throw new FileSystemError(`Artifact path escapes project root through a symlink: ${validated.join('/')}`);
    }
    if (index < validated.length - 1 && !details.isDirectory() && !details.isSymbolicLink()) {
      throw new FileSystemError(`Artifact path parent is not a directory: ${validated.slice(0, index + 1).join('/')}`);
    }
  }

  return targetPath;
}
