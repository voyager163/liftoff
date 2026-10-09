import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSavedTransitionPlan,
  executeApplyNext,
  type ActivationConfiguration,
  type UserActivationState
} from '../src/governance-activation/index.js';
import { readActivationEvidence } from '../src/governance-activation/proof-records.js';
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

const scratch = scratchDirectory('backend-readiness');
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

class BackendReadinessRunner implements CommandRunner {
  readonly base: AbsentAzureEnvironmentRunner;
  readonly calls: ExternalCommand[] = [];
  account: Record<string, unknown> = {
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
  };
  protection: Record<string, unknown> = {
    isVersioningEnabled: true,
    deleteRetentionEnabled: true,
    deleteRetentionDays: 30
  };
  container: Record<string, unknown> = {
    name: 'tfstate',
    publicAccess: null,
    leaseState: 'available',
    leaseStatus: 'unlocked'
  };
  targetExists = false;
  principalId = coveragePrincipal;
  tofu: Record<string, unknown> = {
    terraform_version: '1.12.6',
    platform: process.platform === 'win32'
      ? `windows_${process.arch === 'x64' ? 'amd64' : process.arch}`
      : `${process.platform}_${process.arch === 'x64' ? 'amd64' : process.arch}`
  };

  constructor() {
    this.base = new AbsentAzureEnvironmentRunner(gitEnvironment);
  }

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push(command);
    if (command.executable === 'tofu') return success(command, this.tofu);
    if (command.executable !== 'az') return this.base.run(command, options);
    const key = command.args.join(' ');
    if (key.startsWith('ad signed-in-user show ')) {
      return success(command, {
        id: this.principalId,
        userPrincipalName: 'developer@example.test'
      });
    }
    if (key.startsWith('storage account show ')) return success(command, this.account);
    if (key.startsWith('storage account blob-service-properties show ')) {
      return success(command, this.protection);
    }
    if (key.startsWith('storage container show ')) return success(command, this.container);
    if (key.startsWith('storage blob exists ')) {
      return success(command, { exists: this.targetExists });
    }
    return this.base.run(command, options);
  }
}

function inputs(overrides: Partial<Record<string, unknown>> = {}): ActivationConfiguration {
  const current = coverageActivationInputs();
  return {
    ...current,
    phases: {
      ...current.phases,
      'state-path-selected': {
        ...current.phases['state-path-selected'],
        ...overrides
      }
    }
  };
}

function selectedState(configuration: ActivationConfiguration): UserActivationState {
  return coverageState({
    activationInputs: configuration,
    applicability: {
      statePath: 'existing-private',
      privateStagingDast: false,
      credentialRequired: false
    }
  });
}

