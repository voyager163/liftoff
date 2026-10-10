import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import type {
  ProtectedStateBackup,
  ProtectedStateCustodyProof,
  ProtectedStateOperationRequest
} from './transition-ports.js';

const digestPattern = /^[a-f0-9]{64}$/u;
const opaqueRefPattern = /^[a-z][a-z0-9-]{1,31}:[A-Za-z0-9._/-]{1,512}$/u;
const hostIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

type CustodyBinding = Pick<
  ProtectedStateOperationRequest,
  'bindingDigest' | 'runner'
>;

function custodyBody(proof: ProtectedStateCustodyProof): Omit<ProtectedStateCustodyProof, 'qualificationDigest'> {
  const { qualificationDigest: _qualificationDigest, ...body } = proof;
  return body;
}

export function protectedStateCustodyDigest(
  proof: ProtectedStateCustodyProof
): string {
  return canonicalSha256(custodyBody(proof));
}

export function protectedStateCustodyIdentityDigest(
  proof: ProtectedStateCustodyProof
): string {
  return canonicalSha256({
    kind: proof.kind,
    bindingDigest: proof.bindingDigest,
    runnerId: proof.runnerId,
    runnerLabel: proof.runnerLabel,
    runnerGroupId: proof.runnerGroupId,
    networkConfigurationId: proof.networkConfigurationId,
    hostId: proof.hostId,
    workspaceRef: proof.workspaceRef,
    storageRef: proof.storageRef,
    keyProviderRef: proof.keyProviderRef,
    protectedStorage: proof.protectedStorage,
    keyCustody: proof.keyCustody,
    locking: proof.locking,
    writerQuiesced: proof.writerQuiesced,
    plaintextFallback: proof.plaintextFallback,
    disposalSupported: proof.disposalSupported
  });
}

export function assertProtectedStateCustodyProof(
  proof: ProtectedStateCustodyProof,
  binding: CustodyBinding,
  now: Date
): void {
  const observedAt = Date.parse(proof.observedAt);
  const expiresAt = Date.parse(proof.expiresAt);
  if (proof.kind !== 'protected-state-custody.v1' ||
    proof.bindingDigest !== binding.bindingDigest ||
    proof.runnerId !== binding.runner.id ||
    proof.runnerLabel !== binding.runner.label ||
    proof.runnerGroupId !== binding.runner.groupId ||
    proof.networkConfigurationId !== binding.runner.networkConfigurationId ||
    !hostIdPattern.test(proof.hostId) ||
    !opaqueRefPattern.test(proof.workspaceRef) ||
    !opaqueRefPattern.test(proof.storageRef) ||
    !opaqueRefPattern.test(proof.keyProviderRef) ||
    proof.protectedStorage !== 'encrypted-private' ||
    proof.keyCustody !== 'external-nonexporting' ||
    proof.locking !== 'azure-blob-lease' ||
    proof.writerQuiesced !== true ||
    proof.plaintextFallback !== false ||
    proof.disposalSupported !== true ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    observedAt > now.getTime() ||
    expiresAt <= now.getTime() ||
    !digestPattern.test(proof.qualificationDigest) ||
    proof.qualificationDigest !== protectedStateCustodyDigest(proof)) {
    throw new Error(
      'Protected state custody must bind the reviewed runner to current encrypted storage, non-exporting keys, lease locking, writer quiescence, and due-time disposal without plaintext fallback.'
    );
  }
}

export function assertMatchingProtectedStateCustody(
  actual: ProtectedStateCustodyProof,
  expected: ProtectedStateCustodyProof
): void {
  if (protectedStateCustodyIdentityDigest(actual) !==
    protectedStateCustodyIdentityDigest(expected)) {
    throw new Error('Protected state proof changed the qualified host, storage, key, locking, or disposal custody.');
  }
}

function opaqueRef(value: string, label: string): string {
  if (!opaqueRefPattern.test(value)) {
    throw new Error(`${label} must be one bounded opaque protected-custody reference.`);
  }
  return value;
}

export function protectedStateBackupInventory(
  backups: readonly ProtectedStateBackup[],
  custody: ProtectedStateCustodyProof
): {
  encryptedStatePathParts: string[][];
  encryptionKeyPathParts: string[][];
} {
  if (backups.length < 1 || backups.length > 8) {
    throw new Error('Protected state handover requires a bounded nonempty encrypted backup inventory.');
  }
  const encryptedStatePathParts: string[][] = [];
  const encryptionKeyPathParts: string[][] = [];
  const seenArtifacts = new Set<string>();
  const seenKeys = new Set<string>();
  for (const [index, backup] of backups.entries()) {
    if (!digestPattern.test(backup.artifactDigest)) {
      throw new Error('Protected state backup digest is invalid.');
    }
    const encryptedStateRef = opaqueRef(
      backup.encryptedStateRef,
      `Protected state backup ${index}`
    );
    const encryptionKeyRef = opaqueRef(
      backup.encryptionKeyRef,
      `Protected state key ${index}`
    );
    if (!encryptedStateRef.startsWith(`${custody.workspaceRef}/`) ||
      encryptionKeyRef !== custody.keyProviderRef ||
      seenArtifacts.has(encryptedStateRef) ||
      encryptedStateRef === encryptionKeyRef) {
      throw new Error(
        'Protected state backups must bind distinct encrypted artifacts to the qualified workspace and exact non-exporting key reference.'
      );
    }
    seenArtifacts.add(encryptedStateRef);
    encryptedStatePathParts.push([
      'protected-custody',
      canonicalSha256(encryptedStateRef)
    ]);
    if (!seenKeys.has(encryptionKeyRef)) {
      seenKeys.add(encryptionKeyRef);
      encryptionKeyPathParts.push([
        'protected-custody',
        canonicalSha256(encryptionKeyRef)
      ]);
    }
  }
  return { encryptedStatePathParts, encryptionKeyPathParts };
}

export function protectedStateCustodyFromPayload(
  value: unknown
): ProtectedStateCustodyProof | null {
  if (!isRecord(value) || value.kind !== 'protected-state-custody.v1') return null;
  return value as unknown as ProtectedStateCustodyProof;
}

export function protectedStateBackupsFromPayload(
  value: unknown
): readonly ProtectedStateBackup[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => isRecord(entry) &&
    typeof entry.artifactDigest === 'string' &&
    typeof entry.encryptedStateRef === 'string' &&
    typeof entry.encryptionKeyRef === 'string')
    ? value as unknown as readonly ProtectedStateBackup[]
    : null;
}
