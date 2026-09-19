import path from 'node:path';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { normalizeApprovalCostCeiling } from '../../domain/governance/activation/approvals.js';
import type { PhasePlanningInput, PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import { azureArmBinding, azureArmUrl } from '../../adapters/azure/activation-rest.js';
import {
  applicationUuid, parseApplicationImageReference, ACR_PULL_ROLE_DEFINITION_UUID
} from '../../adapters/azure/application-provisioning.js';
import { validatePrivateStatePathTarget } from '../../adapters/azure/private-state-path.js';
import { azureStateUrl } from '../../adapters/state/azure-blob.js';
import { stateBindingDigest, validateStateContext } from '../../domain/repair/stateful-invariants.js';
import { privateStateContext, validatePrivateCustody } from './private-custody.js';
import {
  applicationPrivateAssert as must, applicationPrivateProtocol, applicationPrivateResourceTypes,
  applicationPrivateFullInventory,
  type ApplicationPrivateConfiguration, type ApplicationPrivateIntent,
  type ApplicationPrivatePhase, type ApplicationPrivateReview, type ApplicationPrivateSource,
  type ApplicationPrivateTarget
} from './application-private-contracts.js';
import { applicationPrivateAddress } from './application-private-address.js';
import { generatedResourcePaths, isGeneratedApplicationResourceType, validateGeneratedResourceTarget } from './application-generated-resource-contracts.js';
import { applicationRehearsalInputs, applicationRehearsalResourceActions } from './application-rehearsal-inputs.js';
import { configuredDisposableTarget } from './qualification-authority.js';
import { applicationFunctionReadRequests } from '../../adapters/azure/application-function-readback.js';
import {
  applicationPrivateArtifactDeployments, applicationPrivateArtifactForTarget, applicationPrivateHealthUrl,
  assertApplicationPrivateArtifactSet
} from './application-private-artifacts.js';

import {
  applicationPrivateDigest, applicationPrivateObject, applicationPrivateReference
} from './application-private-admission.js';
export {
  applicationPrivateDigest, applicationPrivateObject, applicationPrivateReference, assertApplicationPrivateArtifact
} from './application-private-admission.js';

function text(value: unknown, limit = 2048): string {
  must(typeof value === 'string' && value.length > 0 && value.length <= limit &&
    !/[\u0000-\u001f\u007f]/u.test(value), 'input-text');
  return value;
}

function iso(value: unknown): string {
  const result = text(value, 32);
  must(Number.isFinite(Date.parse(result)) && new Date(result).toISOString() === result, 'time-binding');
  return result;
}

export function applicationPrivateWindow(configuration: ApplicationPrivateConfiguration) {
  return configuration.mode === 'recover' ? configuration.recoveryWindow : configuration;
}

function window(value: { notBefore: unknown; expiresAt: unknown; releaseUntil: unknown }): void {
  const begin = Date.parse(iso(value.notBefore)), end = Date.parse(iso(value.expiresAt)), release = Date.parse(iso(value.releaseUntil));
  must(end > begin && end - begin <= 3_600_000 && release > end && release - end <= 120_000, 'time-bound');
}

const paths: Readonly<Record<ApplicationPrivateTarget['type'], readonly string[]>> = {
  ...generatedResourcePaths,
  azurerm_resource_group: ['name', 'location'],
  azurerm_container_registry: ['name', 'location', 'resource_group_name', 'sku', 'admin_enabled',
    'public_network_access_enabled', 'zone_redundancy_enabled'],
  azurerm_user_assigned_identity: ['name', 'location', 'resource_group_name'],
  azurerm_role_assignment: ['name', 'scope', 'principal_id', 'role_definition_id', 'principal_type'],
  azurerm_container_app_environment: ['name', 'location', 'resource_group_name', 'infrastructure_subnet_id',
    'internal_load_balancer_enabled', 'log_analytics_workspace_id', 'zone_redundancy_enabled'],
  azurerm_container_app: ['name', 'resource_group_name', 'container_app_environment_id', 'revision_mode',
    'identity.0.type', 'identity.0.identity_ids.0', 'template.0.min_replicas', 'template.0.max_replicas',
    'template.0.container.0.name', 'template.0.container.0.image', 'template.0.container.0.cpu', 'template.0.container.0.memory',
    'ingress.0.external_enabled', 'ingress.0.target_port', 'ingress.0.transport']
};

export function applicationPrivateTargetName(target: ApplicationPrivateTarget) {
  const match = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)(?:\/providers\/(.+))?$/u.exec(target.resourceId);
  must(match, 'target-resource-id');
  return { subscriptionId: match[1]!, resourceGroup: match[2]!, name: target.resourceId.split('/').at(-1)! };
}

