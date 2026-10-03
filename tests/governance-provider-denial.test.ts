import { access, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@inquirer/prompts', () => ({ password: vi.fn() }));

import { password } from '@inquirer/prompts';
import {
  buildSavedTransitionPlan, canonicalPhaseGraph, executeApplyNext, loadActivationState, phaseCapabilities, previewApplyNext,
  validateSavedTransitionPlan, type ExternalOperationState, type GitHubRulesetAdapter, type GovernancePhaseAdapter,
  type PhaseAdapterOutcome, type PhaseId, type UserActivationState
} from '../src/governance-activation/index.js';
import { executeAzurePhase } from '../src/governance-activation/phase-azure.js';
import { executeGitHubPhase } from '../src/governance-activation/phase-github.js';
import { approveGovernancePreview, saveGovernancePreview } from '../src/governance-activation/public-plans.js';
import {
  LocalOnlyRunner, coverageActivationInputs, coverageInspection, coverageNow, coverageState, coverageSubscription,
  isolateUserLocalStorage, isolatedGitEnvironment, issuePriorApproval, readState, resetDirectory, scratchDirectory,
  treeFingerprint, userLocalRecordNames, writeCoverageProject
} from './fixtures/governance-coverage/transition-project.js';

const scratch = scratchDirectory('provider-denial');
const activationInputs = coverageActivationInputs();
const fineGrainedPat = ['github', 'pat', 'SYNTHETIC', 'DENIAL', 'VALUE', 'FOR', 'TESTS', 'ONLY', '0123456789ABCDEF0123'].join('_');
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

const ttyDescriptors = {
  stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
  stdout: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
};

afterEach(() => {
  for (const [name, descriptor] of Object.entries(ttyDescriptors)) {
    const stream = name === 'stdin' ? process.stdin : process.stdout;
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else delete (stream as { isTTY?: boolean }).isTTY;
  }
});

function privateTerminal(): void {
  for (const stream of [process.stdin, process.stdout]) {
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true, writable: true });
  }
  vi.mocked(password).mockResolvedValue(fineGrainedPat);
}

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

function phase(phaseId: PhaseId) {
  return canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
}

function credentialState(): UserActivationState {
  return coverageState({ applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: true } });
}

async function approvedInspection(root: string, phaseId: PhaseId, state: UserActivationState, runner: LocalOnlyRunner) {
  const planned = await buildSavedTransitionPlan({
    inspection: await coverageInspection({ root, phaseId, state, activationInputs }), runner, now: coverageNow
  });
  expect(planned?.phaseId).toBe(phaseId);
  const approvals = phase(phaseId).approvalGate.required ? [await issuePriorApproval(root, state, planned!)] : [];
  return coverageInspection({ root, phaseId, state, approvals, activationInputs });
}

describe('public capability table', () => {
  it('marks every producer without a built-in executor as an explicit public blocker', () => {
    const unavailable = Object.entries(phaseCapabilities).filter(([, capability]) => capability.executor !== 'built-in');
    expect(unavailable.length).toBeGreaterThan(0);
    for (const [phaseId, capability] of unavailable) {
      expect(capability.blocker, phaseId).toMatch(/\S/u);
      expect(capability.retry, phaseId).toBe('none');
    }
    expect(phaseCapabilities['provider-ready'].executor).toBe('unavailable');
    expect(phaseCapabilities['rulesets-applied'].executor).toBe('injected-only');
    expect(phaseCapabilities['credential-ready'].blocker).toMatch(/public credential enrollment are unavailable/u);
  });

  it('keeps read-only preview usable while surfacing the capability blocker without writes', async () => {
    const root = await project('preview');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const before = await treeFingerprint(root);
    const preview = await previewApplyNext({
      inspection: await coverageInspection({ root, phaseId: 'provider-ready', state: coverageState(), activationInputs }),
      runner, now: coverageNow, execute: false
    });
    expect(preview).toMatchObject({
      reason: 'blocked', selectedPhase: 'provider-ready', noWrites: true, savedPlan: null,
      blockers: [phaseCapabilities['provider-ready'].blocker]
    });
    expect(preview.proposedMutations.operations.map((operation) => operation.actionId)).toContain('azure.provider.ensure-ready');
    expect(await treeFingerprint(root)).toBe(before);
    expect(runner.providerCalls).toEqual([]);
  });
});

