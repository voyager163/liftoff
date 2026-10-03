import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubActivationError } from '../src/adapters/github/activation-rest.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { inspectGovernanceTransition } from '../src/governance-activation/commands.js';
import { inspectCurrentActivationEvidence } from '../src/governance-activation/read-only.js';
import {
  buildSavedTransitionPlan, canonicalApprovalEnvelopeHash, canonicalPhaseGraph, canonicalSha256, currentActivationIdentity, executeApplyNext,
  transitionPlanForPhase,
  type ActivationConfiguration, type ApprovalEnvelope, type GovernanceTransitionAdapters, type GovernanceTransitionInspection,
  type PhaseAdapterExecutionInput, type PhaseId, type PhasePlanningInput, type SavedTransitionPlan, type TransitionOperation,
  type UserActivationState
} from '../src/governance-activation/index.js';
import {
  assertGitHubAuthorized, digest, githubOperation, ownedPath, phaseConfiguration, repositoryConfiguration, sourceSha, verifiedOutput
} from '../src/governance-activation/github-config.js';
import { executeGitHubPublication, planGitHubPublication } from '../src/governance-activation/github-publication.js';
import { classifyGitHubWorkload, executeGitHubDiscovery, observeGitHubPhase0, planGitHubDiscovery } from '../src/governance-activation/github-discovery.js';
import { discoverPhase0 } from '../src/governance-activation/phase-discovery.js';
import type { CommandResult, CommandRunner } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';
import { fixtureContext } from './governance-activation-fixtures.js';
import { FakeGitHub, FakeGitRunner, FakeProviderRunner } from './fixtures/governance-coverage/github-fakes.js';
import {
  coverageInspection, coverageNow, coverageState, isolateUserLocalStorage, issuePriorApproval, readState, resetDirectory,
  scratchDirectory, writeCoverageProject
} from './fixtures/governance-coverage/transition-project.js';

const scratch = scratchDirectory('github-publication');
const origin = 'https://github.com/owner/repo.git';
const localHead = 'a'.repeat(40);
const inputs: ActivationConfiguration = { schemaVersion: 1, phases: {}, repository: { name: 'owner/repo', create: true, visibility: 'private' } };
const phase = (id: PhaseId) => canonicalPhaseGraph.phases.find((entry) => entry.id === id)!;
const sentinel = ['sentinel', 'provider', 'secret', 'for', 'diagnostics'].join('-');
let counter = 0;
let storage: Awaited<ReturnType<typeof isolateUserLocalStorage>>;

beforeAll(async () => {
  await resetDirectory(scratch);
  storage = await isolateUserLocalStorage();
});
afterAll(async () => {
  await storage.restore();
  await rm(scratch, { recursive: true, force: true });
});

async function project(label: string): Promise<string> {
  counter += 1;
  return writeCoverageProject(path.join(scratch, `${label}-${counter}`));
}

function unpublishedState(): UserActivationState {
  const state = coverageState();
  delete state.remoteBinding;
  return state;
}

function adapters(github: FakeGitHub): GovernanceTransitionAdapters {
  return { githubActivation: { transport: github } } as unknown as GovernanceTransitionAdapters;
}

function planning(inspection: GovernanceTransitionInspection, runner: CommandRunner, github: FakeGitHub, phaseId: PhaseId = 'pushed'): PhasePlanningInput {
  return { inspection, phase: phase(phaseId), runner, now: coverageNow, adapters: adapters(github) } as unknown as PhasePlanningInput;
}

async function rejectedWith(promise: Promise<unknown>, code: string): Promise<GitHubActivationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubActivationError);
    expect((error as GitHubActivationError).code).toBe(code);
    return error as GitHubActivationError;
  }
  throw new Error(`Expected GitHub refusal ${code}.`);
}

async function publicationFixture(label: string, prepare: (github: FakeGitHub, git: FakeGitRunner) => void = () => undefined) {
  const root = await project(label);
  const github = new FakeGitHub();
  const git = new FakeGitRunner(root, github);
  github.ownerTypes.set('owner', 'User');
  prepare(github, git);
  const inspection = await coverageInspection({ root, phaseId: 'pushed', state: unpublishedState(), activationInputs: inputs });
  return { root, github, git, inspection };
}

function reviewed(inspection: GovernanceTransitionInspection, operations: readonly TransitionOperation[], overrides: Partial<SavedTransitionPlan> = {}) {
  const request = transitionPlanForPhase(phase('pushed'), inspection.state, fixtureContext('pushed').transition);
  const envelope: ApprovalEnvelope = {
    ...request, schemaVersion: currentActivationIdentity.approvalEnvelopeSchemaVersion, id: 'pushed-approval',
    approvedAt: coverageNow.toISOString(), expiresAt: new Date(coverageNow.getTime() + 10 * 60_000).toISOString(), approver: 'owner'
  };
  const plan = {
    phaseId: 'pushed', scope: 'activation', createdAt: coverageNow.toISOString(),
    expiresAt: new Date(coverageNow.getTime() + 15 * 60_000).toISOString(), operations, configuration: inputs,
    approval: { gateKind: 'repository-publish', required: true, envelopeId: envelope.id, envelopeHash: canonicalApprovalEnvelopeHash(envelope) },
    ...overrides
  } as unknown as SavedTransitionPlan;
  return { plan, envelope, inspection: { ...inspection, approvals: [envelope] } };
}

function execution(inspection: GovernanceTransitionInspection, plan: SavedTransitionPlan, runner: CommandRunner, github: FakeGitHub): PhaseAdapterExecutionInput {
  return { inspection, plan, phase: phase('pushed'), runner, adapters: adapters(github), now: coverageNow };
}

