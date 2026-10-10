import { stat } from 'node:fs/promises';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import type {
  ExternalOperationState,
  LiveReadbackProof,
  TransitionOperation
} from '../domain/governance/activation/types.js';
import { validateArtifactPathParts } from '../domain/project/paths.js';
import { resolveProjectPath } from '../adapters/filesystem/project-paths.js';
import {
  GitHubActivationError,
  safeGitHubFailure
} from '../adapters/github/activation-rest.js';
import type {
  PhaseAdapterExecutionInput,
  PhaseAdapterOutcome,
  PhasePlanningInput,
  ProtectedBackendProof,
  ProtectedStateHandoverProof,
  ProtectedStateOperationRequest,
  ProtectedStateResourceMapping
} from './transition-ports.js';
import {
  azureBackendConfiguration,
  type BackendPlanBinding
} from './azure-backend-readiness.js';
import {
  bootstrapBinding,
  type BootstrapBinding
} from './azure-backend-bootstrap.js';
import {
  runnerBinding
} from './runner-readiness.js';
import {
  assertGitHubAuthorized,
  repositoryConfiguration,
  verifiedOutput
} from './github-config.js';
import { readbackProof } from './transition-records.js';

const digestPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const stateAddressPattern =
  /^(?:azurerm_[a-z0-9_]+\.[a-z0-9_]+)(?:\.[a-z0-9_]+\[[0-9]+\])?$/u;

interface ProtectedStateBinding {
  request: Omit<ProtectedStateOperationRequest, 'phaseId' | 'previousOperation'>;
  backend: BackendPlanBinding;
  bootstrap: BootstrapBinding;
}

function handoverError(code: string, message: string): never {
  throw new GitHubActivationError(code, message);
}

function stateAddress(
  disposition: ProtectedStateResourceMapping['disposition'],
  value: string | null
): string | null {
  if (disposition === 'retain-operation-record') {
    if (value !== null) {
      return handoverError(
        'state-mapping',
        'Retained deployment-operation records cannot claim an OpenTofu state address.'
      );
    }
    return null;
  }
  if (!value || !stateAddressPattern.test(value)) {
    return handoverError(
      'state-mapping',
      'Every imported or embedded bootstrap resource requires one fixed OpenTofu address.'
    );
  }
  return value;
}

function mapping(
  resourceType: string,
  resourceId: string,
  disposition: ProtectedStateResourceMapping['disposition'],
  address: string | null
): ProtectedStateResourceMapping {
  return {
    resourceType,
    resourceId,
    disposition,
    stateAddress: stateAddress(disposition, address)
  };
}

