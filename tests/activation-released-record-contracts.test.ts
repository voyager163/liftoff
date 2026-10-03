import { readFileSync } from 'node:fs';
import { parseAst } from 'rolldown/parseAst';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type * as Records from '../src/domain/governance/activation/record-contracts.js';
import { releasedV3Values } from '../src/domain/governance/activation/record-contracts.js';
import type * as Current from '../src/domain/governance/activation/types.js';
import {
  historicalV1ActivationIdentity, historicalV2ActivationIdentity, releasedV3ActivationIdentity,
  type ReleasedV3ActivationIdentity
} from '../src/domain/governance/policy/identity.js';
import {
  currentActivationRecordValidators, releasedV3RecordValidators
} from '../src/domain/governance/activation/record-validation.js';
import {
  historicalV3PhaseGraph, validateHistoricalV3ActivationState, validateHistoricalV3EvidenceHeader,
  validateHistoricalV3LiveReadback, validateHistoricalV3ApprovalEnvelope, validateHistoricalV3SavedTransitionPlan,
  validateHistoricalV3CredentialPolicy, validateHistoricalV3EvidenceRecord, validateHistoricalV3AuxiliaryRecord,
  type HistoricalV3ActivationState, type HistoricalV3EvidenceHeader, type HistoricalV3LiveReadbackProof,
  type HistoricalV3ApprovalEnvelope, type HistoricalV3SavedTransitionPlan, type HistoricalV3CredentialPolicy,
  type HistoricalV3PhaseGraph, type HistoricalV3SupersessionRecord
} from '../src/governance-activation/historical-v3.js';
import {
  validateHistoricalActivationState, validateHistoricalEvidenceHeader, validateHistoricalSavedTransitionPlan,
  type HistoricalActivationState, type HistoricalEvidenceHeader, type HistoricalSavedTransitionPlan
} from '../src/governance-activation/historical-state.js';
import {
  validateHistoricalV2ActivationState, validateHistoricalV2EvidenceHeader, validateHistoricalV2SavedTransitionPlan,
  type HistoricalV2ActivationState, type HistoricalV2EvidenceHeader, type HistoricalV2SavedTransitionPlan
} from '../src/governance-activation/historical-v2.js';
import { validateHistoricalV3GovernanceChangeMetadata } from '../src/governance-activation/historical-source-metadata.js';
import {
  historyArray, historyRecord, historyString, parseHistoryJson, rawHistoryDigest
} from '../src/governance-activation/history-contracts.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { validateReleasedV3CompatibilityMetadata } from '../src/governance-activation/compatibility.js';

const bytes = readFileSync(new URL('./fixtures/activation-v3/records.json', import.meta.url));
const frozen = historyRecord(parseHistoryJson(bytes, 'frozen records'), 'frozen records');
function raw(name: string) { return historyRecord(structuredClone(frozen[name]), name); }
function first(name: string) { return historyRecord(structuredClone(historyArray(frozen[name], name)[0]), name); }
function nested(value: Record<string, unknown>, ...keys: string[]) {
  return keys.reduce((item, key) => historyRecord(item[key], key), value);
}
function sourceRecord(family: 1 | 2, kind: string) {
  const source = historyArray(frozen.successors, 'successors').map(value => historyRecord(value, 'successor'))
    .find(value => value.family === family);
  if (!source) throw new Error('Missing frozen source family.');
  const file = historyArray(source.sourceFiles, 'files').map(value => historyRecord(value, 'file'))
    .find(file => file.kind === kind);
  if (!file) throw new Error(`Missing frozen ${kind}.`);
  return historyRecord(parseHistoryJson(Buffer.from(historyString(file.content, 'content'), 'base64'), kind), kind);
}
function pending(): Records.PhaseExecutionStateFieldsV3<Records.ReleasedV3PhaseId> {
  return { state: 'pending', updatedAt: '2026-09-12T00:00:00.000Z', evidence: [], approvals: [], blockers: [] };
}
function typedV3State(): HistoricalV3ActivationState {
  return {
    schemaVersion: 3, identity: releasedV3ActivationIdentity,
    repository: { id: 'local:00000000-0000-4000-8000-000000000003', name: 'Typed release', defaultBranch: 'develop' },
    activeChange: null,
    applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' },
    phases: {
      'seed-valid': pending(), 'seed-verified': pending(), 'seed-archived': pending(), committed: pending(), pushed: pending(),
      'phase-0-complete': pending(), 'activation-approved': pending(), 'bootstrap-workflow-source-ready': pending(),
      'credential-ready': pending(), 'provider-ready': pending(), 'state-path-selected': pending(), 'existing-private-path': pending(),
      'bootstrap-local': pending(), 'runner-ready': pending(), 'private-backend-proof': pending(), 'remote-import-verified': pending(),
      'remote-ready': pending(), 'application-prerequisites-ready': pending(), 'workflow-source-ready': pending(),
      'application-artifact-ready': pending(), 'application-foundation': pending(), 'dev-proof': pending(), 'staging-qualified': pending(),
      'production-rehearsed': pending(), 'green-red-proof': pending(), 'enforcement-approved': pending(), 'rulesets-applied': pending(),
      'live-readback': pending(), 'bootstrap-state-disposed': pending()
    },
    createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z'
  };
}

