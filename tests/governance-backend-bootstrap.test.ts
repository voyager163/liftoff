import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSavedTransitionPlan,
  canonicalPhaseGraph,
  executeApplyNext,
  type ActivationConfiguration,
  type UserActivationState
} from '../src/governance-activation/index.js';
import { executeAzurePhase } from '../src/governance-activation/phase-azure.js';
import type { PhaseAdapterExecutionInput } from '../src/governance-activation/transition-ports.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';
import {
  AbsentAzureEnvironmentRunner,
  coverageActivationInputs,
  coverageNow,
  coveragePrincipal,
  coverageState,
  coverageSubscription,
  coverageTenant,
  coverageInspection,
  isolateUserLocalStorage,
  isolatedGitEnvironment,
  issuePriorApproval,
  readState,
  resetDirectory,
  scratchDirectory,
  writeCoverageProject
} from './fixtures/governance-coverage/transition-project.js';

const scratch = scratchDirectory('backend-bootstrap');
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

function success(command: ExternalCommand, value: unknown): CommandResult {
  return {
    command,
    displayCommand: [command.executable, ...command.args].join(' '),
    status: 0,
    signal: null,
    stdout: JSON.stringify(value),
    stderr: '',
    timedOut: false
  };
}

function argument(command: ExternalCommand, name: string): string {
  const index = command.args.indexOf(name);
  if (index < 0 || !command.args[index + 1]) throw new Error(`Missing ${name}`);
  return command.args[index + 1]!;
}

function resourceTypeFromId(id: string): string {
  const marker = '/providers/';
  const suffix = id.slice(id.toLowerCase().lastIndexOf(marker) + marker.length);
  const parts = suffix.split('/');
  const provider = parts.shift()!;
  const types = parts.filter((_, index) => index % 2 === 0);
  return `${provider}/${types.join('/')}`;
}

class BootstrapRunner implements CommandRunner {
  readonly base: AbsentAzureEnvironmentRunner;
  readonly calls: ExternalCommand[] = [];
  deploymentState: 'Accepted' | 'Running' | 'Succeeded' | 'Failed' = 'Succeeded';
  permissionActions: string[] = ['*'];
  deploymentNameOccupied = false;
  ownershipGroupExists = false;
  ownershipResourceIds: string[] = [];

  constructor() {
    this.base = new AbsentAzureEnvironmentRunner(gitEnvironment);
  }

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push(command);
    if (command.executable === 'tofu') {
      return success(command, {
        terraform_version: '1.12.6',
        platform: process.platform === 'win32'
          ? `windows_${process.arch === 'x64' ? 'amd64' : process.arch}`
          : `${process.platform}_${process.arch === 'x64' ? 'amd64' : process.arch}`
      });
    }
    if (command.executable !== 'az') return this.base.run(command, options);
    const key = command.args.join(' ');
    if (key.startsWith('storage account show ')) {
      return success(command, {
        id: `/subscriptions/${coverageSubscription}/resourceGroups/rg-liftoff-state/providers/Microsoft.Storage/storageAccounts/stliftoffstate`,
        name: 'stliftoffstate',
        resourceGroup: 'rg-liftoff-state',
        kind: 'StorageV2',
        location: 'eastus',
        provisioningState: 'Succeeded',
        publicNetworkAccess: 'Disabled',
        allowSharedKeyAccess: false,
        allowBlobPublicAccess: false,
        minimumTlsVersion: 'TLS1_2',
        defaultToOAuthAuthentication: true,
        httpsOnly: true,
        blobEndpoint: 'https://stliftoffstate.blob.core.windows.net/'
      });
    }
    if (key.startsWith('rest --method GET ') &&
      key.includes('Microsoft.Authorization/permissions')) {
      return success(command, {
        value: [{ actions: this.permissionActions, notActions: [] }]
      });
    }
    if (key.startsWith('rest --method POST ') && key.includes('/validate?')) {
      return success(command, { properties: { provisioningState: 'Succeeded' } });
    }
    if (key.startsWith('rest --method PUT ') && key.includes('/deployments/')) {
      return success(command, this.deployment(command));
    }
    if (key.startsWith('rest --method GET ') && key.includes('/deployments/')) {
      return success(command, this.deployment(command));
    }
    if (key.startsWith('deployment sub list ')) {
      return success(command, this.deploymentNameOccupied ? [{
        id: `/subscriptions/${coverageSubscription}/providers/Microsoft.Resources/deployments/occupied`,
        name: 'occupied',
        provisioningState: 'Succeeded'
      }] : []);
    }
    if (key.startsWith('group exists ')) return success(command, this.ownershipGroupExists);
    if (key.startsWith('group show ')) {
      const name = argument(command, '--name');
      return success(command, {
        id: `/subscriptions/${coverageSubscription}/resourceGroups/${name}`,
        name,
        location: 'eastus',
        managedBy: null,
        provisioningState: 'Succeeded',
        tags: {
          'liftoff-managed-by': 'liftoff',
          'liftoff-phase': 'bootstrap-local'
        }
      });
    }
    if (key.startsWith('resource list ')) {
      return success(command, this.ownershipResourceIds.map((id) => ({
        id,
        name: id.split('/').at(-1),
        type: resourceTypeFromId(id),
        location: 'eastus',
        kind: null,
        managedBy: null
      })));
    }
    if (key.startsWith('resource show ')) {
      const id = argument(command, '--ids');
      return success(command, {
        id,
        name: id.split('/').at(-1),
        type: resourceTypeFromId(id),
        location: id.includes('/privateDnsZones/') ? 'global' : 'eastus',
        provisioningState: 'Succeeded',
        tags: {
          'liftoff-managed-by': 'liftoff',
          'liftoff-phase': 'bootstrap-local'
        }
      });
    }
    if (key.startsWith('ad signed-in-user show ')) {
      return success(command, {
        id: coveragePrincipal,
        userPrincipalName: 'developer@example.test'
      });
    }
    return this.base.run(command, options);
  }

  private deployment(command: ExternalCommand) {
    const url = new URL(argument(command, '--url'));
    const name = url.pathname.split('/').at(-1)!;
    return {
      id: `/subscriptions/${coverageSubscription}/providers/Microsoft.Resources/deployments/${name}`,
      name,
      properties: { provisioningState: this.deploymentState }
    };
  }
}

