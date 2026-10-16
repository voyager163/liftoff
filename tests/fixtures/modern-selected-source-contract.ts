import { projectCatalog } from '../../src/application/project/catalog.js';
import { createManifestV8ProjectReader } from '../../src/domain/project/manifest/v8-project.js';
import { canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import { createModernActivationIdentityReader, type ModernIdentityCreationInput } from '../../src/domain/governance/activation/modern-identity.js';
import { createModernActivationRecordContract, type ModernPlanInput } from '../../src/domain/governance/activation/modern-records.js';
import { modernActivationRecordValidators } from '../../src/domain/governance/activation/record-validation.js';
import { createModernGovernanceSourceContract } from '../../src/domain/governance/activation/modern-source-metadata.js';
import { readableModernActivationSourceContracts } from '../../src/domain/governance/policy/identity.js';
import type { ModernActivationSelection, ModernActivationSourceContract, ModernActivationSourceInput, ModernPhaseId } from '../../src/domain/governance/activation/modern-record-contracts.js';
import { capturedV3Records } from './activation-v3/fixture.js';
import { historyRecord } from '../../src/governance-activation/history-contracts.js';
import { validateHistoricalV3CredentialPolicy } from '../../src/governance-activation/historical-v3.js';

export function selectedSourceCases() {
  const reader = createModernActivationIdentityReader(projectCatalog);
  return readableModernActivationSourceContracts().map(source => {
    const { profile, workflow } = source.identity;
    const original = historyRecord(historyRecord(capturedV3Records().manifest, 'manifest').project, 'project');
    const project = { ...original, specWorkflow: workflow, agents: workflow === 'manual' ? [] : ['github-copilot', 'claude'],
      ...(workflow === 'spec-kit' ? { defaultAgent: 'github-copilot' } : {}) };
    if (workflow !== 'spec-kit') Reflect.deleteProperty(project, 'defaultAgent');
    const framework = workflow === 'manual' ? { state: 'not-required' } :
      { state: 'initialized', adapter: workflow, contractVersion: '1.2.3' };
    const selection: ModernActivationSelection = {
      ...createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({ project, framework }), profile
    };
    const request: ModernIdentityCreationInput = {
      sourceVersion: '0.13.0-dev.0', profile, policyVersion: source.identity.policyVersion, selection,
      pluginResolutionDigest: `sha256:${canonicalSha256({ unitOnly: 'independent plugin commitment' })}`,
      activeLayoutDigest: `sha256:${canonicalSha256({ unitOnly: 'independent layout commitment' })}`
    };
    const recordedIdentity = reader.identityForReadableSource({ ...request, phaseGraphHash: source.identity.phaseGraphHash });
    const { sourceVersion: _version, ...context } = request;
    const input = structuredClone({ ...context, recordedIdentity }) satisfies ModernActivationSourceInput;
    return { source, request, input, recordedIdentity };
  });
}

export function countSourceClones<T>(read: () => T) {
  const original = globalThis.structuredClone;
  const hashes: Record<string, number> = {};
  const counts = { arrayCalls: 0, rowCalls: 0, graphRows: 0, bareGraphCalls: 0, otherCalls: 0, hashes };
  const row = (value: unknown): value is ModernActivationSourceContract =>
    typeof value === 'object' && value !== null && Object.hasOwn(value, 'graph') && Object.hasOwn(value, 'identity');
  const add = (value: ModernActivationSourceContract) => {
    counts.graphRows++;
    const hash = value.identity.phaseGraphHash;
    counts.hashes[hash] = (counts.hashes[hash] ?? 0) + 1;
  };
  const observe: typeof globalThis.structuredClone = (value, options) => {
    if (Array.isArray(value) && value.some(row)) {
      counts.arrayCalls++;
      for (const entry of value) if (row(entry)) add(entry);
    } else if (row(value)) {
      counts.rowCalls++; add(value);
    } else if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'phases') &&
      Object.hasOwn(value, 'completionGroups')) counts.bareGraphCalls++;
    else counts.otherCalls++;
    return original(value, options);
  };
  globalThis.structuredClone = observe;
  try { return { value: read(), counts }; } finally { globalThis.structuredClone = original; }
}

export const selectedFactories = {
  validators: (input: ModernActivationSourceInput) => modernActivationRecordValidators(projectCatalog, input),
  records: (input: ModernActivationSourceInput) => createModernActivationRecordContract(projectCatalog, input),
  metadata: (input: ModernActivationSourceInput) => createModernGovernanceSourceContract(projectCatalog, input)
};

export function selectedInvalidIdentityControls() {
  return selectedSourceCases().flatMap(({ input }) => Object.keys(input.recordedIdentity).flatMap(field =>
    Object.entries(selectedFactories).map(([factory, create]) => {
      const invalid = structuredClone(input);
      Reflect.set(invalid.recordedIdentity, field, typeof Reflect.get(invalid.recordedIdentity, field) === 'number' ? 99 : 'unknown');
      const observed = countSourceClones(() => {
        let caught: unknown;
        try { create(invalid); } catch (error: unknown) { caught = error; }
        if (!(caught instanceof Error)) throw new Error('Invalid selected identity did not reject with its original error.');
        return { name: caught.name, message: caught.message };
      });
      return { hash: input.recordedIdentity.phaseGraphHash, field, factory, ...observed };
    })
  ));
}

