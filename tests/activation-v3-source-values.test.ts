import { historicalV3PlanAuthority, historicalV3ProjectionContract } from '../src/governance-activation/historical-state.js';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  currentActivationRecordValidators, currentTaskProjectionContract, releasedV3TaskProjectionContract
} from '../src/domain/governance/activation/record-validation.js';
import * as Current from '../src/domain/governance/activation/types.js';
import {
  canonicalApprovalEnvelopeHash, canonicalApprovalEnvelopeScope, savedPlanAuthorityDigest,
  normalizeApprovalScope, authorityOperations, transitionAuthorityDigest
} from '../src/domain/governance/activation/approvals.js';
import { taskProjectionContract, planDigestFor } from '../src/domain/governance/activation/operations.js';
import { validateGovernanceTaskProjectionContract } from '../src/domain/governance/activation/validators.js';
import { governanceTaskLayoutHash } from '../src/governance-activation/task-projection.js';
import {
  historicalV3PhaseGraph, historicalV3ApprovalEnvelopeHash,
  validateHistoricalV3ApprovalEnvelope, validateHistoricalV3SavedTransitionPlan
} from '../src/governance-activation/historical-v3.js';
import { canonicalSha256, sha256Hex } from '../src/domain/governance/activation/canonical-json.js';
import { historyArray, historyRecord } from '../src/governance-activation/history-contracts.js';
import { capturedV3Records } from './fixtures/activation-v3/fixture.js';
import type { TaskProjectionSourceFieldsV1 } from '../src/domain/governance/activation/record-contracts.js';
import { releasedV3ActivationIdentity, type CurrentActivationIdentity } from '../src/domain/governance/policy/identity.js';

afterEach(() => vi.restoreAllMocks());
const originalKeys = [
  'validateActivationIdentity', 'validateActivationConfiguration', 'validateGovernanceTaskProjectionRecord',
  'validateUserActivationState', 'validateEvidenceHeader', 'validateLiveReadbackProof', 'validateApprovalEnvelope',
  'validateSavedTransitionPlan', 'validateSupersessionRecord', 'validateGraphReconciliationRecord', 'validateCredentialPolicy',
  'stringArray', 'exact', 'enumValue', 'stringField', 'record', 'requireVersion', 'booleanField', 'exactStringSet', 'safePathParts', 'hexDigest', 'publicJson'
];
const contract = (): TaskProjectionSourceFieldsV1 => ({
  schemaVersion: 1, derivation: 'validated-current-readiness', source: 'existing', changeId: 'original-change',
  workflowKind: 'openspec', taskPathParts: ['openspec', 'changes', 'original-change', 'tasks.md'],
  metadataPathParts: ['openspec', 'changes', 'original-change', 'liftoff-governance.json'],
  metadataHash: 'a'.repeat(64), layoutHash: 'b'.repeat(64)
});
const approval = () => validateHistoricalV3ApprovalEnvelope(historyArray(capturedV3Records().approvals, 'approvals')[0]);
const plan = () => validateHistoricalV3SavedTransitionPlan(historyArray(capturedV3Records().plans, 'plans')[0]);