describe('GitHub activation configuration helpers', () => {
  it('binds repository configuration to the verified publication and single-maintainer default branch', async () => {
    const root = await project('config');
    const bound = await coverageInspection({ root, phaseId: 'phase-0-complete', state: coverageState() });
    expect(repositoryConfiguration(bound)).toEqual({ name: 'owner/repo', defaultBranch: 'develop', visibility: 'private', create: false });
    expect(repositoryConfiguration({ ...bound, activationInputs: { schemaVersion: 1, phases: {}, repository: { name: 'Owner/Repo' } } }).name)
      .toBe('Owner/Repo');
    await rejectedWith(Promise.resolve().then(() => repositoryConfiguration({
      ...bound, activationInputs: { schemaVersion: 1, phases: {}, repository: { name: 'owner/other' } }
    })), 'repository-drift');
    await rejectedWith(Promise.resolve().then(() => repositoryConfiguration({
      ...bound, activationInputs: { schemaVersion: 1, phases: {}, repository: { name: 'owner/repo', defaultBranch: 'main' } }
    })), 'policy-default-branch');
    const unbound = await coverageInspection({ root, phaseId: 'pushed', state: { ...unpublishedState(), repository: { id: 'R_1', name: 'demo', defaultBranch: 'develop' } } });
    expect(repositoryConfiguration(unbound).name).toBe('owner/demo');
    expect(phaseConfiguration(unbound, 'runner-ready', ['group'])).toEqual({});
    const configured = { ...unbound, activationInputs: { schemaVersion: 1, phases: { 'runner-ready': { group: 'restricted', command: 'curl' } } } } as GovernanceTransitionInspection;
    await rejectedWith(Promise.resolve().then(() => phaseConfiguration(configured, 'runner-ready', ['group'])), 'invalid-configuration');
    expect(phaseConfiguration(configured, 'runner-ready', ['group', 'command'])).toEqual({ group: 'restricted', command: 'curl' });
  });

  it('accepts only immutable source identities, owned paths, and verified predecessor outputs', async () => {
    expect(sourceSha('b'.repeat(40))).toBe('b'.repeat(40));
    for (const value of ['b'.repeat(39), 'main', 'B'.repeat(40)]) await rejectedWith(Promise.resolve().then(() => sourceSha(value)), 'source-required');
    expect(digest(`sha256:${'c'.repeat(64)}`)).toBe(`sha256:${'c'.repeat(64)}`);
    for (const value of ['c'.repeat(64), 'sha256:short', `sha1:${'c'.repeat(40)}`]) await rejectedWith(Promise.resolve().then(() => digest(value)), 'digest-required');
    expect(ownedPath('backend/src/app.ts', 'Artifact')).toBe('backend/src/app.ts');
    for (const value of ['../escape', 'a//b', '.git/config', 'src/.git/hooks', 'governance/evidence/x.json', '.env', 'config/.env.local',
      'infra/state.tfstate', 'infra/state.tfstate.backup', '/absolute', 'with space']) {
      await rejectedWith(Promise.resolve().then(() => ownedPath(value, 'Artifact')), 'unsafe-path');
    }
    const root = await project('outputs');
    const state = coverageState({ phaseOutputs: { 'phase-0-complete': { values: { repositoryId: 42 }, resources: [] } } });
    state.phases['phase-0-complete'].state = 'verified';
    const inspection = await coverageInspection({ root, phaseId: 'runner-ready', state });
    expect(verifiedOutput(inspection, 'phase-0-complete', 'repositoryId')).toBe(42);
    await rejectedWith(Promise.resolve().then(() => verifiedOutput(inspection, 'phase-0-complete', 'workload')), 'predecessor-required');
    await rejectedWith(Promise.resolve().then(() => verifiedOutput(inspection, 'provider-ready', 'subscriptionId')), 'predecessor-required');
    const failed = structuredClone(state);
    failed.phases['phase-0-complete'].state = 'failed';
    await rejectedWith(Promise.resolve().then(() => verifiedOutput({ ...inspection, state: failed }, 'phase-0-complete', 'repositoryId')), 'predecessor-required');
  });

  it('checks the lease, exact reviewed operation, plan expiry, and configuration before approval-free GitHub reads', async () => {
    const root = await project('authorized');
    const inspection = await coverageInspection({ root, phaseId: 'phase-0-complete', state: coverageState(), activationInputs: inputs });
    const input = planning(inspection, new FakeGitRunner(root), new FakeGitHub(), 'phase-0-complete');
    const operation = githubOperation(input, 'github.phase0.discover', 'github-read', { repository: 'owner/repo' });
    expect(operation.destination).toEqual({ type: 'repository', identity: 'owner/repo', repository: 'owner/repo' });
    const custom = githubOperation(input, 'github.phase0.discover', 'github-read', {}, { type: 'external', identity: 'api.github.com' },
      [{ mutationClass: 'github-read', remote: true, destructive: false, destination: { type: 'external', identity: 'api.github.com' } }]);
    expect(custom).toMatchObject({ destination: { type: 'external' }, effects: [{ mutationClass: 'github-read' }] });
    const leases: string[] = [];
    const plan = { phaseId: 'phase-0-complete', scope: 'activation', operations: [operation], configuration: inputs,
      expiresAt: new Date(coverageNow.getTime() + 60_000).toISOString(), approval: { envelopeId: null, envelopeHash: null } } as unknown as SavedTransitionPlan;
    const execute = (overrides: Partial<PhaseAdapterExecutionInput> = {}): PhaseAdapterExecutionInput => ({
      inspection, plan, phase: phase('phase-0-complete'), runner: new FakeGitRunner(root), adapters: {}, now: coverageNow,
      lease: { assertHeld: async () => { leases.push('held'); } } as PhaseAdapterExecutionInput['lease'], ...overrides
    });
    await expect(assertGitHubAuthorized(execute(), operation)).resolves.toBeUndefined();
    expect(leases).toEqual(['held']);
    await rejectedWith(assertGitHubAuthorized(execute(), { ...operation, inputs: { repository: 'owner/other' } }), 'stale-approval');
    await rejectedWith(assertGitHubAuthorized(execute({ plan: { ...plan, scope: 'local' } }), operation), 'stale-approval');
    await rejectedWith(assertGitHubAuthorized(execute({ clock: () => new Date(plan.expiresAt) }), operation), 'stale-approval');
    await rejectedWith(assertGitHubAuthorized(execute({ inspection: { ...inspection, activationInputs: { ...inputs, phases: { 'runner-ready': {} } } } }), operation),
      'stale-configuration');
  });
});

