import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSavedTransitionPlan,
  canonicalPhaseGraph,
  executeApplyNext,
  rollbackPlanFromCompletedOperations,
  type PhaseAdapterExecutionInput,
  type PhasePlanningInput,
  type SavedTransitionPlan
} from '../src/governance-activation/index.js';
import { executeAzurePhase, planAzurePhase } from '../src/governance-activation/phase-azure.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';
import {
  coverageActivationInputs,
  coverageInspection,
  coverageNow,
  coverageState,
  coverageSubscription,
  coverageTenant,
  issuePriorApproval,
  readState,
  resetDirectory,
  scratchDirectory,
  writeCoverageProject
} from './fixtures/governance-coverage/transition-project.js';

const scratch = scratchDirectory('provider-readiness');
const principalId = '00000000-0000-4000-8000-000000000003';
const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'provider-ready')!;
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

class ProviderRunner implements CommandRunner {
  readonly calls: string[][] = [];
  readonly providerStates = new Map<string, string>();
  readonly featureStates = new Map<string, string>();
  readonly heldRegistrations = new Set<string>();
  providerPermission = true;
  featurePermission = true;
  resourceManager = 'https://management.azure.com/';
  resourceManagerAudience = 'https://management.core.windows.net/';
  failRegistration: string | null = null;

  async run(command: ExternalCommand, _options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push([command.executable, ...command.args]);
    if (command.executable !== 'az') throw new Error(`Unexpected executable ${command.executable}.`);
    const args = command.args;
    const key = args.join(' ');
    const json = (value: unknown) => result(command, { stdout: JSON.stringify(value) });
    const argument = (name: string) => args[args.indexOf(name) + 1]!;
    if (key.startsWith('account show ')) return json({
      id: coverageSubscription,
      tenantId: coverageTenant,
      state: 'Enabled',
      environmentName: 'AzureCloud',
      user: { type: 'user', name: 'developer@example.test' }
    });
    if (key.startsWith('cloud show ')) return json({
      name: 'AzureCloud',
      resourceManager: this.resourceManager,
      resourceManagerAudience: this.resourceManagerAudience
    });
    if (key.startsWith('ad signed-in-user show ')) {
      return json({ id: principalId, userPrincipalName: 'developer@example.test' });
    }
    if (key.startsWith('rest --method GET ') && key.includes('Microsoft.Authorization/permissions')) {
      const actions = [
        ...(this.providerPermission ? ['Microsoft.Resources/subscriptions/providers/register/action'] : []),
        ...(this.featurePermission ? ['Microsoft.Features/providers/features/register/action'] : [])
      ];
      return json({ value: [{ actions, notActions: [] }] });
    }
    if (key.startsWith('rest --method GET ')) {
      return json({ subscriptionId: coverageSubscription, tenantId: coverageTenant, state: 'Enabled' });
    }
    if (key.startsWith('provider show ')) {
      const namespace = argument('--namespace');
      return json({
        id: `/subscriptions/${coverageSubscription}/providers/${namespace}`,
        namespace,
        registrationState: this.providerStates.get(namespace) ?? 'Registered'
      });
    }
    if (key.startsWith('feature show ')) {
      const namespace = argument('--namespace');
      const name = argument('--name');
      return json({
        id: `/subscriptions/${coverageSubscription}/providers/Microsoft.Features/providers/${namespace}/features/${name}`,
        name,
        state: this.featureStates.get(`${namespace}/${name}`) ?? 'Registered'
      });
    }
    if (key.startsWith('provider register ')) {
      const namespace = argument('--namespace');
      if (this.failRegistration === namespace) {
        return result(command, { status: 1, stderr: 'secret provider diagnostic' });
      }
      this.providerStates.set(namespace, this.heldRegistrations.has(namespace) ? 'Registering' : 'Registered');
      return json({ namespace, registrationState: 'Registering' });
    }
    if (key.startsWith('feature register ')) {
      const namespace = argument('--namespace');
      const name = argument('--name');
      const identity = `${namespace}/${name}`;
      if (this.failRegistration === identity) {
        return result(command, { status: 1, stderr: 'secret feature diagnostic' });
      }
      this.featureStates.set(identity, this.heldRegistrations.has(identity) ? 'Registering' : 'Registered');
      return json({ name, properties: { state: 'Registering' } });
    }
    throw new Error(`Unexpected Azure command: ${key}`);
  }
}

