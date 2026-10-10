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
import { bootstrapBinding } from '../src/governance-activation/azure-backend-bootstrap.js';
import {
  executeRunnerReadiness,
  runnerBinding
} from '../src/governance-activation/runner-readiness.js';
import type {
  PhaseAdapterExecutionInput,
  PhasePlanningInput
} from '../src/governance-activation/transition-ports.js';
import type {
  GitHubActivationTransport,
  GitHubRequest,
  GitHubResponse
} from '../src/adapters/github/activation-rest.js';
import type {
  CommandResult,
  CommandRunner,
  RunCommandOptions
} from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';
import {
  AbsentAzureEnvironmentRunner,
  coverageActivationInputs,
  coverageNow,
  coveragePrincipal,
  coverageState,
  coverageSubscription,
  coverageInspection,
  isolateUserLocalStorage,
  isolatedGitEnvironment,
  issuePriorApproval,
  readState,
  resetDirectory,
  scratchDirectory,
  writeCoverageProject
} from './fixtures/governance-coverage/transition-project.js';

const scratch = scratchDirectory('runner-readiness');
const organizationId = 7654321;
const repositoryId = 123;
const runnerAzurePermissions = [
  'GitHub.Network/networkSettings/read',
  'GitHub.Network/networkSettings/write',
  'Microsoft.Network/virtualNetworks/subnets/read',
  'Microsoft.Network/natGateways/read',
  'Microsoft.Network/privateDnsZones/virtualNetworkLinks/read',
  'Microsoft.Network/privateEndpoints/privateDnsZoneGroups/read'
] as const;
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

class RunnerCommandRunner implements CommandRunner {
  readonly base: AbsentAzureEnvironmentRunner;
  readonly calls: ExternalCommand[] = [];
  binding: ReturnType<typeof runnerBinding> | null = null;
  networkSettingsExists = false;
  routeMatches = true;
  dnsMatches = true;
  permissionActions: readonly string[] = [...runnerAzurePermissions];

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
    if (key.startsWith('rest --method GET ') &&
      key.includes('Microsoft.Authorization/permissions')) {
      return success(command, {
        value: [{ actions: this.permissionActions, notActions: [] }]
      });
    }
    if (key.startsWith('resource show ')) {
      const id = argument(command, '--ids');
      if (id.includes('/subnets/')) {
        const binding = this.binding;
        if (!binding) throw new Error('Runner binding was not configured.');
        return success(command, {
          id,
          name: id.split('/').at(-1),
          type: 'Microsoft.Network/virtualNetworks/subnets',
          properties: {
            natGateway: {
              id: this.routeMatches
                ? binding.natGatewayResourceId
                : `${binding.natGatewayResourceId}-other`
            },
            delegations: [{
              name: 'github-network-settings',
              properties: { serviceName: 'GitHub.Network/networkSettings' }
            }]
          }
        });
      }
      if (id.includes('/natGateways/')) {
        return success(command, {
          id,
          name: id.split('/').at(-1),
          type: 'Microsoft.Network/natGateways',
          properties: {
            provisioningState: 'Succeeded',
            publicIpAddresses: [{
              id: `${id.split('/providers/Microsoft.Network/natGateways/')[0]}` +
                '/providers/Microsoft.Network/publicIPAddresses/pip-runner'
            }]
          }
        });
      }
      if (id.includes('/virtualNetworkLinks/')) {
        const binding = this.binding;
        if (!binding) throw new Error('Runner binding was not configured.');
        return success(command, {
          id,
          name: id.split('/').at(-1),
          type: 'Microsoft.Network/privateDnsZones/virtualNetworkLinks',
          properties: {
            registrationEnabled: false,
            virtualNetwork: {
              id: this.dnsMatches
                ? binding.subnetResourceId.split('/subnets/')[0]
                : `${binding.subnetResourceId.split('/subnets/')[0]}-other`
            }
          }
        });
      }
      if (id.includes('/privateDnsZoneGroups/')) {
        return success(command, {
          id,
          name: id.split('/').at(-1),
          type: 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups',
          properties: {
            privateDnsZoneConfigs: [{
              name: 'blob',
              properties: {
                privateDnsZoneId: id.split('/providers/Microsoft.Network/privateEndpoints/')[0] +
                  '/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net'
              }
            }]
          }
        });
      }
    }
    if (key.startsWith('resource list ') &&
      key.includes('GitHub.Network/networkSettings')) {
      if (!this.networkSettingsExists) return success(command, []);
      const binding = this.binding;
      if (!binding) throw new Error('Runner binding was not configured.');
      return success(command, [this.networkSettings({
        id: binding.networkSettingsResourceId,
        subnetId: binding.subnetResourceId
      })]);
    }
    if (key.startsWith('rest --method PUT ') &&
      key.includes('GitHub.Network/networkSettings')) {
      this.networkSettingsExists = true;
      return success(command, this.networkSettings(this.bindingFromCommand(command)));
    }
    if (key.startsWith('ad signed-in-user show ')) {
      return success(command, {
        id: coveragePrincipal,
        userPrincipalName: 'developer@example.test'
      });
    }
    return this.base.run(command, options);
  }

  private bindingFromCommand(command: ExternalCommand) {
    const id = new URL(argument(command, '--url')).pathname;
    const body = JSON.parse(argument(command, '--body')) as {
      properties: { subnetId: string; businessId: string };
    };
    return { id, subnetId: body.properties.subnetId };
  }

  private networkSettings(binding: { id: string; subnetId: string }) {
    if (!this.binding) throw new Error('Runner binding was not configured.');
    return {
      id: binding.id,
      name: binding.id.split('/').at(-1),
      type: 'GitHub.Network/networkSettings',
      location: 'eastus',
      properties: {
        provisioningState: 'Succeeded',
        subnetId: binding.subnetId,
        businessId: String(organizationId)
      },
      tags: {
        GitHubId: 'NS_fixture',
        'liftoff-managed-by': 'liftoff',
        'liftoff-phase': 'runner-ready',
        'liftoff-binding': this.binding.bindingDigest
      }
    };
  }
}