describe('publication planning refusals', () => {
  const cases: Array<[string, (github: FakeGitHub, git: FakeGitRunner) => void, string]> = [
    ['a dirty worktree', (_github, git) => { git.status = ['?? notes.txt']; }, 'publication-prerequisite'],
    ['a feature branch', (_github, git) => { git.branch = 'feature/x'; }, 'publication-prerequisite'],
    ['a foreign repository root', (_github, git) => { git.topLevel = path.parse(scratch).root; }, 'publication-prerequisite'],
    ['a different existing origin', (_github, git) => { git.remotes = [{ name: 'origin', url: 'https://github.com/owner/fork.git', pushUrls: ['https://github.com/owner/fork.git'] }]; },
      'remote-drift'],
    ['an absent repository without create approval', (github) => { github.ownerTypes.set('owner', 'User'); }, 'repository-prerequisite'],
    ['a personal repository for another identity', (github) => { github.actor = 'someone-else'; }, 'owner-prerequisite'],
    ['an inactive organization membership', (github) => { github.ownerTypes.set('owner', 'Organization'); github.memberships.set('owner', 'pending'); },
      'owner-prerequisite'],
    ['an unsupported owner type', (github) => { github.ownerTypes.set('owner', 'Bot'); }, 'owner-prerequisite'],
    ['an archived repository', (github) => { github.repository('owner/repo', { archived: true }); }, 'repository-binding'],
    ['a public repository when private was reviewed', (github) => { github.repository('owner/repo', { private: false }); }, 'repository-binding'],
    ['a fork', (github) => { github.repository('owner/repo', { fork: true }); }, 'repository-binding'],
    ['a nonconforming default branch', (github) => { github.repository('owner/repo', { default_branch: 'main' }); }, 'default-branch-prerequisite'],
    ['a non-fast-forward remote branch', (github, git) => {
      github.repository('owner/repo', { refs: { develop: 'b'.repeat(40) } });
      git.ancestor = false;
    }, 'non-fast-forward']
  ];

  it.each(cases)('refuses %s using reads only', async (label, prepare, code) => {
    const { github, git, inspection } = await publicationFixture('plan-refusal', prepare);
    const reviewedInputs = label.includes('without create approval')
      ? { ...inputs, repository: { name: 'owner/repo', visibility: 'private' as const } } : inputs;
    await rejectedWith(planGitHubPublication(planning({ ...inspection, activationInputs: reviewedInputs }, git, github)), code);
    expect(github.writes()).toEqual([]);
    expect(git.calls.some((call) => ['push', 'remote add'].includes(call.slice(1, 3).join(' ')) || call[1] === 'push')).toBe(false);
  });

  it('plans repository creation, origin binding, push, and default branch only after verified identity reads', async () => {
    const { github, git, inspection } = await publicationFixture('plan-create');
    const planned = await planGitHubPublication(planning(inspection, git, github));
    expect(planned.operations.map((operation) => [operation.actionId, operation.mutationClass])).toEqual([
      ['github.repository.ensure', 'github-repository-create'], ['git.remote.bind', 'git-remote-bind'],
      ['git.push-approved-ref', 'git-push'], ['github.repository.default-branch', 'github-write']
    ]);
    expect(planned.operations[0]!.inputs).toMatchObject({ create: true, ownerKind: 'user', repositoryId: null, visibility: 'private' });
    expect(planned.operations[2]!.inputs).toMatchObject({ localHead, remoteHead: null, pushUrl: origin });
    expect(github.requests.map((request) => `${request.method} ${request.path}`)).toEqual(['GET /repos/owner/repo', 'GET /users/owner', 'GET /user']);
    expect(github.writes()).toEqual([]);
  });

  it('plans a verification-only publication when the reviewed commit is already on the remote', async () => {
    const { github, git, inspection } = await publicationFixture('plan-existing', (provider, local) => {
      const repository = provider.repository('owner/repo', { refs: { develop: localHead } });
      local.remotes = [{ name: 'origin', url: origin, pushUrls: [origin] }];
      expect(repository.id).toBeGreaterThan(0);
    });
    const planned = await planGitHubPublication(planning(inspection, git, github));
    expect(planned.operations.map((operation) => [operation.actionId, operation.mutationClass])).toEqual([
      ['github.repository.ensure', 'github-read'], ['git.verify-existing-push', 'github-read']
    ]);
    expect(planned.operations[0]!.inputs).toMatchObject({ create: false, repositoryId: 4200 });
    expect(github.writes()).toEqual([]);
  });
});

