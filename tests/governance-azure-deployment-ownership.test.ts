import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSavedTransitionPlan,
  canonicalPhaseGraph,
  executeApplyNext,
  type GovernancePhaseAdapter,
  type PhaseAdapterExecutionInput,
  type PhaseId
} from '../src/governance-activation/index.js';
import {
  inspectAzureDeploymentOwnership
} from '../src/governance-activation/azure-deployment-ownership.js';
import { planAzurePhase } from '../src/governance-activation/phase-azure.js';
import { buildAzureResourceNames, stableResourceSuffix } from '../src/generators/infrastructure/names.js';
import { toSafeProjectName } from '../src/domain/project/planning.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';
import {
  LocalOnlyRunner,
  coverageActivationInputs,
  coverageInspection,
  coverageNow,
  coverageState,
  coverageSubscription,
  coverageTenant,
  isolatedGitEnvironment,
  issuePriorApproval,
  readState,
  resetDirectory,
  scratchDirectory,
  writeCoverageProject
} from './fixtures/governance-coverage/transition-project.js';

const scratch = scratchDirectory('azure-deployment-ownership');
const principalId = '00000000-0000-4000-8000-000000000003';
const protectedPhases = [
  'existing-private-path',
  'bootstrap-local',
  'private-backend-proof',
  'remote-import-verified',
  'remote-ready',
  'application-prerequisites-ready',
  'application-artifact-ready',
  'application-foundation',
  'staging-qualified',
  'production-rehearsed'
] as const satisfies readonly PhaseId[];
let gitEnvironment: NodeJS.ProcessEnv;
let counter = 0;

beforeAll(async () => {
  await resetDirectory(scratch);
  gitEnvironment = await isolatedGitEnvironment(scratch);
});

afterAll(async () => rm(scratch, { recursive: true, force: true }));

function result(command: ExternalCommand, stdout: unknown): CommandResult {
  return {
    command,
    displayCommand: [command.executable, ...command.args].join(' '),
    status: 0,
    signal: null,
    stdout: JSON.stringify(stdout),
    stderr: '',
    timedOut: false
  };
}

class OwnershipRunner implements CommandRunner {
  readonly azureCalls: string[][] = [];
  readonly local: LocalOnlyRunner;
  readonly resourceGroupId: string;
  readonly resourceId: string;

  constructor(readonly occupied: boolean) {
    this.local = new LocalOnlyRunner(gitEnvironment);
    const project = { projectName: 'coverage', safeProjectName: toSafeProjectName('coverage') };
    const names = buildAzureResourceNames(project, 'dev', stableResourceSuffix(project, 'dev'));
    this.resourceGroupId = `/subscriptions/${coverageSubscription}/resourceGroups/${names.resourceGroup}`;
    this.resourceId = `${this.resourceGroupId}/providers/Microsoft.Storage/storageAccounts/example`;
  }

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    if (command.executable !== 'az') return this.local.run(command, options);
    this.azureCalls.push([command.executable, ...command.args]);
    const key = command.args.join(' ');
    if (key.startsWith('account show ')) return result(command, {
      id: coverageSubscription,
      tenantId: coverageTenant,
      state: 'Enabled',
      environmentName: 'AzureCloud',
      user: { type: 'user', name: 'developer@example.test' }
    });
    if (key.startsWith('cloud show ')) return result(command, {
      name: 'AzureCloud',
      resourceManager: 'https://management.azure.com/',
      resourceManagerAudience: 'https://management.core.windows.net/'
    });
    if (key.startsWith('rest --method GET ')) return result(command, {
      subscriptionId: coverageSubscription,
      tenantId: coverageTenant,
      state: 'Enabled'
    });
    if (key.startsWith('ad signed-in-user show ')) return result(command, {
      id: principalId,
      userPrincipalName: 'developer@example.test'
    });
    if (key.startsWith('group exists ')) return result(command, this.occupied);
    if (key.startsWith('group show ')) return result(command, {
      id: this.resourceGroupId,
      name: this.resourceGroupId.split('/').at(-1),
      location: 'eastus',
      managedBy: null,
      provisioningState: 'Succeeded',
      tags: { managedBy: 'liftoff' }
    });
    if (key.startsWith('resource list ')) return result(command, [{
      id: this.resourceId,
      name: 'example',
      type: 'Microsoft.Storage/storageAccounts',
      location: 'eastus',
      kind: 'StorageV2',
      managedBy: null
    }]);
    throw new Error(`Unexpected Azure command: ${key}`);
  }
}

