import { FileSystemError } from '../errors.js';

export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function exactRecord(value: unknown, fields: readonly string[], scope: string): Record<string, unknown> {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new FileSystemError(`${scope} must be a plain JSON object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
    throw new FileSystemError(`${scope} must contain exactly the required fields: ${fields.join(', ')}.`);
  }
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const property = Object.getOwnPropertyDescriptor(value, field);
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) {
      throw new FileSystemError(`${scope}.${field} must be an own enumerable data field.`);
    }
    result[field] = property.value;
  }
  return result;
}

export function denseArray(value: unknown, maximum: number, scope: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new FileSystemError(`${scope} must be a dense plain array.`);
  }
  const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximum) {
    throw new FileSystemError(`${scope} exceeds its finite entry limit of ${maximum}.`);
  }
  if (Reflect.ownKeys(value).length !== length + 1) {
    throw new FileSystemError(`${scope} must contain only dense array entries.`);
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) {
      throw new FileSystemError(`${scope}[${index}] must be an own enumerable data entry.`);
    }
    entries.push(property.value);
  }
  return entries;
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
