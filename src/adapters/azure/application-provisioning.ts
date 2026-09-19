import { createHash } from 'node:crypto';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { AzureArmError, azureArmBinding, azureArmUrl, type AzureArmBinding, type AzureArmResponse, type AzureArmTransport } from './activation-rest.js';
import { NIL_UUID, UUID_PATTERN } from './production-adapter.js';

export const ACR_API_VERSION = '2023-07-01';
export const MANAGED_IDENTITY_API_VERSION = '2023-01-31';
export const ROLE_ASSIGNMENT_API_VERSION = '2022-04-01';
export const CONTAINER_APP_API_VERSION = '2023-05-01';
export const MANAGED_ENVIRONMENT_API_VERSION = '2023-05-01';
export const ACR_PULL_ROLE_DEFINITION_UUID = '7f951dda-4ed3-4680-a7ca-43fe172d538d';
export const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const resourceGroupPattern = /^[A-Za-z0-9_()-][A-Za-z0-9_.()-]{0,89}$/u;
const acrNamePattern = /^[a-zA-Z0-9]{5,50}$/u;
const identityNamePattern = /^[a-zA-Z0-9_-]{3,128}$/u;
const appNamePattern = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/u;
const imageRepositoryPattern = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/u;
const registryHostPattern = /^[a-z0-9](?:[a-z0-9.-]{0,180}[a-z0-9])?\.azurecr\.io$/u;

function invalid(message: string): never {
  throw new AzureArmError('application-binding', message, undefined, undefined, false);
}

export function applicationObject(value: unknown, label: string, keys?: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || keys && Object.keys(value).some((key) => !keys.includes(key))) {
    invalid(`${label} must use only its explicit registered fields.`);
  }
  return value;
}

export function applicationUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value) || value === NIL_UUID) invalid(`${label} requires an explicit non-nil UUID.`);
  return value.toLowerCase();
}