describe('public approval refuses unsupported capabilities', () => {
  it.each(['provider-ready', 'state-path-selected', 'credential-ready'] as const)(
    'saves an external preview for %s but issues no approval, authority record, or project file',
    async (phaseId) => {
      const root = await project(`approve-${phaseId}`);
      const runner = new LocalOnlyRunner(gitEnvironment);
      const state = phaseId === 'credential-ready' ? credentialState() : coverageState();
      const inspection = await coverageInspection({ root, phaseId, state, activationInputs });
      const saved = await saveGovernancePreview(inspection, { runner, now: coverageNow });
      expect(saved?.preview.plan).toMatchObject({ phaseId, approval: { evaluation: { approvalRequired: true } } });
      const before = await treeFingerprint(root);
      const recordsBefore = await userLocalRecordNames(storage.root);

      await expect(approveGovernancePreview({
        projectRoot: root, fingerprint: saved!.preview.fingerprint, inspect: async () => inspection, runner, now: coverageNow
      })).rejects.toThrow(phaseCapabilities[phaseId].blocker!);

      expect(await treeFingerprint(root)).toBe(before);
      expect(await userLocalRecordNames(storage.root)).toEqual(recordsBefore);
      expect(recordsBefore.some((name) => name.startsWith('governance-approval-'))).toBe(false);
      expect(runner.providerCalls).toEqual([]);
    }
  );
});

describe('execution guard for phases without a real executor', () => {
  it.each(['provider-ready', 'state-path-selected', 'runner-ready', 'rulesets-applied', 'live-readback'] as const)(
    'blocks %s even with previously issued authority before saving a plan, writing intent, or invoking a producer',
    async (phaseId) => {
      const root = await project(`execute-${phaseId}`);
      const runner = new LocalOnlyRunner(gitEnvironment);
      const inspection = await approvedInspection(root, phaseId, coverageState({ activationInputs }), runner);
      const before = await treeFingerprint(root);

      const result = await executeApplyNext({ inspection, reinspect: async () => inspection, runner, now: coverageNow });

      const blocker = phaseCapabilities[phaseId].blocker!;
      expect(result).toMatchObject({
        applied: false, authorized: false, reason: 'blocked', message: blocker, blockers: [blocker], selectedPhase: phaseId,
        executedPhase: null, savedPlan: null, evidence: null, stateHash: null, executedOperations: [], cleanupWarnings: []
      });
      expect(await treeFingerprint(root)).toBe(before);
      expect(await readState(root)).toBeUndefined();
      expect(runner.providerCalls).toEqual([]);
    }
  );

  it.each(['rulesets-applied', 'live-readback'] as const)(
    'keeps the trusted ruleset adapter seam for %s so enforcement preconditions still run',
    async (phaseId) => {
      const root = await project(`ruleset-seam-${phaseId}`);
      const runner = new LocalOnlyRunner(gitEnvironment);
      const inspection = await approvedInspection(root, phaseId, coverageState({ activationInputs }), runner);
      const providerAccess: string[] = [];
      const githubRulesets: GitHubRulesetAdapter = {
        async applyRuleset() { providerAccess.push('apply'); throw new Error('Ruleset writes require green/red proof.'); },
        async readRuleset() { providerAccess.push('read'); throw new Error('Ruleset reads require green/red proof.'); }
      };

      const result = await executeApplyNext({
        inspection, reinspect: async () => inspection, runner, now: coverageNow, adapters: { githubRulesets }
      });

      expect(result.applied).toBe(false);
      expect(result.message).toContain('green-red-proof');
      expect(result.evidence).toBeNull();
      expect(providerAccess).toEqual([]);
      expect((await readState(root))?.phases[phaseId].state).toBe('blocked');
    }
  );

  it('blocks credential enrollment with prior authority before any plan, intent, state, input, secret, policy, or evidence effect', async () => {
    const root = await project('credential-enroll');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const inspection = await approvedInspection(root, 'credential-ready', credentialState(), runner);
    privateTerminal();
    const before = await treeFingerprint(root);

    for (const credentialEnrollment of [{ protectedStdin: false }, { protectedStdin: true }, undefined]) {
      const result = await executeApplyNext({
        inspection, reinspect: async () => inspection, runner, now: coverageNow,
        ...(credentialEnrollment ? { credentialEnrollment } : {})
      });

      const blocker = phaseCapabilities['credential-ready'].blocker!;
      expect(result).toMatchObject({
        applied: false, authorized: false, reason: 'blocked', message: blocker, blockers: [blocker],
        executedPhase: null, savedPlan: null, evidence: null, stateHash: null, executedOperations: []
      });
      expect(JSON.stringify(result)).not.toContain(fineGrainedPat);
    }
    expect(await treeFingerprint(root)).toBe(before);
    expect(await readState(root)).toBeUndefined();
    expect(await exists(path.join(root, 'governance', 'plans'))).toBe(false);
    expect(await exists(path.join(root, 'governance', 'credentials', 'preflight-policy.json'))).toBe(false);
    expect(password).not.toHaveBeenCalled();
    expect(runner.providerCalls).toEqual([]);
  });

  it('still runs a trusted injected credential-ready adapter instead of the public refusal', async () => {
    const root = await project('credential-seam');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const inspection = await approvedInspection(root, 'credential-ready', credentialState(), runner);
    const invoked: PhaseId[] = [];
    const credentialAdapter: GovernancePhaseAdapter = {
      phaseId: 'credential-ready',
      async execute(input) {
        invoked.push(input.phase.id);
        return { status: 'blocked', blocker: 'Injected credential producer refused without readback.', completedOperations: [] };
      }
    };
    const adapters = { phases: { 'credential-ready': credentialAdapter } };

    const result = await executeApplyNext({ inspection, reinspect: async () => inspection, runner, now: coverageNow, adapters });

    expect(invoked).toEqual(['credential-ready']);
    expect(result).toMatchObject({ applied: false, reason: 'blocked', blockers: ['Injected credential producer refused without readback.'] });
    expect(runner.providerCalls).toEqual([]);
  });
});