class RunnerGitHubTransport implements GitHubActivationTransport {
  readonly calls: GitHubRequest[] = [];
  status = 'Ready';
  forbidden = false;
  occupied = false;
  failPostNumber: number | null = null;
  organizationIdOffset = 0;
  repositoryIdOffset = 0;
  networkConfigurationId = 'NC_fixture';
  groupId = 9;
  runnerId = 77;
  binding: ReturnType<typeof runnerBinding> | null = null;

  async request(request: GitHubRequest): Promise<GitHubResponse> {
    this.calls.push(request);
    if (this.forbidden) return this.response(403, {});
    if (request.method === 'POST' &&
      this.failPostNumber === this.calls.filter((call) => call.method === 'POST').length) {
      return this.response(500, {});
    }
    const path = request.path.split('?')[0]!;
    const binding = this.binding;
    if (!binding) throw new Error('Runner binding was not configured.');
    if (request.method === 'GET' && path === `/orgs/${binding.organization}`) {
      return this.response(200, {
        id: organizationId + this.organizationIdOffset,
        login: binding.organization
      });
    }
    if (request.method === 'GET' && path === `/repos/${binding.repository}`) {
      return this.response(200, {
        id: repositoryId + this.repositoryIdOffset,
        full_name: binding.repository,
        private: true
      });
    }
    if (request.method === 'GET' && path.startsWith(`/repos/${binding.repository}/contents/`)) {
      const workflowPath = path.slice(`/repos/${binding.repository}/contents/`.length);
      return this.response(200, { type: 'file', path: workflowPath });
    }
    if (request.method === 'GET' &&
      path === `/orgs/${binding.organization}/actions/hosted-runners/images/github-owned`) {
      return this.response(200, {
        total_count: 1,
        images: [{
          id: binding.imageId,
          source: binding.imageSource,
          platform: 'linux-x64',
          size_gb: 30,
          display_name: 'Ubuntu latest'
        }]
      });
    }
    if (request.method === 'GET' &&
      path === `/orgs/${binding.organization}/actions/hosted-runners/machine-sizes`) {
      return this.response(200, {
        total_count: 1,
        machine_specs: [{
          id: binding.machineSize,
          cpu_cores: 4,
          memory_gb: 16,
          storage_gb: 150
        }]
      });
    }
    if (request.method === 'GET' &&
      path === `/orgs/${binding.organization}/actions/hosted-runners`) {
      return this.response(200, {
        total_count: this.occupied ? 1 : 0,
        runners: this.occupied ? [{ id: 999, name: binding.label }] : []
      });
    }
    if (request.method === 'GET' &&
      request.path.startsWith(`/orgs/${binding.organization}/actions/runner-groups?visible_to_repository=`)) {
      return this.response(200, {
        total_count: 1,
        runner_groups: [{ id: this.groupId }]
      });
    }
    if (request.method === 'GET' &&
      path === `/orgs/${binding.organization}/actions/runner-groups`) {
      return this.response(200, {
        total_count: this.occupied ? 1 : 0,
        runner_groups: this.occupied ? [{ id: 999, name: binding.runnerGroupName }] : []
      });
    }
    if (request.method === 'GET' &&
      path === `/orgs/${binding.organization}/settings/network-configurations`) {
      return this.response(200, {
        total_count: this.occupied ? 1 : 0,
        network_configurations: this.occupied
          ? [{ id: 'NC_occupied', name: binding.networkConfigurationName }]
          : []
      });
    }
    if (request.method === 'POST' &&
      path === `/orgs/${binding.organization}/settings/network-configurations`) {
      return this.response(201, this.networkConfiguration(binding));
    }
    if (request.method === 'POST' &&
      path === `/orgs/${binding.organization}/actions/runner-groups`) {
      return this.response(201, this.group(binding));
    }
    if (request.method === 'POST' &&
      path === `/orgs/${binding.organization}/actions/hosted-runners`) {
      return this.response(201, this.runner(binding));
    }
    if (request.method === 'GET' &&
      path === `/orgs/${binding.organization}/settings/network-configurations/${this.networkConfigurationId}`) {
      return this.response(200, this.networkConfiguration(binding));
    }
    if (request.method === 'GET' &&
      path === `/orgs/${binding.organization}/settings/network-settings/NS_fixture`) {
      return this.response(200, {
        id: 'NS_fixture',
        network_configuration_id: this.networkConfigurationId,
        name: binding.networkSettingsName,
        subnet_id: binding.subnetResourceId,
        region: 'eastus'
      });
    }
    if (request.method === 'GET' &&
      path === `/orgs/${binding.organization}/actions/runner-groups/${this.groupId}`) {
      return this.response(200, this.group(binding));
    }
    if (request.method === 'GET' &&
      path.startsWith(`/orgs/${binding.organization}/actions/hosted-runners/`)) {
      return this.response(200, this.runner(binding));
    }
    throw new Error(`Unhandled GitHub request: ${request.method} ${request.path}`);
  }

