import { describe, expect, it, vi } from 'vitest';
import { projectCatalog } from '../src/application/project/catalog.js';
import {
  applicationPublicationSourceContracts, applicationPublicationSourceContract, applicationPublicationSourceIdentityTable,
  modernActivationSourceContracts, preWorkflowModernActivationSourceContracts, preCustodyModernActivationSourceContracts,
  readableModernActivationSourceContracts
} from '../src/domain/governance/policy/identity.js';
import { buildModernPhaseGraph, modernPhaseContractDigests } from '../src/domain/governance/activation/modern-graph.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import {
  createApplicationPublicationIdentityReader, createModernActivationIdentityReader
} from '../src/domain/governance/activation/modern-identity.js';
import {
  createApplicationPublicationRecordContract, createModernActivationRecordContract, type ModernPlanInput
} from '../src/domain/governance/activation/modern-records.js';
import { applicationPublicationRecordValidators, modernActivationRecordValidators } from '../src/domain/governance/activation/record-validation.js';
import {
  applicationPublicationActionId, assertDigestApplicationPublicationOperation, readDigestApplicationPublicationReceipt,
  type DigestApplicationPublicationReceipt
} from '../src/domain/governance/activation/application-publication-values.js';
import {
  canonicalApprovalEnvelopeValues, normalizeApprovalScopeValues, plannedApprovalDestinations,
  plannedApprovalMutations, plannedApprovalResources
} from '../src/domain/governance/activation/source-values.js';
import type { ModernActivationSourceContract, ModernActivationSourceInput, ModernPhaseId } from '../src/domain/governance/activation/modern-record-contracts.js';
import type { ExternalOperationStateFieldsV1 } from '../src/domain/governance/activation/record-contracts.js';
import { readVerifiedDigestApplicationArtifact } from '../src/governance-activation/application-artifact-digest-consumer.js';
import { assertSource5WorkflowContext, createSource5WorkflowContext } from '../src/governance-activation/workflow-source5-context.js';
import { applicationArtifactDigestBlockers } from '../src/governance-activation/application-artifact-digest-recipe.js';
import { selectedSourceCases } from './fixtures/modern-selected-source-contract.js';