function bootstrapResourceMappings(
  bootstrap: BootstrapBinding
): readonly ProtectedStateResourceMapping[] {
  const resources = [
    {
      resourceType: 'Microsoft.Resources/deployments',
      resourceId: bootstrap.deploymentResourceId
    },
    ...bootstrap.resourceIds
  ];
  const seen = new Set<string>();
  const mappings = resources.map((resource) => {
    const key = resource.resourceId.toLowerCase();
    if (seen.has(key)) {
      return handoverError(
        'state-mapping',
        'Bootstrap ownership contains a duplicate resource identity.'
      );
    }
    seen.add(key);
    switch (resource.resourceType) {
      case 'Microsoft.Resources/resourceGroups':
        return mapping(resource.resourceType, resource.resourceId, 'import', 'azurerm_resource_group.bootstrap');
      case 'Microsoft.Resources/deployments':
        return mapping(resource.resourceType, resource.resourceId, 'retain-operation-record', null);
      case 'Microsoft.Network/virtualNetworks':
        return mapping(resource.resourceType, resource.resourceId, 'import', 'azurerm_virtual_network.bootstrap');
      case 'Microsoft.Network/virtualNetworks/subnets':
        if (resource.resourceId.endsWith(`/subnets/${bootstrap.runnerSubnetName}`)) {
          return mapping(resource.resourceType, resource.resourceId, 'import', 'azurerm_subnet.runner');
        }
        if (resource.resourceId.endsWith(`/subnets/${bootstrap.privateEndpointSubnetName}`)) {
          return mapping(resource.resourceType, resource.resourceId, 'import', 'azurerm_subnet.private_endpoint');
        }
        break;
      case 'Microsoft.Network/publicIPAddresses':
        return mapping(resource.resourceType, resource.resourceId, 'import', 'azurerm_public_ip.egress');
      case 'Microsoft.Network/natGateways':
        return mapping(resource.resourceType, resource.resourceId, 'import', 'azurerm_nat_gateway.egress');
      case 'Microsoft.Network/privateEndpoints':
        return mapping(resource.resourceType, resource.resourceId, 'import', 'azurerm_private_endpoint.state');
      case 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups':
        return mapping(
          resource.resourceType,
          resource.resourceId,
          'embedded',
          'azurerm_private_endpoint.state.private_dns_zone_group[0]'
        );
      case 'Microsoft.Network/privateDnsZones':
        return mapping(resource.resourceType, resource.resourceId, 'import', 'azurerm_private_dns_zone.state');
      case 'Microsoft.Network/privateDnsZones/virtualNetworkLinks':
        return mapping(
          resource.resourceType,
          resource.resourceId,
          'import',
          'azurerm_private_dns_zone_virtual_network_link.state'
        );
    }
    return handoverError(
      'state-mapping',
      `Bootstrap resource type ${resource.resourceType} has no reviewed state disposition.`
    );
  });
  if (mappings.filter((entry) => entry.disposition === 'import').length !== 9 ||
    mappings.filter((entry) => entry.disposition === 'embedded').length !== 1 ||
    mappings.filter((entry) => entry.disposition === 'retain-operation-record').length !== 2) {
    return handoverError(
      'state-mapping',
      'Bootstrap handover must preserve the exact reviewed import, embedded-child, and deployment-record inventory.'
    );
  }
  return mappings;
}

function exactRunnerOutput(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  key: string
): string | number {
  const value = verifiedOutput(input.inspection, 'runner-ready', key);
  if (typeof value !== 'string' && typeof value !== 'number') {
    return handoverError(
      'state-runner-binding',
      `Verified runner output ${key} is absent or has an unsupported type.`
    );
  }
  return value;
}

