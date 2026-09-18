import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalJson, canonicalSha256, isRecord } from '../governance/activation/canonical-json.js';
import { validateArtifactPathParts } from '../project/paths.js';

export const reviewedBytesDigest = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

export interface ReviewedFileSnapshot {
  pathParts: readonly string[];
  content?: Uint8Array;
  mode?: number;
}

// These are the released repair descriptors. Their shape and ordering are part of its fingerprint.
export function reviewedSnapshotDescriptors(snapshots: readonly ReviewedFileSnapshot[]) {
  return snapshots.map((snapshot) => ({
    pathParts: [...snapshot.pathParts],
    digest: snapshot.content === undefined ? null : reviewedBytesDigest(snapshot.content),
    mode: snapshot.mode ?? null
  })).sort((a, b) => a.pathParts.join('/').localeCompare(b.pathParts.join('/'), 'en'));
}

export interface ReviewedPlanReference {
  projectRoot: string;
  fingerprint: string;
  expiresAt?: string;
}

export function reviewedPlanMatches(expected: ReviewedPlanReference, current: ReviewedPlanReference): boolean {
  return /^[a-f0-9]{64}$/u.test(expected.fingerprint) &&
    expected.fingerprint === current.fingerprint && expected.projectRoot === current.projectRoot &&
    expected.expiresAt === current.expiresAt;
}

export function reviewLifetimeIsCurrent(createdAt: string, expiresAt: string, now: Date, ttlMs: number): boolean {
  const created = Date.parse(createdAt), expires = Date.parse(expiresAt), current = now.getTime();
  return Number.isFinite(created) && Number.isFinite(expires) && Number.isFinite(current) &&
    new Date(created).toISOString() === createdAt && new Date(expires).toISOString() === expiresAt &&
    created <= current && current < expires && expires - created === ttlMs;
}

export interface PlanInputBinding {
  sourceBytesDigest: string;
  destinationBytesDigest?: string;
  fileModes: Readonly<Record<string, number>>;
  directoryInventoryDigest: string;
  targetIdentity: string;
  toolChainDigest?: string;
  configPath?: string;
  configDigest?: string;
  configMode?: number;
  expiresAt?: string;
}

export interface PlanVerificationOutcome {
  valid: boolean;
  reason?: string;
  mismatchCategory?: 'source-bytes' | 'destination-bytes' | 'file-modes' | 'directory-inventory' | 'target-identity' | 'toolchain' | 'config' | 'expired';
}

export function computePlanFingerprint(binding: PlanInputBinding, planPayload: unknown): string {
  validatePlanInputBinding(binding);
  const canonicalPayload = canonicalJson({
    binding: {
      sourceBytesDigest: binding.sourceBytesDigest,
      destinationBytesDigest: binding.destinationBytesDigest,
      fileModes: binding.fileModes,
      directoryInventoryDigest: binding.directoryInventoryDigest,
      targetIdentity: binding.targetIdentity,
      toolChainDigest: binding.toolChainDigest,
      configPath: binding.configPath,
      configDigest: binding.configDigest,
      ...(binding.configMode === undefined ? {} : { configMode: binding.configMode }),
      expiresAt: binding.expiresAt
    },
    plan: planPayload
  });
  return canonicalSha256(canonicalPayload);
}

export function verifyImmutablePlanBinding(
  original: PlanInputBinding,
  current: PlanInputBinding,
  options?: { nowIso?: string }
): PlanVerificationOutcome {
  validatePlanInputBinding(original);
  validatePlanInputBinding(current);
  const now = options?.nowIso ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error('Plan binding verification requires a valid clock.');
  if (original.expiresAt !== undefined) {
    if (Date.parse(now) >= Date.parse(original.expiresAt)) {
      return {
        valid: false,
        reason: `Reviewed plan has expired at ${original.expiresAt}. Current time is ${now}.`,
        mismatchCategory: 'expired'
      };
    }
  }
  if (original.expiresAt !== current.expiresAt) {
    return { valid: false, reason: 'Reviewed plan expiry changed; renewed review is required.', mismatchCategory: 'expired' };
  }

  // Check target identity
  if (original.targetIdentity !== current.targetIdentity) {
    return {
      valid: false,
      reason: `Target identity changed from ${original.targetIdentity} to ${current.targetIdentity}.`,
      mismatchCategory: 'target-identity'
    };
  }

  // Check source bytes
  if (original.sourceBytesDigest !== current.sourceBytesDigest) {
    return {
      valid: false,
      reason: 'Source bytes changed after plan review. Renewed plan review required.',
      mismatchCategory: 'source-bytes'
    };
  }

  // Check destination bytes if original recorded them
  if (original.destinationBytesDigest !== current.destinationBytesDigest) {
    return {
      valid: false,
      reason: 'Destination bytes changed after plan review. Renewed plan review required.',
      mismatchCategory: 'destination-bytes'
    };
  }

  // Check directory inventory
  if (original.directoryInventoryDigest !== current.directoryInventoryDigest) {
    return {
      valid: false,
      reason: 'Directory inventory changed after plan review. Renewed plan review required.',
      mismatchCategory: 'directory-inventory'
    };
  }

  // Check file modes
  const originalKeys = Object.keys(original.fileModes).sort();
  const currentKeys = Object.keys(current.fileModes).sort();
  if (originalKeys.length !== currentKeys.length ||
      originalKeys.some((k, i) => k !== currentKeys[i] || original.fileModes[k] !== current.fileModes[k])) {
    return {
      valid: false,
      reason: 'File modes changed after plan review. Renewed plan review required.',
      mismatchCategory: 'file-modes'
    };
  }

  // Check toolchain identity
  if (original.toolChainDigest !== current.toolChainDigest) {
    return {
      valid: false,
      reason: 'Toolchain identity or version changed after plan review. Renewed plan review required.',
      mismatchCategory: 'toolchain'
    };
  }

  // Check configuration digest
  if (original.configPath !== current.configPath || original.configDigest !== current.configDigest ||
      original.configMode !== current.configMode) {
    return {
      valid: false,
      reason: 'Configuration digest changed after plan review. Renewed plan review required.',
      mismatchCategory: 'config'
    };
  }

  return { valid: true };
}

