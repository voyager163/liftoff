import type { PhaseAdapterExecutionInput, PhasePlanningInput } from './transition-ports.js';
import { buildAzureResourceNames, stableResourceSuffix } from '../generators/infrastructure/names.js';
import { toSafeProjectName } from '../domain/project/planning.js';

const requestTimeoutMs = 30_000;
const maxResponseBytes = 4 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

export class AzureDiscoveryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AzureDiscoveryError';
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AzureDiscoveryError('invalid-response', `${label} did not return a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AzureDiscoveryError('invalid-response', `${label} is absent or invalid.`);
  }
  return value;
}

function guid(value: unknown, label: string): string {
  const result = text(value, label);
  if (!uuid.test(result)) throw new AzureDiscoveryError('invalid-response', `${label} is not a provider GUID.`);
  return result.toLowerCase();
}

function sameGuid(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

function httpsEndpoint(value: unknown, label: string): string {
  const endpoint = new URL(text(value, label));
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new AzureDiscoveryError('invalid-response', `${label} is not a credential-free HTTPS origin.`);
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, '')}/`;
  return endpoint.toString();
}

async function azureJson(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  args: readonly string[],
  label: string
): Promise<unknown> {
  const command = {
    executable: 'az',
    args: [...args, '--only-show-errors', '--output', 'json']
  };
  const result = await input.runner.run(command, {
    cwd: input.inspection.projectRoot,
    timeoutMs: requestTimeoutMs,
    maxOutputBytes: maxResponseBytes,
    stream: false,
    env: { AZURE_CORE_ONLY_SHOW_ERRORS: 'true' }
  });
  if (result.status !== 0 || result.timedOut || result.outputLimitExceeded || result.errorCode || result.aborted) {
    const reason = result.timedOut ? 'timed out' : result.outputLimitExceeded ? 'exceeded its response bound' :
      result.errorCode ? 'could not start Azure CLI' : 'was not confirmed by Azure';
    throw new AzureDiscoveryError('provider-read',
      `${label} ${reason}. Check the exact approved Azure identity, scope, CLI authentication, and connectivity; provider diagnostics were withheld.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new AzureDiscoveryError('invalid-response', `${label} returned invalid JSON; response bytes were withheld.`);
  }
}

async function observePrincipal(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  account: Record<string, unknown>
): Promise<{ type: 'user' | 'service-principal' | 'managed-identity'; objectId: string; appId?: string }> {
  const user = object(account.user, 'Azure account principal');
  const type = text(user.type, 'Azure account principal type').toLowerCase();
  if (type === 'user') {
    const accountName = text(user.name, 'Azure user account name');
    const observed = object(await azureJson(input, [
      'ad', 'signed-in-user', 'show', '--query', '{id:id,userPrincipalName:userPrincipalName}'
    ], 'Azure signed-in user discovery'), 'Azure signed-in user');
    if (text(observed.userPrincipalName, 'Azure signed-in user principal name').toLowerCase() !== accountName.toLowerCase()) {
      throw new AzureDiscoveryError('principal-binding',
        'Azure signed-in user readback differs from the exact selected account principal.');
    }
    return { type: 'user', objectId: guid(observed.id, 'Azure signed-in user id') };
  }
  if (type === 'serviceprincipal') {
    const accountName = guid(user.name, 'Azure service principal application id');
    const observed = object(await azureJson(input, [
      'ad', 'sp', 'show', '--id', accountName,
      '--query', '{id:id,appId:appId,servicePrincipalType:servicePrincipalType,accountEnabled:accountEnabled}'
    ], 'Azure service principal discovery'), 'Azure service principal');
    if (observed.accountEnabled !== true) {
      throw new AzureDiscoveryError('principal-disabled', 'The selected Azure service principal is disabled.');
    }
    const principalType = observed.servicePrincipalType === 'ManagedIdentity' ? 'managed-identity' : 'service-principal';
    const appId = guid(observed.appId, 'Azure service principal application id');
    if (appId !== accountName) {
      throw new AzureDiscoveryError('principal-binding',
        'Azure service principal readback differs from the exact selected account principal.');
    }
    return {
      type: principalType,
      objectId: guid(observed.id, 'Azure service principal object id'),
      appId
    };
  }
  throw new AzureDiscoveryError('principal-type',
    'The selected Azure account principal type is unsupported; use an explicit user, service principal, or managed identity.');
}

function expectedEnvironmentBindings(input: PhasePlanningInput | PhaseAdapterExecutionInput) {
  const project = {
    projectName: input.inspection.manifest.project.name,
    safeProjectName: toSafeProjectName(input.inspection.manifest.project.name)
  };
  return input.inspection.manifest.project.workload.environments.map((environment) => {
    const resourceSuffix = stableResourceSuffix(project, environment);
    return {
      environment,
      resourceSuffix,
      resources: buildAzureResourceNames(project, environment, resourceSuffix)
    };
  });
}

async function observeEnvironmentBindings(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  subscriptionId: string
) {
  const bindings = [];
  for (const expected of expectedEnvironmentBindings(input)) {
    const name = expected.resources.resourceGroup;
    const exists = await azureJson(input, [
      'group', 'exists', '--subscription', subscriptionId, '--name', name
    ], `Azure resource group existence discovery for ${expected.environment}`);
    if (typeof exists !== 'boolean') {
      throw new AzureDiscoveryError('invalid-response', 'Azure resource group existence discovery did not return a boolean.');
    }
    if (!exists) {
      bindings.push({ ...expected, status: 'observed-absent', resourceGroup: null, observedResources: [] });
      continue;
    }
    const group = object(await azureJson(input, [
      'group', 'show', '--subscription', subscriptionId, '--name', name,
      '--query', '{id:id,name:name,location:location,managedBy:managedBy,provisioningState:properties.provisioningState,tags:tags}'
    ], `Azure resource group discovery for ${expected.environment}`), 'Azure resource group');
    const resourceId = text(group.id, 'Azure resource group id');
    const expectedId = `/subscriptions/${subscriptionId}/resourceGroups/${name}`;
    if (resourceId.toLowerCase() !== expectedId.toLowerCase() || group.name !== name) {
      throw new AzureDiscoveryError('resource-binding',
        `Azure returned a resource group identity that differs from the exact ${expected.environment} binding.`);
    }
    const resources = await azureJson(input, [
      'resource', 'list', '--subscription', subscriptionId, '--resource-group', name,
      '--query', '[].{id:id,name:name,type:type,location:location,kind:kind,managedBy:managedBy}'
    ], `Azure resource inventory discovery for ${expected.environment}`);
    if (!Array.isArray(resources) || resources.length > 500) {
      throw new AzureDiscoveryError('resource-bound',
        `Azure ${expected.environment} resource inventory is invalid or exceeds the 500-resource qualification bound.`);
    }
    const prefix = `${expectedId}/providers/`.toLowerCase();
    const observedResources = resources.map((value) => {
      const resource = object(value, 'Azure resource');
      const id = text(resource.id, 'Azure resource id');
      if (!id.toLowerCase().startsWith(prefix)) {
        throw new AzureDiscoveryError('resource-binding',
          `Azure returned a resource outside the exact ${expected.environment} resource group.`);
      }
      return {
        id,
        name: text(resource.name, 'Azure resource name'),
        type: text(resource.type, 'Azure resource type'),
        location: typeof resource.location === 'string' ? resource.location : null,
        kind: typeof resource.kind === 'string' ? resource.kind : null,
        managedBy: typeof resource.managedBy === 'string' ? resource.managedBy : null
      };
    });
    bindings.push({
      ...expected,
      status: 'occupied-unverified-ownership',
      resourceGroup: {
        id: resourceId,
        name,
        location: text(group.location, 'Azure resource group location'),
        managedBy: typeof group.managedBy === 'string' ? group.managedBy : null,
        provisioningState: text(group.provisioningState, 'Azure resource group provisioning state'),
        tagKeys: Object.keys(object(group.tags ?? {}, 'Azure resource group tags'))
          .map((key) => text(key, 'Azure resource group tag key'))
          .sort((left, right) => left.localeCompare(right, 'en'))
      },
      observedResources
    });
  }
  return bindings;
}

export async function observeAzurePhase0(input: PhasePlanningInput | PhaseAdapterExecutionInput) {
  const configuration = input.inspection.activationInputs?.azure ??
    input.inspection.state.activationInputs?.azure;
  if (!configuration) throw new AzureDiscoveryError('configuration-required',
    'Azure Phase 0 discovery requires exact subscription, tenant, and region configuration.');
  const subscriptionId = guid(configuration.subscriptionId, 'Configured Azure subscription id');
  const tenantId = guid(configuration.tenantId, 'Configured Azure tenant id');
  if (configuration.region !== input.inspection.manifest.project.workload.region) {
    throw new AzureDiscoveryError('region-binding',
      'Configured Azure region differs from the project workload region; review activation configuration before discovery.');
  }
  const account = object(await azureJson(input, [
    'account', 'show', '--subscription', subscriptionId
  ], 'Azure account discovery'), 'Azure account');
  if (!sameGuid(account.id, subscriptionId) || !sameGuid(account.tenantId, tenantId) || account.state !== 'Enabled') {
    throw new AzureDiscoveryError('account-binding',
      'Azure account discovery differs from the exact configured enabled subscription and tenant.');
  }
  const cloudName = text(account.environmentName, 'Azure cloud environment');
  const cloud = object(await azureJson(input, [
    'cloud', 'show', '--name', cloudName,
    '--query', '{name:name,resourceManager:endpoints.resourceManager,resourceManagerAudience:endpoints.activeDirectoryResourceId}'
  ], 'Azure cloud discovery'), 'Azure cloud');
  if (cloud.name !== cloudName) {
    throw new AzureDiscoveryError('cloud-binding', 'Azure cloud discovery differs from the selected account environment.');
  }
  const resourceManager = httpsEndpoint(cloud.resourceManager, 'Azure Resource Manager endpoint');
  const resourceManagerAudience = httpsEndpoint(cloud.resourceManagerAudience, 'Azure Resource Manager audience');
  const subscriptionUrl = new URL(`subscriptions/${subscriptionId}?api-version=2022-12-01`, resourceManager).toString();
  const subscription = object(await azureJson(input, [
    'rest', '--method', 'GET', '--url', subscriptionUrl, '--resource', resourceManagerAudience
  ], 'Azure live subscription discovery'), 'Azure live subscription');
  if (!sameGuid(subscription.subscriptionId, subscriptionId) ||
    !sameGuid(subscription.tenantId, tenantId) || subscription.state !== 'Enabled') {
    throw new AzureDiscoveryError('subscription-binding',
      'Azure live subscription readback differs from the exact configured enabled subscription and tenant.');
  }
  const principal = await observePrincipal(input, account);
  const environments = await observeEnvironmentBindings(input, subscriptionId);
  return {
    subscription: { id: subscriptionId, tenantId, state: 'Enabled' as const },
    principal,
    cloud: { name: cloudName, resourceManager, resourceManagerAudience },
    region: configuration.region,
    environments
  };
}