describe('producers cannot manufacture provider proof when invoked directly', () => {
  it.each(['provider-ready', 'state-path-selected'] as const)('returns an explicit blocked outcome from the Azure %s producer', async (phaseId) => {
    const root = await project(`azure-${phaseId}`);
    const runner = new LocalOnlyRunner(gitEnvironment);
    const inspection = await coverageInspection({ root, phaseId, state: coverageState({ activationInputs }), activationInputs });
    const plan = (await buildSavedTransitionPlan({ inspection, runner, now: coverageNow }))!;
    const before = await treeFingerprint(root);

    const outcome = await executeAzurePhase({ inspection, plan, phase: phase(phaseId), runner, adapters: {}, now: coverageNow });

    expect(outcome).toEqual({ status: 'blocked', blocker: phaseCapabilities[phaseId].blocker, completedOperations: [] });
    expect(await treeFingerprint(root)).toBe(before);
    expect(runner.providerCalls).toEqual([]);
  });

  it('refuses direct credential enrollment before selecting or reading any input channel', async () => {
    const root = await project('credential-direct');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const inspection = await coverageInspection({ root, phaseId: 'credential-ready', state: credentialState() });
    const plan = (await buildSavedTransitionPlan({ inspection, runner, now: coverageNow }))!;
    privateTerminal();
    const before = await treeFingerprint(root);

    for (const protectedStdin of [false, true]) {
      const outcome = await executeGitHubPhase({
        inspection, plan, phase: phase('credential-ready'), runner, adapters: {}, now: coverageNow, credentialEnrollment: { protectedStdin }
      });
      expect(outcome).toEqual({
        status: 'blocked', completedOperations: [],
        blocker: expect.stringContaining(phaseCapabilities['credential-ready'].blocker!)
      });
    }
    expect(password).not.toHaveBeenCalled();
    expect(runner.providerCalls).toEqual([]);
    expect(await treeFingerprint(root)).toBe(before);
  });
});