const originalCases = selectedSourceCases(), sources = applicationPublicationSourceContracts();
const at = '2026-09-01T00:00:00.000Z', expiry = '2026-09-02T00:00:00.000Z';
const repository = { id: 'local:11111111-1111-4111-8111-111111111111', name: 'format-only', defaultBranch: 'develop' };
const registryId = '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/unit/providers/Microsoft.ContainerRegistry/registries/unitregistry';
const unitDigest = (label: string) => canonicalSha256({ formatOnly: label });
const inputs = {
  repository: 'unit/format-only', sourceSha: 'a'.repeat(40), sourceTreeSha: 'b'.repeat(40),
  executionRef: `liftoff-execution-${'a'.repeat(40)}`,
  workflowDigest: unitDigest('workflow'), contextDigest: unitDigest('context'), programDigest: unitDigest('program'),
  bindingDigest: unitDigest('binding'), environment: 'dev', registryId, loginServer: 'unitregistry.azurecr.io',
  imageRepository: 'unit/application'
};
function contract(source: ModernActivationSourceContract = sources[0]) {
  const previous = originalCases.find(row => row.recordedIdentity.activationContractVersion === 5 &&
    row.recordedIdentity.profile === source.identity.profile && row.recordedIdentity.workflow === source.identity.workflow)!;
  const identity = createApplicationPublicationIdentityReader(projectCatalog).identityForReadableSource({
    ...previous.request, phaseGraphHash: source.identity.phaseGraphHash
  });
  const context: ModernActivationSourceInput = { ...previous.input, recordedIdentity: identity };
  return { api: createApplicationPublicationRecordContract(projectCatalog, context), context, previous };
}
type Contract = ReturnType<typeof contract>['api'];
function planInput(api: Contract, id: ModernPhaseId = 'application-artifact-ready'): ModernPlanInput {
  const node = api.graph.phases.find(phase => phase.id === id)!;
  const destination = { type: 'repository' as const, identity: inputs.repository, repository: inputs.repository, ref: inputs.executionRef };
  return {
    phaseId: id, createdAt: at, expiresAt: expiry, stateHash: null, baselineDigest: unitDigest('baseline'),
    inputDigest: unitDigest('input'), transitionDigest: unitDigest(`transition:${id}`),
    operations: id === 'application-artifact-ready' ? [{
      phaseId: id, adapter: 'github', actionId: applicationPublicationActionId,
      mutationClass: 'github-workflow-dispatch', inputs, destination, remote: true, destructive: false,
      effects: [
        { mutationClass: 'registry-publish', destination: { type: 'subscription', identity: registryId },
          remote: true, destructive: false },
        { mutationClass: 'github-attestation-write', destination, remote: true, destructive: false }
      ]
    }] : [],
    approval: {
      gateKind: node.approvalGate.kind, required: node.approvalGate.required, envelopeId: null, envelopeHash: null,
      evaluation: { phaseId: id, gateKind: node.approvalGate.kind, questionKind: null,
        approvalRequired: node.approvalGate.required, status: node.approvalGate.required ? 'approval-required' : 'not-required',
        envelopeId: null, envelopeHash: null, reasons: [], expansionReasons: [] }
    },
    rollbackPlan: { phaseId: id, strategy: node.rollback.kind, target: node.rollback.target, operations: [], retained: [], cleanupWarnings: [] },
    configuration: { schemaVersion: 1, phases: {}, budget: { currency: 'USD', fixedMonthlyCents: 100, usageMonthlyCents: 200 } },
    noSecrets: true
  };
}
function approved(api: Contract, input = planInput(api), suffix = '') {
  const draft = api.createPlan(input);
  const effects = draft.operations.flatMap(operation => [operation, ...(operation.effects ?? [])]);
  const approval = api.createApproval({
    plan: draft, id: `format-consent-${draft.phaseId}${suffix}`, resources: plannedApprovalResources(effects),
    destinations: plannedApprovalDestinations(effects), permissions: plannedApprovalMutations(effects),
    costCeiling: { currency: 'USD', fixedMonthlyCents: 100, usageMonthlyCents: 200 },
    policyExceptions: [], destructiveScope: [], expiresAt: expiry, approvedAt: at, approver: 'format-only-not-live-authority'
  });
  const copy = structuredClone(draft);
  const hash = canonicalSha256(canonicalApprovalEnvelopeValues(approval,
    normalizeApprovalScopeValues(approval, api.graph.phases.map(phase => phase.id))));
  Object.assign(copy.approval, { envelopeId: approval.id, envelopeHash: hash });
  Object.assign(copy.approval.evaluation, { status: 'reused', envelopeId: approval.id, envelopeHash: hash });
  return { plan: api.readPlan(copy, { approvals: [approval] }), approval };
}

