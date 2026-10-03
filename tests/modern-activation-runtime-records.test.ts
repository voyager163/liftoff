import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { projectCatalog } from '../src/application/project/catalog.js';
import { composeModernManifestPlugins } from '../src/application/project/plugins.js';
import { resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import { readManifestPluginMetadata } from '../src/domain/project/manifest/plugins.js';
import { manifestActiveLayoutDigest } from '../src/domain/project/manifest/layout.js';
import { createModernActivationIdentityReader } from '../src/domain/governance/activation/modern-identity.js';
import { createModernActivationRecordContract, type ModernPlanInput, type ModernRelatedRecords } from '../src/domain/governance/activation/modern-records.js';
import type * as M from '../src/domain/governance/activation/modern-record-contracts.js';
import { canonicalJson, canonicalSha256, sha256Hex } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalApprovalEnvelopeValues, normalizeApprovalScopeValues } from '../src/domain/governance/activation/source-values.js';
import { capturedV3Records } from './fixtures/activation-v3/fixture.js';
import { historyRecord } from '../src/governance-activation/history-contracts.js';
import { validateHistoricalV3CredentialPolicy } from '../src/governance-activation/historical-v3.js';

const timestamp = '2026-09-01T00:00:00.000Z', expiry = '2026-09-02T00:00:00.000Z';
const repository = { id: 'local:11111111-1111-4111-8111-111111111111', name: 'runtime-fixture', defaultBranch: 'develop' };
function contract(workflow: M.ModernWorkflow = 'manual', profile: M.ModernGovernanceProfile = 'single-maintainer-gitflow') {
  const agents = workflow === 'manual' ? [] : ['github-copilot'];
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project: { name: 'runtime-fixture', workload: { kind: 'standard', apiStack: 'node-fastify', cloud: 'azure',
      region: 'eastus', frontend: false, environments: ['dev'] }, specWorkflow: workflow, agents,
      ...(workflow === 'spec-kit' ? { defaultAgent: 'github-copilot' } : {}) },
    framework: workflow === 'manual' ? { state: 'not-required' } : { state: 'initialized', adapter: workflow, contractVersion: '1.2.3' }
  });
  const composition = composeModernManifestPlugins({ workload: 'standard', stack: 'node-fastify', cloud: 'azure', workflow, agents,
    frontend: 'omitted', environments: ['dev'], governanceProfile: profile }, { safeProjectName: 'runtime-fixture' });
  const plugins = readManifestPluginMetadata({ schemaVersion: 1, resolutionDigest: composition.resolution.digest,
    selections: composition.resolution.plugins }, { stack: 'node-fastify', cloud: 'azure', workflow, agents });
  const selection = { ...leaf, profile }, source = resolveModernManifestV8SourceContract({ selection, recordedPlugins: plugins });
  if (!('identity' in source.governanceSource)) throw new Error('Expected actual enabled source.');
  const context = { profile, policyVersion: source.governanceSource.identity.policyVersion, selection,
    pluginResolutionDigest: plugins.resolutionDigest,
    activeLayoutDigest: manifestActiveLayoutDigest({ schemaVersion: 1, state: 'unresolved', bindings: [] }, source.layoutDescriptor) };
  const identity = createModernActivationIdentityReader(projectCatalog).identityForSource({
    sourceVersion: source.governanceSource.identity.liftoffVersion, ...context
  });
  return createModernActivationRecordContract(projectCatalog, { ...context, recordedIdentity: identity });
}
type Contract = ReturnType<typeof contract>;
function planInput(api: Contract, id: M.ModernPhaseId = 'local-inputs-valid'): ModernPlanInput {
  const phase = api.graph.phases.find(phase => phase.id === id)!;
  return {
    phaseId: id, createdAt: timestamp, expiresAt: expiry, stateHash: null, baselineDigest: 'a'.repeat(64),
    inputDigest: 'b'.repeat(64), transitionDigest: 'c'.repeat(64), operations: [],
    approval: { gateKind: phase.approvalGate.kind, required: phase.approvalGate.required, envelopeId: null, envelopeHash: null,
      evaluation: { phaseId: id, gateKind: phase.approvalGate.kind, questionKind: null, approvalRequired: phase.approvalGate.required,
        status: phase.approvalGate.required ? 'approval-required' : 'not-required', envelopeId: null, envelopeHash: null, reasons: [], expansionReasons: [] } },
    rollbackPlan: { phaseId: id, strategy: phase.rollback.kind, target: phase.rollback.target, operations: [], retained: [], cleanupWarnings: [] },
    noSecrets: true,
    ...(['activation-plan', 'infrastructure-cost'].includes(phase.approvalGate.kind) ? {
      configuration: { schemaVersion: 1 as const, phases: {}, budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 } }
    } : {})
  };
}
function initial(api: Contract) {
  return api.createInitialState({ repository, createdAt: timestamp,
    applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' } });
}
function approval(api: Contract, plan: M.ModernSavedTransitionPlan) {
  return api.createApproval({ plan, id: 'explicit-synthetic-consent', resources: [], destinations: [], permissions: [],
    costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 }, policyExceptions: [], destructiveScope: [],
    approvedAt: timestamp, expiresAt: expiry, approver: 'fixture-human-not-live-qualification' });
}
function proof(api: Contract, plan: M.ModernSavedTransitionPlan, payload: Record<string, unknown> = { kind: `${plan.phaseId}.v1` },
  records: ModernRelatedRecords = {}) {
  return api.createEvidence({ plan, evidenceId: `synthetic-${plan.phaseId}`, repositoryId: repository.id,
    producedAt: timestamp, producer: 'synthetic-format-fixture', result: 'verified', payload }, records);
}
function approvalHash(api: Contract, record: M.ModernApprovalEnvelope) {
  return canonicalSha256(canonicalApprovalEnvelopeValues(record, normalizeApprovalScopeValues(record, api.graph.phases.map(phase => phase.id))));
}

describe('modern terminal outcomes bind their selected original plan', () => {
  it.each(['transition', 'recovery', 'saved-record'] as const)('rejects an outcome using plan A proof with distinct plan B (%s)', difference => {
    const api = contract(), planA = api.createPlan(planInput(api));
    const planB = api.createPlan({ ...planInput(api),
      ...(difference === 'transition' ? { transitionDigest: 'd'.repeat(64) } :
        difference === 'recovery' ? { recovery: true } : { expiresAt: '2026-09-03T00:00:00.000Z' }) });
    const evidenceA = proof(api, planA);
    const refs = { plans: [planA, planB], evidence: [evidenceA] };
    expect(() => api.stateAfterOutcome({ state: initial(api), plan: planB, phaseState: 'verified',
      evidenceId: evidenceA.evidenceId, updatedAt: timestamp }, refs)).toThrow(/plan|outcome/);
  });

  it.each(['transition', 'recovery', 'missing'] as const)('rejects a fabricated terminal state with disconnected execution plan (%s)', difference => {
    const api = contract(), planA = api.createPlan(planInput(api));
    const planB = api.createPlan({ ...planInput(api),
      ...(difference === 'transition' ? { transitionDigest: 'd'.repeat(64) } : { recovery: true }) });
    const evidenceA = proof(api, planA), refs = { plans: [planA, planB], evidence: [evidenceA] };
    const state = structuredClone(api.stateAfterOutcome({ state: initial(api), plan: planA, phaseState: 'verified',
      evidenceId: evidenceA.evidenceId, updatedAt: timestamp }, refs));
    if (difference === 'missing') delete state.phases['local-inputs-valid'].executionPlanDigest;
    else state.phases['local-inputs-valid'].executionPlanDigest = planB.planDigest;
    expect(() => api.readState(state, refs)).toThrow(/terminal|plan|outcome/);
    expect(() => api.encodeRecord({ kind: 'state', record: state }, refs)).toThrow(/terminal|plan|outcome/);
  });

  it('does not retain old success for a new plan when no new evidenceId was supplied', () => {
    const api = contract(), planA = api.createPlan(planInput(api)), planB = api.createPlan({ ...planInput(api), recovery: true });
    const evidenceA = proof(api, planA), refs = { plans: [planA, planB], evidence: [evidenceA] };
    const state = api.stateAfterOutcome({ state: initial(api), plan: planA, phaseState: 'verified',
      evidenceId: evidenceA.evidenceId, updatedAt: timestamp }, refs);
    expect(() => api.stateAfterOutcome({ state, plan: planB, phaseState: 'verified', updatedAt: timestamp }, refs)).toThrow(/terminal|plan|outcome/);
  });

  it('allows a new success while retaining older same-phase proofs and output receipts', () => {
    const api = contract(), planA = api.createPlan(planInput(api)), planB = api.createPlan({ ...planInput(api), recovery: true });
    const outputs = { values: { original: 'retained-value' }, resources: [] };
    const evidenceA = { ...proof(api, planA, { kind: 'local-inputs-valid.v1', outputBindings: outputs }), evidenceId: 'old-proof' };
    const evidenceB = { ...proof(api, planB), evidenceId: 'new-proof' };
    const refs = { plans: [planA, planB], evidence: [evidenceA, evidenceB] };
    const old = api.stateAfterOutcome({ state: initial(api), plan: planA, phaseState: 'verified',
      evidenceId: evidenceA.evidenceId, outputs, updatedAt: timestamp }, refs);
    const updated = api.stateAfterOutcome({ state: old, plan: planB, phaseState: 'verified',
      evidenceId: evidenceB.evidenceId, updatedAt: timestamp }, refs);
    expect(updated.phases['local-inputs-valid'].evidence.map(ref => ref.evidenceId)).toEqual(['old-proof', 'new-proof']);
    expect(updated.phases['local-inputs-valid'].executionPlanDigest).toBe(planB.planDigest);
    expect(updated.phaseOutputs?.['local-inputs-valid']).toEqual(outputs);
    expect(api.readState(updated, refs)).toEqual(updated);
  });

  it.each(['blocked', 'failed'] as const)('keeps old proof/output and distinct dispatch plans in %s recovery states', phaseState => {
    const api = contract(), planA = api.createPlan(planInput(api)), planB = api.createPlan({ ...planInput(api), recovery: true });
    const outputs = { values: { previous: 'original receipt' }, resources: [] };
    const evidenceA = proof(api, planA, { kind: 'local-inputs-valid.v1', outputBindings: outputs });
    const refs = { plans: [planA, planB], evidence: [evidenceA] };
    const success = structuredClone(api.stateAfterOutcome({ state: initial(api), plan: planA, phaseState: 'verified',
      evidenceId: evidenceA.evidenceId, outputs, updatedAt: timestamp }, refs));
    const operation = { provider: 'github' as const, actionId: 'recorded-dispatch', operationId: 'original-op',
      resourceId: 'original-resource', startedAt: timestamp, observedAt: timestamp, status: 'running' as const, planDigest: planA.planDigest };
    success.phases['local-inputs-valid'].operation = operation;
    const recovery = api.stateAfterOutcome({ state: success, plan: planB, phaseState, blocker: 'observed recovery issue', updatedAt: timestamp }, refs);
    expect(recovery.phases['local-inputs-valid'].executionPlanDigest).toBe(planB.planDigest);
    expect(recovery.phases['local-inputs-valid'].operation).toEqual(operation);
    expect(recovery.phases['local-inputs-valid'].evidence).toEqual(success.phases['local-inputs-valid'].evidence);
    expect(recovery.phaseOutputs).toEqual(success.phaseOutputs);
    expect(api.readState(recovery, refs)).toEqual(recovery);
  });

  it.each(['other-consent', 'pending-plan', 'missing-plan'] as const)('rejects approved state assembled from unrelated valid records (%s)', mode => {
    const api = contract(), draftA = api.createPlan(planInput(api, 'activation-approved'));
    const draftB = api.createPlan({ ...planInput(api, 'activation-approved'), transitionDigest: 'd'.repeat(64) });
    const consentA = { ...approval(api, draftA), id: 'consent-a' }, consentB = { ...approval(api, draftB), id: 'consent-b' };
    const authorized = (plan: M.ModernSavedTransitionPlan, consent: M.ModernApprovalEnvelope) => {
      const result = structuredClone(plan), hash = approvalHash(api, consent);
      Object.assign(result.approval, { envelopeId: consent.id, envelopeHash: hash });
      Object.assign(result.approval.evaluation, { envelopeId: consent.id, envelopeHash: hash, status: 'reused' });
      return result;
    };
    const planA = authorized(draftA, consentA), planB = mode === 'pending-plan' ? draftB : authorized(draftB, consentB);
    const refs = { plans: [planA, planB], approvals: [consentA, consentB] };
    const state = structuredClone(api.stateAfterOutcome({ state: initial(api), plan: planA,
      phaseState: 'approved', updatedAt: timestamp }, refs));
    if (mode === 'missing-plan') delete state.phases['activation-approved'].executionPlanDigest;
    else state.phases['activation-approved'].executionPlanDigest = planB.planDigest;
    expect(() => api.readState(state, refs)).toThrow(/terminal|plan|approval/);
  });

  it.each(['manual', 'openspec', 'spec-kit'] as const)('requires the same original baseline for %s local completion', workflow => {
    const api = contract(workflow), baselinePlan = api.createPlan(planInput(api, 'local-baseline-verified'));
    const baseline = proof(api, baselinePlan, { kind: 'local-baseline-verified.v1', checks: [{ id: 'actual-fixture-check', status: 'passed' }] });
    const payload = { schemaVersion: 1, kind: 'local-complete.v1', workflow,
      frameworkValidation: workflow === 'manual' ? 'not-required' : 'verified',
      frameworkFinalization: workflow === 'manual' ? 'not-required' : workflow === 'openspec' ? 'synced-archived' : 'finalized',
      baselineEvidenceId: baseline.evidenceId, baselineHeaderDigest: canonicalSha256(baseline.header) };
    const validPlan = api.createPlan({ ...planInput(api, 'local-complete'), inputDigest: 'e'.repeat(64) });
    const unrelated = api.createPlan({ ...planInput(api, 'local-complete'), baselineDigest: 'f'.repeat(64) });
    const refs = { plans: [baselinePlan], evidence: [baseline] };
    const original = proof(api, validPlan, payload, refs);
    expect(() => proof(api, unrelated, payload, refs)).toThrow(/baseline/);
    const fabricated = structuredClone(original);
    fabricated.header.baselineSha = unrelated.baselineDigest;
    fabricated.header.transition = { phaseId: unrelated.phaseId, baselineSha: unrelated.baselineDigest,
      inputDigest: unrelated.inputDigest, transitionDigest: unrelated.transitionDigest };
    fabricated.header.inputDigest = unrelated.inputDigest;
    fabricated.payload = { ...payload, planDigest: unrelated.planDigest, savedPlanDigest: canonicalSha256(unrelated) };
    fabricated.header.bodyDigest = canonicalSha256({ payload: fabricated.payload, liveReadback: [] });
    expect(() => api.readEvidence(fabricated, { plans: [baselinePlan, unrelated], evidence: [baseline] })).toThrow(/baseline/);
  });
});

describe('complete independent modern runtime records using real source contexts', () => {
  it.each((['single-maintainer-gitflow', 'team-gitflow'] as const).flatMap(profile =>
    (['openspec', 'spec-kit', 'manual'] as const).map(workflow => ({ profile, workflow }))))(
    'constructs/reads/encodes $profile/$workflow without promoting current execution', ({ profile, workflow }) => {
      const api = contract(workflow, profile), state = initial(api), plan = api.createPlan(planInput(api));
      const evidence = proof(api, plan), consent = approval(api, api.createPlan(planInput(api, 'activation-approved')));
      expectTypeOf(api.readState(state)).toEqualTypeOf<M.ModernActivationState>();
      expectTypeOf(api.readPlan(plan)).toEqualTypeOf<M.ModernSavedTransitionPlan>();
      expectTypeOf(api.readEvidence(evidence, { plans: [plan] })).toEqualTypeOf<M.ModernEvidenceRecord>();
      expect(state.schemaVersion).toBe(4); expect(plan.schemaVersion).toBe(3); expect(consent.schemaVersion).toBe(4);
      expect(Object.keys(state.phases)).toHaveLength(29);
      expect(state.activeChange).toBeNull();
      const outcome = api.stateAfterOutcome({ state, plan, phaseState: 'verified', evidenceId: evidence.evidenceId, updatedAt: timestamp },
        { plans: [plan], evidence: [evidence] });
      expect(outcome.phases['local-inputs-valid'].state).toBe('verified');
      expect(state.phases['local-inputs-valid'].state).toBe('pending');
      for (const wrapper of [{ kind: 'state', record: state }, { kind: 'plan', record: plan },
        { kind: 'approval', record: consent }, { kind: 'evidence', record: evidence }] as const) {
        const encoded = api.encodeRecord(wrapper, { plans: [plan] }), text = new TextDecoder().decode(encoded.content);
        expect(text).toBe(canonicalJson(wrapper.record));
        expect(text.endsWith('\n\n')).toBe(false);
        expect(encoded.rawDigest).toBe(sha256Hex(text));
        expect(encoded.recordDigest).toBe(canonicalSha256(wrapper.record));
        expect(JSON.parse(text)).not.toHaveProperty('record');
      }
      expect(() => api.readState(outcome)).toThrow(/references/);
      expect(api.identity.workflow).toBe(workflow); expect(Object.isFrozen(outcome.phases)).toBe(true);
    }
  );

  it('requires concrete modern local baseline and completion references with no fictional Manual archive', () => {
    const api = contract(), baselinePlan = api.createPlan(planInput(api, 'local-baseline-verified'));
    const completePlan = api.createPlan(planInput(api, 'local-complete'));
    expect(() => proof(api, baselinePlan)).toThrow(/check observations/);
    const baseline = proof(api, baselinePlan, { kind: 'local-baseline-verified.v1', checks: [{ id: 'actual-fixture-check', status: 'passed' }] });
    const payload = { schemaVersion: 1, kind: 'local-complete.v1', workflow: 'manual',
      frameworkValidation: 'not-required', frameworkFinalization: 'not-required',
      baselineEvidenceId: baseline.evidenceId, baselineHeaderDigest: canonicalSha256(baseline.header) };
    expect(() => proof(api, completePlan, payload)).toThrow(/baseline evidence/);
    const records = { plans: [baselinePlan], evidence: [baseline] };
    const completed = proof(api, completePlan, payload, records);
    expect(completed.header.phaseId).toBe('local-complete');
    expect(() => proof(api, completePlan, { ...payload, frameworkFinalization: 'synced-archived' }, records)).toThrow(/fictional archive/);
    expect(() => proof(api, completePlan, { ...payload, baselineHeaderDigest: 'f'.repeat(64) }, records)).toThrow(/baseline evidence/);
  });

  it.each(['schemaVersion', 'identity', 'phaseId', 'graphHash', 'planDigest', 'mutationClasses', 'rollbackPlan', 'approval'] as const)(
    'rejects internally inconsistent plan %s', field => {
      const api = contract(), plan = structuredClone(api.createPlan(planInput(api)));
      if (field === 'schemaVersion') Reflect.set(plan, field, 2);
      if (field === 'identity') Reflect.set(plan.identity, 'pluginResolutionDigest', `sha256:${'f'.repeat(64)}`);
      if (field === 'phaseId') Reflect.set(plan, field, 'seed-valid');
      if (field === 'graphHash' || field === 'planDigest') Reflect.set(plan, field, 'f'.repeat(64));
      if (field === 'mutationClasses') Reflect.set(plan.mutationClasses, 'remote', ['github-write']);
      if (field === 'rollbackPlan') Reflect.set(plan.rollbackPlan, 'phaseId', 'local-complete');
      if (field === 'approval') plan.approval.evaluation.envelopeId = 'unbound';
      expect(() => api.readPlan(plan)).toThrow();
    }
  );

  it('derives plan/approval/bundle commitments and never treats absent consent as issued approval', () => {
    const api = contract('openspec'), draft = planInput(api, 'enforcement-approved');
    const plan = api.createPlan({ ...draft, approvalBundle: [{ phaseId: 'rulesets-applied', operations: [],
      inputDigest: 'a'.repeat(64), transitionDigest: 'd'.repeat(64), fileChanges: [] }] });
    const consent = approval(api, plan);
    const authorized = structuredClone(plan), hash = approvalHash(api, consent);
    Object.assign(authorized.approval, { envelopeId: consent.id, envelopeHash: hash });
    Object.assign(authorized.approval.evaluation, { envelopeId: consent.id, envelopeHash: hash, status: 'reused' });
    expect(api.readPlan(authorized, { approvals: [consent] }).planDigest).toBe(plan.planDigest);
    expect(() => api.readPlan(authorized)).toThrow(/stored approval/);
    expect(() => api.readPlan(authorized, { approvals: [{ ...consent, approver: 'different' }] })).toThrow(/envelope hash/);
    expect(consent.planDigest).not.toBe(plan.planDigest);
    expect(consent.coveredPhases).toEqual(['enforcement-approved', 'rulesets-applied']);
  });

  it.each(['resources', 'destinations', 'permissions', 'costCeiling', 'policyExceptions', 'operationDigests'] as const)(
    'rejects correct-hash reused approval with narrower %s', field => {
      const api = contract(), draft = planInput(api, 'activation-approved');
      const plan = api.createPlan({ ...draft,
        configuration: { schemaVersion: 1, phases: { 'activation-approved': { policyExceptions: ['reviewed-exception'] } },
          budget: { currency: 'USD', fixedMonthlyCents: 10, usageMonthlyCents: 20 } },
        operations: [{ phaseId: 'activation-approved', adapter: 'local-evidence', actionId: 'governance.operational-plan.write',
          mutationClass: 'write-operational-plan', inputs: {}, remote: false, destructive: false,
          destination: { type: 'local', identity: 'governance/plans/reviewed.json', pathParts: ['governance', 'plans', 'reviewed.json'] } }] });
      const approved = api.createApproval({ plan, id: 'scope-consent', resources: [{ type: 'write-operational-plan', identity: 'governance/plans/reviewed.json' }],
        destinations: [{ type: 'local', identity: 'governance/plans/reviewed.json', repository: null, subscriptionId: null }],
        permissions: ['write-operational-plan'], costCeiling: { currency: 'USD', fixedMonthlyCents: 10, usageMonthlyCents: 20 },
        policyExceptions: ['reviewed-exception'], destructiveScope: [], approvedAt: timestamp, expiresAt: expiry, approver: 'fixture-human' });
      const bind = (envelope: M.ModernApprovalEnvelope) => {
        const value = structuredClone(plan), hash = approvalHash(api, envelope);
        Object.assign(value.approval, { envelopeId: envelope.id, envelopeHash: hash });
        Object.assign(value.approval.evaluation, { status: 'reused', envelopeId: envelope.id, envelopeHash: hash });
        return value;
      };
      expect(api.readPlan(bind(approved), { approvals: [approved] }).planDigest).toBe(plan.planDigest);
      const changed = structuredClone(approved);
      Reflect.set(changed, field, field === 'costCeiling' ? { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 } : []);
      expect(() => api.readPlan(bind(changed), { approvals: [changed] })).toThrow(/scope|omits/);
    }
  );

  it('does not default missing cost or destructive business observations to reusable empty scope', () => {
    const api = contract(), { configuration: _budget, ...withoutBudget } = planInput(api, 'activation-approved');
    const plan = api.createPlan(withoutBudget);
    expect(() => approval(api, plan)).toThrow(/unavailable cost is not zero/);
    const destructive = api.createPlan(planInput(api, 'bootstrap-state-disposed'));
    expect(() => approval(api, destructive)).toThrow(/actual retained destructive destinations/);
    const operation: M.ModernTransitionOperation = {
      phaseId: 'bootstrap-state-disposed', adapter: 'local-state', actionId: 'local.state.dispose', mutationClass: 'delete-local-state',
      inputs: {}, remote: false, destructive: true,
      destination: { type: 'local', identity: 'protected/material.enc', pathParts: ['protected', 'material.enc'] }
    };
    const disposal = api.createPlan({ ...planInput(api, 'bootstrap-state-disposed'), operations: [operation] });
    const input = { plan: disposal, id: 'disposal-scope', resources: [{ type: 'delete-local-state', identity: 'protected/material.enc' }],
      destinations: [{ type: 'local' as const, identity: 'protected/material.enc', repository: null, subscriptionId: null }],
      permissions: ['delete-local-state'], costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
      policyExceptions: [], destructiveScope: ['protected/material.enc'], approvedAt: timestamp, expiresAt: expiry, approver: 'fixture-human' };
    expect(api.createApproval(input).destructiveScope).toEqual(['protected/material.enc']);
    expect(() => api.createApproval({ ...input, destructiveScope: [] })).toThrow(/destructive scope expanded/);
  });

  it('keeps semantic-plan vs complete-record hashes distinct, including changed pre/post inputs', () => {
    const api = contract(), draft = planInput(api);
    const plan = api.createPlan({ ...draft, fileChanges: [{ pathParts: ['README.md'], beforeHash: 'd'.repeat(64), afterHash: 'e'.repeat(64) }] });
    const record = api.createEvidence({ plan, evidenceId: 'pre-post', repositoryId: repository.id, producedAt: timestamp,
      producer: 'synthetic-original', result: 'verified', payload: { kind: 'local-inputs-valid.v1' }, afterInputDigest: 'e'.repeat(64) });
    expect(record.header.inputDigest).not.toBe(record.header.transition.inputDigest);
    expect(api.readEvidence(record, { plans: [plan] })).toEqual(record);
    const changed = { ...plan, createdAt: '2026-08-31T00:00:00.000Z' };
    expect(changed.planDigest).toBe(plan.planDigest);
    expect(() => api.readEvidence(record, { plans: [changed] })).toThrow(/exact original saved plan/);
    expect(() => api.readEvidence({ ...record, payload: { kind: 'altered' } }, { plans: [plan] })).toThrow(/body commitment/);
  });

  it('supports supplied dispatch/recovery identities independently and refuses missing plans', () => {
    const api = contract(), first = api.createPlan(planInput(api)), second = api.createPlan({ ...planInput(api), recovery: true });
    const value = structuredClone(initial(api));
    value.phases['local-inputs-valid'].executionPlanDigest = second.planDigest;
    value.phases['local-inputs-valid'].operation = { provider: 'github', actionId: 'actual-checkpoint', operationId: 'original-op',
      resourceId: 'original-resource', status: 'running', startedAt: timestamp, observedAt: timestamp, planDigest: first.planDigest };
    expect(api.readState(value, { plans: [first, second] }).phases['local-inputs-valid'].operation!.planDigest).toBe(first.planDigest);
    expect(() => api.readState(value, { plans: [second] })).toThrow(/dispatch plan/);
    const blocked = api.stateAfterOutcome({ state: api.readState(value, { plans: [first, second] }), plan: second,
      phaseState: 'blocked', blocker: 'observed interruption', updatedAt: timestamp }, { plans: [first, second] });
    expect(blocked.phases['local-inputs-valid'].operation).toEqual(value.phases['local-inputs-valid'].operation);
    expect(blocked.phases['local-inputs-valid'].executionPlanDigest).toBe(second.planDigest);
    expect(blocked.baselineAnchor).toBe(first.baselineDigest);
  });

  it('constructs only public credential2 and workflow-correct supersession2 metadata', () => {
    const api = contract('spec-kit');
    const { identity: _old, schemaVersion: _version, ...metadata } = validateHistoricalV3CredentialPolicy(capturedV3Records().credential);
    const fresh = api.createCredentialMetadata(metadata);
    expect(fresh.schemaVersion).toBe(2); expect(fresh.identity).toEqual(api.identity);
    expect(api.encodeRecord({ kind: 'credential-policy', record: fresh }).recordDigest).toBe(canonicalSha256(fresh));
    expect(() => api.readCredentialPolicy({ ...fresh, password: 'must-not-persist' })).toThrow(/prohibited sensitive/);
    expect(() => api.readCredentialPolicy({ ...fresh, expiresAt: fresh.createdAt })).toThrow();
    const record = api.createSupersession({ supersededChangeId: 'old-work', supersedingChangeId: 'reviewed-work',
      reason: 'explicit reconciliation', approvedAt: timestamp, approver: 'fixture-human' });
    expect(record.schemaVersion).toBe(2);
    expect(() => Reflect.apply(contract().createSupersession, undefined, [{ ...record, identity: undefined }])).toThrow();
    expect(() => contract().readSupersession(record)).toThrow(/Manual/);
  });

  it.each(['state', 'plan', 'approval', 'evidence', 'credential-policy', 'supersession'] as const)('does not infer %s from overlapping schemas', kind => {
    const api = contract('openspec'), value = initial(api);
    if (kind === 'state') expect(api.encodeRecord({ kind, record: value }).content.length).toBeGreaterThan(0);
    else expect(() => Reflect.apply(api.encodeRecord, undefined, [{ kind, record: value }])).toThrow();
    expect(() => Reflect.apply(api.encodeRecord, undefined, [{ kind, record: value, schemaVersion: 4 }])).toThrow();
  });

  it('rejects accessors, sparse collections, secrets and excessive nesting before decoder evaluation', () => {
    const api = contract(), state = structuredClone(initial(api)), getter = vi.fn(() => 'untrusted');
    Object.defineProperty(state, 'identity', { enumerable: true, get: getter });
    expect(() => api.readState(state)).toThrow(/own enumerable/); expect(getter).not.toHaveBeenCalled();
    expect(() => api.readState(initial(api), { plans: new Array(1) })).toThrow(/dense/);
    const draft = planInput(api);
    const operation = { adapter: 'local-evidence', actionId: 'local.read', phaseId: draft.phaseId,
      mutationClass: 'read-worktree', remote: false, destructive: false,
      destination: { type: 'local', identity: 'root' }, inputs: { password: 'private' } };
    expect(() => api.createPlan({ ...draft, operations: [operation] } as ModernPlanInput)).toThrow(/prohibited sensitive/);
    let nested: unknown = 'leaf'; for (let i = 0; i < 21; i++) nested = { next: nested };
    expect(() => api.readState(nested)).toThrow(/nesting depth/);
  });

  it('rejects extra caller commitment fields instead of overriding them during construction', () => {
    const api = contract();
    expect(() => Reflect.apply(api.createPlan, undefined, [{ ...planInput(api), planDigest: '0'.repeat(64) }])).toThrow(/not allowed/);
    expect(() => Reflect.apply(api.createInitialState, undefined, [{ repository, createdAt: timestamp,
      applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: false }, schemaVersion: 3 }])).toThrow(/not allowed/);
  });

  it.each(Object.keys(contract().identity))('rejects mismatched embedded identity field %s', field => {
    const api = contract(), state = structuredClone(initial(api));
    Reflect.set(state.identity, field, typeof Reflect.get(state.identity, field) === 'number' ? 99 : 'unknown');
    expect(() => api.readState(state)).toThrow(/exact modern source/);
  });

  it('rejects old local success, fabricated terminal outcomes and wrong workflow pointers', () => {
    const api = contract(), state = structuredClone(initial(api));
    Reflect.set(state.phases, 'seed-archived', state.phases['local-complete']);
    expect(() => api.readState(state)).toThrow(/canonical phase/);
    Reflect.deleteProperty(state.phases, 'seed-archived');
    state.phases['local-complete'].state = 'verified';
    expect(() => api.readState(state)).toThrow(/outcome reference/);
    const manual = structuredClone(initial(api));
    Reflect.set(manual, 'activeChange', { id: 'fabricated-framework', kind: 'openspec' });
    expect(() => api.readState(manual)).toThrow(/workflow/);
    const external = contract('spec-kit'), wrong = structuredClone(initial(external));
    Reflect.set(wrong, 'activeChange', { id: 'wrong-framework', kind: 'openspec' });
    expect(() => external.readState(wrong)).toThrow(/workflow/);
  });

  it('does not let a producer label bypass original saved-plan references', () => {
    const api = contract(), plan = api.createPlan(planInput(api));
    const value = structuredClone(proof(api, plan));
    value.header.producer = 'unrelated-observer';
    const payload = historyRecord(value.payload, 'payload');
    delete payload.planDigest; delete payload.savedPlanDigest;
    value.header.bodyDigest = canonicalSha256({ payload, liveReadback: [] });
    expect(() => api.readEvidence(value)).toThrow(/both original reviewed plan commitments/);
  });

  it('retains an expired/invalidated approval observation without relabeling it usable consent', () => {
    const api = contract('openspec'), unapproved = api.createPlan(planInput(api, 'activation-approved')), envelope = approval(api, unapproved);
    const expired = structuredClone(unapproved);
    expired.approval.envelopeId = envelope.id;
    expired.approval.evaluation = { ...expired.approval.evaluation, envelopeId: envelope.id, status: 'expired', reasons: ['original observed expiry'] };
    expect(api.readPlan(expired, { approvals: [envelope] }).approval.evaluation.status).toBe('expired');
    expect(() => api.stateAfterOutcome({ state: initial(api), plan: expired, phaseState: 'approved', updatedAt: timestamp },
      { plans: [expired], approvals: [envelope] })).toThrow(/stored consent/);
    const invalidated = structuredClone(expired), hash = approvalHash(api, envelope);
    invalidated.approval.envelopeHash = hash;
    invalidated.approval.evaluation = { ...invalidated.approval.evaluation, envelopeHash: hash, status: 'invalidated',
      reasons: ['original plan changed'] };
    expect(api.readPlan(invalidated, { approvals: [envelope] }).approval.evaluation.status).toBe('invalidated');
    const forged = structuredClone(unapproved); forged.approval.evaluation.status = 'reused';
    expect(() => api.readPlan(forged)).toThrow(/distinguish missing/);
  });

  it('requires full original output/resource receipts and preserves older blocked-state outputs', () => {
    const api = contract(), plan = api.createPlan(planInput(api, 'local-inputs-valid'));
    const outputs = { values: { binding: 'original' }, resources: [{ provider: 'github' as const, resourceId: 'receipt-id', resourceType: 'repository' }] };
    const transition = { phaseId: plan.phaseId, baselineSha: plan.baselineDigest, inputDigest: plan.inputDigest, transitionDigest: plan.transitionDigest };
    const readback: Parameters<typeof api.createEvidence>[0]['liveReadback'] = [{
      schemaVersion: 4, repositoryId: repository.id, identity: api.identity, phaseGraphHash: api.identity.phaseGraphHash,
      phaseId: plan.phaseId, baselineSha: plan.baselineDigest, inputDigest: plan.inputDigest, transition, observedAt: timestamp,
      provider: 'github', resourceId: 'receipt-id', resourceType: 'repository', sourceDigest: 'd'.repeat(64),
      readbackDigest: 'e'.repeat(64), matches: true
    }];
    const evidence = api.createEvidence({ plan, evidenceId: 'actual-synthetic-receipt', repositoryId: repository.id,
      producedAt: timestamp, producer: 'synthetic-observation', result: 'verified',
      payload: { kind: 'local-inputs-valid.v1', outputBindings: outputs }, liveReadback: readback });
    const related = { plans: [plan], evidence: [evidence] };
    const completed = api.stateAfterOutcome({ state: initial(api), plan, phaseState: 'verified', updatedAt: timestamp,
      evidenceId: evidence.evidenceId, outputs }, related);
    const blocked = structuredClone(completed); blocked.phases['local-inputs-valid'].state = 'blocked';
    expect(api.readState(blocked, related).phaseOutputs).toEqual(completed.phaseOutputs);
    const bad = structuredClone(completed);
    Reflect.set(bad.phaseOutputs!['local-inputs-valid']!.resources[0], 'resourceId', 'unobserved');
    expect(() => api.readState(bad, related)).toThrow(/resource receipt/);
    expect(() => api.readState(completed, { plans: [plan] })).toThrow(/references/);
  });

  it('refuses an unallocated projection mutation instead of inventing modern source metadata', () => {
    const api = contract('openspec'), draft = planInput(api, 'local-baseline-verified');
    const projection = { schemaVersion: 1, derivation: 'validated-current-readiness', source: 'existing', changeId: 'reviewed-change',
      workflowKind: 'openspec', taskPathParts: ['openspec', 'changes', 'reviewed-change', 'tasks.md'],
      metadataPathParts: ['openspec', 'changes', 'reviewed-change', 'liftoff-governance.json'],
      metadataHash: 'e'.repeat(64), layoutHash: 'f'.repeat(64) };
    const phase = api.graph.phases.find(phase => phase.allowedMutations.local.includes('project-governance-tasks'));
    expect(phase).toBeUndefined();
    expect(() => api.createPlan({ ...draft, operations: [{ phaseId: draft.phaseId, adapter: 'local-evidence',
        actionId: 'governance.tasks.project', mutationClass: 'project-governance-tasks', remote: false, destructive: false,
        inputs: { projection }, destination: { type: 'local', identity: projection.taskPathParts.join('/'), pathParts: projection.taskPathParts } }] }))
      .toThrow(/outside phase/);
  });

  it('preserves explicit JSON nesting threshold and never evaluates an input hook', () => {
    const api = contract(), plan = api.createPlan(planInput(api));
    // Payload wrapper adds two levels; a property chain of eighteen reaches the existing depth20 bound.
    const payload: Record<string, unknown> = { kind: 'local-inputs-valid.v1' };
    let nested: unknown = 'value'; for (let i = 0; i < 17; i++) nested = { data: nested };
    payload.details = nested;
    expect(() => proof(api, plan, payload)).not.toThrow();
    for (let i = 0; i < 5; i++) nested = { data: nested };
    payload.details = nested;
    expect(() => proof(api, plan, payload)).toThrow(/nesting depth/);
  });

  it.each([
    { terraform_version: '1.9.0', resources: [] },
    { serial: 1, lineage: 'private', outputs: {} },
    { planned_values: { root_module: {} } },
    { prior_state: { resources: [] } },
    { raw_state: 'never-public' },
    JSON.stringify({ resource_changes: [] }),
    JSON.stringify({ nested: JSON.stringify({ terraform_version: '1.9.0', values: {} }) }),
    '{"terraform_version": "truncated sensitive payload',
    'Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  ])('rejects prohibited state/plan/credential payloads on constructors, direct readers and encoders %#', payload => {
    const api = contract(), plan = api.createPlan(planInput(api));
    expect(() => proof(api, plan, { kind: 'local-inputs-valid.v1', details: payload })).toThrow(/prohibited sensitive/);
    const record = structuredClone(proof(api, plan));
    const body = { ...historyRecord(record.payload, 'payload'), details: payload };
    record.payload = body; record.header.bodyDigest = canonicalSha256({ payload: body, liveReadback: [] });
    expect(() => api.readEvidence(record, { plans: [plan] })).toThrow(/prohibited sensitive/);
    expect(() => api.encodeRecord({ kind: 'evidence', record }, { plans: [plan] })).toThrow(/prohibited sensitive/);
  });
});
