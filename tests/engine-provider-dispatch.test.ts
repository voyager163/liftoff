import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeExecutionContext } from '../src/application/engine-composition.js';
import { phaseCapabilities } from '../src/domain/governance/activation/capabilities.js';
import { saveGovernancePreview, approveGovernancePreview, loadGovernancePreview } from '../src/governance-activation/public-plans.js';
import { assertGovernanceApprovalIssued } from '../src/governance-activation/authority-records.js';
import { buildSavedTransitionPlan, executeApplyNext } from '../src/governance-activation/transitions.js';
import type { GovernanceTransitionAdapters } from '../src/governance-activation/transition-ports.js';
import type { PhaseId } from '../src/domain/governance/activation/types.js';
import { validateUserActivationState } from '../src/domain/governance/activation/validators.js';
import type { CommandRunner } from '../src/process-runner.js';
import type { GitHubActivationTransport } from '../src/adapters/github/activation-rest.js';
import { PresentationSession } from '../src/terminal.js';
import { activationProducerFixture, producerSubscription, producerTenant } from './helpers/activation-producer-fixture.js';
import { WorkflowGitHubFixture, workflowFixtureNow, workflowFixturePath, workflowFixtureSource } from './helpers/workflow-publication-fixture.js';
import { CaptureStream } from './helpers.js';

interface OwnedFixture {
  path: string;
  device: number;
  inode: number;
  birthtimeMs: number;
  mode: number;
}
const roots: OwnedFixture[] = [];
let activeWork = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  const current = roots.splice(0);
  if (activeWork) throw new Error(`Retaining active provider-dispatch fixtures: ${current.map((root) => root.path).join(', ')}`);
  for (const root of current) {
    const actual = await lstat(root.path);
    if (!actual.isDirectory() || actual.isSymbolicLink() || await realpath(root.path) !== root.path ||
        actual.dev !== root.device || actual.ino !== root.inode ||
        actual.birthtimeMs !== root.birthtimeMs || actual.mode !== root.mode) {
      throw new Error(`Provider-dispatch fixture identity changed; preserving ${root.path}`);
    }
    await rm(root.path, { recursive: true });
  }
});

type Fixture = Awaited<ReturnType<typeof activationProducerFixture>>;

async function withFixture<T>(
  phaseId: PhaseId, phaseInputs: Record<string, unknown>, runner: CommandRunner, operation: (fixture: Fixture) => Promise<T>
): Promise<T> {
  activeWork++;
  try {
    const fixture = await activationProducerFixture(phaseId, phaseInputs, runner);
    const root = await realpath(fixture.root), identity = await lstat(root);
    if (root !== fixture.root || !identity.isDirectory() || identity.isSymbolicLink()) {
      throw new Error('The newly created producer fixture lacks its exact directory identity.');
    }
    roots.push({ path: root, device: identity.dev, inode: identity.ino, birthtimeMs: identity.birthtimeMs, mode: identity.mode });
    return await operation(fixture);
  } finally { activeWork--; }
}

function localReads(azureReadable = false) {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(command) {
      calls.push([command.executable, ...command.args]);
      if (command.executable === 'git') {
        return { command, displayCommand: 'isolated Git observation', status: 128, stdout: '', stderr: 'not a git repository', signal: null, timedOut: false };
      }
      expect(command).toEqual({
        executable: 'az', args: ['account', 'show', '--subscription', producerSubscription, '--output', 'json']
      });
      return {
        command, displayCommand: 'isolated Azure account observation', status: azureReadable ? 0 : 1,
        stdout: azureReadable ? JSON.stringify({ id: producerSubscription, tenantId: producerTenant, state: 'Enabled' }) : '',
        stderr: azureReadable ? '' : 'Fixture account observation denied; no login or provider operation was executed.',
        signal: null, timedOut: false
      };
    }
  };
  return { runner, calls };
}