describe('approved existing-private backend selection', () => {
  it('binds and persists the exact principal, backend, key, and current execution host', async () => {
    const root = await project('selection');
    const runner = new BackendReadinessRunner();
    const activationInputs = inputs();
    const state = coverageState({ activationInputs });
    const preview = await coverageInspection({
      root,
      phaseId: 'state-path-selected',
      state,
      activationInputs
    });
    const plan = (await buildSavedTransitionPlan({
      inspection: preview,
      runner,
      now: coverageNow
    }))!;
    const operation = plan.operations.find((entry) => entry.actionId === 'azure.state-path.select')!;
    expect(operation.inputs).toMatchObject({
      statePath: 'existing-private',
      resourceGroup: 'rg-liftoff-state',
      storageAccount: 'stliftoffstate',
      container: 'tfstate',
      key: 'coverage/dev/terraform.tfstate',
      principalId: coveragePrincipal,
      executionHostId: expect.stringMatching(/^native-host:[a-f0-9]{64}$/u),
      bindingDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      adoptExistingState: false
    });
    const approval = await issuePriorApproval(root, state, plan);
    const inspection = await coverageInspection({
      root,
      phaseId: 'state-path-selected',
      state,
      approvals: [approval],
      activationInputs
    });

    const result = await executeApplyNext({
      inspection,
      reinspect: async () => inspection,
      runner,
      now: coverageNow
    });

    expect(result).toMatchObject({
      applied: true,
      executedPhase: 'state-path-selected',
      evidence: { result: 'verified' }
    });
    const selected = (await readState(root))!;
    expect(selected.applicability.statePath).toBe('existing-private');
    expect(selected.phaseOutputs?.['state-path-selected']?.values).not.toHaveProperty('targetStateExists');
    expect(selected.phaseOutputs?.['state-path-selected']?.resources).toEqual([
      expect.objectContaining({ resourceType: 'Microsoft.Storage/storageAccounts' })
    ]);
    const evidence = await readActivationEvidence(root);
    expect(evidence.at(-1)).toMatchObject({
      header: { phaseId: 'state-path-selected', result: 'verified' },
      payload: {
        kind: 'state-path-selected.v1',
        statePath: 'existing-private',
        adoptExistingState: false,
        principal: { objectId: coveragePrincipal }
      }
    });
  });

  it.each([
    ['a bootstrap path not implemented by task 13.1', { statePath: 'bootstrap-local' }],
    ['an unknown input field', { command: 'az storage blob download' }],
    ['an unsafe state key', { key: '../shared.tfstate' }],
    ['a non-provider principal identity', { principalId: 'current-user' }]
  ])('refuses %s before producing a reviewed plan', async (_label, override) => {
    const root = await project('selection-refusal');
    const inspection = await coverageInspection({
      root,
      phaseId: 'state-path-selected',
      state: coverageState(),
      activationInputs: inputs(override)
    });
    await expect(buildSavedTransitionPlan({
      inspection,
      runner: new BackendReadinessRunner(),
      now: coverageNow
    })).rejects.toThrow();
  });

  it.each([
    'https://stliftoffstate.blob.core.usgovcloudapi.net/',
    'https://stliftoffstate.blob.core.chinacloudapi.cn/'
  ])('accepts the exact qualified sovereign-cloud blob endpoint %s', async (blobEndpoint) => {
    const root = await project('sovereign-endpoint');
    const runner = new BackendReadinessRunner();
    runner.account.blobEndpoint = blobEndpoint;
    const activationInputs = inputs();
    const state = coverageState({ activationInputs });
    const preview = await coverageInspection({
      root,
      phaseId: 'state-path-selected',
      state,
      activationInputs
    });
    const plan = (await buildSavedTransitionPlan({ inspection: preview, runner, now: coverageNow }))!;
    const approval = await issuePriorApproval(root, state, plan);
    const inspection = await coverageInspection({
      root,
      phaseId: 'state-path-selected',
      state,
      approvals: [approval],
      activationInputs
    });

    const result = await executeApplyNext({
      inspection,
      reinspect: async () => inspection,
      runner,
      now: coverageNow
    });

    expect(result).toMatchObject({ applied: true, executedPhase: 'state-path-selected' });
  });
});