function bindingFor(
  input: PhasePlanningInput | PhaseAdapterExecutionInput
): ProtectedStateBinding {
  const backend = azureBackendConfiguration(input, 'bootstrap-local');
  const bootstrap = bootstrapBinding(input);
  const runner = runnerBinding(input);
  const runnerId = Number(exactRunnerOutput(input, 'runnerId'));
  const groupId = Number(exactRunnerOutput(input, 'groupId'));
  const networkConfigurationId = String(exactRunnerOutput(input, 'networkConfigurationId'));
  const runnerLabel = String(exactRunnerOutput(input, 'label'));
  const runnerDigest = String(exactRunnerOutput(input, 'runnerBindingDigest'));
  if (!Number.isSafeInteger(runnerId) || runnerId <= 0 ||
    !Number.isSafeInteger(groupId) || groupId <= 0 ||
    !networkConfigurationId || runnerLabel !== runner.label ||
    runnerDigest !== runner.bindingDigest) {
    return handoverError(
      'state-runner-binding',
      'Protected state work requires the exact current verified hosted-runner outputs.'
    );
  }
  const bootstrapOutput = input.inspection.state.phaseOutputs?.['bootstrap-local'];
  const expectedBootstrapResources = [
    {
      resourceType: 'Microsoft.Resources/deployments',
      resourceId: bootstrap.deploymentResourceId
    },
    ...bootstrap.resourceIds
  ];
  if (bootstrapOutput?.values.bootstrapBindingDigest !== bootstrap.bindingDigest ||
    bootstrapOutput.values.backendBindingDigest !== backend.bindingDigest ||
    bootstrapOutput.resources.length !== expectedBootstrapResources.length ||
    expectedBootstrapResources.some((resource) => !bootstrapOutput.resources.some((output) =>
      output.provider === 'azure' &&
      output.resourceType === resource.resourceType &&
      output.resourceId.toLowerCase() === resource.resourceId.toLowerCase()))) {
    return handoverError(
      'state-bootstrap-binding',
      'Protected state work requires the complete exact bootstrap-local ownership inventory.'
    );
  }
  const repository = repositoryConfiguration(input.inspection);
  const resources = bootstrapResourceMappings(bootstrap);
  const provisional = {
    repository: repository.name,
    defaultBranch: repository.defaultBranch,
    runner: {
      id: runnerId,
      label: runnerLabel,
      groupId,
      networkConfigurationId
    },
    backend: {
      bindingDigest: backend.bindingDigest,
      subscriptionId: backend.subscriptionId,
      tenantId: backend.tenantId,
      resourceGroup: backend.resourceGroup,
      storageAccount: backend.storageAccount,
      container: backend.container,
      keyDigest: canonicalSha256(backend.key),
      principalId: backend.principalId
    },
    bootstrap: {
      bindingDigest: bootstrap.bindingDigest,
      deploymentResourceId: bootstrap.deploymentResourceId,
      environment: bootstrap.environment,
      egressMode: bootstrap.egressMode
    },
    resources,
    requirements: {
      targetState: 'absent' as const,
      locking: 'azure-blob-lease' as const,
      backup: 'authenticated-encrypted' as const,
      completeMapping: true as const,
      noChangePlan: true as const,
      retentionDays: 30 as const,
      preExistingStateMigration: false as const
    }
  };
  if (input.phase.id === 'remote-import-verified') {
    const proofPhase = input.inspection.state.phases['private-backend-proof'];
    const proofOutput = input.inspection.state.phaseOutputs?.['private-backend-proof'];
    if (proofPhase.state !== 'verified' ||
      proofOutput?.values.stateHandoverBindingDigest !== canonicalSha256(provisional) ||
      proofOutput.values.backendBindingDigest !== backend.bindingDigest ||
      proofOutput.values.bootstrapBindingDigest !== bootstrap.bindingDigest ||
      proofOutput.values.targetStateExists !== false ||
      proofOutput.values.locking !== 'azure-blob-lease') {
      return handoverError(
        'state-backend-proof',
        'State handover requires current verified private-backend-proof outputs for the exact runner, backend, and bootstrap binding.'
      );
    }
  }
  return {
    backend,
    bootstrap,
    request: {
      schemaVersion: 1,
      bindingDigest: canonicalSha256(provisional),
      ...provisional
    }
  };
}

export function privateBackendProofPlanInputs(
  input: PhasePlanningInput | PhaseAdapterExecutionInput
): Record<string, unknown> {
  const binding = bindingFor(input);
  return {
    stateHandoverBindingDigest: binding.request.bindingDigest,
    runnerId: binding.request.runner.id,
    runnerLabel: binding.request.runner.label,
    backendBindingDigest: binding.request.backend.bindingDigest,
    bootstrapBindingDigest: binding.request.bootstrap.bindingDigest,
    targetState: binding.request.requirements.targetState,
    locking: binding.request.requirements.locking,
    publicExistingStateMigration: false
  };
}

export function stateHandoverPlanInputs(
  input: PhasePlanningInput | PhaseAdapterExecutionInput
): Record<string, unknown> {
  const binding = bindingFor(input);
  return {
    stateHandoverBindingDigest: binding.request.bindingDigest,
    runnerId: binding.request.runner.id,
    runnerLabel: binding.request.runner.label,
    backendBindingDigest: binding.request.backend.bindingDigest,
    bootstrapBindingDigest: binding.request.bootstrap.bindingDigest,
    mappings: binding.request.resources,
    mappingDigest: canonicalSha256(binding.request.resources),
    locking: binding.request.requirements.locking,
    backup: binding.request.requirements.backup,
    noChangePlanRequired: true,
    retentionDays: binding.request.requirements.retentionDays,
    publicExistingStateMigration: false
  };
}

