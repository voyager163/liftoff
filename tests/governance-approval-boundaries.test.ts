import { describe, expect, it } from 'vitest';
import {
  approvalRequestForSavedPlan, canonicalApprovalEnvelopeHash, canonicalPhaseGraph, canonicalSha256, combineApprovalRequests,
  currentActivationIdentity, determineHumanAuthorityQuestion, evaluateApprovalForTransitionPlan, normalizeApprovalDestinations,
  normalizeApprovalPermissions, normalizeApprovalResources, normalizeApprovalScope, questionKindForApprovalGate, savedPlanAuthorityDigest,
  transitionPlanForPhase, validateApprovalEnvelope, type ApprovalEnvelope, type PhaseId, type RequestedTransitionPlan,
  type SavedTransitionPlan, type TransitionOperation
} from '../src/governance-activation/index.js';
import {
  assertOperationAllowed, assertPlanOperationsAllowed, phaseById, rollbackPlanFromCompletedOperations, taskProjectionContract
} from '../src/domain/governance/activation/operations.js';
import { sha256Hex } from '../src/domain/governance/activation/canonical-json.js';
import { fixtureContext, fixturePayload, fixturePlan } from './governance-activation-fixtures.js';
import { coverageState } from './fixtures/governance-coverage/transition-project.js';

// Authority documents are mutated structurally to prove each refusal; `any` keeps those edits readable.
type Json = any;

const now = new Date('2026-09-04T00:00:00.000Z');
const hex = (seed: string) => canonicalSha256(seed);
const phase = (id: PhaseId) => canonicalPhaseGraph.phases.find((entry) => entry.id === id)!;
const subscription = '00000000-0000-4000-8000-000000000001';

function request(phaseId: PhaseId, operations?: readonly TransitionOperation[]): RequestedTransitionPlan {
  return transitionPlanForPhase(phase(phaseId), coverageState(), fixtureContext(phaseId).transition, undefined, undefined,
    operations ? { operations } : undefined);
}

function envelope(plan: RequestedTransitionPlan, overrides: Partial<ApprovalEnvelope> = {}): ApprovalEnvelope {
  return {
    ...plan, schemaVersion: currentActivationIdentity.approvalEnvelopeSchemaVersion, id: `${plan.phaseId}-approval`,
    approvedAt: now.toISOString(), expiresAt: '2026-09-04T01:00:00.000Z', approver: 'owner', ...overrides
  };
}

function githubOperation(phaseId: PhaseId, actionId: string, mutationClass: TransitionOperation['mutationClass'], inputs = {}): TransitionOperation {
  return {
    adapter: 'github', actionId, mutationClass, phaseId, inputs, remote: true, destructive: false,
    destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' }
  };
}

