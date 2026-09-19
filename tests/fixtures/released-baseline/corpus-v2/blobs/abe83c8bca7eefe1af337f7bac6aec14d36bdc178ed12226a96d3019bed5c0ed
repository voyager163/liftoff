import { FileSystemError } from '../errors.js';

export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requiredString(record: Record<string, unknown>, key: string, scope: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FileSystemError(`${scope}.${key} must be a non-empty string.`);
  }
  return value;
}

export function optionalString(record: Record<string, unknown>, key: string, scope: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FileSystemError(`${scope}.${key} must be a non-empty string when present.`);
  }
  return value;
}

export function assertOnlyFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  scope: string
): void {
  const unknown = Object.keys(record).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) {
    throw new FileSystemError(
      `${scope} contains inapplicable or unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`
    );
  }
}

export function requiredBoolean(record: Record<string, unknown>, key: string, scope: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new FileSystemError(`${scope}.${key} must be a boolean.`);
  }
  return value;
}
