import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const installedPackageRoot = path.resolve(
  fileURLToPath(new URL('../../../', import.meta.url))
);

let packageRootOverride: string | undefined;

export function setPackageRootOverride(customRoot: string | undefined): void {
  packageRootOverride = customRoot ? path.resolve(customRoot) : undefined;
}

export function getPackageRoot(): string {
  return packageRootOverride ?? installedPackageRoot;
}

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
  return path.join(getPackageRoot(), ...pathParts);
}

export function resolvePackageFileUrl(...pathParts: readonly string[]): URL {
  return pathToFileURL(resolvePackageFile(...pathParts));
}