afterEach(() => {
  vi.doUnmock('../src/domain/governance/activation/graph.js');
  vi.doUnmock('../src/domain/governance/activation/types.js');
  vi.doUnmock('../src/domain/governance/policy/identity.js');
  vi.resetModules();
});

describe('genuinely versioned released record types', () => {
  it('retains literal schemas and exact identity correlation through all released factory returns', () => {
    const readers = releasedV3RecordValidators(historicalV3PhaseGraph());
    expectTypeOf<ReturnType<typeof readers.validateUserActivationState>>().toEqualTypeOf<HistoricalV3ActivationState>();
    expectTypeOf<ReturnType<typeof readers.validateEvidenceHeader>>().toEqualTypeOf<HistoricalV3EvidenceHeader>();
    expectTypeOf<ReturnType<typeof readers.validateLiveReadbackProof>>().toEqualTypeOf<HistoricalV3LiveReadbackProof>();
    expectTypeOf<ReturnType<typeof readers.validateApprovalEnvelope>>().toEqualTypeOf<HistoricalV3ApprovalEnvelope>();
    expectTypeOf<ReturnType<typeof readers.validateSavedTransitionPlan>>().toEqualTypeOf<HistoricalV3SavedTransitionPlan>();
    expectTypeOf<ReturnType<typeof readers.validateCredentialPolicy>>().toEqualTypeOf<HistoricalV3CredentialPolicy>();
    expectTypeOf<ReturnType<typeof readers.validateSupersessionRecord>>().toEqualTypeOf<HistoricalV3SupersessionRecord>();
    expectTypeOf<ReturnType<typeof readers.validateGraphReconciliationRecord>['schemaVersion']>().toEqualTypeOf<3>();
    expectTypeOf<ReturnType<typeof readers.validateGraphReconciliationRecord>['fromIdentity']['liftoffVersion']>().toEqualTypeOf<'0.12.0'>();
    expectTypeOf<HistoricalV3ActivationState['schemaVersion']>().toEqualTypeOf<3>();
    expectTypeOf<HistoricalV3EvidenceHeader['schemaVersion']>().toEqualTypeOf<3>();
    expectTypeOf<HistoricalV3LiveReadbackProof['schemaVersion']>().toEqualTypeOf<3>();
    expectTypeOf<HistoricalV3ApprovalEnvelope['schemaVersion']>().toEqualTypeOf<3>();
    expectTypeOf<HistoricalV3SavedTransitionPlan['schemaVersion']>().toEqualTypeOf<2>();
    expectTypeOf<HistoricalV3CredentialPolicy['schemaVersion']>().toEqualTypeOf<1>();
    expectTypeOf<HistoricalV3SupersessionRecord['schemaVersion']>().toEqualTypeOf<1>();
    expectTypeOf<HistoricalV3ActivationState['identity']>().toEqualTypeOf<ReleasedV3ActivationIdentity>();
    expectTypeOf<HistoricalV3PhaseGraph['schemaVersion']>().toEqualTypeOf<2>();
    expectTypeOf<HistoricalV3PhaseGraph['versions']['activationContractVersion']>().toEqualTypeOf<3>();
    expectTypeOf<HistoricalV3PhaseGraph['phases'][number]['evidence']['headerSchemaVersion']>().toEqualTypeOf<3>();
    expectTypeOf<HistoricalV3PhaseGraph['phases'][number]['approvalGate']['envelopeSchemaVersion']>().toEqualTypeOf<3>();
  });

  it('closes every phase-bearing nested map over its actual 26- or 29-phase vocabulary', () => {
    type P = Records.ReleasedV3PhaseId;
    expectTypeOf<keyof HistoricalV3ActivationState['phases']>().toEqualTypeOf<P>();
    expectTypeOf<keyof NonNullable<HistoricalV3ActivationState['phaseOutputs']>>().toEqualTypeOf<P>();
    expectTypeOf<keyof NonNullable<HistoricalV3ActivationState['activationInputs']>['phases']>().toEqualTypeOf<P>();
    expectTypeOf<keyof NonNullable<NonNullable<HistoricalV3ActivationState['taskProjection']>['states']>>().toEqualTypeOf<P>();
    expectTypeOf<HistoricalV3EvidenceHeader['transition']['phaseId']>().toEqualTypeOf<P>();
    expectTypeOf<NonNullable<HistoricalV3SavedTransitionPlan['approvalBundle']>[number]['phaseId']>().toEqualTypeOf<P>();
    expectTypeOf<HistoricalV3SavedTransitionPlan['operations'][number]['phaseId']>().toEqualTypeOf<P>();
    expectTypeOf<HistoricalV3SavedTransitionPlan['rollbackPlan']['target']>().toEqualTypeOf<P | null>();
    expectTypeOf<keyof NonNullable<HistoricalV3ApprovalEnvelope['phasePlanDigests']>>().toEqualTypeOf<P>();
    expectTypeOf<keyof HistoricalActivationState['phases']>().toEqualTypeOf<Records.ReleasedV1PhaseId>();
    expectTypeOf<keyof HistoricalV2ActivationState['phases']>().toEqualTypeOf<Records.ReleasedV1PhaseId>();
    expectTypeOf<Extract<P, 'manual-local-complete'>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<Records.ReleasedV1PhaseId, 'application-artifact-ready'>>().toEqualTypeOf<never>();
    expect(Object.keys(validateHistoricalActivationState(sourceRecord(1, 'state')).phases)).toHaveLength(26);
    expect(Object.keys(validateHistoricalV2ActivationState(sourceRecord(2, 'state')).phases)).toHaveLength(26);
    expect(Object.keys(typedV3State().phases)).toHaveLength(29);
  });

  it('preserves v1/v2 record differences rather than deriving them from current interfaces', () => {
    expectTypeOf<HistoricalEvidenceHeader['schemaVersion']>().toEqualTypeOf<1>();
    expectTypeOf<HistoricalEvidenceHeader['identity']>().toEqualTypeOf<typeof historicalV1ActivationIdentity>();
    expectTypeOf<HistoricalActivationState['identity']>().toEqualTypeOf<typeof historicalV1ActivationIdentity>();
    expectTypeOf<HistoricalSavedTransitionPlan['identity']>().toEqualTypeOf<typeof historicalV1ActivationIdentity>();
    expectTypeOf<HistoricalV2SavedTransitionPlan['identity']>().toEqualTypeOf<typeof historicalV2ActivationIdentity>();
    expectTypeOf<HistoricalV2EvidenceHeader['schemaVersion']>().toEqualTypeOf<2>();
    expectTypeOf<Extract<keyof HistoricalEvidenceHeader, 'bodyDigest' | 'scope' | 'inputBindings'>>().toEqualTypeOf<never>();
    expectTypeOf<HistoricalV2EvidenceHeader['bodyDigest']>().toEqualTypeOf<string>();
    expectTypeOf<Extract<keyof HistoricalV2EvidenceHeader, 'scope' | 'inputBindings'>>().toEqualTypeOf<never>();
    expectTypeOf<HistoricalSavedTransitionPlan['schemaVersion']>().toEqualTypeOf<1>();
    expectTypeOf<HistoricalV2SavedTransitionPlan['schemaVersion']>().toEqualTypeOf<1>();
    expectTypeOf<Extract<keyof HistoricalSavedTransitionPlan, 'scope' | 'configuration' | 'recovery' | 'approvalBundle'>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof HistoricalActivationState['phases']['seed-valid'], 'operation' | 'executionPlanDigest'>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof HistoricalActivationState, 'remoteBinding'>>().toEqualTypeOf<never>();
    expectTypeOf<NonNullable<HistoricalV2ActivationState['remoteBinding']>['pushUrl']>().toEqualTypeOf<string>();
    expectTypeOf<Extract<HistoricalSavedTransitionPlan['operations'][number]['mutationClass'], 'registry-publish'>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<HistoricalSavedTransitionPlan['operations'][number]['mutationClass'], 'write-seed-tasks'>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<HistoricalV2SavedTransitionPlan['operations'][number]['mutationClass'], 'write-seed-tasks'>>().toEqualTypeOf<'write-seed-tasks'>();
    expectTypeOf<Extract<keyof HistoricalSavedTransitionPlan['operations'][number], 'effects'>>().toEqualTypeOf<never>();
  });

  it('keeps nested credential, retention, input and checkpoint shapes literal and independent', () => {
    expectTypeOf<HistoricalV3CredentialPolicy['rotationLeadDays']>().toEqualTypeOf<7>();
    expectTypeOf<HistoricalV3CredentialPolicy['secretName']>().toEqualTypeOf<'RUNNER_CONFIGURATION_READ_TOKEN'>();
    expectTypeOf<HistoricalV3CredentialPolicy['displayNameTemplate']>().toEqualTypeOf<'<repo>-runner-preflight-read'>();
    expectTypeOf<NonNullable<HistoricalV3CredentialPolicy['pat']>['lifetimeDays']>().toEqualTypeOf<30>();
    expectTypeOf<NonNullable<HistoricalV3CredentialPolicy['app']>['token']['strategy']>().toEqualTypeOf<'installation-token'>();
    expectTypeOf<HistoricalV3CredentialPolicy['proof']['payloadFree']>().toEqualTypeOf<true>();
    expectTypeOf<NonNullable<HistoricalV3ActivationState['activationInputs']>['schemaVersion']>().toEqualTypeOf<1>();
    expectTypeOf<NonNullable<HistoricalV3ActivationState['taskProjection']>['schemaVersion']>().toEqualTypeOf<1>();
    expectTypeOf<NonNullable<HistoricalV3ActivationState['successorHistory']>['schemaVersion']>().toEqualTypeOf<1>();
    expectTypeOf<NonNullable<HistoricalV3ActivationState['bootstrapState']>['status']>().toEqualTypeOf<'retained' | 'disposed'>();
    expectTypeOf<NonNullable<HistoricalV3ActivationState['phases']['seed-valid']['operation']>['status']>()
      .toEqualTypeOf<'running' | 'completed' | 'failed'>();
    expectTypeOf<NonNullable<HistoricalV3EvidenceHeader['inputBindings']>['files'][number]['pathParts']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<HistoricalV3SavedTransitionPlan['approval']['evaluation']['status']>()
      .toEqualTypeOf<'not-required' | 'approval-required' | 'reused' | 'expired' | 'invalidated'>();
  });

  it('supports stable generic identity fields without adding a sentinel to released aliases', () => {
    interface TestIdentity extends Records.ActivationIdentityFieldsV1 { testOnlyRequired: string }
    const identity: TestIdentity = { ...releasedV3ActivationIdentity, testOnlyRequired: 'compile-boundary-only' };
    const value: Records.UserActivationStateFieldsV3<TestIdentity, Records.ReleasedV3PhaseId> = {
      ...typedV3State(), identity
    };
    expectTypeOf(value.identity.testOnlyRequired).toEqualTypeOf<string>();
    expectTypeOf<Extract<keyof HistoricalV3ActivationState['identity'], 'testOnlyRequired'>>().toEqualTypeOf<never>();
    expect(value.identity.testOnlyRequired).toBe('compile-boundary-only');
    expect(() => validateHistoricalV3ActivationState(value)).toThrow(/not allowed/);
    const current: Current.UserActivationState = typedV3State();
    expect(current.identity).toBe(releasedV3ActivationIdentity);
    const readers = currentActivationRecordValidators();
    expectTypeOf<ReturnType<typeof readers.validateUserActivationState>>().toEqualTypeOf<Current.UserActivationState>();
    expectTypeOf<ReturnType<typeof readers.validateEvidenceHeader>>().toEqualTypeOf<Current.EvidenceHeader>();
    expectTypeOf<ReturnType<typeof readers.validateApprovalEnvelope>>().toEqualTypeOf<Current.ApprovalEnvelope>();
    expectTypeOf<ReturnType<typeof readers.validateCredentialPolicy>>().toEqualTypeOf<Current.CredentialPolicy>();
    expectTypeOf<ReturnType<typeof readers.validateGraphReconciliationRecord>>().toEqualTypeOf<Current.GraphReconciliationRecord>();
    expectTypeOf<Parameters<typeof readers.validateGraphReconciliationRecord>>().toEqualTypeOf<
      [value: unknown, recognizedGraphHashes?: ReadonlySet<string>]
    >();
    const state: Current.UserActivationState = readers.validateUserActivationState(typedV3State());
    const evidence: Current.EvidenceHeader = readers.validateEvidenceHeader(first('evidence').header);
    const plan: Current.SavedTransitionPlan = readers.validateSavedTransitionPlan(first('plans'));
    const credential: Current.CredentialPolicy = readers.validateCredentialPolicy(raw('credential'));
    expect(state.schemaVersion).toBe(3);
    expect(evidence.schemaVersion).toBe(3);
    expect(plan.schemaVersion).toBe(2);
    expect(credential.schemaVersion).toBe(1);
  });

  it('rejects invalid shapes at compile time without widening historical fields', () => {
    function negativeTypeCases() {
      const state = typedV3State();
      // @ts-expect-error Released v3 state has no Manual phase.
      state.phases['manual-local-complete'] = pending();
      // @ts-expect-error Released v3 identity has no profile field.
      state.identity.governanceProfile = 'team-gitflow';
      // @ts-expect-error Missing released state phases is not a valid typed record.
      const incomplete: HistoricalV3ActivationState = { schemaVersion: 3, identity: releasedV3ActivationIdentity };
      const old = validateHistoricalActivationState(sourceRecord(1, 'state'));
      // @ts-expect-error Released v1 phase state cannot gain current checkpoints.
      old.phases['seed-valid'].operation = { status: 'running' };
      const oldPlan = validateHistoricalSavedTransitionPlan(sourceRecord(1, 'plan'));
      // @ts-expect-error Released plan-1 cannot acquire current recovery fields.
      oldPlan.recovery = true;
      void incomplete;
    }
    expect(negativeTypeCases).toBeTypeOf('function');
  });
});

