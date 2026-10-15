import { createHash } from 'node:crypto';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import type {
  ExternalOperationState, LiveReadbackProof, PhaseOutputBindings, TransitionOperation
} from '../domain/governance/activation/types.js';
import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput
} from './transition-ports.js';
import {
  applicationBudget, applicationConfiguration, applicationDispatchPlan, applicationEnvironment,
  applicationDeadlineInput, applicationError, assertApplicationAuthority, assertApplicationProgressPorts,
  isApplicationProviderError, observeApplicationProtection
} from './application-readiness.js';
import { azureBackendConfiguration } from './azure-backend-readiness.js';
import { azureObject, runAzureJson } from './azure-discovery.js';
import { azurePermits, observeAzureEffectivePermissions } from './azure-permissions.js';
import { applicationReadbackProof as readbackProof } from './application-readiness.js';
import { verifiedOutput } from './github-config.js';
import { inspectAzureDeploymentOwnership } from './azure-deployment-ownership.js';
import { protectedStateCustodyIdentityDigest } from './protected-state-custody.js';

const deploymentApi = '2022-09-01';
const registryApi = '2023-07-01';
const identityApi = '2023-01-31';
const roleApi = '2022-04-01';
const pullRole = '7f951dda-4ed3-4680-a7ca-43fe172d538d';
const pushRole = '8311e382-0749-4cb8-b61a-304f252e45ec';
const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const requiredActions = [
  'Microsoft.Resources/deployments/read', 'Microsoft.Resources/deployments/write',
  'Microsoft.Resources/deployments/validate/action',
  'Microsoft.Resources/subscriptions/resourceGroups/read',
  'Microsoft.ContainerRegistry/registries/read', 'Microsoft.ContainerRegistry/registries/write',
  'Microsoft.ManagedIdentity/userAssignedIdentities/read', 'Microsoft.ManagedIdentity/userAssignedIdentities/write',
  'Microsoft.Authorization/roleAssignments/read', 'Microsoft.Authorization/roleAssignments/write'
] as const;