  private response(status: number, data: unknown): GitHubResponse {
    return { status, data, headers: {} };
  }

  private networkConfiguration(binding: ReturnType<typeof runnerBinding>) {
    return {
      id: this.networkConfigurationId,
      name: binding.networkConfigurationName,
      compute_service: 'actions',
      network_settings_ids: ['NS_fixture'],
      failover_network_settings_ids: [],
      failover_network_enabled: false,
      created_on: coverageNow.toISOString()
    };
  }

  private group(binding: ReturnType<typeof runnerBinding>) {
    return {
      id: this.groupId,
      name: binding.runnerGroupName,
      visibility: 'selected',
      default: false,
      runners_url: 'https://api.github.test/runners',
      hosted_runners_url: 'https://api.github.test/hosted-runners',
      network_configuration_id: this.networkConfigurationId,
      inherited: false,
      allows_public_repositories: false,
      restricted_to_workflows: true,
      selected_workflows: binding.selectedWorkflows
    };
  }

  private runner(binding: ReturnType<typeof runnerBinding>) {
    return {
      id: this.runnerId,
      name: binding.label,
      runner_group_id: this.groupId,
      image_details: {
        id: binding.imageId,
        source: binding.imageSource,
        size_gb: 30,
        display_name: 'Ubuntu latest'
      },
      machine_size_details: {
        id: binding.machineSize,
        cpu_cores: 4,
        memory_gb: 16,
        storage_gb: 150
      },
      status: this.status,
      platform: 'linux-x64',
      maximum_runners: 1,
      public_ip_enabled: false,
      image_gen: false
    };
  }
}

