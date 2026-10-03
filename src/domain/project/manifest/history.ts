import { canonicalJson, canonicalSha256, sha256Hex } from '../../governance/activation/canonical-json.js';
import type { HistoricalLiftoffManifest } from '../contracts.js';
import { FileSystemError } from '../errors.js';
import { exactRecord } from './fields.js';

export const manifestHistoryMaximumSourceBytes = 8 * 1024 * 1024;

export interface ManifestHistorySource {
  readonly artifactVersion: HistoricalLiftoffManifest['artifactVersion'];
  readonly digest: string;
  readonly bytes: number;
  readonly mode: number;
}

export interface ManifestHistoryIndex {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-manifest-history';
  readonly snapshotId: string;
  readonly source: ManifestHistorySource;
}

export interface ManifestSourceHistoryReference {
  readonly schemaVersion: 1;
  readonly kind: 'manifest-history' | 'activation-history';
  readonly snapshotId: string;
  readonly indexDigest: string;
}

export interface EncodedManifestHistoryIndex {
  readonly content: string;
  readonly indexDigest: string;
}

export interface ManifestHistoryPaths {
  readonly manifestPathParts: readonly ['.liftoff', 'manifest-history', string, 'manifest.json'];
  readonly indexPathParts: readonly ['.liftoff', 'manifest-history', string, 'index.json'];
}

function digest(value: unknown, scope: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new FileSystemError(`${scope} must be a raw lowercase 64-hex SHA-256 digest.`);
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, scope: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) ||
    value < minimum || value > maximum) {
    throw new FileSystemError(`${scope} must be a safe integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

export function validateManifestHistorySource(value: unknown): ManifestHistorySource {
  const source = exactRecord(value, ['artifactVersion', 'digest', 'bytes', 'mode'], 'Manifest history source');
  const artifactVersion = ([2, 3, 4, 5, 6, 7] as const).find((version) => version === source.artifactVersion);
  if (artifactVersion === undefined) {
    throw new FileSystemError('Manifest history source.artifactVersion must be one of 2, 3, 4, 5, 6, 7.');
  }
  return Object.freeze({
    artifactVersion,
    digest: digest(source.digest, 'Manifest history source.digest'),
    bytes: boundedInteger(source.bytes, 1, manifestHistoryMaximumSourceBytes, 'Manifest history source.bytes'),
    mode: boundedInteger(source.mode, 0, 0o7777, 'Manifest history source.mode')
  });
}

/** Descriptor validity does not establish the truth or safety of the captured source bytes. */
export function createManifestHistoryIndex(source: unknown): ManifestHistoryIndex {
  const seed = {
    schemaVersion: 1 as const,
    kind: 'liftoff-manifest-history' as const,
    source: validateManifestHistorySource(source)
  };
  return Object.freeze({ ...seed, snapshotId: canonicalSha256(seed) });
}

export function validateManifestHistoryIndex(value: unknown): ManifestHistoryIndex {
  const index = exactRecord(value, ['schemaVersion', 'kind', 'snapshotId', 'source'], 'Manifest history index');
  if (index.schemaVersion !== 1 || index.kind !== 'liftoff-manifest-history') {
    throw new FileSystemError('Manifest history index requires schemaVersion 1 and kind liftoff-manifest-history.');
  }
  const snapshotId = digest(index.snapshotId, 'Manifest history index.snapshotId');
  const validated = createManifestHistoryIndex(index.source);
  if (snapshotId !== validated.snapshotId) {
    throw new FileSystemError('Manifest history index.snapshotId does not match its source-only identity.');
  }
  return validated;
}

export function encodeManifestHistoryIndex(value: unknown): EncodedManifestHistoryIndex {
  const content = canonicalJson(validateManifestHistoryIndex(value));
  return Object.freeze({ content, indexDigest: sha256Hex(content) });
}

/** Syntax only: no storage, source linkage, fresh origin or approval is inferred. */
export function validateManifestSourceHistoryReference(value: unknown): ManifestSourceHistoryReference {
  const reference = exactRecord(value, ['schemaVersion', 'kind', 'snapshotId', 'indexDigest'], 'Manifest source history reference');
  if (reference.schemaVersion !== 1 ||
    (reference.kind !== 'manifest-history' && reference.kind !== 'activation-history')) {
    throw new FileSystemError('Manifest source history reference requires schemaVersion 1 and kind manifest-history or activation-history.');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: reference.kind,
    snapshotId: digest(reference.snapshotId, 'Manifest source history reference.snapshotId'),
    indexDigest: digest(reference.indexDigest, 'Manifest source history reference.indexDigest')
  });
}

export function manifestHistoryPaths(reference: unknown): ManifestHistoryPaths {
  const validated = validateManifestSourceHistoryReference(reference);
  if (validated.kind !== 'manifest-history') {
    throw new FileSystemError('Activation-history paths require the activation-owned resolver.');
  }
  return Object.freeze({
    manifestPathParts: Object.freeze(['.liftoff', 'manifest-history', validated.snapshotId, 'manifest.json'] as const),
    indexPathParts: Object.freeze(['.liftoff', 'manifest-history', validated.snapshotId, 'index.json'] as const)
  });
}