function named(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is absent or outside the supported exact naming contract.`);
  return value;
}

export function applicationImageRepository(value: unknown): string {
  const name = named(value, imageRepositoryPattern, 'Image repository');
  if (name.length > 255) invalid('Image repository exceeds its bounded size.');
  return name;
}

export function applicationImageDigest(value: unknown): string {
  return named(value, SHA256_DIGEST_PATTERN, 'Immutable image digest');
}

export function applicationRegistryHost(value: unknown): string {
  const host = named(value, registryHostPattern, 'Observed Azure registry login server');
  if (host.includes('..')) invalid('The registry login server contains an empty DNS label.');
  return host;
}

export function parseApplicationImageReference(value: unknown): { loginServer: string; repository: string; digest: string } {
  if (typeof value !== 'string' || value.length > 512) invalid('Application deployment requires an exact bounded immutable image reference.');
  const match = /^([^/@:]+)\/([^@]+)@(sha256:[a-f0-9]{64})$/u.exec(value);
  if (!match) invalid('Application deployment requires registry/repository@sha256:64hex, without tags, suffixes or credentials.');
  return {
    loginServer: applicationRegistryHost(match[1]),
    repository: applicationImageRepository(match[2]),
    digest: applicationImageDigest(match[3])
  };
}

export interface ApplicationPrerequisitesConfig extends AzureArmBinding {
  region: string;
  resourceGroup: string;
  acrName: string;
  identityName: string;
  identityPrincipalId: string;
  identityClientId: string;
  roleAssignmentName: string;
}

export interface ApplicationFoundationConfig extends AzureArmBinding {
  region: string;
  resourceGroup: string;
  appName: string;
  environmentName: string;
  imageRef: string;
  expectedDigest: string;
  identityResourceId: string;
}

function scope(value: Record<string, unknown>): AzureArmBinding & { region: string; resourceGroup: string } {
  return {
    subscriptionId: applicationUuid(value.subscriptionId, 'Application subscription'),
    tenantId: applicationUuid(value.tenantId, 'Application tenant'),
    principalId: applicationUuid(value.principalId, 'Reviewed Azure actor principal'),
    region: named(value.region, /^[a-z0-9-]+$/u, 'Application region'),
    resourceGroup: named(value.resourceGroup, resourceGroupPattern, 'Application resource group')
  };
}

export function validateApplicationPrerequisitesConfig(value: unknown): ApplicationPrerequisitesConfig {
  const config = applicationObject(value, 'Application prerequisites', [
    'subscriptionId', 'tenantId', 'principalId', 'region', 'resourceGroup', 'acrName',
    'identityName', 'identityPrincipalId', 'identityClientId', 'roleAssignmentName'
  ]);
  return {
    ...scope(config),
    acrName: named(config.acrName, acrNamePattern, 'Registry name'),
    identityName: named(config.identityName, identityNamePattern, 'Workload identity name'),
    identityPrincipalId: applicationUuid(config.identityPrincipalId, 'Expected workload identity principal'),
    identityClientId: applicationUuid(config.identityClientId, 'Expected workload identity client'),
    roleAssignmentName: applicationUuid(config.roleAssignmentName, 'Exact AcrPull assignment name')
  };
}

export function validateApplicationFoundationConfig(value: unknown): ApplicationFoundationConfig {
  const config = applicationObject(value, 'Application foundation', [
    'subscriptionId', 'tenantId', 'principalId', 'region', 'resourceGroup', 'appName',
    'environmentName', 'imageRef', 'expectedDigest', 'identityResourceId'
  ]);
  const binding = scope(config);
  const image = parseApplicationImageReference(config.imageRef);
  const expectedDigest = applicationImageDigest(config.expectedDigest);
  if (image.digest !== expectedDigest) invalid('The exact image reference and approved digest differ.');
  const identity = typeof config.identityResourceId === 'string'
    ? /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/([^/]+)$/iu.exec(config.identityResourceId)
    : null;
  if (!identity || identity[1]!.toLowerCase() !== binding.subscriptionId) invalid('The workload identity requires its explicit resource ID in the approved subscription.');
  const identityId = managedIdentityResourceId(binding.subscriptionId, identity[2]!, identity[3]!);
  if (identityId.toLowerCase() !== String(config.identityResourceId).toLowerCase()) invalid('The workload identity resource ID is not canonical.');
  return {
    ...binding,
    appName: named(config.appName, appNamePattern, 'Container App name'),
    environmentName: named(config.environmentName, appNamePattern, 'Container App environment name'),
    imageRef: `${image.loginServer}/${image.repository}@${image.digest}`, expectedDigest,
    identityResourceId: identityId
  };
}

export function containerRegistryResourceId(subscriptionId: string, resourceGroup: string, acrName: string): string {
  return `/subscriptions/${applicationUuid(subscriptionId, 'Registry subscription')}/resourceGroups/${named(resourceGroup, resourceGroupPattern, 'Registry resource group')}/providers/Microsoft.ContainerRegistry/registries/${named(acrName, acrNamePattern, 'Registry name')}`;
}

export function managedIdentityResourceId(subscriptionId: string, resourceGroup: string, identityName: string): string {
  return `/subscriptions/${applicationUuid(subscriptionId, 'Identity subscription')}/resourceGroups/${named(resourceGroup, resourceGroupPattern, 'Identity resource group')}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${named(identityName, identityNamePattern, 'Identity name')}`;
}

export function acrPullRoleDefinitionId(subscriptionId: string): string {
  return `/subscriptions/${applicationUuid(subscriptionId, 'Role subscription')}/providers/Microsoft.Authorization/roleDefinitions/${ACR_PULL_ROLE_DEFINITION_UUID}`;
}

export function roleAssignmentResourceId(resourceScope: string, name: string): string {
  const subscription = /^\/subscriptions\/([^/]+)\//iu.exec(resourceScope)?.[1];
  if (!subscription) invalid('An exact subscription-scoped role assignment target is required.');
  azureArmUrl(resourceScope, ROLE_ASSIGNMENT_API_VERSION, applicationUuid(subscription, 'Role scope subscription'));
  return `${resourceScope}/providers/Microsoft.Authorization/roleAssignments/${applicationUuid(name, 'Role assignment name')}`;
}

export function containerAppResourceId(subscriptionId: string, resourceGroup: string, name: string): string {
  return `/subscriptions/${applicationUuid(subscriptionId, 'Application subscription')}/resourceGroups/${named(resourceGroup, resourceGroupPattern, 'Application resource group')}/providers/Microsoft.App/containerApps/${named(name, appNamePattern, 'Application name')}`;
}

export function containerAppEnvironmentResourceId(subscriptionId: string, resourceGroup: string, name: string): string {
  return `/subscriptions/${applicationUuid(subscriptionId, 'Environment subscription')}/resourceGroups/${named(resourceGroup, resourceGroupPattern, 'Environment resource group')}/providers/Microsoft.App/managedEnvironments/${named(name, appNamePattern, 'Environment name')}`;
}

export function deterministicRoleAssignmentUuid(resourceScope: string, principalId: string, roleDefinitionId: string): string {
  const hash = createHash('sha256').update(`${resourceScope.toLowerCase()}:${applicationUuid(principalId, 'Role assignee')}:${roleDefinitionId.toLowerCase()}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
}