function inputs(overrides: Record<string, unknown> = {}): ActivationConfiguration {
  const current = coverageActivationInputs();
  return {
    ...current,
    repository: {
      name: 'owner/repo',
      defaultBranch: 'develop',
      visibility: 'private',
      create: false
    },
    budget: {
      currency: 'USD',
      fixedMonthlyCents: 40_000,
      usageMonthlyCents: 20_000
    },
    phases: {
      ...current.phases,
      'provider-ready': {
        azureRmRegistrationMode: 'none',
        resourceTypes: [
          'Microsoft.Network/virtualNetworks',
          'GitHub.Network/networkSettings'
        ]
      },
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
        privateDnsZone: 'privatelink.blob.core.windows.net'
      },
      'runner-ready': {
        environment: 'dev',
        organizationId,
        egressMode: 'nat-gateway',
        image: 'ubuntu-latest',
        size: '4-core',
        maximumRunners: 1,
        ...overrides
      }
    }
  };
}

async function fixture(label: string, activationInputs = inputs()) {
  const root = await project(label);
  const runner = new RunnerCommandRunner();
  const phase = canonicalPhaseGraph.phases.find((candidate) =>
    candidate.id === 'runner-ready')!;
  let state = coverageState({
    activationInputs,
    applicability: {
      statePath: 'bootstrap-local',
      privateStagingDast: false,
      credentialRequired: false
    }
  });
  state = {
    ...state,
    phases: {
      ...state.phases,
      'phase-0-complete': {
        ...state.phases['phase-0-complete'],
        state: 'verified'
      },
      'provider-ready': {
        ...state.phases['provider-ready'],
        state: 'verified'
      },
      'bootstrap-local': {
        ...state.phases['bootstrap-local'],
        state: 'verified'
      }
    },
    phaseOutputs: {
      'phase-0-complete': {
        values: {
          repositoryId,
          repository: 'owner/repo'
        },
        resources: [{
          provider: 'github',
          resourceType: 'repository',
          resourceId: 'owner/repo'
        }]
      },
      'provider-ready': {
        values: {
          subscriptionId: coverageSubscription
        },
        resources: [{
          provider: 'azure',
          resourceType: 'provider-registration',
          resourceId: `/subscriptions/${coverageSubscription}/providers/GitHub.Network`
        }]
      }
    }
  };
  const provisional = await coverageInspection({
    root,
    phaseId: 'runner-ready',
    state,
    activationInputs
  });
  const bootstrap = bootstrapBinding({
    inspection: provisional,
    phase,
    runner,
    now: coverageNow
  } satisfies PhasePlanningInput);
  state.phaseOutputs = {
    ...state.phaseOutputs,
    'bootstrap-local': {
      values: {
        bootstrapBindingDigest: bootstrap.bindingDigest,
        environment: bootstrap.environment,
        egressMode: bootstrap.egressMode
      },
      resources: bootstrap.resourceIds.map((resource) => ({
        provider: 'azure' as const,
        ...resource
      }))
    }
  };
  const preview = await coverageInspection({
    root,
    phaseId: 'runner-ready',
    state,
    activationInputs
  });
  const approvalPlan = (await buildSavedTransitionPlan({
    inspection: preview,
    runner,
    now: coverageNow
  }))!;
  const approval = await issuePriorApproval(root, state, approvalPlan);
  const inspection = await coverageInspection({
    root,
    phaseId: 'runner-ready',
    state,
    approvals: [approval],
    activationInputs
  });
  const plan = (await buildSavedTransitionPlan({
    inspection,
    runner,
    now: coverageNow,
    createdAt: approvalPlan.createdAt
  }))!;
  const transport = new RunnerGitHubTransport();
  const binding = runnerBinding({
    inspection,
    phase,
    plan,
    runner,
    adapters: { githubActivation: { transport } },
    now: coverageNow
  } satisfies PhaseAdapterExecutionInput);
  transport.binding = binding;
  runner.binding = binding;
  return { root, runner, transport, phase, state, plan, approval, inspection, binding };
}

function execution(input: Awaited<ReturnType<typeof fixture>>, now = coverageNow): PhaseAdapterExecutionInput {
  return {
    inspection: input.inspection,
    phase: input.phase,
    plan: input.plan,
    runner: input.runner,
    adapters: {
      githubActivation: {
        transport: input.transport
      }
    },
    now
  };
}

