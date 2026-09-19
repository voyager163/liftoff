import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolvePackageFile } from '../adapters/packaged-assets/package-root.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import {
  historicalV4Policy7ActivationIdentity, isHistoricalV4Policy7ActivationIdentity,
  type HistoricalV4Policy7ActivationIdentity
} from '../domain/governance/policy/identity.js';
import type {
  ApprovalEnvelope, ManagedPhaseGraph, PhaseEvidenceRecord, SavedTransitionPlan, UserActivationState
} from '../domain/governance/activation/types.js';
import {
  historyArray, historyExact, historyFail, historyPathParts, historyRecordId
} from './history-contracts.js';
import { assertSafeHistoricalRecord } from './historical-safety.js';

export type HistoricalV4Policy7ActivationState = Omit<UserActivationState, 'identity' | 'schemaVersion'> & {
  schemaVersion: 4;
  identity: HistoricalV4Policy7ActivationIdentity;
};
export type HistoricalV4Policy7ApprovalEnvelope = ApprovalEnvelope & { schemaVersion: 4; identity: HistoricalV4Policy7ActivationIdentity };
export type HistoricalV4Policy7SavedTransitionPlan = SavedTransitionPlan & { identity: HistoricalV4Policy7ActivationIdentity };
export type HistoricalV4Policy7EvidenceRecord = PhaseEvidenceRecord & {
  header: PhaseEvidenceRecord['header'] & { schemaVersion: 4; identity: HistoricalV4Policy7ActivationIdentity };
};

interface FrozenReaders {
  validators: Pick<typeof import('../domain/governance/activation/validators.js'),
    'validateUserActivationState' | 'validateEvidenceHeader' | 'validateLiveReadbackProof' |
    'validateApprovalEnvelope' | 'validateSavedTransitionPlan' | 'validateSupersessionRecord' |
    'validateGraphReconciliationRecord' | 'validateCredentialPolicy'>;
  approvals: Pick<typeof import('../domain/governance/activation/approvals.js'),
    'canonicalApprovalEnvelopeHash' | 'savedPlanAuthorityDigest'>;
  operations: Pick<typeof import('../domain/governance/activation/operations.js'), 'assertPlanOperationsAllowed'>;
}

const root = ['assets', 'governance', 'single-maintainer-gitflow', 'activation-v4-policy7-reader'] as const;
const indexDigest = 'cfc2a231b8977155fe67d7d70fae0edd51aee44fb49355d3c212746bc147c75d';
let frozen: FrozenReaders | undefined;

function readers(): FrozenReaders {
  if (frozen) return frozen;
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const bytes = readFileSync(resolvePackageFile(...root, 'index.json'));
  if (digest(bytes) !== indexDigest) historyFail('policy-7 reader', 'immutable candidate index differs.', 'invalid-packaged-history');
  const index = JSON.parse(bytes.toString('utf8')) as { files: Array<{ path: string; digest: string }> };
  for (const file of index.files) {
    const parts = historyPathParts(file.path.split('/'), 'policy-7 reader module');
    if (digest(readFileSync(resolvePackageFile(...root, ...parts))) !== file.digest) {
      historyFail('policy-7 reader', 'immutable candidate algorithm differs.', 'invalid-packaged-history');
    }
  }
  const require = createRequire(import.meta.url);
  const load = (name: string) => require(resolvePackageFile(...root, 'domain', 'governance', 'activation', `${name}.js`));
  frozen = { validators: load('validators'), approvals: load('approvals'), operations: load('operations') };
  return frozen;
}

export function historicalV4Policy7PhaseGraph(): ManagedPhaseGraph {
  const graph: ManagedPhaseGraph = JSON.parse(readFileSync(resolvePackageFile(
    'assets', 'governance', 'single-maintainer-gitflow', 'activation-v4-policy7-graph.json'
  ), 'utf8'));
  if (canonicalSha256(graph) !== historicalV4Policy7ActivationIdentity.phaseGraphHash) {
    historyFail('policy-7 graph', 'does not match the exact pre-amendment candidate.', 'invalid-packaged-history');
  }
  return graph;
}

function validated<T>(value: unknown, label: string, read: (value: unknown) => T): T {
  assertSafeHistoricalRecord(value, label);
  try { return read(value); }
  catch (error) { historyFail(label, error instanceof Error ? error.message : 'Invalid pre-amendment record.'); }
}

export function validateHistoricalV4Policy7ActivationState(value: unknown): HistoricalV4Policy7ActivationState {
  const state = validated(value, 'policy7.state', readers().validators.validateUserActivationState);
  if (!isHistoricalV4Policy7ActivationIdentity(state.identity) || state.schemaVersion !== 4) historyFail('policy7.state', 'requires the exact original identity.');
  for (const phase of historicalV4Policy7PhaseGraph().phases) {
    const status = state.phases[phase.id].state;
    if (['approved', 'verified', 'failed', 'inapplicable', 'retained', 'disposed'].includes(status) &&
        !phase.terminalStates.some((allowed) => allowed === status)) {
      historyFail('policy7.state', 'terminal state is not allowed by the original phase.');
    }
  }
  return { ...state, schemaVersion: state.schemaVersion, identity: state.identity };
}