function inputs(overrides: {
  budget?: ActivationConfiguration['budget'] | null;
  bootstrap?: Record<string, unknown>;
} = {}): ActivationConfiguration {
  const current = coverageActivationInputs();
  const budget = overrides.budget === undefined
    ? { currency: 'USD', fixedMonthlyCents: 20_000, usageMonthlyCents: 10_000 }
    : overrides.budget;
  return {
    ...current,
    phases: {
      ...current.phases,
      'state-path-selected': {
        ...current.phases['state-path-selected'],
        statePath: 'bootstrap-local'
      },
      'bootstrap-local': {
        environment: 'dev',
        egressMode: 'nat-gateway',
        virtualNetworkCidr: '10.42.0.0/24',
        runnerSubnetCidr: '10.42.0.0/27',
        privateEndpointSubnetCidr: '10.42.0.32/27',
        privateDnsZone: 'privatelink.blob.core.windows.net',
        ...overrides.bootstrap
      }
    },
    ...(budget ? { budget } : {})
  };
}

function selectedState(configuration: ActivationConfiguration): UserActivationState {
  return coverageState({
    activationInputs: configuration,
    applicability: {
      statePath: 'bootstrap-local',
      privateStagingDast: false,
      credentialRequired: false
    }
  });
}

async function approvedFixture(
  label: string,
  runner: BootstrapRunner,
  activationInputs = inputs()
) {
  const root = await project(label);
  const state = selectedState(activationInputs);
  const preview = await coverageInspection({
    root,
    phaseId: 'bootstrap-local',
    state,
    activationInputs
  });
  const plan = (await buildSavedTransitionPlan({
    inspection: preview,
    runner,
    now: coverageNow
  }))!;
  const approval = await issuePriorApproval(root, state, plan);
  const inspection = await coverageInspection({
    root,
    phaseId: 'bootstrap-local',
    state,
    approvals: [approval],
    activationInputs
  });
  return { root, state, plan, approval, inspection, activationInputs };
}