function plannedOperation(
  input: PhaseAdapterExecutionInput,
  actionId: 'github.runner.backend-proof' | 'github.runner.state-handover',
  expectedInputs: Record<string, unknown>
): TransitionOperation {
  const operation = input.plan.operations.find((entry) => entry.actionId === actionId);
  if (!operation || canonicalSha256(operation.inputs) !== canonicalSha256(expectedInputs)) {
    return handoverError(
      'state-plan-stale',
      'The reviewed protected-state operation no longer matches its exact runner, backend, bootstrap, and mapping scope.'
    );
  }
  return operation;
}

function validateOperation(
  operation: ExternalOperationState,
  actionId: string,
  repository: string,
  previous: ExternalOperationState | undefined,
  expectedStatus: 'running' | 'completed'
): void {
  const match = operation.resourceId.match(
    new RegExp(`^/repos/${repository.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/actions/runs/([1-9][0-9]*)$`, 'u')
  );
  const runId = Number(match?.[1]);
  const expectedPoll = `https://api.github.com/repos/${repository}/actions/runs/${runId}`;
  if (operation.provider !== 'github' || operation.actionId !== actionId ||
    operation.status !== expectedStatus || !Number.isSafeInteger(runId) ||
    operation.operationId !== `github-actions-run:${runId}` ||
    operation.pollUrl !== expectedPoll ||
    Date.parse(operation.startedAt) > Date.parse(operation.observedAt)) {
    return handoverError(
      'state-operation',
      'Protected state progress returned an invalid or out-of-scope workflow operation handle.'
    );
  }
  if (previous && (previous.provider !== operation.provider ||
    previous.actionId !== operation.actionId ||
    previous.operationId !== operation.operationId ||
    previous.resourceId !== operation.resourceId ||
    previous.pollUrl !== operation.pollUrl ||
    previous.startedAt !== operation.startedAt)) {
    return handoverError(
      'state-operation',
      'Protected state resume changed the immutable workflow operation identity.'
    );
  }
}

function proofReadbacks(
  input: PhaseAdapterExecutionInput,
  operation: ExternalOperationState,
  backend: BackendPlanBinding,
  proof: ProtectedBackendProof | ProtectedStateHandoverProof
): readonly LiveReadbackProof[] {
  return [
    readbackProof(input, 'github', 'actions-workflow-run', operation.resourceId, {
      operationId: operation.operationId,
      workflowRunId: proof.workflowRunId,
      workflowJobId: proof.workflowJobId,
      headSha: proof.headSha,
      runnerId: proof.runnerId,
      runnerLabel: proof.runnerLabel
    }),
    readbackProof(input, 'azure', 'private-state-backend', backend.containerResourceId, {
      backendBindingDigest: proof.backendBindingDigest,
      bindingDigest: proof.bindingDigest,
      locking: proof.locking,
      targetStatePreviouslyExisted: 'targetStatePreviouslyExisted' in proof
        ? proof.targetStatePreviouslyExisted
        : proof.targetStateExists
    })
  ];
}

function validateCommonProof(
  input: PhaseAdapterExecutionInput,
  proof: ProtectedBackendProof | ProtectedStateHandoverProof,
  operation: ExternalOperationState,
  binding: ProtectedStateBinding
): void {
  const runId = Number(operation.resourceId.split('/').at(-1));
  if (proof.bindingDigest !== binding.request.bindingDigest ||
    proof.workflowRunId !== runId ||
    !Number.isSafeInteger(proof.workflowJobId) || proof.workflowJobId <= 0 ||
    !commitPattern.test(proof.headSha) ||
    proof.runnerId !== binding.request.runner.id ||
    proof.runnerLabel !== binding.request.runner.label ||
    proof.backendBindingDigest !== binding.backend.bindingDigest ||
    proof.locking !== 'azure-blob-lease') {
    return handoverError(
      'state-proof',
      'Protected state proof differs from the exact reviewed workflow, runner, or backend binding.'
    );
  }
}

