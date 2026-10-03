import { historicalV3PlanAuthority, assertHistoricalV3PlanReferences, assertHistoricalV3StateReferences } from '../src/governance-activation/historical-state.js';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { historyArray, historyRecord, rawHistoryDigest, validateFrozenV3SourceIndex, type HistoricalFileKind } from '../src/governance-activation/history-contracts.js';
import { validateCapturedV3SourceSnapshot } from '../src/governance-activation/historical-state.js';
import {
  historicalV3PhaseGraph, historicalV3PhaseContractDigest, historicalV3EvidenceBodyDigest,
  historicalV3ApprovalEnvelopeHash, validateHistoricalV3ActivationState, validateHistoricalV3SavedTransitionPlan,
  validateHistoricalV3ApprovalEnvelope, validateHistoricalV3EvidenceRecord,
  type HistoricalV3SavedTransitionPlan, type HistoricalV3EvidenceRecord,
  type HistoricalV3ApprovalEnvelope
} from '../src/governance-activation/historical-v3.js';
import type { ReleasedV3PhaseId as PhaseId } from '../src/domain/governance/activation/record-contracts.js';
import { capturedV3Records } from './fixtures/activation-v3/fixture.js';
import { releasedV3ActivationIdentity } from '../src/domain/governance/policy/identity.js';
import { releasedV3RecordValidators } from '../src/domain/governance/activation/record-validation.js';