function target(value: unknown, intent: ApplicationPrivateIntent, ownerId: string): ApplicationPrivateTarget {
  const item = applicationPrivateObject(value, ['address', 'type', 'resourceId', 'actions', 'expected', 'role', 'runtime']);
  const type = text(item.type);
  must(Object.hasOwn(applicationPrivateResourceTypes, type), 'unsupported-resource-type');
  if (isGeneratedApplicationResourceType(type)) {
    const selected = validateGeneratedResourceTarget(item, intent.binding.subscriptionId, ownerId);
    must(['foundation', 'foundation-dependencies', 'staging', 'staging-dependencies'].includes(intent.scope), 'prerequisite-only');
    return { ...selected, role: null, runtime: null };
  }
  const result = item as unknown as ApplicationPrivateTarget;
  const address = applicationPrivateAddress(result.address);
  must(address.type === type && address.mode === 'managed', 'target-address');
  const contract = applicationPrivateResourceTypes[result.type];
  azureArmUrl(text(result.resourceId), contract.api, intent.binding.subscriptionId);
  const name = applicationPrivateTargetName(result);
  if (result.type === 'azurerm_resource_group') {
    must(result.resourceId.split('/').length === 5, 'target-resource-id');
  } else if (result.type !== 'azurerm_role_assignment') {
    must(result.resourceId === `/subscriptions/${intent.binding.subscriptionId}/resourceGroups/${name.resourceGroup}/providers/${contract.arm}/${name.name}`,
      'target-resource-id');
  }
  must(Array.isArray(result.actions) && result.actions.length > 0 && result.actions.length <= 3 &&
    new Set(result.actions).size === result.actions.length &&
    result.actions.every((action) => ['create', 'update', 'no-op'].includes(action)), 'resource-actions');
  must(isRecord(result.expected) && Object.keys(result.expected).length > 0 && Object.keys(result.expected).length <= 40,
    'target-expectations');
  for (const [key, expected] of Object.entries(result.expected)) {
    must(paths[result.type].includes(key) || key === 'tags.liftoff-repository-id', 'target-expectations');
    must(expected === null || typeof expected === 'boolean' || typeof expected === 'number' && Number.isFinite(expected) ||
      typeof expected === 'string' && expected.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(expected), 'target-expectations');
  }
  must(result.expected.name === name.name, 'target-name');
  if (result.type !== 'azurerm_role_assignment') {
    if (result.expected['tags.liftoff-repository-id'] !== undefined) {
      must(result.expected['tags.liftoff-repository-id'] === ownerId, 'target-ownership');
    }
    if (result.type !== 'azurerm_container_app') must(result.expected.location === intent.backend.region, 'target-region');
    if (result.type !== 'azurerm_resource_group') must(result.expected.resource_group_name === name.resourceGroup, 'target-group');
  }
  if (result.type === 'azurerm_container_registry') {
    must(result.expected.admin_enabled === false && ['Basic', 'Standard', 'Premium'].includes(String(result.expected.sku)),
      'registry-contract');
  }
  if (result.type === 'azurerm_role_assignment') {
    must((intent.scope === 'prerequisites-rbac' || intent.scope === 'foundation' || intent.scope === 'staging') && result.role, 'additional-rbac-plan-required');
    const role = applicationPrivateObject(result.role, ['scope', 'roleDefinitionId', 'principalId', 'identityResourceId', 'clientId',
      ...(Object.hasOwn(result.role, 'roleDefinitionName') ? ['roleDefinitionName'] : [])]);
    applicationUuid(role.principalId, 'Exact reviewed role principal');
    applicationUuid(role.clientId, 'Exact reviewed workload client');
    applicationUuid(name.name, 'Exact reviewed role assignment name');
    const scope = text(role.scope);
    const scopeType = /\/providers\/(Microsoft\.(?:ContainerRegistry\/registries|ServiceBus\/namespaces|Storage\/storageAccounts))\/[^/]+(?:\/queues\/[^/]+)?$/u.exec(scope)?.[1];
    must(scopeType && scope.startsWith(`/subscriptions/${intent.binding.subscriptionId}/resourceGroups/`) &&
      (!scope.includes('/queues/') || scopeType === 'Microsoft.ServiceBus/namespaces') &&
      result.resourceId === `${scope}/providers/Microsoft.Authorization/roleAssignments/${name.name}`,
    'role-scope');
    const definitions = [ACR_PULL_ROLE_DEFINITION_UUID, '8311e382-0749-4cb8-b61a-304f252e45ec'];
    if (role.roleDefinitionName !== undefined) {
      const allowed = scopeType === 'Microsoft.ContainerRegistry/registries' ? ['AcrPull', 'AcrPush'] :
        scopeType === 'Microsoft.ServiceBus/namespaces' ? ['Azure Service Bus Data Sender', 'Azure Service Bus Data Receiver'] :
          ['Storage Blob Data Contributor'];
      must(typeof role.roleDefinitionName === 'string' && allowed.includes(role.roleDefinitionName) &&
        typeof role.roleDefinitionId === 'string' &&
        role.roleDefinitionId.startsWith(`/subscriptions/${intent.binding.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/`),
      'role-definition');
      applicationUuid(role.roleDefinitionId.split('/').at(-1), 'Exact role definition identity');
    } else {
      must(scopeType === 'Microsoft.ContainerRegistry/registries' &&
        definitions.some((id) => role.roleDefinitionId === `/subscriptions/${intent.binding.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${id}`),
      'role-definition');
    }
    must(new RegExp(`^/subscriptions/${intent.binding.subscriptionId}/resourceGroups/[^/]+/providers/Microsoft\\.ManagedIdentity/userAssignedIdentities/[A-Za-z0-9_-]+$`, 'u')
      .test(text(role.identityResourceId)), 'role-assignee');
    must(result.expected.scope === role.scope && result.expected.role_definition_id === role.roleDefinitionId &&
      result.expected.principal_id === role.principalId && result.expected.principal_type === 'ServicePrincipal', 'role-exact-inputs');
  } else must(result.role === null, 'role-contract');
  if (result.type === 'azurerm_container_app') {
    const artifact = applicationPrivateArtifactForTarget(intent, result);
    must(applicationPrivateFullInventory(intent.scope) && artifact && result.runtime, 'artifact-runtime-required');
    applicationPrivateHealthUrl(result.runtime, 'role' in artifact ? artifact.role : undefined);
    must(result.expected['template.0.container.0.image'] === artifact.imageRef &&
      result.expected.revision_mode === 'Single' && result.expected['identity.0.type'] === 'UserAssigned' &&
      typeof result.expected.container_app_environment_id === 'string' &&
      typeof result.expected['identity.0.identity_ids.0'] === 'string' &&
      new RegExp(`^/subscriptions/${intent.binding.subscriptionId}/resourceGroups/[^/]+/providers/Microsoft\\.ManagedIdentity/userAssignedIdentities/[A-Za-z0-9_-]+$`, 'u')
        .test(result.expected['identity.0.identity_ids.0']), 'application-runtime-contract');
    azureArmUrl(result.expected.container_app_environment_id, '2023-05-01', intent.binding.subscriptionId);
  } else must(result.runtime === null, 'runtime-contract');
  return structuredClone(result);
}

