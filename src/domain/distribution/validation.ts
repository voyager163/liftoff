import { isRecord } from '../governance/activation/canonical-json.js';
import { isStableSemver } from '../../semver.js';
import { DistributionError } from './errors.js';

export const digestPattern = /^[a-f0-9]{64}$/u;
export const commitPattern = /^[a-f0-9]{40}$/u;
export const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new DistributionError(`${label} must be an object with only registered fields.`, 'invalid_metadata');
  }
  return value;
}

export function text(value: unknown, label: string, maximum = 2048): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new DistributionError(`${label} must be bounded nonempty text.`, 'invalid_metadata');
  }
  return value;
}

export function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    throw new DistributionError(`${label} must be a lowercase SHA-256 digest.`, 'invalid_metadata');
  }
  return value;
}

export function sourceCommit(value: unknown): string {
  if (typeof value !== 'string' || !commitPattern.test(value)) {
    throw new DistributionError('Source commit must be a complete lowercase Git commit.', 'invalid_metadata');
  }
  return value;
}

export function stableVersion(value: unknown): string {
  if (!isStableSemver(value) || value.length > 64) {
    throw new DistributionError('Native versions must be canonical stable SemVer.', 'invalid_metadata');
  }
  return value;
}

export function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new DistributionError(`${label} must be a canonical UTC timestamp.`, 'invalid_metadata');
  }
  return value;
}

export function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DistributionError(`${label} is outside its registered integer bounds.`, 'invalid_metadata');
  }
  return value;
}

export function publicHttpsUrl(value: unknown, label: string): string {
  const input = text(value, label);
  let url: URL;
  try { url = new URL(input); }
  catch { throw new DistributionError(`${label} is not a valid URL.`, 'invalid_metadata'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.href !== input || /%2f|%5c|%2e/iu.test(url.pathname)) {
    throw new DistributionError(`${label} must be a canonical credential-free HTTPS URL.`, 'invalid_metadata');
  }
  return input;
}

export function freeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return value;
  for (const entry of Object.values(value)) freeze(entry);
  return Object.freeze(value);
}
