import { canonicalSha256 } from '../../governance/activation/canonical-json.js';
import { FileSystemError } from '../errors.js';
import { exactRecord } from './fields.js';
import { manifestHistoryMaximumSourceBytes } from './history.js';

export interface ActivationTargetHistoryReference {
  readonly schemaVersion: 1;
  readonly kind: 'activation-target-history';
  readonly manifestDigest: string;
  readonly bytes: number;
  readonly mode: number;
}

/** A bounded reference identifies preservation data, not execution or approval authority. */
export function validateActivationTargetHistoryReference(value: unknown): ActivationTargetHistoryReference {
  const record = exactRecord(value, ['schemaVersion', 'kind', 'manifestDigest', 'bytes', 'mode'], 'Activation target history');
  const { manifestDigest, bytes, mode } = record;
  if (record.schemaVersion !== 1 || record.kind !== 'activation-target-history' ||
    typeof manifestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(manifestDigest) ||
    typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > manifestHistoryMaximumSourceBytes ||
    typeof mode !== 'number' || !Number.isSafeInteger(mode) || Object.is(mode, -0) || mode < 0 || mode > 0o777) {
    throw new FileSystemError('Activation target history requires its exact schema, raw digest, bounded byte count and ordinary permission mode.');
  }
  return Object.freeze({ schemaVersion: 1, kind: 'activation-target-history', manifestDigest, bytes, mode });
}

export function activationTargetHistoryPathParts(value: unknown) {
  const reference = validateActivationTargetHistoryReference(value);
  const digest = canonicalSha256({ kind: 'liftoff-activation-target-history-path', schemaVersion: 1, reference });
  return Object.freeze(['.liftoff', 'activation-target-history', digest, 'manifest.json'] as const);
}
