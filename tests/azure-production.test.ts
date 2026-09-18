import { describe, expect, it } from 'vitest';
import type { ExternalCommand, CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type {
  PhaseAdapterExecutionInput,
  PhasePlanningInput,
  GovernanceTransitionInspection
} from '../src/governance-activation/transition-ports.js';
import type {
  UserActivationState,
  PhaseGraphNode,
  SavedTransitionPlan,
  PhaseId,
  ManagedPhaseGraph
} from '../src/domain/governance/activation/types.js';
import { phaseIds } from '../src/domain/governance/activation/types.js';
import {
  canonicalPhaseGraph,
  canonicalPhaseGraphHash,
  canonicalPhaseContractDigests,
  currentActivationIdentity
} from '../src/domain/governance/activation/graph.js';
import { isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { currentGovernanceManifest } from './governance-activation-fixtures.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { planExistingPrivatePath, executeExistingPrivatePathVerification } from '../src/application/azure-activation/producer-private-path.js';
import { fixtureStorageAccount, privateActivationFixture, privateTarget } from './helpers/private-activation-fixture.js';
import { privateStateHttpFixture } from './helpers/private-state-http-fixture.js';
import {
  validateAzureBindings,
  executeAzureAccountShow,
  executeAzureProviderShow,
  executeAzureProviderRegister,
  executeAzureStorageAccountShow,
  executeAzureBlobPropertiesShow,
  executeAzureAcrShow,
  executeAzureIdentityShow,
  executeAzureAcrManifestsShow,
  executeAzureContainerAppShow,
  sanitizeAzureOutput,
  NIL_UUID
} from '../src/adapters/azure/production-adapter.js';
import { planAzurePhase, executeAzurePhase } from '../src/governance-activation/phase-azure.js';
import { discoverPhase0 } from '../src/governance-activation/phase-discovery.js';
import { resolveAzureInputs } from '../src/application/azure-activation/producer-discovery.js';

class MockRunner implements CommandRunner {
  calls: Array<{ command: ExternalCommand; options?: RunCommandOptions }> = [];
  responses: Array<{
    match: (cmd: ExternalCommand) => boolean;
    result: CommandResult;
  }> = [];
  defaultResult: CommandResult = { status: 0, stdout: '{}', stderr: '', displayCommand: '' };

  when(match: (cmd: ExternalCommand) => boolean, result: Partial<CommandResult>): this {
    this.responses.push({
      match,
      result: { status: 0, stdout: '', stderr: '', displayCommand: '', ...result }
    });
    return this;
  }

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, options });
    for (const entry of this.responses) {
      if (entry.match(command)) {
        return entry.result;
      }
    }
    return this.defaultResult;
  }
}

const validSubId = '11111111-2222-3333-4444-555555555555';
const validTenantId = '66666666-7777-8888-9999-000000000000';
const validRegion = 'eastus';
const registryId = `/subscriptions/${validSubId}/resourceGroups/rg-app/providers/Microsoft.ContainerRegistry/registries/crliftoff`;
const clientId = '11111111-2222-4333-8444-555555555556';
const principalId = '11111111-2222-4333-8444-555555555557';

function providerResponses(runner: MockRunner, states: Record<string, string> = {}): void {
  for (const namespace of [
    'Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.ManagedIdentity',
    'Microsoft.Network', 'Microsoft.Resources', 'Microsoft.Storage'
  ]) {
    runner.when((cmd) => cmd.args?.includes('provider') && cmd.args.includes('show') && cmd.args.includes(namespace), {
      status: 0,
      stdout: JSON.stringify({
        id: `/subscriptions/${validSubId}/providers/${namespace}`, namespace,
        registrationState: states[namespace] ?? 'Registered'
      })
    });
  }
}

function applicationInspection(phaseId: 'application-prerequisites-ready' | 'application-artifact-ready', inputs: Record<string, unknown>) {
  const inspection = createMockInspection();
  inspection.activationInputs!.phases = { [phaseId]: inputs };
  return inspection;
}

function createMockState(overrides: Partial<UserActivationState> = {}): UserActivationState {
  const phases = Object.fromEntries(
    phaseIds.map((id) => [
      id,
      {
        state: 'pending' as const,
        updatedAt: '2026-09-04T00:00:00.000Z',
        evidence: [],
        approvals: [],
        blockers: []
      }
    ])
  ) as UserActivationState['phases'];

  return {
    schemaVersion: 4,
    identity: currentActivationIdentity,
    repository: {
      id: 'R_123',
      name: 'owner/repo',
      defaultBranch: 'main'
    },
    activeChange: null,
    applicability: {
      statePath: 'bootstrap-local',
      privateStagingDast: true,
      credentialRequired: true
    },
    phases,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    ...overrides
  };
}

function createMockInspection(overrides: Partial<GovernanceTransitionInspection> = {}): GovernanceTransitionInspection {
  const state = overrides.state ?? createMockState();
  const graph: ManagedPhaseGraph = canonicalPhaseGraph;
  const contexts = Object.fromEntries(
    phaseIds.map((id) => [
      id,
      {
        repositoryId: 'R_123',
        identity: currentActivationIdentity,
        phaseGraphHash: canonicalPhaseGraphHash,
        phaseId: id,
        phaseContractDigest: canonicalPhaseContractDigests[id],
        baselineSha: 'a'.repeat(64),
        inputDigest: 'b'.repeat(64),
        transition: {
          phaseId: id,
          baselineSha: 'a'.repeat(64),
          inputDigest: 'b'.repeat(64),
          transitionDigest: 'c'.repeat(64)
        }
      }
    ])
  ) as GovernanceTransitionInspection['contexts'];

  return {
    projectRoot: '/mock/project',
    manifest: parseManifest(currentGovernanceManifest('Azure adapter regression', ['dev', 'staging', 'prod'])),
    graph,
    graphHash: canonicalPhaseGraphHash,
    scope: 'activation',
    state,
    approvals: [],
    evidence: [],
    contexts,
    readiness: {
      nextReadyPhase: 'phase-0-complete',
      phases: Object.fromEntries(phaseIds.map((id) => [id, { state: 'pending', blockers: [] }])) as GovernanceTransitionInspection['readiness']['phases']
    },
    sourceOfTruth: {
      status: 'none', selected: null, candidates: [],
      createPlan: { status: 'blocked', workflowKind: 'openspec', changeId: 'governance-fixture',
        reason: 'No source or private authority is established by a metadata fixture.', requiredFacts: [] }
    },
    activationInputs: {
      schemaVersion: 1,
      azure: {
        subscriptionId: validSubId,
        tenantId: validTenantId,
        region: validRegion
      },
      phases: {}
    },
    ...overrides
  };
}

