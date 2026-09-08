import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const installedPackageRoot = path.resolve(
  fileURLToPath(new URL('../../../', import.meta.url))
);

export function resolvePackageFile(...pathParts: readonly string[]): string {
  for (const part of pathParts) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      part.includes('/') ||
      part.includes('\\') ||
      path.posix.isAbsolute(part) ||
      path.win32.isAbsolute(part)
    ) {
      throw new Error(`Invalid packaged file path part: ${JSON.stringify(part)}.`);
    }
  }
  return path.join(installedPackageRoot, ...pathParts);
}

export function resolvePackageFileUrl(...pathParts: readonly string[]): URL {
  return pathToFileURL(resolvePackageFile(...pathParts));
}
