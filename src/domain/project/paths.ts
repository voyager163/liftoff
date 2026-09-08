import { FileSystemError } from './errors.js';

const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export function validateArtifactPathParts(value: unknown, label = 'Artifact path'): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FileSystemError(`${label} must be a non-empty path-part array.`);
  }

  return value.map((part, index) => {
    if (typeof part !== 'string' || part.length === 0 || part.trim().length === 0) {
      throw new FileSystemError(`${label} part ${index + 1} must be a non-empty string.`);
    }
    if (
      part === '.' ||
      part === '..' ||
      part.includes('/') ||
      part.includes('\\') ||
      part.includes('\0') ||
      WINDOWS_DRIVE_PATTERN.test(part)
    ) {
      throw new FileSystemError(`${label} contains unsafe path part ${JSON.stringify(part)}.`);
    }
    if (part.endsWith('.') || part.endsWith(' ') || WINDOWS_RESERVED_NAME_PATTERN.test(part)) {
      throw new FileSystemError(`${label} contains non-portable path part ${JSON.stringify(part)}.`);
    }
    return part;
  });
}

export function manifestDisplayPath(pathParts: string[]): string {
  return pathParts.join('/');
}