async function validateBackups(
  input: PhaseAdapterExecutionInput,
  proof: ProtectedStateHandoverProof
): Promise<{
  encryptedStatePathParts: string[][];
  encryptionKeyPathParts: string[][];
}> {
  if (proof.backups.length < 1 || proof.backups.length > 8) {
    return handoverError(
      'state-backup',
      'Protected state handover requires a bounded nonempty encrypted backup inventory.'
    );
  }
  const encryptedStatePathParts: string[][] = [];
  const encryptionKeyPathParts: string[][] = [];
  const seen = new Set<string>();
  for (const [index, backup] of proof.backups.entries()) {
    if (!digestPattern.test(backup.artifactDigest)) {
      return handoverError('state-backup', 'Protected state backup digest is invalid.');
    }
    const stateParts = validateArtifactPathParts(
      [...backup.encryptedStatePathParts],
      `Protected state backup ${index}`
    );
    const keyParts = validateArtifactPathParts(
      [...backup.encryptionKeyPathParts],
      `Protected state key ${index}`
    );
    for (const parts of [stateParts, keyParts]) {
      const key = parts.join('/');
      if (seen.has(key)) {
        return handoverError(
          'state-backup',
          'Protected state backup and key paths must be distinct.'
        );
      }
      seen.add(key);
      const target = await resolveProjectPath(input.inspection.projectRoot, parts);
      const details = await stat(target);
      if (!details.isFile() || details.size < 1 || (details.mode & 0o077) !== 0) {
        return handoverError(
          'state-backup',
          'Protected state backup material must already exist as nonempty owner-only regular files.'
        );
      }
    }
    encryptedStatePathParts.push(stateParts);
    encryptionKeyPathParts.push(keyParts);
  }
  return { encryptedStatePathParts, encryptionKeyPathParts };
}

function blockedMessage(reason: string): string {
  return reason === 'capability-unavailable'
    ? 'The selected execution host has no approved protected state handover capability.'
    : 'Protected state work did not satisfy exact ownership, locking, backup, concurrency, mapping, or no-change verification; provider diagnostics were withheld.';
}