describe('released/current parser behavioral parity', () => {
  it('keeps frozen capture bytes, graphs, optional records and current outputs unchanged', () => {
    expect(rawHistoryDigest(bytes)).toBe('cb9a4768b30e031d9d4b802528223679efa28259b50713221cdfc7a71d6eda46');
    expect(canonicalSha256(historicalV3PhaseGraph())).toBe(releasedV3ActivationIdentity.phaseGraphHash);
    const current = currentActivationRecordValidators();
    const pairs = [
      [raw('state'), validateHistoricalV3ActivationState, current.validateUserActivationState],
      [first('evidence').header, validateHistoricalV3EvidenceHeader, current.validateEvidenceHeader],
      [first('approvals'), validateHistoricalV3ApprovalEnvelope, current.validateApprovalEnvelope],
      [first('plans'), validateHistoricalV3SavedTransitionPlan, current.validateSavedTransitionPlan],
      [raw('credential'), validateHistoricalV3CredentialPolicy, current.validateCredentialPolicy]
    ] as const;
    for (const [value, releasedReader, currentReader] of pairs) {
      expect(releasedReader(value)).toEqual(value);
      expect(JSON.stringify(releasedReader(value))).toBe(JSON.stringify(currentReader(value)));
    }
    expect(validateHistoricalV3GovernanceChangeMetadata(raw('metadata'))).toEqual(raw('metadata'));
    for (const kind of ['supersession', 'reconciliation', 'credential-policy'] as const) {
      expect(() => validateHistoricalV3AuxiliaryRecord(raw(kind === 'credential-policy' ? 'credential' : kind), kind)).not.toThrow();
    }
    expect(validateHistoricalV3ActivationState(typedV3State())).toEqual(typedV3State());
    const invalidReadbackRecord = historyRecord(historyArray(frozen.evidence, 'evidence')[1], 'record');
    expect(() => validateHistoricalV3EvidenceRecord(invalidReadbackRecord)).toThrow(/original reviewed transition/);
    const readback = historyArray(invalidReadbackRecord.liveReadback, 'readback')[0];
    expect(validateHistoricalV3LiveReadback(readback)).toEqual(readback);
  });

  it('preserves v1/v2 reader values and their original plan schemas and proof differences', () => {
    const v1State = sourceRecord(1, 'state');
    const v2State = sourceRecord(2, 'state');
    expect(validateHistoricalActivationState(v1State)).toEqual(v1State);
    expect(validateHistoricalV2ActivationState(v2State)).toEqual(v2State);
    const v1Proof = sourceRecord(1, 'evidence');
    const v2Proof = sourceRecord(2, 'evidence');
    expect(validateHistoricalEvidenceHeader(v1Proof.header ?? v1Proof)).toEqual(v1Proof.header ?? v1Proof);
    expect(validateHistoricalV2EvidenceHeader(v2Proof.header)).toEqual(v2Proof.header);
    expect(validateHistoricalSavedTransitionPlan(sourceRecord(1, 'plan')).schemaVersion).toBe(1);
    expect(validateHistoricalV2SavedTransitionPlan(sourceRecord(2, 'plan')).schemaVersion).toBe(1);
  });

  const mutations: Array<{ label: string; make(): Record<string, unknown>; read(value: unknown): unknown; alter(value: Record<string, unknown>): void }> = [
    { label: 'configuration schema', make: () => raw('state'), read: validateHistoricalV3ActivationState, alter: v => { nested(v, 'activationInputs').schemaVersion = 2; } },
    { label: 'configuration phase', make: () => raw('state'), read: validateHistoricalV3ActivationState, alter: v => { nested(v, 'activationInputs', 'phases')['manual-local-complete'] = {}; } },
    { label: 'checkpoint field', make: () => raw('state'), read: validateHistoricalV3ActivationState, alter: v => { nested(v, 'phases', 'application-foundation', 'operation').unknown = true; } },
    { label: 'checkpoint status', make: () => raw('state'), read: validateHistoricalV3ActivationState, alter: v => { nested(v, 'phases', 'application-foundation', 'operation').status = 'verified'; } },
    { label: 'task projection schema', make: () => raw('state'), read: validateHistoricalV3ActivationState, alter: v => { nested(v, 'taskProjection').schemaVersion = 2; } },
    { label: 'task projection outcome', make: () => raw('state'), read: validateHistoricalV3ActivationState, alter: v => { nested(v, 'taskProjection').status = 'complete'; } },
    { label: 'retention due time', make: () => raw('state'), read: validateHistoricalV3ActivationState, alter: v => { nested(v, 'bootstrapState').disposeAfter = '2026-09-01T00:00:00.000Z'; } },
    { label: 'retention state payload', make: () => raw('state'), read: validateHistoricalV3ActivationState, alter: v => { nested(v, 'bootstrapState').rawState = { private: true }; } },
    { label: 'evidence scope', make: () => first('evidence'), read: v => validateHistoricalV3EvidenceHeader(historyRecord(v, 'record').header), alter: v => { nested(v, 'header').scope = 'activation'; } },
    { label: 'input binding digest', make: () => first('evidence'), read: v => validateHistoricalV3EvidenceHeader(historyRecord(v, 'record').header), alter: v => { nested(v, 'header', 'inputBindings').beforeDigest = '0'.repeat(64); } },
    { label: 'plan schema', make: () => first('plans'), read: validateHistoricalV3SavedTransitionPlan, alter: v => { v.schemaVersion = 3; } },
    { label: 'plan configuration', make: () => first('plans'), read: validateHistoricalV3SavedTransitionPlan, alter: v => { nested(v, 'configuration').schemaVersion = 2; } },
    { label: 'plan bundle phase', make: () => first('plans'), read: validateHistoricalV3SavedTransitionPlan, alter: v => { historyRecord(historyArray(v.approvalBundle, 'bundle')[0], 'bundle').phaseId = 'seed-valid'; } },
    { label: 'approval bundle omission', make: () => first('approvals'), read: validateHistoricalV3ApprovalEnvelope, alter: v => { delete v.phasePlanDigests; } },
    { label: 'credential lifetime', make: () => raw('credential'), read: validateHistoricalV3CredentialPolicy, alter: v => { nested(v, 'pat').lifetimeDays = 31; } },
    { label: 'credential rotation', make: () => raw('credential'), read: validateHistoricalV3CredentialPolicy, alter: v => { v.rotationLeadDays = 8; } },
    { label: 'credential proof payload', make: () => raw('credential'), read: validateHistoricalV3CredentialPolicy, alter: v => { nested(v, 'proof').payloadFree = false; } }
  ];
  it.each(mutations)('rejects changed nested $label without rewriting original data', ({ make, read, alter }) => {
    const value = make();
    alter(value);
    const before = JSON.stringify(value);
    expect(() => read(value)).toThrow();
    expect(JSON.stringify(value)).toBe(before);
  });
});