describe('repository-dedicated hosted-runner planning', () => {
  it('binds exact labels, network, workflows, capacity, egress, identities, and cost', async () => {
    const value = await fixture('plan');
    expect(value.plan.operations.find((operation) =>
      operation.actionId === 'azure.runner-network.ensure')?.inputs).toMatchObject({
      organization: 'owner',
      organizationId,
      repository: 'owner/repo',
      repositoryId,
      environment: 'dev',
      egressMode: 'nat-gateway',
      networkSettingsResourceId: expect.stringContaining('/providers/GitHub.Network/networkSettings/'),
      adoptsExistingResources: false
    });
    expect(value.plan.operations.find((operation) =>
      operation.actionId === 'github.runner.ensure-ready')?.inputs).toMatchObject({
      label: expect.stringMatching(/^liftoff-[a-f0-9]{8}-dev-private-staging$/u),
      image: { id: 'ubuntu-latest', source: 'github' },
      size: '4-core',
      maximumRunners: 1,
      enableStaticIp: false,
      repositoryDedicated: true,
      allowsPublicRepositories: false,
      selectedWorkflows: [
        'owner/repo/.github/workflows/bootstrap-import-preflight.yml@refs/heads/develop',
        'owner/repo/.github/workflows/private-dast-preflight.yml@refs/heads/develop'
      ]
    });
  });

  it.each([
    ['a mismatched environment', { environment: 'staging' }],
    ['an unqualified egress mode', { egressMode: 'firewall' }],
    ['an unqualified image', { image: 'ubuntu-24.04' }],
    ['unbounded concurrency', { maximumRunners: 2 }]
  ])('refuses %s before an executable plan', async (_label, override) => {
    await expect(fixture('invalid-plan', inputs(override))).rejects.toThrow();
  });

  it('requires current verified GitHub.Network provider registration from predecessor proof', async () => {
    const value = await fixture('provider-proof');
    value.state.phaseOutputs!['provider-ready']!.resources = [];
    await expect(buildSavedTransitionPlan({
      inspection: await coverageInspection({
        root: value.root,
        phaseId: 'runner-ready',
        state: value.state,
        activationInputs: value.state.activationInputs
      }),
      runner: value.runner,
      now: coverageNow
    })).rejects.toThrow(
      'Runner readiness requires current verified GitHub.Network provider registration'
    );
  });
});