export function validatePlanInputBinding(value: unknown): PlanInputBinding {
  if (!isRecord(value)) {
    throw new Error('PlanInputBinding must be a non-null object.');
  }

  if (typeof value.sourceBytesDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceBytesDigest)) {
    throw new Error('PlanInputBinding: sourceBytesDigest must be a 64-character lowercase hex string.');
  }

  if (value.destinationBytesDigest !== undefined &&
      (typeof value.destinationBytesDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.destinationBytesDigest))) {
    throw new Error('PlanInputBinding: destinationBytesDigest must be a 64-character lowercase hex string when provided.');
  }

  if (!isRecord(value.fileModes)) {
    throw new Error('PlanInputBinding: fileModes must be a record of file paths to numeric modes.');
  }

  for (const [key, mode] of Object.entries(value.fileModes)) {
    if (!key || key.includes('\\') || key.split('/').some((part) => !part || part === '.' || part === '..') ||
        /[\u0000-\u001f\u007f]/u.test(key) ||
        typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw new Error(`PlanInputBinding: invalid mode for ${key}: ${mode}`);
    }
    validateArtifactPathParts(key.split('/'), 'PlanInputBinding fileModes');
  }

  if (typeof value.directoryInventoryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.directoryInventoryDigest)) {
    throw new Error('PlanInputBinding: directoryInventoryDigest must be a 64-character lowercase hex string.');
  }

  if (!canonicalNativePath(value.targetIdentity)) {
    throw new Error('PlanInputBinding: targetIdentity must be an absolute canonical native path.');
  }

  if (value.toolChainDigest !== undefined &&
      (typeof value.toolChainDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.toolChainDigest))) {
    throw new Error('PlanInputBinding: toolChainDigest must be a 64-character lowercase hex string when provided.');
  }

  if (value.configPath !== undefined && !canonicalNativePath(value.configPath)) {
    throw new Error('PlanInputBinding: configPath must be an absolute canonical native path when provided.');
  }

  if (value.configDigest !== undefined &&
      (typeof value.configDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.configDigest))) {
    throw new Error('PlanInputBinding: configDigest must be a 64-character lowercase hex string when provided.');
  }

  if (value.expiresAt !== undefined && (typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      new Date(value.expiresAt).toISOString() !== value.expiresAt)) {
    throw new Error('PlanInputBinding: expiresAt must be a canonical ISO date string when provided.');
  }
  if ((value.configPath === undefined) !== (value.configDigest === undefined)) {
    throw new Error('PlanInputBinding: configPath and configDigest must be supplied together.');
  }
  if (value.configMode !== undefined && (value.configPath === undefined ||
      !Number.isInteger(value.configMode) || (value.configMode as number) < 0 || (value.configMode as number) > 0o777)) {
    throw new Error('PlanInputBinding: configMode must be an ordinary file mode for the bound configuration.');
  }
  const keys = ['sourceBytesDigest', 'destinationBytesDigest', 'fileModes', 'directoryInventoryDigest',
    'targetIdentity', 'toolChainDigest', 'configPath', 'configDigest', 'configMode', 'expiresAt'];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('PlanInputBinding has unrecognized fields.');

  return {
    sourceBytesDigest: value.sourceBytesDigest,
    destinationBytesDigest: value.destinationBytesDigest as string | undefined,
    fileModes: { ...value.fileModes } as Record<string, number>,
    directoryInventoryDigest: value.directoryInventoryDigest,
    targetIdentity: value.targetIdentity,
    toolChainDigest: value.toolChainDigest as string | undefined,
    configPath: value.configPath as string | undefined,
    configDigest: value.configDigest as string | undefined,
    ...(value.configMode === undefined ? {} : { configMode: value.configMode as number }),
    expiresAt: value.expiresAt as string | undefined
  };
}

function canonicalNativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/u.test(value) ||
      /^\\\\[?.]\\/.test(value) || value.startsWith('//')) return false;
  const native = /^[a-z]:/iu.test(value) || value.startsWith('\\') ? path.win32 : path.posix;
  return native.isAbsolute(value) && native.normalize(value) === value &&
    (native !== path.win32 || /^[a-z]:\\/iu.test(value) || /^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/u.test(value));
}