describe('publication execution', () => {
  async function plannedExecution(label: string, prepare: (github: FakeGitHub, git: FakeGitRunner) => void = () => undefined) {
    const fixture = await publicationFixture(label, prepare);
    const planned = await planGitHubPublication(planning(fixture.inspection, fixture.git, fixture.github));
    const authorized = reviewed(fixture.inspection, planned.operations);
    fixture.github.requests.length = 0;
    fixture.git.calls.length = 0;
    return { ...fixture, ...authorized, operations: planned.operations };
  }

  it('creates, binds, pushes, sets the default branch, and verifies independent readback', async () => {
    const { github, git, plan, inspection } = await plannedExecution('execute-success');
    const outcome = await executeGitHubPublication(execution(inspection, plan, git, github));
    expect(outcome).toMatchObject({ status: 'completed', resultState: 'verified' });
    expect(outcome.completedOperations!.map((operation) => operation.actionId)).toEqual([
      'github.repository.ensure', 'git.remote.bind', 'git.push-approved-ref', 'github.repository.default-branch'
    ]);
    expect(github.writes()).toEqual(['POST /user/repos', 'PATCH /repos/owner/repo']);
    expect(git.calls.filter((call) => ['remote', 'push'].includes(call[1]!) && call[2] !== '-v' && call[2] !== 'get-url')).toEqual([
      ['git', 'remote', 'add', 'origin', origin], ['git', 'push', origin, `${localHead}:refs/heads/develop`]
    ]);
    expect(outcome.stateOverride?.remoteBinding).toEqual({
      id: '4200', name: 'owner/repo', defaultBranch: 'develop', pushUrl: origin, verifiedAt: coverageNow.toISOString()
    });
    expect(outcome.outputs).toEqual({ values: { sourceSha: localHead, repositoryId: 4200, repository: 'owner/repo' },
      resources: [{ provider: 'github', resourceType: 'repository', resourceId: 'owner/repo' }] });
    expect(outcome.liveReadback).toEqual([expect.objectContaining({ provider: 'github', resourceType: 'repository', resourceId: 'owner/repo' })]);
    expect(outcome.evidencePayload).toEqual({ kind: 'pushed.v1', head: localHead, pushUrl: origin, repositoryId: 4200 });
  });

  it('refuses stale plans, changed configuration, and missing approval before any provider request', async () => {
    const { github, git, plan, inspection, envelope } = await plannedExecution('execute-authority');
    const attempts: Array<[PhaseAdapterExecutionInput, RegExp]> = [
      [{ ...execution(inspection, plan, git, github), now: new Date(plan.expiresAt) }, /absent from the reviewed activation plan, has changed, or has expired/u],
      [execution({ ...inspection, activationInputs: { ...inputs, repository: { ...inputs.repository!, visibility: 'public' } } }, plan, git, github),
        /Activation configuration changed after review/u],
      [execution({ ...inspection, approvals: [] }, plan, git, github), /approval is missing, changed, or expired immediately before mutation/u],
      [execution({ ...inspection, approvals: [{ ...envelope, approver: 'someone-else' }] }, plan, git, github), /approval is missing, changed, or expired/u],
      [execution(inspection, { ...plan, operations: plan.operations.filter((operation) => operation.actionId !== 'github.repository.ensure') }, git, github),
        /The reviewed repository binding operation is missing/u]
    ];
    for (const [input, expected] of attempts) {
      const outcome = await executeGitHubPublication(input);
      expect(outcome).toMatchObject({ status: 'blocked', completedOperations: [] });
      expect(outcome.blocker).toMatch(expected);
    }
    expect(github.requests).toEqual([]);
    expect(git.calls).toEqual([]);
  });

  it('never replaces a repository that disappeared after an existing-repository review', async () => {
    const { github, git, plan, inspection } = await plannedExecution('execute-vanished', (provider, local) => {
      provider.repository('owner/repo', { refs: { develop: localHead } });
      local.remotes = [{ name: 'origin', url: origin, pushUrls: [origin] }];
    });
    github.repositories.clear();
    const outcome = await executeGitHubPublication(execution(inspection, plan, git, github));
    expect(outcome).toMatchObject({ status: 'blocked', completedOperations: [],
      blocker: 'The reviewed existing repository is no longer visible; refusing to create a replacement.' });
    expect(github.writes()).toEqual([]);
  });

  const partial: Array<[string, (github: FakeGitHub, git: FakeGitRunner) => void, RegExp, string[]]> = [
    ['a created repository with the wrong visibility', (github) => {
      github.overrides.set('POST /user/repos', { status: 201, headers: {}, data: { id: 9, full_name: 'owner/repo', private: false, archived: false, fork: false } });
    }, /visibility, or ownership differs/u, ['github.repository.ensure']],
    ['local drift before origin binding', (_github, git) => { git.status = [' M backend/app.ts']; }, /Local Git inputs changed after publication review/u,
      ['github.repository.ensure']],
    ['a failed origin binding', (_github, git) => { git.remoteAddStatus = 1; }, /could not bind the approved origin; no existing remote was replaced/u,
      ['github.repository.ensure']],
    ['a moved HEAD before push', (_github, git) => {
      const add = git.run.bind(git);
      git.run = async (command: ExternalCommand, options) => {
        const result = await add(command, options);
        if (command.args[0] === 'remote' && command.args[1] === 'add') git.head = 'c'.repeat(40);
        return result;
      };
    }, /Git HEAD or push URL changed after review/u, ['github.repository.ensure', 'git.remote.bind']],
    ['a concurrently moved remote branch', (github, git) => {
      const add = git.run.bind(git);
      git.run = async (command: ExternalCommand, options) => {
        const result = await add(command, options);
        if (command.args[0] === 'remote' && command.args[1] === 'add') github.repositories.get('owner/repo')!.refs.develop = 'd'.repeat(40);
        return result;
      };
    }, /Remote branch changed concurrently; no force\/update was attempted/u, ['github.repository.ensure', 'git.remote.bind']],
    ['a rejected push', (_github, git) => { git.pushStatus = 1; }, /GitHub rejected publication; inspect protected-branch policy/u,
      ['github.repository.ensure', 'git.remote.bind']],
    ['a push that is not visible on readback', (github) => {
      github.overrides.set('GET /repos/owner/repo/git/ref/heads/develop', { status: 404, headers: {}, data: { message: 'Not Found' } });
      github.overrides.set('PATCH /repos/owner/repo', (request) => {
        const repository = github.repositories.get('owner/repo')!;
        Object.assign(repository, request.body as object);
        github.overrides.set('GET /repos/owner/repo/git/ref/heads/develop', { status: 200, headers: {}, data: { object: { sha: 'e'.repeat(40) } } });
        return { status: 200, headers: {}, data: { ...repository } };
      });
    }, /Independent repository\/ref readback differs from the reviewed local publication/u,
      ['github.repository.ensure', 'git.remote.bind', 'git.push-approved-ref', 'github.repository.default-branch']],
    ['an unexpected transport failure', (github) => {
      github.overrides.set('POST /user/repos', new Error(`socket closed: ghs_${'x'.repeat(30)}`));
    }, /^Publication could not be verified; raw Git\/provider diagnostics were withheld\.$/u, []]
  ];

  it.each(partial)('reports %s as blocked while retaining only actually completed operations', async (_label, prepare, expected, completed) => {
    const { github, git, plan, inspection } = await plannedExecution('execute-partial');
    prepare(github, git);
    const outcome = await executeGitHubPublication(execution(inspection, plan, git, github));
    expect(outcome.status).toBe('blocked');
    expect(outcome.blocker).toMatch(expected);
    expect(outcome.blocker).not.toMatch(/ghs_/u);
    expect(outcome.completedOperations!.map((operation) => operation.actionId)).toEqual(completed);
    expect(outcome).not.toHaveProperty('stateOverride');
    expect(outcome).not.toHaveProperty('liveReadback');
  });
});

