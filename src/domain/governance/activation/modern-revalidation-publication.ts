import { canonicalSha256 } from './canonical-json.js';
import { copyModernLocalData, localInputFailure, rawLocalDigest } from './modern-local-inputs.js';
import {
  completionRecord, completionHash, completionRoot, completionTime, snapshotControl, validateCompletedBinding,
  type CompletedLocalExecutionBinding, type CompletionSnapshot, type ManualFinalizationResult
} from './modern-local-completion.js';
import { exactRecord } from '../../project/manifest/fields.js';
import { validateManifestPathParts } from '../../project/manifest/layout.js';
import { modernLocalRevalidationPhases } from './modern-record-contracts.js';

export const localRevalidationPolicy = Object.freeze({
  kind: 'liftoff-local-revalidation-policy', schemaVersion: 1,
  recordBytes: 65536, artifacts: 9, mutations: 8, approvalLifetimeMs: 900000,
  execution: 'independently-completed-native-operation', framework: 'already-completed-source-only',
  baseline: 'fresh-local-proof-before-nonlocal-progression', publication: 'separate-exact-byte-consent',
  recovery: 'explicit-attributed-transaction-only'
});
export const revalidationPhaseIds = modernLocalRevalidationPhases;
export type RevalidationPhaseId = typeof revalidationPhaseIds[number];
type TargetPurpose = 'input-plan' | 'baseline-plan' | 'completion-plan' | 'input-evidence' |
  'baseline-evidence' | 'completion-evidence' | 'state' | 'migration-journal';
const targetPurposes: readonly TargetPurpose[] = [
  'input-plan', 'baseline-plan', 'completion-plan', 'input-evidence', 'baseline-evidence', 'completion-evidence', 'state', 'migration-journal'
];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export interface LocalRevalidationIntent {
  kind: 'liftoff-local-revalidation-preview'; schemaVersion: 1; operationKind: 'revalidate-successor';
  projectRoot: string; operationId: string; createdAt: string; expiresAt: string; fingerprint: string;
  sourceBinding: string; sourcePlanFingerprint: string; originalTransitionDigest: string; originalPreparationDigest: string;
  execution: CompletedLocalExecutionBinding; protectedSetDigest: string; policyDigest: string;
}
export interface LocalRevalidationArtifact {
  kind: 'liftoff-local-revalidation-artifact'; schemaVersion: 1;
  projectRoot: string; operationId: string; intentFingerprint: string;
  role: 'target' | 'protected-index'; pathParts: string[] | null; mode: number | null;
  contentBase64: string; bytes: number; rawDigest: string;
}
export interface LocalRevalidationTarget {
  pathParts: string[]; operation: 'write'; original: CompletionSnapshot; target: CompletionSnapshot;
  artifactKey: string; purpose: TargetPurpose;
}
export interface LocalRevalidationResult {
  kind: 'liftoff-local-revalidation-result'; schemaVersion: 1;
  projectRoot: string; operationId: string; fingerprint: string;
  execution: CompletedLocalExecutionBinding; originalTransitionDigest: string; originalPreparationDigest: string;
  startedAt: string; completedAt: string; protectedIndexKey: string; protectedSetDigest: string;
  phases: { phaseId: RevalidationPhaseId; status: 'complete' | 'blocked'; evidenceId: string | null; blockers: string[] }[];
  targets: LocalRevalidationTarget[]; targetSetDigest: string;
  candidateBinding: string; candidateSize: ManualFinalizationResult['candidateSize'];
  reviewCreatedAt: string; reviewExpiresAt: string; publicationFingerprint: string; resultDigest: string;
}
export interface LocalRevalidationConsent {
  kind: 'liftoff-local-revalidation-publication-consent'; schemaVersion: 1;
  projectRoot: string; intentFingerprint: string; resultDigest: string;
  publicationFingerprint: string; candidateBinding: string; targetSetDigest: string;
  executionConsentDigest: string; executionResultDigest: string; approvedAt: string; expiresAt: string;
  scopes: {
    publishLocalRecords: true; workflowWrites: false; projectCode: false; dependencyPreparation: false;
    dependencyNetwork: false; protectedStateAccess: false; providerAccess: false;
  };
}
export interface LocalRevalidationState {
  kind: 'liftoff-local-revalidation-state'; schemaVersion: 1;
  projectRoot: string; operationId: string; intentFingerprint: string;
  publicationFingerprint: string; candidateBinding: string; ownerTokenDigest: string;
  phase: 'publishing' | 'committed-readback-pending' | 'complete' | 'incomplete' | 'rolled-back' | 'blocked';
  startedAt: string; updatedAt: string; transactionDigest: string | null;
  commitObservation: {
    publicationFingerprint: string; transactionDigest: string; observedAt: string;
    source: 'local-verification-inspector'; committed: true;
  } | null;
  readbackDigest: string | null; cleanupPending: boolean;
}

