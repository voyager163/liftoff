import type { MutationClass } from '../types.js';
import { validateArtifactPathParts } from '../../../project/paths.js';
import { governanceScopes, phaseIds } from '../types.js';

export const phaseIdSet = new Set<string>(phaseIds);

export const terminalPhaseStateSet = new Set<string>(['approved', 'verified', 'failed', 'inapplicable', 'retained', 'disposed']);

export const resultStateSet = new Set<string>(['verified', 'failed', 'inapplicable', 'retained', 'disposed']);

export const hex64Pattern = /^[a-f0-9]{64}$/;

export const isoLikePattern = /^\d{4}-\d{2}-\d{2}T/;

export const liveReadbackProviderSet = new Set<string>(['github', 'azure']);

export const githubRemoteWriteMutations = new Set<MutationClass>([
  'git-push', 'github-write', 'github-repository-create', 'github-workflow-dispatch',
  'github-secret-write', 'github-ruleset-write'
]);

export const azureRemoteWriteMutations = new Set<MutationClass>([
  'azure-provider-register',
  'azure-network-provision',
  'azure-state-import',
  'azure-resource-provision'
]);

export const governanceScopeSet = new Set<string>(governanceScopes);

export const transitionAdapterIds = new Set<string>([
  'local-evidence',
  'selected-spec-workflow',
  'git',
  'github',
  'azure-opentofu',
  'local-state'
]);

export function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function exact(value: unknown, requiredKeys: readonly string[], path: string): Record<string, unknown> {
  const item = record(value, path);
  for (const key of requiredKeys) {
    if (!Object.hasOwn(item, key)) {
      throw new Error(`${path}.${key} is required.`);
    }
  }
  const allowed = new Set(requiredKeys);
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) {
      throw new Error(`${path}.${key} is not allowed.`);
    }
  }
  return item;
}

export function exactWithOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  path: string
): Record<string, unknown> {
  const item = record(value, path);
  for (const key of requiredKeys) {
    if (!Object.hasOwn(item, key)) {
      throw new Error(`${path}.${key} is required.`);
    }
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) {
      throw new Error(`${path}.${key} is not allowed.`);
    }
  }
  return item;
}

export function stringField(item: Record<string, unknown>, key: string, path: string): string {
  const value = item[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path}.${key} must be a non-empty string.`);
  }
  return value;
}

export function booleanField(item: Record<string, unknown>, key: string, path: string): boolean {
  const value = item[key];
  if (typeof value !== 'boolean') {
    throw new Error(`${path}.${key} must be a boolean.`);
  }
  return value;
}

export function numberField(item: Record<string, unknown>, key: string, path: string): number {
  const value = item[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path}.${key} must be a finite number.`);
  }
  return value;
}

export function integerField(item: Record<string, unknown>, key: string, path: string): number {
  const value = numberField(item, key, path);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${path}.${key} must be a safe integer.`);
  }
  return value;
}

export function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`${path}[${index}] must be a non-empty string.`);
    }
    return entry;
  });
}

export function optionalStringArray(value: unknown, path: string): string[] | undefined {
  return value === undefined ? undefined : stringArray(value, path);
}

export function pathPartsArray(value: unknown, path: string): readonly string[][] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value.map((entry, index) => safePathParts(entry, `${path}[${index}]`));
}

export function safePathParts(value: unknown, path: string): string[] {
  return validateArtifactPathParts(value, path);
}

export function publicJson(value: unknown, path: string, depth = 0): unknown {
  if (depth > 20) throw new Error(`${path} exceeds the supported JSON nesting depth.`);
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') {
    if (/https?:\/\/[^/\s]*@|[?&](?:token|key|secret|sig)=|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.test(value)) {
      throw new Error(`${path} contains credential material; use protected credential enrollment instead.`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => publicJson(entry, `${path}[${index}]`, depth + 1));
  const object = record(value, path);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    const tokenMetadata = key === 'token' && typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? record(entry, `${path}.${key}`) : null;
    const publicAppTokenMetadata = tokenMetadata !== null &&
      Object.keys(tokenMetadata).sort().join(',') === 'generatedBy,strategy,ttlSeconds' &&
      tokenMetadata.generatedBy === 'github-app' && tokenMetadata.strategy === 'installation-token' &&
      Number.isSafeInteger(tokenMetadata.ttlSeconds) && Number(tokenMetadata.ttlSeconds) > 0 && Number(tokenMetadata.ttlSeconds) <= 3600;
    if (['__proto__', 'prototype', 'constructor'].includes(key) ||
      /^(?:accessToken|refreshToken|token|password|secret|clientSecret|privateKey|accountKey|connectionString|sasToken)$/iu.test(key) && !publicAppTokenMetadata) {
      throw new Error(`${path}.${key} is not permitted in public activation inputs.`);
    }
    result[key] = publicJson(entry, `${path}.${key}`, depth + 1);
  }
  return result;
}

export function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<string>, path: string): T {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`${path} contains unsupported value ${JSON.stringify(value)}.`);
  }
  return value as T;
}

export function requireVersion(value: unknown, expected: string | number, path: string): void {
  if (value !== expected) {
    throw new Error(`${path} must be ${JSON.stringify(expected)}.`);
  }
}

export function hexDigest(value: unknown, path: string): string {
  if (typeof value !== 'string' || !hex64Pattern.test(value)) {
    throw new Error(`${path} must be a SHA-256 hex digest.`);
  }
  return value;
}

export function isoTimestamp(value: unknown, path: string): string {
  if (typeof value !== 'string' || !isoLikePattern.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${path} must be a valid ISO timestamp.`);
  }
  return value;
}

export function dateDaysBetween(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / (24 * 60 * 60 * 1000);
}

export function addDaysIso(start: string, days: number): string {
  return new Date(Date.parse(start) + days * 24 * 60 * 60 * 1000).toISOString();
}

export function exactStringSet(
  value: readonly string[],
  expected: readonly string[],
  path: string
): readonly string[] {
  const sortedValue = [...value].sort();
  const sortedExpected = [...expected].sort();
  if (
    sortedValue.length !== sortedExpected.length ||
    sortedValue.some((entry, index) => entry !== sortedExpected[index])
  ) {
    throw new Error(`${path} must exactly equal ${expected.join(', ')}.`);
  }
  return expected;
}

export function assertNoDuplicateStrings(value: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const entry of value) {
    if (seen.has(entry)) {
      throw new Error(`${path} contains duplicate value ${entry}.`);
    }
    seen.add(entry);
  }
}

export function assertTimestampNotExpired(value: string, path: string, now: Date): void {
  if (Date.parse(value) <= now.getTime()) {
    throw new Error(`${path} must be in the future.`);
  }
}
