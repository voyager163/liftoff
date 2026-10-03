import { readFileSync } from 'node:fs';
import { resolvePackageFile } from '../adapters/packaged-assets/package-root.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { releasedV3RecordValidators } from '../domain/governance/activation/record-validation.js';
import { releasedV3ActivationIdentity, type ReleasedV3ActivationIdentity } from '../domain/governance/policy/identity.js';
import type * as Records from '../domain/governance/activation/record-contracts.js';
import {
  normalizeApprovalScopeValues, canonicalApprovalEnvelopeValues, assertGraphMappingDigests
} from '../domain/governance/activation/source-values.js';
import {
  historyArray, historyExact, historyFail, historyRecordId
} from './history-contracts.js';
import { assertSafeHistoricalRecord } from './historical-safety.js';

type PhaseId = Records.ReleasedV3PhaseId;
export type HistoricalV3PhaseGraph = Records.BoundPhaseGraphFieldsV2<ReleasedV3ActivationIdentity, PhaseId>;
export type HistoricalV3ActivationState = Records.UserActivationStateFieldsV3<ReleasedV3ActivationIdentity, PhaseId>;
export type HistoricalV3EvidenceHeader = Records.EvidenceHeaderFieldsV3<ReleasedV3ActivationIdentity, PhaseId>;
export type HistoricalV3LiveReadbackProof = Records.LiveReadbackProofFieldsV3<ReleasedV3ActivationIdentity, PhaseId>;
export type HistoricalV3ApprovalEnvelope = Records.ApprovalEnvelopeFieldsV3<ReleasedV3ActivationIdentity, PhaseId>;
export type HistoricalV3SavedTransitionPlan = Records.SavedTransitionPlanFieldsV2<ReleasedV3ActivationIdentity, PhaseId>;
export type HistoricalV3CredentialPolicy = Records.CredentialPolicyFieldsV1<ReleasedV3ActivationIdentity>;
export type HistoricalV3EvidenceRecord = Records.PhaseEvidenceRecordFieldsV3<ReleasedV3ActivationIdentity, PhaseId>;
export type HistoricalV3SupersessionRecord = Records.SupersessionRecordFieldsV1<ReleasedV3ActivationIdentity>;
export type HistoricalV3ReconciliationRecord = Records.GraphReconciliationRecordFieldsV3<ReleasedV3ActivationIdentity, PhaseId>;

function isFrozenGraph(value: unknown): value is HistoricalV3PhaseGraph {
  return canonicalSha256(value) === releasedV3ActivationIdentity.phaseGraphHash;
}

let frozenGraph: HistoricalV3PhaseGraph | undefined;
export function historicalV3PhaseGraph(): HistoricalV3PhaseGraph {
  if (!frozenGraph) {
    const value: unknown = JSON.parse(readFileSync(resolvePackageFile(
      'assets', 'governance', 'single-maintainer-gitflow', 'activation-v3-graph.json'
    ), 'utf8'));
    if (!isFrozenGraph(value)) historyFail('packaged activation-v3-graph.json', 'does not match the released v3 graph.', 'invalid-packaged-history');
    frozenGraph = value;
  }
  return structuredClone(frozenGraph);
}

let readers: ReturnType<typeof releasedV3RecordValidators> | undefined;
function records() {
  return readers ??= releasedV3RecordValidators(historicalV3PhaseGraph());
}

function read<T>(value: unknown, label: string, validate: (value: unknown) => T): T {
  assertSafeHistoricalRecord(value, label);
  try { return validate(value); }
  catch (error) {
    if (!(error instanceof Error) || error.name !== 'Error') throw error;
    return historyFail(label, error.message);
  }
}

export function historicalV3PhaseContractDigest(phaseId: PhaseId): string {
  const node = historicalV3PhaseGraph().phases.find(phase => phase.id === phaseId);
  if (!node) historyFail('historicalV3.phaseId', 'does not name a released phase.');
  const { label: _label, ...behavior } = node;
  return canonicalSha256(behavior);
}

export function validateHistoricalV3ActivationState(value: unknown): HistoricalV3ActivationState {
  return read(value, 'historicalV3ActivationState', records().validateUserActivationState);
}

export function validateHistoricalV3EvidenceHeader(value: unknown): HistoricalV3EvidenceHeader {
  const header = read(value, 'historicalV3EvidenceHeader', records().validateEvidenceHeader);
  const node = historicalV3PhaseGraph().phases.find(phase => phase.id === header.phaseId)!;
  if (header.phaseContractDigest !== historicalV3PhaseContractDigest(header.phaseId) ||
    !node.terminalStates.includes(header.result)) {
    historyFail('historicalV3EvidenceHeader', 'phase digest or terminal result contradicts the released graph.');
  }
  return header;
}