export function applicationPrivateIntent(configuration: ApplicationPrivateConfiguration): ApplicationPrivateIntent {
  const { mode: _mode, ...rest } = configuration;
  const value: Record<string, unknown> = { ...rest };
  delete value.reviewed;
  delete value.recovery;
  delete value.recoveryWindow;
  delete value.checkpoint;
  delete value.candidateRef;
  return value as unknown as ApplicationPrivateIntent;
}

export function applicationPrivateInputs(input: Pick<PhasePlanningInput, 'inspection' | 'phase'>): ApplicationPrivateConfiguration {
  if (input.phase.id === 'production-rehearsed') {
    return applicationRehearsalInputs(input).privateExecution;
  }
  must(['application-prerequisites-ready', 'application-foundation', 'staging-qualified'].includes(input.phase.id), 'phase-scope');
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  must(configuration?.budget, 'explicit-budget-required');
  normalizeApprovalCostCeiling(configuration.budget);
  const wrapper = applicationPrivateObject(configuration.phases[input.phase.id],
    input.phase.id === 'staging-qualified' ? ['privateExecution', 'disposableTarget', 'qualification'] : ['privateExecution']);
  must(isRecord(wrapper.privateExecution), 'private-input-required');
  const mode = wrapper.privateExecution.mode;
  must(mode === 'prepare' || mode === 'apply' || mode === 'recover', 'execution-mode');
  const fields = ['schemaVersion', 'scope', 'binding', 'backend', 'custody', 'writer', 'source', 'targets',
    'artifact', 'notBefore', 'expiresAt', 'releaseUntil', 'maxCommandMs', 'mode',
    ...(Object.hasOwn(wrapper.privateExecution, 'artifactSet') ? ['artifactSet'] : [])];
  applicationPrivateObject(wrapper.privateExecution, [
    ...fields, ...(mode === 'prepare' ? [] : ['reviewed']), ...(mode === 'recover' ? ['recovery', 'recoveryWindow', 'checkpoint', 'candidateRef'] : [])
  ]);
  const config = structuredClone(wrapper.privateExecution) as unknown as ApplicationPrivateConfiguration;
  const scopes = {
    'application-prerequisites-ready': ['prerequisites-core', 'prerequisites-rbac'],
    'application-foundation': ['foundation-dependencies', 'foundation'],
    'staging-qualified': ['staging-dependencies', 'staging']
  };
  must(config.schemaVersion === 1 && Object.hasOwn(scopes, input.phase.id) &&
    scopes[input.phase.id as keyof typeof scopes].includes(config.scope), 'phase-scope');
  applicationPrivateObject(config.binding, ['subscriptionId', 'tenantId', 'principalId']);
  config.binding = azureArmBinding(config.binding);
  config.backend = validatePrivateStatePathTarget(config.backend);
  config.custody = validatePrivateCustody(config.custody);
  must(canonicalSha256(config.binding) === canonicalSha256(config.backend.binding) &&
    config.backend.hostId === config.custody.tools.hostId &&
    config.backend.backend.ownerId === input.inspection.state.remoteBinding?.id &&
    config.custody.keyReference.account === config.backend.backend.ownerId, 'backend-actor-owner');
  applicationPrivateObject(config.writer, ['keychainPath', 'service', 'account', 'subscriptionId', 'tenantId', 'principalId', 'clientId']);
  must(canonicalSha256(azureArmBinding(config.writer)) === canonicalSha256(config.binding) &&
    config.writer.account === config.backend.backend.ownerId && path.isAbsolute(text(config.writer.keychainPath)) &&
    /^org\.liftoff\.azure-application-writer\.[A-Za-z0-9_.:-]{1,160}$/u.test(config.writer.service), 'writer-binding');
  applicationUuid(config.writer.clientId, 'Explicit application writer client');
  applicationPrivateObject(config.source, ['rootPathParts', 'backendPathParts', 'variablesRef', 'provider']);
  if (['foundation', 'foundation-dependencies', 'staging', 'staging-dependencies'].includes(config.scope)) {
    const environment = input.phase.id === 'staging-qualified' ? 'staging' : 'dev';
    must(Array.isArray(config.source.rootPathParts) &&
      config.source.rootPathParts.join('/') === `infrastructure/opentofu/azure/environments/${environment}` &&
      input.inspection.manifest.project.workload.kind !== 'components' &&
      input.inspection.manifest.project.workload.environments.includes(environment), 'foundation-is-not-rehearsal-authority');
  }
  applicationPrivateReference(config.source.variablesRef, config.custody.workspaceId);
  const provider = config.source.provider;
  applicationPrivateObject(provider, ['source', 'version', 'mirrorDirectory', 'binary']);
  applicationPrivateObject(provider.binary, ['path', 'sha256']);
  must(provider.source === 'registry.opentofu.org/hashicorp/azurerm' && /^[45]\.\d+\.\d+$/u.test(provider.version) &&
    path.isAbsolute(text(provider.mirrorDirectory)) && path.isAbsolute(text(provider.binary.path)) &&
    !path.relative(provider.mirrorDirectory, provider.binary.path).startsWith('..') &&
    path.relative(provider.mirrorDirectory, provider.binary.path) !== '', 'provider-pin');
  applicationPrivateDigest(provider.binary.sha256);
  window(config);
  must(Number.isSafeInteger(config.maxCommandMs) && config.maxCommandMs >= 1_000 && config.maxCommandMs <= 300_000,
    'command-bound');
  if (config.artifact !== null) {
    applicationPrivateObject(config.artifact, ['evidenceId', 'headerDigest', 'imageRef', 'sourceSha', 'registryResourceId',
      ...(Object.hasOwn(config.artifact, 'sourceRegistryResourceId') ? ['sourceRegistryResourceId'] : [])]);
    text(config.artifact.evidenceId, 256);
    applicationPrivateDigest(config.artifact.headerDigest);
    parseApplicationImageReference(config.artifact.imageRef);
    must(/^[a-f0-9]{40,64}$/u.test(config.artifact.sourceSha), 'artifact-source');
    azureArmUrl(config.artifact.registryResourceId, '2023-07-01', config.binding.subscriptionId);
    if (config.artifact.sourceRegistryResourceId !== undefined) {
      azureArmUrl(config.artifact.sourceRegistryResourceId, '2023-07-01', config.binding.subscriptionId);
      must(['staging', 'rehearsal-rollout', 'rehearsal-rollback'].includes(config.scope) &&
        config.artifact.sourceRegistryResourceId !== config.artifact.registryResourceId, 'artifact-mirror-scope');
    }
  }
  if (Object.hasOwn(config, 'artifactSet')) must(isRecord(config.artifactSet) && config.artifact === null, 'artifact-set-stage');
  must(applicationPrivateFullInventory(config.scope) ? config.artifact !== null || config.artifactSet !== undefined :
    config.artifact === null && config.artifactSet === undefined, 'artifact-stage');
  must(Array.isArray(config.targets) && config.targets.length > 0 && config.targets.length <= 32, 'target-bound');
  config.targets = config.targets.map((item) => target(item, config, config.backend.backend.ownerId));
  must(new Set(config.targets.map((item) => item.address)).size === config.targets.length &&
    new Set(config.targets.map((item) => item.resourceId.toLowerCase())).size === config.targets.length, 'duplicate-target');
  assertApplicationPrivateArtifactSet(config, input.inspection.manifest);
  if (config.scope === 'prerequisites-core' || config.scope === 'prerequisites-rbac') must(config.targets.every((item) =>
    ['azurerm_resource_group', 'azurerm_container_registry', 'azurerm_user_assigned_identity', 'azurerm_role_assignment'].includes(item.type)),
  'prerequisite-only');
  if (config.scope === 'prerequisites-core') must(config.targets.some((item) => item.type === 'azurerm_container_registry') &&
    config.targets.some((item) => item.type === 'azurerm_user_assigned_identity'), 'prerequisite-core-inventory');
  if (config.scope === 'prerequisites-rbac') must(config.targets.some((item) => item.type === 'azurerm_role_assignment'),
    'additional-rbac-plan-required');
  if (applicationPrivateFullInventory(config.scope)) must(config.targets.some((item) => item.type === 'azurerm_container_app'), 'application-inventory');
  if (config.scope === 'foundation-dependencies' || config.scope === 'staging-dependencies') must(config.targets.every((item) =>
    !['azurerm_container_app', 'azurerm_linux_function_app', 'azurerm_role_assignment'].includes(item.type)), 'foundation-dependency-scope');
  if (config.mode === 'recover') {
    applicationPrivateObject(config.recoveryWindow, ['notBefore', 'expiresAt', 'releaseUntil']);
    window(config.recoveryWindow);
    must(['inspect', 'publish-retained', 'close-unapplied'].includes(config.recovery), 'recovery-mode');
    applicationPrivateObject(config.checkpoint, ['transactionId', 'journalRef']);
    applicationUuid(config.checkpoint.transactionId, 'Original private application transaction');
    applicationPrivateReference(config.checkpoint.journalRef, config.custody.workspaceId);
    if (config.candidateRef !== null) applicationPrivateReference(config.candidateRef, config.custody.workspaceId);
    if (config.recovery === 'publish-retained') must(config.candidateRef !== null, 'reviewed-candidate-required');
  }
  return config;
}

