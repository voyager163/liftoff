import { isUtf8 } from 'node:buffer';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { parseStrictManifestJson } from '../../domain/project/manifest/json.js';
import { StateMigrationError } from '../../domain/repair/stateful.js';
import { stateAssert } from '../../domain/repair/stateful-invariants.js';
import { managedLinuxKeystoreKinds } from '../../domain/repair/managed-linux-keystore-contract.js';
import {
  managedLinuxKeyReferenceId, mergeManagedLinuxKeyEffect,
  parseManagedLinuxEnrollmentRecord, parseManagedLinuxKeyReference, parseManagedLinuxRecoveryCheckpoint,
  parseManagedLinuxPersistedGeneration, readManagedLinuxCheckpointChain,
  type ManagedLinuxKeystoreBinding, type ManagedLinuxKeystoreRecord, type ManagedLinuxKeyEffect,
  type ManagedLinuxPersistedGeneration, type ManagedLinuxRecoveryCheckpoint
} from '../../domain/repair/managed-linux-keystore-records.js';
import { inspectControlledGnomeBinary } from './gnome-persisted-format.js';
import { type LinuxKeyClientOutcome, PrivateLinuxKeySnapshot } from './linux-keystore-client-protocol.js';
import { verifyManagedKeystoreKeyBinding, type ManagedKeystoreKeyContext } from './managed-keystore-key-binding.js';

export const maximumManagedLinuxRecordBytes = 32768;

function parseRecord(value: unknown): ManagedLinuxKeystoreRecord {
  stateAssert(isRecord(value), 'artifact-integrity');
  switch (value.kind) {
    case managedLinuxKeystoreKinds.enrollment: return parseManagedLinuxEnrollmentRecord(value);
    case managedLinuxKeystoreKinds.checkpoint: return parseManagedLinuxRecoveryCheckpoint(value);
    case managedLinuxKeystoreKinds.keyReference: return parseManagedLinuxKeyReference(value);
    default: throw new StateMigrationError('artifact-integrity');
  }
}

/** New managed-Linux metadata only; never an auto-migration reader for legacy records. */
export function decodeManagedLinuxKeystoreRecord(bytes: Uint8Array): ManagedLinuxKeystoreRecord {
  try {
    stateAssert(bytes.byteLength > 0 && bytes.byteLength <= maximumManagedLinuxRecordBytes && isUtf8(bytes), 'artifact-integrity');
    const value = parseStrictManifestJson(Buffer.from(bytes).toString('utf8'), 'Managed Linux record');
    return parseRecord(value);
  } catch { throw new StateMigrationError('artifact-integrity'); }
}

export function encodeManagedLinuxKeystoreRecord(record: ManagedLinuxKeystoreRecord): Uint8Array {
  const bytes = Buffer.from(canonicalJson(parseRecord(record)));
  stateAssert(bytes.byteLength <= maximumManagedLinuxRecordBytes, 'artifact-integrity');
  return bytes;
}

export function retainManagedLinuxClientEffect(previous: ManagedLinuxKeyEffect, outcome: LinuxKeyClientOutcome): ManagedLinuxKeyEffect {
  return mergeManagedLinuxKeyEffect(previous, {
    creation: outcome.creation,
    observedItemPaths: outcome.observedItemPaths
  });
}

/** Consumes encrypted file bytes. Structural inspection is not native custody/durability proof. */
export function consumeManagedLinuxPersistedGeneration(
  bytes: Uint8Array, identity: Omit<ManagedLinuxPersistedGeneration, 'format' | 'sha256' | 'byteLength'>
): ManagedLinuxPersistedGeneration {
  try {
    const observed = inspectControlledGnomeBinary(bytes);
    return parseManagedLinuxPersistedGeneration({
      ...identity, format: observed.format, sha256: observed.sha256, byteLength: observed.bytes
    });
  } finally { bytes.fill(0); }
}

export interface ManagedLinuxRecordSelection {
  binding: ManagedLinuxKeystoreBinding;
  enrollmentFingerprint: string;
  checkpointFingerprint: string;
  keyRef: string;
}

const metadataOnly = Object.freeze({
  evidence: 'metadata-binding-only' as const,
  nativeAuthority: 'not-established' as const,
  execution: 'not-authorized' as const,
  readiness: false as const,
  recovery: Object.freeze({
    preserveScope: true, creationRetry: 'not-authorized', passwordReset: 'not-authorized',
    rekey: 'not-authorized', crossHostConversion: 'not-authorized', disposal: 'not-authorized'
  } as const)
});