const timestamp = '2026-09-01T00:00:00.000Z';
const first = (key: string) => historyArray(capturedV3Records()[key], key)[0];
function state() {
  const value = validateHistoricalV3ActivationState(capturedV3Records().state);
  value.activeChange = null;
  delete value.bootstrapState; delete value.phaseOutputs; delete value.successorHistory; delete value.taskProjection;
  for (const key of Object.keys(value.phases) as PhaseId[]) value.phases[key] = {
    state: 'pending', updatedAt: timestamp, evidence: [], approvals: [], blockers: []
  };
  return value;
}
function bindPlan(value: HistoricalV3SavedTransitionPlan) {
  const authority = historicalV3PlanAuthority(value).digest;
  value.planDigest = canonicalSha256({ phaseId: value.phaseId, transitionDigest: value.transitionDigest,
    approvalPlanDigest: authority, operations: value.operations });
  return value;
}
function plan(id: PhaseId = 'seed-valid'): HistoricalV3SavedTransitionPlan {
  const value = validateHistoricalV3SavedTransitionPlan(first('plans'));
  const node = historicalV3PhaseGraph().phases.find(node => node.id === id)!;
  value.phaseId = id;
  value.scope = id.startsWith('seed-') ? 'local' : id === 'bootstrap-state-disposed' ? 'lifecycle' : 'activation';
  value.operations = []; value.fileChanges = []; value.recovery = false; delete value.approvalBundle; delete value.configuration;
  value.rollbackPlan = { phaseId: id, strategy: node.rollback.kind, target: node.rollback.target, operations: [], retained: [], cleanupWarnings: [] };
  const required = node.approvalGate.kind !== 'none';
  value.approval = {
    gateKind: node.approvalGate.kind, required, envelopeId: null, envelopeHash: null,
    evaluation: { phaseId: id, gateKind: node.approvalGate.kind, approvalRequired: required,
      questionKind: null, status: required ? 'approval-required' : 'not-required',
      envelopeId: null, envelopeHash: null, reasons: [], expansionReasons: [] }
  };
  return bindPlan(value);
}
function evidence(value: HistoricalV3SavedTransitionPlan, id = value.phaseId): HistoricalV3EvidenceRecord {
  const base = validateHistoricalV3EvidenceRecord(first('evidence'));
  const header = { ...base.header, phaseId: id, scope: value.scope, repositoryId: state().repository.id,
    phaseContractDigest: historicalV3PhaseContractDigest(id), baselineSha: value.baselineDigest, inputDigest: value.inputDigest,
    producer: 'synthetic-retained-proof', transition: { phaseId: id, baselineSha: value.baselineDigest,
      inputDigest: value.inputDigest, transitionDigest: value.transitionDigest } };
  delete header.inputBindings;
  const payload = { kind: `${id}.v1`, planDigest: value.planDigest, savedPlanDigest: canonicalSha256(value),
    ...(['committed', 'pushed'].includes(id) ? { head: 'a'.repeat(40) } : {}) };
  header.bodyDigest = historicalV3EvidenceBodyDigest(payload);
  return { evidenceId: `proof-${id}`, header, payload };
}
function approve(value: HistoricalV3SavedTransitionPlan): HistoricalV3ApprovalEnvelope {
  const base = validateHistoricalV3ApprovalEnvelope(first('approvals')), authority = historicalV3PlanAuthority(value);
  base.phaseId = value.phaseId; base.scope = value.scope; base.gateKind = value.approval.gateKind;
  base.baselineSha = value.baselineDigest; base.planDigest = authority.digest;
  base.coveredPhases = [value.phaseId, ...(value.approvalBundle ?? []).map(entry => entry.phaseId)];
  base.operationDigests = [...new Set([value.operations, ...(value.approvalBundle ?? []).map(entry => entry.operations)]
    .flat().filter(op => !['governance.evidence.write', 'governance.activation-state.write'].includes(op.actionId)).map(op => canonicalSha256(op)))];
  delete base.phasePlanDigests;
  if (value.approvalBundle?.length) base.phasePlanDigests = authority.phasePlanDigests;
  const hash = historicalV3ApprovalEnvelopeHash(base);
  value.approval.envelopeId = base.id; value.approval.envelopeHash = hash;
  value.approval.evaluation = { ...value.approval.evaluation, status: 'reused', envelopeId: base.id, envelopeHash: hash };
  return base;
}
interface Source { kind: HistoricalFileKind; parts: string[]; value: unknown }
async function inspect(
  value = state(), plans: HistoricalV3SavedTransitionPlan[] = [], proofs: HistoricalV3EvidenceRecord[] = [],
  approvals: HistoricalV3ApprovalEnvelope[] = [], extra: Source[] = []
) {
  const inputs: Source[] = [
    { kind: 'manifest', parts: ['liftoff.manifest.json'], value: capturedV3Records().manifest },
    { kind: 'state', parts: ['governance', 'activation-state.json'], value },
    ...plans.map((value, index): Source => ({ kind: 'plan', parts: ['governance', 'plans', `plan-${index}.json`], value })),
    ...proofs.map((value, index): Source => ({ kind: 'evidence', parts: ['governance', 'evidence', `proof-${index}.json`], value })),
    ...approvals.map((value, index): Source => ({ kind: 'approval', parts: ['governance', 'approvals', `approval-${index}.json`], value })),
    ...extra
  ];
  const originals = inputs.map(input => {
    const bytes = typeof input.value === 'string' ? Buffer.from(input.value) : Buffer.from(JSON.stringify(input.value) + '\r\n');
    return { ...input, bytes, digest: rawHistoryDigest(bytes), mode: 0o640 };
  });
  const files = originals.map(file => ({ kind: file.kind, originalPathParts: file.parts, digest: file.digest, mode: file.mode }))
    .sort((a, b) => a.originalPathParts.join('/') < b.originalPathParts.join('/') ? -1 : 1);
  const snapshotId = canonicalSha256({ schemaVersion: 1, sourceIdentity: releasedV3ActivationIdentity, files });
  const index = validateFrozenV3SourceIndex({ schemaVersion: 1, snapshotId, sourceIdentity: releasedV3ActivationIdentity,
    files: files.map(file => ({ ...file, copyPathParts: ['governance', 'history', snapshotId, 'files', ...file.originalPathParts] })) });
  return validateCapturedV3SourceSnapshot(index, index.files.map(file => ({
    pathParts: file.copyPathParts, mode: 0o600, content: originals.find(input => input.parts.join('/') === file.originalPathParts.join('/'))!.bytes
  })));
}
function reference(source: ReturnType<typeof state>, proof: HistoricalV3EvidenceRecord) {
  source.phases[proof.header.phaseId].evidence = [{
    evidenceId: proof.evidenceId, phaseId: proof.header.phaseId, result: proof.header.result, headerDigest: canonicalSha256(proof.header)
  }];
}