export function applicationPrivateIntentDigest(input: Pick<PhasePlanningInput, 'inspection'>, config: ApplicationPrivateConfiguration): string {
  return canonicalSha256({
    protocol: applicationPrivateProtocol, intent: applicationPrivateIntent(config),
    budget: (input.inspection.activationInputs ?? input.inspection.state.activationInputs)?.budget
  });
}

export function applicationPrivateContext(input: PhasePlanningInput, config: ApplicationPrivateConfiguration) {
  const context = privateStateContext(input, config.binding, config.custody.tools.hostId, config.backend.backend.ownerId);
  context.configurationDigest = applicationPrivateIntentDigest(input, config);
  context.artifactDigest = canonicalSha256({
    manifest: input.inspection.manifest, artifact: config.artifact,
    ...(config.artifactSet ? { artifactSet: config.artifactSet } : {})
  });
  validateStateContext(context);
  return context;
}

export function assertApplicationPrivateReview(
  input: PhasePlanningInput, config: ApplicationPrivateConfiguration, source: ApplicationPrivateSource
): ApplicationPrivateReview | null {
  if (config.mode === 'prepare') return null;
  const review = config.reviewed;
  if (review === null) {
    must(config.mode === 'recover' && config.recovery !== 'publish-retained', 'original-reviewed-plan-required');
    return null;
  }
  applicationPrivateObject(review, ['schemaVersion', 'protocol', 'transactionId', 'journalRef', 'planRef', 'phaseId', 'intentDigest',
    'sourceDigest', 'backendBindingDigest', 'binding', 'artifact', 'tools', 'changes', 'expiresAt',
    ...(config.artifactSet ? ['artifactSet'] : [])]);
  applicationUuid(review.transactionId, 'Private application transaction');
  applicationPrivateReference(review.journalRef, config.custody.workspaceId);
  applicationPrivateReference(review.planRef, config.custody.workspaceId);
  must(review.schemaVersion === 1 && review.protocol === applicationPrivateProtocol && review.phaseId === input.phase.id &&
    review.intentDigest === applicationPrivateIntentDigest(input, config) &&
    (review.sourceDigest === source.digest || config.mode === 'recover' && config.recovery !== 'publish-retained') &&
    review.backendBindingDigest === stateBindingDigest(config.backend.backend) &&
    canonicalSha256(review.binding) === canonicalSha256(config.binding) &&
    canonicalSha256(review.artifact) === canonicalSha256(config.artifact) &&
    canonicalSha256(review.artifactSet ?? null) === canonicalSha256(config.artifactSet ?? null) &&
    canonicalSha256(review.tools) === canonicalSha256({
      tofu: config.custody.tools.tofu.sha256, python: config.custody.tools.python.sha256,
      provider: config.source.provider.binary.sha256, providerVersion: config.source.provider.version,
      hostId: config.custody.tools.hostId
    }) && review.expiresAt === config.expiresAt, 'review-binding');
  must(Array.isArray(review.changes) && review.changes.length === config.targets.length, 'review-effects');
  for (const change of review.changes) {
    applicationPrivateObject(change, ['address', 'type', 'action', 'targetResourceId', 'changedAttributes', 'computedOutputs']);
    const selected = config.targets.find((item) => item.address === change.address);
    must(selected && selected.type === change.type && selected.resourceId === change.targetResourceId &&
      selected.actions.includes(change.action) && Array.isArray(change.changedAttributes) && Array.isArray(change.computedOutputs) &&
      [...change.changedAttributes, ...change.computedOutputs].every((key) =>
        typeof key === 'string' && /^[a-z][a-z0-9_]{0,100}$/u.test(key)), 'review-effects');
  }
  must(new Set(review.changes.map((item) => item.address)).size === review.changes.length, 'review-effects');
  if (config.mode === 'recover') must(review.transactionId === config.checkpoint.transactionId &&
    review.journalRef === config.checkpoint.journalRef, 'recovery-original-checkpoint');
  return review;
}