export function sourceFactorySnapshot(input: ModernActivationSourceInput) {
  const api = selectedFactories.records(input);
  const timestamp = '2026-09-01T00:00:00.000Z', expiry = '2026-09-02T00:00:00.000Z';
  const repository = { id: 'local:11111111-1111-4111-8111-111111111111', name: 'selected-fixture', defaultBranch: 'develop' };
  const planInput = (id: ModernPhaseId): ModernPlanInput => {
    const phase = api.graph.phases.find(phase => phase.id === id)!;
    return {
      phaseId: id, createdAt: timestamp, expiresAt: expiry, stateHash: null, baselineDigest: 'a'.repeat(64),
      inputDigest: 'b'.repeat(64), transitionDigest: 'c'.repeat(64), operations: [],
      approval: { gateKind: phase.approvalGate.kind, required: phase.approvalGate.required, envelopeId: null, envelopeHash: null,
        evaluation: { phaseId: id, gateKind: phase.approvalGate.kind, questionKind: null, approvalRequired: phase.approvalGate.required,
          status: phase.approvalGate.required ? 'approval-required' : 'not-required', envelopeId: null, envelopeHash: null,
          reasons: [], expansionReasons: [] } },
      rollbackPlan: { phaseId: id, strategy: phase.rollback.kind, target: phase.rollback.target,
        operations: [], retained: [], cleanupWarnings: [] }, noSecrets: true,
      ...(['activation-plan', 'infrastructure-cost'].includes(phase.approvalGate.kind) ? {
        configuration: { schemaVersion: 1 as const, phases: {},
          budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 } }
      } : {})
    };
  };
  const state = api.createInitialState({ repository, createdAt: timestamp,
    applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' } });
  const plan = api.createPlan(planInput('local-inputs-valid'));
  const approval = api.createApproval({
    plan: api.createPlan(planInput('activation-approved')), id: 'format-only-consent',
    resources: [], destinations: [], permissions: [], costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
    policyExceptions: [], destructiveScope: [], approvedAt: timestamp, expiresAt: expiry, approver: 'format-fixture-not-live-authority'
  });
  const evidence = api.createEvidence({ plan, evidenceId: 'format-only-evidence', repositoryId: repository.id,
    producedAt: timestamp, producer: 'format-fixture-not-live-proof', result: 'verified',
    payload: { kind: 'local-inputs-valid.v1' } });
  const related = { plans: [plan], evidence: [evidence] };
  const completed = api.stateAfterOutcome({ state, plan, phaseState: 'verified', updatedAt: timestamp,
    evidenceId: evidence.evidenceId }, related);
  const { identity: _old, schemaVersion: _schema, ...credentialInput } =
    validateHistoricalV3CredentialPolicy(capturedV3Records().credential);
  const credential = api.createCredentialMetadata(credentialInput);
  const supersession = api.identity.workflow === 'manual' ? null : api.createSupersession({
    supersededChangeId: 'old-work', supersedingChangeId: 'reviewed-work', reason: 'format-only explicit reconciliation',
    approvedAt: timestamp, approver: 'format-fixture-not-live-authority'
  });
  const records = { state, completed, plan, approval, evidence, credential, supersession };
  const encoded = {
    state: Buffer.from(api.encodeRecord({ kind: 'state', record: state }).content).toString(),
    completed: Buffer.from(api.encodeRecord({ kind: 'state', record: completed }, related).content).toString(),
    plan: Buffer.from(api.encodeRecord({ kind: 'plan', record: plan }).content).toString(),
    approval: Buffer.from(api.encodeRecord({ kind: 'approval', record: approval }).content).toString(),
    evidence: Buffer.from(api.encodeRecord({ kind: 'evidence', record: evidence }, related).content).toString(),
    credential: Buffer.from(api.encodeRecord({ kind: 'credential-policy', record: credential }).content).toString(),
    supersession: supersession === null ? null :
      Buffer.from(api.encodeRecord({ kind: 'supersession', record: supersession }).content).toString()
  };
  const metadata = api.identity.workflow === 'manual' ? null : (() => {
    const contract = selectedFactories.metadata(input);
    const created = contract.create({ changeId: 'reviewed-work', baselineSha: 'a'.repeat(64),
      createdFrom: { kind: 'approved-phase-0-facts', approvedFactDigest: 'd'.repeat(64), evidenceIds: ['format-facts'] },
      acknowledgedAt: timestamp, owner: 'format-fixture-not-live-authority' });
    return { created, encoded: contract.encode(created), graph: contract.graph };
  })();
  return { identity: api.identity, graph: api.graph, records, encoded, metadata };
}