describe('approval scope normalization refusals', () => {
  it('rejects malformed scope members, unknown bundle phases, and invalid authority digests', () => {
    expect(() => normalizeApprovalResources([{ type: 5 as unknown as string, identity: 'x' }])).toThrow(/resources\[0\]\.type must be a string/u);
    expect(() => normalizeApprovalPermissions(['   '])).toThrow(/permissions\[0\] must be a non-empty string/u);
    expect(() => normalizeApprovalDestinations([{ type: 'organization' as 'repository', identity: 'acme', repository: null, subscriptionId: null }]))
      .toThrow(/destinations\[0\]\.type contains unsupported value "organization"/u);
    const base = request('committed');
    const refusals: Array<[Json, RegExp]> = [
      [{ ...base, baselineSha: 'baseline' }, /baselineSha must be a SHA-256 hex digest/u],
      [{ ...base, coveredPhases: ['committed', 'team-review'] }, /Unsupported covered phase team-review/u],
      [{ ...base, coveredPhases: ['committed', 'committed'] }, /coveredPhases must not contain duplicate committed/u],
      [{ ...base, phasePlanDigests: { committed: base.planDigest, 'team-review': hex('x') } }, /approval bundle contains an unknown phase/u],
      [{ ...base, phasePlanDigests: { committed: 'plan' } }, /phasePlanDigests\.committed must be a SHA-256 hex digest/u],
      [{ ...base, operationDigests: ['operation'] }, /operationDigests must be a SHA-256 hex digest/u]
    ];
    for (const [scope, expected] of refusals) expect(() => normalizeApprovalScope(scope)).toThrow(expected);
    const approved = envelope(base);
    expect(() => canonicalApprovalEnvelopeHash({ ...approved, expiresAt: 'soon' })).toThrow(/expiresAt must be a valid ISO timestamp/u);
    expect(() => canonicalApprovalEnvelopeHash({ ...approved, approver: '  ' })).toThrow(/approver must be a non-empty string/u);
  });

  it('keeps cost, exception, and destructive authority on their dedicated gates', () => {
    const none = request('seed-valid');
    expect(() => determineHumanAuthorityQuestion({
      ...none, costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 5 }, policyExceptions: ['skip-scan'], destructiveScope: ['state.key']
    })).toThrow('Approval gate none cannot request usage monthly cost, policy exception, destructive scope authority.');
    for (const phaseId of ['committed', 'credential-ready', 'enforcement-approved'] as const) {
      expect(() => determineHumanAuthorityQuestion({ ...request(phaseId), costCeiling: { currency: 'USD', fixedMonthlyCents: 100, usageMonthlyCents: 0 } }))
        .toThrow(/Cost ceilings and policy exceptions require an activation-plan or infrastructure-cost approval gate/u);
      expect(() => determineHumanAuthorityQuestion({ ...request(phaseId), policyExceptions: ['temporary-exception'] }))
        .toThrow(/Cost ceilings and policy exceptions require/u);
    }
    expect(determineHumanAuthorityQuestion({ ...request('provider-ready'), policyExceptions: ['temporary-exception'] }))
      .toBe('billed-infrastructure-policy-exception-cost-ceiling');
    expect(questionKindForApprovalGate('external-blocker')).toBe('external-blocker');
  });
});

describe('approval reuse boundaries', () => {
  it('prefers a current invalidated candidate over an expired one and the narrowest mismatch among candidates', () => {
    const plan = request('committed');
    const expired = envelope(plan, { id: 'expired', approvedAt: '2026-09-03T00:00:00.000Z', expiresAt: '2026-09-03T01:00:00.000Z' });
    const staleBaseline = envelope({ ...plan, baselineSha: hex('old baseline') }, { id: 'stale-baseline' });
    const staleEverything = envelope({ ...plan, baselineSha: hex('older'), planDigest: hex('older plan') }, { id: 'stale-everything' });
    const result = evaluateApprovalForTransitionPlan(plan, [expired, staleEverything, staleBaseline], { now });
    expect(result).toMatchObject({ approvalRequired: true, status: 'invalidated', envelopeId: 'stale-baseline', reasons: ['baseline SHA changed'] });
    expect(result.envelopeHash).toBe(canonicalApprovalEnvelopeHash(staleBaseline));
    const future = envelope(plan, { id: 'future', approvedAt: '2026-09-04T00:30:00.000Z', expiresAt: '2026-09-04T02:00:00.000Z' });
    expect(evaluateApprovalForTransitionPlan(plan, [future], { now })).toMatchObject({
      status: 'expired', envelopeId: 'future', envelopeHash: null,
      reasons: ['Approval future requires a valid approvedAt <= now < expiresAt interval.']
    });
    expect(evaluateApprovalForTransitionPlan(plan, [envelope(request('credential-ready'))], { now })).toMatchObject({
      status: 'approval-required', envelopeId: null, reasons: ['no approval envelope exists for committed (repository-publish)']
    });
  });

  it('names changed currency, scope, phase, bundled phase, and operation authority as distinct reasons', () => {
    const provider = request('provider-ready');
    const eur = { ...provider, costCeiling: { currency: 'EUR', fixedMonthlyCents: 0, usageMonthlyCents: 0 } };
    expect(evaluateApprovalForTransitionPlan(eur, [envelope(provider)], { now }).reasons).toContain('cost currency changed from USD to EUR');
    const committed = request('committed');
    const localScope = evaluateApprovalForTransitionPlan({ ...committed, scope: 'local' }, [envelope(committed)], { now });
    expect(localScope).toMatchObject({ status: 'invalidated', reasons: ['governance execution scope changed'] });
    const pushed = request('pushed');
    expect(evaluateApprovalForTransitionPlan(pushed, [envelope(committed)], { now }).reasons).toContain('phase changed from committed to pushed');
    const operation = githubOperation('rulesets-applied', 'github.ruleset.apply', 'github-ruleset-write', { sourceDigest: hex('rulesets') });
    const rulesets = request('rulesets-applied', [operation]);
    const expanded = { ...rulesets, coveredPhases: ['rulesets-applied', 'live-readback'] as PhaseId[],
      operationDigests: [...rulesets.operationDigests!, hex('unreviewed operation')] };
    const evaluation = evaluateApprovalForTransitionPlan(expanded, [envelope(rulesets)], { now });
    expect(evaluation.status).toBe('approval-required');
    expect(evaluation.expansionReasons).toEqual(expect.arrayContaining([
      'phase scope expanded: live-readback', `operation scope expanded: ${hex('unreviewed operation')}`
    ]));
  });
});

