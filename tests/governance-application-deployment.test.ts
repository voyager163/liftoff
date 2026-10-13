import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applicationDeploymentExecutionMode,
  bindApplicationDeployment,
  observeApplicationDeploymentReadback,
  observeApplicationDeploymentSource,
  protectedApplicationAcceptedCheckpoint,
  protectedApplicationDispatchRequest,
  protectedApplicationExecutionIntent,
  protectedApplicationReadRequest,
  protectedApplicationTerminalCheckpoint,
  protectedApplicationWriteObservationRequest,
  validateApplicationStateMappingProofs,
  validateApplicationOriginalInvocation,
  validateProtectedApplicationAcceptedCheckpoint,
  validateProtectedApplicationCompletionProof,
  validateProtectedApplicationExecutionProvenance,
  validateProtectedApplicationReadResult,
  validateProtectedApplicationPlanProof,
  validateProtectedApplicationTerminalCheckpoint,
  validateProtectedApplicationWriteResult,
  type ApplicationDeploymentBinding,
  type ApplicationOriginalInvocation,
  type ApplicationOriginalStateAuthority,
  type ApplicationStateMappingProof,
  type FreshApplicationHealthObservation,
  type ObservedApplicationDeploymentSource,
  type ProtectedApplicationCompletionProof,
  type ProtectedApplicationExecutionAuthority,
  type ProtectedApplicationExecutionProvenance,
  type ProtectedApplicationPlanProof
} from '../src/governance-activation/application-deployment.js';
import type { VerifiedApplicationArtifact } from '../src/governance-activation/application-artifact.js';
import {
  buildSavedTransitionPlan, canonicalSha256
} from '../src/governance-activation/index.js';
import {
  NodeCommandRunner, type CommandResult, type CommandRunner, type RunCommandOptions
} from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';
import type { PhaseAdapterExecutionInput } from '../src/governance-activation/transition-ports.js';
import {
  applicationPlanningFixture
} from './fixtures/governance-coverage/application-project.js';
import {
  coverageNow, isolatedGitEnvironment, scratchDirectory, resetDirectory, writeCoverageProject
} from './fixtures/governance-coverage/transition-project.js';

const scratch = scratchDirectory('application-deployment');
const imageDigest = `sha256:${'d'.repeat(64)}`;
let gitEnvironment: NodeJS.ProcessEnv;
let counter = 0;