async function fixture(label: string, phaseId: PhaseId, occupied: boolean) {
  const root = await writeCoverageProject(path.join(scratch, `${label}-${++counter}`), 'coverage');
  const state = coverageState({
    applicability: { statePath: 'existing-private', privateStagingDast: false, credentialRequired: false }
  });
  const inspection = await coverageInspection({
    root,
    phaseId,
    state,
    activationInputs: coverageActivationInputs()
  });
  const runner = new OwnershipRunner(occupied);
  const phase = canonicalPhaseGraph.phases.find((candidate) => candidate.id === phaseId)!;
  const plan = await buildSavedTransitionPlan({ inspection, runner, now: coverageNow });
  expect(plan?.phaseId).toBe(phaseId);
  return {
    root,
    state,
    inspection,
    runner,
    phase,
    plan: plan!,
    execution: {
      inspection,
      plan: plan!,
      phase,
      runner,
      adapters: {},
      now: coverageNow
    } as PhaseAdapterExecutionInput
  };
}

function expectReadOnlyAzure(calls: readonly string[][]): void {
  for (const call of calls) {
    expect(call[0]).toBe('az');
    expect(call).not.toEqual(expect.arrayContaining(['create', 'update', 'delete', 'set']));
  }
}

describe('Azure deployment ownership planning', () => {
  it.each(protectedPhases)('prepends exact ownership classification for %s', async (phaseId) => {
    const root = await writeCoverageProject(path.join(scratch, `plan-${phaseId}-${++counter}`), 'coverage');
    const inspection = await coverageInspection({
      root,
      phaseId,
      state: coverageState(),
      activationInputs: coverageActivationInputs()
    });
    const runner = new OwnershipRunner(false);
    const phase = canonicalPhaseGraph.phases.find((candidate) => candidate.id === phaseId)!;
    const planned = await planAzurePhase({ inspection, phase, runner, now: coverageNow });
    expect(planned?.operations[0]).toMatchObject({
      phaseId,
      actionId: 'azure.deployment.classify-ownership',
      adapter: 'azure-opentofu',
      remote: true,
      mutationClass: 'azure-read',
      inputs: {
        scope: 'new-environment-activation',
        allowed: ['new-environment', 'same-operation-owned'],
        preExisting: 'planning-only',
        readsDeploymentState: false,
        environments: [{
          environment: 'dev',
          resourceGroup: expect.stringMatching(/^rg-coverage-[a-f0-9]{8}-dev$/u)
        }]
      }
    });
  });
});