function roleId(seed: string): string {
  const bytes = createHash('sha256').update(`liftoff-application-role-v1:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function applicationPrerequisiteBinding(input: PhasePlanningInput | PhaseAdapterExecutionInput) {
  const config = applicationConfiguration(input, 'application-prerequisites-ready', [
    'environment', 'registrySku', 'assignRegistryRoles'
  ]);
  if (config.registrySku !== 'Basic' || config.assignRegistryRoles !== true) {
    return applicationError('application-prerequisite-scope',
      'This producer requires explicit Basic registry and exact registry-scoped AcrPull/AcrPush approval; it does not infer RBAC authority or create broader roles.');
  }
  const environment = applicationEnvironment(input, config.environment);
  const backend = azureBackendConfiguration(input, 'bootstrap-local');
  const principalId = verifiedOutput(input.inspection, 'phase-0-complete', 'principalObjectId');
  const principalAppId = verifiedOutput(input.inspection, 'phase-0-complete', 'principalAppId');
  if (typeof principalId !== 'string' || !guid.test(principalId) ||
    typeof principalAppId !== 'string' || !guid.test(principalAppId) ||
    verifiedOutput(input.inspection, 'phase-0-complete', 'principalType') !== 'service-principal' ||
    principalId !== backend.principalId) {
    return applicationError('application-identity',
      'Application publication requires the same verified tenant service principal with existing OIDC access; user/default-account or newly invented build identities are not supported.');
  }
  const groupId = `/subscriptions/${backend.subscriptionId}/resourceGroups/${environment.resources.resourceGroup}`;
  const registryId = `${groupId}/providers/Microsoft.ContainerRegistry/registries/${environment.resources.containerRegistry}`;
  const identityId = `${groupId}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${environment.resources.identity}`;
  const deploymentName = `liftoff-${environment.resourceSuffix}-${environment.environment}-application`;
  const deploymentId = `/subscriptions/${backend.subscriptionId}/providers/Microsoft.Resources/deployments/${deploymentName}`;
  const roles = [
    { id: `${registryId}/providers/Microsoft.Authorization/roleAssignments/${roleId(`${registryId}:pull`)}`,
      name: roleId(`${registryId}:pull`), roleDefinitionId: `/subscriptions/${backend.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${pullRole}`,
      principal: 'workload-identity' as const },
    { id: `${registryId}/providers/Microsoft.Authorization/roleAssignments/${roleId(`${registryId}:${principalId}:push`)}`,
      name: roleId(`${registryId}:${principalId}:push`), roleDefinitionId: `/subscriptions/${backend.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${pushRole}`,
      principal: principalId }
  ];
  const binding = {
    environment: environment.environment, subscriptionId: backend.subscriptionId, tenantId: backend.tenantId,
    region: (input.inspection.activationInputs ?? input.inspection.state.activationInputs)!.azure!.region,
    resourceGroup: environment.resources.resourceGroup,
    groupId, registryName: environment.resources.containerRegistry, registryId,
    identityName: environment.resources.identity, identityId, deploymentName, deploymentId,
    principalId, principalAppId, registrySku: 'Basic' as const, adminUserEnabled: false,
    roles, budget: applicationBudget(input), backendBindingDigest: backend.bindingDigest
  };
  return { ...binding, bindingDigest: canonicalSha256(binding) };
}

export function applicationPrerequisitePlanInputs(input: PhasePlanningInput | PhaseAdapterExecutionInput) {
  return { ...applicationPrerequisiteBinding(input), adoptsExistingResources: false, deployment: false };
}

export type ApplicationPrerequisiteBinding = ReturnType<typeof applicationPrerequisiteBinding>;

function template(binding: ReturnType<typeof applicationPrerequisiteBinding>) {
  const registry = {
    type: 'Microsoft.ContainerRegistry/registries', apiVersion: registryApi,
    name: binding.registryName, location: binding.region, sku: { name: binding.registrySku },
    tags: { 'liftoff-binding': binding.bindingDigest, 'liftoff-environment': binding.environment },
    properties: { adminUserEnabled: false }
  };
  const identity = {
    type: 'Microsoft.ManagedIdentity/userAssignedIdentities', apiVersion: identityApi,
    name: binding.identityName, location: binding.region,
    tags: registry.tags
  };
  return {
    $schema: 'https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#',
    contentVersion: '1.0.0.0',
    resources: [{
      type: 'Microsoft.Resources/deployments', apiVersion: deploymentApi,
      name: `${binding.deploymentName}-resources`, resourceGroup: binding.resourceGroup,
      properties: {
        mode: 'Incremental', expressionEvaluationOptions: { scope: 'inner' },
        template: {
          $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
          contentVersion: '1.0.0.0',
          resources: [
            registry, identity,
            ...binding.roles.map((role) => ({
              type: 'Microsoft.Authorization/roleAssignments', apiVersion: roleApi,
              name: role.name,
              scope: `[concat('Microsoft.ContainerRegistry/registries/', '${binding.registryName}')]`,
              dependsOn: [binding.registryId, binding.identityId],
              properties: {
                roleDefinitionId: role.roleDefinitionId, principalType: 'ServicePrincipal',
                principalId: role.principal === 'workload-identity'
                  ? `[reference('${binding.identityId}', '${identityApi}').principalId]` : role.principal
              }
            }))
          ]
        }
      }
    }]
  };
}

function resourceBindings(binding: ReturnType<typeof applicationPrerequisiteBinding>) {
  return [
    { resourceType: 'Microsoft.Resources/deployments', resourceId: binding.deploymentId },
    { resourceType: 'Microsoft.Resources/deployments', resourceId: `${binding.groupId}/providers/Microsoft.Resources/deployments/${binding.deploymentName}-resources` },
    { resourceType: 'Microsoft.Resources/resourceGroups', resourceId: binding.groupId },
    { resourceType: 'Microsoft.ContainerRegistry/registries', resourceId: binding.registryId },
    { resourceType: 'Microsoft.ManagedIdentity/userAssignedIdentities', resourceId: binding.identityId },
    ...binding.roles.map((role) => ({ resourceType: 'Microsoft.Authorization/roleAssignments', resourceId: role.id }))
  ];
}

export async function observeApplicationPrerequisites(input: PhaseAdapterExecutionInput) {
  input = applicationDeadlineInput(input);
  const binding = applicationPrerequisiteBinding(input);
  const registry = azureObject(await runAzureJson(input, [
    'acr', 'show', '--subscription', binding.subscriptionId, '--ids', binding.registryId,
    '--query', '{id:id,name:name,location:location,loginServer:loginServer,sku:sku.name,adminUserEnabled:adminUserEnabled,provisioningState:provisioningState,tags:tags}'
  ], 'Application registry readback'), 'Application registry');
  const identity = azureObject(await runAzureJson(input, [
    'identity', 'show', '--subscription', binding.subscriptionId, '--ids', binding.identityId,
    '--query', '{id:id,name:name,location:location,tenantId:tenantId,principalId:principalId,clientId:clientId,tags:tags}'
  ], 'Application workload identity readback'), 'Application workload identity');
  if (registry.id !== binding.registryId || registry.name !== binding.registryName ||
    registry.location !== binding.region || registry.sku !== 'Basic' || registry.adminUserEnabled !== false ||
    registry.provisioningState !== 'Succeeded' || !isRecord(registry.tags) ||
    registry.tags['liftoff-binding'] !== binding.bindingDigest ||
    typeof registry.loginServer !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)?\.azurecr\.io$/u.test(registry.loginServer) ||
    identity.id !== binding.identityId || identity.name !== binding.identityName ||
    identity.location !== binding.region || identity.tenantId !== binding.tenantId ||
    typeof identity.principalId !== 'string' || !guid.test(identity.principalId) ||
    typeof identity.clientId !== 'string' || !guid.test(identity.clientId) ||
    !isRecord(identity.tags) || identity.tags['liftoff-binding'] !== binding.bindingDigest) {
    return applicationError('application-prerequisite-readback', 'Registry or workload identity differs from the exact approved owned prerequisite.');
  }
  const roles = [];
  for (const role of binding.roles) {
    const observed = azureObject(await runAzureJson(input, [
      'rest', '--method', 'GET',
      '--url', `https://management.azure.com${role.id}?api-version=${roleApi}`,
      '--resource', 'https://management.core.windows.net/',
      '--query', '{id:id,properties:properties}'
    ], 'Exact registry role readback'), 'Registry role');
    const properties = azureObject(observed.properties, 'Registry role properties');
    if (observed.id !== role.id || properties.scope !== binding.registryId ||
      properties.roleDefinitionId !== role.roleDefinitionId ||
      properties.principalId !== (role.principal === 'workload-identity' ? identity.principalId : binding.principalId) ||
      properties.principalType !== 'ServicePrincipal') {
      return applicationError('application-role-readback', 'The exact registry-scoped role or principal differs; broader/inherited access cannot replace the approved assignment.');
    }
    roles.push({ id: role.id, properties: {
      scope: properties.scope, principalId: properties.principalId,
      principalType: properties.principalType, roleDefinitionId: properties.roleDefinitionId
    } });
  }
  return { binding, registry: {
    id: registry.id, name: registry.name, location: registry.location, loginServer: registry.loginServer,
    sku: registry.sku, adminUserEnabled: registry.adminUserEnabled, provisioningState: registry.provisioningState,
    tags: { 'liftoff-binding': binding.bindingDigest, 'liftoff-environment': binding.environment }
  }, identity: {
    id: identity.id, name: identity.name, location: identity.location, tenantId: identity.tenantId,
    principalId: identity.principalId, clientId: identity.clientId,
    tags: { 'liftoff-binding': binding.bindingDigest, 'liftoff-environment': binding.environment }
  }, roles };
}