export interface PlannedApplicationResource {
  resourceId: string;
  type: string;
  namespace: string;
  name: string;
  phaseId: 'application-prerequisites-ready' | 'application-foundation';
}
export interface PlannedApplicationResourceInventory {
  schemaVersion: 1;
  phaseId: PlannedApplicationResource['phaseId'];
  subscriptionId: string;
  inventoryDigest: string;
  resources: readonly PlannedApplicationResource[];
  namespaces: readonly string[];
}

function inventory(phaseId: PlannedApplicationResource['phaseId'], subscriptionId: string, values: Array<[string, string, string]>): PlannedApplicationResourceInventory {
  const resources = values.map(([resourceId, type, name]) => ({ resourceId, type, name, namespace: type.split('/')[0]!, phaseId }));
  const namespaces = [...new Set(resources.map((resource) => resource.namespace))].sort();
  return { schemaVersion: 1, phaseId, subscriptionId, resources, namespaces,
    inventoryDigest: canonicalSha256({ phaseId, subscriptionId, resources, namespaces }) };
}

export function inspectApplicationPrerequisiteResources(value: ApplicationPrerequisitesConfig): PlannedApplicationResourceInventory {
  const config = validateApplicationPrerequisitesConfig(value);
  const acr = containerRegistryResourceId(config.subscriptionId, config.resourceGroup, config.acrName);
  return inventory('application-prerequisites-ready', config.subscriptionId, [
    [acr, 'Microsoft.ContainerRegistry/registries', config.acrName],
    [managedIdentityResourceId(config.subscriptionId, config.resourceGroup, config.identityName), 'Microsoft.ManagedIdentity/userAssignedIdentities', config.identityName],
    [roleAssignmentResourceId(acr, config.roleAssignmentName), 'Microsoft.Authorization/roleAssignments', config.roleAssignmentName]
  ]);
}

export function inspectApplicationFoundationResources(value: ApplicationFoundationConfig): PlannedApplicationResourceInventory {
  const config = validateApplicationFoundationConfig(value);
  return inventory('application-foundation', config.subscriptionId, [
    [containerAppEnvironmentResourceId(config.subscriptionId, config.resourceGroup, config.environmentName), 'Microsoft.App/managedEnvironments', config.environmentName],
    [containerAppResourceId(config.subscriptionId, config.resourceGroup, config.appName), 'Microsoft.App/containerApps', config.appName]
  ]);
}

export interface ApplicationRegistryObservation {
  id: string;
  name: string;
  location: string;
  loginServer: string;
  provisioningState: string;
  adminUserEnabled: boolean;
  requestId: string;
}

// Resource-changing application plans have no registered private-backend executor.
// This client exposes observations only; it cannot bypass that boundary with ARM PUTs.
export class AzureApplicationProvisioningClient {
  readonly binding: AzureArmBinding;
  constructor(readonly transport: AzureArmTransport, binding: AzureArmBinding) {
    this.binding = Object.freeze(azureArmBinding(binding));
  }

