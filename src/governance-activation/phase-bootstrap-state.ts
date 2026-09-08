import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome } from './transition-ports.js';
import { latestRecordWithPayload, evidenceHeaderDigest } from '../domain/governance/activation/evidence.js';
import { isRecord, canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { cloneState, safeTimestamp } from './transition-records.js';
import { validateArtifactPathParts } from '../domain/project/paths.js';
import { resolveProjectPath } from '../adapters/filesystem/project-paths.js';
import { stat } from 'node:fs/promises';
import { errorMessage } from './transition-process.js';

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
  if (canonicalSha256(retention.encryptedStatePathParts) !== canonicalSha256(importRecord.payload.encryptedStatePathParts) ||
    canonicalSha256(retention.encryptionKeyPathParts) !== canonicalSha256(importRecord.payload.encryptionKeyPathParts)) {
    return { status: 'blocked', blocker: 'Disposal paths differ from the immutable verified import inventory.', completedOperations: [] };
  }
  const remoteBackendDigest = importRecord.payload.remoteBackendDigest;
  const noChangePlanDigest = importRecord.payload.noChangePlanDigest;
  if (typeof remoteBackendDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(remoteBackendDigest) ||
    typeof noChangePlanDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(noChangePlanDigest)) {
    return { status: 'blocked', blocker: 'Destructive disposal requires payload-free remote backend and no-change plan digests.', completedOperations: [] };
  }
  const allPaths = [...retention.encryptedStatePathParts, ...retention.encryptionKeyPathParts]
    .map((parts) => validateArtifactPathParts([...parts], 'Bootstrap disposal path'));
  const incompleteCleanup: string[] = [];
  for (const parts of allPaths) {
    try {
      const target = await resolveProjectPath(input.inspection.projectRoot, parts);
      const details = await stat(target);
      if (!details.isFile()) incompleteCleanup.push(`${parts.join('/')} is not a regular file.`);
    } catch (error) {
      incompleteCleanup.push(`${parts.join('/')} was already absent before disposal: ${errorMessage(error)}`);
    }
  }
  const state = cloneState(input.inspection.state);
  state.bootstrapState = {
    ...retention, status: 'disposed', disposedAt: input.now.toISOString(),
    deletionEvidenceId: `${input.phase.id}-${safeTimestamp(input.now.toISOString())}`, incompleteCleanup
  };
  return {
    status: 'completed', resultState: 'disposed', stateOverride: state,
    evidencePayload: {
      kind: bootstrapStateDisposedPayloadKind, deletedPathParts: allPaths,
      remoteBackendDigest, noChangePlanDigest, incompleteCleanup, payloadFree: true
    },
    fileMutations: allPaths.map((parts) => ({ type: 'delete', pathParts: parts })),
    completedOperations: input.plan.operations.filter((op) => op.actionId === 'local.bootstrap-state.dispose'),
    cleanupWarnings: incompleteCleanup
  };
}