export async function executeProtectedStatePhase(
  input: PhaseAdapterExecutionInput
): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'private-backend-proof' &&
    input.phase.id !== 'remote-import-verified') {
    return null;
  }
  const port = input.adapters.protectedStateHandover;
  if (!port) {
    return {
      status: 'blocked',
      blocker: 'Protected state execution requires an explicitly registered private capability; the public CLI does not enable arbitrary existing-state migration.',
      completedOperations: []
    };
  }
  try {
    const binding = bindingFor(input);
    const actionId = input.phase.id === 'private-backend-proof'
      ? 'github.runner.backend-proof'
      : 'github.runner.state-handover';
    const operation = plannedOperation(
      input,
      actionId,
      input.phase.id === 'private-backend-proof'
        ? privateBackendProofPlanInputs(input)
        : stateHandoverPlanInputs(input)
    );
    await assertGitHubAuthorized(input, operation);
    const previousOperation = input.inspection.state.phases[input.phase.id].operation;
    const request: ProtectedStateOperationRequest = {
      ...binding.request,
      phaseId: input.phase.id,
      previousOperation: previousOperation ?? null
    };
    const result = input.phase.id === 'private-backend-proof'
      ? await port.proveBackend(request)
      : await port.handover(request);
    if (result.status === 'blocked') {
      return {
        status: 'blocked',
        resultState: 'failed',
        blocker: blockedMessage(result.reason),
        completedOperations: []
      };
    }
    if (result.status === 'pending') {
      validateOperation(
        result.operation,
        actionId,
        binding.request.repository,
        previousOperation,
        'running'
      );
      return {
        status: 'pending',
        blocker: 'Protected state workflow is still running; resume reobserves the same immutable workflow run without redispatch.',
        operation: result.operation,
        completedOperations: []
      };
    }
    validateOperation(
      result.operation,
      actionId,
      binding.request.repository,
      previousOperation,
      'completed'
    );
    validateCommonProof(input, result.proof, result.operation, binding);
    if (input.phase.id === 'private-backend-proof') {
      const proof = result.proof as ProtectedBackendProof;
      if (proof.kind !== 'private-backend-proof.v1' ||
        proof.targetStateExists !== false ||
        !digestPattern.test(proof.observationDigest)) {
        return handoverError(
          'state-proof',
          'Private backend proof must establish exact target absence and a payload-free observation digest.'
        );
      }
      return {
        status: 'completed',
        resultState: 'verified',
        operation: result.operation,
        evidencePayload: proof,
        liveReadback: proofReadbacks(input, result.operation, binding.backend, proof),
        outputs: {
          values: {
            stateHandoverBindingDigest: binding.request.bindingDigest,
            backendBindingDigest: binding.backend.bindingDigest,
            bootstrapBindingDigest: binding.bootstrap.bindingDigest,
            runnerId: binding.request.runner.id,
            runnerLabel: binding.request.runner.label,
            targetStateExists: false,
            locking: proof.locking
          },
          resources: [{
            provider: 'azure',
            resourceType: 'Microsoft.Storage/storageAccounts/blobServices/containers',
            resourceId: binding.backend.containerResourceId
          }]
        },
        completedOperations: [operation]
      };
    }
    const proof = result.proof as ProtectedStateHandoverProof;
    if (proof.kind !== 'remote-import-verified.v1' ||
      proof.targetStatePreviouslyExisted !== false ||
      proof.plan.add !== 0 || proof.plan.change !== 0 || proof.plan.destroy !== 0 ||
      !digestPattern.test(proof.mappingDigest) ||
      !digestPattern.test(proof.concurrencyDigest) ||
      !digestPattern.test(proof.remoteBackendDigest) ||
      !digestPattern.test(proof.noChangePlanDigest) ||
      proof.mappingDigest !== canonicalSha256(binding.request.resources) ||
      canonicalSha256(proof.mappings) !== canonicalSha256(binding.request.resources)) {
      return handoverError(
        'state-proof',
        'State handover proof must preserve the complete mapping, absent target, exact concurrency, and zero-change plan.'
      );
    }
    const backupPaths = await validateBackups(input, proof);
    return {
      status: 'completed',
      resultState: 'verified',
      operation: result.operation,
      evidencePayload: {
        ...proof,
        encryptedStatePathParts: backupPaths.encryptedStatePathParts,
        encryptionKeyPathParts: backupPaths.encryptionKeyPathParts,
        publicExistingStateMigration: false
      },
      liveReadback: proofReadbacks(input, result.operation, binding.backend, proof),
      outputs: {
        values: {
          stateHandoverBindingDigest: binding.request.bindingDigest,
          backendBindingDigest: binding.backend.bindingDigest,
          bootstrapBindingDigest: binding.bootstrap.bindingDigest,
          mappingDigest: proof.mappingDigest,
          concurrencyDigest: proof.concurrencyDigest,
          remoteBackendDigest: proof.remoteBackendDigest,
          noChangePlanDigest: proof.noChangePlanDigest,
          retentionDays: 30,
          publicExistingStateMigration: false
        },
        resources: binding.request.resources.map((resource) => ({
          provider: 'azure' as const,
          resourceType: resource.resourceType,
          resourceId: resource.resourceId
        }))
      },
      completedOperations: [operation]
    };
  } catch (error) {
    return {
      status: 'blocked',
      resultState: 'failed',
      blocker: safeGitHubFailure(error),
      completedOperations: []
    };
  }
}
