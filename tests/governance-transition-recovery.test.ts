import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSavedTransitionPlan, canonicalJson, canonicalPhaseGraph, canonicalSha256, executeApplyNext, previewApplyNext,
  type GovernancePhaseAdapter, type GovernanceSourceOfTruthInspection, type GovernanceTransitionAdapters,
  type GovernanceTransitionInspection, type PhaseAdapterExecutionInput, type PhaseAdapterOutcome, type PhaseId,
  type SavedTransitionPlan, type TransitionOperation, type UserActivationState
} from '../src/governance-activation/index.js';
import { activationStateContentHash } from '../src/governance-activation/activation-state.js';
import { comparePlanFreshness } from '../src/governance-activation/transition-planning.js';
import {
  blockedState, initializeExecutionAnchor, nextStateForOutcome, readbackProof, saveTransitionPlan, writeOutcomeTransaction
} from '../src/governance-activation/transition-records.js';
import {
  assertInputFileChanges, assertOutcomeFileChanges, assertPlannedFilesAfter, plannedFileChanges, snapshotWithPlannedWrites,
  verifiedGitInputBinding
} from '../src/governance-activation/transition-files.js';
import type { ActivationInputSnapshot } from '../src/domain/governance/activation/inputs.js';
import type { CommandResult, CommandRunner } from '../src/process-runner.js';
import {
  LocalOnlyRunner, coverageActivationInputs, coverageInspection, coverageNow, coverageState, coverageSubscription,
  isolateUserLocalStorage, isolatedGitEnvironment, issuePriorApproval, readState, resetDirectory, scratchDirectory,
  selectedSource, treeFingerprint, writeCoverageProject
} from './fixtures/governance-coverage/transition-project.js';

const scratch = scratchDirectory('transition-recovery');
const activationInputs = coverageActivationInputs();
const resourceGroup = `/subscriptions/${coverageSubscription}/resourceGroups/rg-state`;
const connectionString = ['DefaultEndpointsProtocol=https', 'AccountName=state', `AccountKey=${'q'.repeat(24)}`].join(';');
const slackWebhook = ['https://hooks.slack.com/services', 'T000', 'B000', 'SYNTHETIC'].join('/');
const hex = (seed: string) => canonicalSha256(seed);
const sha = (content: string) => createHash('sha256').update(content).digest('hex');
let storage: Awaited<ReturnType<typeof isolateUserLocalStorage>>;
let gitEnvironment: NodeJS.ProcessEnv;
let counter = 0;

beforeAll(async () => {
  await resetDirectory(scratch);
  storage = await isolateUserLocalStorage();
  gitEnvironment = await isolatedGitEnvironment(scratch);
});

afterAll(async () => {
  await storage.restore();
  await rm(scratch, { recursive: true, force: true });
});