describe('reviewed backend bootstrap planning', () => {
  it('binds deterministic scoped names, exact cost, two non-overlapping subnets, and one egress mode', async () => {
    const runner = new BootstrapRunner();
    const fixture = await approvedFixture('plan', runner);
    const operation = fixture.plan.operations.find((entry) =>
      entry.actionId === 'azure.bootstrap-local.apply'
    )!;

    expect(operation.inputs).toMatchObject({
      environment: 'dev',
      egressMode: 'nat-gateway',
      virtualNetworkCidr: '10.42.0.0/24',
      runnerSubnetCidr: '10.42.0.0/27',
      privateEndpointSubnetCidr: '10.42.0.32/27',
      privateDnsZone: 'privatelink.blob.core.windows.net',
      resourceGroup: expect.stringMatching(/^rg-/u),
      deploymentName: expect.stringMatching(/^liftoff-[a-f0-9]{8}-dev-backend-bootstrap$/u),
      networkDeploymentResourceId: expect.stringMatching(
        /\/resourceGroups\/[^/]+\/providers\/Microsoft\.Resources\/deployments\/network-[a-f0-9]{8}-dev$/u
      ),
      budget: {
        currency: 'USD',
        fixedMonthlyCents: 20_000,
        usageMonthlyCents: 10_000
      },
      adoptsExistingResources: false,
      applicationProvisioning: false
    });
    expect(fixture.plan.approval.evaluation).toMatchObject({
      gateKind: 'infrastructure-cost',
      status: 'approval-required'
    });
  });

  it.each([
    ['missing nonzero cost', inputs({ budget: null })],
    ['an unknown environment', inputs({ bootstrap: { environment: 'unknown' } })],
    ['overlapping subnets', inputs({ bootstrap: { privateEndpointSubnetCidr: '10.42.0.0/27' } })],
    ['a second unqualified egress mode', inputs({ bootstrap: { egressMode: 'firewall' } })]
  ])('refuses %s before saving an executable plan', async (_label, activationInputs) => {
    const root = await project('plan-refusal');
    await expect(buildSavedTransitionPlan({
      inspection: await coverageInspection({
        root,
        phaseId: 'bootstrap-local',
        state: selectedState(activationInputs),
        activationInputs
      }),
      runner: new BootstrapRunner(),
      now: coverageNow
    })).rejects.toThrow();
  });
});