describe('approval bundle composition', () => {
  const rulesetOperation = githubOperation('rulesets-applied', 'github.ruleset.apply', 'github-ruleset-write', { sourceDigest: hex('rulesets') });

  it('refuses empty, repeated, nested, or cross-currency bundles', () => {
    const committed = request('committed');
    const pushed = request('pushed');
    expect(() => combineApprovalRequests([])).toThrow('An approval bundle must name at least one resolved phase plan.');
    expect(() => combineApprovalRequests([committed, committed])).toThrow('An approval bundle cannot repeat a phase.');
    const nested = combineApprovalRequests([committed, pushed]);
    expect(() => combineApprovalRequests([nested, request('committed')])).toThrow(/nested bundles are not supported/u);
    const euro = { ...pushed, costCeiling: { currency: 'EUR', fixedMonthlyCents: 0, usageMonthlyCents: 0 } };
    expect(() => combineApprovalRequests([committed, euro])).toThrow(/one identity, baseline, scope, authority gate, and currency/u);
    const { scope: _scope, ...unscopedCommitted } = committed;
    const { scope: _pushedScope, operationDigests: _digests, ...unscopedPushed } = pushed;
    const combined = combineApprovalRequests([unscopedCommitted, unscopedPushed]);
    expect(combined.coveredPhases).toEqual(['committed', 'pushed']);
    expect(combined.planDigest).toBe(canonicalSha256({
      scope: 'activation', phasePlanDigests: { committed: committed.planDigest, pushed: pushed.planDigest }
    }));
  });

  it('derives the same authority digest from a saved bundled plan and its approval request', () => {
    const state = coverageState();
    const approvalPhase = phase('enforcement-approved');
    const primary = transitionPlanForPhase(approvalPhase, state, fixtureContext('enforcement-approved').transition,
      undefined, undefined, { operations: [], fileChanges: [] });
    const rulesetsContext = fixtureContext('rulesets-applied');
    const plan = {
      phaseId: 'enforcement-approved', baselineDigest: fixtureContext('enforcement-approved').baselineSha,
      inputDigest: fixtureContext('enforcement-approved').inputDigest, transitionDigest: fixtureContext('enforcement-approved').transition.transitionDigest,
      operations: [], fileChanges: [], approvalBundle: [{
        phaseId: 'rulesets-applied', inputDigest: rulesetsContext.inputDigest, transitionDigest: rulesetsContext.transition.transitionDigest,
        operations: [rulesetOperation], fileChanges: []
      }]
    } as unknown as SavedTransitionPlan;
    const bundled = approvalRequestForSavedPlan(plan, approvalPhase, state);
    expect(bundled.coveredPhases).toEqual(['enforcement-approved', 'rulesets-applied']);
    expect(bundled.phasePlanDigests?.['enforcement-approved']).toBe(primary.planDigest);
    expect(savedPlanAuthorityDigest(plan, approvalPhase)).toBe(bundled.planDigest);
    expect(savedPlanAuthorityDigest({ ...plan, approvalBundle: [] }, approvalPhase)).toBe(primary.planDigest);
    const unknown = { ...plan, approvalBundle: [{ ...plan.approvalBundle![0]!, phaseId: 'team-review' as PhaseId }] };
    expect(() => approvalRequestForSavedPlan(unknown, approvalPhase, state)).toThrow('Unknown approval phase team-review.');
    expect(() => savedPlanAuthorityDigest(unknown, approvalPhase)).toThrow('Unknown approval phase team-review.');
  });
});