function fixture(options: {
  receipt?: Partial<DigestApplicationPublicationReceipt>;
  values?: Readonly<Record<string, string>>;
  omitResource?: 'github' | 'azure';
  revision?: string;
} = {}) {
  const { api, context } = contract(), { plan, approval } = approved(api,
    { ...planInput(api), ...(options.revision ? { transitionDigest: unitDigest(options.revision) } : {}) }, options.revision);
  const runId = options.revision ? 23 : 22, jobId = options.revision ? 34 : 33;
  const run = `/repos/${inputs.repository}/actions/runs/${runId}`;
  const operation: ExternalOperationStateFieldsV1 = {
    provider: 'github', actionId: applicationPublicationActionId, operationId: `github-actions:${runId}`,
    resourceId: run, startedAt: at, observedAt: at, status: 'completed', pollUrl: `https://api.github.com${run}`,
    planDigest: plan.planDigest
  };
  const artifactDigest = `sha256:${unitDigest('image')}`;
  const receipt: DigestApplicationPublicationReceipt = {
    schemaVersion: 2, kind: 'application-artifact-publication.v2', recipeVersion: 'oci-digest-v1',
    repository: inputs.repository, sourceSha: inputs.sourceSha, sourceTreeSha: inputs.sourceTreeSha,
    workflowDigest: inputs.workflowDigest, contextDigest: inputs.contextDigest, programDigest: inputs.programDigest,
    executionRef: `liftoff-execution-${inputs.sourceSha}`, workflowId: 11, workflowRunId: runId, workflowJobId: jobId, attempt: 1,
    environment: 'dev', registryResourceId: registryId, loginServer: inputs.loginServer, imageRepository: inputs.imageRepository,
    artifactDigest, immutableImage: `${inputs.loginServer}/${inputs.imageRepository}@${artifactDigest}`,
    artifactBindingDigest: inputs.bindingDigest, planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan),
    originalOperationDigest: canonicalSha256(operation), attestationVerificationDigest: unitDigest('attestation'),
    authenticatedDeliveryDigest: unitDigest('delivery'), wholeJobCustodyDigest: unitDigest('custody'),
    toolQualificationDigest: unitDigest('tools'), ...options.receipt
  };
  const output = {
    values: {
      sourceSha: receipt.sourceSha, sourceTreeSha: receipt.sourceTreeSha, workflowDigest: receipt.workflowDigest,
      environment: receipt.environment, registryResourceId: receipt.registryResourceId,
      imageRepository: receipt.imageRepository, artifactDigest: receipt.artifactDigest, immutableImage: receipt.immutableImage,
      publicationReceiptDigest: canonicalSha256(receipt), ...options.values
    },
    resources: [
      { provider: 'github' as const, resourceType: 'workflow-run', resourceId: run },
      { provider: 'azure' as const, resourceType: 'container-image',
        resourceId: `${registryId}/repositories/${receipt.imageRepository}@${receipt.artifactDigest}` }
    ].filter(resource => resource.provider !== options.omitResource)
  };
  const transition = { phaseId: plan.phaseId, baselineSha: plan.baselineDigest, inputDigest: plan.inputDigest,
    transitionDigest: plan.transitionDigest };
  const liveReadback = [
    { provider: 'github' as const, resourceType: 'workflow-run', resourceId: run },
    { provider: 'github' as const, resourceType: 'workflow-job',
      resourceId: `/repos/${inputs.repository}/actions/jobs/${receipt.workflowJobId}` },
    { provider: 'azure' as const, resourceType: 'container-image',
      resourceId: `${registryId}/repositories/${receipt.imageRepository}@${receipt.artifactDigest}` }
  ].map(resource => ({
    ...resource, schemaVersion: 4 as const, repositoryId: repository.id, identity: api.identity,
    phaseGraphHash: api.identity.phaseGraphHash, phaseId: plan.phaseId, baselineSha: plan.baselineDigest,
    inputDigest: plan.inputDigest, transition, observedAt: at, sourceDigest: unitDigest('observation-source'),
    readbackDigest: unitDigest('observation-format'), matches: true
  }));
  const evidence = api.createEvidence({
    plan, evidenceId: `format-publication${options.revision ?? ''}`, repositoryId: repository.id, producedAt: at, producer: 'synthetic-record-format-only',
    result: 'verified', payload: { kind: 'application-artifact-ready.v2', publication: receipt,
      deploymentPerformed: false, outputBindings: output }, liveReadback
  }, { approvals: [approval] });
  const related = { plans: [plan], approvals: [approval], evidence: [evidence] };
  const initial = api.createInitialState({ repository, createdAt: at,
    applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' } });
  const state = api.stateAfterOutcome({ state: initial, plan, phaseState: 'verified', updatedAt: at,
    evidenceId: evidence.evidenceId, operation, outputs: output }, related);
  return { api, context, plan, approval, receipt, evidence, operation, related, state, initial, output };
}

function resealEvidence(value: ReturnType<typeof fixture>['evidence']) {
  value.header.bodyDigest = canonicalSha256({
    payload: value.payload,
    liveReadback: [...(value.liveReadback ?? [])].sort((a, b) => canonicalSha256(a).localeCompare(canonicalSha256(b), 'en'))
  });
  return value;
}

describe('explicit unpublished publication source6 allocation, not producer qualification', () => {
  it('preserves every frozen source4/source5 getter, graph, packaged table and default selector', () => {
    expect(canonicalSha256(modernActivationSourceContracts())).toBe('dcf71aa7039fd27307b8fa7e47f3a9577af6bca1b42007b5c6d50ca6afe8c71d');
    expect(canonicalSha256(preWorkflowModernActivationSourceContracts())).toBe('343d62d5a939134e8799d93d544f1f2d5959c0d729c9c3f263862fa505c40289');
    expect(canonicalSha256(preCustodyModernActivationSourceContracts())).toBe('1063f49769a76f3ed56458a970f75bbd6aaa51ca63be9795a2805215f565cd29');
    expect(canonicalSha256(readableModernActivationSourceContracts())).toBe('ae79ca38bc3a17eb24fb207bd2a58e30aa6d95a178ab6cfdce12cc257b46b252');
    expect(new Set(sources.map(source => source.identity.phaseGraphHash)).size).toBe(6);
    expect(applicationPublicationSourceIdentityTable()).toEqual(sources.map(source => source.identity));
    expect(applicationPublicationSourceContract('unregistered')).toBeUndefined();
  });
  it.each(sources)('allocates only the intended successor behavior for $identity.profile/$identity.workflow', source => {
    const previous = modernActivationSourceContracts().find(row =>
      row.identity.profile === source.identity.profile && row.identity.workflow === source.identity.workflow)!;
    expect(source.identity).toEqual({ ...previous.identity, activationContractVersion: 6,
      phaseGraphHash: canonicalSha256(source.graph) });
    expect(source.compatibilityMetadataSchemaVersion).toBe(6);
    expect(source.savedPlanSchemaVersion).toBe(3);
    expect(source.graph).toEqual({
      ...previous.graph, versions: { ...previous.graph.versions, activationContractVersion: 6 },
      phases: previous.graph.phases.map(phase => phase.id === 'application-artifact-ready' ? {
        ...phase, allowedMutations: { ...phase.allowedMutations, remote: [...phase.allowedMutations.remote, 'github-attestation-write'] },
        evidence: { ...phase.evidence, schema: 'application-artifact-ready.v2' }
      } : phase.id === 'application-foundation' ? { ...phase, evidence: { ...phase.evidence, schema: 'application-foundation.v2' } } : phase)
    });
    expect(() => buildModernPhaseGraph(source.identity, source.graph.profileContract, source.identity.workflow)).toThrow(/separate graph/);
    const first = applicationPublicationSourceContract(source.identity.phaseGraphHash)!;
    expect(first).toEqual(source); expect(first).not.toBe(source);
    expect(Object.isFrozen(first.graph.phases)).toBe(true);
    expect(modernPhaseContractDigests(first.graph)['application-artifact-ready'])
      .not.toBe(modernPhaseContractDigests(previous.graph)['application-artifact-ready']);
    const { api, context, previous: original } = contract(source);
    const reader = createApplicationPublicationIdentityReader(projectCatalog);
    expect(reader.identityForSource(original.request)).toEqual(api.identity);
    expect(reader.validateReadableModernActivationIdentity(context)).toEqual(api.identity);
    expect(() => createModernActivationIdentityReader(projectCatalog).validateReadableModernActivationIdentity(context)).toThrow();
    expect(() => createModernActivationRecordContract(projectCatalog, context)).toThrow();
    expect(() => modernActivationRecordValidators(projectCatalog, context)).toThrow();
    expect(() => createSource5WorkflowContext(projectCatalog, context)).toThrow();
    expect(() => assertSource5WorkflowContext({ records: api })).toThrow(/structural/);
    expect(() => reader.validateReadableModernActivationIdentity(original.input)).toThrow();
    expect(() => applicationPublicationRecordValidators(projectCatalog, original.input)).toThrow();
    const state = api.createInitialState({ repository, createdAt: at,
      applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' } });
    expect(api.readState(JSON.parse(Buffer.from(api.encodeRecord({ kind: 'state', record: state }).content).toString()))).toEqual(state);
    const { plan, approval } = approved(api);
    expect(api.readPlan(plan, { approvals: [approval] })).toEqual(plan);
    expect(approval.permissions).toContain('github-attestation-write');
  });
  it.each(Object.keys(sources[0].identity))('rejects mixed/future successor field %s before creating records', field => {
    const { context } = contract(), changed = structuredClone(context);
    if (!isRecord(changed.recordedIdentity)) throw new Error('Expected the source6 fixture identity.');
    Reflect.set(changed.recordedIdentity, field, typeof Reflect.get(changed.recordedIdentity, field) === 'number' ? 999 : 'unsupported');
    expect(() => createApplicationPublicationRecordContract(projectCatalog, changed)).toThrow();
  });
  it('does not remove the current route blockers or manufacture execution authority from an allocation', () => {
    expect(applicationArtifactDigestBlockers).toHaveLength(4);
    expect(applicationArtifactDigestBlockers[3]).toContain('unallocated');
    expect(sources.every(row => !Object.hasOwn(row, 'qualified') && !Object.hasOwn(row, 'authority'))).toBe(true);
  });
});

describe('source6 plan permission and original-record boundaries', () => {
  it.each(['legacy-action', 'missing-attestation', 'duplicate-attestation', 'wrong-repository',
    'wrong-registry', 'destructive', 'local', 'duplicate-dispatch', 'wrong-ref', 'wrong-repository-scope',
    'extra-dispatch-effect', 'rollback-dispatch'] as const)('rejects %s rather than borrowing v1/source5 authority', change => {
    const { api } = contract(), input = structuredClone(planInput(api)), operation = input.operations[0];
    if (change === 'legacy-action') Reflect.set(operation, 'actionId', 'github.artifact.build-dispatch');
    if (change === 'missing-attestation') Reflect.set(operation, 'effects', operation.effects!.slice(0, 1));
    if (change === 'duplicate-attestation') Reflect.set(operation, 'effects', [...operation.effects!, operation.effects![1]]);
    if (change === 'wrong-repository') Reflect.set(operation.effects![1].destination, 'identity', 'unit/other');
    if (change === 'wrong-registry') Reflect.set(operation.effects![0].destination, 'identity', `${registryId}other`);
    if (change === 'destructive') Reflect.set(operation.effects![1], 'destructive', true);
    if (change === 'local') Reflect.set(operation.effects![1], 'remote', false);
    if (change === 'duplicate-dispatch') Reflect.set(input, 'operations', [operation, operation]);
    if (change === 'wrong-ref') Reflect.set(operation.destination, 'ref', 'develop');
    if (change === 'wrong-repository-scope') Reflect.set(operation.destination, 'repository', 'unit/other');
    if (change === 'extra-dispatch-effect') Reflect.set(operation, 'effects',
      [...operation.effects!, { ...operation.effects![0], mutationClass: 'github-workflow-dispatch' }]);
    if (change === 'rollback-dispatch') Reflect.set(input.rollbackPlan, 'operations', [operation]);
    expect(() => api.createPlan(input)).toThrow();
  });
  it('retains new permissions in approval hashes and rejects a correctly rehashed narrower approval', () => {
    const { api } = contract(), { plan, approval } = approved(api), changed = structuredClone(approval);
    Reflect.set(changed, 'permissions', changed.permissions.filter(permission => permission !== 'github-attestation-write'));
    const copy = structuredClone(plan);
    const hash = canonicalSha256(canonicalApprovalEnvelopeValues(changed,
      normalizeApprovalScopeValues(changed, api.graph.phases.map(phase => phase.id))));
    Object.assign(copy.approval, { envelopeHash: hash });
    Object.assign(copy.approval.evaluation, { envelopeHash: hash });
    expect(() => api.readPlan(copy, { approvals: [changed] })).toThrow(/scope|permission/);
  });
  it('cannot allocate the new effect to another phase or parse it through the original source5 operation decoder', () => {
    const { api, previous } = contract(), input = planInput(api, 'application-foundation');
    expect(() => api.createPlan({ ...input, operations: planInput(api).operations.map(operation =>
      ({ ...operation, phaseId: 'application-foundation' })) })).toThrow(/outside phase/);
    const { plan } = approved(api);
    expect(() => modernActivationRecordValidators(projectCatalog, previous.input).records.validateSavedTransitionPlan({
      ...plan, identity: previous.recordedIdentity, graphHash: previous.recordedIdentity.phaseGraphHash
    })).toThrow(/mutationClass|mutation class|mutationClasses/);
  });
  it.each(['sourceSha', 'sourceTreeSha', 'workflowDigest', 'contextDigest', 'programDigest', 'artifactBindingDigest',
    'planDigest', 'savedPlanDigest'] as const)('binds receipt %s to the exact original reviewed plan', field => {
    const value = field === 'sourceSha' || field === 'sourceTreeSha' ? 'c'.repeat(40) : unitDigest(`changed:${field}`);
    expect(() => fixture({ receipt: { [field]: value,
      ...(field === 'sourceSha' ? { executionRef: `liftoff-execution-${value}` } : {}) } })).toThrow(/original.*plan|reviewed artifact binding/);
  });
});

describe('v2 receipt format and read-only original-publication consumer', () => {
  it('roundtrips all original bindings without fabricating an ACR run or claiming real producer qualification', () => {
    const value = fixture();
    expect(readDigestApplicationPublicationReceipt(JSON.parse(JSON.stringify(value.receipt)))).toEqual(value.receipt);
    expect(readVerifiedDigestApplicationArtifact(projectCatalog, value.context, value.state, value.related)).toEqual(value.receipt);
    expect(value.receipt).not.toHaveProperty('acrRunId');
    expect(value.receipt).not.toHaveProperty('qualified');
    expect(Object.isFrozen(readDigestApplicationPublicationReceipt(value.receipt))).toBe(true);
    expect(value.api.readEvidence(value.evidence, value.related)).toEqual(value.evidence);
  });
  it('retains older original evidence while selecting only the explicitly current reviewed plan and output', () => {
    const previous = fixture(), current = fixture({ revision: '-separate-reviewed-intent' });
    const related = {
      plans: [previous.plan, current.plan], approvals: [previous.approval, current.approval],
      evidence: [previous.evidence, current.evidence]
    };
    const state = current.api.stateAfterOutcome({
      state: previous.state, plan: current.plan, phaseState: 'verified', updatedAt: at,
      evidenceId: current.evidence.evidenceId, operation: current.operation, outputs: current.output
    }, related);
    expect(state.phases['application-artifact-ready'].evidence).toHaveLength(2);
    expect(readVerifiedDigestApplicationArtifact(projectCatalog, current.context, state, related)).toEqual(current.receipt);
    expect(previous.state.phases['application-artifact-ready'].operation).toEqual(previous.operation);
  });
  it('admits legitimate dot-prefixed repository names but rejects traversal-shaped names and malformed subscription IDs', () => {
    const { receipt } = fixture();
    expect(readDigestApplicationPublicationReceipt({ ...receipt, repository: 'unit/.github' }).repository).toBe('unit/.github');
    for (const repository of ['unit/.', 'unit/..']) {
      expect(() => readDigestApplicationPublicationReceipt({ ...receipt, repository })).toThrow();
    }
    expect(() => readDigestApplicationPublicationReceipt({ ...receipt,
      registryResourceId: receipt.registryResourceId.replace('11111111-1111-4111-8111-111111111111', '-----') })).toThrow();
  });
  it.each(['schemaVersion', 'kind', 'recipeVersion', 'attempt', 'environment', 'workflowId', 'workflowRunId',
    'workflowJobId', 'repository', 'sourceSha', 'sourceTreeSha', 'workflowDigest', 'contextDigest', 'programDigest',
    'executionRef', 'registryResourceId', 'loginServer', 'imageRepository', 'artifactDigest', 'immutableImage',
    'artifactBindingDigest', 'planDigest', 'savedPlanDigest', 'originalOperationDigest', 'attestationVerificationDigest',
    'authenticatedDeliveryDigest', 'wholeJobCustodyDigest', 'toolQualificationDigest'] as const)('rejects malformed receipt %s', field => {
    const { receipt } = fixture(), changed = structuredClone(receipt);
    Reflect.set(changed, field, typeof Reflect.get(changed, field) === 'number' ? 0 : 'invalid');
    expect(() => readDigestApplicationPublicationReceipt(changed)).toThrow();
  });
  it.each(['acrRunId', 'qualified', 'authority', 'success', 'extra'] as const)('rejects a legacy or authority-shaped extra %s', field => {
    expect(() => readDigestApplicationPublicationReceipt({ ...fixture().receipt, [field]: 'not-authority' })).toThrow(/exactly/);
  });
  it('rejects hooks and proxies without invoking them', () => {
    const { receipt } = fixture(), getter = vi.fn(() => 'dev');
    const changed = { ...receipt };
    Object.defineProperty(changed, 'environment', { enumerable: true, get: getter });
    expect(() => readDigestApplicationPublicationReceipt(changed)).toThrow(/data field/);
    const hook = vi.fn(() => 'dev');
    expect(() => readDigestApplicationPublicationReceipt({ ...receipt, environment: { toString: hook } })).toThrow(/environment/);
    expect(() => readDigestApplicationPublicationReceipt(new Proxy(receipt, {}))).toThrow(/plain JSON/);
    expect(getter).not.toHaveBeenCalled(); expect(hook).not.toHaveBeenCalled();
  });
  it.each(['missing', 'legacy-action', 'pending', 'other-run', 'other-resource', 'other-poll',
    'other-plan', 'other-start', 'other-digest'] as const)('rejects an original handle that is %s, even if other records are intact', change => {
    const { api, receipt, operation, state, related } = fixture(), copy = structuredClone(state), changed = { ...operation };
    if (change === 'legacy-action') changed.actionId = 'github.artifact.build-dispatch';
    if (change === 'pending') changed.status = 'running';
    if (change === 'other-run') changed.operationId = 'github-actions:23';
    if (change === 'other-resource') changed.resourceId += 'other';
    if (change === 'other-poll') changed.pollUrl += 'other';
    if (change === 'other-plan') changed.planDigest = unitDigest('different-plan');
    if (change === 'other-start') changed.startedAt = '2026-08-31T00:00:00.000Z';
    const checked = change === 'other-digest' ? { ...receipt, originalOperationDigest: unitDigest('other-operation') } : receipt;
    expect(() => assertDigestApplicationPublicationOperation(checked, change === 'missing' ? undefined : changed)).toThrow(/original completed/);
    if (change === 'missing') Reflect.deleteProperty(copy.phases['application-artifact-ready'], 'operation');
    else copy.phases['application-artifact-ready'].operation = changed;
    if (change !== 'other-digest') expect(() => api.readState(copy, related)).toThrow();
  });
  it.each(['immutableImage', 'artifactDigest', 'sourceSha', 'registryResourceId', 'publicationReceiptDigest'] as const)(
    'rejects contradictory %s even when the altered output has a valid enclosing body digest', field => {
      const value = fixture({ values: { [field]: 'different' } });
      expect(() => readVerifiedDigestApplicationArtifact(projectCatalog, value.context, value.state, value.related)).toThrow(/outputs contradict/);
    });
  it.each(['github', 'azure'] as const)('requires the original %s resource, not just a provider-shaped observation', provider => {
    const value = fixture({ omitResource: provider });
    expect(() => readVerifiedDigestApplicationArtifact(projectCatalog, value.context, value.state, value.related)).toThrow(/outputs contradict/);
  });
  it.each(['workflow-run', 'workflow-job', 'container-image'] as const)(
    'rejects missing original %s readback after recomputing the enclosing body digest', resourceType => {
      const value = fixture(), changed = structuredClone(value.evidence);
      changed.liveReadback = changed.liveReadback!.filter(proof => proof.resourceType !== resourceType);
      expect(() => value.api.readEvidence(resealEvidence(changed), value.related)).toThrow(/matching independent readback|declared provider/);
    });
  it('binds foundation v2 evidence to the same retained publication and rejects missing, replaced or v1 publications', () => {
    const value = fixture(), { api } = value, { plan, approval } = approved(api, planInput(api, 'application-foundation'));
    const liveReadback = value.evidence.liveReadback!.map(proof => ({
      ...proof, phaseId: plan.phaseId, baselineSha: plan.baselineDigest, inputDigest: plan.inputDigest,
      transition: { phaseId: plan.phaseId, baselineSha: plan.baselineDigest, inputDigest: plan.inputDigest,
        transitionDigest: plan.transitionDigest }
    }));
    const prior = { ...value.related, plans: [...value.related.plans, plan], approvals: [...value.related.approvals, approval] };
    const evidence = api.createEvidence({
      plan, evidenceId: 'format-foundation', repositoryId: repository.id, producedAt: at, producer: 'synthetic-foundation-format-only',
      result: 'verified', payload: { kind: 'application-foundation.v2', publication: value.receipt }, liveReadback
    }, prior);
    const related = { ...prior, evidence: [...prior.evidence, evidence] };
    expect(api.readEvidence(evidence, related)).toEqual(evidence);
    const state = api.stateAfterOutcome({ state: value.state, plan, phaseState: 'verified',
      updatedAt: at, evidenceId: evidence.evidenceId }, related);
    expect(readVerifiedDigestApplicationArtifact(projectCatalog, value.context, state, related)).toEqual(value.receipt);
    expect(() => api.readEvidence(evidence, { ...prior, evidence: [] })).toThrow(/exact original v2 artifact/);
    const replaced = structuredClone(evidence);
    if (!isRecord(replaced.payload)) throw new Error('Expected the foundation fixture payload.');
    replaced.payload.publication = { ...value.receipt, programDigest: unitDigest('replaced-program') };
    expect(() => api.readEvidence(resealEvidence(replaced), related)).toThrow(/exact original v2 artifact/);
    replaced.payload.publication = value.receipt; replaced.payload.kind = 'application-foundation.v1';
    expect(() => api.readEvidence(resealEvidence(replaced), related)).toThrow(/application-foundation.v2/);
  });
  it('rejects v1 evidence and absent publication outcomes without changing their bytes', () => {
    const value = fixture(), original = structuredClone(value.evidence);
    if (!isRecord(original.payload)) throw new Error('Expected the format fixture payload.');
    original.payload.kind = 'application-artifact-ready.v1';
    expect(() => value.api.readEvidence(resealEvidence(original), value.related)).toThrow(/application-artifact-ready.v2/);
    expect(() => readVerifiedDigestApplicationArtifact(projectCatalog, value.context, value.initial, value.related)).toThrow(/original verified/);
    const noOutputs = structuredClone(value.state); Reflect.deleteProperty(noOutputs, 'phaseOutputs');
    expect(() => readVerifiedDigestApplicationArtifact(projectCatalog, value.context, noOutputs, value.related)).toThrow(/bound outputs/);
    expect(original.payload.kind).toBe('application-artifact-ready.v1');
  });
});