async function tracedOwners(f: Fixture, transport?: GitHubActivationTransport) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const context = await composeExecutionContext({
    cwd: f.projectRoot, stdout, stderr, runner: f.runner, updatePreview: f.storage,
    ...(transport ? { adapters: { githubActivation: { transport } } } : {})
  }, new PresentationSession({ stdout, stderr }));
  const actual = context.adapters!.providerEngines!;
  const events: string[] = [];
  const assertStorage = (adapters: GovernanceTransitionAdapters | undefined) => {
    expect(adapters?.githubActivation?.storage?.homedir).toBe(f.home);
    expect(adapters?.azureActivation?.storage).toBe(adapters?.githubActivation?.storage);
    expect(adapters?.phases).toBeUndefined();
  };
  const repositoryGovernance = {
    planPhase: vi.fn<typeof actual.repositoryGovernance.planPhase>(async (input) => {
      events.push('plan-repository');
      assertStorage(input.adapters);
      return actual.repositoryGovernance.planPhase(input);
    }),
    executePhase: vi.fn<typeof actual.repositoryGovernance.executePhase>(async (input) => {
      events.push('execute-repository');
      assertStorage(input.adapters);
      return actual.repositoryGovernance.executePhase(input);
    })
  };
  const azureActivation = {
    planPhase: vi.fn<typeof actual.azureActivation.planPhase>(async (input) => {
      events.push('plan-azure');
      assertStorage(input.adapters);
      return actual.azureActivation.planPhase(input);
    }),
    executePhase: vi.fn<typeof actual.azureActivation.executePhase>(async (input) => {
      events.push('execute-azure');
      assertStorage(input.adapters);
      return actual.azureActivation.executePhase(input);
    }),
    planCompositePhase: vi.fn<typeof actual.azureActivation.planCompositePhase>(async (input) => {
      events.push('plan-composite');
      assertStorage(input.adapters);
      return actual.azureActivation.planCompositePhase(input);
    }),
    executeCompositePhase: vi.fn<typeof actual.azureActivation.executeCompositePhase>(async (input) => {
      events.push('execute-composite');
      assertStorage(input.adapters);
      return actual.azureActivation.executeCompositePhase(input);
    })
  };
  const adapters: GovernanceTransitionAdapters = {
    ...context.adapters, providerEngines: { repositoryGovernance, azureActivation }
  };
  return { context, adapters, repositoryGovernance, azureActivation, events };
}

async function assertNoPhaseProof(f: Fixture, phaseId: PhaseId) {
  const state = validateUserActivationState(JSON.parse(await readFile(path.join(f.projectRoot, 'governance', 'activation-state.json'), 'utf8')));
  expect(state.phases[phaseId].state).not.toBe('verified');
  expect(state.phases[phaseId].evidence).toEqual([]);
  expect(state.phaseOutputs?.[phaseId]).toBeUndefined();
}

