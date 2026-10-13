import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalPhaseGraph,
  executeApplyNext,
  type PhaseAdapterExecutionInput,
  type PhasePlanningInput,
  type SavedTransitionPlan
} from '../src/governance-activation/index.js';
import { executeAzurePhase, planAzurePhase } from '../src/governance-activation/phase-azure.js';
import { buildAzureResourceNames, stableResourceSuffix } from '../src/generators/infrastructure/names.js';
import { toSafeProjectName } from '../src/domain/project/planning.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';
import {
  coverageActivationInputs,
  coverageInspection,
  coverageNow,
  coverageState,
  coverageSubscription,
  coverageTenant,
  resetDirectory,
  scratchDirectory,
  writeCoverageProject
} from './fixtures/governance-coverage/transition-project.js';
import { FakeGitHub, FakeGitRunner } from './fixtures/governance-coverage/github-fakes.js';

const scratch = scratchDirectory('azure-discovery');
const principalId = '00000000-0000-4000-8000-000000000003';
const appId = '00000000-0000-4000-8000-000000000004';
const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'phase-0-complete')!;
let counter = 0;

beforeAll(async () => resetDirectory(scratch));
afterAll(async () => rm(scratch, { recursive: true, force: true }));

function result(command: ExternalCommand, overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command,
    displayCommand: [command.executable, ...command.args].join(' '),
    status: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides
  };
}

class AzureRunner implements CommandRunner {
  readonly calls: string[][] = [];
  accountSubscription = coverageSubscription;
  accountTenant = coverageTenant;
  accountState = 'Enabled';
  accountUser: Record<string, unknown> = { type: 'user', name: 'developer@example.test' };
  cloudName = 'AzureCloud';
  resourceManager = 'https://management.azure.com/';
  resourceManagerAudience = 'https://management.core.windows.net/';
  liveSubscription = coverageSubscription;
  liveTenant = coverageTenant;
  liveState = 'Enabled';
  signedInUserId = principalId;
  signedInUserName = 'developer@example.test';
  servicePrincipal = { id: principalId, appId, servicePrincipalType: 'Application', accountEnabled: true };
  groupExists = false;
  group: Record<string, unknown> = {};
  resources: unknown[] = [];
  malformedPrefix: string | null = null;
  timeoutPrefix: string | null = null;
  secretDiagnostic = '';

  async run(command: ExternalCommand, _options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push([command.executable, ...command.args]);
    if (command.executable !== 'az') throw new Error(`Unexpected executable ${command.executable}.`);
    const key = command.args.join(' ');
    if (this.timeoutPrefix && key.startsWith(this.timeoutPrefix)) {
      return result(command, { status: null, timedOut: true, stderr: this.secretDiagnostic });
    }
    if (this.malformedPrefix && key.startsWith(this.malformedPrefix)) {
      return result(command, { stdout: `not-json ${this.secretDiagnostic}` });
    }
    const json = (value: unknown) => result(command, { stdout: JSON.stringify(value) });
    if (key.startsWith('account show ')) return json({
      id: this.accountSubscription,
      tenantId: this.accountTenant,
      state: this.accountState,
      environmentName: this.cloudName,
      user: this.accountUser
    });
    if (key.startsWith('cloud show ')) return json({
      name: this.cloudName,
      resourceManager: this.resourceManager,
      resourceManagerAudience: this.resourceManagerAudience
    });
    if (key.startsWith('rest --method GET ')) return json({
      subscriptionId: this.liveSubscription,
      tenantId: this.liveTenant,
      state: this.liveState
    });
    if (key.startsWith('ad signed-in-user show ')) return json({
      id: this.signedInUserId,
      userPrincipalName: this.signedInUserName
    });
    if (key.startsWith('ad sp show ')) return json(this.servicePrincipal);
    if (key.startsWith('group exists ')) return json(this.groupExists);
    if (key.startsWith('group show ')) return json(this.group);
    if (key.startsWith('resource list ')) return json(this.resources);
    throw new Error(`Unexpected Azure command: ${key}`);
  }
}

async function fixture(label: string, runner = new AzureRunner(), withAzure = true) {
  counter += 1;
  const root = await writeCoverageProject(path.join(scratch, `${label}-${counter}`), 'coverage');
  const inspection = await coverageInspection({
    root,
    phaseId: 'phase-0-complete',
    state: coverageState(),
    ...(withAzure ? { activationInputs: coverageActivationInputs() } : {})
  });
  const planning = { inspection, phase, runner, now: coverageNow } as PhasePlanningInput;
  const planned = await planAzurePhase(planning);
  const plan = {
    phaseId: 'phase-0-complete',
    operations: planned?.operations ?? []
  } as unknown as SavedTransitionPlan;
  const execution = { inspection, phase, runner, plan, adapters: {}, now: coverageNow } as PhaseAdapterExecutionInput;
  return { runner, planned, execution };
}