export function applicationPrivateOperation(
  input: PhasePlanningInput | PhaseAdapterExecutionInput, config: ApplicationPrivateConfiguration, source: ApplicationPrivateSource,
  target = config.targets[0]!
): TransitionOperation {
  const phaseId = input.phase.id as ApplicationPrivatePhase;
  const destination = {
    type: 'subscription' as const, identity: target.resourceId,
    subscriptionId: config.binding.subscriptionId
  };
  const artifact = config.artifactSet ? applicationPrivateArtifactForTarget(config, target) : null;
  return {
    phaseId, adapter: 'azure-opentofu',
    actionId: phaseId === 'production-rehearsed'
      ? applicationRehearsalResourceActions[config.scope === 'rehearsal-rollout' ? 'rollout' : 'rollback']
      : phaseId === 'staging-qualified' ? 'azure.application-staging.apply'
        : phaseId === 'application-foundation' ? 'azure.application-foundation.apply' : 'azure.prerequisites.apply',
    mutationClass: 'azure-resource-provision', remote: true, destructive: false, destination,
    inputs: {
      protocol: applicationPrivateProtocol, resourceSourceDigest: source.digest,
      intentDigest: applicationPrivateIntentDigest(input, config),
      resourceEffect: { address: target.address, type: target.type, targetResourceId: target.resourceId,
        action: config.mode === 'apply' ? config.reviewed.changes.find((change) => change.address === target.address)!.action : 'none',
        ...(artifact ? { artifact } : {}) },
      ...(config.artifactSet ? { artifactSet: config.artifactSet } : {})
    },
    effects: [
      { mutationClass: 'azure-read', destination, remote: true, destructive: false }
    ]
  };
}

