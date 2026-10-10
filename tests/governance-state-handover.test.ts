import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSavedTransitionPlan,
  canonicalPhaseGraph,
  canonicalSha256,
  executeApplyNext,
  type ActivationConfiguration,
  type ExternalOperationState,
  type PhaseEvidenceRecord,
  type UserActivationState
} from '../src/governance-activation/index.js';
import { validatePhasePayloadValues } from '../src/domain/governance/activation/source-values.js';
import {
  executeProtectedStatePhase,
  privateBackendProofPlanInputs
} from '../src/governance-activation/protected-state-handover.js';
import {
  protectedStateCustodyIdentityDigest
} from '../src/governance-activation/protected-state-custody.js';
import { bootstrapBinding } from '../src/governance-activation/azure-backend-bootstrap.js';
import { runnerBinding } from '../src/governance-activation/runner-readiness.js';
import type {
  PhaseAdapterExecutionInput,
  PhasePlanningInput,
  ProtectedBackendProofResult,
  ProtectedStateCustodyPort,
  ProtectedStateCustodyRequest,
  ProtectedStateCustodyResult,
  ProtectedStateDisposalRequest,
  ProtectedStateDisposalResult,
  ProtectedStateHandoverPort,
  ProtectedStateHandoverResult,
  ProtectedStateOperationRequest
} from '../src/governance-activation/transition-ports.js';
import {
  AbsentAzureEnvironmentRunner,
  coverageNow,
  coveragePrincipal,
  coverageState,
  coverageSubscription,
  coverageTenant,
  coverageInspection,
  isolateUserLocalStorage,
  isolatedGitEnvironment,
  issuePriorApproval,
  resetDirectory,
  scratchDirectory,
  writeCoverageProject
} from './fixtures/governance-coverage/transition-project.js';
import { fixtureHeader } from './governance-activation-fixtures.js';

const scratch = scratchDirectory('state-handover');
const repositoryId = 123;
const organizationId = 7654321;
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

function activationInputs(): ActivationConfiguration {
  return {
    schemaVersion: 1,
    repository: {
      name: 'owner/repo',
      defaultBranch: 'develop',
      visibility: 'private',
      create: false
    },
    azure: {
      subscriptionId: coverageSubscription,
      tenantId: coverageTenant,
      region: 'eastus'
    },
    budget: {
      currency: 'USD',
      fixedMonthlyCents: 5000,
      usageMonthlyCents: 2500
    },
    phases: {
      'state-path-selected': {
        statePath: 'bootstrap-local',
        resourceGroup: 'rg-liftoff-coverage-dev',
        storageAccount: 'stliftoffstate',
        container: 'tfstate',
        key: 'coverage/dev/terraform.tfstate',
        principalId: coveragePrincipal
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
        maximumRunners: 1
      }
    }
  };
}

async function project(label: string): Promise<string> {
  counter += 1;
  return writeCoverageProject(path.join(scratch, `${label}-${counter}`));
}

interface Fixture {
  root: string;
  runner: AbsentAzureEnvironmentRunner;
  phase: (typeof canonicalPhaseGraph.phases)[number];
  state: UserActivationState;
  inspection: Awaited<ReturnType<typeof coverageInspection>>;
  plan: NonNullable<Awaited<ReturnType<typeof buildSavedTransitionPlan>>>;
}