export function validateHistoricalV3LiveReadback(value: unknown): HistoricalV3LiveReadbackProof {
  return read(value, 'historicalV3LiveReadback', records().validateLiveReadbackProof);
}

export function historicalV3EvidenceBodyDigest(payload: unknown, liveReadback: readonly HistoricalV3LiveReadbackProof[] = []): string {
  const normalized = [...liveReadback].map(validateHistoricalV3LiveReadback).sort((left, right) =>
    canonicalSha256(left).localeCompare(canonicalSha256(right), 'en'));
  return canonicalSha256({ payload: payload ?? null, liveReadback: normalized });
}

export function validateHistoricalV3EvidenceRecord(value: unknown): HistoricalV3EvidenceRecord {
  const label = 'historicalV3EvidenceRecord';
  assertSafeHistoricalRecord(value, label);
  const raw = historyExact(value, ['evidenceId', 'header'], label, ['payload', 'liveReadback']);
  const header = validateHistoricalV3EvidenceHeader(raw.header);
  const liveReadback = raw.liveReadback === undefined ? undefined :
    historyArray(raw.liveReadback, `${label}.liveReadback`).map(validateHistoricalV3LiveReadback);
  for (const proof of liveReadback ?? []) {
    if (proof.repositoryId !== header.repositoryId || proof.phaseId !== header.phaseId ||
      proof.baselineSha !== header.baselineSha || proof.inputDigest !== header.transition.inputDigest ||
      canonicalSha256(proof.transition) !== canonicalSha256(header.transition)) {
      historyFail(label, 'readback contradicts its original reviewed transition.');
    }
  }
  if (header.bodyDigest !== historicalV3EvidenceBodyDigest(raw.payload, liveReadback)) {
    historyFail(label, 'body digest contradicts the original payload and readback.', 'history-digest-mismatch');
  }
  return {
    evidenceId: historyRecordId(raw.evidenceId, `${label}.evidenceId`), header,
    ...(Object.hasOwn(raw, 'payload') ? { payload: raw.payload } : {}),
    ...(liveReadback === undefined ? {} : { liveReadback })
  };
}

export function validateHistoricalV3ApprovalEnvelope(value: unknown): HistoricalV3ApprovalEnvelope {
  return read(value, 'historicalV3ApprovalEnvelope', records().validateApprovalEnvelope);
}

export function validateHistoricalV3SavedTransitionPlan(value: unknown): HistoricalV3SavedTransitionPlan {
  return read(value, 'historicalV3TransitionPlan', records().validateSavedTransitionPlan);
}

export function validateHistoricalV3CredentialPolicy(value: unknown): HistoricalV3CredentialPolicy {
  return read(value, 'historicalV3CredentialPolicy', records().validateCredentialPolicy);
}

export function validateHistoricalV3AuxiliaryRecord(value: unknown, kind: 'supersession' | 'reconciliation' | 'credential-policy'): void {
  if (kind === 'credential-policy') validateHistoricalV3CredentialPolicy(value);
  else if (kind === 'supersession') read(value, 'historicalV3Supersession', records().validateSupersessionRecord);
  else read(value, 'historicalV3Reconciliation', records().validateGraphReconciliationRecord);
}

export function historicalV3ApprovalEnvelopeHash(envelope: HistoricalV3ApprovalEnvelope): string {
  const normalized = normalizeApprovalScopeValues(envelope, historicalV3PhaseGraph().phases.map(phase => phase.id));
  return canonicalSha256(canonicalApprovalEnvelopeValues(envelope, normalized));
}

export function assertHistoricalV3Reconciliation(value: unknown): void {
  const record = read(value, 'historicalV3Reconciliation', records().validateGraphReconciliationRecord);
  const graph = historicalV3PhaseGraph();
  if (record.fromGraphHash !== canonicalSha256(graph) || record.toGraphHash !== canonicalSha256(graph)) {
    historyFail('historical reconciliation', 'requires its declared original graph preimages.', 'unsupported-historical-graph');
  }
  const digests = Object.fromEntries(graph.phases.map(node => [node.id, historicalV3PhaseContractDigest(node.id)]));
  assertGraphMappingDigests(record.phaseMappings, digests, digests);
}