describe('approval envelope validation boundaries', () => {
  const base = envelope(request('committed'));

  it('rejects malformed digests, intervals, collections, and unbound bundle digests', () => {
    const refusals: Array<[Json, RegExp]> = [
      [{ ...base, baselineSha: 'baseline' }, /baselineSha and planDigest must be SHA-256 hex digests/u],
      [{ ...base, planDigest: 'plan' }, /baselineSha and planDigest must be SHA-256 hex digests/u],
      [{ ...base, approvedAt: base.expiresAt }, /Approval requires approvedAt < expiresAt/u],
      [{ ...base, resources: {} }, /approvalEnvelope\.resources must be an array/u],
      [{ ...base, destinations: 'repository' }, /approvalEnvelope\.destinations must be an array/u],
      [{ ...base, coveredPhases: ['pushed'] }, /must contain its primary phase and only phases in the same scope and authority gate/u],
      [{ ...base, coveredPhases: ['committed', 'provider-ready'] }, /must contain its primary phase and only phases in the same scope and authority gate/u],
      [{ ...base, coveredPhases: ['committed', 'bootstrap-state-disposed'] }, /must contain its primary phase and only phases in the same scope/u],
      [{ ...base, operationDigests: [hex('a'), hex('a')] }, /operationDigests contains duplicate value/u],
      [{ ...base, coveredPhases: undefined, phasePlanDigests: { pushed: hex('pushed') } }, /phasePlanDigests must exactly equal committed/u],
      [{ ...base, scope: 'lifecycle' }, /scope contains unsupported value "lifecycle"/u]
    ];
    for (const [value, expected] of refusals) {
      expect(() => validateApprovalEnvelope(JSON.parse(JSON.stringify(value)))).toThrow(expected);
    }
    const { coveredPhases: _covered, ...single } = base;
    expect(validateApprovalEnvelope({ ...single, phasePlanDigests: { committed: base.planDigest } }).phasePlanDigests).toEqual({
      committed: base.planDigest
    });
  });

  it('refuses unexpired-authority checks for approvals dated in the future of the real clock', () => {
    const future = { ...base, approvedAt: '2099-01-01T00:00:00.000Z', expiresAt: '2099-01-01T01:00:00.000Z' };
    expect(() => validateApprovalEnvelope(future, { requireUnexpired: true })).toThrow('Approval approvedAt is in the future.');
    expect(validateApprovalEnvelope(future).approvedAt).toBe(future.approvedAt);
  });
});