describe('Azure deployment ownership classification', () => {
  it('blocks a protected plan that omits the reviewed classification operation without provider access', async () => {
    const current = await fixture('missing-classification', 'existing-private-path', false);
    current.execution.plan = {
      ...current.plan,
      operations: current.plan.operations.filter((operation) =>
        operation.actionId !== 'azure.deployment.classify-ownership')
    };

    const classification = await inspectAzureDeploymentOwnership(current.execution);
    expect(classification).toMatchObject({
      completedOperations: [],
      blocker: 'Deployment execution requires an exact reviewed Azure ownership-classification operation before any protected effect.'
    });
    expect(current.runner.azureCalls).toEqual([]);
  });

  it('allows an independently observed absent environment without deployment-state reads', async () => {
    const { execution, runner } = await fixture('absent', 'existing-private-path', false);
    const classification = await inspectAzureDeploymentOwnership(execution);
    expect(classification).toMatchObject({
      payload: {
        kind: 'deployment-ownership.v1',
        scope: 'new-environment-activation',
        environments: [{
          environment: 'dev',
          status: 'new-environment',
          resourceGroupId: null,
          observedResourceCount: 0,
          operationProofDigest: null
        }]
      },
      completedOperations: [{ actionId: 'azure.deployment.classify-ownership', mutationClass: 'azure-read' }]
    });
    expect(runner.azureCalls.some((call) => call.includes('resource') && call.includes('list'))).toBe(false);
    expectReadOnlyAzure(runner.azureCalls);
  });

  it('allows an occupied environment only when the current operation and outputs cover every observed resource', async () => {
    const current = await fixture('resume', 'existing-private-path', true);
    current.state.phases['existing-private-path'] = {
      ...current.state.phases['existing-private-path'],
      executionPlanDigest: current.plan.planDigest,
      operation: {
        provider: 'azure',
        actionId: 'azure.existing-private-path.verify',
        operationId: 'existing-private-path-resume-1',
        resourceId: current.runner.resourceGroupId,
        startedAt: coverageNow.toISOString(),
        observedAt: coverageNow.toISOString(),
        status: 'running',
        planDigest: current.plan.planDigest
      }
    };
    current.state.phaseOutputs = {
      'existing-private-path': {
        values: {},
        resources: [
          { provider: 'azure', resourceType: 'Microsoft.Resources/resourceGroups', resourceId: current.runner.resourceGroupId },
          { provider: 'azure', resourceType: 'Microsoft.Storage/storageAccounts', resourceId: current.runner.resourceId }
        ]
      }
    };

    const classification = await inspectAzureDeploymentOwnership(current.execution);
    expect(classification).toMatchObject({
      payload: {
        environments: [{
          status: 'same-operation-owned',
          resourceGroupId: current.runner.resourceGroupId,
          observedResourceCount: 1,
          operationProofDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
        }]
      }
    });
    expectReadOnlyAzure(current.runner.azureCalls);
  });

  it('rejects stale operation proof for an occupied environment', async () => {
    const current = await fixture('stale', 'existing-private-path', true);
    current.state.phases['existing-private-path'] = {
      ...current.state.phases['existing-private-path'],
      executionPlanDigest: current.plan.planDigest,
      operation: {
        provider: 'azure',
        actionId: 'azure.existing-private-path.verify',
        operationId: 'existing-private-path-resume-1',
        resourceId: current.runner.resourceGroupId,
        startedAt: coverageNow.toISOString(),
        observedAt: coverageNow.toISOString(),
        status: 'running',
        planDigest: 'sha256:stale'
      }
    };
    current.state.phaseOutputs = {
      'existing-private-path': {
        values: {},
        resources: [
          { provider: 'azure', resourceType: 'Microsoft.Resources/resourceGroups', resourceId: current.runner.resourceGroupId },
          { provider: 'azure', resourceType: 'Microsoft.Storage/storageAccounts', resourceId: current.runner.resourceId }
        ]
      }
    };

    const classification = await inspectAzureDeploymentOwnership(current.execution);
    expect(classification?.blocker).toContain('pre-existing or uncertain');
    expect(classification?.payload.environments[0]).toMatchObject({
      status: 'pre-existing-or-unknown',
      operationProofDigest: null
    });
    expectReadOnlyAzure(current.runner.azureCalls);
  });

  it.each([
    ['a different protected operation', {
      actionId: 'azure.remote-ready.verify',
      includeResource: true
    }],
    ['an incomplete output resource set', {
      actionId: 'azure.existing-private-path.verify',
      includeResource: false
    }]
  ] as const)('rejects %s as same-operation ownership', async (_label, proof) => {
    const current = await fixture(`wrong-${proof.actionId}`, 'existing-private-path', true);
    current.state.phases['existing-private-path'] = {
      ...current.state.phases['existing-private-path'],
      executionPlanDigest: current.plan.planDigest,
      operation: {
        provider: 'azure',
        actionId: proof.actionId,
        operationId: 'existing-private-path-resume-1',
        resourceId: current.runner.resourceGroupId,
        startedAt: coverageNow.toISOString(),
        observedAt: coverageNow.toISOString(),
        status: 'running',
        planDigest: current.plan.planDigest
      }
    };
    current.state.phaseOutputs = {
      'existing-private-path': {
        values: {},
        resources: [
          { provider: 'azure', resourceType: 'Microsoft.Resources/resourceGroups', resourceId: current.runner.resourceGroupId },
          ...(proof.includeResource
            ? [{ provider: 'azure' as const, resourceType: 'Microsoft.Storage/storageAccounts', resourceId: current.runner.resourceId }]
            : [])
        ]
      }
    };

    const classification = await inspectAzureDeploymentOwnership(current.execution);
    expect(classification?.payload.environments[0]).toMatchObject({
      status: 'pre-existing-or-unknown',
      operationProofDigest: null
    });
    expect(classification?.blocker).toContain('planning-only');
  });

  it('blocks an occupied environment before invoking the phase adapter or reading backend state', async () => {
    const current = await fixture('public-block', 'existing-private-path', true);
    const approval = await issuePriorApproval(current.root, current.state, current.plan);
    const inspection = await coverageInspection({
      root: current.root,
      phaseId: 'existing-private-path',
      state: current.state,
      approvals: [approval],
      activationInputs: coverageActivationInputs()
    });
    const invoked: string[] = [];
    const adapter: GovernancePhaseAdapter = {
      phaseId: 'existing-private-path',
      async execute() {
        invoked.push('execute');
        return { status: 'completed', resultState: 'verified', completedOperations: [] };
      }
    };

    const applied = await executeApplyNext({
      inspection,
      reinspect: async () => inspection,
      runner: current.runner,
      adapters: { phases: { 'existing-private-path': adapter } },
      now: coverageNow
    });

    expect(applied).toMatchObject({
      applied: false,
      authorized: false,
      reason: 'blocked',
      selectedPhase: 'existing-private-path',
      executedPhase: null,
      evidence: null,
      stateHash: null,
      executedOperations: [{
        actionId: 'azure.deployment.classify-ownership',
        mutationClass: 'azure-read'
      }]
    });
    expect(applied.message).toContain('pre-existing or uncertain');
    expect(invoked).toEqual([]);
    expect(await readState(current.root)).toBeUndefined();
    expect(current.runner.azureCalls.some((call) => ['tofu', 'terraform'].includes(call[0]!))).toBe(false);
    expectReadOnlyAzure(current.runner.azureCalls);
  });
});