describe('Phase 0 discovery refusals', () => {
  class Phase0Runner extends FakeGitRunner {
    ghResult: Partial<CommandResult> = { status: 0, stdout: '' };
    override async run(command: ExternalCommand, options?: Parameters<CommandRunner['run']>[1]): Promise<CommandResult> {
      if (command.executable === 'gh') {
        this.calls.push([command.executable, ...command.args]);
        return { command, displayCommand: 'gh repo view', status: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...this.ghResult };
      }
      return super.run(command, options);
    }
  }

  async function discovery(label: string, ghResult: Partial<CommandResult>) {
    const root = await project(label);
    const runner = new Phase0Runner(root);
    runner.remotes = [{ name: 'origin', url: origin, pushUrls: [origin] }];
    runner.ghResult = ghResult;
    const inspection = await coverageInspection({ root, phaseId: 'phase-0-complete', state: unpublishedState() });
    const operation = { adapter: 'github', actionId: 'github.phase0.discover', mutationClass: 'github-read', phaseId: 'phase-0-complete',
      inputs: { repository: 'owner/repo' }, remote: true, destructive: false,
      destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' } } as TransitionOperation;
    const plan = { phaseId: 'phase-0-complete', baselineDigest: 'f'.repeat(64), operations: [operation] } as unknown as SavedTransitionPlan;
    return { runner, input: { inspection, plan, phase: phase('phase-0-complete'), runner, adapters: {}, now: coverageNow } as PhaseAdapterExecutionInput };
  }

  it.each([
    ['a failed read', { status: 1, stderr: `HTTP 403 ${sentinel}` }, /^Phase 0 GitHub read-only discovery failed: GitHub CLI did not confirm read access\./u],
    ['an unstartable CLI', { status: null, errorCode: 'ENOENT', errorMessage: `spawn gh ${sentinel}` },
      /^Phase 0 GitHub read-only discovery failed: GitHub CLI could not be started\./u],
    ['a timed-out read', { status: null, timedOut: true, stderr: sentinel }, /^Phase 0 GitHub read-only discovery failed: the bounded read timed out\./u],
    ['invalid JSON', { stdout: `raw ${sentinel} response` }, /^Phase 0 GitHub discovery returned invalid JSON; response bytes were withheld\.$/u],
    ['incomplete identity', { stdout: JSON.stringify({ id: 'R_1', nameWithOwner: 'owner/repo' }) }, /did not return repository id, nameWithOwner, and default branch/u],
    ['a different push destination', { stdout: JSON.stringify({ id: 'R_1', nameWithOwner: 'owner/other', defaultBranchRef: { name: 'develop' } }) },
      /readback differs from the actual reviewed Git push destination/u]
  ] satisfies Array<[string, Partial<CommandResult>, RegExp]>)('blocks %s without binding a repository or claiming readback', async (_label, ghResult, expected) => {
    const { input, runner } = await discovery('phase0', ghResult);
    const outcome = await discoverPhase0(input);
    expect(outcome).toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(outcome!.blocker).toMatch(expected);
    expect(outcome!.blocker).not.toContain(sentinel);
    expect(outcome!.blocker).not.toMatch(/HTTP 403|spawn gh|Unexpected token/u);
    expect(outcome).not.toHaveProperty('stateOverride');
    expect(outcome).not.toHaveProperty('liveReadback');
    expect(runner.calls[0]).toEqual(['gh', 'repo', 'view', 'owner/repo', '--json', 'id,nameWithOwner,defaultBranchRef,isPrivate']);
  });

  it('binds only a verified repository readback that matches the reviewed push destination', async () => {
    const { input } = await discovery('phase0-verified', {
      stdout: JSON.stringify({ id: 'R_1', nameWithOwner: 'Owner/Repo', defaultBranchRef: { name: 'develop' }, isPrivate: true })
    });
    const outcome = await discoverPhase0(input);
    expect(outcome).toMatchObject({ status: 'completed', resultState: 'verified' });
    expect(outcome!.stateOverride!.remoteBinding).toMatchObject({ id: 'R_1', name: 'Owner/Repo', pushUrl: origin, defaultBranch: 'develop' });
    expect(outcome!.stateOverride!.applicability).toEqual({ statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' });
    expect(await discoverPhase0({ ...input, phase: phase('pushed') })).toBeNull();
  });
});

describe('REST Phase 0 observation', () => {
  const sha = 'b'.repeat(40);
  const workflow = Buffer.from('name: CI\non: push\njobs:\n  test:\n    name: Unit tests\n    runs-on: ubuntu-latest\n    steps: []\n').toString('base64');

  async function observationFixture(label: string, complete: boolean) {
    const root = await project(label);
    await mkdir(path.join(root, 'backend'), { recursive: true });
    await writeFile(path.join(root, 'backend', 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run' } }));
    await writeFile(path.join(root, 'backend', 'package-lock.json'), '{}\n');
    await writeFile(path.join(root, 'backend', 'Dockerfile'), 'FROM node:24\n');
    const github = new FakeGitHub();
    github.repository('owner/repo', {
      id: 7, refs: { develop: sha }, owner: { login: 'owner', type: 'User', id: 1, node_id: 'withheld' },
      permissions: { admin: true, push: true, pull: true, maintain: true, triage: true },
      security_and_analysis: { secret_scanning: { status: 'enabled', extra: 'withheld' } }
    });
    const state = coverageState();
    state.remoteBinding = { ...state.remoteBinding!, id: '7' };
    const inspection = await coverageInspection({ root, phaseId: 'phase-0-complete', state });
    inspection.manifest = { ...inspection.manifest, projectArtifacts: [...inspection.manifest.projectArtifacts,
      { logicalName: 'backend-dockerfile', category: 'container', pathParts: ['backend', 'Dockerfile'], contentHash: `sha256:${'d'.repeat(64)}` }
    ] } as GovernanceTransitionInspection['manifest'];
    if (complete) {
      const page = (route: string, data: unknown) => github.overrides.set(`GET ${route}${route.includes('?') ? '&' : '?'}per_page=100&page=1`,
        { status: 200, headers: {}, data });
      page('/repos/owner/repo/branches', [{ name: 'develop', commit: { sha }, protected: true }, { name: 'feature/x', commit: { sha }, protected: false }]);
      page('/repos/owner/repo/actions/workflows', { total_count: 1, workflows: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] });
      github.overrides.set('GET /repos/owner/repo/contents/.github/workflows/ci.yml?ref=develop',
        { status: 200, headers: {}, data: { encoding: 'base64', content: workflow, size: 90 } });
      page('/repos/owner/repo/rulesets?includes_parents=true', [
        { id: 5, name: 'protect', source_type: 'Repository', source: 'owner/repo', target: 'branch', enforcement: 'active' },
        { id: 6, name: 'org', source_type: 'Organization', source: 'owner', target: 'branch', enforcement: 'active' }
      ]);
      github.overrides.set('GET /repos/owner/repo/rulesets/5', { status: 200, headers: {}, data: { bypass_actors: [], conditions: {}, rules: [], token: 'hidden' } });
      page('/repos/owner/repo/tags', []);
      page('/repos/owner/repo/releases', []);
      page('/repos/owner/repo/environments', { total_count: 1, environments: [
        { id: 3, name: 'prod', deployment_branch_policy: null, protection_rules: [{ type: 'required_reviewers', reviewers: [{}], wait_timer: 0 }] }
      ] });
      page('/repos/owner/repo/deployments', []);
      github.overrides.set('GET /repos/owner/repo/actions/permissions', { status: 200, headers: {}, data: { enabled: true, allowed_actions: 'selected' } });
      github.overrides.set('GET /repos/owner/repo/actions/permissions/workflow', { status: 200, headers: {}, data: {
        default_workflow_permissions: 'read', can_approve_pull_request_reviews: false } });
      page('/repos/owner/repo/code-scanning/alerts?state=open', [{ tool: { name: 'CodeQL' } }]);
      page('/repos/owner/repo/secret-scanning/alerts?state=open', []);
      page('/repos/owner/repo/dependabot/alerts?state=open', []);
      page(`/repos/owner/repo/commits/${sha}/check-runs?filter=latest`, { total_count: 1, check_runs: [
        { id: 11, name: 'CI', status: 'completed', conclusion: 'success', head_sha: sha, app: { id: 15368, slug: 'github-actions' } }
      ] });
    }
    const operation = githubOperation(planning(inspection, new FakeGitRunner(root), github, 'phase-0-complete'), 'github.phase0.discover', 'github-read', {});
    const plan = { phaseId: 'phase-0-complete', operations: [operation] } as unknown as SavedTransitionPlan;
    return {
      github,
      input: { inspection, plan, phase: phase('phase-0-complete'), runner: new FakeGitRunner(root), adapters: adapters(github), now: coverageNow } as PhaseAdapterExecutionInput
    };
  }

  it('refuses a repository whose identity differs from the verified publication binding', async () => {
    const { input } = await observationFixture('observe-drift', false);
    await rejectedWith(observeGitHubPhase0({ ...input, inspection: { ...input.inspection, state: coverageState() } }), 'phase0-binding');
  });

  it('keeps denied or unavailable inventories unknown instead of absent and blocks mandatory gaps', async () => {
    const { input, github } = await observationFixture('observe-incomplete', false);
    const outcome = await executeGitHubDiscovery(input);
    expect(outcome.status).toBe('blocked');
    expect(outcome.blocker).toMatch(/^Phase 0 has incomplete authoritative GitHub coverage: branches, workflows, rulesets, tags, releases, environments, deployments, actionsPermissions, codeScanning, secretProtection, dependencySecurity, contexts\./u);
    expect(outcome.blocker).not.toMatch(/runners|networkConfigurations/u);
    const payload = outcome.evidencePayload as { github: { observations: Record<string, { status: string; prerequisite?: string }> } };
    expect(payload.github.observations.identity.status).toBe('observed');
    expect(payload.github.observations.contexts).toEqual({ status: 'unknown', prerequisite: 'Branches are unreadable; required-context coverage cannot be inferred.' });
    expect(payload.github.observations.workflows.prerequisite).toMatch(/absent or is not visible to this identity \(HTTP 404\)/u);
    expect(outcome.completedOperations!.map((operation) => operation.actionId)).toEqual(['github.phase0.discover']);
    expect(outcome).not.toHaveProperty('liveReadback');
    expect(github.writes()).toEqual([]);
  });

  it('verifies complete mandatory coverage while reporting optional runner inventories as incomplete', async () => {
    const { input, github } = await observationFixture('observe-complete', true);
    const outcome = await executeGitHubDiscovery(input);
    expect(outcome).toMatchObject({ status: 'completed', resultState: 'verified' });
    expect(outcome.outputs!.values).toEqual({ repositoryId: 7, repository: 'owner/repo', workload: 'node-fastify', githubCoverageComplete: false });
    const report = (outcome.evidencePayload as { github: { observations: Record<string, { status: string; values?: unknown }> } }).github;
    expect(report.observations.runners!.status).toBe('unknown');
    expect(report.observations.rulesets!.values).toEqual([
      { id: 5, name: 'protect', source_type: 'Repository', source: 'owner/repo', target: 'branch', enforcement: 'active',
        payload: { bypass_actors: [], conditions: {}, rules: [] } },
      { id: 6, name: 'org', source_type: 'Organization', source: 'owner', target: 'branch', enforcement: 'active',
        ownership: 'external-inherited-control-not-modifiable' }
    ]);
    expect(report.observations.contexts!.values).toEqual([{ ref: 'develop', sha, checks: [
      { id: 11, name: 'CI', status: 'completed', conclusion: 'success', head_sha: sha, appId: 15368, appSlug: 'github-actions' }
    ] }]);
    expect(JSON.stringify(outcome)).not.toContain('hidden');
    expect(JSON.stringify(outcome)).not.toContain('withheld');
    expect((outcome.evidencePayload as { github: { repository: unknown } }).github.repository).toEqual({
      id: 7, name: 'owner/repo', defaultBranch: 'develop', private: true, owner: { login: 'owner', type: 'User', id: 1 },
      permissions: { admin: true, push: true, pull: true, maintain: true }, security: { secret_scanning: { status: 'enabled' } }
    });
    expect(github.writes()).toEqual([]);
  });

  it('marks workflow sources with unsupported paths, oversized content, or invalid YAML as unknown coverage', async () => {
    for (const [workflowPath, content, expected] of [
      ['scripts/ci.yml', workflow, /unsupported source path/u],
      ['.github/workflows/ci.yml', Buffer.alloc(300 * 1024).toString('base64'), /unavailable or exceeds the inspection bound/u],
      ['.github/workflows/ci.yml', Buffer.from('jobs: [unterminated').toString('base64'), /invalid YAML/u]
    ] as const) {
      const { input, github } = await observationFixture('observe-workflow', true);
      github.overrides.set('GET /repos/owner/repo/actions/workflows?per_page=100&page=1', { status: 200, headers: {}, data: {
        total_count: 1, workflows: [{ id: 1, name: 'CI', path: workflowPath, state: 'active' }] } });
      github.overrides.set(`GET /repos/owner/repo/contents/${workflowPath}?ref=develop`, { status: 200, headers: {},
        data: { encoding: 'base64', content, size: Buffer.from(content, 'base64').length } });
      const report = await observeGitHubPhase0(input);
      expect(report.observations.workflows).toEqual({ status: 'unknown', prerequisite: expect.stringMatching(expected) });
    }
  });

  it('classifies supported workloads without executing project commands and refuses unknown stacks', async () => {
    const { input } = await observationFixture('workload', false);
    const node = await classifyGitHubWorkload(input.inspection);
    expect(node).toMatchObject({ artifactKind: 'container-image', stack: 'node-fastify', commandsExecutedByDiscovery: false, missing: [] });
    const withStack = (apiStack: string) => ({ ...input.inspection, manifest: { ...input.inspection.manifest, projectArtifacts: [],
      project: { ...input.inspection.manifest.project, workload: { ...input.inspection.manifest.project.workload, apiStack } } } }) as GovernanceTransitionInspection;
    expect(await classifyGitHubWorkload(withStack('python-fastapi'))).toMatchObject({
      artifactKind: 'unknown', commands: { test: ['uv', 'run', '--project', 'backend', 'pytest'] },
      missing: ['backend/pyproject.toml', 'backend/uv.lock', 'recorded application Dockerfile']
    });
    expect(await classifyGitHubWorkload(withStack('go-huma'))).toMatchObject({ commands: { build: ['go', '-C', 'backend', 'build', './...'] } });
    await rejectedWith(classifyGitHubWorkload(withStack('rust-axum')), 'unsupported-workload');
  });

  it('plans discovery from the reviewed origin or falls back to the bound repository', async () => {
    const root = await project('plan-discovery');
    const inspection = await coverageInspection({ root, phaseId: 'phase-0-complete', state: coverageState() });
    const withOrigin = new FakeGitRunner(root);
    withOrigin.remotes = [{ name: 'origin', url: 'git@github.com:owner/repo.git', pushUrls: ['git@github.com:owner/repo.git'] }];
    const fromOrigin = await planGitHubDiscovery(planning(inspection, withOrigin, new FakeGitHub(), 'phase-0-complete'));
    expect(fromOrigin.operations[0]).toMatchObject({ inputs: { repository: 'owner/repo' }, destination: { identity: 'owner/repo' } });
    const broken: CommandRunner = { async run(command) { return { command, displayCommand: 'git', status: 128, signal: null, stdout: '', stderr: '', timedOut: false }; } };
    const fallback = await planGitHubDiscovery(planning(inspection, broken, new FakeGitHub(), 'phase-0-complete'));
    expect(fallback.operations[0]!.inputs.repository).toBe('owner/repo');
    expect(fallback.operations[0]!.inputs.coverage).toContain('network-configurations');
  });
});

describe('publication through the transition engine', () => {
  async function publish(label: string, prepare: (github: FakeGitHub, runner: FakeProviderRunner) => void = () => undefined) {
    const root = await project(label);
    const github = new FakeGitHub();
    github.ownerTypes.set('owner', 'User');
    const runner = new FakeProviderRunner(root, github);
    prepare(github, runner);
    // Normal inspection merges reviewed activation inputs into state; they are part of the phase input digest.
    const state = { ...unpublishedState(), activationInputs: inputs };
    const inspection = await coverageInspection({ root, phaseId: 'pushed', state, activationInputs: inputs });
    const plan = (await buildSavedTransitionPlan({ inspection, runner, now: coverageNow }))!;
    const approval = await issuePriorApproval(root, state, plan);
    const approved = await coverageInspection({ root, phaseId: 'pushed', state, approvals: [approval], activationInputs: inputs });
    const result = await executeApplyNext({ inspection: approved, reinspect: async () => approved, runner, now: coverageNow });
    return { root, github, runner, result };
  }

  it('publishes through the engine and reloads bound outputs, readback, and remote binding from persisted records', async () => {
    const { root, github, runner, result } = await publish('engine-publication');
    expect(result).toMatchObject({ applied: true, executedPhase: 'pushed', evidence: { result: 'verified' } });
    expect(github.writes()).toEqual(['POST /user/repos', 'PATCH /repos/owner/repo']);
    const repository = github.repositories.get('owner/repo')!;
    const outputs = {
      values: { sourceSha: localHead, repositoryId: repository.id, repository: 'owner/repo' },
      resources: [{ provider: 'github', resourceType: 'repository', resourceId: 'owner/repo' }]
    };
    const state = (await readState(root))!;
    expect(state.phases.pushed.state).toBe('verified');
    expect(state.remoteBinding).toEqual({
      id: String(repository.id), name: 'owner/repo', defaultBranch: 'develop', pushUrl: origin, verifiedAt: coverageNow.toISOString()
    });
    expect(state.phaseOutputs?.pushed).toEqual(outputs);
    const evidence = JSON.parse(await readFile(path.join(root, ...result.evidence!.pathParts), 'utf8'));
    expect(evidence.payload.outputBindings).toEqual(outputs);
    expect(evidence.liveReadback).toEqual([expect.objectContaining({
      provider: 'github', resourceType: 'repository', resourceId: 'owner/repo', matches: true,
      readbackDigest: canonicalSha256({ id: repository.id, name: 'owner/repo', head: localHead, defaultBranch: 'develop', visibility: 'private' })
    })]);

    const reloaded = await inspectCurrentActivationEvidence(root, await loadManifest(root), { runner, now: coverageNow });
    expect(reloaded.status).toBe('inspected');
    if (reloaded.status !== 'inspected') throw new Error('Persisted activation evidence was not reloaded.');
    expect(reloaded.selections.pushed!.selected?.evidenceId).toBe(result.evidence!.evidenceId);
    expect(reloaded.selections.pushed!.issues).toEqual([]);
    const inspection = await inspectGovernanceTransition(root, { runner, scope: 'activation', now: coverageNow });
    expect(inspection.state.remoteBinding).toEqual(state.remoteBinding);
    expect(inspection.evidence.map((record) => record.evidenceId)).toContain(result.evidence!.evidenceId);
  });

  it('refuses hand-edited output bindings or readback during normal reinspection', async () => {
    const { root, runner, result } = await publish('engine-tamper');
    expect(result.applied).toBe(true);
    const statePath = path.join(root, 'governance', 'activation-state.json');
    const evidencePath = path.join(root, ...result.evidence!.pathParts);
    const originalState = await readFile(statePath, 'utf8');
    const originalEvidence = await readFile(evidencePath, 'utf8');
    const outputsMismatch = /Phase output bindings for pushed have no matching authoritative resource receipt; hand-edited state is not proof\./u;

    const editedState = JSON.parse(originalState);
    editedState.phaseOutputs.pushed.resources[0].resourceId = 'owner/other';
    await writeFile(statePath, JSON.stringify(editedState));
    await expect(inspectCurrentActivationEvidence(root, await loadManifest(root), { runner, now: coverageNow })).rejects.toThrow(outputsMismatch);
    await expect(inspectGovernanceTransition(root, { runner, scope: 'activation', now: coverageNow })).rejects.toThrow(outputsMismatch);

    await writeFile(statePath, originalState);
    const editedEvidence = JSON.parse(originalEvidence);
    editedEvidence.liveReadback[0].resourceId = 'owner/other';
    await writeFile(evidencePath, JSON.stringify(editedEvidence));
    await expect(inspectCurrentActivationEvidence(root, await loadManifest(root), { runner, now: coverageNow })).rejects.toThrow(outputsMismatch);
  });

  it.each([
    ['a created repository with another identity', (github: FakeGitHub) => {
      github.overrides.set('POST /user/repos', { status: 201, headers: {}, data: {
        id: 77, full_name: 'owner/other', private: true, archived: false, fork: false, default_branch: 'develop' } });
    }, /Repository identity, visibility, or ownership differs/u],
    ['a ref readback that differs from the reviewed commit', (github: FakeGitHub) => {
      github.overrides.set('PATCH /repos/owner/repo', (request) => {
        const repository = github.repositories.get('owner/repo')!;
        Object.assign(repository, request.body as object);
        repository.refs.develop = 'e'.repeat(40);
        return { status: 200, headers: {}, data: { ...repository } };
      });
    }, /Independent repository\/ref readback differs from the reviewed local publication/u]
  ] as const)('refuses %s without recording success or a remote binding', async (_label, prepare, expected) => {
    const { root, result } = await publish('engine-refusal', prepare);
    expect(result).toMatchObject({ applied: false, reason: 'blocked', evidence: null });
    expect(result.message).toMatch(expected);
    const state = (await readState(root))!;
    expect(state.phases.pushed.state).toBe('blocked');
    expect(state.remoteBinding).toBeUndefined();
    expect(state.phaseOutputs?.pushed).toBeUndefined();
    expect(result.executedOperations.map((operation) => operation.actionId)).toContain('github.repository.ensure');
  });
});

describe('Phase 0 diagnostics withheld through the transition engine', () => {
  it.each([
    ['a failed read', { status: 1, stderr: `gh: HTTP 401 ${sentinel}` }],
    ['invalid JSON', { status: 0, stdout: `raw ${sentinel} response` }]
  ] as const)('persists a fixed blocker for %s without raw provider text', async (_label, repoView) => {
    const root = await project('engine-phase0');
    const runner = new FakeProviderRunner(root, new FakeGitHub());
    runner.remotes = [{ name: 'origin', url: origin, pushUrls: [origin] }];
    runner.repoView = repoView;
    const inspection = await coverageInspection({ root, phaseId: 'phase-0-complete', state: unpublishedState() });

    const result = await executeApplyNext({ inspection, reinspect: async () => inspection, runner, now: coverageNow });

    expect(result).toMatchObject({ applied: false, reason: 'blocked', evidence: null });
    expect(result.message).toMatch(/^Phase 0 GitHub (?:read-only discovery failed|discovery returned invalid JSON)/u);
    const persisted = await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8');
    expect(JSON.parse(persisted).phases['phase-0-complete']).toMatchObject({ state: 'blocked', blockers: [result.message] });
    for (const text of [JSON.stringify(result), persisted]) {
      expect(text).not.toContain(sentinel);
      expect(text).not.toMatch(/HTTP 401|Unexpected token/u);
    }
  });
});