async function fixture(
  label: string,
  runner: ProviderRunner,
  resourceTypes: readonly string[],
  registrationMode: 'automatic' | 'none'
) {
  const root = await writeCoverageProject(path.join(scratch, `${label}-${++counter}`), 'coverage');
  const activationInputs = coverageActivationInputs();
  activationInputs.phases['provider-ready'] = {
    resourceTypes: [...resourceTypes],
    azureRmRegistrationMode: registrationMode
  };
  const inspection = await coverageInspection({
    root,
    phaseId: 'provider-ready',
    state: coverageState({ activationInputs }),
    activationInputs
  });
  const planning = { inspection, phase, runner, now: coverageNow } as PhasePlanningInput;
  const planned = await planAzurePhase(planning);
  const plan = {
    phaseId: 'provider-ready',
    operations: planned?.operations ?? []
  } as unknown as SavedTransitionPlan;
  const execution = {
    inspection, phase, runner, plan, adapters: {}, now: coverageNow
  } as PhaseAdapterExecutionInput;
  return { planned, execution };
}

function commandNames(calls: readonly string[][]): string[] {
  return calls.map((call) => `${call[1]} ${call[2]}`);
}

describe('Azure provider readiness', () => {
  it('derives and deduplicates only the namespaces used by approved resource types', async () => {
    const runner = new ProviderRunner();
    const { planned } = await fixture('minimal', runner, [
      'Microsoft.Storage/storageAccounts',
      'Microsoft.Storage/storageAccounts/blobServices/containers',
      'Microsoft.Network/virtualNetworks'
    ], 'automatic');

    expect(planned?.blockers).toBeUndefined();
    expect(planned?.operations.map((entry) => entry.inputs.namespace)).toEqual([
      'Microsoft.Network',
      'Microsoft.Storage'
    ]);
    expect(planned?.operations.every((entry) => entry.mutationClass === 'azure-read')).toBe(true);
    expect(JSON.stringify(planned)).not.toContain('Microsoft.ContainerRegistry');
    expect(JSON.stringify(planned)).not.toContain('Microsoft.ManagedIdentity');
    expect(commandNames(runner.calls)).not.toContain('provider register');
  });

  it('registers only an approved missing namespace and requires terminal independent readback', async () => {
    const runner = new ProviderRunner();
    runner.providerStates.set('Microsoft.Storage', 'NotRegistered');
    const { planned, execution } = await fixture(
      'register-provider',
      runner,
      ['Microsoft.Storage/storageAccounts'],
      'none'
    );
    const planningCallCount = runner.calls.length;
    const outcome = await executeAzurePhase(execution);

    expect(planned?.operations).toHaveLength(1);
    expect(planned?.operations[0]).toMatchObject({
      mutationClass: 'azure-provider-register',
      inputs: {
        kind: 'provider',
        namespace: 'Microsoft.Storage',
        observedState: 'NotRegistered',
        registrationMode: 'none'
      }
    });
    expect(outcome).toMatchObject({
      status: 'completed',
      resultState: 'verified',
      outputs: {
        values: {
          namespaceCount: 1,
          featureCount: 0,
          providerRegistrationPermitted: true
        }
      }
    });
    const executionCalls = runner.calls.slice(planningCallCount);
    expect(commandNames(executionCalls).filter((name) => name === 'provider register')).toHaveLength(1);
    expect(executionCalls.filter((call) => call[1] === 'provider' && call[2] === 'show')).toHaveLength(2);
    expect(outcome!.outputs!.resources.map((entry) => entry.resourceId)).toEqual(
      outcome!.liveReadback!.map((entry) => entry.resourceId)
    );
    expect(outcome!.cleanupWarnings).toEqual([
      'Retained Azure registration Microsoft.Storage; subscription capabilities are never unregistered by repository rollback.'
    ]);
    expect(JSON.stringify(runner.calls)).not.toContain('unregister');
  });

  it('advances the public provider-ready transition only after approved terminal readback', async () => {
    const runner = new ProviderRunner();
    runner.providerStates.set('Microsoft.Storage', 'NotRegistered');
    const root = await writeCoverageProject(path.join(scratch, `public-${++counter}`), 'coverage');
    const activationInputs = coverageActivationInputs();
    activationInputs.phases['provider-ready'] = {
      resourceTypes: ['Microsoft.Storage/storageAccounts'],
      azureRmRegistrationMode: 'none'
    };
    const state = coverageState({ activationInputs });
    const previewInspection = await coverageInspection({
      root, phaseId: 'provider-ready', state, activationInputs
    });
    const reviewed = (await buildSavedTransitionPlan({
      inspection: previewInspection, runner, now: coverageNow
    }))!;
    const approval = await issuePriorApproval(root, state, reviewed);
    const inspection = await coverageInspection({
      root, phaseId: 'provider-ready', state, approvals: [approval], activationInputs
    });

    const applied = await executeApplyNext({
      inspection,
      reinspect: async () => inspection,
      runner,
      now: coverageNow
    });

    expect(applied).toMatchObject({
      applied: true,
      authorized: true,
      reason: 'phase-executed',
      selectedPhase: 'provider-ready',
      executedPhase: 'provider-ready'
    });
    expect(applied.evidence).not.toBeNull();
    expect((await readState(root))?.phases['provider-ready']).toMatchObject({
      state: 'verified',
      blockers: []
    });
    expect(commandNames(runner.calls).filter((name) => name === 'provider register')).toHaveLength(1);
  });

  it('blocks explicit registration during planning when live subscription permission is absent', async () => {
    const runner = new ProviderRunner();
    runner.providerStates.set('Microsoft.Storage', 'NotRegistered');
    runner.providerPermission = false;
    const { planned } = await fixture(
      'missing-permission',
      runner,
      ['Microsoft.Storage/storageAccounts'],
      'none'
    );

    expect(planned).toEqual({
      operations: [],
      blockers: [
        'The current Azure identity lacks Microsoft.Resources/subscriptions/providers/register/action for an approved missing namespace.'
      ]
    });
    expect(commandNames(runner.calls)).not.toContain('provider register');
  });

  it('does not duplicate explicit provider registration when automatic mode has not reached readiness', async () => {
    const runner = new ProviderRunner();
    runner.providerStates.set('Microsoft.Network', 'NotRegistered');
    const { planned } = await fixture(
      'automatic-missing',
      runner,
      ['Microsoft.Network/virtualNetworks'],
      'automatic'
    );

    expect(planned?.operations).toEqual([]);
    expect(planned?.blockers?.[0]).toMatch(/automatic provider registration has not established/u);
    expect(commandNames(runner.calls)).not.toContain('provider register');
  });

  it('derives an intended subscription feature only from an approved custom IP prefix and refreshes its provider afterward', async () => {
    const runner = new ProviderRunner();
    runner.featureStates.set('Microsoft.Network/AllowBringYourOwnPublicIpAddress', 'NotRegistered');
    const { planned, execution } = await fixture('feature', runner, [
      'Microsoft.Network/publicIPAddresses',
      'Microsoft.Network/customIPPrefixes'
    ], 'none');
    const planningCallCount = runner.calls.length;
    const outcome = await executeAzurePhase(execution);
    const executionNames = commandNames(runner.calls.slice(planningCallCount));

    expect(planned?.operations.map((entry) => entry.inputs.kind)).toEqual(['feature', 'provider']);
    expect(planned?.operations[0]?.inputs).toMatchObject({
      namespace: 'Microsoft.Network',
      name: 'AllowBringYourOwnPublicIpAddress',
      requiredBy: ['Microsoft.Network/customIPPrefixes']
    });
    expect(planned?.operations[1]?.inputs).toMatchObject({
      namespace: 'Microsoft.Network',
      refreshAfterFeature: true
    });
    expect(executionNames.indexOf('feature register')).toBeLessThan(executionNames.indexOf('provider register'));
    expect(outcome?.status).toBe('completed');
  });

  it('blocks an intended feature registration when its independent live permission is absent', async () => {
    const runner = new ProviderRunner();
    runner.featureStates.set('Microsoft.Network/AllowBringYourOwnPublicIpAddress', 'NotRegistered');
    runner.featurePermission = false;
    const { planned } = await fixture(
      'feature-permission',
      runner,
      ['Microsoft.Network/customIPPrefixes'],
      'none'
    );

    expect(planned).toEqual({
      operations: [],
      blockers: [
        'The current Azure identity lacks Microsoft.Features/providers/features/register/action for an approved required feature.'
      ]
    });
    expect(commandNames(runner.calls)).not.toContain('feature register');
  });

  it('waits on an already Registering namespace without redispatching the registration', async () => {
    const runner = new ProviderRunner();
    runner.providerStates.set('GitHub.Network', 'Registering');
    const { planned, execution } = await fixture(
      'resume-registering',
      runner,
      ['GitHub.Network/networkSettings'],
      'none'
    );
    runner.providerStates.set('GitHub.Network', 'Registered');
    const planningCallCount = runner.calls.length;
    const outcome = await executeAzurePhase(execution);

    expect(planned?.operations[0]?.mutationClass).toBe('azure-read');
    expect(outcome?.status).toBe('completed');
    expect(commandNames(runner.calls.slice(planningCallCount))).not.toContain('provider register');
  });

  it('returns a bounded resumable handle and completes by reobserving without redispatch', async () => {
    const runner = new ProviderRunner();
    runner.providerStates.set('GitHub.Network', 'NotRegistered');
    runner.heldRegistrations.add('GitHub.Network');
    const { execution } = await fixture(
      'pending-registration',
      runner,
      ['GitHub.Network/networkSettings'],
      'none'
    );
    execution.plan = { ...execution.plan, planDigest: 'a'.repeat(64) };
    execution.adapters = {
      azureOperationPolling: {
        maxAttempts: 2,
        intervalMs: 0,
        async sleep() {}
      }
    };

    const pending = await executeAzurePhase(execution);

    expect(pending).toMatchObject({
      status: 'pending',
      blocker: expect.stringContaining('resume reobserves the same resource without redispatch'),
      operation: {
        provider: 'azure',
        actionId: 'azure.provider.ensure-ready',
        operationId: expect.stringContaining('azure-registration:/subscriptions/'),
        resourceId: `/subscriptions/${coverageSubscription}/providers/GitHub.Network`,
        status: 'running',
        pollUrl: expect.stringContaining('management.azure.com/subscriptions/')
      },
      outputs: {
        resources: [{
          provider: 'azure',
          resourceType: 'provider-registration',
          resourceId: `/subscriptions/${coverageSubscription}/providers/GitHub.Network`
        }]
      },
      completedOperations: []
    });
    expect(commandNames(runner.calls).filter((command) => command === 'provider register')).toHaveLength(1);

    runner.providerStates.set('GitHub.Network', 'Registered');
    execution.inspection.state.phases['provider-ready'] = {
      ...execution.inspection.state.phases['provider-ready'],
      state: 'running',
      executionPlanDigest: execution.plan.planDigest,
      operation: { ...pending!.operation!, planDigest: execution.plan.planDigest }
    };
    execution.inspection.state.phaseOutputs = { 'provider-ready': pending!.outputs! };
    execution.now = new Date(coverageNow.getTime() + 60_000);
    const resumed = await executeAzurePhase(execution);

    expect(resumed).toMatchObject({
      status: 'completed',
      resultState: 'verified',
      operation: {
        operationId: pending!.operation!.operationId,
        resourceId: pending!.operation!.resourceId,
        startedAt: pending!.operation!.startedAt,
        observedAt: execution.now.toISOString(),
        status: 'completed'
      }
    });
    expect(commandNames(runner.calls).filter((command) => command === 'provider register')).toHaveLength(1);
  });

  it('records completed shared registrations as retained when a later registration fails', async () => {
    const runner = new ProviderRunner();
    runner.providerStates.set('Microsoft.Network', 'NotRegistered');
    runner.providerStates.set('Microsoft.Storage', 'NotRegistered');
    const { execution } = await fixture('partial', runner, [
      'Microsoft.Network/virtualNetworks',
      'Microsoft.Storage/storageAccounts'
    ], 'none');
    runner.failRegistration = 'Microsoft.Storage';
    const outcome = await executeAzurePhase(execution);

    expect(outcome).toMatchObject({
      status: 'blocked',
      resultState: 'failed',
      blocker: expect.not.stringContaining('secret provider diagnostic')
    });
    expect(outcome?.completedOperations).toHaveLength(1);
    expect(outcome?.cleanupWarnings).toEqual([
      'Retained Azure registration Microsoft.Network; subscription capabilities are never unregistered by repository rollback.'
    ]);
    expect(rollbackPlanFromCompletedOperations(
      'provider-ready',
      'retain',
      null,
      outcome?.completedOperations ?? []
    )).toMatchObject({
      operations: [],
      retained: ['provider-ready:azure.provider.ensure-ready:provider-registration']
    });
    expect(JSON.stringify(outcome)).not.toContain('secret provider diagnostic');
  });

  it('uses the selected sovereign cloud endpoint and token audience for permission proof', async () => {
    const runner = new ProviderRunner();
    runner.resourceManager = 'https://management.usgovcloudapi.net/';
    runner.resourceManagerAudience = 'https://management.core.usgovcloudapi.net/';
    await fixture('sovereign', runner, ['Microsoft.Storage/storageAccounts'], 'automatic');

    const permissionCall = runner.calls.find((call) =>
      call.includes('rest') && call.some((argument) => argument.includes('Microsoft.Authorization/permissions')));
    expect(permissionCall).toEqual(expect.arrayContaining([
      `https://management.usgovcloudapi.net/subscriptions/${coverageSubscription}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`,
      'https://management.core.usgovcloudapi.net/'
    ]));
  });
});