describe('pending external operations', () => {
  const handle: ExternalOperationState = {
    provider: 'azure', actionId: 'azure.existing-private-path.verify', operationId: 'op-123',
    resourceId: `/subscriptions/${coverageSubscription}/resourceGroups/rg-state`,
    startedAt: coverageNow.toISOString(), observedAt: coverageNow.toISOString(), status: 'running'
  };

  function adapter(outcomes: PhaseAdapterOutcome[], seen: Array<ExternalOperationState | null>): GovernancePhaseAdapter {
    return {
      phaseId: 'existing-private-path',
      async execute(input) {
        seen.push(input.inspection.state.phases['existing-private-path'].operation ?? null);
        const next = outcomes.shift();
        if (!next) throw new Error('The injected producer was invoked more often than reviewed.');
        return next;
      }
    };
  }

  it('records a running provider operation for resume and resumes only the exact reviewed operation set', async () => {
    const root = await project('pending-resume');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const seen: Array<ExternalOperationState | null> = [];
    const failed = { ...handle, status: 'failed' as const, observedAt: new Date(coverageNow.getTime() + 120_000).toISOString() };
    const adapters = { phases: { 'existing-private-path': adapter([
      { status: 'pending', operation: handle, completedOperations: [] },
      { status: 'blocked', blocker: 'Provider operation op-123 failed; inspect the owned resource before recovery.', operation: failed, completedOperations: [] }
    ], seen) } };
    const inspection = await coverageInspection({ root, phaseId: 'existing-private-path', state: coverageState({ activationInputs }), activationInputs });

    const pending = await executeApplyNext({ inspection, reinspect: async () => inspection, runner, now: coverageNow, adapters });

    expect(pending).toMatchObject({
      applied: false, authorized: true, reason: 'external-operation-pending', executedPhase: 'existing-private-path',
      nextReadyPhase: 'existing-private-path', evidence: null
    });
    expect(pending.blockers[0]).toContain('op-123 is running; resume polls this operation without redispatch');
    expect(pending.executedOperations.map((operation) => operation.actionId)).toEqual(['governance.activation-state.write']);
    const savedPlan = validateSavedTransitionPlan(JSON.parse(await readFile(path.join(root, ...pending.savedPlan!.pathParts), 'utf8')));
    const running = (await readState(root))!.phases['existing-private-path'];
    expect(running).toMatchObject({ state: 'running', executionPlanDigest: savedPlan.planDigest, operation: { ...handle, planDigest: savedPlan.planDigest } });
    expect(await exists(path.join(root, 'governance', 'evidence'))).toBe(false);

    const loaded = (await loadActivationState(root))!;
    const unreviewed = await coverageInspection({ root, phaseId: 'existing-private-path', state: loaded.state, activationInputs });
    unreviewed.loadedState = loaded;
    const stateBytes = await readFile(path.join(root, 'governance', 'activation-state.json'));
    await expect(executeApplyNext({
      inspection: unreviewed, reinspect: async () => unreviewed, runner, now: new Date(coverageNow.getTime() + 60_000), adapters
    })).rejects.toThrow(/pending external operation does not match this exact reviewed operation set/);
    expect(await readFile(path.join(root, 'governance', 'activation-state.json'))).toEqual(stateBytes);
    expect(seen).toHaveLength(1);

    const resumable = await coverageInspection({
      root, phaseId: 'existing-private-path', state: loaded.state, reviewedPlans: [savedPlan], activationInputs
    });
    resumable.loadedState = loaded;
    const resumed = await executeApplyNext({
      inspection: resumable, reinspect: async () => resumable, runner, now: new Date(coverageNow.getTime() + 60_000), adapters
    });

    expect(seen[1]).toMatchObject({ operationId: 'op-123', status: 'running', planDigest: savedPlan.planDigest });
    expect(resumed).toMatchObject({
      applied: false, reason: 'blocked', evidence: null,
      blockers: ['Provider operation op-123 failed; inspect the owned resource before recovery.']
    });
    expect((await readState(root))!.phases['existing-private-path']).toMatchObject({
      state: 'blocked', evidence: [], operation: { operationId: 'op-123', status: 'failed', planDigest: savedPlan.planDigest }
    });
    expect(runner.providerCalls).toEqual([]);
  });

  it.each([
    ['without a concrete handle', { status: 'pending', completedOperations: [] } satisfies PhaseAdapterOutcome, /concrete resumable external operation handle/],
    ['with a non-running handle', { status: 'pending', operation: { ...handle, status: 'completed' }, completedOperations: [] } satisfies PhaseAdapterOutcome,
      /concrete resumable external operation handle/],
    ['for an unreviewed action', { status: 'pending', operation: { ...handle, actionId: 'azure.bootstrap-local.apply' }, completedOperations: [] } satisfies PhaseAdapterOutcome,
      /no corresponding action in the reviewed plan/],
    ['with a state-free retry after an external handle',
      { status: 'blocked', blocker: 'retry later', retryableWithoutStateMutation: true, operation: handle, completedOperations: [] } satisfies PhaseAdapterOutcome,
      /cannot request a state-free retry/]
  ])('refuses a pending outcome %s without persisting fabricated progress', async (_label, outcome, expected) => {
    const root = await project('pending-invalid');
    const runner = new LocalOnlyRunner(gitEnvironment);
    const inspection = await coverageInspection({ root, phaseId: 'existing-private-path', state: coverageState({ activationInputs }), activationInputs });
    const adapters = { phases: { 'existing-private-path': adapter([outcome as PhaseAdapterOutcome], []) } };

    await expect(executeApplyNext({ inspection, reinspect: async () => inspection, runner, now: coverageNow, adapters })).rejects.toThrow(expected);

    expect(await readState(root)).toBeUndefined();
    expect(await exists(path.join(root, 'governance', 'evidence'))).toBe(false);
    expect((await readdir(path.join(root, 'governance', 'plans'))).length).toBe(1);
  });
});