async function project(label: string): Promise<string> {
  counter += 1;
  return writeCoverageProject(path.join(scratch, `${label}-${counter}`));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function injected(phaseId: PhaseId, execute: (input: PhaseAdapterExecutionInput) => PhaseAdapterOutcome) {
  const calls: PhaseAdapterExecutionInput[] = [];
  const adapter: GovernancePhaseAdapter = { phaseId, async execute(input) { calls.push(input); return execute(input); } };
  return { calls, adapters: { phases: { [phaseId]: adapter } } as GovernanceTransitionAdapters };
}

async function existingPrivatePath(root: string, overrides: Partial<Parameters<typeof coverageInspection>[0]> = {}) {
  return coverageInspection({
    root, phaseId: 'existing-private-path', state: coverageState({ activationInputs }), activationInputs, ...overrides
  });
}

function verifyOperation(plan: SavedTransitionPlan): TransitionOperation {
  return plan.operations.find((operation) => operation.actionId === 'azure.existing-private-path.verify')!;
}

describe('reviewed plan freshness', () => {
  it('refuses changed, rebound, or expired reviewed previews before saving a plan or invoking a producer', async () => {
    const root = await project('reviewed');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const inspection = await existingPrivatePath(root);
    const reviewed = (await buildSavedTransitionPlan({ inspection, runner, now: coverageNow }))!;
    const { calls, adapters } = injected('existing-private-path', () => ({ status: 'blocked', blocker: 'must not run', completedOperations: [] }));
    const before = await treeFingerprint(root);
    for (const reviewedPlan of [
      { ...reviewed, planDigest: hex('another reviewed plan') },
      { ...reviewed, stateHash: hex('another state') },
      { ...reviewed, expiresAt: coverageNow.toISOString() }
    ]) {
      await expect(executeApplyNext({ inspection, reinspect: async () => inspection, runner, now: coverageNow, adapters, reviewedPlan }))
        .rejects.toThrow('The reviewed preview expired or its inputs/operations changed; request a fresh plan before execution.');
    }
    expect(calls).toEqual([]);
    expect(await treeFingerprint(root)).toBe(before);
  });

  it('keeps the saved plan as audit but runs no producer when reinspection shows changed operations', async () => {
    const root = await project('stale-after-save');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const inspection = await existingPrivatePath(root);
    const otherInputs = { ...activationInputs, azure: { ...activationInputs.azure!, subscriptionId: '00000000-0000-4000-8000-000000000009' } };
    const changed = await existingPrivatePath(root, { state: coverageState({ activationInputs: otherInputs }), activationInputs: otherInputs });
    const { calls, adapters } = injected('existing-private-path', () => ({ status: 'blocked', blocker: 'must not run', completedOperations: [] }));

    const result = await executeApplyNext({ inspection, reinspect: async () => changed, runner, now: coverageNow, adapters });

    expect(result).toMatchObject({
      applied: false, authorized: false, reason: 'stale-after-plan-save', executedPhase: null, evidence: null, stateHash: null,
      executedOperations: []
    });
    expect(result.blockers).toEqual(expect.arrayContaining([
      'Proposed operations changed after plan save.', 'Selected scope, configuration, or reviewed file outputs changed after plan save.'
    ]));
    expect(await exists(path.join(root, ...result.savedPlan!.pathParts))).toBe(true);
    expect(await readState(root)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('names every freshness dimension that changed after the reviewed plan was saved', async () => {
    const root = await project('freshness');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const saved = (await buildSavedTransitionPlan({ inspection: await existingPrivatePath(root), runner, now: coverageNow }))!;
    expect(comparePlanFreshness(saved, saved)).toEqual([]);
    expect(comparePlanFreshness(saved, null)).toEqual(['No phase remained ready after saving the transition plan.']);
    const changed: SavedTransitionPlan = {
      ...saved, phaseId: 'remote-ready', stateHash: hex('state'), baselineDigest: hex('baseline'), inputDigest: hex('input'),
      transitionDigest: hex('transition'), operations: [], fileChanges: [{ pathParts: ['src', 'app.ts'], beforeHash: null, afterHash: hex('app') }],
      approval: { ...saved.approval, evaluation: { ...saved.approval.evaluation, approvalRequired: true } }
    };
    expect(comparePlanFreshness(saved, changed)).toEqual([
      'Ready phase changed from existing-private-path to remote-ready.',
      'stateHash changed after plan save.', 'baselineDigest changed after plan save.', 'inputDigest changed after plan save.',
      'transitionDigest changed after plan save.', 'Proposed operations changed after plan save.',
      'Selected scope, configuration, or reviewed file outputs changed after plan save.',
      'Approval was not valid immediately before execution.'
    ]);
  });

  it('requires an anchored committed state and exact guards before local revalidation takes the project lock', async () => {
    const root = await project('local-revalidation');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const state = coverageState();
    const inspection = await coverageInspection({ root, phaseId: 'seed-valid', state, scope: 'local' });
    const loaded = { state, content: canonicalJson(state), contentHash: hex('loaded'), schemaVersion: 3 };
    const guards = { assertReviewedPlan: () => undefined, assertProtectedInputs: () => undefined };
    const before = await treeFingerprint(root);
    for (const attempt of [
      { inspection, ...guards },
      { inspection: { ...inspection, loadedState: loaded } },
      { inspection: { ...inspection, loadedState: loaded }, assertReviewedPlan: guards.assertReviewedPlan },
      { inspection: { ...inspection, loadedState: loaded, state: { ...state, repository: { ...state.repository, id: 'unbound' } } }, ...guards }
    ]) {
      await expect(executeApplyNext({ ...attempt, reinspect: async () => attempt.inspection, runner, now: coverageNow, localRevalidation: true }))
        .rejects.toThrow('Local revalidation requires a committed anchored v3 state and exact reviewed-plan/protected-input guards.');
    }
    expect(await treeFingerprint(root)).toBe(before);
  });
});

describe('source-of-truth and adapter integrity boundaries', () => {
  const supersession = { records: [], invalidRecords: [], selectedChangeId: null, issues: [] };
  const sources: Array<[string, GovernanceSourceOfTruthInspection, string]> = [
    ['ambiguous', { status: 'ambiguous', selected: null, candidates: [], supersession,
      blockers: ['Two governance changes claim the same scope.', 'Reconcile before activation.'] },
      'Two governance changes claim the same scope.; Reconcile before activation.'],
    ['incompatible', { status: 'incompatible', selected: null, candidates: [], blockers: ['Governance change uses a future identity.'],
      reconciliation: { status: 'blocked', approvalRequired: false, issues: [], preservedPhaseIds: [], invalidPhaseIds: [] } },
      'Governance change uses a future identity.'],
    ['uncreated', { status: 'none', selected: null, candidates: [], createPlan: {
      status: 'blocked', reason: 'Approve activation before creating governance work.', changeId: 'governance-demo',
      workflowKind: 'openspec', requiredFacts: []
    } } as GovernanceSourceOfTruthInspection, 'Approve activation before creating governance work.'],
    ['unreconciled', { ...selectedSource(), reconciliation: {
      status: 'blocked', approvalRequired: false, issues: ['Graph identity changed.'], preservedPhaseIds: [], invalidPhaseIds: []
    } } as GovernanceSourceOfTruthInspection, 'Active governance source of truth is not ready.']
  ];

  it.each(sources)('records an %s source-of-truth blocker without invoking the producer', async (_label, source, blocker) => {
    const root = await project('source');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const inspection = await existingPrivatePath(root, { source });
    const { calls, adapters } = injected('existing-private-path', () => ({ status: 'blocked', blocker: 'must not run', completedOperations: [] }));

    const result = await executeApplyNext({ inspection, reinspect: async () => inspection, runner, now: coverageNow, adapters });

    expect(result).toMatchObject({ applied: false, reason: 'blocked', blockers: [blocker], evidence: null, executedPhase: null });
    expect(calls).toEqual([]);
    const state = (await readState(root))!;
    expect(state.phases['existing-private-path']).toMatchObject({ state: 'blocked', blockers: [blocker], evidence: [] });
    expect(result.stateHash).toBe(activationStateContentHash(await readFile(path.join(root, 'governance', 'activation-state.json'))));
    expect(await exists(path.join(root, 'governance', 'evidence'))).toBe(false);
  });

  const projectionOperation = (phaseId: PhaseId): TransitionOperation => ({
    adapter: 'local-evidence', actionId: 'governance.tasks.project', mutationClass: 'project-governance-tasks', phaseId,
    inputs: { projection: {} }, remote: false, destructive: false,
    destination: { type: 'local', identity: 'openspec/changes/governance-demo/tasks.md', pathParts: ['openspec', 'changes', 'governance-demo', 'tasks.md'] }
  });
  const override = (input: PhaseAdapterExecutionInput, change: (state: UserActivationState) => void): UserActivationState => {
    const state = structuredClone(input.inspection.state);
    change(state);
    return state;
  };
  const refusals: Array<[string, (input: PhaseAdapterExecutionInput) => PhaseAdapterOutcome, RegExp]> = [
    ['a completed operation outside the reviewed plan', (input) => ({
      status: 'completed', resultState: 'verified', completedOperations: [{ ...verifyOperation(input.plan), inputs: { statePath: 'bootstrap-local' } }]
    }), /Completed operation azure\.existing-private-path\.verify was not in the reviewed plan/u],
    ['the engine-owned task projection', (input) => ({
      status: 'completed', resultState: 'verified', completedOperations: [projectionOperation(input.phase.id)]
    }), /Adapters cannot claim the engine-owned post-outcome task projection/u],
    ['a file write outside reviewed destinations', () => ({
      status: 'completed', resultState: 'verified', fileMutations: [{ type: 'write', pathParts: ['README.md'], content: 'rewritten\n' }]
    }), /Outcome file mutation README\.md is outside the reviewed plan destinations/u],
    ['a replaced execution anchor', (input) => ({
      status: 'completed', resultState: 'verified', stateOverride: override(input, (state) => { state.repository.id = 'R_OTHER'; })
    }), /must not replace the immutable local execution anchor/u],
    ['a rewritten baseline binding', (input) => ({
      status: 'completed', resultState: 'verified', stateOverride: override(input, (state) => { state.baselineAnchor = hex('rewritten anchor'); })
    }), /cannot replace immutable execution-baseline\/successor-history bindings/u],
    ['rewritten phase history', (input) => ({
      status: 'completed', resultState: 'verified', stateOverride: override(input, (state) => { state.phases['seed-valid'].state = 'verified'; })
    }), /cannot rewrite authoritative phase history or unrelated phase states/u],
    ['a new remote binding', (input) => ({
      status: 'completed', resultState: 'verified', stateOverride: override(input, (state) => {
        state.remoteBinding = { ...state.remoteBinding!, name: 'owner/other', pushUrl: 'https://github.com/owner/other.git' };
      })
    }), /Only verified Phase 0 discovery or publication may establish a remote repository binding/u]
  ];

  it.each(refusals)('refuses an adapter outcome claiming %s before persisting state or evidence', async (_label, execute, expected) => {
    const root = await project('adapter-integrity');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const inspection = await existingPrivatePath(root);
    const { calls, adapters } = injected('existing-private-path', execute);

    await expect(executeApplyNext({ inspection, reinspect: async () => inspection, runner, now: coverageNow, adapters })).rejects.toThrow(expected);

    expect(calls).toHaveLength(1);
    expect(await readState(root)).toBeUndefined();
    expect(await exists(path.join(root, 'governance', 'evidence'))).toBe(false);
    expect(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).toContain('"artifactVersion": 7');
  });

  it('rejects completed evidence whose readback is outside the reviewed destinations without writing state', async () => {
    const root = await project('evidence-rejected');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const inspection = await existingPrivatePath(root);
    const { adapters } = injected('existing-private-path', (input) => ({
      status: 'completed', resultState: 'verified', evidencePayload: { kind: 'existing-private-path.v1' },
      liveReadback: [readbackProof(input, 'azure', 'subscription', `/subscriptions/${coverageSubscription}`, { reachable: true })],
      completedOperations: [verifyOperation(input.plan)]
    }));

    const result = await executeApplyNext({ inspection, reinspect: async () => inspection, runner, now: coverageNow, adapters });

    expect(result).toMatchObject({ applied: false, reason: 'blocked', evidence: null, stateHash: '' });
    expect(result.message).toMatch(/^Completed outcome rejected: .*outside the reviewed plan destinations/u);
    expect(result.executedOperations.map((operation) => operation.actionId)).toEqual(['azure.existing-private-path.verify']);
    expect(await readState(root)).toBeUndefined();
    expect(await exists(path.join(root, 'governance', 'evidence'))).toBe(false);
  });

  it('binds verified provider outputs into evidence and state only after independent readback matches the plan', async () => {
    const root = await project('verified-outputs');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const inspection = await existingPrivatePath(root);
    const outputs = { values: { backendResourceGroup: 'rg-state' }, resources: [{ provider: 'azure' as const, resourceType: 'resource-group', resourceId: resourceGroup }] };
    const { adapters } = injected('existing-private-path', (input) => ({
      status: 'completed', resultState: 'verified', evidencePayload: { kind: 'existing-private-path.v1', statePath: 'existing-private' },
      liveReadback: [readbackProof(input, 'azure', 'resource-group', resourceGroup, { name: 'rg-state' })],
      completedOperations: [verifyOperation(input.plan)], outputs
    }));

    const result = await executeApplyNext({ inspection, reinspect: async () => inspection, runner, now: coverageNow, adapters });

    expect(result).toMatchObject({ applied: true, authorized: true, reason: 'phase-executed', executedPhase: 'existing-private-path',
      evidence: { result: 'verified' } });
    expect(result.executedOperations.map((operation) => operation.actionId)).toEqual([
      'azure.existing-private-path.verify', 'governance.evidence.write', 'governance.activation-state.write'
    ]);
    const evidence = JSON.parse(await readFile(path.join(root, ...result.evidence!.pathParts), 'utf8'));
    const plan = JSON.parse(await readFile(path.join(root, ...result.savedPlan!.pathParts), 'utf8')) as SavedTransitionPlan;
    expect(evidence.payload).toEqual({
      kind: 'existing-private-path.v1', statePath: 'existing-private', planDigest: plan.planDigest,
      savedPlanDigest: canonicalSha256(plan), outputBindings: outputs
    });
    const state = (await readState(root))!;
    expect(state.phases['existing-private-path']).toMatchObject({ state: 'verified', executionPlanDigest: plan.planDigest });
    expect(state.phaseOutputs?.['existing-private-path']).toEqual(outputs);
  });

  it('leaves no activation record for a producer-requested state-free retry after read-only work', async () => {
    const root = await project('state-free-retry');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const inspection = await existingPrivatePath(root);
    const { adapters } = injected('existing-private-path', (input) => ({
      status: 'blocked', blocker: 'Provider throttled the read; retry later.', retryableWithoutStateMutation: true,
      completedOperations: [verifyOperation(input.plan)]
    }));

    const result = await executeApplyNext({ inspection, reinspect: async () => inspection, runner, now: coverageNow, adapters });

    expect(result).toMatchObject({ applied: false, reason: 'blocked', blockers: ['Provider throttled the read; retry later.'], evidence: null });
    expect(result.stateHash).toBe(activationStateContentHash(canonicalJson(inspection.state)));
    expect(result.executedOperations.map((operation) => operation.actionId)).toEqual(['azure.existing-private-path.verify']);
    expect(await readState(root)).toBeUndefined();
  });

  it('retains the running checkpoint but records no success when approval changes before outcome persistence', async () => {
    const root = await project('approval-changed');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const state = coverageState({ activationInputs });
    const planned = await buildSavedTransitionPlan({
      inspection: await coverageInspection({ root, phaseId: 'provider-ready', state, activationInputs }), runner, now: coverageNow
    });
    const approval = await issuePriorApproval(root, state, planned!);
    const approved = await coverageInspection({ root, phaseId: 'provider-ready', state, approvals: [approval], activationInputs });
    const revoked = await coverageInspection({ root, phaseId: 'provider-ready', state, approvals: [], activationInputs });
    let reinspections = 0;
    const { calls, adapters } = injected('provider-ready', () => ({
      status: 'completed', resultState: 'verified', evidencePayload: { kind: 'provider-ready.v1' }, completedOperations: []
    }));

    const result = await executeApplyNext({
      inspection: approved, reinspect: async () => (++reinspections === 1 ? approved : revoked), runner, now: coverageNow, adapters
    });

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({
      applied: false, reason: 'blocked', evidence: null,
      blockers: ['Approval changed or expired before outcome persistence; no successful outcome was recorded.']
    });
    const statePath = path.join(root, 'governance', 'activation-state.json');
    expect((await readState(root))!.phases['provider-ready']).toMatchObject({ state: 'running', evidence: [], approvals: [approval.id] });
    expect(result.stateHash).toBe(activationStateContentHash(await readFile(statePath)));
    expect(await exists(path.join(root, 'governance', 'evidence'))).toBe(false);
    expect(runner.providerCalls).toEqual([]);
  });
});

describe('transition record persistence boundaries', () => {
  async function savedPlan(root: string): Promise<SavedTransitionPlan> {
    return (await buildSavedTransitionPlan({ inspection: await existingPrivatePath(root), runner: new LocalOnlyRunner(gitEnvironment), now: coverageNow }))!;
  }

  it('re-saves an identical plan idempotently and refuses to overwrite a divergent plan', async () => {
    const root = await project('plan-save');
    const plan = await savedPlan(root);
    const first = await saveTransitionPlan(root, plan);
    const bytes = await readFile(path.join(root, ...first.pathParts));
    expect(await saveTransitionPlan(root, plan)).toEqual(first);
    await expect(saveTransitionPlan(root, { ...plan, stateHash: hex('divergent state') }))
      .rejects.toThrow(`Refusing to overwrite existing governance transition plan ${first.pathParts.join('/')}.`);
    expect(await readFile(path.join(root, ...first.pathParts))).toEqual(bytes);
  });

  it('refuses to persist plans, states, or evidence carrying credential shapes that field validators allow', async () => {
    const root = await project('credential-shapes');
    const plan = await savedPlan(root);
    const operations = plan.operations.map((operation) => operation.actionId === 'azure.existing-private-path.verify'
      ? { ...operation, inputs: { ...operation.inputs, note: connectionString } } : operation);
    await expect(saveTransitionPlan(root, { ...plan, operations }))
      .rejects.toThrow('Governance transition plan contains credential-shaped content: azure-account-key.');
    const state = coverageState();
    const leaking = blockedState({
      inspection: await existingPrivatePath(root), phase: canonicalPhaseGraph.phases.find((node) => node.id === 'existing-private-path')!,
      plan, blocker: `Provider said: ${slackWebhook}`, now: coverageNow
    });
    await expect(writeOutcomeTransaction({ projectRoot: root, plan, nextState: leaking }))
      .rejects.toThrow('Activation state contains credential-shaped content; the private execution checkpoint was preserved.');
    await expect(writeOutcomeTransaction({
      projectRoot: root, plan, nextState: state, evidencePathParts: ['governance', 'evidence', 'leak.json'],
      evidenceRecord: { evidenceId: 'leak', header: {} as never, payload: { note: connectionString } }
    })).rejects.toThrow('Governance evidence contains credential-shaped content: azure-account-key.');
    expect(await exists(path.join(root, 'governance'))).toBe(false);
  });

  it('refuses outcome writes when state changed after inspection or evidence already exists', async () => {
    const root = await project('outcome-preconditions');
    const plan = await savedPlan(root);
    const statePath = path.join(root, 'governance', 'activation-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, 'concurrent edit\n');
    await expect(writeOutcomeTransaction({ projectRoot: root, plan, nextState: coverageState() }))
      .rejects.toThrow(/^Activation state changed after inspection: expected absent, found [a-f0-9]{64}\.$/u);
    expect(await readFile(statePath, 'utf8')).toBe('concurrent edit\n');

    await rm(statePath);
    await mkdir(path.join(root, 'governance', 'evidence'), { recursive: true });
    await writeFile(path.join(root, 'governance', 'evidence', 'existing.json'), '{}\n');
    await expect(writeOutcomeTransaction({
      projectRoot: root, plan, nextState: coverageState(), evidencePathParts: ['governance', 'evidence', 'existing.json'],
      evidenceRecord: { evidenceId: 'existing', header: {} as never, payload: { kind: 'existing-private-path.v1' } }
    })).rejects.toThrow('Refusing to overwrite existing governance evidence governance/evidence/existing.json.');
    expect(await exists(statePath)).toBe(false);
    expect(await readFile(path.join(root, 'governance', 'evidence', 'existing.json'), 'utf8')).toBe('{}\n');
  });

  it('records approvals, outputs, reviewed configuration, and existing operation handles but never an unvalidated active change', async () => {
    const root = await project('next-state');
    const plan = { ...(await savedPlan(root)), configuration: activationInputs };
    const node = canonicalPhaseGraph.phases.find((entry) => entry.id === 'existing-private-path')!;
    const recording = await existingPrivatePath(root, {
      source: { ...selectedSource(), recordActiveChangeOnNextMutation: true } as GovernanceSourceOfTruthInspection
    });
    expect(() => nextStateForOutcome({ inspection: recording, phase: node, plan, resultState: 'approved', now: coverageNow }))
      .toThrow('governanceChange must be an object.');
    const inspection = await existingPrivatePath(root);
    const planWithApproval = { ...plan, approval: { ...plan.approval, envelopeId: 'approval-1' } };
    const outputs = { values: { ready: true }, resources: [] };
    const approved = nextStateForOutcome({ inspection, phase: node, plan: planWithApproval, resultState: 'approved', now: coverageNow, outputs });
    expect(approved.activeChange).toBeNull();
    expect(approved.phases['existing-private-path']).toMatchObject({
      state: 'approved', approvals: ['approval-1'], blockers: [], executionPlanDigest: plan.planDigest
    });
    expect(approved.phaseOutputs?.['existing-private-path']).toEqual(outputs);
    expect(approved.activationInputs).toEqual(activationInputs);
    const repeated = nextStateForOutcome({
      inspection: { ...inspection, state: approved }, phase: node, plan: planWithApproval, resultState: 'failed', now: coverageNow, blocker: 'Readback failed.'
    });
    expect(repeated.phases['existing-private-path']).toMatchObject({ state: 'failed', approvals: ['approval-1'], blockers: ['Readback failed.'] });

    const handle = {
      provider: 'azure' as const, actionId: 'azure.existing-private-path.verify', operationId: 'op-9', resourceId: resourceGroup,
      startedAt: coverageNow.toISOString(), observedAt: coverageNow.toISOString(), status: 'running' as const, planDigest: plan.planDigest
    };
    const running = structuredClone(inspection.state);
    running.phases['existing-private-path'] = { ...running.phases['existing-private-path'], state: 'running', operation: handle };
    const blocked = blockedState({ inspection: { ...inspection, state: running }, phase: node, plan, blocker: 'Stopped.', now: coverageNow, executionStarted: true });
    expect(blocked.phases['existing-private-path']).toMatchObject({ state: 'blocked', operation: handle, executionPlanDigest: plan.planDigest });
  });

  it('initializes an execution anchor with reviewed inputs only when no state exists', async () => {
    const root = await project('anchor');
    const inspection = await existingPrivatePath(root);
    const unbound = { ...inspection, state: { ...inspection.state, repository: { ...inspection.state.repository, id: 'unbound' } } };
    await initializeExecutionAnchor(unbound, coverageNow);
    const state = (await readState(root))!;
    expect(state.repository.id).toMatch(/^local:[0-9a-f-]{36}$/u);
    expect(state.baselineAnchor).toBe(inspection.contexts['seed-valid'].baselineSha);
    expect(state.activationInputs).toEqual(activationInputs);
    expect(state.createdAt).toBe(coverageNow.toISOString());
    await expect(initializeExecutionAnchor(unbound, coverageNow)).rejects.toThrow();
    expect((await readState(root))!.repository.id).toBe(state.repository.id);
  });
});

describe('transition file and Git binding boundaries', () => {
  function planWith(fileChanges: SavedTransitionPlan['fileChanges'], operations: TransitionOperation[] = []): SavedTransitionPlan {
    return { fileChanges, operations } as unknown as SavedTransitionPlan;
  }

  it('binds planned writes to real before snapshots and refuses conflicting writes', async () => {
    const root = await project('planned-files');
    await writeFile(path.join(root, 'existing.txt'), 'before\n');
    await expect(plannedFileChanges(root, [
      { type: 'write', pathParts: ['a.txt'], content: 'one' }, { type: 'write', pathParts: ['a.txt'], content: 'two' }
    ])).rejects.toThrow('A transition cannot plan conflicting writes to the same file.');
    expect(await plannedFileChanges(root, [
      { type: 'write', pathParts: ['new.txt'], content: 'created\n' }, { type: 'delete', pathParts: ['existing.txt'] }
    ])).toEqual([
      { pathParts: ['new.txt'], beforeHash: null, afterHash: sha('created\n') },
      { pathParts: ['existing.txt'], beforeHash: sha('before\n'), afterHash: null }
    ]);
  });

  it('refuses outcome files that differ from their exact reviewed before/after binding', () => {
    const plan = planWith([
      { pathParts: ['a.txt'], beforeHash: sha('before'), afterHash: sha('after') },
      { pathParts: ['gone.txt'], beforeHash: sha('old'), afterHash: null }
    ]);
    const snapshots = [{ pathParts: ['a.txt'], content: Buffer.from('before') }, { pathParts: ['gone.txt'], content: Buffer.from('old') }];
    expect(() => assertOutcomeFileChanges(plan, [
      { type: 'write', pathParts: ['a.txt'], content: 'after' }, { type: 'delete', pathParts: ['gone.txt'] }
    ], snapshots)).not.toThrow();
    const refusals: Array<[Parameters<typeof assertOutcomeFileChanges>[1], Parameters<typeof assertOutcomeFileChanges>[2], string]> = [
      [[{ type: 'write', pathParts: ['b.txt'], content: 'after' }], snapshots, 'b.txt'],
      [[{ type: 'write', pathParts: ['a.txt'], content: 'after' }], [], 'a.txt'],
      [[{ type: 'write', pathParts: ['a.txt'], content: 'after' }], [{ pathParts: ['a.txt'], content: Buffer.from('changed before') }], 'a.txt'],
      [[{ type: 'write', pathParts: ['a.txt'], content: 'unreviewed after' }], snapshots, 'a.txt'],
      [[{ type: 'write', pathParts: ['gone.txt'], content: 'recreated' }], snapshots, 'gone.txt']
    ];
    for (const [mutations, preconditions, name] of refusals) {
      expect(() => assertOutcomeFileChanges(plan, mutations, preconditions))
        .toThrow(`Outcome file ${name} differs from its exact reviewed before/after binding.`);
    }
    expect(() => assertOutcomeFileChanges(planWith(undefined), [{ type: 'write', pathParts: ['x'], content: 'x' }], [])).not.toThrow();
  });

  it('keeps the effective input snapshot aligned with planned writes and ignores unobserved paths', () => {
    const snapshot: ActivationInputSnapshot = {
      schemaVersion: 2, project: { name: 'app' }, baselineSha: hex('baseline'),
      files: [{ path: 'src/app.ts', digest: hex('app') }, { path: 'src/old.ts', digest: hex('old') }],
      git: { head: null, branch: null, pushUrls: [] }
    };
    const effective = snapshotWithPlannedWrites(snapshot, [
      { type: 'delete', pathParts: ['src', 'old.ts'] },
      { type: 'write', pathParts: ['.github', 'workflows', 'ci.yml'], content: 'on: push\r\n' },
      { type: 'write', pathParts: ['notes', 'draft.md'], content: 'unobserved' },
      { type: 'write', pathParts: ['src', 'secrets.pem'], content: 'excluded' }
    ]);
    expect(effective.files.map((file) => file.path)).toEqual(['.github/workflows/ci.yml', 'src/app.ts']);
    expect(effective.files[0]!.digest).toBe(canonicalSha256('on: push\n'));
  });

  it('refuses project configuration or unreviewed source changes during a transition', () => {
    const before: ActivationInputSnapshot = {
      schemaVersion: 2, project: { name: 'app' }, baselineSha: hex('baseline'),
      files: [{ path: 'src/app.ts', digest: hex('app') }, { path: 'src/gone.ts', digest: hex('gone') }], git: { head: null, branch: null, pushUrls: [] }
    };
    const plan = planWith([{ pathParts: ['src', 'app.ts'], beforeHash: null, afterHash: null }]);
    expect(() => assertInputFileChanges(before, { ...before, project: { name: 'renamed' } }, plan))
      .toThrow('Project configuration changed during the reviewed transition.');
    expect(() => assertInputFileChanges(before, { ...before, files: [{ path: 'src/app.ts', digest: hex('reviewed change') }, before.files[1]!] }, plan))
      .not.toThrow();
    expect(() => assertInputFileChanges(before, { ...before, files: [before.files[0]!] }, plan))
      .toThrow('Relevant source src/gone.ts changed outside the reviewed transition; preserve the partial outcome and inspect recovery.');
    expect(() => assertInputFileChanges(before, { ...before, files: [...before.files, { path: 'src/new.ts', digest: hex('new') }] }, planWith(undefined)))
      .toThrow(/Relevant source src\/new\.ts changed outside the reviewed transition/u);
  });

  it('verifies observed outputs against reviewed after-hashes', async () => {
    const root = await project('planned-after');
    await writeFile(path.join(root, 'out.txt'), 'expected\n');
    await expect(assertPlannedFilesAfter(root, planWith([{ pathParts: ['out.txt'], beforeHash: null, afterHash: sha('expected\n') }]), []))
      .resolves.toBeUndefined();
    await expect(assertPlannedFilesAfter(root, planWith([{ pathParts: ['out.txt'], beforeHash: null, afterHash: sha('other\n') }]), []))
      .rejects.toThrow('The observed output out.txt does not match the reviewed after-hash.');
    await expect(assertPlannedFilesAfter(root, planWith([{ pathParts: ['out.txt'], beforeHash: sha('expected\n'), afterHash: null }]),
      [{ type: 'delete', pathParts: ['out.txt'] }])).resolves.toBeUndefined();
    await expect(assertPlannedFilesAfter(root, planWith([{ pathParts: ['deferred.txt'], beforeHash: null, afterHash: sha('deferred') }]),
      [{ type: 'write', pathParts: ['deferred.txt'], content: 'tampered' }])).rejects.toThrow(/deferred\.txt does not match the reviewed after-hash/u);
    await expect(assertPlannedFilesAfter(root, planWith(undefined), [])).resolves.toBeUndefined();
  });

  it('accepts only ancestry-preserving commits, reviewed initialization branches, and one new approved origin', async () => {
    const ancestryRunner = (status: number, extra: Partial<CommandResult> = {}): CommandRunner & { calls: string[][] } => {
      const calls: string[][] = [];
      return {
        calls,
        async run(command) {
          calls.push([command.executable, ...command.args]);
          return { command, displayCommand: 'git merge-base', status, signal: null, stdout: '', stderr: '', timedOut: false, ...extra };
        }
      };
    };
    const commit = (inputs: Record<string, unknown> = {}, actionId = 'git.commit-reviewed'): TransitionOperation => ({
      adapter: 'git', actionId, mutationClass: 'git-commit', phaseId: 'committed', inputs, remote: false, destructive: false,
      destination: { type: 'local', identity: '/project' }
    });
    const bind = (pushUrl: string): TransitionOperation => ({
      adapter: 'git', actionId: 'git.remote.bind', mutationClass: 'git-remote-bind', phaseId: 'pushed', inputs: { name: 'origin', pushUrl },
      remote: false, destructive: false, destination: { type: 'local', identity: '.git/config' }
    });
    const clean = { head: 'a'.repeat(40), branch: 'develop', pushUrls: [] as string[] };
    const origin = 'https://github.com/owner/repo.git';
    expect(await verifiedGitInputBinding(clean, { ...clean }, { operations: [] }, '/project', ancestryRunner(0))).toBeUndefined();
    for (const failure of [ancestryRunner(1), ancestryRunner(0, { timedOut: true }), ancestryRunner(0, { errorCode: 'ENOENT' })]) {
      await expect(verifiedGitInputBinding(clean, { ...clean, head: 'b'.repeat(40) }, { operations: [commit()] }, '/project', failure))
        .rejects.toThrow('The resulting commit does not preserve the reviewed Git ancestry; no success was recorded.');
      expect(failure.calls).toEqual([['git', 'merge-base', '--is-ancestor', 'a'.repeat(40), 'b'.repeat(40)]]);
    }
    await expect(verifiedGitInputBinding(clean, { ...clean, head: null }, { operations: [commit()] }, '/project', ancestryRunner(0)))
      .rejects.toThrow('Git HEAD changed outside an approved history-preserving commit operation.');
    const unborn = { head: null, branch: null, pushUrls: [] as string[] };
    const initialized = { head: 'c'.repeat(40), branch: 'develop', pushUrls: [] as string[] };
    const noAncestry = ancestryRunner(1);
    expect(await verifiedGitInputBinding(unborn, initialized, { operations: [commit({ initialBranch: 'develop' }, 'git.init')] }, '/project', noAncestry))
      .toEqual({ before: unborn, after: initialized });
    expect(noAncestry.calls).toEqual([]);
    await expect(verifiedGitInputBinding(unborn, initialized, { operations: [commit({ initialBranch: 'main' }, 'git.init')] }, '/project', noAncestry))
      .rejects.toThrow('The selected Git branch changed outside the reviewed initialization boundary.');
    await expect(verifiedGitInputBinding(clean, { ...clean, branch: 'feature' }, { operations: [commit()] }, '/project', ancestryRunner(0)))
      .rejects.toThrow('The selected Git branch changed outside the reviewed initialization boundary.');
    expect(await verifiedGitInputBinding(clean, { ...clean, pushUrls: [origin] }, { operations: [bind(origin)] }, '/project', ancestryRunner(0)))
      .toEqual({ before: clean, after: { ...clean, pushUrls: [origin] } });
    for (const [before, after, operations] of [
      [clean, { ...clean, pushUrls: [origin, 'git@github.com:owner/repo.git'] }, [bind(origin)]],
      [clean, { ...clean, pushUrls: ['https://github.com/owner/other.git'] }, [bind(origin)]],
      [{ ...clean, pushUrls: ['https://github.com/owner/old.git'] }, { ...clean, pushUrls: [origin] }, [bind(origin)]],
      [clean, { ...clean, pushUrls: [origin] }, []]
    ] as const) {
      await expect(verifiedGitInputBinding(before, after, { operations }, '/project', ancestryRunner(0)))
        .rejects.toThrow(/existing remotes are never replaced/u);
    }
  });
});

describe('transition planning refusals', () => {
  it('refuses disabled governance, cross-scope phases, protected inputs, and unplannable recovery without writes', async () => {
    const root = await project('planning-scope');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const inspection = await existingPrivatePath(root);
    const before = await treeFingerprint(root);
    const disabled: GovernanceTransitionInspection = {
      ...inspection, manifest: { ...inspection.manifest, governance: { profile: 'none', state: 'disabled' } }
    };
    const cases: Array<[GovernanceTransitionInspection, PhaseId | undefined, string]> = [
      [disabled, undefined, 'Governance activation is explicitly disabled. A local repair, JSON flag, or existing approval cannot enable the profile.'],
      [{ ...inspection, scope: 'local' }, undefined, 'The local scope cannot plan or execute existing-private-path.'],
      [{ ...inspection, scope: 'lifecycle' }, undefined, 'The lifecycle scope cannot plan or execute existing-private-path.'],
      [{ ...inspection, scope: 'activation' }, 'bootstrap-state-disposed', 'The activation scope cannot plan or execute bootstrap-state-disposed.'],
      [{ ...inspection, sensitivePathExclusions: [['infrastructure', 'state.enc.txt'], ['governance', 'private', 'x']] }, 'seed-verified',
        'Protected retained material overlaps public verification input infrastructure/state.enc.txt.'],
      [{ ...inspection, recoverPhase: 'existing-private-path', readiness: {
        ...inspection.readiness, phases: { ...inspection.readiness.phases,
          'existing-private-path': { state: 'blocked', blockers: ['Awaiting backend reachability.'], plannable: false } }
      } }, undefined, 'Recovery of existing-private-path is not plannable: Awaiting backend reachability.']
    ];
    for (const [candidate, phaseId, expected] of cases) {
      await expect(buildSavedTransitionPlan({ inspection: candidate, runner, now: coverageNow, ...(phaseId ? { phaseId } : {}) }))
        .rejects.toThrow(expected);
    }
    const preview = await previewApplyNext({ inspection: disabled, runner, now: coverageNow, execute: true });
    expect(preview).toMatchObject({ reason: 'blocked', authorized: false, noWrites: true, savedPlan: null, approval: null });
    expect(preview.blockers[0]).toMatch(/Governance activation is explicitly disabled/u);
    expect(await treeFingerprint(root)).toBe(before);
    expect(runner.providerCalls).toEqual([]);
  });

  it('requires concrete planners, selected backend paths, governance destinations, and reviewed ruleset sources', async () => {
    const root = await project('planning-prerequisites');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const bare = coverageState();
    const ambiguous = { status: 'ambiguous', selected: null, candidates: [], blockers: ['Two changes claim authority.'],
      supersession: { records: [], invalidRecords: [], selectedChangeId: null, issues: [] } } as GovernanceSourceOfTruthInspection;
    const uncreated = { status: 'none', selected: null, candidates: [], createPlan: {
      status: 'ready', reason: 'Create after approval.', changeId: 'governance-demo', workflowKind: 'openspec', requiredFacts: []
    } } as GovernanceSourceOfTruthInspection;
    const existingPrivate = coverageState({ applicability: { statePath: 'existing-private', privateStagingDast: false, credentialRequired: false } });
    const cases: Array<[Promise<GovernanceTransitionInspection>, string]> = [
      [coverageInspection({ root, phaseId: 'application-prerequisites-ready', state: bare }),
        'Phase application-prerequisites-ready requires its concrete production planner.'],
      [coverageInspection({ root, phaseId: 'remote-ready', state: bare }), 'Remote readiness requires an explicitly selected backend path.'],
      [coverageInspection({ root, phaseId: 'remote-ready', state: existingPrivate }),
        'Remote readiness requires successful proof from the selected backend path.'],
      [coverageInspection({ root, phaseId: 'activation-approved', state: bare, source: ambiguous }), 'A reviewed governance change destination is required.'],
      [coverageInspection({ root, phaseId: 'activation-approved', state: bare, source: uncreated }),
        'Current verified Phase 0 facts are required to preview governance change creation.'],
      [coverageInspection({ root, phaseId: 'enforcement-approved', state: bare }),
        'Final enforcement approval requires a current reviewed ruleset source digest.']
    ];
    const before = await treeFingerprint(root);
    for (const [inspection, expected] of cases) {
      await expect(buildSavedTransitionPlan({ inspection: await inspection, runner, now: coverageNow })).rejects.toThrow(expected);
    }
    expect(await treeFingerprint(root)).toBe(before);
  });

  it('reports readiness blockers or an explicit execution request without writing', async () => {
    const root = await project('planning-preview');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const inspection = await coverageInspection({ root, phaseId: 'remote-ready', state: coverageState({ activationInputs }), activationInputs });
    const before = await treeFingerprint(root);
    const requested = await previewApplyNext({ inspection, runner, now: coverageNow, execute: true });
    expect(requested).toMatchObject({
      reason: 'execute-requested', authorized: true, noWrites: true, savedPlan: null, selectedPhase: 'remote-ready',
      message: 'Execution requested; the plan must be saved and revalidated before any mutation.'
    });
    const idle: GovernanceTransitionInspection = {
      ...inspection, scope: 'activation', readiness: {
        nextReadyPhase: null, nextPlannablePhase: null,
        phases: { ...inspection.readiness.phases, committed: { state: 'blocked', blockers: ['Publication needs a reviewed commit.'] } }
      }
    };
    expect(await previewApplyNext({ inspection: idle, runner, now: coverageNow, execute: false })).toMatchObject({
      reason: 'blocked', selectedPhase: null, message: 'Publication needs a reviewed commit.', blockers: ['Publication needs a reviewed commit.'], noWrites: true
    });
    const nothing: GovernanceTransitionInspection = {
      ...idle, readiness: { ...idle.readiness, phases: Object.fromEntries(Object.keys(idle.readiness.phases).map((id) =>
        [id, { state: 'verified', blockers: [] }])) as unknown as GovernanceTransitionInspection['readiness']['phases'] }
    };
    expect(await previewApplyNext({ inspection: nothing, runner, now: coverageNow, execute: false })).toMatchObject({
      reason: 'blocked', message: 'No phase is ready for execution.', blockers: ['No phase is ready for execution.']
    });
    expect(await treeFingerprint(root)).toBe(before);
    expect(runner.providerCalls).toEqual([]);
  });
});