beforeAll(async () => {
  await resetDirectory(scratch);
  gitEnvironment = await isolatedGitEnvironment(scratch);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function commandResult(command: ExternalCommand, value: unknown): CommandResult {
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

class DeploymentRunner implements CommandRunner {
  readonly calls: ExternalCommand[] = [];
  readonly native = new NodeCommandRunner();
  binding: ApplicationDeploymentBinding | undefined;
  completion: ProtectedApplicationCompletionProof | undefined;
  imageDrift = false;
  unhealthyRevision = false;
  missingResource = false;

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push(command);
    if (command.executable === 'git') {
      return this.native.run(command, {
        ...options,
        env: { ...options?.env, ...gitEnvironment }
      });
    }
    if (command.executable !== 'az' || !this.binding || !this.completion) {
      throw new Error(`Unexpected application deployment fixture command: ${command.executable}`);
    }
    const key = command.args.join(' ');
    const fqdn = `${this.binding.expectedResourceNames.backendContainerApp}.example.azurecontainerapps.io`;
    if (key.startsWith('group show ')) {
      return commandResult(command, {
        id: this.binding.resourceGroupId,
        name: this.binding.resourceGroup,
        location: this.binding.region,
        provisioningState: 'Succeeded'
      });
    }
    if (key.startsWith('containerapp show ')) {
      return commandResult(command, {
        id: `${this.binding.resourceGroupId}/providers/Microsoft.App/containerApps/${this.binding.expectedResourceNames.backendContainerApp}`,
        name: this.binding.expectedResourceNames.backendContainerApp,
        location: this.binding.region,
        provisioningState: 'Succeeded',
        latestRevisionName: 'backend--qualified',
        ingress: {
          external: true,
          fqdn,
          traffic: [{ latestRevision: true, weight: 100 }]
        },
        template: {
          containers: [{
            name: 'backend',
            image: this.imageDrift ? `example.invalid/backend@sha256:${'a'.repeat(64)}` : this.binding.immutableImage
          }]
        },
        identity: {
          userAssignedIdentities: {
            [`${this.binding.resourceGroupId}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${this.binding.expectedResourceNames.identity}`]: {}
          }
        }
      });
    }
    if (key.startsWith('containerapp revision list ')) {
      return commandResult(command, [{
        name: 'backend--qualified',
        active: true,
        healthState: this.unhealthyRevision ? 'Unhealthy' : 'Healthy',
        provisioningState: 'Provisioned',
        runningState: 'Running',
        trafficWeight: 100,
        containers: [{ name: 'backend', image: this.binding.immutableImage }]
      }]);
    }
    if (key.startsWith('resource list ')) {
      const resources = this.missingResource
        ? this.completion.appliedResourceIds.slice(1)
        : this.completion.appliedResourceIds;
      return commandResult(command, resources.map((id) => ({ id })));
    }
    throw new Error(`Unexpected Azure fixture command: ${key}`);
  }
}

async function put(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function writeApplicationSources(root: string): Promise<void> {
  const moduleRoot = 'infrastructure/opentofu/azure/modules/application';
  const environmentRoot = 'infrastructure/opentofu/azure/environments/dev';
  await put(root, `${moduleRoot}/versions.tf`, 'terraform { required_version = ">= 1.12.6" }\n');
  await put(root, `${moduleRoot}/variables.tf`, [
    'variable "backend_image" { type = string }',
    'variable "postgres_admin_password" { type = string sensitive = true }'
  ].join('\n'));
  await put(root, `${moduleRoot}/main.tf`, [
    'resource "azurerm_resource_group" "main" { name = "fixture" location = "eastus" }',
    'resource "azurerm_container_app" "backend" { name = "fixture" resource_group_name = azurerm_resource_group.main.name }',
    'resource "azurerm_monitor_action_group" "custom" { name = "custom-preserved" resource_group_name = azurerm_resource_group.main.name short_name = "custom" }'
  ].join('\n'));
  await put(root, `${moduleRoot}/outputs.tf`, 'output "backend_url" { value = "fixture.example" }\n');
  await put(root, `${environmentRoot}/versions.tf`, 'terraform { required_version = ">= 1.12.6" }\n');
  await put(root, `${environmentRoot}/.terraform.lock.hcl`, '# exact provider lock fixture\n');
  await put(root, `${environmentRoot}/providers.tf`, 'provider "azurerm" { features {} }\n');
  await put(root, `${environmentRoot}/variables.tf`, 'variable "environment" { type = string default = "dev" }\n');
  await put(root, `${environmentRoot}/main.tf`, 'module "application" { source = "../../modules/application" }\n');
  await put(root, `${environmentRoot}/outputs.tf`, 'output "backend_url" { value = module.application.backend_url }\n');
  await put(root, `${environmentRoot}/backend.local.tf`, [
    'terraform {',
    '  backend "local" {',
    '    path = "state/dev.tfstate"',
    '  }',
    '}',
    ''
  ].join('\n'));
  await put(root, `${environmentRoot}/backend.remote.example.tf`, [
    '# Reviewed protected backend example only.',
    '# terraform { backend "azurerm" {} }',
    ''
  ].join('\n'));
  await put(root, `${environmentRoot}/dev.tfvars`, [
    'environment = "dev"',
    'location = "eastus"',
    'backend_target_port = 80'
  ].join('\n'));
}

async function git(root: string, runner: DeploymentRunner, args: readonly string[]): Promise<string> {
  const result = await runner.run({ executable: 'git', args: [...args] }, { cwd: root });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

async function fixture() {
  const root = await writeCoverageProject(path.join(scratch, `${++counter}`));
  await writeApplicationSources(root);
  const runner = new DeploymentRunner();
  await git(root, runner, ['init', '--initial-branch=develop']);
  await git(root, runner, ['add', '.']);
  await git(root, runner, [
    '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.test',
    'commit', '-m', 'Qualified application source'
  ]);
  const sourceSha = await git(root, runner, ['rev-parse', 'HEAD']);
  const planned = await applicationPlanningFixture(root, 'application-foundation', runner);
  const reference = (
    phaseId: 'remote-import-verified' | 'application-prerequisites-ready' |
      'application-artifact-ready',
    marker: string
  ) => ({
    phaseId,
    evidenceId: `${phaseId}-fixture`,
    headerDigest: marker.repeat(64),
    result: 'verified' as const
  });
  planned.state.phases['remote-import-verified'].state = 'verified';
  planned.state.phases['remote-import-verified'].evidence = [
    reference('remote-import-verified', '7')
  ];
  planned.state.phases['application-prerequisites-ready'].state = 'verified';
  planned.state.phases['application-prerequisites-ready'].evidence = [
    reference('application-prerequisites-ready', '8')
  ];
  planned.state.phases['application-artifact-ready'].state = 'verified';
  planned.state.phases['application-artifact-ready'].evidence = [
    reference('application-artifact-ready', '9')
  ];
  planned.state.bootstrapState = {
    status: 'retained',
    remoteImportEvidenceId: 'remote-import-verified-fixture',
    remoteImportEvidenceDigest: '6'.repeat(64),
    retainedAt: coverageNow.toISOString(),
    disposeAfter: new Date(coverageNow.getTime() + 30 * 86_400_000).toISOString(),
    encryptedStatePathParts: [['fixture', 'state']],
    encryptionKeyPathParts: [['fixture', 'key']]
  };
  planned.state.phaseOutputs = {
    ...planned.state.phaseOutputs,
    'remote-import-verified': {
      values: {
        custodyIdentityDigest: 'c'.repeat(64),
        custodyQualificationDigest: 'd'.repeat(64),
        bootstrapBindingDigest: planned.bootstrap.bindingDigest
      },
      resources: []
    },
    'application-prerequisites-ready': {
      values: {
        prerequisiteBindingDigest: planned.prerequisite.bindingDigest,
        environment: planned.prerequisite.environment,
        registryResourceId: planned.prerequisite.registryId,
        loginServer: `${planned.prerequisite.registryName}.azurecr.io`,
        workloadPrincipalId: '00000000-0000-4000-8000-000000000005',
        workloadClientId: '00000000-0000-4000-8000-000000000006'
      },
      resources: []
    }
  };
  const artifact: VerifiedApplicationArtifact = {
    sourceSha,
    workflowDigest: 'b'.repeat(64),
    workflowRunId: 901,
    workflowJobId: 902,
    acrRunId: 'ca1',
    environment: 'dev',
    registryResourceId: planned.prerequisite.registryId,
    imageRepository: 'application/backend',
    digest: imageDigest,
    immutableImage: `${planned.prerequisite.registryName}.azurecr.io/application/backend@${imageDigest}`,
    artifactBindingDigest: 'a'.repeat(64),
    attestationVerificationDigest: 'e'.repeat(64)
  };
  const binding = bindApplicationDeployment(planned, artifact);
  runner.binding = binding;
  const source = await observeApplicationDeploymentSource(planned, binding);
  const savedPlan = (await buildSavedTransitionPlan(planned))!;
  const input: PhaseAdapterExecutionInput = {
    ...planned,
    plan: savedPlan,
    adapters: {}
  };
  return { ...planned, input, runner, artifact, binding, source };
}

function planProof(
  binding: ApplicationDeploymentBinding,
  source: ObservedApplicationDeploymentSource
): ProtectedApplicationPlanProof {
  const authority = stateAuthority(binding);
  const state = mappingState(binding, authority);
  const body = {
    schemaVersion: 1 as const,
    kind: 'protected-application-plan.v1' as const,
    bindingDigest: binding.bindingDigest,
    sourceInventoryDigest: source.sourceInventoryDigest,
    executionInventoryDigest: source.executionInventoryDigest,
    providerLockDigest: source.providerLockDigest,
    backendOverlaySha256: source.backendOverlay.sha256,
    variableOverlayDigest: source.variableOverlay.digest,
    plannedAt: coverageNow.toISOString(),
    changes: { add: 12, change: 0 as const, destroy: 0 as const },
    resourceIds: [...binding.requiredResourceIds],
    stateTransitions: [...binding.stateTransitions],
    ownedResourceConfigurations: binding.ownedResourceConfigurations.map((resource) => ({
      resourceId: resource.resourceId,
      stateAddress: resource.stateAddress,
      configurationDigest: resource.configurationDigest
    })),
    state: {
      originalAuthorityDigest: authority.authorityDigest,
      mappingBatchDigest: state.mappingBatchDigest,
      lineage: state.after.stateLineage,
      serial: state.after.stateSerial,
      stateDigest: state.after.stateDigest,
      unmappedStateDigest: state.unmappedStateDigest
    },
    cost: {
      currency: binding.budget.currency,
      fixedMonthlyCents: binding.budget.fixedMonthlyCents - 1,
      usageMonthlyCents: binding.budget.usageMonthlyCents - 1
    },
    protectedInputs: [{
      name: 'postgres_admin_password' as const,
      source: 'qualified-protected-input' as const,
      valueIncluded: false as const
    }],
    checks: {
      initializedProtectedBackend: true as const,
      validatedConfiguration: true as const,
      providerLockVerified: true as const,
      artifactDigestBound: true as const,
      sourceUnchanged: true as const,
      plaintextStateAbsent: true as const,
      existingDeploymentAdoption: false as const
    }
  };
  return { ...body, planDigest: canonicalSha256(body) };
}

function stateAuthority(
  binding: ApplicationDeploymentBinding
): ApplicationOriginalStateAuthority {
  const value = {
    kind: 'protected-application-original-state.v1' as const,
    backendBindingDigest: binding.backendBindingDigest,
    remoteBackendDigest: '0'.repeat(64),
    handoverEvidenceId: 'remote-import-verified-fixture',
    handoverHeaderDigest: '7'.repeat(64),
    stateLineage: 'fixture-lineage',
    stateSerial: 1,
    stateDigest: '1'.repeat(64),
    unmappedStateDigest: '9'.repeat(64),
    observedAt: coverageNow.toISOString()
  };
  return { ...value, authorityDigest: canonicalSha256(value) };
}

function mappingState(
  binding: ApplicationDeploymentBinding,
  authority: ApplicationOriginalStateAuthority
) {
  const before = {
    stateLineage: authority.stateLineage,
    stateSerial: authority.stateSerial,
    stateDigest: authority.stateDigest,
    backupArtifactDigest: '2'.repeat(64),
    backupKeyRefDigest: '3'.repeat(64),
    lockProofDigest: '4'.repeat(64),
    writerQuiescenceDigest: '5'.repeat(64)
  };
  const after = {
    stateLineage: authority.stateLineage,
    stateSerial: authority.stateSerial + 1,
    stateDigest: '6'.repeat(64),
    lockProofDigest: '7'.repeat(64),
    writerQuiescenceDigest: '8'.repeat(64)
  };
  const mappings = binding.ownedResourceConfigurations.map((configuration) => {
    const transition = binding.stateTransitions.find((entry) =>
      entry.resourceId === configuration.resourceId)!;
    return {
      resourceId: configuration.resourceId,
      fromAddress: transition.fromAddress,
      toAddress: transition.toAddress,
      configurationDigest: configuration.configurationDigest
    };
  });
  const mappingBatchDigest = canonicalSha256({
    originalStateAuthorityDigest: authority.authorityDigest,
    before,
    after,
    unmappedStateDigestBefore: authority.unmappedStateDigest,
    unmappedStateDigestAfter: authority.unmappedStateDigest,
    mappings
  });
  return {
    before,
    after,
    unmappedStateDigest: authority.unmappedStateDigest,
    mappingBatchDigest
  };
}

function completionProof(
  binding: ApplicationDeploymentBinding,
  source: ObservedApplicationDeploymentSource,
  plan: ProtectedApplicationPlanProof
): ProtectedApplicationCompletionProof {
  const fqdn = `${binding.expectedResourceNames.backendContainerApp}.example.azurecontainerapps.io`;
  return {
    schemaVersion: 1,
    kind: 'protected-application-apply.v1',
    bindingDigest: binding.bindingDigest,
    planDigest: plan.planDigest,
    sourceInventoryDigest: source.sourceInventoryDigest,
    operation: {
      provider: 'azure',
      actionId: 'azure.application-foundation.apply',
      operationId: 'protected-application:fixture',
      resourceId: binding.resourceGroupId,
      startedAt: coverageNow.toISOString(),
      observedAt: new Date(coverageNow.getTime() + 1_000).toISOString(),
      status: 'completed',
      planDigest: plan.planDigest
    },
    originalStateAuthorityDigest: plan.state.originalAuthorityDigest,
    mappingBatchDigest: plan.state.mappingBatchDigest,
    stateLineage: plan.state.lineage,
    stateSerial: plan.state.serial + 1,
    preApplyStateDigest: plan.state.stateDigest,
    stateDigest: 'a'.repeat(64),
    unmappedStateDigest: plan.state.unmappedStateDigest,
    appliedResourceIds: [...plan.resourceIds],
    outputs: {
      backendUrl: `https://${fqdn}`,
      immutableImage: binding.immutableImage
    },
    health: [{
      component: 'backend',
      method: 'GET',
      path: '/health',
      endpoint: `https://${fqdn}/health`,
      status: 200,
      bodyBytes: 24,
      bodySha256: 'f'.repeat(64),
      observedAt: new Date(coverageNow.getTime() + 2_000).toISOString(),
      healthy: true
    }],
    noChangePlanDigest: 'e'.repeat(64),
    completedAt: new Date(coverageNow.getTime() + 3_000).toISOString(),
    checks: {
      protectedBackend: true,
      exactPlanApplied: true,
      providerReadbackComplete: true,
      noChangePlan: true,
      plaintextStateAbsent: true,
      sourceUnchanged: true
    }
  };
}

function executionAuthority(
  binding: ApplicationDeploymentBinding
): ProtectedApplicationExecutionAuthority {
  const executionRef = `liftoff-execution-${binding.sourceSha}`;
  const value = {
    hostId: 'qualified-host-fixture',
    runnerId: 444,
    runnerLabel: 'liftoff-fixture',
    runnerGroupId: 333,
    networkConfigurationId: 'NC_fixture',
    runnerQualificationDigest: '1'.repeat(64),
    networkQualificationDigest: '2'.repeat(64),
    custodyIdentityDigest: binding.custodyIdentityDigest,
    custodyQualificationDigest: binding.custodyQualificationDigest,
    workflow: {
      repositoryId: 1234,
      repository: 'owner/repo',
      path: '.github/workflows/application-execution.yml',
      executionRef,
      ref: `refs/tags/${executionRef}`,
      sourceSha: binding.sourceSha,
      treeSha: 'e'.repeat(40),
      tagObjectType: 'commit' as const,
      workflowDigest: '3'.repeat(64),
      executionSourceDigest: '4'.repeat(64),
      barrierStatus: 'active-update-deletion-no-bypass' as const,
      barrierBindingDigest: '5'.repeat(64),
      providerTagObservationDigest: '6'.repeat(64),
      providerAdmissionStatus: 'current' as const,
      providerAdmissionDigest: '7'.repeat(64)
    }
  };
  return { ...value, authorityDigest: canonicalSha256(value) };
}

function executionProvenance(
  authority: ProtectedApplicationExecutionAuthority
): ProtectedApplicationExecutionProvenance {
  const value = {
    executionHostId: authority.hostId,
    runnerId: authority.runnerId,
    runnerLabel: authority.runnerLabel,
    runnerGroupId: authority.runnerGroupId,
    networkConfigurationId: authority.networkConfigurationId,
    runnerQualificationDigest: authority.runnerQualificationDigest,
    networkQualificationDigest: authority.networkQualificationDigest,
    custodyIdentityDigest: authority.custodyIdentityDigest,
    custodyQualificationDigest: authority.custodyQualificationDigest,
    workflow: {
      repositoryId: authority.workflow.repositoryId,
      repository: authority.workflow.repository,
      path: authority.workflow.path,
      executionRef: authority.workflow.executionRef,
      ref: authority.workflow.ref,
      sourceSha: authority.workflow.sourceSha,
      treeSha: authority.workflow.treeSha,
      workflowDigest: authority.workflow.workflowDigest,
      executionSourceDigest: authority.workflow.executionSourceDigest
    },
    authorityDigest: authority.authorityDigest
  };
  return { ...value, provenanceDigest: canonicalSha256(value) };
}

function invocation(
  phaseId: ApplicationOriginalInvocation['phaseId']
): ApplicationOriginalInvocation {
  const value = {
    phaseId,
    graphHash: '1'.repeat(64),
    stateHash: '2'.repeat(64),
    baselineDigest: '3'.repeat(64),
    inputDigest: '4'.repeat(64),
    transitionDigest: '5'.repeat(64),
    planDigest: '6'.repeat(64),
    operationDigest: '7'.repeat(64),
    approvalEnvelopeId: `${phaseId}-approval`,
    approvalEnvelopeHash: '8'.repeat(64),
    createdAt: coverageNow.toISOString(),
    expiresAt: new Date(coverageNow.getTime() + 30 * 60_000).toISOString()
  };
  return { ...value, invocationDigest: canonicalSha256(value) };
}

function mappingProofs(
  binding: ApplicationDeploymentBinding,
  authority: ApplicationOriginalStateAuthority,
  plan: ProtectedApplicationPlanProof
): ApplicationStateMappingProof[] {
  const state = mappingState(binding, authority);
  return binding.ownedResourceConfigurations.map((configuration, index) => {
    const transition = binding.stateTransitions.find((entry) =>
      entry.resourceId === configuration.resourceId)!;
    if (transition.disposition === 'retain-external' || !transition.toAddress) {
      throw new Error('Fixture owned resource requires a mapped state address.');
    }
    const value = {
      resourceType: configuration.resourceType,
      resourceId: configuration.resourceId,
      disposition: transition.disposition,
      fromAddress: transition.fromAddress,
      toAddress: transition.toAddress,
      authoritativeRecord: configuration.authoritativeRecord,
      expectedConfigurationDigest: configuration.configurationDigest,
      originalStateAuthorityDigest: authority.authorityDigest,
      mappingBatchDigest: state.mappingBatchDigest,
      mappingIndex: index,
      mappingCount: binding.ownedResourceConfigurations.length,
      before: state.before,
      after: state.after,
      unmappedStateDigestBefore: state.unmappedStateDigest,
      unmappedStateDigestAfter: state.unmappedStateDigest,
      observedConfigurationDigest: configuration.configurationDigest,
      resourceMutationPerformed: false as const,
      custodyIdentityDigest: binding.custodyIdentityDigest,
      custodyQualificationDigest: binding.custodyQualificationDigest,
      retentionObligationDigest: binding.retentionObligationDigest
    };
    return { ...value, proofDigest: canonicalSha256(value) };
  });
}

function freshHealth(
  binding: ApplicationDeploymentBinding,
  source: ObservedApplicationDeploymentSource,
  completion: ProtectedApplicationCompletionProof,
  provenance: ProtectedApplicationExecutionProvenance,
  authority: ProtectedApplicationExecutionAuthority,
  status = 200,
  parsedBodyDigest = binding.healthTargets[0]!.parsedBodyDigest
): FreshApplicationHealthObservation {
  const value = {
    kind: 'protected-application-health.v1' as const,
    bindingDigest: binding.bindingDigest,
    sourceInventoryDigest: source.sourceInventoryDigest,
    executionAuthorityDigest: authority.authorityDigest,
    provenanceDigest: provenance.provenanceDigest,
    operationId: completion.operation.operationId,
    component: 'backend' as const,
    method: 'GET' as const,
    path: '/health' as const,
    endpoint: `${completion.outputs.backendUrl}/health`,
    revision: 'backend--qualified',
    immutableImage: binding.immutableImage,
    status,
    mediaType: 'application/json',
    bodyBytes: 15,
    bodySha256: 'b'.repeat(64),
    parsedBodyDigest,
    observedAt: new Date(Date.parse(completion.completedAt) + 1_000).toISOString()
  };
  return { ...value, observationDigest: canonicalSha256(value) };
}

describe('protected application deployment source contracts', () => {
  it('binds the exact artifact, backend, custody, owned prerequisites and immutable state transition', async () => {
    const f = await fixture();
    expect(f.binding).toMatchObject({
      phaseId: 'application-foundation',
      sourceSha: f.artifact.sourceSha,
      immutableImage: f.artifact.immutableImage,
      resourceGroupId: f.prerequisite.groupId,
      protectedVariableNames: ['postgres_admin_password'],
      requirements: {
        newEnvironmentOnly: true,
        protectedExecutionRequired: true,
        localStateFallback: false,
        plaintextStateFallback: false,
        arbitraryStateImport: false,
        uncertainRedispatch: false
      }
    });
    expect(f.binding.stateTransitions).toEqual([
      expect.objectContaining({
        disposition: 'move',
        fromAddress: 'azurerm_resource_group.bootstrap',
        toAddress: 'module.application.azurerm_resource_group.main'
      }),
      expect.objectContaining({
        disposition: 'import',
        toAddress: 'module.application.azurerm_container_registry.main'
      }),
      expect.objectContaining({
        disposition: 'import',
        toAddress: 'module.application.azurerm_user_assigned_identity.app'
      }),
      expect.objectContaining({
        disposition: 'import',
        toAddress: 'module.application.azurerm_role_assignment.acr_pull'
      }),
      expect.objectContaining({
        disposition: 'retain-external',
        resourceId: f.prerequisite.roles[1]!.id
      })
    ]);
  });

  it('retains every tracked customization but replaces only the exact local backend in private execution staging', async () => {
    const f = await fixture();
    expect(f.source.files.some((file) =>
      file.path.endsWith('/modules/application/main.tf'))).toBe(true);
    expect(f.source.files.some((file) => file.path === f.binding.localBackendPath)).toBe(true);
    expect(f.source.executionFiles.some((file) => file.path === f.binding.localBackendPath)).toBe(false);
    expect(f.source.backendOverlay.path).toBe('backend.tf');
    expect(f.source.backendOverlay.bytes).toBeGreaterThan(0);
    expect(f.source.variableOverlay.keys).toEqual([
      'backend_image', 'environment', 'location', 'resource_suffix'
    ]);
    expect(f.source.requiredProtectedVariables).toEqual(['postgres_admin_password']);
  });

  it('refuses dirty source, execution-overlay collisions and committed protected values', async () => {
    const dirty = await fixture();
    await put(dirty.root, `${dirty.binding.applicationRoot}/backend.tf`, 'terraform { backend "local" {} }\n');
    await expect(observeApplicationDeploymentSource(dirty, dirty.binding))
      .rejects.toThrow(/exact clean committed environment root/u);

    const secret = await fixture();
    await put(secret.root, secret.binding.environmentVariablesPath,
      'environment = "dev"\npostgres_admin_password = "not-permitted"\n');
    await git(secret.root, secret.runner, ['add', '.']);
    await git(secret.root, secret.runner, [
      '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.test',
      'commit', '-m', 'Unsafe fixture'
    ]);
    const unsafeArtifact = {
      ...secret.artifact,
      sourceSha: await git(secret.root, secret.runner, ['rev-parse', 'HEAD'])
    };
    const unsafeBinding = bindApplicationDeployment(secret, unsafeArtifact);
    await expect(observeApplicationDeploymentSource(secret, unsafeBinding))
      .rejects.toThrow(/protected values/u);
  });

  it('blocks frontend or worker-bearing workloads until each artifact is independently immutable', async () => {
    const f = await fixture();
    const inspection = {
      ...f.inspection,
      manifest: {
        ...f.inspection.manifest,
        project: {
          ...f.inspection.manifest.project,
          workload: {
            ...f.inspection.manifest.project.workload,
            frontend: true
          }
        }
      }
    };
    expect(() => bindApplicationDeployment({ ...f, inspection }, f.artifact))
      .toThrow(/one backend image only/u);
  });

  it('accepts only a bounded no-destroy plan under the exact resource and cost bindings', async () => {
    const f = await fixture();
    const authority = stateAuthority(f.binding);
    const proof = planProof(f.binding, f.source);
    expect(validateProtectedApplicationPlanProof(
      f.binding, f.source, authority, proof
    )).toBe(proof);

    const destructive = structuredClone(proof);
    Reflect.set(destructive.changes, 'destroy', 1);
    expect(() => validateProtectedApplicationPlanProof(
      f.binding, f.source, authority, destructive
    ))
      .toThrow(/no apply is permitted/u);

    const outside = structuredClone(proof);
    outside.resourceIds = [...outside.resourceIds, '/subscriptions/other/resourceGroups/foreign'];
    const { planDigest: ignored, ...outsideBody } = outside;
    void ignored;
    outside.planDigest = canonicalSha256(outsideBody);
    expect(() => validateProtectedApplicationPlanProof(
      f.binding, f.source, authority, outside
    ))
      .toThrow(/resource scope/u);

    const expensive = structuredClone(proof);
    expensive.cost.fixedMonthlyCents = f.binding.budget.fixedMonthlyCents + 1;
    const { planDigest: oldDigest, ...expensiveBody } = expensive;
    void oldDigest;
    expensive.planDigest = canonicalSha256(expensiveBody);
    expect(() => validateProtectedApplicationPlanProof(
      f.binding, f.source, authority, expensive
    ))
      .toThrow(/cost/u);

    const changedOwnedResource = structuredClone(proof);
    changedOwnedResource.ownedResourceConfigurations[0]!.configurationDigest =
      '0'.repeat(64);
    const { planDigest: staleDigest, ...changedBody } = changedOwnedResource;
    void staleDigest;
    changedOwnedResource.planDigest = canonicalSha256(changedBody);
    expect(() => validateProtectedApplicationPlanProof(
      f.binding, f.source, authority, changedOwnedResource
    )).toThrow(/state mapping/u);
  });

  it('binds protected execution provenance, original approval and fixed state mappings without broad authority', async () => {
    const f = await fixture();
    const state = stateAuthority(f.binding);
    const plan = planProof(f.binding, f.source);
    const completion = completionProof(f.binding, f.source, plan);
    const authority = executionAuthority(f.binding);
    const provenance = executionProvenance(authority);
    const writeInvocation = invocation('application-foundation');
    const readInvocation = invocation('staging-qualified');
    const mappings = mappingProofs(f.binding, state, plan);

    expect(validateProtectedApplicationExecutionProvenance(
      f.binding, provenance, authority
    )).toBe(provenance);
    expect(validateApplicationOriginalInvocation(writeInvocation)).toBe(writeInvocation);
    expect(validateApplicationStateMappingProofs(
      f.binding, state, plan, mappings
    )).toBe(mappings);

    const intent = protectedApplicationExecutionIntent(
      f.binding,
      f.source,
      plan,
      provenance,
      authority,
      state,
      writeInvocation,
      coverageNow.toISOString()
    );
    expect(protectedApplicationDispatchRequest(
      f.binding, f.source, plan, provenance, authority, state,
      writeInvocation, intent
    )).toMatchObject({
      mode: 'write',
      action: 'application-foundation',
      execution: 'dispatch',
      effects: {
        arbitraryImport: false,
        resourceGroupReplacement: false,
        externalPushRoleRetained: true
      }
    });
    expect(protectedApplicationReadRequest(
      'staging-qualified',
      f.binding,
      f.source,
      plan,
      completion,
      provenance,
      authority,
      state,
      readInvocation
    )).toMatchObject({
      mode: 'read-only',
      action: 'staging-qualified',
      permissions: {
        azureRead: true,
        stateRead: false,
        stateWrite: false,
        dispatch: false,
        import: false,
        move: false,
        apply: false
      }
    });

    const changedUnmappedState = structuredClone(mappings);
    changedUnmappedState[0]!.unmappedStateDigestAfter = '0'.repeat(64);
    expect(() => validateApplicationStateMappingProofs(
      f.binding, state, plan, changedUnmappedState
    )).toThrow(/unmapped state/u);

    const staleProvenance = structuredClone(provenance);
    staleProvenance.workflow.ref = 'main';
    const { provenanceDigest: ignoredDigest, ...staleBody } = staleProvenance;
    void ignoredDigest;
    staleProvenance.provenanceDigest = canonicalSha256(staleBody);
    expect(() => validateProtectedApplicationExecutionProvenance(
      f.binding, staleProvenance, authority
    )).toThrow(/immutable current workflow source/u);

    const annotatedAuthority = structuredClone(authority);
    Reflect.set(annotatedAuthority.workflow, 'tagObjectType', 'tag');
    const { authorityDigest, ...annotatedBody } = annotatedAuthority;
    void authorityDigest;
    annotatedAuthority.authorityDigest = canonicalSha256(annotatedBody);
    const annotatedProvenance = executionProvenance(annotatedAuthority);
    expect(() => validateProtectedApplicationExecutionProvenance(
      f.binding, annotatedProvenance, annotatedAuthority
    )).toThrow(/immutable current workflow source/u);

    const disconnectedMappings = structuredClone(mappings);
    for (const [index, proof] of disconnectedMappings.entries()) {
      proof.before.stateLineage = `disconnected-${index}`;
      proof.after.stateLineage = `disconnected-${index}`;
      const { proofDigest, ...body } = proof;
      void proofDigest;
      proof.proofDigest = canonicalSha256(body);
    }
    expect(() => validateApplicationStateMappingProofs(
      f.binding, state, plan, disconnectedMappings
    )).toThrow(/state mapping/u);
  });

  it('durably separates no-effect blocking, accepted operations, terminal checkpoints and read-only observation', async () => {
    const f = await fixture();
    const state = stateAuthority(f.binding);
    const plan = planProof(f.binding, f.source);
    const completion = completionProof(f.binding, f.source, plan);
    const authority = executionAuthority(f.binding);
    const provenance = executionProvenance(authority);
    const writeInvocation = invocation('application-foundation');
    const intent = protectedApplicationExecutionIntent(
      f.binding,
      f.source,
      plan,
      provenance,
      authority,
      state,
      writeInvocation,
      coverageNow.toISOString()
    );
    const dispatch = protectedApplicationDispatchRequest(
      f.binding, f.source, plan, provenance, authority, state,
      writeInvocation, intent
    );
    const runningOperation = {
      ...completion.operation,
      status: 'running' as const,
      planDigest: writeInvocation.planDigest
    };
    const accepted = protectedApplicationAcceptedCheckpoint(
      dispatch,
      runningOperation,
      new Date(coverageNow.getTime() + 1_000).toISOString()
    );
    const retainedIntent = { intent, accepted: null, terminal: null };
    expect(validateProtectedApplicationWriteResult(dispatch, {
      status: 'uncertain',
      effect: 'intent',
      reason: 'checkpoint-failed',
      intent
    }, retainedIntent)).toMatchObject({
      status: 'uncertain',
      effect: 'intent'
    });
    const firstRetry = protectedApplicationWriteObservationRequest(
      f.binding,
      f.source,
      plan,
      provenance,
      authority,
      state,
      writeInvocation,
      retainedIntent
    );
    expect(firstRetry).toMatchObject({
      execution: 'observe',
      observationReason: 'intent-without-handle',
      previousOperation: null
    });
    expect(validateProtectedApplicationAcceptedCheckpoint(
      dispatch, accepted
    )).toBe(accepted);
    const retainedAccepted = { intent, accepted, terminal: null };
    expect(validateProtectedApplicationWriteResult(dispatch, {
      status: 'failed',
      effect: 'accepted',
      reason: 'verification-failed',
      operation: runningOperation,
      intent,
      accepted
    }, retainedAccepted)).toMatchObject({
      status: 'failed',
      effect: 'accepted',
      operation: { operationId: runningOperation.operationId }
    });

    const terminalOperation = {
      ...runningOperation,
      status: 'completed' as const,
      observedAt: new Date(coverageNow.getTime() + 2_000).toISOString()
    };
    const terminal = protectedApplicationTerminalCheckpoint(
      dispatch,
      accepted,
      terminalOperation,
      new Date(coverageNow.getTime() + 2_000).toISOString()
    );
    expect(validateProtectedApplicationTerminalCheckpoint(
      dispatch, accepted, terminal
    )).toBe(terminal);
    const retainedTerminal = { intent, accepted, terminal };
    expect(validateProtectedApplicationWriteResult(dispatch, {
      status: 'failed',
      effect: 'terminal',
      reason: 'health-unverified',
      operation: terminalOperation,
      intent,
      accepted,
      terminal
    }, retainedTerminal)).toMatchObject({
      status: 'failed',
      effect: 'terminal',
      operation: { status: 'completed' }
    });

    const completedProof = {
      ...completion,
      operation: terminalOperation
    };
    expect(validateProtectedApplicationWriteResult(dispatch, {
      status: 'completed',
      effect: 'terminal',
      action: 'application-foundation',
      operation: terminalOperation,
      intent,
      accepted,
      terminal,
      provenance,
      plan,
      mappings: mappingProofs(f.binding, state, plan),
      completion: completedProof
    }, retainedTerminal)).toMatchObject({
      status: 'completed',
      effect: 'terminal'
    });

    const withoutTerminal = {
      status: 'completed',
      effect: 'terminal',
      action: 'application-foundation',
      operation: terminalOperation,
      intent,
      accepted,
      terminal,
      provenance,
      plan,
      mappings: mappingProofs(f.binding, state, plan),
      completion: completedProof
    } as const;
    Reflect.deleteProperty(withoutTerminal, 'terminal');
    expect(() => validateProtectedApplicationWriteResult(
      dispatch, withoutTerminal, retainedTerminal
    )).toThrow(/terminal-before-readback/u);

    const uncertain = protectedApplicationWriteObservationRequest(
      f.binding,
      f.source,
      plan,
      provenance,
      authority,
      state,
      writeInvocation,
      retainedIntent
    );
    expect(validateProtectedApplicationWriteResult(uncertain, {
      status: 'uncertain',
      effect: 'intent',
      reason: 'verification-failed',
      intent
    }, retainedIntent)).toMatchObject({
      status: 'uncertain',
      effect: 'intent'
    });
    expect(() => validateProtectedApplicationWriteResult(uncertain, {
      status: 'blocked',
      effect: 'none',
      reason: 'verification-failed'
    }, retainedIntent)).toThrow(/before the first dispatch effect/u);

    const observeAccepted = protectedApplicationWriteObservationRequest(
      f.binding,
      f.source,
      plan,
      provenance,
      authority,
      state,
      writeInvocation,
      retainedAccepted
    );
    const differentOperation = {
      ...runningOperation,
      operationId: 'protected-application:different',
      startedAt: new Date(coverageNow.getTime() + 500).toISOString()
    };
    const rebuiltAccepted = protectedApplicationAcceptedCheckpoint(
      dispatch,
      differentOperation,
      accepted.acceptedAt
    );
    expect(() => validateProtectedApplicationWriteResult(observeAccepted, {
      status: 'accepted',
      effect: 'accepted',
      operation: differentOperation,
      intent,
      accepted: rebuiltAccepted
    }, retainedAccepted)).toThrow(/independently retained/u);

    const observeTerminal = protectedApplicationWriteObservationRequest(
      f.binding,
      f.source,
      plan,
      provenance,
      authority,
      state,
      writeInvocation,
      retainedTerminal
    );
    expect(() => validateProtectedApplicationWriteResult(observeTerminal, {
      status: 'accepted',
      effect: 'accepted',
      operation: runningOperation,
      intent,
      accepted
    }, retainedTerminal)).toThrow(/running provider handle/u);

    const readRequest = protectedApplicationReadRequest(
      'staging-qualified',
      f.binding,
      f.source,
      plan,
      completedProof,
      provenance,
      authority,
      state,
      invocation('staging-qualified')
    );
    f.runner.completion = completedProof;
    const observed = await observeApplicationDeploymentReadback(
      f.input, f.source, state, plan, completedProof, provenance, authority,
      freshHealth(f.binding, f.source, completedProof, provenance, authority)
    );
    const readResult = {
      status: 'completed' as const,
      effect: 'none' as const,
      action: 'staging-qualified' as const,
      operation: terminalOperation,
      provenance,
      admittedCompletionDigest: readRequest.admittedCompletionDigest,
      observation: observed
    };
    expect(validateProtectedApplicationReadResult(
      readRequest, readResult, observed
    )).toBe(readResult);
    const contradictoryRead = { ...readResult };
    Reflect.set(contradictoryRead, 'effect', 'terminal');
    expect(() => validateProtectedApplicationReadResult(
      readRequest, contradictoryRead, observed
    )).toThrow(/Read-only result/u);
  });

  it('requires exact applied state, no-change proof and successful bounded workload health', async () => {
    const f = await fixture();
    const state = stateAuthority(f.binding);
    const plan = planProof(f.binding, f.source);
    const completion = completionProof(f.binding, f.source, plan);
    expect(validateProtectedApplicationCompletionProof(
      f.binding, f.source, state, plan, completion
    )).toBe(completion);

    const unhealthy = structuredClone(completion);
    Reflect.set(unhealthy.health[0]!, 'healthy', false);
    expect(() => validateProtectedApplicationCompletionProof(
      f.binding, f.source, state, plan, unhealthy
    )).toThrow(/workload health/u);

    const incomplete = structuredClone(completion);
    incomplete.appliedResourceIds = incomplete.appliedResourceIds.slice(1);
    expect(() => validateProtectedApplicationCompletionProof(
      f.binding, f.source, state, plan, incomplete
    )).toThrow(/resource inventory/u);
  });

  it('independently reobserves exact Azure resources, immutable image, revision health and inventory', async () => {
    const f = await fixture();
    const state = stateAuthority(f.binding);
    const plan = planProof(f.binding, f.source);
    const completion = completionProof(f.binding, f.source, plan);
    const authority = executionAuthority(f.binding);
    const provenance = executionProvenance(authority);
    const health = freshHealth(
      f.binding, f.source, completion, provenance, authority
    );
    f.runner.completion = completion;
    const result = await observeApplicationDeploymentReadback(
      f.input, f.source, state, plan, completion, provenance, authority, health
    );
    expect(result.observed).toMatchObject({
      kind: 'application-foundation-readback.v1',
      bindingDigest: f.binding.bindingDigest,
      immutableImage: f.binding.immutableImage,
      health: { status: 200 }
    });
    expect(result.liveReadback).toHaveLength(2);

    f.runner.imageDrift = true;
    await expect(observeApplicationDeploymentReadback(
      f.input, f.source, state, plan, completion, provenance, authority, health
    )).rejects.toThrow(/immutable image/u);
    f.runner.imageDrift = false;
    f.runner.unhealthyRevision = true;
    await expect(observeApplicationDeploymentReadback(
      f.input, f.source, state, plan, completion, provenance, authority, health
    )).rejects.toThrow(/revision health/u);
    f.runner.unhealthyRevision = false;

    const currentFailure = freshHealth(
      f.binding, f.source, completion, provenance, authority, 500
    );
    await expect(observeApplicationDeploymentReadback(
      f.input, f.source, state, plan, completion, provenance, authority,
      currentFailure
    )).rejects.toThrow(/Fresh application health/u);

    const malformedSuccess = freshHealth(
      f.binding, f.source, completion, provenance, authority, 200,
      '0'.repeat(64)
    );
    await expect(observeApplicationDeploymentReadback(
      f.input, f.source, state, plan, completion, provenance, authority,
      malformedSuccess
    )).rejects.toThrow(/Fresh application health/u);
  });

  it('never redispatches recorded uncertain or mismatched application operations', async () => {
    const f = await fixture();
    expect(applicationDeploymentExecutionMode(f.input, f.binding)).toEqual({
      mode: 'dispatch',
      previousOperation: null
    });
    f.state.phases['application-foundation'].executionPlanDigest = f.input.plan.planDigest;
    expect(() => applicationDeploymentExecutionMode(f.input, f.binding))
      .toThrow(/without a confirmed provider handle/u);
    f.state.phases['application-foundation'].operation = {
      provider: 'azure',
      actionId: 'azure.application-foundation.apply',
      operationId: 'protected-application:fixture',
      resourceId: f.binding.resourceGroupId,
      startedAt: coverageNow.toISOString(),
      observedAt: coverageNow.toISOString(),
      status: 'running',
      planDigest: f.input.plan.planDigest
    };
    expect(applicationDeploymentExecutionMode(f.input, f.binding)).toMatchObject({
      mode: 'observe',
      previousOperation: { operationId: 'protected-application:fixture' }
    });
    f.state.phases['application-foundation'].operation!.resourceId =
      '/subscriptions/other/resourceGroups/foreign';
    expect(() => applicationDeploymentExecutionMode(f.input, f.binding))
      .toThrow(/not the exact protected deployment handle/u);
  });
});