async function fixture(
  phaseId: 'private-backend-proof' | 'remote-import-verified'
): Promise<Fixture> {
  const root = await project(phaseId);
  const runner = new AbsentAzureEnvironmentRunner(gitEnvironment);
  const inputs = activationInputs();
  let state = coverageState({
    activationInputs: inputs,
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
      },
      'runner-ready': {
        ...state.phases['runner-ready'],
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
  const bootstrapPhase = canonicalPhaseGraph.phases.find((entry) =>
    entry.id === 'bootstrap-local')!;
  const provisional = await coverageInspection({
    root,
    phaseId: 'bootstrap-local',
    state,
    activationInputs: inputs
  });
  const bootstrap = bootstrapBinding({
    inspection: provisional,
    phase: bootstrapPhase,
    runner,
    now: coverageNow
  } satisfies PhasePlanningInput);
  state.phaseOutputs = {
    ...state.phaseOutputs,
    'bootstrap-local': {
      values: {
        bootstrapBindingDigest: bootstrap.bindingDigest,
        backendBindingDigest: bootstrap.backend.bindingDigest,
        environment: bootstrap.environment,
        egressMode: bootstrap.egressMode
      },
      resources: [{
        provider: 'azure',
        resourceType: 'Microsoft.Resources/deployments',
        resourceId: bootstrap.deploymentResourceId
      }, ...bootstrap.resourceIds.map((resource) => ({
        provider: 'azure' as const,
        ...resource
      }))]
    }
  };
  const runnerPhase = canonicalPhaseGraph.phases.find((entry) =>
    entry.id === 'runner-ready')!;
  const runnerInspection = await coverageInspection({
    root,
    phaseId: 'runner-ready',
    state,
    activationInputs: inputs
  });
  const runnerPlanBinding = runnerBinding({
    inspection: runnerInspection,
    phase: runnerPhase,
    runner,
    now: coverageNow
  } satisfies PhasePlanningInput);
  state.phaseOutputs = {
    ...state.phaseOutputs,
    'runner-ready': {
      values: {
        runnerBindingDigest: runnerPlanBinding.bindingDigest,
        bootstrapBindingDigest: bootstrap.bindingDigest,
        label: runnerPlanBinding.label,
        runnerId: 444,
        groupId: 333,
        networkConfigurationId: 'NC_fixture',
        networkSettingsId: runnerPlanBinding.networkSettingsResourceId
      },
      resources: [{
        provider: 'github',
        resourceType: 'hosted-runner',
        resourceId: `/orgs/owner/actions/hosted-runners/444`
      }]
    }
  };
  const privatePhase = canonicalPhaseGraph.phases.find((entry) =>
    entry.id === 'private-backend-proof')!;
  const privateInspection = await coverageInspection({
    root,
    phaseId: 'private-backend-proof',
    state,
    activationInputs: inputs
  });
  const privateInputs = privateBackendProofPlanInputs({
    inspection: privateInspection,
    phase: privatePhase,
    runner,
    now: coverageNow
  });
  if (phaseId === 'remote-import-verified') {
    const priorCustody = custodyProof({
      schemaVersion: 1,
      bindingDigest: privateInputs.stateHandoverBindingDigest as string,
      repository: 'owner/repo',
      runner: {
        id: 444,
        label: runnerPlanBinding.label,
        groupId: 333,
        networkConfigurationId: 'NC_fixture'
      },
      backendBindingDigest: bootstrap.backend.bindingDigest,
      bootstrapBindingDigest: bootstrap.bindingDigest,
      retentionDays: 30
    });
    state = {
      ...state,
      phases: {
        ...state.phases,
        'private-backend-proof': {
          ...state.phases['private-backend-proof'],
          state: 'verified'
        }
      },
      phaseOutputs: {
        ...state.phaseOutputs,
        'private-backend-proof': {
          values: {
            stateHandoverBindingDigest: privateInputs.stateHandoverBindingDigest as string,
            backendBindingDigest: bootstrap.backend.bindingDigest,
            bootstrapBindingDigest: bootstrap.bindingDigest,
            runnerId: 444,
            runnerLabel: runnerPlanBinding.label,
            targetStateExists: false,
            locking: 'azure-blob-lease',
            custodyIdentityDigest: protectedStateCustodyIdentityDigest(priorCustody)
          },
          resources: [{
            provider: 'azure',
            resourceType: 'Microsoft.Storage/storageAccounts/blobServices/containers',
            resourceId: bootstrap.backend.containerResourceId
          }]
        }
      }
    };
  }
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
  const preview = await coverageInspection({
    root,
    phaseId,
    state,
    activationInputs: inputs
  });
  const approvalPlan = (await buildSavedTransitionPlan({
    inspection: preview,
    runner,
    now: coverageNow
  }))!;
  const approval = await issuePriorApproval(root, state, approvalPlan);
  const inspection = await coverageInspection({
    root,
    phaseId,
    state,
    approvals: [approval],
    activationInputs: inputs
  });
  const plan = (await buildSavedTransitionPlan({
    inspection,
    runner,
    now: coverageNow,
    createdAt: approvalPlan.createdAt
  }))!;
  return { root, runner, phase, state, inspection, plan };
}

function operation(
  request: ProtectedStateOperationRequest,
  status: 'running' | 'completed'
): ExternalOperationState {
  const workflowRunId = request.phaseId === 'private-backend-proof' ? 9001 : 9002;
  return {
    provider: 'github',
    actionId: request.phaseId === 'private-backend-proof'
      ? 'github.runner.backend-proof'
      : 'github.runner.state-handover',
    operationId: `github-actions-run:${workflowRunId}`,
    resourceId: `/repos/${request.repository}/actions/runs/${workflowRunId}`,
    status,
    startedAt: coverageNow.toISOString(),
    observedAt: coverageNow.toISOString(),
    pollUrl: `https://api.github.com/repos/${request.repository}/actions/runs/${workflowRunId}`
  };
}

function custodyProof(request: ProtectedStateCustodyRequest) {
  const body = {
    kind: 'protected-state-custody.v1' as const,
    bindingDigest: request.bindingDigest,
    runnerId: request.runner.id,
    runnerLabel: request.runner.label,
    runnerGroupId: request.runner.groupId,
    networkConfigurationId: request.runner.networkConfigurationId,
    hostId: `github-hosted-runner:${request.runner.id}`,
    workspaceRef: 'state-workspace:fixture',
    storageRef: 'protected-storage:fixture',
    keyProviderRef: 'key-provider:fixture',
    protectedStorage: 'encrypted-private' as const,
    keyCustody: 'external-nonexporting' as const,
    locking: 'azure-blob-lease' as const,
    writerQuiesced: true as const,
    plaintextFallback: false as const,
    disposalSupported: true as const,
    observedAt: coverageNow.toISOString(),
    expiresAt: new Date(coverageNow.getTime() + 40 * 24 * 60 * 60 * 1000).toISOString()
  };
  return { ...body, qualificationDigest: canonicalSha256(body) };
}

class StatePort implements ProtectedStateHandoverPort, ProtectedStateCustodyPort {
  readonly requests: ProtectedStateOperationRequest[] = [];
  readonly custodyRequests: ProtectedStateCustodyRequest[] = [];
  mode: 'completed' | 'pending' | 'occupied' | 'mapping-drift' | 'shared-key' = 'completed';
  custodyMode:
    | 'qualified'
    | 'unsupported-host'
    | 'protected-storage-unavailable'
    | 'key-unavailable'
    | 'locking-unavailable'
    | 'writer-active' = 'qualified';
  custodyHostId: string | undefined;

  constructor(_root: string) {}

  async qualify(
    request: ProtectedStateCustodyRequest
  ): Promise<ProtectedStateCustodyResult> {
    this.custodyRequests.push(request);
    if (this.custodyMode !== 'qualified') {
      return { status: 'blocked', reason: this.custodyMode };
    }
    const proof = custodyProof(request);
    if (!this.custodyHostId) return { status: 'qualified', proof };
    const changed = {
      ...proof,
      hostId: this.custodyHostId
    };
    return {
      status: 'qualified',
      proof: {
        ...changed,
        qualificationDigest: canonicalSha256(
          Object.fromEntries(Object.entries(changed).filter(([key]) =>
            key !== 'qualificationDigest'))
        )
      }
    };
  }

  async dispose(
    request: ProtectedStateDisposalRequest
  ): Promise<ProtectedStateDisposalResult> {
    const body = {
      kind: 'protected-state-disposal.v1' as const,
      remoteImportEvidenceId: request.remoteImportEvidenceId,
      remoteImportEvidenceDigest: request.remoteImportEvidenceDigest,
      custodyQualificationDigest: request.custody.qualificationDigest,
      disposedAt: request.requestedAt,
      deletedArtifactRefs: request.backups.map((backup) => backup.encryptedStateRef),
      deletedKeyRefs: [...new Set(request.backups.map((backup) => backup.encryptionKeyRef))],
      payloadFree: true as const
    };
    return {
      status: 'completed',
      proof: { ...body, disposalDigest: canonicalSha256(body) }
    };
  }

  async proveBackend(
    request: ProtectedStateOperationRequest
  ): Promise<ProtectedBackendProofResult> {
    this.requests.push(request);
    if (this.mode === 'occupied') {
      return { status: 'blocked', reason: 'target-occupied' };
    }
    if (this.mode === 'pending') {
      return { status: 'pending', operation: operation(request, 'running') };
    }
    return {
      status: 'completed',
      operation: operation(request, 'completed'),
      proof: {
        kind: 'private-backend-proof.v1',
        bindingDigest: request.bindingDigest,
        workflowRunId: 9001,
        workflowJobId: 9101,
        headSha: 'a'.repeat(40),
        runnerId: request.runner.id,
        runnerLabel: request.runner.label,
        backendBindingDigest: request.backend.bindingDigest,
        targetStateExists: false,
        locking: 'azure-blob-lease',
        custody: request.custody,
        observationDigest: 'b'.repeat(64)
      }
    };
  }

  async handover(
    request: ProtectedStateOperationRequest
  ): Promise<ProtectedStateHandoverResult> {
    this.requests.push(request);
    if (this.mode === 'occupied') {
      return { status: 'blocked', reason: 'target-occupied' };
    }
    if (this.mode === 'pending') {
      return { status: 'pending', operation: operation(request, 'running') };
    }
    const mappings = this.mode === 'mapping-drift'
      ? request.resources.slice(1)
      : request.resources;
    const backups = [{
      artifactDigest: '1'.repeat(64),
      encryptedStateRef: `${request.custody.workspaceRef}/bootstrap.tfstate.enc`,
      encryptionKeyRef: request.custody.keyProviderRef
    }, ...(this.mode === 'shared-key' ? [{
      artifactDigest: '2'.repeat(64),
      encryptedStateRef: `${request.custody.workspaceRef}/bootstrap.tfstate.previous.enc`,
      encryptionKeyRef: request.custody.keyProviderRef
    }] : [])];
    return {
      status: 'completed',
      operation: operation(request, 'completed'),
      proof: {
        kind: 'remote-import-verified.v1',
        bindingDigest: request.bindingDigest,
        workflowRunId: 9002,
        workflowJobId: 9102,
        headSha: 'c'.repeat(40),
        runnerId: request.runner.id,
        runnerLabel: request.runner.label,
        backendBindingDigest: request.backend.bindingDigest,
        mappingDigest: canonicalSha256(mappings),
        concurrencyDigest: 'd'.repeat(64),
        remoteBackendDigest: 'e'.repeat(64),
        noChangePlanDigest: 'f'.repeat(64),
        locking: 'azure-blob-lease',
        targetStatePreviouslyExisted: false,
        plan: {
          add: 0,
          change: 0,
          destroy: 0
        },
        mappings,
        backups,
        custody: request.custody
      }
    };
  }
}

function execution(
  value: Fixture,
  port: ProtectedStateHandoverPort & ProtectedStateCustodyPort
): PhaseAdapterExecutionInput {
  return {
    inspection: value.inspection,
    phase: value.phase,
    plan: value.plan,
    runner: value.runner,
    adapters: {
      protectedStateHandover: port,
      protectedStateCustody: port
    },
    now: coverageNow
  };
}

describe('protected bootstrap-owned state handover', () => {
  it('plans exact restricted-runner proof and handover operations without public Azure import execution', async () => {
    const backend = await fixture('private-backend-proof');
    expect(backend.plan.operations.map((entry) => entry.actionId)).toEqual([
      'azure.deployment.classify-ownership',
      'github.runner.backend-proof',
      'governance.evidence.write',
      'governance.activation-state.write'
    ]);
    expect(backend.plan.operations.find((entry) =>
      entry.actionId === 'github.runner.backend-proof')?.effects?.map((entry) =>
      entry.mutationClass)).toEqual(['backend-state-read', 'azure-read']);

    const handover = await fixture('remote-import-verified');
    expect(handover.plan.operations.map((entry) => entry.actionId)).toEqual([
      'azure.deployment.classify-ownership',
      'github.runner.state-handover',
      'governance.evidence.write',
      'governance.activation-state.write'
    ]);
    expect(handover.plan.operations.some((entry) =>
      entry.actionId === 'azure.remote-import.verify')).toBe(false);
    expect(handover.plan.operations.find((entry) =>
      entry.actionId === 'github.runner.state-handover')?.inputs).toMatchObject({
      noChangePlanRequired: true,
      retentionDays: 30,
      publicExistingStateMigration: false
    });
  });

  it('verifies backend reachability only for the exact runner, absent target, and lease-lock binding', async () => {
    const value = await fixture('private-backend-proof');
    const port = new StatePort(value.root);
    const result = await executeProtectedStatePhase(execution(value, port));

    expect(result).toMatchObject({
      status: 'completed',
      resultState: 'verified',
      evidencePayload: {
        kind: 'private-backend-proof.v1',
        targetStateExists: false,
        locking: 'azure-blob-lease'
      },
      outputs: {
        values: {
          targetStateExists: false,
          runnerId: 444
        }
      }
    });
    expect(port.requests).toHaveLength(1);
    expect(port.requests[0]).toMatchObject({
      phaseId: 'private-backend-proof',
      repository: 'owner/repo',
      runner: {
        id: 444
      },
      requirements: {
        targetState: 'absent',
        protectedStorage: 'encrypted-private',
        keyCustody: 'external-nonexporting',
        plaintextFallback: false,
        preExistingStateMigration: false
      },
      custody: {
        kind: 'protected-state-custody.v1',
        writerQuiesced: true,
        disposalSupported: true
      }
    });
    expect(port.custodyRequests).toHaveLength(1);
  });

  it('accepts only complete bootstrap mappings, protected-custody backups, exact concurrency, and a zero-change plan', async () => {
    const value = await fixture('remote-import-verified');
    const port = new StatePort(value.root);
    const result = await executeProtectedStatePhase(execution(value, port));

    expect(result).toMatchObject({
      status: 'completed',
      resultState: 'verified',
      evidencePayload: {
        kind: 'remote-import-verified.v1',
        locking: 'azure-blob-lease',
        targetStatePreviouslyExisted: false,
        publicExistingStateMigration: false,
        plan: {
          add: 0,
          change: 0,
          destroy: 0
        },
        encryptedStatePathParts: [[
          'protected-custody',
          canonicalSha256('state-workspace:fixture/bootstrap.tfstate.enc')
        ]],
        encryptionKeyPathParts: [[
          'protected-custody',
          canonicalSha256('key-provider:fixture')
        ]],
        custody: {
          protectedStorage: 'encrypted-private',
          keyCustody: 'external-nonexporting',
          plaintextFallback: false,
          writerQuiesced: true
        },
        backups: [{
          encryptedStateRef: 'state-workspace:fixture/bootstrap.tfstate.enc',
          encryptionKeyRef: 'key-provider:fixture'
        }]
      },
      outputs: {
        values: {
          retentionDays: 30,
          publicExistingStateMigration: false
        }
      }
    });
    const request = port.requests[0]!;
    expect(request.resources).toHaveLength(12);
    expect(request.resources.filter((entry) => entry.disposition === 'import')).toHaveLength(9);
    expect(request.resources.filter((entry) => entry.disposition === 'embedded')).toHaveLength(1);
    expect(request.resources.filter((entry) =>
      entry.disposition === 'retain-operation-record')).toHaveLength(2);
  });

  it('retains one qualified non-exporting key inventory when bounded encrypted artifacts share it', async () => {
    const value = await fixture('remote-import-verified');
    const port = new StatePort(value.root);
    port.mode = 'shared-key';
    const result = await executeProtectedStatePhase(execution(value, port));

    expect(result).toMatchObject({
      status: 'completed',
      evidencePayload: {
        encryptedStatePathParts: [
          ['protected-custody', canonicalSha256('state-workspace:fixture/bootstrap.tfstate.enc')],
          ['protected-custody', canonicalSha256('state-workspace:fixture/bootstrap.tfstate.previous.enc')]
        ],
        encryptionKeyPathParts: [
          ['protected-custody', canonicalSha256('key-provider:fixture')]
        ]
      }
    });
  });

  it('persists one immutable workflow handle and supplies it to resume without redispatch authority expansion', async () => {
    const value = await fixture('private-backend-proof');
    const port = new StatePort(value.root);
    port.mode = 'pending';
    const pending = await executeProtectedStatePhase(execution(value, port));
    expect(pending).toMatchObject({
      status: 'pending',
      operation: {
        operationId: 'github-actions-run:9001',
        status: 'running'
      }
    });

    const resumedState: UserActivationState = {
      ...value.state,
      phases: {
        ...value.state.phases,
        'private-backend-proof': {
          ...value.state.phases['private-backend-proof'],
          state: 'running',
          operation: pending!.operation
        }
      }
    };
    const resumedInspection = await coverageInspection({
      root: value.root,
      phaseId: 'private-backend-proof',
      state: resumedState,
      approvals: value.inspection.approvals,
      activationInputs: activationInputs()
    });
    const resumed = await executeProtectedStatePhase({
      ...execution(value, port),
      inspection: resumedInspection
    });
    expect(resumed?.status).toBe('pending');
    expect(port.requests[1]?.previousOperation).toEqual(pending!.operation);
  });

  it('rejects occupied target state and incomplete mappings without emitting success-shaped proof', async () => {
    const backend = await fixture('private-backend-proof');
    const occupied = new StatePort(backend.root);
    occupied.mode = 'occupied';
    await expect(executeProtectedStatePhase(execution(backend, occupied))).resolves.toMatchObject({
      status: 'blocked',
      resultState: 'failed'
    });

    const handover = await fixture('remote-import-verified');
    const drift = new StatePort(handover.root);
    drift.mode = 'mapping-drift';
    await expect(executeProtectedStatePhase(execution(handover, drift))).resolves.toMatchObject({
      status: 'blocked',
      resultState: 'failed'
    });
  });

  it.each([
    ['unsupported-host', 'not approved'],
    ['protected-storage-unavailable', 'plaintext project-file fallback is prohibited'],
    ['key-unavailable', 'key provider is unavailable'],
    ['locking-unavailable', 'locking capability is unavailable'],
    ['writer-active', 'another writer may still be active']
  ] as const)('blocks %s custody admission without dispatching protected state work', async (mode, message) => {
    const value = await fixture('private-backend-proof');
    const port = new StatePort(value.root);
    port.custodyMode = mode;
    const result = await executeProtectedStatePhase(execution(value, port));
    expect(result).toMatchObject({ status: 'blocked', resultState: 'failed' });
    expect(result?.blocker).toContain(message);
    expect(port.requests).toHaveLength(0);
  });

  it('blocks handover when current custody changes from private backend proof', async () => {
    const value = await fixture('remote-import-verified');
    const port = new StatePort(value.root);
    port.custodyHostId = 'github-hosted-runner:999';
    const result = await executeProtectedStatePhase(execution(value, port));
    expect(result).toMatchObject({ status: 'blocked', resultState: 'failed' });
    expect(result?.blocker).toContain('changed the host, storage, key, locking, or writer custody');
    expect(port.requests).toHaveLength(0);
  });

  it('rejects brownfield claims and incomplete provider readback as current authoritative evidence', async () => {
    const value = await fixture('remote-import-verified');
    const result = await executeProtectedStatePhase(execution(value, new StatePort(value.root)));
    if (!result || result.status !== 'completed' || !result.evidencePayload ||
      !result.liveReadback) {
      throw new Error('Expected completed protected state evidence.');
    }
    const record: PhaseEvidenceRecord = {
      evidenceId: 'protected-state-current-proof',
      header: fixtureHeader('remote-import-verified'),
      payload: result.evidencePayload,
      liveReadback: result.liveReadback
    };
    expect(validatePhasePayloadValues(record)).toEqual([]);
    expect(validatePhasePayloadValues({
      ...record,
      payload: {
        ...(record.payload as Record<string, unknown>),
        publicExistingStateMigration: true
      }
    })).toContain(
      'Remote import proof requires exact complete mapping, concurrency, encrypted backups, zero-change planning, and disabled brownfield migration.'
    );
    expect(validatePhasePayloadValues({
      ...record,
      liveReadback: record.liveReadback?.filter((proof) => proof.provider !== 'github')
    })).toContain(
      'Remote import proof requires matching GitHub workflow and Azure backend readback.'
    );
  });

  it('keeps public execution blocked when no protected handover capability is registered', async () => {
    const value = await fixture('private-backend-proof');
    const result = await executeApplyNext({
      inspection: value.inspection,
      reinspect: async () => value.inspection,
      runner: value.runner,
      now: coverageNow
    });
    expect(result).toMatchObject({
      applied: false,
      authorized: false,
      reason: 'blocked'
    });
    expect(result.message).toContain('public existing-state migration and plaintext fallback remain disabled');
    expect(value.runner.azureCalls).toHaveLength(0);
  });
});