describe('current facade and pure extraction parity', () => {
  it('retains every original factory key, own order, runtime arity and exact current record return', () => {
    const facade = currentActivationRecordValidators();
    expect(Object.keys(facade)).toEqual(originalKeys);
    expectTypeOf<ReturnType<typeof facade.validateActivationIdentity>>().toEqualTypeOf<CurrentActivationIdentity>();
    expectTypeOf<ReturnType<typeof facade.validateActivationConfiguration>>().toEqualTypeOf<Current.ActivationConfiguration>();
    expectTypeOf<ReturnType<typeof facade.validateUserActivationState>>().toEqualTypeOf<Current.UserActivationState>();
    expectTypeOf<ReturnType<typeof facade.validateGovernanceTaskProjectionRecord>>().toEqualTypeOf<Current.GovernanceTaskProjectionRecord>();
    expectTypeOf<ReturnType<typeof facade.validateEvidenceHeader>>().toEqualTypeOf<Current.EvidenceHeader>();
    expectTypeOf<ReturnType<typeof facade.validateLiveReadbackProof>>().toEqualTypeOf<Current.LiveReadbackProof>();
    expectTypeOf<ReturnType<typeof facade.validateApprovalEnvelope>>().toEqualTypeOf<Current.ApprovalEnvelope>();
    expectTypeOf<ReturnType<typeof facade.validateSavedTransitionPlan>>().toEqualTypeOf<Current.SavedTransitionPlan>();
    expectTypeOf<ReturnType<typeof facade.validateSupersessionRecord>>().toEqualTypeOf<Current.SupersessionRecord>();
    expectTypeOf<ReturnType<typeof facade.validateGraphReconciliationRecord>>().toEqualTypeOf<Current.GraphReconciliationRecord>();
    expectTypeOf<ReturnType<typeof facade.validateCredentialPolicy>>().toEqualTypeOf<Current.CredentialPolicy>();
    expectTypeOf<Parameters<typeof facade.validateGraphReconciliationRecord>>()
      .toEqualTypeOf<[value: unknown, recognizedGraphHashes?: ReadonlySet<string>]>();
    expect(facade.validateGraphReconciliationRecord.length).toBe(1);
    expect(facade.validateApprovalEnvelope.length).toBe(1);
    expect(facade.validateSavedTransitionPlan.length).toBe(1);
    expect(validateGovernanceTaskProjectionContract.length).toBe(1);
    expectTypeOf(validateGovernanceTaskProjectionContract(contract())).toEqualTypeOf<Current.GovernanceTaskProjectionContract>();
    const reconciliation = historyRecord(capturedV3Records().reconciliation, 'record');
    const hash = 'f'.repeat(64);
    reconciliation.fromGraphHash = hash;
    historyRecord(reconciliation.fromIdentity, 'identity').phaseGraphHash = hash;
    expect(facade.validateGraphReconciliationRecord(reconciliation, new Set([hash, releasedV3ActivationIdentity.phaseGraphHash])).fromGraphHash).toBe(hash);
  });

  it.each([false, true])('preserves v3 hash projection and later bundle-array sorting (bundle=%s)', bundle => {
    const value = approval();
    if (bundle) {
      value.phaseId = 'rulesets-applied'; value.gateKind = 'enforcement'; value.scope = 'activation';
      value.coveredPhases = ['rulesets-applied', 'enforcement-approved'];
      value.operationDigests = ['b'.repeat(64), 'a'.repeat(64)];
      value.phasePlanDigests = { 'enforcement-approved': 'c'.repeat(64), 'rulesets-applied': 'd'.repeat(64) };
    }
    value.approver = ' Original approver ';
    expect(historicalV3ApprovalEnvelopeHash(value)).toBe(canonicalApprovalEnvelopeHash(value));
    const decoded = validateHistoricalV3ApprovalEnvelope(value);
    expect(decoded.coveredPhases).toEqual(value.coveredPhases);
    const before = historicalV3ApprovalEnvelopeHash(value);
    if (bundle) {
      value.coveredPhases = [...value.coveredPhases!].reverse();
      value.operationDigests = [...value.operationDigests!].reverse();
      expect(historicalV3ApprovalEnvelopeHash(value)).toBe(before);
    }
    value.approvedAt = '2026-08-01T00:00:00.000Z';
    expect(historicalV3ApprovalEnvelopeHash(value)).not.toBe(before);
    expect(normalizeApprovalScope(value).phaseId).toBe(value.phaseId);
  });

  it('preserves normalization then expiresAt/approvedAt/approver failure order', () => {
    const value = approval(), calls: string[] = [];
    for (const name of ['expiresAt', 'approvedAt', 'approver'] as const) {
      const original = value[name];
      Object.defineProperty(value, name, { configurable: true, get() { calls.push(name); return original; } });
    }
    canonicalApprovalEnvelopeScope(value);
    expect(calls).toEqual(['expiresAt', 'approvedAt', 'approver']);
    const malformed = { ...approval(), baselineSha: 'invalid', expiresAt: 'invalid', approvedAt: 'invalid', approver: '' };
    expect(() => canonicalApprovalEnvelopeScope(malformed)).toThrow('approvalEnvelope.baselineSha must be a SHA-256 hex digest.');
    malformed.baselineSha = 'a'.repeat(64);
    expect(() => canonicalApprovalEnvelopeScope(malformed)).toThrow('approvalEnvelope.expiresAt must be a valid ISO timestamp.');
    malformed.expiresAt = '2026-09-01T00:00:00.000Z';
    expect(() => canonicalApprovalEnvelopeScope(malformed)).toThrow('approvalEnvelope.approvedAt must be a valid ISO timestamp.');
    malformed.approvedAt = '2026-08-01T00:00:00.000Z';
    expect(() => canonicalApprovalEnvelopeScope(malformed)).toThrow('approvalEnvelope.approver must be a non-empty string.');
  });

  it('uses separate saved-record, semantic-operation and authority hash domains', () => {
    const value = plan(), node = historicalV3PhaseGraph().phases.find(entry => entry.id === value.phaseId)!;
    const authority = historicalV3PlanAuthority(value);
    expect(authority.digest).toBe(savedPlanAuthorityDigest(value, node));
    const expectedAuthority = canonicalSha256({
      scope: value.scope, phaseId: value.phaseId, gateKind: node.approvalGate.kind,
      transitionDigest: value.transitionDigest, allowedMutations: node.allowedMutations,
      operations: value.operations.filter(operation => !['governance.evidence.write', 'governance.activation-state.write'].includes(operation.actionId)),
      configuration: value.configuration ?? null, fileChanges: value.fileChanges ?? [], recovery: value.recovery ?? false
    });
    expect(authority.primary).toBe(expectedAuthority);
    expect(transitionAuthorityDigest({ phase: node, transitionDigest: value.transitionDigest, operations: value.operations })).toBe(
      canonicalSha256({ scope: value.scope, phaseId: value.phaseId, gateKind: node.approvalGate.kind, transitionDigest: value.transitionDigest,
        allowedMutations: node.allowedMutations, operations: authorityOperations(value.operations), configuration: null, fileChanges: [], recovery: false }));
    const semantic = planDigestFor({ phase: node, transitionDigest: value.transitionDigest, operations: value.operations, approvalPlanDigest: authority.digest });
    expect(semantic).toBe(canonicalSha256({ phaseId: node.id, transitionDigest: value.transitionDigest, operations: value.operations, approvalPlanDigest: authority.digest }));
    expect(semantic).not.toBe(canonicalSha256(value));
  });
});