export function applicationPrivateControlOperation(
  input: PhasePlanningInput | PhaseAdapterExecutionInput, config: ApplicationPrivateConfiguration, source: ApplicationPrivateSource
): TransitionOperation {
  const destination = {
    type: 'subscription' as const, identity: azureStateUrl(config.backend.backend, 'blob'),
    subscriptionId: config.binding.subscriptionId
  };
  const reads = applicationPrivateReadResourceIds(config);
  return {
    phaseId: input.phase.id, adapter: 'azure-opentofu',
    actionId: config.mode === 'prepare' ? 'azure.application-private.prepare' :
      config.mode === 'recover' ? 'azure.application-private.recover' : 'azure.application-private.state',
    mutationClass: 'backend-state-write', remote: true, destructive: false, destination,
    inputs: {
      applicationPrivate: config, resourceSourceDigest: source.digest, protocol: applicationPrivateProtocol,
      privateConfigurationReads: config.targets.filter((target) => target.type === 'azurerm_linux_function_app')
        .flatMap((target) => applicationFunctionReadRequests(target.resourceId).map(({ responseId: _responseId, ...request }) => request)),
      ...(input.phase.id === 'staging-qualified' ? { disposableTarget: configuredDisposableTarget(input, 'staging') } : {}),
      nativeExecution: 'fixed-private-opentofu-only',
      backendProtocol: 'existing-blob-lease-local-native-state-conditional-publication',
      stateLeaseActions: ['acquire', 'renew', 'release'],
      statePublication: config.mode === 'prepare' || config.mode === 'recover' && config.recovery !== 'publish-retained'
        ? 'forbidden' : 'exact-retained-candidate',
      resourceMutation: config.mode === 'apply' ? 'exact-saved-plan-once' : 'forbidden',
      intentDigest: applicationPrivateIntentDigest(input, config)
    },
    effects: [
      { mutationClass: 'backend-state-read', destination, remote: true, destructive: false },
      { mutationClass: 'write-local-state', destination: { type: 'external', identity: `state-workspace:${config.custody.workspaceId}` },
        remote: false, destructive: false },
      ...reads.map((identity) => ({
        mutationClass: 'azure-read' as const, destination: { ...destination, identity }, remote: true, destructive: false
      }))
    ]
  };
}