describe('operation authority boundaries', () => {
  const metadataText = '{"changeId":"governance-demo"}\n';
  const contract = {
    schemaVersion: 1, derivation: 'validated-current-readiness', source: 'existing', changeId: 'governance-demo', workflowKind: 'openspec',
    taskPathParts: ['openspec', 'changes', 'governance-demo', 'tasks.md'],
    metadataPathParts: ['openspec', 'changes', 'governance-demo', 'liftoff-governance.json'],
    metadataHash: sha256Hex(metadataText), layoutHash: hex('layout')
  };
  const projection = (overrides: Json = {}): TransitionOperation => ({
    adapter: 'local-evidence', actionId: 'governance.tasks.project', mutationClass: 'project-governance-tasks', phaseId: 'phase-0-complete',
    inputs: { projection: contract }, remote: false, destructive: false,
    destination: { type: 'local', identity: contract.taskPathParts.join('/'), pathParts: contract.taskPathParts }, ...overrides
  });

  it('accepts one exact checkbox projection and rejects duplicated, widened, or relocated projections', () => {
    expect(taskProjectionContract([projection()])).toEqual(contract);
    expect(taskProjectionContract([githubOperation('phase-0-complete', 'github.phase0.discover', 'github-read')])).toBeUndefined();
    expect(() => taskProjectionContract([projection(), projection()])).toThrow('A phase can project only one exact current governance task document.');
    expect(() => taskProjectionContract([projection({ inputs: { projection: contract, template: 'x' } })]))
      .toThrow('Task projection has no unbounded adapter inputs.');
    for (const overrides of [
      { adapter: 'local-state' }, { remote: true }, { destination: { type: 'local', identity: 'README.md', pathParts: ['README.md'] } },
      { destination: { type: 'local', identity: contract.taskPathParts.join('/'), pathParts: contract.taskPathParts, repository: 'owner/repo' } },
      { effects: [{ mutationClass: 'write-evidence', remote: false, destructive: false, destination: { type: 'local', identity: 'x' } }] }
    ]) {
      expect(() => taskProjectionContract([projection(overrides)]), JSON.stringify(overrides))
        .toThrow('Task projection must name only its exact local checkbox destination.');
    }
    expect(() => phaseById(canonicalPhaseGraph, 'team-review' as PhaseId)).toThrow('Unknown phase team-review.');
  });

  it('refuses unlisted actions, mismatched authority, destructive drift, placeholder destinations, and undeclared effects', () => {
    const discovery = phase('phase-0-complete');
    const valid = githubOperation('phase-0-complete', 'github.phase0.discover', 'github-read');
    expect(() => assertOperationAllowed(discovery, valid)).not.toThrow();
    expect(() => assertOperationAllowed(discovery, projection())).not.toThrow();
    const azure = (overrides: Json = {}): TransitionOperation => ({
      adapter: 'azure-opentofu', actionId: 'azure.existing-private-path.verify', mutationClass: 'azure-read', phaseId: 'existing-private-path',
      inputs: {}, remote: true, destructive: false,
      destination: { type: 'subscription', identity: subscription, subscriptionId: subscription },
      effects: [{ mutationClass: 'backend-state-read', remote: true, destructive: false,
        destination: { type: 'subscription', identity: subscription, subscriptionId: subscription } }],
      ...overrides
    });
    expect(() => assertOperationAllowed(phase('existing-private-path'), azure())).not.toThrow();
    const refusals: Array<[PhaseId, TransitionOperation, RegExp]> = [
      ['phase-0-complete', githubOperation('phase-0-complete', 'github.repository.delete', 'github-write'), /is not allowlisted for phase phase-0-complete/u],
      ['phase-0-complete', githubOperation('pushed', 'github.phase0.discover', 'github-read'), /is not allowlisted for phase phase-0-complete/u],
      ['phase-0-complete', { ...valid, adapter: 'git' }, /adapter, authority, or mutation class is not declared/u],
      ['phase-0-complete', { ...valid, remote: false }, /adapter, authority, or mutation class is not declared/u],
      ['phase-0-complete', { ...valid, mutationClass: 'github-write' }, /adapter, authority, or mutation class is not declared/u],
      ['phase-0-complete', { ...valid, destructive: true }, /has an invalid destructive scope/u],
      ['phase-0-complete', { ...valid, destination: { type: 'repository', identity: 'repo', repository: 'repo' } },
        /requires a verified owner\/repository destination/u],
      ['existing-private-path', azure({ destination: { type: 'subscription', identity: 'unresolved' } }),
        /has no verified subscription destination; placeholders cannot authorize a transition/u],
      ['existing-private-path', azure({ effects: [{ mutationClass: 'backend-state-read', remote: false, destructive: false,
        destination: { type: 'subscription', identity: subscription, subscriptionId: subscription } }] }),
        /Delegated effect backend-state-read is not authorized/u],
      ['existing-private-path', azure({ effects: [{ mutationClass: 'backend-state-write', remote: true, destructive: false,
        destination: { type: 'subscription', identity: subscription, subscriptionId: subscription } }] }),
        /Delegated effect backend-state-write is not authorized/u],
      ['existing-private-path', azure({ effects: [{ mutationClass: 'backend-state-read', remote: true, destructive: true,
        destination: { type: 'subscription', identity: subscription, subscriptionId: subscription } }] }),
        /Delegated effect backend-state-read is not authorized/u],
      ['existing-private-path', azure({ effects: [{ mutationClass: 'backend-state-read', remote: true, destructive: false,
        destination: { type: 'subscription', identity: 'placeholder' } }] }), /placeholders cannot authorize a transition/u]
    ];
    for (const [phaseId, operation, expected] of refusals) {
      expect(() => assertOperationAllowed(phase(phaseId), operation), `${phaseId}:${operation.actionId}`).toThrow(expected);
    }
  });

  it('refuses saved plans whose metadata, projection, or bundle expands reviewed authority', () => {
    const state = coverageState();
    const plan = fixturePlan(fixtureContext('phase-0-complete'), state, now.toISOString(), fixturePayload('phase-0-complete'), '/fixture-root');
    const discovery = phase('phase-0-complete');
    expect(() => assertPlanOperationsAllowed(plan, discovery)).not.toThrow();
    const metadataRefusals: Json[] = [
      { scope: 'local' },
      { mutationClasses: { local: ['write-evidence'], remote: ['github-read'] } },
      { approval: { ...plan.approval, gateKind: 'repository-publish' } },
      { approval: { ...plan.approval, required: true } },
      { approval: { ...plan.approval, evaluation: { ...plan.approval.evaluation, phaseId: 'pushed' } } },
      { approval: { ...plan.approval, envelopeId: 'imported-approval' } },
      { approval: { ...plan.approval, envelopeHash: hex('imported') } },
      { expiresAt: plan.createdAt }
    ];
    for (const overrides of metadataRefusals) {
      expect(() => assertPlanOperationsAllowed({ ...plan, ...overrides }, discovery), JSON.stringify(Object.keys(overrides)))
        .toThrow('Plan metadata, approval gate, or validity interval does not match phase phase-0-complete.');
    }
    expect(() => assertPlanOperationsAllowed(plan, phase('pushed'))).toThrow(/does not match phase pushed/u);

    const projected = { ...plan, operations: [...plan.operations, projection()] };
    expect(() => assertPlanOperationsAllowed(projected, discovery)).not.toThrow();
    const taskChange = { pathParts: contract.taskPathParts, beforeHash: hex('tasks'), afterHash: hex('tasks after') };
    expect(() => assertPlanOperationsAllowed({ ...projected, fileChanges: [taskChange] }, discovery))
      .toThrow('Derived checkbox projection cannot also authorize a generic task-file replacement.');
    const metadataChange = { pathParts: contract.metadataPathParts, beforeHash: hex('metadata'), afterHash: contract.metadataHash };
    expect(() => assertPlanOperationsAllowed({ ...projected, fileChanges: [metadataChange] }, discovery))
      .toThrow('Task projection metadata must be the exact new source or an unchanged existing source.');
    const createContract = { ...contract, source: 'create', template: '- [ ] 1.1 Review\n', metadataText };
    const creating = { ...plan, operations: [...plan.operations, projection({ inputs: { projection: createContract } })] };
    expect(() => assertPlanOperationsAllowed(creating, discovery)).toThrow(/exact new source or an unchanged existing source/u);
    expect(() => assertPlanOperationsAllowed({ ...creating, fileChanges: [{ ...metadataChange, beforeHash: null }] }, discovery)).not.toThrow();
    expect(() => assertPlanOperationsAllowed({ ...creating, fileChanges: [{ ...metadataChange, beforeHash: null, afterHash: hex('other') }] }, discovery))
      .toThrow(/exact new source or an unchanged existing source/u);

    const bundle = (phaseId: PhaseId, operations: TransitionOperation[]) => ({
      ...plan, approvalBundle: [{ phaseId, inputDigest: hex('input'), transitionDigest: hex('transition'), operations, fileChanges: [] }]
    });
    expect(() => assertPlanOperationsAllowed(bundle('existing-private-path', []), discovery)).not.toThrow();
    expect(() => assertPlanOperationsAllowed(bundle('existing-private-path', [
      githubOperation('existing-private-path', 'github.phase0.discover', 'github-read')
    ]), discovery)).toThrow(/github\.phase0\.discover is not allowlisted for phase existing-private-path/u);
    expect(() => assertPlanOperationsAllowed(bundle('bootstrap-state-disposed', []), discovery))
      .toThrow('Bundled operations cannot expand the approval scope or authority gate.');
    expect(() => assertPlanOperationsAllowed(bundle('provider-ready', []), discovery))
      .toThrow('Bundled operations cannot expand the approval scope or authority gate.');
  });

  it('builds recovery plans that retain provider registrations and never expand into unregistration', () => {
    const operation = (actionId: string, mutationClass: TransitionOperation['mutationClass'], remote = true): TransitionOperation => ({
      adapter: remote ? 'azure-opentofu' : 'local-state', actionId, mutationClass, phaseId: 'bootstrap-local', inputs: {}, remote, destructive: false,
      destination: remote ? { type: 'subscription', identity: subscription, subscriptionId: subscription } : { type: 'local', identity: '.bootstrap' }
    });
    const plan = rollbackPlanFromCompletedOperations('bootstrap-local', 'reverse-to', 'provider-ready', [
      operation('azure.provider.ensure-ready', 'azure-provider-register'),
      operation('azure.bootstrap-local.apply', 'azure-network-provision'),
      operation('local.bootstrap.write', 'write-local-state', false),
      operation('azure.provider.unregister', 'azure-read'),
      githubOperation('rulesets-applied', 'github.ruleset.apply', 'github-ruleset-write'),
      operation('azure.prerequisites.apply', 'azure-resource-provision'),
      operation('azure.readback', 'azure-read')
    ]);
    expect(plan.operations.map((entry) => [entry.actionId, entry.destructive, entry.inputs.fromOperation])).toEqual([
      ['azure.resource.cleanup', true, 'azure.prerequisites.apply'],
      ['github.ruleset.disable', false, 'github.ruleset.apply'],
      ['local.state.rollback', false, 'local.bootstrap.write'],
      ['azure.resource.cleanup', true, 'azure.bootstrap-local.apply']
    ]);
    expect(plan.operations.every((entry) => entry.phaseId === 'bootstrap-local')).toBe(true);
    expect(plan.retained).toEqual(['bootstrap-local:azure.provider.ensure-ready:provider-registration']);
    expect(plan.cleanupWarnings).toEqual(['Refused to generate provider unregister rollback for azure.provider.unregister.']);
    expect(plan.operations.some((entry) => /unregister/iu.test(entry.actionId))).toBe(false);
    expect(plan.operations.filter((entry) => entry.actionId === 'azure.resource.cleanup').map((entry) => entry.inputs.noProviderUnregister))
      .toEqual([true, true]);
  });
});