describe('closed shared projection decoder and retained layout', () => {
  it.each([
    { input: null, message: 'taskProjectionContract must be an object.' },
    { input: { source: 'future' }, message: 'taskProjectionContract.source' },
    { input: { ...contract(), source: 'existing', extra: true }, message: 'is not allowed' },
    { input: { ...contract(), schemaVersion: 2 }, message: 'schemaVersion' },
    { input: { ...contract(), derivation: 'unchecked' }, message: 'bounded current-readiness' },
    { input: { ...contract(), changeId: 'archive', taskPathParts: ['..'] }, message: 'seed tasks or an archive' },
    { input: { ...contract(), taskPathParts: ['elsewhere'], metadataHash: 'invalid' }, message: 'exact current governance' },
    { input: { ...contract(), metadataHash: 'invalid', layoutHash: 'invalid' }, message: 'metadataHash' }
  ])('preserves original decoder diagnostic order %#', ({ input, message }) => {
    const readers = [validateGovernanceTaskProjectionContract, currentTaskProjectionContract,
      (value: unknown) => releasedV3TaskProjectionContract(value, historicalV3PhaseGraph())];
    const errors = readers.map(read => {
      try { read(input); throw new Error('unexpected success'); } catch (error) { return (error as Error).message; }
    });
    expect(new Set(errors).size).toBe(1);
    expect(errors[0]).toContain(message);
  });

  it('checks retained create text/layout but does not invent old existing-source text', () => {
    const metadata = historyRecord(capturedV3Records().metadata, 'metadata');
    const mappings = historyArray(metadata.phaseTaskMapping, 'mappings').map(item => historyRecord(item, 'mapping'));
    const template = mappings.map(mapping => `- [x] ${mapping.taskId} ${mapping.marker}\r\n`).join('');
    const creation: TaskProjectionSourceFieldsV1 = {
      ...contract(), changeId: String(metadata.changeId), source: 'create', template, metadataText: JSON.stringify(metadata),
      taskPathParts: ['openspec', 'changes', String(metadata.changeId), 'tasks.md'],
      metadataPathParts: ['openspec', 'changes', String(metadata.changeId), 'liftoff-governance.json'],
      metadataHash: sha256Hex(JSON.stringify(metadata)), layoutHash: governanceTaskLayoutHash(template, metadata)
    };
    const operation: Current.TransitionOperation = {
      phaseId: 'provider-ready', actionId: 'governance.tasks.project', adapter: 'local-evidence', mutationClass: 'project-governance-tasks',
      inputs: { projection: creation }, destination: { type: 'local', identity: creation.taskPathParts.join('/'), pathParts: creation.taskPathParts },
      remote: false, destructive: false
    };
    expect(historicalV3ProjectionContract([operation])).toEqual(taskProjectionContract([operation]));
    const bad = { ...creation, layoutHash: 'f'.repeat(64) };
    expect(() => historicalV3ProjectionContract([{ ...operation, inputs: { projection: bad } }])).toThrow(/creation layout hash/);
    const missing = { ...creation, metadataText: '{}' };
    expect(() => historicalV3ProjectionContract([{ ...operation, inputs: { projection: missing } }])).toThrow(/inconsistently bound/);
    const prior = contract();
    expect(historicalV3ProjectionContract([{ ...operation, inputs: { projection: prior },
      destination: { type: 'local', identity: prior.taskPathParts.join('/'), pathParts: prior.taskPathParts } }])).toEqual(prior);
  });
});