export function validateHistoricalV4Policy7ApprovalEnvelope(value: unknown): HistoricalV4Policy7ApprovalEnvelope {
  const envelope = validated(value, 'policy7.approval', readers().validators.validateApprovalEnvelope);
  if (!isHistoricalV4Policy7ActivationIdentity(envelope.identity) || envelope.schemaVersion !== 4) historyFail('policy7.approval', 'requires the exact original identity.');
  return { ...envelope, schemaVersion: envelope.schemaVersion, identity: envelope.identity };
}

export function historicalV4Policy7ApprovalEnvelopeHash(value: HistoricalV4Policy7ApprovalEnvelope): string {
  return readers().approvals.canonicalApprovalEnvelopeHash(validateHistoricalV4Policy7ApprovalEnvelope(value));
}

export function validateHistoricalV4Policy7SavedTransitionPlan(value: unknown): HistoricalV4Policy7SavedTransitionPlan {
  const plan = validated(value, 'policy7.plan', readers().validators.validateSavedTransitionPlan);
  if (!isHistoricalV4Policy7ActivationIdentity(plan.identity)) historyFail('policy7.plan', 'requires the exact original identity.');
  const phase = historicalV4Policy7PhaseGraph().phases.find((node) => node.id === plan.phaseId);
  if (!phase) historyFail('policy7.plan', 'phase is absent from the original graph.');
  validated(plan, 'policy7.plan', () => readers().operations.assertPlanOperationsAllowed(plan, phase));
  const approvalPlanDigest = readers().approvals.savedPlanAuthorityDigest(plan, phase);
  if (canonicalSha256(plan.mutationClasses) !== canonicalSha256(phase.allowedMutations) ||
      plan.planDigest !== canonicalSha256({
        phaseId: plan.phaseId, transitionDigest: plan.transitionDigest, approvalPlanDigest, operations: plan.operations
      })) {
    historyFail('policy7.plan', 'original operation and authority digests do not match.', 'invalid-historical-reference');
  }
  return { ...plan, identity: plan.identity };
}

export function validateHistoricalV4Policy7EvidenceRecord(value: unknown): HistoricalV4Policy7EvidenceRecord {
  assertSafeHistoricalRecord(value, 'policy7.evidence');
  const record = historyExact(value, ['evidenceId', 'header'], 'policy7.evidence', ['payload', 'liveReadback']);
  const header = validated(record.header, 'policy7.evidence.header', readers().validators.validateEvidenceHeader);
  if (!isHistoricalV4Policy7ActivationIdentity(header.identity) || header.schemaVersion !== 4) historyFail('policy7.evidence', 'requires the exact original identity.');
  const phase = historicalV4Policy7PhaseGraph().phases.find((node) => node.id === header.phaseId);
  if (!phase) historyFail('policy7.evidence', 'phase is absent from the original graph.');
  const { label: _label, ...behavior } = phase;
  if (header.phaseContractDigest !== canonicalSha256(behavior) ||
      !phase.terminalStates.some((result) => result === header.result)) {
    historyFail('policy7.evidence', 'phase contract or terminal result differs from the original graph.');
  }
  const liveReadback = record.liveReadback === undefined ? undefined :
    historyArray(record.liveReadback, 'policy7.evidence.liveReadback')
      .map((proof) => validated(proof, 'policy7.evidence.readback', readers().validators.validateLiveReadbackProof));
  const normalized = [...(liveReadback ?? [])].sort((left, right) => canonicalSha256(left).localeCompare(canonicalSha256(right), 'en'));
  if (header.bodyDigest !== canonicalSha256({ payload: record.payload ?? null, liveReadback: normalized }) ||
      liveReadback?.some((proof) => proof.repositoryId !== header.repositoryId || proof.phaseId !== header.phaseId ||
        canonicalSha256(proof.transition) !== canonicalSha256(header.transition))) {
    historyFail('policy7.evidence', 'original body or readback linkage is inconsistent.', 'invalid-historical-reference');
  }
  return {
    evidenceId: historyRecordId(record.evidenceId, 'policy7.evidenceId'),
    header: { ...header, schemaVersion: header.schemaVersion, identity: header.identity },
    ...(record.payload === undefined ? {} : { payload: record.payload }),
    ...(liveReadback === undefined ? {} : { liveReadback })
  };
}

export function validateHistoricalV4Policy7AuxiliaryRecord(
  value: unknown, kind: 'supersession' | 'reconciliation' | 'credential-policy'
): void {
  const read = kind === 'supersession' ? readers().validators.validateSupersessionRecord :
    kind === 'reconciliation' ? readers().validators.validateGraphReconciliationRecord : readers().validators.validateCredentialPolicy;
  validated<unknown>(value, `policy7.${kind}`, read);
}