describe('explicit stored reference integrity without current freshness', () => {
  it.each(historicalV3PhaseGraph().phases.map(node => node.id))('resolves exact semantic and whole-record plan domains for %s', async id => {
    const source = state(), reviewed = plan(id);
    const proof = evidence(reviewed);
    // Some phases permit only a specialized result; this tests declared plan links independently of readiness.
    const allowed = historicalV3PhaseGraph().phases.find(node => node.id === id)!.terminalStates;
    const result = allowed.find(result => result === 'failed') ?? allowed.find(result => result !== 'approved');
    if (!result) throw new Error('The frozen phase must expose a recorded nonapproval outcome.');
    proof.header.result = result;
    proof.header.bodyDigest = historicalV3EvidenceBodyDigest(proof.payload);
    reference(source, proof);
    expect((await inspect(source, [reviewed], [proof])).state.phases[id].evidence).toHaveLength(1);
  });

  it.each(['missing-plan', 'saved-record', 'semantic', 'header', 'body', 'approval', 'evaluation'] as const)(
    'rejects explicit %s inconsistency', async corruption => {
      const source = state(), reviewed = plan('committed'), consent = approve(reviewed), proof = evidence(reviewed);
      reference(source, proof);
      if (corruption === 'saved-record') reviewed.createdAt = '2026-08-01T00:00:00.000Z';
      if (corruption === 'semantic') reviewed.planDigest = 'f'.repeat(64);
      if (corruption === 'header') source.phases.committed.evidence[0].headerDigest = 'f'.repeat(64);
      if (corruption === 'body') proof.payload = { kind: 'altered' };
      if (corruption === 'approval') consent.approver = 'different';
      if (corruption === 'evaluation') reviewed.approval.evaluation.envelopeHash = 'e'.repeat(64);
      await expect(inspect(source, corruption === 'missing-plan' ? [] : [reviewed], [proof], [consent])).rejects.toThrow();
    }
  );

  it('accepts distinct retained dispatch/recovery plans and original pre/post inputs', async () => {
    const source = state(), initial = plan(), recovery = plan();
    initial.fileChanges = [{ pathParts: ['README.md'], beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64) }];
    bindPlan(initial);
    recovery.recovery = true; recovery.createdAt = '2026-09-02T00:00:00.000Z'; bindPlan(recovery);
    source.phases['seed-valid'].executionPlanDigest = recovery.planDigest;
    source.phases['seed-valid'].operation = { provider: 'github', actionId: 'seed.validate', operationId: 'original',
      resourceId: 'original-resource', status: 'running', startedAt: timestamp, observedAt: timestamp, planDigest: initial.planDigest };
    const proof = evidence(initial);
    proof.header.inputDigest = 'd'.repeat(64);
    proof.header.inputBindings = { beforeDigest: initial.inputDigest, afterDigest: proof.header.inputDigest, files: initial.fileChanges };
    reference(source, proof);
    expect((await inspect(source, [initial, recovery], [proof])).state.phases['seed-valid'].executionPlanDigest).toBe(recovery.planDigest);
    await expect(inspect(source, [recovery], [proof])).rejects.toThrow(/plan/);
  });

  it('preserves rotated policy observations without requiring an unrecorded old policy preimage', async () => {
    const source = state(), reviewed = plan('credential-ready'), proof = evidence(reviewed);
    proof.payload = { ...historyRecord(proof.payload, 'payload'), policyDigest: 'a'.repeat(64) };
    proof.header.bodyDigest = historicalV3EvidenceBodyDigest(proof.payload); reference(source, proof);
    const policy = capturedV3Records().credential;
    expect(canonicalSha256(policy)).not.toBe('a'.repeat(64));
    const extra: Source[] = [{ kind: 'credential-policy', parts: ['governance', 'credentials', 'preflight-policy.json'], value: policy }];
    expect((await inspect(source, [reviewed], [proof], [], extra)).files.some(file => file.kind === 'credential-policy')).toBe(true);
    await expect(inspect(source, [], [proof], [], extra)).rejects.toThrow(/plan/);
    const altered = historyRecord(structuredClone(policy), 'policy'); altered.schemaVersion = 2; extra[0].value = altered;
    await expect(inspect(source, [reviewed], [proof], [], extra)).rejects.toThrow();
  });

  it('binds task audit to retained contract while preserving later mutable text observations', async () => {
    const source = state(), reviewed = plan('provider-ready');
    const contract = {
      schemaVersion: 1, derivation: 'validated-current-readiness', source: 'existing',
      changeId: 'recorded-change', workflowKind: 'openspec',
      taskPathParts: ['openspec', 'changes', 'recorded-change', 'tasks.md'],
      metadataPathParts: ['openspec', 'changes', 'recorded-change', 'liftoff-governance.json'],
      metadataHash: 'a'.repeat(64), layoutHash: 'b'.repeat(64)
    };
    reviewed.operations = [{ phaseId: reviewed.phaseId, actionId: 'governance.tasks.project', mutationClass: 'project-governance-tasks',
      adapter: 'local-evidence', remote: false, destructive: false, inputs: { projection: contract },
      destination: { type: 'local', identity: contract.taskPathParts.join('/'), pathParts: contract.taskPathParts } }];
    bindPlan(reviewed);
    const audit = releasedV3RecordValidators(historicalV3PhaseGraph()).validateGovernanceTaskProjectionRecord({
      schemaVersion: 1, purpose: 'projection-audit-only', phaseId: reviewed.phaseId, status: 'complete', observedAt: timestamp,
      planDigest: reviewed.planDigest, contractDigest: canonicalSha256(contract), metadataHash: contract.metadataHash,
      layoutHash: contract.layoutHash, taskPathParts: contract.taskPathParts,
      beforeHash: 'c'.repeat(64), afterHash: 'd'.repeat(64),
      states: Object.fromEntries(historicalV3PhaseGraph().phases.map(node => [node.id, 'pending'])), blockers: []
    });
    source.taskProjection = audit;
    expect((await inspect(source, [reviewed])).state.taskProjection?.afterHash).toBe('d'.repeat(64));
    audit.contractDigest = 'e'.repeat(64);
    await expect(inspect(source, [reviewed])).rejects.toThrow(/saved projection contract/);
  });

  it('validates a bundle authority and covered-secondary phase without translating it into a saved-plan hash', () => {
    const reviewed = plan('enforcement-approved');
    reviewed.approvalBundle = [{ phaseId: 'rulesets-applied', inputDigest: 'a'.repeat(64),
      transitionDigest: 'b'.repeat(64), operations: [], fileChanges: [] }];
    bindPlan(reviewed);
    const consent = approve(reviewed);
    expect(() => assertHistoricalV3PlanReferences(reviewed, consent)).not.toThrow();
    expect(consent.planDigest).not.toBe(reviewed.planDigest);
    const changed = { ...consent, phasePlanDigests: { ...consent.phasePlanDigests, 'rulesets-applied': 'f'.repeat(64) } };
    expect(() => assertHistoricalV3PlanReferences(reviewed, changed)).toThrow();
  });

  it('rejects forged output/resource bindings even if each record is structurally well formed', () => {
    const source = state(), reviewed = plan('provider-ready'), proof = evidence(reviewed);
    source.phaseOutputs = { 'provider-ready': { values: {}, resources: [{ provider: 'azure', resourceId: 'original-resource', resourceType: 'provider' }] } };
    proof.payload = { ...historyRecord(proof.payload, 'payload'), outputBindings: source.phaseOutputs['provider-ready'] };
    proof.header.bodyDigest = historicalV3EvidenceBodyDigest(proof.payload); reference(source, proof);
    expect(() => assertHistoricalV3StateReferences(source, [reviewed], [proof])).toThrow(/resource receipt/);
  });

  it('retains blocked-state outputs with one matching original receipt, not every old output', async () => {
    const source = state(), reviewed = plan('provider-ready'), proof = evidence(reviewed);
    const outputs = { values: { region: 'original' }, resources: [{ provider: 'azure' as const, resourceId: 'original-resource', resourceType: 'provider' }] };
    source.phaseOutputs = { 'provider-ready': outputs };
    source.phases['provider-ready'].state = 'blocked';
    proof.payload = { ...historyRecord(proof.payload, 'payload'), outputBindings: outputs };
    proof.liveReadback = [{
      schemaVersion: 3, repositoryId: proof.header.repositoryId, identity: releasedV3ActivationIdentity,
      phaseGraphHash: releasedV3ActivationIdentity.phaseGraphHash, phaseId: proof.header.phaseId,
      baselineSha: proof.header.baselineSha, inputDigest: proof.header.transition.inputDigest, transition: proof.header.transition,
      observedAt: timestamp, provider: 'azure', resourceType: 'provider', resourceId: 'original-resource',
      sourceDigest: 'a'.repeat(64), readbackDigest: 'b'.repeat(64), matches: true
    }];
    proof.header.bodyDigest = historicalV3EvidenceBodyDigest(proof.payload, proof.liveReadback); reference(source, proof);
    const older = evidence(reviewed);
    older.evidenceId = 'older-output';
    older.payload = { ...historyRecord(older.payload, 'payload'), outputBindings: { values: {}, resources: [] } };
    older.header.bodyDigest = historicalV3EvidenceBodyDigest(older.payload);
    expect((await inspect(source, [reviewed], [older, proof])).state.phaseOutputs).toEqual(source.phaseOutputs);
    proof.liveReadback = [{ ...proof.liveReadback[0], matches: false }];
    proof.header.bodyDigest = historicalV3EvidenceBodyDigest(proof.payload, proof.liveReadback); reference(source, proof);
    await expect(inspect(source, [reviewed], [proof])).rejects.toThrow(/resource receipt/);
  });

  it('preserves original retained/disposed proof links and due times without current-clock evaluation', async () => {
    const source = state(), importedPlan = plan('remote-import-verified'), deletionPlan = plan('bootstrap-state-disposed');
    const imported = evidence(importedPlan), deletion = evidence(deletionPlan);
    deletion.header.result = 'disposed';
    reference(source, imported); reference(source, deletion);
    source.applicability.statePath = 'bootstrap-local';
    source.bootstrapState = {
      status: 'disposed', remoteImportEvidenceId: imported.evidenceId, remoteImportEvidenceDigest: canonicalSha256(imported.header),
      retainedAt: '2026-08-01T00:00:00.000Z', disposeAfter: '2026-08-31T00:00:00.000Z', disposedAt: timestamp,
      deletionEvidenceId: deletion.evidenceId, encryptedStatePathParts: [['protected', 'state.enc']], encryptionKeyPathParts: [['protected', 'key']]
    };
    expect((await inspect(source, [importedPlan, deletionPlan], [imported, deletion])).state.bootstrapState).toEqual(source.bootstrapState);
    await expect(inspect(source, [importedPlan, deletionPlan], [deletion])).rejects.toThrow(/evidence/);
  });

  it('requires explicit metadata evidence IDs but not a fabricated full approved-facts preimage', async () => {
    const source = state(), metadata = historyRecord(capturedV3Records().metadata, 'metadata');
    source.activeChange = { id: String(metadata.changeId), kind: 'openspec' };
    historyRecord(metadata.createdFrom, 'createdFrom').evidenceIds = [];
    historyRecord(metadata.createdFrom, 'createdFrom').approvedFactDigest = 'f'.repeat(64);
    const extra: Source[] = [
      { kind: 'source-metadata', parts: ['openspec', 'changes', source.activeChange.id, 'liftoff-governance.json'], value: metadata },
      { kind: 'source-tasks', parts: ['openspec', 'changes', source.activeChange.id, 'tasks.md'], value: 'Later task text\r\n' }
    ];
    expect((await inspect(source, [], [], [], extra)).sourceChangeMetadata?.createdFrom.approvedFactDigest).toBe('f'.repeat(64));
    historyRecord(metadata.createdFrom, 'createdFrom').evidenceIds = ['missing-original'];
    await expect(inspect(source, [], [], [], extra)).rejects.toThrow(/phase-0 evidence/);
  });

  it('compares declared reconciliation digests with the real frozen graph', async () => {
    const value = historyRecord(capturedV3Records().reconciliation, 'reconciliation');
    const extra: Source[] = [{ kind: 'reconciliation', parts: ['governance', 'reconciliation', 'original.json'], value }];
    expect((await inspect(state(), [], [], [], extra)).files.some(file => file.kind === 'reconciliation')).toBe(true);
    const mapping = historyRecord(historyArray(value.phaseMappings, 'mappings')[0], 'mapping');
    mapping.fromContractDigest = 'f'.repeat(64); mapping.toContractDigest = 'f'.repeat(64);
    await expect(inspect(state(), [], [], [], extra)).rejects.toThrow(/recognized source graph/);
  });
});