  private async read<T>(
    resourceId: string, apiVersion: string, type: string, name: string,
    decode: (observation: { id: string; name: string; value: Record<string, unknown>; properties: Record<string, unknown>; requestId: string }) => T
  ): Promise<T> {
    azureArmUrl(resourceId, apiVersion, this.binding.subscriptionId);
    const response: AzureArmResponse = await this.transport.request({ method: 'GET', resourceId, apiVersion }, this.binding);
    if (response.status !== 200) {
      throw new AzureArmError('application-readback', `The exact application resource was not observed (HTTP ${response.status}).`, response.status, response.requestId, true);
    }
    if (!response.requestId || !UUID_PATTERN.test(response.requestId) || response.requestId === NIL_UUID) {
      throw new AzureArmError('request-identity-missing', 'Application readback requires an actual provider-issued request ID.', response.status, undefined, true);
    }
    try {
      const value = applicationObject(response.data, 'ARM resource observation');
      if (typeof value.id !== 'string' || value.id.toLowerCase() !== resourceId.toLowerCase() ||
        typeof value.name !== 'string' || value.name.toLowerCase() !== name.toLowerCase() ||
        typeof value.type !== 'string' || value.type.toLowerCase() !== type.toLowerCase()) {
        throw new AzureArmError('application-scope-mismatch', 'The returned application resource ID, type or name differs from the exact requested resource.', response.status, response.requestId, true);
      }
      return decode({
        id: value.id, name: value.name, value,
        properties: applicationObject(value.properties, 'ARM resource properties'), requestId: response.requestId
      });
    } catch (error) {
      if (!(error instanceof AzureArmError)) throw error;
      throw new AzureArmError(error.code, error.message, response.status, response.requestId, true);
    }
  }

  async getAcr(resourceGroup: string, name: string): Promise<ApplicationRegistryObservation> {
    const id = containerRegistryResourceId(this.binding.subscriptionId, resourceGroup, name);
    return this.read(id, ACR_API_VERSION, 'Microsoft.ContainerRegistry/registries', name, ({ id, name, value, properties, requestId }) => {
      if (typeof properties.adminUserEnabled !== 'boolean') invalid('Registry readback omitted its actual admin-user setting.');
      return {
        id, name, location: named(value.location, /^[a-z0-9-]+$/u, 'Observed registry location'),
        loginServer: applicationRegistryHost(properties.loginServer),
        provisioningState: named(properties.provisioningState, /^[A-Za-z]+$/u, 'Observed registry provisioning state'),
        adminUserEnabled: properties.adminUserEnabled, requestId
      };
    });
  }

  async getIdentity(resourceGroup: string, name: string) {
    const id = managedIdentityResourceId(this.binding.subscriptionId, resourceGroup, name);
    return this.read(id, MANAGED_IDENTITY_API_VERSION, 'Microsoft.ManagedIdentity/userAssignedIdentities', name, ({ id, name, value, properties, requestId }) => {
      const tenantId = applicationUuid(properties.tenantId, 'Observed identity tenant');
      if (tenantId !== this.binding.tenantId) invalid('The observed workload identity belongs to another tenant.');
      return {
        id, name, tenantId, location: named(value.location, /^[a-z0-9-]+$/u, 'Observed identity location'),
        clientId: applicationUuid(properties.clientId, 'Observed workload client ID'),
        principalId: applicationUuid(properties.principalId, 'Observed workload principal ID'), requestId
      };
    });
  }

  async getRoleAssignment(resourceScope: string, name: string) {
    const id = roleAssignmentResourceId(resourceScope, name);
    return this.read(id, ROLE_ASSIGNMENT_API_VERSION, 'Microsoft.Authorization/roleAssignments', name, ({ id, properties, requestId }) => {
      if (typeof properties.scope !== 'string' || properties.scope.toLowerCase() !== resourceScope.toLowerCase() ||
        typeof properties.roleDefinitionId !== 'string' ||
        !new RegExp(`^/subscriptions/${this.binding.subscriptionId}/providers/Microsoft\\.Authorization/roleDefinitions/[a-f0-9-]{36}$`, 'iu').test(properties.roleDefinitionId) ||
        properties.principalType !== 'ServicePrincipal') invalid('The role assignment has no exact service-principal/resource scope and role definition.');
      applicationUuid(properties.roleDefinitionId.split('/').at(-1), 'Observed role definition ID');
      return {
        id, scope: properties.scope, principalId: applicationUuid(properties.principalId, 'Observed role assignee'),
        roleDefinitionId: properties.roleDefinitionId, requestId
      };
    });
  }
}