describe('type boundary versus imported runtime selection', () => {
  it('retains released literals when current runtime exports differ, without claiming a current-source compiler mutation', async () => {
    const graph = await vi.importActual<typeof import('../src/domain/governance/activation/graph.js')>('../src/domain/governance/activation/graph.js');
    const identity = await vi.importActual<typeof import('../src/domain/governance/policy/identity.js')>('../src/domain/governance/policy/identity.js');
    const types = await vi.importActual<typeof import('../src/domain/governance/activation/types.js')>('../src/domain/governance/activation/types.js');
    vi.doMock('../src/domain/governance/activation/graph.js', () => ({
      ...graph, currentActivationIdentity: { ...graph.currentActivationIdentity, manifestArtifactVersion: 99 },
      activationCompatibility: new Map()
    }));
    vi.doMock('../src/domain/governance/activation/types.js', () => ({
      ...types, phaseStates: ['future-test-state'], mutationClasses: ['future-test-mutation'],
      runnerPreflightRotationLeadDays: 99, runnerPreflightPatLifetimeDays: 99
    }));
    vi.doMock('../src/domain/governance/policy/identity.js', () => ({
      ...identity, liftoffManifestArtifactVersion: 99, minimumVersion: 'test-only-not-a-release'
    }));
    vi.resetModules();
    const released = await import('../src/governance-activation/historical-v3.js');
    expect(released.validateHistoricalV3ActivationState(raw('state'))).toEqual(raw('state'));
    expect(released.validateHistoricalV3CredentialPolicy(raw('credential'))).toEqual(raw('credential'));
    const compatibility = await import('../src/governance-activation/compatibility.js');
    expect(compatibility.validateReleasedV3CompatibilityMetadata(raw('compatibility')).manifest.writeVersion).toBe(7);
    expectTypeOf<ReturnType<typeof validateReleasedV3CompatibilityMetadata>['manifest']['writeVersion']>().toEqualTypeOf<7>();
    expectTypeOf<ReturnType<typeof validateReleasedV3CompatibilityMetadata>['minimumLiftoffVersions']['manifestWriteVersion7']>()
      .toEqualTypeOf<'0.10.0'>();
    expect(releasedV3Values.runnerPreflightRotationLeadDays).toBe(7);
  });

  it('keeps versioned declarations and historical aliases independent of mutable current interfaces', () => {
    function object(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
    function nodes(v: unknown): Record<string, unknown>[] {
      if (Array.isArray(v)) return v.flatMap(nodes);
      if (!object(v)) return [];
      return [...(typeof v.type === 'string' ? [v] : []), ...Object.values(v).flatMap(nodes)];
    }
    function tree(file: string) { return parseAst(readFileSync(file, 'utf8'), { lang: 'ts' }, file); }
    function names(v: unknown) { return nodes(v).filter(n => n.type === 'Identifier').map(n => n.name); }
    const stable = tree('src/domain/governance/activation/record-contracts.ts');
    const imports = nodes(stable).filter(n => n.type === 'ImportDeclaration');
    expect(imports.map(n => object(n.source) ? n.source.value : undefined)).toEqual(['./approval-values.js']);
    for (const name of ['ActivationIdentity', 'CurrentActivationIdentity', 'UserActivationState', 'PhaseId', 'CredentialPolicy', 'SavedTransitionPlan']) {
      expect(names(stable)).not.toContain(name);
    }
    for (const file of ['historical-v3.ts', 'historical-common.ts', 'historical-v2.ts', 'historical-source-metadata.ts']) {
      const ast = tree(`src/governance-activation/${file}`);
      expect(nodes(ast).filter(n => n.type === 'ImportDeclaration')
        .some(n => object(n.source) && n.source.value === '../domain/governance/activation/types.js')).toBe(false);
    }
    const parser = tree('src/domain/governance/activation/record-validation.ts');
    expect(nodes(parser).filter(n => n.type === 'ImportDeclaration' && n.importKind === 'type')
      .some(n => object(n.source) && n.source.value === './types.js')).toBe(false);
    const factories = nodes(parser).filter(n => n.type === 'FunctionDeclaration' && object(n.id) && n.id.name === 'createRecordValidators');
    expect(factories).toHaveLength(1);
    expect(names(factories[0].typeParameters)).toContain('ActivationIdentityFieldsV1');
    expect(names(factories[0].typeParameters)).not.toContain('ActivationIdentity');
    const policy = tree('src/domain/governance/policy/identity.ts');
    const satisfies = nodes(policy).filter(n => n.type === 'TSSatisfiesExpression');
    expect(satisfies).toHaveLength(2);
    expect(satisfies.every(n => names(n.typeAnnotation).includes('ActivationIdentityFieldsV1'))).toBe(true);
    const compatibility = tree('src/governance-activation/compatibility.ts');
    const common = nodes(compatibility).find(n => n.type === 'VariableDeclarator' && object(n.id) && n.id.name === 'common');
    expect(common).toBeDefined();
    expect(names(common?.init)).not.toContain('manifestWriteVersion');
    expect(names(common?.init)).not.toContain('minimumManifestWriter');
    const releasedCheck = nodes(compatibility).find(n => n.type === 'FunctionDeclaration' && object(n.id) && n.id.name === 'assertReleasedIdentity');
    expect(names(releasedCheck?.params)).not.toContain('ActivationIdentity');
    expect(names(releasedCheck?.params)).toContain('ActivationIdentityFieldsV1');
  });
});
