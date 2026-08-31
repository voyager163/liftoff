import {
  canonicalNpmRegistry,
  liftoffPackageName,
  stableNpmTag
} from './package-identity.js';

export const stableReleaseLookupTimeoutMs = 2_000;

export type StableReleaseFailureCode =
  | 'http_failure'
  | 'invalid_metadata'
  | 'network_failure'
  | 'timeout';

export class StableReleaseLookupError extends Error {
  constructor(
    readonly code: StableReleaseFailureCode,
    message: string
  ) {
    super(message);
    this.name = 'StableReleaseLookupError';
  }
}

export interface StableRelease {
  name: typeof liftoffPackageName;
  version: string;
}

export interface StableReleaseLookupOptions {
  fetch?: typeof globalThis.fetch;
  registry?: string;
  timeoutMs?: number;
}

export function isStableSemver(value: unknown): value is string {
  return typeof value === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

function packageMetadataUrl(registry: string): URL {
  const base = new URL(registry);
  const normalized = base.toString().endsWith('/') ? base : new URL(`${base.toString()}/`);
  return new URL(`${encodeURIComponent(liftoffPackageName)}/${stableNpmTag}`, normalized);
}

export async function lookupStableRelease(
  options: StableReleaseLookupOptions = {}
): Promise<StableRelease> {
  const fetchRelease = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? stableReleaseLookupTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new StableReleaseLookupError('invalid_metadata', 'Stable release timeout must be positive.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchRelease(
      packageMetadataUrl(options.registry ?? canonicalNpmRegistry),
      {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        redirect: 'error',
        signal: controller.signal
      }
    );
    if (!response.ok) {
      throw new StableReleaseLookupError(
        'http_failure',
        `Canonical npm stable release lookup returned HTTP ${response.status}.`
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new StableReleaseLookupError(
        'invalid_metadata',
        'Canonical npm stable release metadata was not valid JSON.'
      );
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new StableReleaseLookupError(
        'invalid_metadata',
        'Canonical npm stable release metadata must be an object.'
      );
    }
    const metadata = value as Record<string, unknown>;
    if (metadata.name !== liftoffPackageName || !isStableSemver(metadata.version)) {
      throw new StableReleaseLookupError(
        'invalid_metadata',
        'Canonical npm stable release metadata has an invalid package name or version.'
      );
    }
    return { name: liftoffPackageName, version: metadata.version };
  } catch (error) {
    if (error instanceof StableReleaseLookupError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new StableReleaseLookupError('timeout', 'Canonical npm stable release lookup timed out.');
    }
    throw new StableReleaseLookupError('network_failure', 'Canonical npm stable release lookup failed.');
  } finally {
    clearTimeout(timer);
  }
}