function lifetime(createdAt: string, expiresAt: string, now: Date) {
  const created = completionTime(createdAt), expires = completionTime(expiresAt);
  if (!Number.isFinite(now.getTime()) || created > now.getTime() || expires <= now.getTime() ||
      expires <= created || expires - created > localRevalidationPolicy.approvalLifetimeMs) {
    localInputFailure('Revalidation review is expired or has invalid issuance.');
  }
}
export function validateRevalidationIntent(input: LocalRevalidationIntent, now: Date): LocalRevalidationIntent {
  const p = completionRecord(input, ['kind', 'schemaVersion', 'operationKind', 'projectRoot', 'operationId', 'createdAt', 'expiresAt',
    'fingerprint', 'sourceBinding', 'sourcePlanFingerprint', 'originalTransitionDigest', 'originalPreparationDigest', 'execution',
    'protectedSetDigest', 'policyDigest'], 'Revalidation intent');
  if (p.kind !== 'liftoff-local-revalidation-preview' || p.schemaVersion !== 1 || p.operationKind !== 'revalidate-successor' ||
      !uuid.test(p.operationId) || p.policyDigest !== canonicalSha256(localRevalidationPolicy)) localInputFailure('Invalid revalidation intent identity.');
  completionRoot(p.projectRoot); lifetime(p.createdAt, p.expiresAt, now); validateCompletedBinding(p.execution);
  if (!uuid.test(p.execution.operationId)) localInputFailure('Revalidation requires an actual native operation identity.');
  for (const [key, value] of Object.entries(p.execution)) {
    if (key.endsWith('Digest') || key.endsWith('Binding') || key.endsWith('Fingerprint')) completionHash(value);
  }
  for (const value of [p.sourceBinding, p.sourcePlanFingerprint, p.originalTransitionDigest, p.originalPreparationDigest, p.protectedSetDigest]) completionHash(value);
  if (p.execution.projectRoot !== p.projectRoot || p.execution.selectedPlanDigest === null ||
      completionTime(p.execution.completedAt) > completionTime(p.createdAt)) localInputFailure('Revalidation requires its own prior completed governed execution.');
  const { fingerprint, ...body } = p;
  if (fingerprint !== canonicalSha256(body)) localInputFailure('Revalidation intent fingerprint differs.');
  return p;
}
export function revalidationArtifactBytes(input: LocalRevalidationArtifact, intent: LocalRevalidationIntent): Buffer {
  const value = completionRecord(input, ['kind', 'schemaVersion', 'projectRoot', 'operationId', 'intentFingerprint', 'role',
    'pathParts', 'mode', 'contentBase64', 'bytes', 'rawDigest'], 'Revalidation artifact');
  if (value.kind !== 'liftoff-local-revalidation-artifact' || value.schemaVersion !== 1 || value.projectRoot !== intent.projectRoot ||
      value.operationId !== intent.operationId || value.intentFingerprint !== intent.fingerprint ||
      !['target', 'protected-index'].includes(value.role)) localInputFailure('Revalidation artifact attribution differs.');
  if (value.role === 'protected-index') {
    if (value.pathParts !== null || value.mode !== null) localInputFailure('Protected index cannot select a publication path.');
  } else {
    validateManifestPathParts(value.pathParts, 'Revalidation target');
    if (!Number.isInteger(value.mode) || value.mode === null || value.mode < 0 || value.mode > 0o777 || Object.is(value.mode, -0)) {
      localInputFailure('Invalid revalidation target mode.');
    }
  }
  if (typeof value.contentBase64 !== 'string' || !Number.isSafeInteger(value.bytes) || value.bytes < 0) localInputFailure('Invalid revalidation artifact bytes.');
  const bytes = Buffer.from(value.contentBase64, 'base64');
  if (bytes.toString('base64') !== value.contentBase64 || bytes.length !== value.bytes || rawLocalDigest(bytes) !== value.rawDigest) {
    localInputFailure('Revalidation artifact differs from its exact raw bytes.');
  }
  return bytes;
}
export function revalidationPublicationFingerprint(value: Omit<LocalRevalidationResult, 'publicationFingerprint' | 'resultDigest'>): string {
  return canonicalSha256({ kind: 'liftoff-local-revalidation-publication', schemaVersion: 1, result: value });
}
export function validateRevalidationResult(input: LocalRevalidationResult, intent: LocalRevalidationIntent): LocalRevalidationResult {
  const r = completionRecord(input, ['kind', 'schemaVersion', 'projectRoot', 'operationId', 'fingerprint', 'execution',
    'originalTransitionDigest', 'originalPreparationDigest', 'startedAt', 'completedAt', 'protectedIndexKey', 'protectedSetDigest',
    'phases', 'targets', 'targetSetDigest', 'candidateBinding', 'candidateSize', 'reviewCreatedAt', 'reviewExpiresAt',
    'publicationFingerprint', 'resultDigest'], 'Revalidation result');
  if (r.kind !== 'liftoff-local-revalidation-result' || r.schemaVersion !== 1 || r.projectRoot !== intent.projectRoot ||
      r.operationId !== intent.operationId || r.fingerprint !== intent.fingerprint || canonicalSha256(r.execution) !== canonicalSha256(intent.execution) ||
      r.originalTransitionDigest !== intent.originalTransitionDigest || r.originalPreparationDigest !== intent.originalPreparationDigest ||
      r.protectedSetDigest !== intent.protectedSetDigest) localInputFailure('Revalidation result is disconnected from its original source and execution.');
  for (const value of [r.protectedIndexKey, r.targetSetDigest, r.candidateBinding, r.publicationFingerprint, r.resultDigest]) completionHash(value);
  if (completionTime(r.startedAt) < completionTime(intent.createdAt) || completionTime(r.completedAt) < completionTime(r.startedAt) ||
      completionTime(r.completedAt) > completionTime(intent.expiresAt) || completionTime(r.reviewCreatedAt) < completionTime(r.completedAt)) {
    localInputFailure('Revalidation construction chronology differs.');
  }
  lifetime(r.reviewCreatedAt, r.reviewExpiresAt, new Date(r.reviewCreatedAt));
  if (!Array.isArray(r.phases) || r.phases.length !== 3) localInputFailure('Revalidation must retain exactly three local phases.');
  for (const [index, phase] of r.phases.entries()) {
    exactRecord(phase, ['phaseId', 'status', 'evidenceId', 'blockers'], 'Revalidation phase outcome');
    if (phase.phaseId !== revalidationPhaseIds[index] || !['complete', 'blocked'].includes(phase.status) ||
        index < 2 && phase.status !== 'complete' || !Array.isArray(phase.blockers) ||
        phase.blockers.some(value => typeof value !== 'string' || !value.length || value.length > 4096) ||
        (phase.status === 'complete' ? typeof phase.evidenceId !== 'string' || !uuid.test(phase.evidenceId) || phase.blockers.length !== 0
          : phase.evidenceId !== null || phase.blockers.length === 0)) localInputFailure('Revalidation phases contradict their actual evidence or blockers.');
  }
  const expected = targetPurposes.filter(purpose => purpose !== 'completion-evidence' || r.phases[2].status === 'complete');
  if (!Array.isArray(r.targets) || r.targets.length !== expected.length ||
      new Set(r.targets.map(target => target.purpose)).size !== expected.length) localInputFailure('Revalidation target coverage differs.');
  for (const target of r.targets) {
    exactRecord(target, ['pathParts', 'operation', 'original', 'target', 'artifactKey', 'purpose'], 'Revalidation target');
    validateManifestPathParts(target.pathParts, 'Revalidation target'); completionHash(target.artifactKey);
    snapshotControl(target.original); snapshotControl(target.target);
    if (target.operation !== 'write' || !target.target.exists || !expected.includes(target.purpose) ||
        Object.is(target.original.mode, -0) || Object.is(target.target.mode, -0)) localInputFailure('Unsupported revalidation target effect.');
    const name = target.pathParts.join('/');
    const phaseIndex = target.purpose.startsWith('input-') ? 0 : target.purpose.startsWith('baseline-') ? 1 : 2;
    const validPath = target.purpose === 'state' ? name === 'governance/activation-state.json' :
      target.purpose === 'migration-journal' ? name === 'governance/migration-state.json' :
        target.purpose.endsWith('-plan') ? /^governance\/plans\/[a-f0-9]{64}\.json$/u.test(name) :
          name === `governance/evidence/${r.phases[phaseIndex].evidenceId}.json`;
    if (!validPath || target.original.exists && target.purpose !== 'state' && target.purpose !== 'migration-journal' &&
        canonicalSha256(target.original) !== canonicalSha256(target.target) ||
        (target.purpose === 'state' || target.purpose === 'migration-journal') && !target.original.exists ||
        target.target.mode !== (target.original.exists ? target.original.mode : 0o600)) {
      localInputFailure('Revalidation cannot replace an immutable record or select another effect/path.');
    }
  }
  if (new Set(r.targets.map(target => target.pathParts.join('/'))).size !== r.targets.length ||
      r.targetSetDigest !== canonicalSha256(r.targets)) localInputFailure('Revalidation target paths or exact bytes differ.');
  exactRecord(r.candidateSize, ['kind', 'mutationCount', 'suppliedPreconditionCount', 'snapshotBytes', 'headerBytes',
    'mutationFrameBytes', 'commitFrameBytes', 'completeJournalBytes'], 'Revalidation candidate size');
  if (r.candidateSize.kind !== 'journal' || r.candidateSize.mutationCount !== r.targets.length ||
      Object.entries(r.candidateSize).some(([key, value]) => key !== 'kind' && (!Number.isSafeInteger(value) || Number(value) < 0 || Object.is(value, -0)))) {
    localInputFailure('Revalidation candidate lacks its measured transaction size.');
  }
  const { publicationFingerprint, resultDigest, ...body } = r;
  if (publicationFingerprint !== revalidationPublicationFingerprint(body) || resultDigest !== canonicalSha256({ ...body, publicationFingerprint })) {
    localInputFailure('Revalidation publication/result commitment differs.');
  }
  return r;
}
export function validateRevalidationConsent(input: LocalRevalidationConsent, result: LocalRevalidationResult, now: Date): LocalRevalidationConsent {
  const c = completionRecord(input, ['kind', 'schemaVersion', 'projectRoot', 'intentFingerprint', 'resultDigest', 'publicationFingerprint',
    'candidateBinding', 'targetSetDigest', 'executionConsentDigest', 'executionResultDigest', 'approvedAt', 'expiresAt', 'scopes'], 'Revalidation publication consent');
  exactRecord(c.scopes, ['publishLocalRecords', 'workflowWrites', 'projectCode', 'dependencyPreparation', 'dependencyNetwork', 'protectedStateAccess', 'providerAccess'],
    'Revalidation publication scopes');
  if (c.kind !== 'liftoff-local-revalidation-publication-consent' || c.schemaVersion !== 1 || c.projectRoot !== result.projectRoot ||
      c.intentFingerprint !== result.fingerprint || c.resultDigest !== result.resultDigest || c.publicationFingerprint !== result.publicationFingerprint ||
      c.candidateBinding !== result.candidateBinding || c.targetSetDigest !== result.targetSetDigest ||
      c.executionConsentDigest !== result.execution.consentDigest || c.executionResultDigest !== result.execution.resultDigest ||
      c.expiresAt !== result.reviewExpiresAt || completionTime(c.approvedAt) < completionTime(result.reviewCreatedAt) ||
      c.scopes.publishLocalRecords !== true || Object.entries(c.scopes).some(([key, value]) => key !== 'publishLocalRecords' && value !== false)) {
    localInputFailure('Revalidation needs separate exact-byte publication consent without other permissions.');
  }
  lifetime(c.approvedAt, c.expiresAt, now);
  return c;
}
export function validateRevalidationState(input: LocalRevalidationState, result: LocalRevalidationResult): LocalRevalidationState {
  const s = completionRecord(input, ['kind', 'schemaVersion', 'projectRoot', 'operationId', 'intentFingerprint', 'publicationFingerprint',
    'candidateBinding', 'ownerTokenDigest', 'phase', 'startedAt', 'updatedAt', 'transactionDigest', 'commitObservation', 'readbackDigest', 'cleanupPending'],
  'Revalidation progress');
  if (s.kind !== 'liftoff-local-revalidation-state' || s.schemaVersion !== 1 || s.projectRoot !== result.projectRoot || s.operationId !== result.operationId ||
      s.intentFingerprint !== result.fingerprint || s.publicationFingerprint !== result.publicationFingerprint || s.candidateBinding !== result.candidateBinding ||
      !['publishing', 'committed-readback-pending', 'complete', 'incomplete', 'rolled-back', 'blocked'].includes(s.phase) ||
      typeof s.cleanupPending !== 'boolean' || completionTime(s.startedAt) < completionTime(result.reviewCreatedAt) ||
      completionTime(s.updatedAt) < completionTime(s.startedAt)) localInputFailure('Revalidation progress attribution or chronology differs.');
  completionHash(s.ownerTokenDigest);
  if (s.transactionDigest !== null) completionHash(s.transactionDigest);
  if (s.readbackDigest !== null) completionHash(s.readbackDigest);
  if (s.commitObservation !== null) {
    const c = s.commitObservation;
    exactRecord(c, ['publicationFingerprint', 'transactionDigest', 'observedAt', 'source', 'committed'], 'Revalidation commit observation');
    if (c.publicationFingerprint !== result.publicationFingerprint || c.transactionDigest !== s.transactionDigest || c.transactionDigest === null ||
        c.source !== 'local-verification-inspector' || c.committed !== true || completionTime(c.observedAt) < completionTime(s.startedAt) ||
        completionTime(c.observedAt) > completionTime(s.updatedAt)) localInputFailure('Revalidation has no attributed actual commit observation.');
  }
  const committed = ['committed-readback-pending', 'complete', 'incomplete'].includes(s.phase);
  if (committed !== (s.commitObservation !== null) || (s.cleanupPending && !committed) ||
      (s.readbackDigest !== null && !['complete', 'incomplete'].includes(s.phase)) ||
      (['complete', 'incomplete'].includes(s.phase) && (!s.readbackDigest || s.cleanupPending)) ||
      (s.phase === 'complete' && result.phases.some(phase => phase.status !== 'complete')) ||
      (s.phase === 'incomplete' && result.phases.every(phase => phase.status === 'complete'))) localInputFailure('Revalidation progress misrepresents commit or current completeness.');
  return copyModernLocalData(s);
}