describe('repository-dedicated hosted-runner execution', () => {
  it('creates and independently reads back the Azure network settings and restricted GitHub runner', async () => {
    const value = await fixture('execute');
    const result = await executeRunnerReadiness(execution(value));
    expect(result.blocker).toBeUndefined();
    expect(result).toMatchObject({
      status: 'completed',
      resultState: 'verified',
      evidencePayload: {
        kind: 'runner-ready.v1',
        organization: 'owner',
        organizationId,
        repository: 'owner/repo',
        repositoryId,
        environment: 'dev',
        egressMode: 'nat-gateway',
        label: value.binding.label,
        runnerId: value.transport.runnerId,
        groupId: value.transport.groupId,
        networkConfigurationId: value.transport.networkConfigurationId,
        networkSettingsId: 'NS_fixture',
        repositoryAssigned: true,
        adoptsExistingResources: false
      },
      outputs: {
        values: {
          label: value.binding.label,
          runnerId: value.transport.runnerId,
          groupId: value.transport.groupId,
          networkConfigurationId: value.transport.networkConfigurationId,
          networkSettingsId: 'NS_fixture'
        }
      }
    });
    expect(value.runner.calls.some((call) =>
      call.executable === 'az' &&
      call.args.join(' ').startsWith('rest --method PUT ') &&
      call.args.join(' ').includes('GitHub.Network/networkSettings'))).toBe(true);
    expect(value.transport.calls.filter((call) => call.method === 'POST').map((call) =>
      call.path.split('?')[0])).toEqual([
      '/orgs/owner/settings/network-configurations',
      '/orgs/owner/actions/runner-groups',
      '/orgs/owner/actions/hosted-runners'
    ]);
  });

  it('runs through coordinator ownership, intent, evidence, and output persistence', async () => {
    const value = await fixture('coordinator');
    const result = await executeApplyNext({
      inspection: value.inspection,
      reinspect: async () => value.inspection,
      runner: value.runner,
      adapters: {
        githubActivation: {
          transport: value.transport
        }
      },
      now: coverageNow
    });

    expect(result.message).toBe('Executed one phase: runner-ready.');
    expect(result).toMatchObject({
      applied: true,
      authorized: true,
      executedPhase: 'runner-ready',
      evidence: { result: 'verified' }
    });
    const state = (await readState(value.root))!;
    expect(state.phaseOutputs?.['runner-ready']).toMatchObject({
      values: {
        label: value.binding.label,
        networkSettingsId: 'NS_fixture',
        networkConfigurationId: value.transport.networkConfigurationId,
        groupId: value.transport.groupId,
        runnerId: value.transport.runnerId
      }
    });
    expect(result.executedOperations.some((operation) =>
      operation.actionId === 'azure.deployment.classify-ownership')).toBe(true);
  });

  it('blocks unavailable organization capabilities before any Azure or GitHub write', async () => {
    const value = await fixture('unavailable');
    value.transport.forbidden = true;
    const result = await executeRunnerReadiness(execution(value));
    expect(result).toMatchObject({
      status: 'blocked',
      resultState: 'failed'
    });
    expect(result.blocker).toContain('account capability is unavailable');
    expect(value.runner.calls.some((call) =>
      call.executable === 'az' &&
      call.args.join(' ').startsWith('rest --method PUT '))).toBe(false);
    expect(value.transport.calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('refuses occupied deterministic GitHub names before the Azure network write', async () => {
    const value = await fixture('occupied');
    value.transport.occupied = true;
    const result = await executeRunnerReadiness(execution(value));
    expect(result).toMatchObject({ status: 'blocked', resultState: 'failed' });
    expect(result.blocker).toContain('already occupied');
    expect(value.runner.calls.some((call) =>
      call.executable === 'az' &&
      call.args.join(' ').startsWith('rest --method PUT '))).toBe(false);
  });

  it('refuses routing or DNS drift before creating the Azure network settings resource', async () => {
    const route = await fixture('route-drift');
    route.runner.routeMatches = false;
    const routeResult = await executeRunnerReadiness(execution(route));
    expect(routeResult).toMatchObject({ status: 'blocked', resultState: 'failed' });
    expect(routeResult.blocker).toContain('NAT gateway');

    const dns = await fixture('dns-drift');
    dns.runner.dnsMatches = false;
    const dnsResult = await executeRunnerReadiness(execution(dns));
    expect(dnsResult).toMatchObject({ status: 'blocked', resultState: 'failed' });
    expect(dnsResult.blocker).toContain('private DNS link');
  });

  it('refuses occupied Azure network settings without adopting the existing resource', async () => {
    const value = await fixture('azure-occupied');
    value.runner.networkSettingsExists = true;
    const result = await executeRunnerReadiness(execution(value));
    expect(result).toMatchObject({ status: 'blocked', resultState: 'failed' });
    expect(result.blocker).toContain(
      'occupied without a current owned runner operation'
    );
    expect(value.runner.calls.some((call) =>
      call.executable === 'az' && call.args.includes('PUT'))).toBe(false);
  });

  it('refuses missing exact Azure permission before the network settings write', async () => {
    const value = await fixture('azure-permission');
    value.runner.permissionActions = runnerAzurePermissions.filter((action) =>
      action !== 'GitHub.Network/networkSettings/write'
    );
    const result = await executeRunnerReadiness(execution(value));
    expect(result).toMatchObject({ status: 'blocked', resultState: 'failed' });
    expect(result.blocker).toContain('lacks 1 exact runner-network permission');
    expect(value.runner.calls.some((call) =>
      call.executable === 'az' && call.args.includes('PUT'))).toBe(false);
  });

  it('refuses organization or repository identity drift before any provider write', async () => {
    for (const field of ['organizationIdOffset', 'repositoryIdOffset'] as const) {
      const value = await fixture(`identity-${field}`);
      value.transport[field] = 1;
      const result = await executeRunnerReadiness(execution(value));
      expect(result).toMatchObject({ status: 'blocked', resultState: 'failed' });
      expect(result.blocker).toMatch(/exact reviewed|exact verified/u);
      expect(value.runner.calls.some((call) =>
        call.executable === 'az' && call.args.includes('PUT'))).toBe(false);
      expect(value.transport.calls.some((call) => call.method === 'POST')).toBe(false);
    }
  });

  it('refuses an unsupported hosted-runner status without recording readiness', async () => {
    const value = await fixture('unsupported-status');
    value.transport.status = 'Unknown';
    const result = await executeRunnerReadiness(execution(value));
    expect(result).toMatchObject({ status: 'blocked', resultState: 'failed' });
    expect(result.blocker).toContain('unsupported larger-runner status');
  });

  it('records the reviewed GitHub mutation scope after a dispatched partial failure', async () => {
    const value = await fixture('github-partial');
    value.transport.failPostNumber = 2;
    const result = await executeRunnerReadiness(execution(value));
    expect(result).toMatchObject({ status: 'blocked', resultState: 'failed' });
    expect(result.completedOperations.map((operation) => operation.actionId)).toEqual([
      'azure.runner-network.ensure',
      'github.runner.ensure-ready'
    ]);
    expect(value.transport.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });

  it('persists one GitHub handle and resumes the same runner without redispatch', async () => {
    const value = await fixture('resume');
    value.transport.status = 'Provisioning';
    const pending = await executeRunnerReadiness(execution(value));
    expect(pending.blocker).toContain('still in progress');
    expect(pending).toMatchObject({
      status: 'pending',
      operation: {
        provider: 'github',
        actionId: 'github.runner.ensure-ready',
        resourceId: `/orgs/owner/actions/hosted-runners/${value.transport.runnerId}`,
        status: 'running'
      }
    });
    const postCount = value.transport.calls.filter((call) => call.method === 'POST').length;
    const azurePutCount = value.runner.calls.filter((call) =>
      call.executable === 'az' &&
      call.args.join(' ').startsWith('rest --method PUT ')).length;
    const resumedState: UserActivationState = {
      ...value.state,
      phaseOutputs: {
        ...value.state.phaseOutputs,
        'runner-ready': pending.outputs!
      },
      phases: {
        ...value.state.phases,
        'runner-ready': {
          ...value.state.phases['runner-ready'],
          state: 'pending',
          operation: {
            ...pending.operation!,
            planDigest: value.plan.planDigest
          }
        }
      }
    };
    value.inspection = await coverageInspection({
      root: value.root,
      phaseId: 'runner-ready',
      state: resumedState,
      approvals: [value.approval],
      activationInputs: value.state.activationInputs
    });
    value.runner.networkSettingsExists = true;
    value.transport.status = 'Ready';
    const resumed = await executeRunnerReadiness(
      execution(value, new Date(coverageNow.getTime() + 60_000))
    );
    expect(resumed).toMatchObject({
      status: 'completed',
      resultState: 'verified',
      operation: {
        operationId: pending.operation!.operationId,
        resourceId: pending.operation!.resourceId,
        status: 'completed'
      }
    });
    expect(value.transport.calls.filter((call) => call.method === 'POST')).toHaveLength(postCount);
    expect(value.runner.calls.filter((call) =>
      call.executable === 'az' &&
      call.args.join(' ').startsWith('rest --method PUT '))).toHaveLength(azurePutCount);
  });

  it('rejects contradictory provider output bindings on resume', async () => {
    const value = await fixture('contradictory-resume');
    value.transport.status = 'Provisioning';
    const pending = await executeRunnerReadiness(execution(value));
    const outputs = structuredClone(pending.outputs!);
    outputs.values.runnerId = value.transport.runnerId + 1;
    const resumedState: UserActivationState = {
      ...value.state,
      phaseOutputs: {
        ...value.state.phaseOutputs,
        'runner-ready': outputs
      },
      phases: {
        ...value.state.phases,
        'runner-ready': {
          ...value.state.phases['runner-ready'],
          state: 'pending',
          operation: {
            ...pending.operation!,
            planDigest: value.plan.planDigest
          }
        }
      }
    };
    value.inspection = await coverageInspection({
      root: value.root,
      phaseId: 'runner-ready',
      state: resumedState,
      approvals: [value.approval],
      reviewedPlans: [value.plan],
      activationInputs: value.state.activationInputs
    });
    value.runner.networkSettingsExists = true;
    value.transport.status = 'Ready';

    const result = await executeRunnerReadiness(
      execution(value, new Date(coverageNow.getTime() + 60_000))
    );
    expect(result).toMatchObject({ status: 'blocked', resultState: 'failed' });
    expect(result.blocker).toContain('exact Azure and GitHub provider resource');
  });
});