describe('backend bootstrap execution', () => {
  it('validates permission and template scope before one exact billable deployment and current readback', async () => {
    const runner = new BootstrapRunner();
    const fixture = await approvedFixture('success', runner);

    const result = await executeApplyNext({
      inspection: fixture.inspection,
      reinspect: async () => fixture.inspection,
      runner,
      now: coverageNow
    });

    expect(result).toMatchObject({
      applied: true,
      executedPhase: 'bootstrap-local',
      evidence: { result: 'verified' }
    });
    const remoteCalls = runner.calls.filter((call) =>
      call.executable === 'az' && call.args[0] === 'rest');
    const validation = remoteCalls.find((call) =>
      call.args[2] === 'POST' && call.args.some((arg) => arg.includes('/validate?')));
    const deployment = remoteCalls.find((call) =>
      call.args[2] === 'PUT' && call.args.some((arg) => arg.includes('/deployments/')));
    expect(validation).toBeDefined();
    expect(deployment).toBeDefined();
    expect(remoteCalls.indexOf(validation!)).toBeLessThan(remoteCalls.indexOf(deployment!));
    const body = JSON.parse(argument(deployment!, '--body'));
    expect(body.properties.parameters).toMatchObject({
      storageAccountResourceId: {
        value: `/subscriptions/${coverageSubscription}/resourceGroups/rg-liftoff-state/providers/Microsoft.Storage/storageAccounts/stliftoffstate`
      }
    });
    expect(JSON.stringify(body)).not.toContain('ContainerApp');
    expect(JSON.stringify(body)).not.toContain('application-foundation');
    const state = (await readState(fixture.root))!;
    expect(state.phaseOutputs?.['bootstrap-local']).toMatchObject({
      values: {
        statePath: 'bootstrap-local',
        egressMode: 'nat-gateway',
        fixedMonthlyCents: 20_000,
        usageMonthlyCents: 10_000,
        adoptsExistingResources: false,
        applicationProvisioning: false
      }
    });
    expect(state.phaseOutputs?.['bootstrap-local']?.resources.filter((resource) =>
      resource.resourceType === 'Microsoft.Resources/deployments'
    )).toHaveLength(2);
  });

  it('blocks before validation or deployment when an exact write permission is absent', async () => {
    const runner = new BootstrapRunner();
    runner.permissionActions = requiredPermissionFixture().filter((action) =>
      action !== 'Microsoft.Network/privateEndpoints/write'
    );
    const fixture = await approvedFixture('permission', runner);

    const result = await executeApplyNext({
      inspection: fixture.inspection,
      reinspect: async () => fixture.inspection,
      runner,
      now: coverageNow
    });

    expect(result).toMatchObject({ applied: false, executedPhase: null });
    expect(result.message).toContain('lacks 1 exact bootstrap permission');
    expect(runner.calls.some((call) =>
      call.executable === 'az' && call.args.includes('PUT'))).toBe(false);
  });

  it('refuses an occupied deterministic deployment name without dispatching a replacement', async () => {
    const runner = new BootstrapRunner();
    runner.deploymentNameOccupied = true;
    const fixture = await approvedFixture('occupied-deployment', runner);

    const result = await executeApplyNext({
      inspection: fixture.inspection,
      reinspect: async () => fixture.inspection,
      runner,
      now: coverageNow
    });

    expect(result).toMatchObject({ applied: false, executedPhase: null });
    expect(result.message).toContain('already occupied without a current owned operation record');
    expect(runner.calls.some((call) =>
      call.executable === 'az' && call.args.includes('PUT'))).toBe(false);
  });

  it('persists one immutable deployment handle and resumes by readback without redispatch', async () => {
    const runner = new BootstrapRunner();
    runner.deploymentState = 'Accepted';
    const fixture = await approvedFixture('pending', runner);

    const pending = await executeApplyNext({
      inspection: fixture.inspection,
      reinspect: async () => fixture.inspection,
      runner,
      now: coverageNow
    });

    expect(pending).toMatchObject({
      applied: false,
      reason: 'external-operation-pending',
      authorized: true,
      executedPhase: 'bootstrap-local'
    });
    const runningState = (await readState(fixture.root))!;
    expect(runningState.phases['bootstrap-local'].operation).toMatchObject({
      provider: 'azure',
      actionId: 'azure.bootstrap-local.apply',
      status: 'running',
      operationId: expect.stringMatching(/^azure-deployment:/u)
    });
    runner.deploymentState = 'Succeeded';
    const resumedInspection = await coverageInspection({
      root: fixture.root,
      phaseId: 'bootstrap-local',
      state: runningState,
      approvals: [fixture.approval],
      reviewedPlans: [fixture.plan],
      activationInputs: fixture.activationInputs
    });
    const putCount = runner.calls.filter((call) =>
      call.executable === 'az' && call.args.includes('PUT')).length;

    const phase = canonicalPhaseGraph.phases.find((candidate) =>
      candidate.id === 'bootstrap-local'
    )!;
    const resumed = await executeAzurePhase({
      inspection: resumedInspection,
      plan: fixture.plan,
      phase,
      runner,
      adapters: {},
      now: new Date(coverageNow.getTime() + 60_000)
    } satisfies PhaseAdapterExecutionInput);

    expect(resumed).toMatchObject({
      status: 'completed',
      resultState: 'verified',
      operation: {
        status: 'completed',
        operationId: runningState.phases['bootstrap-local'].operation!.operationId
      }
    });
    expect(runner.calls.filter((call) =>
      call.executable === 'az' && call.args.includes('PUT'))).toHaveLength(putCount);
    expect(runner.calls.some((call) =>
      call.executable === 'az' &&
      call.args[0] === 'rest' &&
      call.args[1] === '--method' &&
      call.args[2] === 'GET' &&
      call.args.join(' ').includes('/deployments/'))).toBe(true);
  });
});

function requiredPermissionFixture(): string[] {
  return [
    'Microsoft.Resources/deployments/read',
    'Microsoft.Resources/deployments/write',
    'Microsoft.Resources/deployments/validate/action',
    'Microsoft.Resources/subscriptions/resourceGroups/read',
    'Microsoft.Resources/subscriptions/resourceGroups/write',
    'Microsoft.Network/virtualNetworks/read',
    'Microsoft.Network/virtualNetworks/write',
    'Microsoft.Network/virtualNetworks/subnets/read',
    'Microsoft.Network/virtualNetworks/subnets/write',
    'Microsoft.Network/publicIPAddresses/read',
    'Microsoft.Network/publicIPAddresses/write',
    'Microsoft.Network/natGateways/read',
    'Microsoft.Network/natGateways/write',
    'Microsoft.Network/privateEndpoints/read',
    'Microsoft.Network/privateEndpoints/write',
    'Microsoft.Network/privateEndpoints/privateDnsZoneGroups/read',
    'Microsoft.Network/privateEndpoints/privateDnsZoneGroups/write',
    'Microsoft.Network/privateDnsZones/read',
    'Microsoft.Network/privateDnsZones/write',
    'Microsoft.Network/privateDnsZones/virtualNetworkLinks/read',
    'Microsoft.Network/privateDnsZones/virtualNetworkLinks/write',
    'Microsoft.Storage/storageAccounts/privateEndpointConnectionsApproval/action'
  ];
}
