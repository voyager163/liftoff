import type {
  PhaseAdapterExecutionInput,
  PhaseAdapterOutcome,
  ProtectedStateDisposalProof
} from './transition-ports.js';
import { latestRecordWithPayload, evidenceHeaderDigest } from '../domain/governance/activation/evidence.js';
import { isRecord, canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { cloneState, safeTimestamp } from './transition-records.js';
import { validateArtifactPathParts } from '../domain/project/paths.js';
import {
  assertMatchingProtectedStateCustody,
  assertProtectedStateCustodyProof,
  protectedStateBackupInventory,
  protectedStateBackupsFromPayload,
  protectedStateCustodyFromPayload
} from './protected-state-custody.js';

const dayMs = 24 * 60 * 60 * 1000;
const remoteImportPayloadKind = 'remote-import-verified.v1';
const bootstrapStateDisposedPayloadKind = 'bootstrap-state-disposed.v1';

export function remoteImportRetention(input: PhaseAdapterExecutionInput): PhaseAdapterOutcome | null {
  if (input.phase.id !== 'remote-ready') return null;
  const statePath = input.inspection.state.applicability.statePath;
  if (statePath === 'none') {
    return { status: 'blocked', blocker: 'Remote readiness requires an explicitly selected backend path.', completedOperations: [] };
  }
  if (statePath === 'existing-private') {
    if (latestRecordWithPayload(input.inspection, 'existing-private-path')?.header.result !== 'verified') {
      return { status: 'blocked', blocker: 'The selected existing-private backend path has no current authoritative proof.', completedOperations: [] };
    }
    return {
      status: 'completed', resultState: 'verified',
      evidencePayload: { kind: 'remote-ready.v1', retention: 'not-applicable' },
      completedOperations: input.plan.operations.filter((op) => op.actionId === 'azure.remote-ready.verify')
    };
  }
  const importRecord = latestRecordWithPayload(input.inspection, 'remote-import-verified');
  if (!importRecord || importRecord.header.result !== 'verified' || !isRecord(importRecord.payload) || importRecord.payload.kind !== remoteImportPayloadKind) {
    return { status: 'blocked', blocker: 'Remote import retention requires immutable remote-import evidence with state and key identifiers.', completedOperations: [] };
  }
  const encryptedStatePathParts = pathPartLists(importRecord.payload.encryptedStatePathParts, 'encryptedStatePathParts');
  const encryptionKeyPathParts = pathPartLists(importRecord.payload.encryptionKeyPathParts, 'encryptionKeyPathParts');
  const retainedAt = input.now.toISOString();
  const disposeAfter = new Date(input.now.getTime() + 30 * dayMs).toISOString();
  const state = cloneState(input.inspection.state);
  state.bootstrapState = {
    status: 'retained', remoteImportEvidenceId: importRecord.evidenceId,
    remoteImportEvidenceDigest: evidenceHeaderDigest(importRecord.header),
    retainedAt, disposeAfter, encryptedStatePathParts, encryptionKeyPathParts
  };
  return {
    status: 'completed', resultState: 'retained', stateOverride: state,
    evidencePayload: { kind: 'remote-ready.v1', retention: state.bootstrapState },
    completedOperations: input.plan.operations.filter((op) => op.actionId === 'azure.remote-ready.verify')
  };
}

function pathPartLists(value: unknown, label: string): string[][] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of path-part arrays.`);
  return value.map((entry, index) => validateArtifactPathParts(entry, `${label}[${index}]`));
}

function disposalBody(
  proof: ProtectedStateDisposalProof
): Omit<ProtectedStateDisposalProof, 'disposalDigest'> {
  const { disposalDigest: _disposalDigest, ...body } = proof;
  return body;
}

function disposalBlocked(reason: string): string {
  switch (reason) {
    case 'unsupported-host':
      return 'The retained bootstrap state cannot be disposed from an unsupported execution host.';
    case 'protected-storage-unavailable':
      return 'Protected bootstrap storage is unavailable; disposal cannot fall back to project files.';
    case 'key-unavailable':
      return 'The exact retained non-exporting key reference is unavailable.';
    case 'locking-unavailable':
      return 'The exact retained locking capability is unavailable.';
    case 'writer-active':
      return 'Bootstrap state disposal requires verified writer quiescence.';
    case 'artifact-missing':
      return 'Protected bootstrap artifacts were missing before exact disposal could be verified.';
    default:
      return 'Protected bootstrap custody could not verify exact due-time disposal.';
  }
}

export async function executeBootstrapStateDisposal(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'bootstrap-state-disposed') return null;
  const retention = input.inspection.state.bootstrapState;
  const statePath = input.inspection.state.applicability.statePath;
  if (statePath === 'none' || statePath === 'bootstrap-local' && !retention) {
    return { status: 'blocked', blocker: 'Bootstrap disposal requires a selected path and its recorded retention inventory.', completedOperations: [] };
  }
  if (statePath !== 'bootstrap-local') {
    return {
      status: 'completed', resultState: 'inapplicable',
      evidencePayload: { kind: bootstrapStateDisposedPayloadKind, reason: 'no retained bootstrap state' },
      completedOperations: []
    };
  }
  if (!retention) throw new Error('Selected bootstrap retention inventory is missing.');
  if (retention.status === 'disposed') {
    return {
      status: 'completed', resultState: 'disposed',
      evidencePayload: { kind: bootstrapStateDisposedPayloadKind, reason: 'already disposed', deletionEvidenceId: retention.deletionEvidenceId ?? null },
      completedOperations: []
    };
  }
  if (Date.parse(retention.disposeAfter) > input.now.getTime()) {
    return { status: 'blocked', blocker: `Retained bootstrap state is not disposable until ${retention.disposeAfter}.`, completedOperations: [] };
  }
  const importRecord = latestRecordWithPayload(input.inspection, 'remote-import-verified');
  if (!importRecord || importRecord.evidenceId !== retention.remoteImportEvidenceId ||
    importRecord.header.result !== 'verified' || evidenceHeaderDigest(importRecord.header) !== retention.remoteImportEvidenceDigest) {
    return { status: 'blocked', blocker: 'Destructive disposal requires the immutable remote-import evidence referenced by retained bootstrap state.', completedOperations: [] };
  }
  if (!isRecord(importRecord.payload) || importRecord.payload.kind !== remoteImportPayloadKind) {
    return { status: 'blocked', blocker: 'Destructive disposal requires verified remote backend and no-change evidence.', completedOperations: [] };
  }
  const custody = protectedStateCustodyFromPayload(importRecord.payload.custody);
  const backups = protectedStateBackupsFromPayload(importRecord.payload.backups);
  if (!custody || !backups) {
    return { status: 'blocked', blocker: 'Destructive disposal requires the original qualified protected custody and backup references.', completedOperations: [] };
  }
  const bindingDigest = importRecord.payload.bindingDigest;
  const backendBindingDigest = importRecord.payload.backendBindingDigest;
  const runnerId = importRecord.payload.runnerId;
  const runnerLabel = importRecord.payload.runnerLabel;
  const bootstrapBindingDigest =
    input.inspection.state.phaseOutputs?.['remote-import-verified']?.values.bootstrapBindingDigest;
  if (typeof bindingDigest !== 'string' || typeof backendBindingDigest !== 'string' ||
    typeof bootstrapBindingDigest !== 'string' ||
    typeof runnerId !== 'number' || typeof runnerLabel !== 'string') {
    return { status: 'blocked', blocker: 'Destructive disposal requires exact retained runner, backend, and bootstrap bindings.', completedOperations: [] };
  }
  const retainedRunner = {
    id: runnerId,
    label: runnerLabel,
    groupId: custody.runnerGroupId,
    networkConfigurationId: custody.networkConfigurationId
  };
  try {
    assertProtectedStateCustodyProof(custody, {
      bindingDigest,
      runner: retainedRunner
    }, input.now);
  } catch {
    return { status: 'blocked', blocker: 'The retained protected custody proof is invalid or expired.', completedOperations: [] };
  }
  let protectedInventory: ReturnType<typeof protectedStateBackupInventory>;
  try {
    protectedInventory = protectedStateBackupInventory(backups, custody);
  } catch {
    return { status: 'blocked', blocker: 'The retained protected backup inventory is invalid.', completedOperations: [] };
  }
  if (canonicalSha256(retention.encryptedStatePathParts) !== canonicalSha256(protectedInventory.encryptedStatePathParts) ||
    canonicalSha256(retention.encryptionKeyPathParts) !== canonicalSha256(protectedInventory.encryptionKeyPathParts) ||
    canonicalSha256(retention.encryptedStatePathParts) !== canonicalSha256(importRecord.payload.encryptedStatePathParts) ||
    canonicalSha256(retention.encryptionKeyPathParts) !== canonicalSha256(importRecord.payload.encryptionKeyPathParts)) {
    return { status: 'blocked', blocker: 'Disposal paths differ from the immutable verified import inventory.', completedOperations: [] };
  }
  const remoteBackendDigest = importRecord.payload.remoteBackendDigest;
  const noChangePlanDigest = importRecord.payload.noChangePlanDigest;
  if (typeof remoteBackendDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(remoteBackendDigest) ||
    typeof noChangePlanDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(noChangePlanDigest)) {
    return { status: 'blocked', blocker: 'Destructive disposal requires payload-free remote backend and no-change plan digests.', completedOperations: [] };
  }
  const custodyPort = input.adapters.protectedStateCustody;
  if (!custodyPort) {
    return { status: 'blocked', blocker: 'Bootstrap disposal requires the same explicitly registered protected custody capability.', completedOperations: [] };
  }
  const qualification = await custodyPort.qualify({
    schemaVersion: 1,
    bindingDigest,
    repository: input.inspection.state.repository.name,
    runner: retainedRunner,
    backendBindingDigest,
    bootstrapBindingDigest,
    retentionDays: 30
  });
  if (qualification.status === 'blocked') {
    return { status: 'blocked', blocker: disposalBlocked(qualification.reason), completedOperations: [] };
  }
  try {
    assertProtectedStateCustodyProof(qualification.proof, {
      bindingDigest,
      runner: retainedRunner
    }, input.now);
    assertMatchingProtectedStateCustody(qualification.proof, custody);
  } catch {
    return { status: 'blocked', blocker: 'Current protected custody differs from the immutable retained host, storage, key, or locking authority.', completedOperations: [] };
  }
  const disposal = await custodyPort.dispose({
    schemaVersion: 1,
    repository: input.inspection.state.repository.name,
    remoteImportEvidenceId: importRecord.evidenceId,
    remoteImportEvidenceDigest: retention.remoteImportEvidenceDigest,
    remoteBackendDigest,
    noChangePlanDigest,
    disposeAfter: retention.disposeAfter,
    requestedAt: input.now.toISOString(),
    custody,
    backups
  });
  if (disposal.status === 'blocked') {
    return { status: 'blocked', blocker: disposalBlocked(disposal.reason), completedOperations: [] };
  }
  const artifactRefs = backups.map((backup) => backup.encryptedStateRef);
  const keyRefs = [...new Set(backups.map((backup) => backup.encryptionKeyRef))];
  const disposedAt = Date.parse(disposal.proof.disposedAt);
  if (disposal.proof.kind !== 'protected-state-disposal.v1' ||
    disposal.proof.remoteImportEvidenceId !== importRecord.evidenceId ||
    disposal.proof.remoteImportEvidenceDigest !== retention.remoteImportEvidenceDigest ||
    disposal.proof.custodyQualificationDigest !== custody.qualificationDigest ||
    disposal.proof.payloadFree !== true ||
    !Number.isFinite(disposedAt) ||
    disposedAt < Date.parse(retention.disposeAfter) ||
    disposedAt > input.now.getTime() ||
    canonicalSha256(disposal.proof.deletedArtifactRefs) !== canonicalSha256(artifactRefs) ||
    canonicalSha256(disposal.proof.deletedKeyRefs) !== canonicalSha256(keyRefs) ||
    disposal.proof.disposalDigest !== canonicalSha256(disposalBody(disposal.proof))) {
    return { status: 'blocked', blocker: 'Protected custody returned incomplete or contradictory disposal evidence.', completedOperations: [] };
  }
  const state = cloneState(input.inspection.state);
  state.bootstrapState = {
    ...retention, status: 'disposed', disposedAt: input.now.toISOString(),
    deletionEvidenceId: `${input.phase.id}-${safeTimestamp(input.now.toISOString())}`, incompleteCleanup: []
  };
  return {
    status: 'completed', resultState: 'disposed', stateOverride: state,
    evidencePayload: {
      kind: bootstrapStateDisposedPayloadKind,
      deletedPathParts: [
        ...retention.encryptedStatePathParts,
        ...retention.encryptionKeyPathParts
      ],
      deletedArtifactRefs: artifactRefs,
      deletedKeyRefs: keyRefs,
      custodyQualificationDigest: custody.qualificationDigest,
      disposalDigest: disposal.proof.disposalDigest,
      remoteBackendDigest, noChangePlanDigest, incompleteCleanup: [], payloadFree: true
    },
    completedOperations: input.plan.operations.filter((op) => op.actionId === 'local.bootstrap-state.dispose'),
    cleanupWarnings: []
  };
}