describe('existing-private backend production readiness', () => {
  it('verifies private readback and an absent target key without reading or adopting state', async () => {
    const root = await project('ready');
    const runner = new BackendReadinessRunner();
    const activationInputs = inputs();
    const state = selectedState(activationInputs);
    const inspection = await coverageInspection({
      root,
      phaseId: 'existing-private-path',
      state,
      activationInputs
    });

    const result = await executeApplyNext({
      inspection,
      reinspect: async () => inspection,
      runner,
      now: coverageNow
    });

    expect(result).toMatchObject({
      applied: true,
      executedPhase: 'existing-private-path',
      evidence: { result: 'verified' }
    });
    expect(result.executedOperations.map((operation) => operation.actionId)).toEqual(expect.arrayContaining([
      'azure.deployment.classify-ownership',
      'azure.existing-private-path.verify'
    ]));
    const stateAfter = (await readState(root))!;
    expect(stateAfter.phaseOutputs?.['existing-private-path']).toMatchObject({
      values: {
        targetStateExists: false,
        openTofuVersion: '1.12.6',
        backendBindingDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    });
    const evidence = (await readActivationEvidence(root)).at(-1)!;
    expect(evidence).toMatchObject({
      header: { phaseId: 'existing-private-path', result: 'verified' },
      payload: {
        kind: 'existing-private-path.v1',
        adoptExistingState: false,
        protection: { versioning: true, softDelete: true, softDeleteDays: 30 },
        container: {
          reachable: true,
          publicAccess: false,
          locking: 'azure-blob-lease',
          leaseState: 'available',
          leaseStatus: 'unlocked'
        },
        target: {
          exists: false,
          keyDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
        },
        deploymentOwnership: {
          environments: [{ status: 'new-environment' }]
        }
      }
    });
    const dataPlane = runner.calls.filter((call) =>
      call.executable === 'az' && call.args[0] === 'storage');
    expect(dataPlane.map((call) => call.args.slice(0, 3))).toEqual([
      ['storage', 'account', 'show'],
      ['storage', 'account', 'blob-service-properties'],
      ['storage', 'container', 'show'],
      ['storage', 'blob', 'exists']
    ]);
    expect(runner.calls.some((call) =>
      call.executable === 'az' &&
      call.args[0] === 'storage' &&
      call.args[1] === 'blob' &&
      ['download', 'show'].includes(call.args[2] ?? '')
    )).toBe(false);
  });

  it.each([
    ['a changed Azure principal', (runner: BackendReadinessRunner) => {
      runner.principalId = '00000000-0000-4000-8000-000000000099';
    }, 'differs from the exact reviewed backend principal'],
    ['public backend networking', (runner: BackendReadinessRunner) => {
      runner.account.publicNetworkAccess = 'Enabled';
    }, 'private OAuth-only HTTPS protection'],
    ['shared-key backend access', (runner: BackendReadinessRunner) => {
      runner.account.allowSharedKeyAccess = true;
    }, 'private OAuth-only HTTPS protection'],
    ['an invalid backend endpoint', (runner: BackendReadinessRunner) => {
      runner.account.blobEndpoint = 'not a URL';
    }, 'returned an invalid blob endpoint'],
    ['an inexact backend endpoint origin', (runner: BackendReadinessRunner) => {
      runner.account.blobEndpoint = 'https://stliftoffstate.blob.core.windows.net:444/private';
    }, 'private OAuth-only HTTPS protection'],
    ['missing versioning', (runner: BackendReadinessRunner) => {
      runner.protection.isVersioningEnabled = false;
    }, 'enable blob versioning'],
    ['a leased or locked container', (runner: BackendReadinessRunner) => {
      runner.container.leaseStatus = 'locked';
    }, 'unavailable for blob-lease locking'],
    ['an existing target state object', (runner: BackendReadinessRunner) => {
      runner.targetExists = true;
    }, 'refuses to read, import, or adopt it'],
    ['an unqualified OpenTofu version', (runner: BackendReadinessRunner) => {
      runner.tofu.terraform_version = '1.11.0';
    }, 'must use qualified OpenTofu 1.12.6']
  ] as const)('blocks %s without state adoption', async (_label, mutate, message) => {
    const root = await project('blocked');
    const runner = new BackendReadinessRunner();
    mutate(runner);
    const activationInputs = inputs();
    const state = selectedState(activationInputs);
    const inspection = await coverageInspection({
      root,
      phaseId: 'existing-private-path',
      state,
      activationInputs
    });

    const result = await executeApplyNext({
      inspection,
      reinspect: async () => inspection,
      runner,
      now: coverageNow
    });

    expect(result).toMatchObject({
      applied: false,
      reason: 'blocked',
      executedPhase: null
    });
    expect(result.message).toContain(message);
    expect(runner.calls.some((call) =>
      call.executable === 'az' &&
      call.args[0] === 'storage' &&
      call.args[1] === 'blob' &&
      call.args[2] !== 'exists'
    )).toBe(false);
  });

  it('binds the configured tenant and subscription independently of the current Azure CLI default', async () => {
    const activationInputs = inputs();
    activationInputs.azure = {
      subscriptionId: '00000000-0000-4000-8000-000000000009',
      tenantId: coverageTenant,
      region: 'eastus'
    };
    const root = await project('subscription');
    const inspection = await coverageInspection({
      root,
      phaseId: 'existing-private-path',
      state: selectedState(activationInputs),
      activationInputs
    });
    const result = await executeApplyNext({
      inspection,
      reinspect: async () => inspection,
      runner: new BackendReadinessRunner(),
      now: coverageNow
    });
    expect(result.applied).toBe(false);
    expect(result.message).toContain('exact configured enabled subscription and tenant');
  });
});