function outputs(
  binding: ReturnType<typeof applicationPrerequisiteBinding>,
  values: PhaseOutputBindings['values'] = {},
  verifiedResources = false
): PhaseOutputBindings {
  return {
    values: { prerequisiteBindingDigest: binding.bindingDigest, environment: binding.environment,
      registryResourceId: binding.registryId, workloadIdentityResourceId: binding.identityId, ...values },
    resources: (verifiedResources ? resourceBindings(binding) : [
      { resourceType: 'Microsoft.Resources/deployments', resourceId: binding.deploymentId }
    ]).map((resource) => ({ provider: 'azure', ...resource }))
  };
}

export async function executeApplicationPrerequisites(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  input = applicationDeadlineInput(input);
  const completedOperations: TransitionOperation[] = [];
  let handle: ExternalOperationState | undefined;
  let output: PhaseOutputBindings | undefined;
  let currentReadback: LiveReadbackProof[] = [];
  let dispatchAttempted = false;
  try {
    assertApplicationProgressPorts(input);
    const binding = applicationPrerequisiteBinding(input);
    const previous = input.inspection.state.phases[input.phase.id].operation;
    applicationDispatchPlan(input);
    if (input.applicationObservationOnly && !previous) {
      return applicationError('application-operation', 'Observation-only prerequisite recovery requires its recorded provider handle.');
    }
    const apply = input.plan.operations.find((entry) => entry.actionId === 'azure.prerequisites.apply');
    const verify = input.plan.operations.find((entry) => entry.actionId === 'azure.prerequisites.verify');
    if (!apply || !verify ||
      canonicalSha256(apply.inputs) !== canonicalSha256(applicationPrerequisitePlanInputs(input)) ||
      canonicalSha256(verify.inputs) !== canonicalSha256({ prerequisiteBindingDigest: binding.bindingDigest })) {
      return applicationError('application-plan-stale', 'The reviewed prerequisite operations no longer match exact resources, roles, identity or cost.');
    }
    await assertApplicationAuthority(input, apply);
    const protection = await observeApplicationProtection(input);
    if (protection.identity.cloud.name !== 'AzureCloud') {
      return applicationError('application-cloud-unsupported', 'Application registry production adapters currently qualify only the AzureCloud endpoint family.');
    }
    const permissions = await observeAzureEffectivePermissions(input, {
      subscriptionId: binding.subscriptionId, ...protection.identity.cloud
    }, 'Application prerequisite permissions');
    if (requiredActions.some((action) => !azurePermits(permissions, action))) {
      return applicationError('application-permission', 'Exact application registry, identity or scoped role permission is missing; no role/account/provider broadening was attempted.');
    }
    for (const namespace of ['Microsoft.ContainerRegistry', 'Microsoft.ManagedIdentity']) {
      const observed = azureObject(await runAzureJson(input, [
        'provider', 'show', '--subscription', binding.subscriptionId, '--namespace', namespace,
        '--query', '{id:id,namespace:namespace,registrationState:registrationState}'
      ], 'Application provider readiness'), 'Application provider');
      if (observed.registrationState !== 'Registered' || observed.namespace !== namespace ||
        observed.id !== `/subscriptions/${binding.subscriptionId}/providers/${namespace}`) {
        return applicationError('application-provider', 'An exact application provider is not Registered; registration requires its separate approved readiness phase.');
      }
    }
    const ownership = await inspectAzureDeploymentOwnership(input);
    if (!ownership || ownership.blocker && !previous) return applicationError('application-ownership', ownership?.blocker ?? 'Application ownership classification is missing.');
    // The backend bootstrap owns this group. This producer never creates/replaces a group.
    if (!previous && !ownership.payload?.environments.some((entry) =>
      entry.environment === binding.environment && entry.status === 'same-operation-owned' &&
      entry.resourceGroupId === binding.groupId)) {
      return applicationError('application-group-unready', 'Application prerequisites require the exact resource group already owned by the recorded protected bootstrap.');
    }
    const url = `https://management.azure.com${binding.deploymentId}?api-version=${deploymentApi}`;
    const body = { location: binding.region, properties: { mode: 'Incremental', template: template(binding) } };
    output = outputs(binding);
    if (!previous) {
      if (input.inspection.state.phases[input.phase.id].executionPlanDigest) {
        return applicationError('application-dispatch-uncertain', 'A prior prerequisite dispatch has no confirmed provider handle; inspect exact partial effects under recovery rather than repeat creation.');
      }
      const deployments = await runAzureJson(input, [
        'deployment', 'sub', 'list', '--subscription', binding.subscriptionId,
        '--query', `[?name=='${binding.deploymentName}'].{id:id}`
      ], 'Application deployment collision inspection');
      const resources = await runAzureJson(input, [
        'resource', 'list', '--subscription', binding.subscriptionId, '--resource-group', binding.resourceGroup,
        '--query', '[].{id:id}'
      ], 'Application prerequisite collision inspection');
      if (!Array.isArray(deployments) || deployments.length ||
        !Array.isArray(resources) || resources.length > 500 ||
        resources.some((entry) => !isRecord(entry) || typeof entry.id !== 'string' ||
          resourceBindings(binding).filter((resource) => resource.resourceId !== binding.groupId)
            .some((resource) => resource.resourceId.toLowerCase() === String(entry.id).toLowerCase()))) {
        return applicationError('application-collision', 'An exact prerequisite/deployment destination is occupied or unobservable without this operation ownership; no adoption or overwrite is allowed.');
      }
      const validation = azureObject(await runAzureJson(input, [
        'rest', '--method', 'POST', '--url', url.replace('?', '/validate?'),
        '--resource', protection.identity.cloud.resourceManagerAudience, '--body', JSON.stringify(body)
      ], 'Application prerequisite deployment validation'), 'Application validation');
      if (validation.error || !isRecord(validation.properties) || validation.properties.provisioningState !== 'Succeeded') {
        return applicationError('application-validation-unready',
          'The exact prerequisite deployment has not independently completed validation; failed, pending or unknown validation cannot authorize creation.');
      }
      await assertApplicationAuthority(input, apply);
      await observeApplicationProtection(input);
      const freshOwnership = await inspectAzureDeploymentOwnership(input);
      if (freshOwnership?.blocker) return applicationError('application-ownership', freshOwnership.blocker);
      await input.recordApplicationDispatchIntent?.(apply);
      await assertApplicationAuthority(input, apply);
      dispatchAttempted = true;
      const accepted = azureObject(await runAzureJson(input, [
        'rest', '--method', 'PUT', '--url', url,
        '--resource', protection.identity.cloud.resourceManagerAudience, '--headers', 'If-None-Match=*',
        '--body', JSON.stringify(body)
      ], 'Application prerequisite dispatch'), 'Application deployment dispatch');
      if (accepted.id !== binding.deploymentId) {
        return applicationError('application-operation', 'Application dispatch returned an out-of-scope provider identity; acceptance is uncertain and must not be retried.');
      }
      const observedAt = (input.clock?.() ?? input.now).toISOString();
      handle = {
        provider: 'azure', actionId: apply.actionId, operationId: `azure-deployment:${binding.deploymentId.toLowerCase()}`,
        resourceId: binding.deploymentId, startedAt: observedAt, observedAt, status: 'running', pollUrl: url
      };
      currentReadback = [readbackProof(input, 'azure', 'Microsoft.Resources/deployments', binding.deploymentId, {
        id: accepted.id, dispatchAccepted: true
      })];
      await input.recordApplicationProgress?.({ operation: handle, outputs: output, liveReadback: currentReadback });
    } else {
      if (previous.provider !== 'azure' || previous.actionId !== apply.actionId ||
        previous.resourceId !== binding.deploymentId || previous.pollUrl !== url ||
        previous.operationId !== `azure-deployment:${binding.deploymentId.toLowerCase()}`) {
        return applicationError('application-operation', 'Application resume does not match the exact confirmed provider handle.');
      }
      handle = { ...previous, observedAt: (input.clock?.() ?? input.now).toISOString() };
    }
    const observed = azureObject(await runAzureJson(input, [
      'rest', '--method', 'GET', '--url', url, '--resource', protection.identity.cloud.resourceManagerAudience,
      '--query', '{id:id,name:name,properties:{provisioningState:properties.provisioningState}}'
    ], 'Application deployment current readback'), 'Application deployment');
    if (observed.id !== binding.deploymentId || observed.name !== binding.deploymentName) {
      return applicationError('application-operation', 'Application deployment readback changed the exact provider identity.');
    }
    const state = azureObject(observed.properties, 'Application deployment properties').provisioningState;
    const liveReadback = [readbackProof(input, 'azure', 'Microsoft.Resources/deployments', binding.deploymentId, observed)];
    currentReadback = liveReadback;
    if (['Accepted', 'Running', 'Creating', 'Ready'].includes(String(state))) {
      if (handle.status !== 'running') {
        return applicationError('application-operation-regressed',
          'A recorded terminal prerequisite deployment now has contradictory nonterminal readback; preserve its handle and observe recovery without redispatch.');
      }
      return { status: 'pending', operation: handle, outputs: output, liveReadback, completedOperations,
        blocker: 'Application prerequisite deployment is pending; retry observes this exact deployment without redispatch.' };
    }
    if (state === 'Failed' || state === 'Canceled') {
      handle = { ...handle, status: 'failed' };
      await input.recordApplicationProgress?.({ operation: handle, outputs: output, liveReadback });
      return { status: 'blocked', operation: handle, outputs: output, liveReadback,
        resultState: 'failed', completedOperations,
        blocker: 'Application prerequisites reached terminal failure; retain owned partial effects for separately approved recovery.' };
    }
    if (state !== 'Succeeded') {
      return applicationError('application-operation-status', 'Application deployment returned an unsupported provider status; no completion or failure was inferred.');
    }
    handle = { ...handle, status: 'completed' };
    await input.recordApplicationProgress?.({ operation: handle, outputs: output, liveReadback });
    // Acceptance, names and tags are not ownership. Independently export the actual deployed recipe.
    const exported = await runAzureJson(input, [
      'deployment', 'sub', 'export', '--subscription', binding.subscriptionId, '--name', binding.deploymentName
    ], 'Application deployed recipe readback');
    if (canonicalSha256(exported) !== canonicalSha256(body.properties.template)) {
      return applicationError('application-recipe-readback', 'The actual deployed prerequisite recipe differs from the approved exact resource/role inventory.');
    }
    const readback = await observeApplicationPrerequisites(input);
    completedOperations.push(apply, verify);
    const values = { loginServer: String(readback.registry.loginServer),
      workloadPrincipalId: String(readback.identity.principalId), workloadClientId: String(readback.identity.clientId),
      buildPrincipalId: binding.principalId, buildClientId: binding.principalAppId };
    const resources = resourceBindings(binding).map((resource) =>
      readbackProof(input, 'azure', resource.resourceType, resource.resourceId,
        resource.resourceId === binding.registryId ? readback.registry :
          resource.resourceId === binding.identityId ? readback.identity :
            readback.roles.find((role) => role.id === resource.resourceId) ?? { bindingDigest: binding.bindingDigest, deployedTemplateDigest: canonicalSha256(exported) }));
    const verifiedOutputs = outputs(binding, values, true);
    const finalOwnership = await inspectAzureDeploymentOwnership({
      ...input,
      inspection: {
        ...input.inspection,
        state: {
          ...input.inspection.state,
          phases: { ...input.inspection.state.phases, [input.phase.id]: {
            ...input.inspection.state.phases[input.phase.id],
            executionPlanDigest: input.plan.planDigest, operation: { ...handle, planDigest: handle.planDigest ?? input.plan.planDigest }
          } },
          phaseOutputs: { ...input.inspection.state.phaseOutputs, [input.phase.id]: verifiedOutputs }
        }
      }
    });
    if (!finalOwnership || finalOwnership.blocker) {
      return applicationError('application-ownership', finalOwnership?.blocker ?? 'Current application ownership proof is missing.');
    }
    return {
      status: 'completed', resultState: 'verified', operation: { ...handle, status: 'completed' },
      outputs: verifiedOutputs, liveReadback: [...resources, ...finalOwnership?.liveReadback ?? []],
      evidencePayload: { kind: 'application-prerequisites-ready.v1', prerequisiteBindingDigest: binding.bindingDigest,
        deployedTemplateDigest: canonicalSha256(exported), roles: readback.roles,
        registry: readback.registry, identity: readback.identity, deployment: observed,
        protectedCustodyIdentityDigest: protectedStateCustodyIdentityDigest(protection.custody),
        deploymentOwnership: finalOwnership.payload,
        deploymentPerformed: false, adoptsExistingResources: false },
      completedOperations
    };
  } catch (error) {
    if (!isApplicationProviderError(error)) throw error;
    return {
      status: handle?.status === 'running' && currentReadback.length ? 'pending' : 'blocked', resultState: 'failed', blocker: error.message,
      ...(handle && currentReadback.length ? {
        operation: handle, outputs: output, liveReadback: currentReadback
      } : {}),
      completedOperations,
      cleanupWarnings: dispatchAttempted || handle
        ? ['Application dispatch/verification may have partial external effects; observe the recorded deployment, never repeat or infer rollback from missing local files.'] : []
    };
  }
}