describe('composed provider ownership under real governance gates', () => {
  it('uses real owner planners in canonical order and preserves the no-pair fallback plan', async () => {
    const { runner, calls } = localReads();
    await withFixture('phase-0-complete', {}, runner, async (f) => {
      const owners = await tracedOwners(f);
      const saved = await saveGovernancePreview(f.inspection, { runner, now: f.now, storage: f.storage, adapters: owners.adapters });
      expect(saved).not.toBeNull();
      expect(owners.events).toEqual(['plan-composite', 'plan-azure', 'plan-repository']);
      expect(saved!.preview.plan.operations.filter((operation) => operation.remote).map((operation) => operation.actionId))
        .toEqual(['azure.phase0.discover', 'github.phase0.discover']);
      expect((await loadGovernancePreview(f.projectRoot, saved!.preview.fingerprint, { now: f.now, storage: f.storage })).plan)
        .toEqual(saved!.preview.plan);
      const fallback = await buildSavedTransitionPlan({
        inspection: f.inspection, runner, now: f.now, createdAt: saved!.preview.plan.createdAt,
        adapters: { githubActivation: { storage: f.storage }, azureActivation: { storage: f.storage } }
      });
      expect(fallback).toEqual(saved!.preview.plan);
      expect(owners.repositoryGovernance.executePhase).not.toHaveBeenCalled();
      expect(owners.azureActivation.executePhase).not.toHaveBeenCalled();
      expect(calls.every(([executable]) => executable === 'git')).toBe(true);
    });
  });

  it('routes explicit Phase 0 execution through real Azure ownership and stops before GitHub on a blocked read', async () => {
    const { runner, calls } = localReads();
    await withFixture('phase-0-complete', {}, runner, async (f) => {
      const owners = await tracedOwners(f);
      const saved = await saveGovernancePreview(f.inspection, { runner, now: f.now, storage: f.storage, adapters: owners.adapters });
      expect(saved!.preview.plan.approval.required).toBe(false);
      owners.events.length = 0;
      const result = await executeApplyNext({
        inspection: f.inspection, reinspect: async () => f.inspection, runner, now: f.now,
        reviewedPlan: saved!.preview.plan, storage: f.storage, adapters: owners.adapters
      });
      expect(result).toMatchObject({ applied: false, authorized: false, reason: 'blocked', evidence: null });
      expect(result.message).toContain('Azure Phase 0 discovery failed');
      expect(owners.events.filter((event) => event.startsWith('execute'))).toEqual(['execute-composite', 'execute-azure']);
      expect(owners.azureActivation.executePhase).toHaveBeenCalledOnce();
      expect(owners.repositoryGovernance.executePhase).not.toHaveBeenCalled();
      expect(calls.filter(([executable]) => executable === 'az')).toHaveLength(1);
      await assertNoPhaseProof(f, 'phase-0-complete');
    });
  });

  it('reaches the real repository owner after the Azure observation without fabricating final phase proof', async () => {
    const { runner } = localReads(true);
    const requests: string[] = [];
    const transport: GitHubActivationTransport = {
      async request(request) {
        expect(request.method).toBe('GET');
        requests.push(request.path);
        return { status: 403, headers: { 'x-github-request-id': 'ENGINE-BOUNDARY-DENIED' }, data: { message: 'Fixture repository observation denied.' } };
      }
    };
    await withFixture('phase-0-complete', {}, runner, async (f) => {
      const owners = await tracedOwners(f, transport);
      const saved = await saveGovernancePreview(f.inspection, { runner, now: f.now, storage: f.storage, adapters: owners.adapters });
      owners.events.length = 0;
      const result = await executeApplyNext({
        inspection: f.inspection, reinspect: async () => f.inspection, runner, now: f.now,
        reviewedPlan: saved!.preview.plan, storage: f.storage, adapters: owners.adapters
      });
      expect(result).toMatchObject({ applied: false, authorized: false, reason: 'blocked', evidence: null });
      expect(owners.events.filter((event) => event.startsWith('execute')))
        .toEqual(['execute-composite', 'execute-azure', 'execute-repository']);
      expect(requests).toEqual(['/repos/owner/repo']);
      expect(result.executedOperations.map((operation) => operation.actionId)).toContain('azure.phase0.discover');
      await assertNoPhaseProof(f, 'phase-0-complete');
    });
  });

  it('retains direct built-in execution behavior when no provider pair is supplied', async () => {
    const { runner, calls } = localReads();
    await withFixture('phase-0-complete', {}, runner, async (f) => {
      const saved = await saveGovernancePreview(f.inspection, { runner, now: f.now, storage: f.storage });
      const result = await executeApplyNext({
        inspection: f.inspection, reinspect: async () => f.inspection, runner, now: f.now,
        reviewedPlan: saved!.preview.plan, storage: f.storage
      });
      expect(result).toMatchObject({ applied: false, authorized: false, reason: 'blocked', evidence: null });
      expect(result.message).toContain('Azure Phase 0 discovery failed');
      expect(calls.filter(([executable]) => executable === 'az')).toHaveLength(1);
      await assertNoPhaseProof(f, 'phase-0-complete');
    });
  });

  it.each([false, true])('does not bypass approval or capability denial through composed owners (approval issued: %s)', async (approve) => {
    const protocol = new WorkflowGitHubFixture(`${workflowFixtureSource}\n# Previously published source\n`);
    const runner: CommandRunner = { run: vi.fn(async () => { throw new Error('No native or provider process is authorized.'); }) };
    await withFixture('repository-workflow-source-ready', {
      sourceSha: protocol.baseSha, paths: [workflowFixturePath],
      publication: { featureBranch: 'automation/engine-boundary', repositoryId: 42, actorId: 7,
        commitTime: workflowFixtureNow, commitMessage: 'Review exact source through its owning engine' }
    }, runner, async (f) => {
      f.inspection.scope = 'repository';
      const source = path.join(f.projectRoot, workflowFixturePath);
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, workflowFixtureSource);
      await f.refreshInputs();
      const owners = await tracedOwners(f, {
        async request(request) {
          expect(request.method).toBe('GET');
          return protocol.request(request);
        }
      });
      const saved = await saveGovernancePreview(f.inspection, { runner, now: f.now, storage: f.storage, adapters: owners.adapters });
      expect(saved!.preview.plan.approval.required).toBe(true);
      let reviewed = saved!.preview.plan;
      if (approve) {
        const issued = await approveGovernancePreview({
          projectRoot: f.projectRoot, fingerprint: saved!.preview.fingerprint, inspect: async () => f.inspection,
          runner, now: f.now, storage: f.storage, adapters: owners.adapters
        });
        await assertGovernanceApprovalIssued(f.projectRoot, issued.envelope, f.storage);
        f.inspection.approvals = [...f.inspection.approvals, issued.envelope];
        reviewed = issued.plan;
      }
      owners.events.length = 0;
      const result = await executeApplyNext({
        inspection: f.inspection, reinspect: async () => f.inspection, runner, now: f.now,
        reviewedPlan: reviewed, storage: f.storage, adapters: owners.adapters
      });
      expect(result.applied).toBe(false);
      expect(result.evidence).toBeNull();
      expect(owners.events.filter((event) => event.startsWith('execute'))).toEqual([]);
      expect(owners.azureActivation.executePhase).not.toHaveBeenCalled();
      expect(owners.azureActivation.executeCompositePhase).not.toHaveBeenCalled();
      expect(owners.repositoryGovernance.executePhase).not.toHaveBeenCalled();
      if (approve) {
        expect(result).toMatchObject({ authorized: false, reason: 'blocked' });
        expect(result.approval?.evaluation.approvalRequired).toBe(false);
        expect(result.message).toBe(phaseCapabilities['repository-workflow-source-ready'].blocker);
      } else {
        expect(result.authorized).toBe(false);
        expect(result.approval?.evaluation.approvalRequired).toBe(true);
      }
      expect(protocol.requests.every((request) => request.method === 'GET')).toBe(true);
      expect(runner.run).not.toHaveBeenCalled();
      await assertNoPhaseProof(f, 'repository-workflow-source-ready');
    });
  });

  it('lets the real composite planner reject incomplete inputs without falling through to either provider planner', async () => {
    const { runner, calls } = localReads();
    await withFixture('private-backend-proof', {}, runner, async (f) => {
      const owners = await tracedOwners(f);
      await expect(saveGovernancePreview(f.inspection, { runner, now: f.now, storage: f.storage, adapters: owners.adapters }))
        .rejects.toThrow();
      expect(owners.azureActivation.planCompositePhase).toHaveBeenCalledOnce();
      const planned = await owners.azureActivation.planCompositePhase.mock.results[0]!.value;
      expect(planned).toMatchObject({ operations: [], blockers: [expect.any(String)] });
      expect(owners.azureActivation.planPhase).not.toHaveBeenCalled();
      expect(owners.repositoryGovernance.planPhase).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      await assertNoPhaseProof(f, 'private-backend-proof');
    });
  });
});