/** Reads incomplete/blocked histories without requiring or minting a ready key reference. */
export function readManagedLinuxRecoveryRecords(input: {
  enrollment: Uint8Array;
  checkpoints: readonly Uint8Array[];
  expected: Omit<ManagedLinuxRecordSelection, 'keyRef'>;
}) {
  stateAssert(isRecord(input) && Object.keys(input).sort().join(',') === 'checkpoints,enrollment,expected' &&
    Array.isArray(input.checkpoints) && input.checkpoints.length > 0 && input.checkpoints.length <= 64 &&
    isRecord(input.expected) &&
    Object.keys(input.expected).sort().join(',') === 'binding,checkpointFingerprint,enrollmentFingerprint', 'artifact-integrity');
  const enrollment = parseManagedLinuxEnrollmentRecord(decodeManagedLinuxKeystoreRecord(input.enrollment));
  const checkpoints = input.checkpoints.map((bytes) => parseManagedLinuxRecoveryCheckpoint(decodeManagedLinuxKeystoreRecord(bytes)));
  const current = readManagedLinuxCheckpointChain(enrollment, checkpoints, input.expected.binding);
  stateAssert(enrollment.fingerprint === input.expected.enrollmentFingerprint &&
    current.checkpoint.fingerprint === input.expected.checkpointFingerprint, 'stale-state');
  return Object.freeze({ ...current, ...metadataOnly });
}

/** Selection equality/integrity only. Caller-supplied records cannot authorize native operations. */
export function readManagedLinuxKeystoreReferences(input: {
  enrollment: Uint8Array;
  checkpoints: readonly Uint8Array[];
  keyReference: Uint8Array;
  expected: ManagedLinuxRecordSelection;
}) {
  stateAssert(isRecord(input) && Object.keys(input).sort().join(',') === 'checkpoints,enrollment,expected,keyReference' &&
    Array.isArray(input.checkpoints) && input.checkpoints.length > 0 && input.checkpoints.length <= 64 &&
    isRecord(input.expected) &&
    Object.keys(input.expected).sort().join(',') === 'binding,checkpointFingerprint,enrollmentFingerprint,keyRef', 'artifact-integrity');
  const { enrollment, checkpoint } = readManagedLinuxRecoveryRecords({
    enrollment: input.enrollment, checkpoints: input.checkpoints, expected: {
      binding: input.expected.binding, enrollmentFingerprint: input.expected.enrollmentFingerprint,
      checkpointFingerprint: input.expected.checkpointFingerprint
    }
  });
  const reference = parseManagedLinuxKeyReference(decodeManagedLinuxKeystoreRecord(input.keyReference));
  stateAssert(managedLinuxKeyReferenceId(reference) === input.expected.keyRef, 'stale-state');
  stateAssert(checkpoint.stage === 'restart-observed' && checkpoint.generation !== null &&
    reference.enrollmentFingerprint === enrollment.fingerprint && reference.checkpointFingerprint === checkpoint.fingerprint &&
    reference.bindingDigest === checkpoint.bindingDigest && reference.itemPath === checkpoint.keyEffect.observedItemPaths[0] &&
    reference.persistedGenerationDigest === checkpoint.generation.sha256 &&
    reference.keyBindingDigest === checkpoint.keyBindingDigest, 'artifact-integrity');
  return Object.freeze({ enrollment, checkpoint, reference, ...metadataOnly });
}

function keyContext(binding: ManagedLinuxKeystoreBinding, checkpoint: ManagedLinuxRecoveryCheckpoint): ManagedKeystoreKeyContext {
  stateAssert(checkpoint.generation, 'artifact-integrity');
  return {
    projectId: binding.projectId, hostRef: binding.hostRef, principalUid: binding.principalUid,
    enrollmentId: binding.enrollmentId, storeId: binding.storeId,
    itemPath: checkpoint.keyEffect.observedItemPaths[0]!,
    daemonDigest: binding.software.daemonDigest,
    dependencyInventoryDigest: binding.software.dependencyInventoryDigest,
    helperDigest: binding.software.clientDigest,
    persistedGenerationDigest: checkpoint.generation.sha256
  };
}

/**
 * Reuses the existing consuming cryptographic verifier. Even a matching fresh
 * buffer is not proof of its native origin, new process, storage or approval.
 */
export async function verifyManagedLinuxKeyReferenceBinding(
  input: Parameters<typeof readManagedLinuxKeystoreReferences>[0],
  encryptedBinding: unknown, freshKey: PrivateLinuxKeySnapshot
) {
  try {
    const records = readManagedLinuxKeystoreReferences(input);
    const result = await verifyManagedKeystoreKeyBinding(freshKey, encryptedBinding,
      keyContext(records.enrollment.binding, records.checkpoint));
    stateAssert(canonicalSha256(encryptedBinding) === records.reference.keyBindingDigest, 'artifact-integrity');
    return result;
  } finally { freshKey.release(); }
}