export function applicationPrivateReadResourceIds(config: ApplicationPrivateIntent): readonly string[] {
  const reads = new Set(config.targets.map((target) => target.resourceId));
  for (const target of config.targets) {
    reads.add(`/subscriptions/${config.binding.subscriptionId}/providers/${applicationPrivateResourceTypes[target.type].arm.split('/')[0]}`);
    if (target.role) {
      reads.add(target.role.scope);
      reads.add(target.role.identityResourceId);
      if (target.role.roleDefinitionName) reads.add(target.role.roleDefinitionId);
    }
    for (const field of ['container_app_environment_id', 'identity.0.identity_ids.0', 'log_analytics_workspace_id',
      'storage_account_id', 'server_id', 'namespace_id', 'service_plan_id']) {
      if (typeof target.expected[field] === 'string') reads.add(target.expected[field]);
    }
    if (['azurerm_postgresql_flexible_server_firewall_rule', 'azurerm_servicebus_queue'].includes(target.type)) {
      reads.add(target.resourceId.split('/').slice(0, -2).join('/'));
    }
    if (target.type === 'azurerm_storage_container') reads.add(target.resourceId.split('/').slice(0, -4).join('/'));
    if (target.type === 'azurerm_linux_function_app') {
      for (const request of applicationFunctionReadRequests(target.resourceId)) reads.add(request.resourceId);
    }
  }
  for (const artifact of applicationPrivateArtifactDeployments(config)) {
    reads.add(artifact.registryResourceId);
    if (artifact.sourceRegistryResourceId !== undefined && config.artifactSet) reads.add(artifact.sourceRegistryResourceId);
  }
  reads.add(`/subscriptions/${config.binding.subscriptionId}/resourceGroups/${config.backend.backend.resourceGroup}` +
    `/providers/Microsoft.Storage/storageAccounts/${config.backend.backend.account}`);
  for (const resourceId of [
    config.backend.privateEndpointId, config.backend.virtualNetworkId, config.backend.subnetId,
    config.backend.privateDnsZoneId, config.backend.privateDnsLinkId, config.backend.privateDnsZoneGroupId
  ]) reads.add(resourceId);
  return [...reads].sort();
}

/** Dispatch the component once for this combined inventory, never once per operation. */
export function applicationPrivateOperations(
  input: PhasePlanningInput | PhaseAdapterExecutionInput, config: ApplicationPrivateConfiguration, source: ApplicationPrivateSource
): readonly TransitionOperation[] {
  return [
    applicationPrivateControlOperation(input, config, source),
    ...(config.mode === 'apply' ? config.targets.map((target) => applicationPrivateOperation(input, config, source, target)) : [])
  ];
}