function mockGitRepository(runner: MockRunner, projectRoot: string, remoteUrl = 'https://github.com/owner/repo.git') {
  runner.when((cmd) => cmd.executable === 'git' && cmd.args?.includes('--show-toplevel'), { status: 0, stdout: `${projectRoot}\n` });
  runner.when((cmd) => cmd.executable === 'git' && cmd.args?.includes('symbolic-ref'), { status: 0, stdout: 'main\n' });
  runner.when((cmd) => cmd.executable === 'git' && cmd.args?.includes('rev-parse') && cmd.args?.includes('HEAD'), { status: 0, stdout: 'a'.repeat(40) + '\n' });
  runner.when((cmd) => cmd.executable === 'git' && cmd.args?.includes('rev-parse') && cmd.args?.includes('@{u}'), { status: 0, stdout: 'origin/main\n' });
  runner.when((cmd) => cmd.executable === 'git' && cmd.args?.includes('status'), { status: 0, stdout: '' });
  runner.when((cmd) => cmd.executable === 'git' && cmd.args?.includes('remote') && cmd.args?.includes('-v'), {
    status: 0, stdout: `origin\t${remoteUrl} (fetch)\norigin\t${remoteUrl} (push)\n`
  });
  runner.when((cmd) => cmd.executable === 'git' && cmd.args?.includes('remote') && cmd.args?.includes('get-url'), {
    status: 0, stdout: `${remoteUrl}\n`
  });
}

function createPhasePlanningInput(phaseId: PhaseId, inspection = createMockInspection(), runner = new MockRunner()): PhasePlanningInput {
  const phase = canonicalPhaseGraph.phases.find((p) => p.id === phaseId)!;
  return {
    inspection,
    phase,
    runner,
    now: new Date('2026-09-04T00:00:00.000Z')
  };
}

function createPhaseExecutionInput(
  phaseId: PhaseId,
  operations: SavedTransitionPlan['operations'] = [],
  inspection = createMockInspection(),
  runner = new MockRunner()
): PhaseAdapterExecutionInput {
  const phase = canonicalPhaseGraph.phases.find((p) => p.id === phaseId)!;
  const plan: SavedTransitionPlan = {
    schemaVersion: 2,
    scope: 'activation',
    phaseId,
    createdAt: '2026-09-04T00:00:00.000Z',
    expiresAt: '2026-09-05T00:00:00.000Z',
    identity: currentActivationIdentity,
    graphHash: canonicalPhaseGraphHash,
    stateHash: null,
    baselineDigest: 'a'.repeat(64),
    inputDigest: 'b'.repeat(64),
    transitionDigest: 'c'.repeat(64),
    planDigest: 'd'.repeat(64),
    mutationClasses: phase.allowedMutations,
    operations,
    approval: {
      gateKind: 'none',
      required: false,
      evaluation: { approvalRequired: false, reasons: [], envelopeId: null, envelopeHash: null },
      envelopeId: null,
      envelopeHash: null
    },
    rollbackPlan: {
      phaseId,
      strategy: 'none',
      target: null,
      operations: [],
      retained: [],
      cleanupWarnings: []
    },
    noSecrets: true
  };

  return {
    inspection,
    plan,
    phase,
    runner,
    adapters: {},
    now: new Date('2026-09-04T00:00:00.000Z')
  };
}