function assertReadOnly(calls: readonly string[][]): void {
  const allowed = new Set(['show', 'exists', 'list', 'GET']);
  for (const call of calls) {
    expect(call[0]).toBe('az');
    expect(call.some((argument) => allowed.has(argument))).toBe(true);
    expect(call).not.toEqual(expect.arrayContaining(['create', 'update', 'delete', 'set']));
  }
}

describe('Azure Phase 0 identity discovery', () => {
  it('does not invent a subscription or plan Azure discovery when Azure is not configured', async () => {
    const { planned, runner } = await fixture('unconfigured', new AzureRunner(), false);
    expect(planned).toBeNull();
    expect(runner.calls).toEqual([]);
  });

  it('selects the reviewed subscription explicitly and records independently read user, cloud, region, and absent environment bindings', async () => {
    const { runner, planned, execution } = await fixture('user');
    const outcome = await executeAzurePhase(execution);
    expect(planned!.operations[0]!.inputs).toEqual({
      subscriptionId: coverageSubscription,
      tenantId: coverageTenant,
      region: 'eastus'
    });
    expect(outcome).toMatchObject({
      status: 'completed',
      resultState: 'verified',
      outputs: {
        values: {
          subscriptionId: coverageSubscription,
          tenantId: coverageTenant,
          principalType: 'user',
          principalObjectId: principalId,
          cloudName: 'AzureCloud',
          region: 'eastus',
          environmentCount: 1,
          occupiedEnvironmentCount: 0
        }
      }
    });
    expect(runner.calls[0]).toContain(coverageSubscription);
    expect(runner.calls.find((call) => call[1] === 'rest')).toEqual(expect.arrayContaining([
      `https://management.azure.com/subscriptions/${coverageSubscription}?api-version=2022-12-01`,
      'https://management.core.windows.net/'
    ]));
    expect((outcome!.evidencePayload as { azure: { environments: Array<{ status: string; resources: object }> } })
      .azure.environments[0]).toMatchObject({
        environment: 'dev',
        status: 'observed-absent',
        resourceGroup: null,
        resources: { resourceGroup: expect.stringMatching(/^rg-/u) }
      });
    expect(outcome!.outputs!.resources.map((resource) => resource.resourceId).sort()).toEqual(
      outcome!.liveReadback!.map((proof) => proof.resourceId).sort()
    );
    assertReadOnly(runner.calls);
  });

  it('persists combined GitHub and Azure Phase 0 evidence through the public transition engine', async () => {
    const root = await writeCoverageProject(path.join(scratch, `public-${++counter}`), 'coverage');
    await mkdir(path.join(root, 'backend'), { recursive: true });
    await writeFile(path.join(root, 'backend', 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run' } }));
    await writeFile(path.join(root, 'backend', 'package-lock.json'), '{}\n');
    await writeFile(path.join(root, 'backend', 'Dockerfile'), 'FROM node:24\n');
    const state = coverageState();
    state.remoteBinding = { ...state.remoteBinding!, id: '7' };
    state.phases.pushed.state = 'verified';
    const inspection = await coverageInspection({
      root,
      phaseId: 'phase-0-complete',
      state,
      activationInputs: coverageActivationInputs()
    });
    inspection.manifest = {
      ...inspection.manifest,
      projectArtifacts: [...inspection.manifest.projectArtifacts, {
        logicalName: 'backend-dockerfile',
        category: 'container',
        pathParts: ['backend', 'Dockerfile'],
        contentHash: `sha256:${'d'.repeat(64)}`
      }]
    };
    const github = new FakeGitHub();
    const sha = 'a'.repeat(40);
    github.repository('owner/repo', {
      id: 7,
      refs: { develop: sha },
      owner: { login: 'owner', type: 'User', id: 1 },
      permissions: { admin: true, push: true, pull: true, maintain: true }
    });
    const page = (route: string, data: unknown) => github.overrides.set(
      `GET ${route}${route.includes('?') ? '&' : '?'}per_page=100&page=1`,
      { status: 200, headers: {}, data }
    );
    page('/repos/owner/repo/branches', [{ name: 'develop', commit: { sha }, protected: true }]);
    page('/repos/owner/repo/actions/workflows', { total_count: 0, workflows: [] });
    page('/repos/owner/repo/rulesets?includes_parents=true', []);
    page('/repos/owner/repo/tags', []);
    page('/repos/owner/repo/releases', []);
    page('/repos/owner/repo/environments', { total_count: 0, environments: [] });
    page('/repos/owner/repo/deployments', []);
    page('/repos/owner/repo/code-scanning/alerts?state=open', []);
    page('/repos/owner/repo/secret-scanning/alerts?state=open', []);
    page('/repos/owner/repo/dependabot/alerts?state=open', []);
    page(`/repos/owner/repo/commits/${sha}/check-runs?filter=latest`, { total_count: 0, check_runs: [] });
    github.overrides.set('GET /repos/owner/repo/actions/permissions', {
      status: 200, headers: {}, data: { enabled: true, allowed_actions: 'all' }
    });
    github.overrides.set('GET /repos/owner/repo/actions/permissions/workflow', {
      status: 200, headers: {}, data: {
        default_workflow_permissions: 'read',
        can_approve_pull_request_reviews: false
      }
    });
    const git = new FakeGitRunner(root, github);
    git.remotes = [{
      name: 'origin',
      url: 'https://github.com/owner/repo.git',
      pushUrls: ['https://github.com/owner/repo.git']
    }];
    const azure = new AzureRunner();
    const runner: CommandRunner = {
      run: (command, options) => command.executable === 'az'
        ? azure.run(command, options)
        : git.run(command, options)
    };
    const result = await executeApplyNext({
      inspection,
      reinspect: async () => inspection,
      runner,
      now: coverageNow,
      adapters: { githubActivation: { transport: github } } as never
    });
    expect(result).toMatchObject({
      applied: true,
      executedPhase: 'phase-0-complete',
      evidence: { result: 'verified' }
    });
    expect(result.executedOperations.map((operation) => operation.actionId)).toEqual(expect.arrayContaining([
      'azure.phase0.discover',
      'github.phase0.discover'
    ]));
    assertReadOnly(azure.calls);
    expect(github.writes()).toEqual([]);
  });

  it('ignores an unrelated default account by requiring --subscription on every subscription-scoped read', async () => {
    const { runner, execution } = await fixture('explicit-selection');
    const outcome = await executeAzurePhase(execution);
    expect(outcome!.status).toBe('completed');
    for (const call of runner.calls.filter((entry) => ['account', 'group', 'resource'].includes(entry[1]!))) {
      expect(call).toEqual(expect.arrayContaining(['--subscription', coverageSubscription]));
    }
  });

  it.each([
    ['account subscription drift', (runner: AzureRunner) => { runner.accountSubscription = '00000000-0000-4000-8000-000000000099'; }, /exact configured enabled subscription and tenant/u],
    ['account tenant drift', (runner: AzureRunner) => { runner.accountTenant = '00000000-0000-4000-8000-000000000099'; }, /exact configured enabled subscription and tenant/u],
    ['live subscription drift', (runner: AzureRunner) => { runner.liveSubscription = '00000000-0000-4000-8000-000000000099'; }, /live subscription readback differs/u],
    ['disabled subscription', (runner: AzureRunner) => { runner.liveState = 'Disabled'; }, /live subscription readback differs/u]
  ])('blocks %s without claiming completed operations', async (_label, prepare, expected) => {
    const runner = new AzureRunner();
    prepare(runner);
    const { execution } = await fixture('binding-drift', runner);
    const outcome = await executeAzurePhase(execution);
    expect(outcome).toMatchObject({ status: 'blocked', resultState: 'failed', completedOperations: [] });
    expect(outcome!.blocker).toMatch(expected);
    expect(outcome).not.toHaveProperty('liveReadback');
  });

  it('binds a service-principal account to its provider object and application ids', async () => {
    const runner = new AzureRunner();
    runner.accountUser = { type: 'servicePrincipal', name: appId };
    const { execution } = await fixture('service-principal', runner);
    const outcome = await executeAzurePhase(execution);
    expect(outcome).toMatchObject({
      status: 'completed',
      outputs: { values: { principalType: 'service-principal', principalObjectId: principalId, principalAppId: appId } }
    });
    expect(runner.calls.find((call) => call[1] === 'ad')).toEqual(expect.arrayContaining(['--id', appId]));
  });

  it('blocks when the signed-in user differs from the selected account identity', async () => {
    const runner = new AzureRunner();
    runner.signedInUserName = 'other@example.test';
    const outcome = await executeAzurePhase((await fixture('user-drift', runner)).execution);
    expect(outcome).toMatchObject({ status: 'blocked', resultState: 'failed', completedOperations: [] });
    expect(outcome!.blocker).toMatch(/signed-in user readback differs/u);
  });

  it('blocks service-principal identity drift and disabled principals', async () => {
    const drift = new AzureRunner();
    drift.accountUser = { type: 'servicePrincipal', name: appId };
    drift.servicePrincipal.appId = '00000000-0000-4000-8000-000000000099';
    const driftOutcome = await executeAzurePhase((await fixture('principal-drift', drift)).execution);
    expect(driftOutcome!.blocker).toMatch(/service principal readback differs/u);
    const disabled = new AzureRunner();
    disabled.accountUser = { type: 'servicePrincipal', name: appId };
    disabled.servicePrincipal.accountEnabled = false;
    const disabledOutcome = await executeAzurePhase((await fixture('principal-disabled', disabled)).execution);
    expect(disabledOutcome!.blocker).toMatch(/service principal is disabled/u);
  });

  it('uses the account cloud Resource Manager endpoint for sovereign-cloud live readback', async () => {
    const runner = new AzureRunner();
    runner.cloudName = 'AzureUSGovernment';
    runner.resourceManager = 'https://management.usgovcloudapi.net/';
    runner.resourceManagerAudience = 'https://management.core.usgovcloudapi.net/';
    const { execution } = await fixture('sovereign', runner);
    const outcome = await executeAzurePhase(execution);
    expect(outcome).toMatchObject({
      status: 'completed',
      outputs: { values: {
        cloudName: 'AzureUSGovernment',
        resourceManagerEndpoint: 'https://management.usgovcloudapi.net/',
        resourceManagerAudience: 'https://management.core.usgovcloudapi.net/'
      } }
    });
    expect(runner.calls.find((call) => call[1] === 'rest')).toEqual(expect.arrayContaining([
      `https://management.usgovcloudapi.net/subscriptions/${coverageSubscription}?api-version=2022-12-01`,
      'https://management.core.usgovcloudapi.net/'
    ]));
  });

  it('records occupied deterministic names without inferring Liftoff ownership', async () => {
    const runner = new AzureRunner();
    const project = { projectName: 'coverage', safeProjectName: toSafeProjectName('coverage') };
    const names = buildAzureResourceNames(project, 'dev', stableResourceSuffix(project, 'dev'));
    runner.groupExists = true;
    runner.group = {
      id: `/subscriptions/${coverageSubscription}/resourceGroups/${names.resourceGroup}`,
      name: names.resourceGroup,
      location: 'eastus',
      managedBy: null,
      provisioningState: 'Succeeded',
      tags: { managedBy: 'liftoff' }
    };
    runner.resources = [{
      id: `/subscriptions/${coverageSubscription}/resourceGroups/${names.resourceGroup}/providers/Microsoft.Storage/storageAccounts/example`,
      name: 'example',
      type: 'Microsoft.Storage/storageAccounts',
      location: 'eastus',
      kind: 'StorageV2',
      managedBy: null
    }];
    const { execution } = await fixture('occupied', runner);
    const report = (await executeAzurePhase(execution))!.evidencePayload as {
      azure: { environments: Array<{ status: string; resourceGroup: { tagKeys: string[] }; observedResources: unknown[] }> }
    };
    expect(report.azure.environments[0]).toMatchObject({
      status: 'occupied-unverified-ownership',
      resourceGroup: { tagKeys: ['managedBy'] }
    });
    expect(JSON.stringify(report)).not.toContain('liftoff');
    expect(report.azure.environments[0]!.observedResources).toHaveLength(1);
    assertReadOnly(runner.calls);
  });

  it.each([
    ['malformed output', (runner: AzureRunner) => { runner.malformedPrefix = 'account show'; }, /invalid JSON; response bytes were withheld/u],
    ['a bounded timeout', (runner: AzureRunner) => { runner.timeoutPrefix = 'cloud show'; }, /timed out.*provider diagnostics were withheld/u]
  ])('sanitizes %s and never persists raw provider diagnostics', async (_label, prepare, expected) => {
    const secret = `client-secret-${'x'.repeat(32)}`;
    const runner = new AzureRunner();
    runner.secretDiagnostic = secret;
    prepare(runner);
    const { execution } = await fixture('sanitized', runner);
    const outcome = await executeAzurePhase(execution);
    expect(outcome).toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(outcome!.blocker).toMatch(expected);
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(outcome).not.toHaveProperty('evidencePayload');
    expect(outcome).not.toHaveProperty('liveReadback');
  });
});
