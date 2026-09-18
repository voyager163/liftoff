import { isRecord } from '../domain/governance/activation/canonical-json.js';
import { SEMVER_PATTERN } from '../domain/project/manifest/fields.js';
import path from 'node:path';
import { canonicalizePathBoundary, ContinuationError } from '../domain/execution/continuation.js';
import { validateArtifactPathParts } from '../domain/project/paths.js';

export const publicProtocolSchemaVersion = 1 as const;

export class ProtocolError extends Error {
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export class ProtocolValidationError extends ProtocolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = 'ProtocolValidationError';
  }
}

export function assertStrictObject(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProtocolValidationError(`${context} must be a non-null object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.getOwnPropertyNames(value).length > 64 ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some((property) => !Object.hasOwn(property, 'value'))) {
    throw new ProtocolValidationError(`${context} must be a bounded plain data object without accessors or symbols.`);
  }
  return value;
}

export function assertSchemaVersion(
  value: Record<string, unknown>,
  expectedVersion: number = publicProtocolSchemaVersion,
  context: string = 'Protocol'
): void {
  if (!Object.hasOwn(value, 'schemaVersion')) {
    throw new ProtocolValidationError(`${context} missing required field "schemaVersion".`);
  }
  if (value.schemaVersion !== expectedVersion) {
    throw new ProtocolValidationError(
      `${context} unsupported schemaVersion: ${String(value.schemaVersion)}. Expected ${expectedVersion}.`,
      { found: value.schemaVersion, supported: [expectedVersion] }
    );
  }
}

export function assertStrictKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string
): void {
  const actualKeys = Object.getOwnPropertyNames(record);
  const extraKeys = actualKeys.filter((k) => !allowedKeys.includes(k));
  if (extraKeys.length > 0) {
    throw new ProtocolValidationError(
      `${context} contains unsupported fields: ${extraKeys.slice(0, 16).map((key) => key.slice(0, 128)).join(', ')}. Allowed: ${allowedKeys.join(', ')}.`
    );
  }
}

export function protocolString(value: unknown, context: string, maximum = 4096): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new ProtocolValidationError(`${context} must be bounded nonempty text without controls or surrounding whitespace.`);
  }
  return value;
}

export function protocolArray(value: unknown, context: string, maximum = 512): unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Object.keys(value).length !== value.length ||
      Object.getOwnPropertyNames(value).length !== value.length + 1 ||
      Object.keys(value).some((key, index) => key !== String(index)) ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some((property) => !Object.hasOwn(property, 'value'))) {
    throw new ProtocolValidationError(`${context} must be a bounded dense array without extra properties.`);
  }
  return Array.from(value);
}

export function protocolStringArray(value: unknown, context: string, maximum = 128, nonempty = false): string[] {
  const values = protocolArray(value, context, maximum).map((entry) => protocolString(entry, context, 256));
  if (nonempty && values.length === 0 || new Set(values).size !== values.length) {
    throw new ProtocolValidationError(`${context} must contain distinct${nonempty ? ' nonempty' : ''} entries.`);
  }
  return values;
}

function isProtocolChoice<const T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
  return typeof value === 'string' && choices.some((choice) => choice === value);
}

export function protocolChoice<const T extends readonly string[]>(value: unknown, choices: T, context: string): T[number] {
  if (!isProtocolChoice(value, choices)) throw new ProtocolValidationError(`${context} is unsupported.`);
  return value;
}

export function protocolSchemaNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ProtocolValidationError(`${context} must be a positive safe schema/contract integer.`);
  }
  return value;
}

export function protocolReleaseVersion(value: unknown, context: string): string {
  const version = protocolString(value, context, 128);
  if (!SEMVER_PATTERN.test(version) ||
      version.split('+')[0]!.split('-').slice(1).join('-').split('.').some((part) => /^0\d+$/u.test(part))) {
    throw new ProtocolValidationError(`${context} must be a valid release version.`);
  }
  return version;
}

export function protocolNativePath(value: unknown, context: string): string {
  const input = protocolString(value, context, 4096);
  let normalized: string;
  try { normalized = canonicalizePathBoundary(input); }
  catch (error) {
    if (!(error instanceof ContinuationError)) throw error;
    throw new ProtocolValidationError(`${context}: ${error.message}`);
  }
  const nativePath = /^[a-z]:/iu.test(input) || input.startsWith('\\') ? path.win32 : path.posix;
  if (!nativePath.isAbsolute(input) || normalized !== input || nativePath.resolve(input) !== input) {
    throw new ProtocolValidationError(`${context} must be an absolute canonical native path, not an implicit cwd or drive-relative target.`);
  }
  const root = nativePath.parse(input).root;
  const parts = input.slice(root.length).split(nativePath.sep).filter(Boolean);
  try {
    if (parts.length) validateArtifactPathParts(parts, context);
    if (parts.some((part) => /[<>:"|?*]/u.test(part))) throw new Error('Ambiguous path component.');
  } catch {
    throw new ProtocolValidationError(`${context} contains an unsafe or nonportable path component.`);
  }
  return input;
}

export function protocolArguments(value: unknown, context: string): string[] {
  const argumentsList = protocolArray(value, context, 128);
  const result: string[] = [];
  let length = 0;
  for (const argument of argumentsList) {
    if (typeof argument !== 'string' || argument.length > 4096 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(argument)) {
      throw new ProtocolValidationError(`${context} must contain bounded literal arguments without control characters.`);
    }
    length += argument.length;
    if (length > 32_768) throw new ProtocolValidationError(`${context} exceeds the total argument bound.`);
    result.push(argument);
  }
  return result;
}