describe('Azure Production Producer Work', () => {
  describe('Input validation & Planning (Task 9.3 & 9.4)', () => {
    const bindingKeys = ['subscriptionId', 'tenantId', 'region'] as const;
    const invalidOverrides = [null, undefined, false, 0, {}, []];

    it.each(bindingKeys.flatMap((key) => invalidOverrides.map((value) => ({ key, value }))))(
      'rejects an explicit invalid Azure override $key=$value without inheriting valid globals',
      async ({ key, value }) => {
        const inspection = createMockInspection();
        inspection.activationInputs!.phases['phase-0-complete'] = { [key]: value };
        const runner = new MockRunner();
        const input = createPhasePlanningInput('phase-0-complete', inspection, runner);
        expect(resolveAzureInputs(input)[key]).toBe(value);
        const plan = await planAzurePhase(input);
        expect(plan?.operations).toEqual([]);
        expect(plan?.blockers?.join(' ')).toContain(key);
        expect(await executeAzurePhase(createPhaseExecutionInput('phase-0-complete', [], inspection, runner)))
          .toMatchObject({ status: 'blocked', completedOperations: [] });
        expect(runner.calls).toEqual([]);
      }
    );

    it.each(bindingKeys.flatMap((key) => [null, undefined, false, 0].map((value) => ({ key, value }))))(
      'keeps present invalid binding $key=$value distinct from an absent remote-ready binding',
      async ({ key, value }) => {
        const inspection = createMockInspection({
          activationInputs: { schemaVersion: 1, phases: { 'remote-ready': { [key]: value } } }
        });
        const runner = new MockRunner();
        const plan = await planAzurePhase(createPhasePlanningInput('remote-ready', inspection, runner));
        expect(plan).not.toBeNull();
        expect(plan?.operations).toEqual([]);
        expect(plan?.blockers?.join(' ')).toContain(key);
        expect(runner.calls).toEqual([]);
      }
    );

    it.each([NIL_UUID, '0', '-', '-eastus', 'eastus-', 'eastus--2'])(
      'rejects a nil or malformed region %s before operation planning', async (region) => {
        const inspection = createMockInspection();
        inspection.activationInputs!.phases['phase-0-complete'] = { region };
        const runner = new MockRunner();
        const plan = await planAzurePhase(createPhasePlanningInput('phase-0-complete', inspection, runner));
        expect(plan?.operations).toEqual([]);
        expect(plan?.blockers?.join(' ')).toContain('region');
        expect(runner.calls).toEqual([]);
      }
    );

    it('retains valid phase overrides and inherits only absent fields from the selected configuration', async () => {
      const inspection = createMockInspection();
      const subscriptionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      inspection.activationInputs!.phases['phase-0-complete'] = { subscriptionId };
      const input = createPhasePlanningInput('phase-0-complete', inspection);
      expect(resolveAzureInputs(input)).toEqual({ subscriptionId, tenantId: validTenantId, region: validRegion });
      const plan = await planAzurePhase(input);
      expect(plan?.operations[0]).toMatchObject({
        destination: { identity: subscriptionId },
        inputs: { subscriptionId, tenantId: validTenantId, region: validRegion }
      });
      inspection.state.activationInputs = inspection.activationInputs;
      inspection.activationInputs = undefined;
      expect(resolveAzureInputs(input)).toEqual({ subscriptionId, tenantId: validTenantId, region: validRegion });
      inspection.state.activationInputs = undefined;
      expect(Object.values(resolveAzureInputs(input)).every((value) => value === undefined)).toBe(true);
    });

    it('rejects missing subscription, tenant, and region with structured blockers and never emits nil-UUID operation', async () => {
      const inspection = createMockInspection({
        activationInputs: {
          schemaVersion: 1,
          phases: {}
        }
      });
      const planInput = createPhasePlanningInput('phase-0-complete', inspection);
      const plan = await planAzurePhase(planInput);

      expect(plan).not.toBeNull();
      expect(plan?.operations).toEqual([]);
      expect(plan?.blockers?.length).toBeGreaterThan(0);
      expect(plan?.blockers?.[0]).toContain('requires valid explicit non-placeholder subscriptionId');
    });

    it('rejects nil UUID 00000000-0000-0000-0000-000000000000 as subscriptionId', async () => {
      const inspection = createMockInspection({
        activationInputs: {
          schemaVersion: 1,
          azure: {
            subscriptionId: NIL_UUID,
            tenantId: validTenantId,
            region: validRegion
          },
          phases: {}
        }
      });
      const planInput = createPhasePlanningInput('provider-ready', inspection);
      const plan = await planAzurePhase(planInput);

      expect(plan?.operations).toEqual([]);
      expect(plan?.blockers?.some((b) => b.includes('nil or placeholder UUID'))).toBe(true);
    });

    it('rejects malformed UUID format for subscription and tenant', () => {
      const validation = validateAzureBindings({
        subscriptionId: 'not-a-valid-uuid',
        tenantId: '12345',
        region: 'eastus'
      });
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes('valid UUID format'))).toBe(true);
    });

    it('rejects placeholder regions such as none, placeholder, or nil', () => {
      const validation = validateAzureBindings({
        subscriptionId: validSubId,
        tenantId: validTenantId,
        region: 'placeholder'
      });
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes('placeholder or invalid format'))).toBe(true);
    });

    it('returns null in repository-only scope without creating Azure operations', async () => {
      const inspection = createMockInspection({ scope: 'repository' });
      const planInput = createPhasePlanningInput('phase-0-complete', inspection);
      const plan = await planAzurePhase(planInput);
      expect(plan).toBeNull();
    });

    it('plans bounded discovery operations targeting the exact subscription ID when inputs are valid', async () => {
      const planInput = createPhasePlanningInput('phase-0-complete');
      const plan = await planAzurePhase(planInput);

      expect(plan).not.toBeNull();
      expect(plan?.blockers).toBeUndefined();
      expect(plan?.operations.length).toBe(1);
      expect(plan?.operations[0].destination.identity).toBe(validSubId);
      expect(plan?.operations[0].inputs.subscriptionId).toBe(validSubId);
    });
  });

  describe('Phase 0 Discovery & Account Verification (Task 9.4)', () => {
    it('executes az account show with exact --subscription ID and verifies matching Enabled account', async () => {
      const runner = new MockRunner();
      runner.when(
        (cmd) => cmd.args?.includes('account') && cmd.args?.includes('show'),
        {
          status: 0,
          stdout: JSON.stringify({
            id: validSubId,
            tenantId: validTenantId,
            state: 'Enabled',
            name: 'Production Subscription'
          })
        }
      );

      const execInput = createPhaseExecutionInput(
        'phase-0-complete',
        [{
          adapter: 'azure-opentofu',
          actionId: 'azure.phase0.discover',
          mutationClass: 'azure-read',
          phaseId: 'phase-0-complete',
          inputs: { subscriptionId: validSubId },
          destination: { type: 'subscription', identity: validSubId },
          remote: true,
          destructive: false
        }],
        createMockInspection(),
        runner
      );

      const outcome = await executeAzurePhase(execInput);

      expect(outcome?.status).toBe('completed');
      expect(outcome?.resultState).toBe('verified');
      expect(runner.calls.length).toBe(1);
      expect(runner.calls[0].command.args).toEqual([
        'account', 'show', '--subscription', validSubId, '--output', 'json'
      ]);

      const payload = outcome?.evidencePayload as any;
      expect(payload.kind).toBe('phase-0-discovery.v1');
      expect(payload.azure.subscriptionId).toBe(validSubId);
      expect(payload.azure.tenantId).toBe(validTenantId);
      expect(payload.azure.state).toBe('Enabled');
      expect(outcome?.liveReadback?.[0].matches).toBe(true);
    });

    it('rejects account when observed subscription ID does not match expected target', async () => {
      const runner = new MockRunner();
      const foreignSubId = '99999999-8888-7777-6666-555555555555';
      runner.when(
        (cmd) => cmd.args?.includes('account') && cmd.args?.includes('show'),
        {
          status: 0,
          stdout: JSON.stringify({
            id: foreignSubId,
            tenantId: validTenantId,
            state: 'Enabled'
          })
        }
      );

      const execInput = createPhaseExecutionInput(
        'phase-0-complete',
        [],
        createMockInspection(),
        runner
      );

      const outcome = await executeAzurePhase(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.blocker).toContain('Azure subscription ID mismatch');
    });

    it('rejects account when observed tenant ID does not match expected tenant', async () => {
      const runner = new MockRunner();
      const foreignTenantId = '88888888-7777-6666-5555-444444444444';
      runner.when(
        (cmd) => cmd.args?.includes('account') && cmd.args?.includes('show'),
        {
          status: 0,
          stdout: JSON.stringify({
            id: validSubId,
            tenantId: foreignTenantId,
            state: 'Enabled'
          })
        }
      );

      const execInput = createPhaseExecutionInput(
        'phase-0-complete',
        [],
        createMockInspection(),
        runner
      );

      const outcome = await executeAzurePhase(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.blocker).toContain('Azure tenant ID mismatch');
    });

    it.each(['Disabled', 'Warned', undefined, null, '', false, {}, []])('rejects account when state is missing or unusable: %j', async (state) => {
      const runner = new MockRunner();
      runner.when(
        (cmd) => cmd.args?.includes('account') && cmd.args?.includes('show'),
        {
          status: 0,
          stdout: JSON.stringify({
            id: validSubId,
            tenantId: validTenantId,
            state
          })
        }
      );

      const execInput = createPhaseExecutionInput(
        'phase-0-complete',
        [],
        createMockInspection(),
        runner
      );

      const outcome = await executeAzurePhase(execInput);
      expect(outcome).toMatchObject({ status: 'blocked', completedOperations: [] });
      expect(outcome?.blocker).toContain('expected Enabled');
      expect(outcome?.evidencePayload).toBeUndefined();
      expect(outcome?.liveReadback).toBeUndefined();
    });

    it('classifies unauthenticated CLI failure honestly without faking proof', async () => {
      const runner = new MockRunner();
      runner.when(
        (cmd) => cmd.args?.includes('account') && cmd.args?.includes('show'),
        {
          status: 1,
          stdout: '',
          stderr: 'ERROR: Please run "az login" to setup account.'
        }
      );

      const execInput = createPhaseExecutionInput(
        'phase-0-complete',
        [],
        createMockInspection(),
        runner
      );

      const outcome = await executeAzurePhase(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.blocker).toContain('Azure CLI is not authenticated');
    });

    it('phase-discovery.ts discoverPhase0 does not call Azure in repository scope', async () => {
      const runner = new MockRunner();
      mockGitRepository(runner, '/mock/project');
      runner.when(
        (cmd) => cmd.executable === 'gh' && cmd.args?.includes('repo'),
        {
          status: 0,
          stdout: JSON.stringify({
            id: 'R_123',
            nameWithOwner: 'owner/repo',
            defaultBranchRef: { name: 'main' },
            isPrivate: true
          })
        }
      );

      const inspection = createMockInspection({ scope: 'repository' });
      const execInput = createPhaseExecutionInput(
        'phase-0-complete',
        [{
          adapter: 'github',
          actionId: 'github.phase0.discover',
          mutationClass: 'github-read',
          phaseId: 'phase-0-complete',
          inputs: { repository: 'owner/repo' },
          destination: { type: 'repository', identity: 'owner/repo' },
          remote: true,
          destructive: false
        }],
        inspection,
        runner
      );

      const outcome = await discoverPhase0(execInput);
      expect(outcome).toBeNull();
      expect(runner.calls.some((c) => c.command.executable === 'az')).toBe(false);
    });

    it('does not complete full Phase 0 without independently bound GitHub observations', async () => {
      const runner = new MockRunner();
      mockGitRepository(runner, '/mock/project');
      runner.when(
        (cmd) => cmd.executable === 'gh',
        {
          status: 0,
          stdout: JSON.stringify({
            id: 'R_123',
            nameWithOwner: 'owner/repo',
            defaultBranchRef: { name: 'main' },
            isPrivate: true
          })
        }
      );
      runner.when(
        (cmd) => cmd.executable === 'az' && cmd.args?.includes('account'),
        {
          status: 0,
          stdout: JSON.stringify({
            id: validSubId,
            tenantId: validTenantId,
            state: 'Enabled'
          })
        }
      );

      const execInput = createPhaseExecutionInput(
        'phase-0-complete',
        [
          {
            adapter: 'github',
            actionId: 'github.phase0.discover',
            mutationClass: 'github-read',
            phaseId: 'phase-0-complete',
            inputs: { repository: 'owner/repo' },
            destination: { type: 'repository', identity: 'owner/repo' },
            remote: true,
            destructive: false
          },
          {
            adapter: 'azure-opentofu',
            actionId: 'azure.phase0.discover',
            mutationClass: 'azure-read',
            phaseId: 'phase-0-complete',
            inputs: { subscriptionId: validSubId },
            destination: { type: 'subscription', identity: validSubId },
            remote: true,
            destructive: false
          }
        ],
        createMockInspection(),
        runner
      );

      const outcome = await discoverPhase0(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.evidencePayload).toBeUndefined();
    });
  });

  describe('Provider Readiness (Task 11.3)', () => {
    it.each(['Registered', 'Registering', 'NotRegistered'])('does not infer source inventory or authority from %s status fixtures', async (status) => {
      const runner = new MockRunner();
      providerResponses(runner, { 'Microsoft.Storage': status });

      const execInput = createPhaseExecutionInput(
        'provider-ready',
        [{
          adapter: 'azure-opentofu',
          actionId: 'azure.provider.ensure-ready',
          mutationClass: 'azure-read',
          phaseId: 'provider-ready',
          inputs: { subscriptionId: validSubId },
          destination: { type: 'subscription', identity: validSubId },
          remote: true,
          destructive: false
        }],
        createMockInspection(),
        runner
      );

      const outcome = await executeAzurePhase(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.operation).toBeUndefined();
      expect(outcome?.evidencePayload).toBeUndefined();
      expect(outcome?.blocker).toContain('exact rootPathParts, principalId');
      expect(runner.calls).toEqual([]);
    });

    it.each([
      { approvedRegistrations: ['Microsoft.Network'] }, { autoRegisterApproved: true }
    ])('rejects configuration flags as provider mutation authority %#', async (flags) => {
      const runner = new MockRunner();
      providerResponses(runner, { 'Microsoft.Network': 'NotRegistered' });

      const inspection = createMockInspection({
        activationInputs: {
          schemaVersion: 1,
          azure: {
            subscriptionId: validSubId,
            tenantId: validTenantId,
            region: validRegion
          },
          phases: {
            'provider-ready': flags
          }
        }
      });

      const execInput = createPhaseExecutionInput(
        'provider-ready',
        [],
        inspection,
        runner
      );

      const outcome = await executeAzurePhase(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.blocker).toContain('Configuration approval flags cannot authorize');
      expect(outcome?.operation).toBeUndefined();
      expect(runner.calls).toEqual([]);
    });
  });

  describe('State Path Selection & Existing Private Path (Task 11.4)', () => {
    it('blocks state path selection if unconfigured without falling back to synthetic bootstrap', async () => {
      const inspection = createMockInspection({
        state: createMockState({
          applicability: {
            statePath: 'none' as any,
            privateStagingDast: true,
            credentialRequired: true
          }
        }),
        activationInputs: {
          schemaVersion: 1,
          azure: {
            subscriptionId: validSubId,
            tenantId: validTenantId,
            region: validRegion
          },
          phases: {}
        }
      });

      const execInput = createPhaseExecutionInput('state-path-selected', [], inspection);
      const outcome = await executeAzurePhase(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.blocker).toContain('Automatic fallback');
    });

    it('does not record a configured path without its exact approved selection operation', async () => {
      const inspection = createMockInspection({
        activationInputs: {
          schemaVersion: 1,
          azure: {
            subscriptionId: validSubId,
            tenantId: validTenantId,
            region: validRegion
          },
          phases: {
            'state-path-selected': {
              statePath: 'existing-private'
            }
          }
        }
      });

      const execInput = createPhaseExecutionInput(
        'state-path-selected',
        [{
          adapter: 'azure-opentofu',
          actionId: 'azure.state-path.select',
          mutationClass: 'azure-read',
          phaseId: 'state-path-selected',
          inputs: { allowed: ['existing-private', 'bootstrap-local'] },
          destination: { type: 'subscription', identity: validSubId },
          remote: true,
          destructive: false
        }],
        inspection
      );

      const outcome = await executeAzurePhase(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.stateOverride).toBeUndefined();
      expect(outcome?.evidencePayload).toBeUndefined();
    });

    it('does not promote storage metadata and versioning to a verified private management path', async () => {
      const runner = new MockRunner();
      runner.when(
        (cmd) => cmd.args?.includes('blob-service-properties') && cmd.args?.includes('show'),
        {
          status: 0,
          stdout: JSON.stringify({
            isVersioningEnabled: true
          })
        }
      );
      runner.when(
        (cmd) => cmd.args?.includes('storage') && cmd.args?.includes('show') && !cmd.args?.includes('blob-service-properties'),
        {
          status: 0,
          stdout: JSON.stringify({
            id: `/subscriptions/${validSubId}/resourceGroups/rg-state/providers/Microsoft.Storage/storageAccounts/stprivatestate`,
            name: 'stprivatestate',
            publicNetworkAccess: 'Disabled',
            minimumTlsVersion: 'TLS1_2'
          })
        }
      );

      const inspection = createMockInspection({
        activationInputs: {
          schemaVersion: 1,
          azure: {
            subscriptionId: validSubId,
            tenantId: validTenantId,
            region: validRegion
          },
          phases: {
            'existing-private-path': {
              resourceGroup: 'rg-state',
              storageAccount: 'stprivatestate',
              containerName: 'tfstate'
            }
          }
        }
      });

      const execInput = createPhaseExecutionInput(
        'existing-private-path',
        [{
          adapter: 'azure-opentofu',
          actionId: 'azure.existing-private-path.verify',
          mutationClass: 'azure-read',
          phaseId: 'existing-private-path',
          inputs: { statePath: 'existing-private' },
          destination: { type: 'subscription', identity: validSubId },
          remote: true,
          destructive: false
        }],
        inspection,
        runner
      );

      const outcome = await executeAzurePhase(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.blocker).toContain('exact selected activation path');
      expect(outcome?.evidencePayload).toBeUndefined();
      expect(outcome?.liveReadback).toBeUndefined();
      expect(runner.calls).toEqual([]);
    });

    it('blocks existing-private-path verification when blob versioning is disabled', async () => {
      const target = privateTarget();
      const f = await privateActivationFixture('existing-private-path', { target });
      try {
        const http = privateStateHttpFixture(target);
        const service = http.rows.get(`${fixtureStorageAccount}/blobServices/default`);
        if (!service || !isRecord(service.properties)) throw new Error('The exact blob-service fixture is missing.');
        service.properties.isVersioningEnabled = false;
        const input = await f.execution(planExistingPrivatePath(f.planning()));
        const outcome = await withProjectMutationLock(f.projectRoot, (lease) =>
          executeExistingPrivatePathVerification({ ...input, lease }, { path: http.path }));
        expect(outcome.status).toBe('blocked');
        expect(outcome.evidencePayload).toBeUndefined();
        expect(http.armCalls.some((call) => call.resourceId === `${fixtureStorageAccount}/blobServices/default`)).toBe(true);
        expect(http.armCalls.every((call) => call.method === 'GET')).toBe(true);
        expect(http.blob.calls).toEqual([]);
      } finally { await f.cleanup(); }
    });
  });

  describe('Bounded Bootstrap Local & Durable Checkpoints (Task 11.5 & 11.7)', () => {
    it('does not treat existing resource metadata as an executed private bootstrap', async () => {
      const runner = new MockRunner();
      runner.when(
        (cmd) => cmd.args?.includes('group') && cmd.args?.includes('show'),
        { status: 0, stdout: JSON.stringify({ name: 'rg-liftoff-bootstrap-eastus' }) }
      );
      runner.when(
        (cmd) => cmd.args?.includes('network') && cmd.args?.includes('vnet'),
        { status: 0, stdout: JSON.stringify({ name: 'vnet-liftoff-bootstrap' }) }
      );
      runner.when(
        (cmd) => cmd.args?.includes('storage') && cmd.args?.includes('show'),
        { status: 0, stdout: JSON.stringify({ id: 'st-id', name: 'stliftoffbooteastus' }) }
      );

      const execInput = createPhaseExecutionInput(
        'bootstrap-local',
        [{
          adapter: 'azure-opentofu',
          actionId: 'azure.bootstrap-local.apply',
          mutationClass: 'azure-network-provision',
          phaseId: 'bootstrap-local',
          inputs: { boundedLocalBootstrap: true },
          destination: { type: 'subscription', identity: validSubId },
          remote: true,
          destructive: false
        }],
        createMockInspection(),
        runner
      );

      const outcome = await executeAzurePhase(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.blocker).toContain('Bootstrap phase inputs requires its exact declared fields');
      expect(outcome?.evidencePayload).toBeUndefined();
      expect(runner.calls).toEqual([]);
    });

    it('never fabricates a provider operation ID when no operation was dispatched', async () => {
      const runner = new MockRunner();
      runner.when(
        (cmd) => cmd.args?.includes('group') && cmd.args?.includes('show'),
        { status: 0, stdout: JSON.stringify({ name: 'rg-liftoff-bootstrap-eastus' }) }
      );
      runner.when(
        (cmd) => cmd.args?.includes('network') && cmd.args?.includes('vnet'),
        { status: 1, stdout: '', stderr: 'ResourceNotFound: Virtual network not found' }
      );

      const execInput = createPhaseExecutionInput('bootstrap-local', [], createMockInspection(), runner);
      const outcome = await executeAzurePhase(execInput);

      expect(outcome?.status).toBe('blocked');
      expect(outcome?.operation).toBeUndefined();
      expect(outcome?.blocker).toContain('Bootstrap phase inputs requires its exact declared fields');
      expect(runner.calls).toEqual([]);
    });

    it('does not promote blob versioning metadata to private transport or lock proof', async () => {
      const runner = new MockRunner();
      runner.when(
        (cmd) => cmd.args?.includes('blob-service-properties'),
        { status: 0, stdout: JSON.stringify({ isVersioningEnabled: true }) }
      );
      runner.when(
        (cmd) => cmd.args?.includes('storage') && cmd.args?.includes('show') && !cmd.args?.includes('blob-service-properties'),
        { status: 0, stdout: JSON.stringify({ id: 'st-id', name: 'stliftoffbooteastus' }) }
      );

      const execInput = createPhaseExecutionInput(
        'private-backend-proof',
        [{
          adapter: 'azure-opentofu',
          actionId: 'azure.remote-state.read',
          mutationClass: 'azure-read',
          phaseId: 'private-backend-proof',
          inputs: { verifyAccess: true },
          destination: { type: 'subscription', identity: validSubId },
          remote: true,
          destructive: false
        }],
        createMockInspection(),
        runner
      );

      const outcome = await executeAzurePhase(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.evidencePayload).toBeUndefined();
      expect(outcome?.blocker).toContain('Private backend lease proof requires');
      expect(runner.calls).toEqual([]);
    });

    it('does not promote blob presence to verified import or a no-change OpenTofu plan', async () => {
      const runner = new MockRunner();
      runner.when(
        (cmd) => cmd.args?.includes('storage') && cmd.args?.includes('blob') && cmd.args?.includes('show'),
        { status: 0, stdout: JSON.stringify({ name: 'default.tfstate', properties: { contentLength: 1024 } }) }
      );

      const execInput = createPhaseExecutionInput(
        'remote-import-verified',
        [{
          adapter: 'azure-opentofu',
          actionId: 'azure.remote-import.verify',
          mutationClass: 'azure-state-import',
          phaseId: 'remote-import-verified',
          inputs: { noChangePlanRequired: true },
          destination: { type: 'subscription', identity: validSubId },
          remote: true,
          destructive: false
        }],
        createMockInspection(),
        runner
      );

      const outcome = await executeAzurePhase(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.evidencePayload).toBeUndefined();
      expect(outcome?.blocker).toContain('Remote bootstrap import inputs requires its exact declared fields');
      expect(runner.calls).toEqual([]);
    });
  });

  describe('Application Prerequisites & Immutable Artifacts (Task 11.8)', () => {
    it('does not invent application prerequisite names or an artifact selection', async () => {
      for (const phase of ['application-prerequisites-ready', 'application-artifact-ready'] as const) {
        const runner = new MockRunner();
        const outcome = await executeAzurePhase(createPhaseExecutionInput(phase, [], createMockInspection(), runner));
        expect(outcome?.status).toBe('blocked');
        if (phase === 'application-prerequisites-ready') {
          expect(outcome?.evidencePayload).toMatchObject({
            applicationPrivate: { status: 'blocked', transactionId: null, journalRef: null }
          });
          expect(outcome?.liveReadback).toEqual([]);
        } else expect(outcome?.evidencePayload).toBeUndefined();
        expect(runner.calls).toEqual([]);
      }
    });

    it('reads exact ACR and identity metadata without claiming private-plan application prerequisites', async () => {
      const runner = new MockRunner();
      runner.when(
        (cmd) => cmd.args?.includes('acr') && cmd.args?.includes('show'),
        {
          status: 0,
          stdout: JSON.stringify({
            id: `/subscriptions/${validSubId}/resourceGroups/rg-app/providers/Microsoft.ContainerRegistry/registries/crliftoff`,
            name: 'crliftoff',
            loginServer: 'crliftoff.azurecr.io',
            provisioningState: 'Succeeded'
          })
        }
      );
      runner.when(
        (cmd) => cmd.args?.includes('identity') && cmd.args?.includes('show'),
        {
          status: 0,
          stdout: JSON.stringify({
            id: `/subscriptions/${validSubId}/resourceGroups/rg-app/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-liftoff-app`,
            name: 'id-liftoff-app',
            clientId,
            principalId
          })
        }
      );

      const execInput = createPhaseExecutionInput(
        'application-prerequisites-ready',
        [{
          adapter: 'azure-opentofu',
          actionId: 'azure.prerequisites.verify',
          mutationClass: 'azure-read',
          phaseId: 'application-prerequisites-ready',
          inputs: { acr: true, managedIdentity: true },
          destination: { type: 'subscription', identity: validSubId },
          remote: true,
          destructive: false
        }],
        applicationInspection('application-prerequisites-ready', {
          resourceGroup: 'rg-app', acrName: 'crliftoff', identityName: 'id-liftoff-app'
        }),
        runner
      );

      expect(await executeAzureAcrShow(runner, execInput.inspection.projectRoot, validSubId, 'crliftoff')).toMatchObject({
        success: true, acr: { id: registryId, loginServer: 'crliftoff.azurecr.io', provisioningState: 'Succeeded' }
      });
      expect(await executeAzureIdentityShow(runner, execInput.inspection.projectRoot, validSubId, 'rg-app', 'id-liftoff-app')).toMatchObject({
        success: true, identity: { clientId, principalId }
      });
      runner.calls.length = 0;
      expect(await executeAzurePhase(execInput)).toMatchObject({ status: 'blocked', completedOperations: [] });
      expect(runner.calls).toEqual([]);
    });

    it('reads registry inventory without confusing a listed digest or tag with source-bound build provenance', async () => {
      const runner = new MockRunner();
      const genuineDigest = 'sha256:' + 'e'.repeat(64);
      runner.when(
        (cmd) => cmd.args?.includes('acr') && cmd.args?.includes('show'),
        {
          status: 0,
          stdout: JSON.stringify({
            id: registryId,
            name: 'crliftoff',
            loginServer: 'crliftoff.azurecr.io',
            provisioningState: 'Succeeded'
          })
        }
      );
      runner.when(
        (cmd) => cmd.args?.includes('repository') && cmd.args?.includes('show-manifests'),
        {
          status: 0,
          stdout: JSON.stringify([
            {
              digest: `sha256:${'f'.repeat(64)}`,
              tags: ['latest-unreviewed']
            },
            {
              digest: genuineDigest,
              tags: ['latest', 'commit-sha']
            }
          ])
        }
      );

      const execInput = createPhaseExecutionInput(
        'application-artifact-ready',
        [{
          adapter: 'azure-opentofu',
          actionId: 'azure.artifact.readback',
          mutationClass: 'azure-read',
          phaseId: 'application-artifact-ready',
          inputs: { verifyDigest: true },
          destination: { type: 'subscription', identity: validSubId },
          remote: true,
          destructive: false
        }],
        applicationInspection('application-artifact-ready', {
          acrName: 'crliftoff', imageName: 'test-project', expectedDigest: genuineDigest
        }),
        runner
      );

      expect(await executeAzureAcrManifestsShow(runner, execInput.inspection.projectRoot, validSubId, 'crliftoff', 'test-project')).toMatchObject({
        success: true, manifests: [{ digest: `sha256:${'f'.repeat(64)}` }, { digest: genuineDigest }]
      });
      runner.calls.length = 0;
      const outcome = await executeAzurePhase(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.evidencePayload).toBeUndefined();
      expect(outcome?.liveReadback).toBeUndefined();
      expect(runner.calls).toEqual([]);
    });

    it('rejects image manifests with invalid or placeholder digest', async () => {
      const runner = new MockRunner();
      runner.when(
        (cmd) => cmd.args?.includes('acr') && cmd.args?.includes('show'),
        { status: 0, stdout: JSON.stringify({ id: registryId, name: 'crliftoff', loginServer: 'crliftoff.azurecr.io', provisioningState: 'Succeeded' }) }
      );
      runner.when(
        (cmd) => cmd.args?.includes('repository') && cmd.args?.includes('show-manifests'),
        { status: 0, stdout: JSON.stringify([{ digest: 'placeholder-digest', tags: ['latest'] }]) }
      );

      const outcome = await executeAzureAcrManifestsShow(runner, '/mock/project', validSubId, 'crliftoff', 'test-project');
      expect(outcome).toMatchObject({ success: false, error: expect.stringContaining('Genuine sha256 digest is required') });
      expect(runner.calls).toHaveLength(1);
    });

    it('preserves nonterminal registry state instead of inventing a Succeeded default', async () => {
      const runner = new MockRunner();
      runner.when((cmd) => cmd.args.includes('acr') && cmd.args.includes('show'), {
        stdout: JSON.stringify({ id: registryId, name: 'crliftoff', loginServer: 'crliftoff.azurecr.io', provisioningState: 'Updating' })
      });
      expect(await executeAzureAcrShow(runner, '/mock/project', validSubId, 'crliftoff')).toMatchObject({
        success: true, acr: { provisioningState: 'Updating' }
      });
      expect(runner.calls).toHaveLength(1);
    });
  });

  describe('Application Foundation (Task 11.9)', () => {
    it('does not promote a resource-show response to executed deployment and runtime proof', async () => {
      const runner = new MockRunner();
      runner.when(
        (cmd) => cmd.args?.includes('containerapp') && cmd.args?.includes('show'),
        {
          status: 0,
          stdout: JSON.stringify({
            id: `/subscriptions/${validSubId}/resourceGroups/rg-app/providers/Microsoft.App/containerApps/ca-test-project`,
            name: 'ca-test-project',
            properties: {
              provisioningState: 'Succeeded',
              runningStatus: 'Running',
              configuration: { ingress: { fqdn: 'ca-test-project.eastus.azurecontainerapps.io' } }
            }
          })
        }
      );

      const execInput = createPhaseExecutionInput(
        'application-foundation',
        [{
          adapter: 'azure-opentofu',
          actionId: 'azure.application-foundation.apply',
          mutationClass: 'azure-resource-provision',
          phaseId: 'application-foundation',
          inputs: { opentofu: true },
          destination: { type: 'subscription', identity: validSubId },
          remote: true,
          destructive: false
        }],
        createMockInspection(),
        runner
      );

      const outcome = await executeAzurePhase(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.evidencePayload).toMatchObject({
        applicationPrivate: { status: 'blocked', transactionId: null, journalRef: null }
      });
      expect(outcome?.liveReadback).toEqual([]);
      expect(outcome?.completedOperations).toEqual([]);
    });
  });

  describe('Staging & Production Qualification Release Gate (Tasks 11.11, 11.12, 11.16)', () => {
    it('blocks qualification when environment is not declared in manifest', async () => {
      const inspection = createMockInspection();
      inspection.manifest.project.workload.environments = ['dev']; // Staging and prod absent

      const execInput = createPhaseExecutionInput('staging-qualified', [], inspection);
      const outcome = await executeAzurePhase(execInput);

      expect(outcome?.status).toBe('blocked');
      expect(outcome?.blocker).toContain('Staging execution requires exactly its registered fields');
      expect(outcome?.completedOperations).toEqual([]);
    });

    it('reports missing exact staging inputs without claiming the implemented producer is absent', async () => {
      const inspection = createMockInspection();
      const runner = new MockRunner();
      const execInput = createPhaseExecutionInput('staging-qualified', [], inspection, runner);
      const outcome = await executeAzurePhase(execInput);

      expect(outcome?.status).toBe('blocked');
      expect(outcome?.blocker).toContain('Staging execution requires exactly its registered fields');
      expect(outcome?.blocker).not.toContain('Implementation missing');
      expect(outcome?.completedOperations).toEqual([]);
      expect(outcome?.evidencePayload).toBeUndefined();
      expect(outcome?.liveReadback).toBeUndefined();
      expect(runner.calls).toEqual([]);
    });

    it('rejects a staging approval boolean without exact disposable target, effects, spend and time authority', async () => {
      const runner = new MockRunner();
      runner.when(
        (cmd) => cmd.args?.includes('containerapp') && cmd.args?.includes('show'),
        {
          status: 0,
          stdout: JSON.stringify({
            id: `/subscriptions/${validSubId}/resourceGroups/rg-liftoff-app-staging/providers/Microsoft.App/containerApps/ca-test-project-staging`,
            name: 'ca-test-project-staging',
            properties: {
              provisioningState: 'Succeeded',
              runningStatus: 'Running'
            }
          })
        }
      );

      const inspection = createMockInspection({
        activationInputs: {
          schemaVersion: 1,
          azure: {
            subscriptionId: validSubId,
            tenantId: validTenantId,
            region: validRegion
          },
          phases: {
            'staging-qualified': {
              qualificationApproved: true
            }
          }
        }
      });

      const execInput = createPhaseExecutionInput(
        'staging-qualified',
        [{
          adapter: 'azure-opentofu',
          actionId: 'azure.staging.readback',
          mutationClass: 'azure-read',
          phaseId: 'staging-qualified',
          inputs: { environment: 'staging' },
          destination: { type: 'subscription', identity: validSubId },
          remote: true,
          destructive: false
        }],
        inspection,
        runner
      );

      const outcome = await executeAzurePhase(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.evidencePayload).toBeUndefined();
      expect(runner.calls).toEqual([]);
    });

    it('rejects a generic production approval flag instead of manufacturing rehearsal proof', async () => {
      const runner = new MockRunner();
      runner.when(
        (cmd) => cmd.args?.includes('containerapp') && cmd.args?.includes('show'),
        {
          status: 0,
          stdout: JSON.stringify({
            id: `/subscriptions/${validSubId}/resourceGroups/rg-liftoff-app-prod/providers/Microsoft.App/containerApps/ca-test-project-prod`,
            name: 'ca-test-project-prod',
            properties: {
              provisioningState: 'Succeeded',
              runningStatus: 'Running'
            }
          })
        }
      );

      const inspection = createMockInspection({
        activationInputs: {
          schemaVersion: 1,
          azure: {
            subscriptionId: validSubId,
            tenantId: validTenantId,
            region: validRegion,
            disposableTarget: {
              approved: true,
              spendLimitUsd: 50,
              maxDurationMinutes: 60
            }
          },
          phases: {}
        }
      });

      const execInput = createPhaseExecutionInput(
        'production-rehearsed',
        [{
          adapter: 'azure-opentofu',
          actionId: 'azure.production-readback',
          mutationClass: 'azure-read',
          phaseId: 'production-rehearsed',
          inputs: { environment: 'prod' },
          destination: { type: 'subscription', identity: validSubId },
          remote: true,
          destructive: false
        }],
        inspection,
        runner
      );

      const outcome = await executeAzurePhase(execInput);
      expect(outcome?.status).toBe('blocked');
      expect(outcome?.evidencePayload).toBeUndefined();
      expect(runner.calls).toEqual([]);
    });
  });

  describe('Secret Sanitization', () => {
    it('sanitizes client secrets, tokens, passwords, and bearer credentials from error strings', () => {
      const raw = 'Failed request with Bearer eyJhbGciOiJIUzI1NiJ9.test and clientSecret="super-secret-123" and token=abc123secret';
      const sanitized = sanitizeAzureOutput(raw);

      expect(sanitized).not.toContain('super-secret-123');
      expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(sanitized).toContain('Bearer [REDACTED]');
      expect(sanitized).toContain('clientSecret: "[REDACTED]"');
    });
  });
});
