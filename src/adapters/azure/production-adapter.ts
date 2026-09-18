import type { CommandRunner, CommandResult } from '../../process-runner.js';
import type { ExternalCommand } from '../../domain/project/contracts.js';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import { commandSucceeded as baseCommandSucceeded, commandFailure } from '../../governance-activation/transition-process.js';

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGION_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/i;
const PLACEHOLDER_PATTERN = /^(none|placeholder|nil|null|undefined|test|zero)$/i;
const PROVIDER_NAMESPACE_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u;
const DNS_NAME_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u;

function commandSucceeded(result: CommandResult): boolean {
  return baseCommandSucceeded(result) && !result.outputLimitExceeded && !result.aborted;
}

async function runCommand(runner: CommandRunner, command: ExternalCommand, cwd: string): Promise<CommandResult> {
  return runner.run(command, { cwd, timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, stream: false });
}

function responseObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AzureResponseError('Required Azure object metadata was missing or malformed.');
  }
  return value;
}

export class AzureResponseError extends Error {
  constructor(message: string, readonly code = 'invalid-response') {
    super(message);
  }
}

function invalidAzureResponse(error: unknown, label: string): string {
  if (!(error instanceof SyntaxError) && !(error instanceof AzureResponseError)) throw error;
  return error instanceof AzureResponseError ? error.message : `Invalid JSON returned for ${label}; provider response bytes were withheld.`;
}

function exactResourceId(
  value: Record<string, unknown>, subscriptionId: string, resourceType: string, name: string, resourceGroup?: string
): string {
  const id = value.id;
  const parts = typeof id === 'string' ? id.split('/') : [];
  if (typeof id !== 'string' || parts.length !== 9 || parts[0] !== '' ||
    parts[1]?.toLowerCase() !== 'subscriptions' || parts[2]?.toLowerCase() !== subscriptionId.toLowerCase() ||
    parts[3]?.toLowerCase() !== 'resourcegroups' || !/^[A-Za-z0-9][A-Za-z0-9_.()-]{0,89}$/u.test(parts[4] ?? '') ||
    resourceGroup !== undefined && parts[4]?.toLowerCase() !== resourceGroup.toLowerCase() ||
    parts[5]?.toLowerCase() !== 'providers' ||
    `${parts[6]}/${parts[7]}`.toLowerCase() !== resourceType.toLowerCase() ||
    parts[8]?.toLowerCase() !== name.toLowerCase() || typeof value.name !== 'string' ||
    value.name.toLowerCase() !== name.toLowerCase()) {
    throw new AzureResponseError('Azure resource identity does not match the exact requested subscription, resource group, type and name.', 'scope-mismatch');
  }
  return id;
}

export interface AzureBindingValidation {
  valid: boolean;
  subscriptionId?: string;
  tenantId?: string;
  region?: string;
  errors: readonly string[];
}

export function sanitizeAzureOutput(text: string): string {
  return text
    .replace(/(clientSecret|password|secret|key|token|connectionString)\s*[:=]\s*["']?[^"',\s}]+/gi, '$1: "[REDACTED]"')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [REDACTED]')
    .replace(/(sig|token|key|secret)=[A-Za-z0-9%._~+/-]+/g, '$1=[REDACTED]');
}

export function validateAzureBindings(input: {
  subscriptionId?: unknown;
  tenantId?: unknown;
  region?: unknown;
}): AzureBindingValidation {
  const errors: string[] = [];
  const sub = typeof input.subscriptionId === 'string' ? input.subscriptionId.trim() : '';
  const tenant = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
  const reg = typeof input.region === 'string' ? input.region.trim() : '';

  if (!sub) {
    errors.push('Azure subscriptionId is required but was missing or empty.');
  } else if (sub === NIL_UUID || PLACEHOLDER_PATTERN.test(sub)) {
    errors.push(`Azure subscriptionId cannot be a nil or placeholder UUID: ${sub}.`);
  } else if (!UUID_PATTERN.test(sub)) {
    errors.push(`Azure subscriptionId must be a valid UUID format: ${sub}.`);
  }

  if (!tenant) {
    errors.push('Azure tenantId is required but was missing or empty.');
  } else if (tenant === NIL_UUID || PLACEHOLDER_PATTERN.test(tenant)) {
    errors.push(`Azure tenantId cannot be a nil or placeholder UUID: ${tenant}.`);
  } else if (!UUID_PATTERN.test(tenant)) {
    errors.push(`Azure tenantId must be a valid UUID format: ${tenant}.`);
  }

  if (!reg) {
    errors.push('Azure region is required but was missing or empty.');
  } else if (PLACEHOLDER_PATTERN.test(reg) || !REGION_PATTERN.test(reg)) {
    errors.push(`Azure region cannot be a placeholder or invalid format: ${reg}.`);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, subscriptionId: sub, tenantId: tenant, region: reg, errors: [] };
}

export interface AzureAccountDetails {
  id: string;
  tenantId: string;
  state: 'Enabled';
  name?: string;
  environmentName?: string;
}

export type AzureAccountResult =
  | { success: true; account: AzureAccountDetails }
  | { success: false; error: string; classification: 'mismatch' | 'disabled' | 'not-authenticated' | 'subscription-not-found' | 'command-failed' };

export async function executeAzureAccountShow(
  runner: CommandRunner,
  projectRoot: string,
  expectedSubscriptionId: string,
  expectedTenantId: string
): Promise<AzureAccountResult> {
  if (![expectedSubscriptionId, expectedTenantId].every((value) => UUID_PATTERN.test(value) && value !== NIL_UUID)) {
    return { success: false, error: 'Azure account discovery requires explicit non-nil subscription and tenant UUIDs.', classification: 'mismatch' };
  }
  const result = await runCommand(runner, {
    executable: 'az',
    args: ['account', 'show', '--subscription', expectedSubscriptionId, '--output', 'json']
  }, projectRoot);

  if (!commandSucceeded(result) || !result.stdout) {
    const rawError = sanitizeAzureOutput(commandFailure(result));
    if (/az login|not logged in|login to azure/i.test(rawError)) {
      return { success: false, error: `Azure CLI is not authenticated: ${rawError}`, classification: 'not-authenticated' };
    }
    if (/SubscriptionNotFound|subscription.*not found|could not find subscription/i.test(rawError)) {
      return { success: false, error: `Azure subscription ${expectedSubscriptionId} was not found: ${rawError}`, classification: 'subscription-not-found' };
    }
    return { success: false, error: `az account show failed for subscription ${expectedSubscriptionId}: ${rawError}`, classification: 'command-failed' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = responseObject(JSON.parse(result.stdout));
  } catch (error) {
    return { success: false, error: invalidAzureResponse(error, 'az account show'), classification: 'command-failed' };
  }

  const observedSub = typeof parsed.id === 'string' ? parsed.id.toLowerCase() : null;
  const targetSub = expectedSubscriptionId.toLowerCase();
  if (observedSub !== targetSub) {
    return {
      success: false,
      error: 'Azure subscription ID mismatch: the observed subscription does not match the explicitly selected subscription.',
      classification: 'mismatch'
    };
  }

  const observedTenant = typeof parsed.tenantId === 'string' ? parsed.tenantId.toLowerCase() : null;
  const targetTenant = expectedTenantId.toLowerCase();
  if (observedTenant !== targetTenant) {
    return {
      success: false,
      error: 'Azure tenant ID mismatch: the observed tenant does not match the explicitly selected tenant.',
      classification: 'mismatch'
    };
  }

  if (parsed.state !== 'Enabled') {
    return {
      success: false,
      error: 'Azure account state was absent or unusable; expected Enabled.',
      classification: 'disabled'
    };
  }

  return {
    success: true,
    account: {
      id: observedSub,
      tenantId: observedTenant,
      state: 'Enabled',
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      ...(typeof parsed.environmentName === 'string' ? { environmentName: parsed.environmentName } : {})
    }
  };
}

export type ProviderRegistrationState = 'Registered' | 'Registering' | 'NotRegistered' | 'Unregistered' | 'Unregistering' | 'Unknown';

export interface ProviderNamespaceStatus {
  namespace: string;
  state: ProviderRegistrationState;
  resourceId: string;
}

export type ProviderCheckResult =
  | { success: true; registered: readonly string[]; pending: readonly string[]; statuses: readonly ProviderNamespaceStatus[] }
  | { success: false; error: string; classification: 'authorization-failed' | 'subscription-not-found' | 'quota-exceeded' | 'invalid-namespace' | 'command-failed' };

export function parseAzureProviderStatus(value: unknown, subscriptionId: string, namespace: string): ProviderNamespaceStatus {
  const parsed = responseObject(value);
  if (parsed.namespace !== namespace || typeof parsed.id !== 'string' ||
    parsed.id.toLowerCase() !== `/subscriptions/${subscriptionId}/providers/${namespace}`.toLowerCase()) {
    throw new AzureResponseError('Provider response namespace or subscription resource identity differs from the exact requested target.', 'scope-mismatch');
  }
  for (const state of ['Registered', 'Registering', 'NotRegistered', 'Unregistered', 'Unregistering'] as const) {
    if (parsed.registrationState === state) return { namespace: parsed.namespace, resourceId: parsed.id, state };
  }
  throw new AzureResponseError('Provider response omitted a supported registration state; no default readiness was inferred.', 'unsupported-response');
}

export async function executeAzureProviderShow(
  runner: CommandRunner,
  projectRoot: string,
  subscriptionId: string,
  namespace: string
): Promise<{ success: true; status: ProviderNamespaceStatus } | { success: false; error: string; classification: string }> {
  if (!UUID_PATTERN.test(subscriptionId) || subscriptionId === NIL_UUID || !PROVIDER_NAMESPACE_PATTERN.test(namespace)) {
    return { success: false, error: 'Provider discovery requires an exact non-nil subscription and valid namespace.', classification: 'invalid-namespace' };
  }
  const result = await runCommand(runner, {
    executable: 'az',
    args: ['provider', 'show', '--namespace', namespace, '--subscription', subscriptionId, '--output', 'json']
  }, projectRoot);

  if (!commandSucceeded(result) || !result.stdout) {
    const rawError = sanitizeAzureOutput(commandFailure(result));
    if (/AuthorizationFailed|not authorized/i.test(rawError)) {
      return { success: false, error: `Authorization failed for namespace ${namespace}: ${rawError}`, classification: 'authorization-failed' };
    }
    if (/SubscriptionNotFound/i.test(rawError)) {
      return { success: false, error: `Subscription ${subscriptionId} not found: ${rawError}`, classification: 'subscription-not-found' };
    }
    return { success: false, error: `az provider show failed for ${namespace}: ${rawError}`, classification: 'command-failed' };
  }

  try {
    return { success: true, status: parseAzureProviderStatus(JSON.parse(result.stdout), subscriptionId, namespace) };
  } catch (error) {
    return { success: false, error: invalidAzureResponse(error, 'provider discovery'),
      classification: error instanceof AzureResponseError ? error.code : 'invalid-response' };
  }
}

export async function executeAzureProviderRegister(
  runner: CommandRunner,
  projectRoot: string,
  subscriptionId: string,
  namespace: string
): Promise<{ success: true; status: ProviderNamespaceStatus } | { success: false; error: string; classification: string }> {
  if (!UUID_PATTERN.test(subscriptionId) || subscriptionId === NIL_UUID || !PROVIDER_NAMESPACE_PATTERN.test(namespace)) {
    return { success: false, error: 'Provider registration requires an exact non-nil subscription and valid namespace.', classification: 'invalid-namespace' };
  }
  const result = await runCommand(runner, {
    executable: 'az',
    args: ['provider', 'register', '--namespace', namespace, '--subscription', subscriptionId, '--output', 'json']
  }, projectRoot);

  if (!commandSucceeded(result) || !result.stdout) {
    const rawError = sanitizeAzureOutput(commandFailure(result));
    if (/AuthorizationFailed|not authorized/i.test(rawError)) {
      return { success: false, error: `Authorization failed to register ${namespace}: ${rawError}`, classification: 'authorization-failed' };
    }
    return { success: false, error: `az provider register failed for ${namespace}: ${rawError}`, classification: 'command-failed' };
  }

  try {
    return { success: true, status: parseAzureProviderStatus(JSON.parse(result.stdout), subscriptionId, namespace) };
  } catch (error) {
    return { success: false, error: invalidAzureResponse(error, 'provider registration'),
      classification: error instanceof AzureResponseError ? error.code : 'invalid-response' };
  }
}

export async function executeAzureStorageAccountShow(
  runner: CommandRunner,
  projectRoot: string,
  subscriptionId: string,
  resourceGroup: string,
  accountName: string
): Promise<{ success: true; account: { id: string; name: string; publicNetworkAccess?: string; minimumTlsVersion?: string; primaryEndpoints?: Record<string, string> } } | { success: false; error: string }> {
  const result = await runCommand(runner, {
    executable: 'az',
    args: ['storage', 'account', 'show', '--name', accountName, '--resource-group', resourceGroup, '--subscription', subscriptionId, '--output', 'json']
  }, projectRoot);

  if (!commandSucceeded(result) || !result.stdout) {
    return { success: false, error: sanitizeAzureOutput(commandFailure(result)) };
  }

  try {
    const parsed = responseObject(JSON.parse(result.stdout));
    const id = exactResourceId(parsed, subscriptionId, 'Microsoft.Storage/storageAccounts', accountName, resourceGroup);
    if (parsed.publicNetworkAccess !== undefined && (typeof parsed.publicNetworkAccess !== 'string' || !['Enabled', 'Disabled'].includes(parsed.publicNetworkAccess)) ||
      parsed.minimumTlsVersion !== undefined && (typeof parsed.minimumTlsVersion !== 'string' || !['TLS1_0', 'TLS1_1', 'TLS1_2', 'TLS1_3'].includes(parsed.minimumTlsVersion))) {
      return { success: false, error: 'Storage account response contains unsupported network or TLS metadata.' };
    }
    let primaryEndpoints: Record<string, string> | undefined;
    if (parsed.primaryEndpoints !== undefined) {
      primaryEndpoints = {};
      for (const [key, endpoint] of Object.entries(responseObject(parsed.primaryEndpoints))) {
        if (typeof endpoint !== 'string' || !/^https:\/\/[a-z0-9.-]+\/$/u.test(endpoint)) {
          throw new AzureResponseError('Storage account returned an unsupported public endpoint.');
        }
        primaryEndpoints[key] = endpoint;
      }
    }
    return {
      success: true,
      account: {
        id, name: accountName,
        ...(typeof parsed.publicNetworkAccess === 'string' ? { publicNetworkAccess: parsed.publicNetworkAccess } : {}),
        ...(typeof parsed.minimumTlsVersion === 'string' ? { minimumTlsVersion: parsed.minimumTlsVersion } : {}),
        ...(primaryEndpoints ? { primaryEndpoints } : {})
      }
    };
  } catch (error) {
    return { success: false, error: invalidAzureResponse(error, 'storage account') };
  }
}

export async function executeAzureBlobPropertiesShow(
  runner: CommandRunner,
  projectRoot: string,
  subscriptionId: string,
  resourceGroup: string,
  accountName: string
): Promise<{ success: true; isVersioningEnabled: boolean } | { success: false; error: string }> {
  const result = await runCommand(runner, {
    executable: 'az',
    args: ['storage', 'account', 'blob-service-properties', 'show', '--account-name', accountName, '--resource-group', resourceGroup, '--subscription', subscriptionId, '--output', 'json']
  }, projectRoot);

  if (!commandSucceeded(result) || !result.stdout) {
    return { success: false, error: sanitizeAzureOutput(commandFailure(result)) };
  }

  try {
    const parsed = responseObject(JSON.parse(result.stdout));
    if (typeof parsed.isVersioningEnabled !== 'boolean') {
      return { success: false, error: 'Blob service readback omitted a boolean versioning setting; no enabled or disabled default was inferred.' };
    }
    return { success: true, isVersioningEnabled: parsed.isVersioningEnabled };
  } catch (error) {
    return { success: false, error: invalidAzureResponse(error, 'blob service properties') };
  }
}

export async function executeAzureAcrShow(
  runner: CommandRunner,
  projectRoot: string,
  subscriptionId: string,
  acrName: string
): Promise<{ success: true; acr: { id: string; name: string; loginServer: string; provisioningState: string } } | { success: false; error: string }> {
  const result = await runCommand(runner, {
    executable: 'az',
    args: ['acr', 'show', '--name', acrName, '--subscription', subscriptionId, '--output', 'json']
  }, projectRoot);

  if (!commandSucceeded(result) || !result.stdout) {
    return { success: false, error: sanitizeAzureOutput(commandFailure(result)) };
  }

  try {
    const parsed = responseObject(JSON.parse(result.stdout));
    const id = exactResourceId(parsed, subscriptionId, 'Microsoft.ContainerRegistry/registries', acrName);
    if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string' || typeof parsed.loginServer !== 'string' ||
      !DNS_NAME_PATTERN.test(parsed.loginServer) || parsed.loginServer.length > 253 ||
      typeof parsed.provisioningState !== 'string' || !parsed.provisioningState) {
      return { success: false, error: 'ACR response missing valid id, name, loginServer, or provisioningState; no Succeeded default was inferred.' };
    }
    return {
      success: true,
      acr: {
        id, name: parsed.name,
        loginServer: parsed.loginServer,
        provisioningState: parsed.provisioningState
      }
    };
  } catch (error) {
    return { success: false, error: invalidAzureResponse(error, 'ACR') };
  }
}

export async function executeAzureIdentityShow(
  runner: CommandRunner,
  projectRoot: string,
  subscriptionId: string,
  resourceGroup: string,
  identityName: string
): Promise<{ success: true; identity: { id: string; name: string; clientId: string; principalId: string } } | { success: false; error: string }> {
  const result = await runCommand(runner, {
    executable: 'az',
    args: ['identity', 'show', '--name', identityName, '--resource-group', resourceGroup, '--subscription', subscriptionId, '--output', 'json']
  }, projectRoot);

  if (!commandSucceeded(result) || !result.stdout) {
    return { success: false, error: sanitizeAzureOutput(commandFailure(result)) };
  }

  try {
    const parsed = responseObject(JSON.parse(result.stdout));
    const id = exactResourceId(parsed, subscriptionId, 'Microsoft.ManagedIdentity/userAssignedIdentities', identityName, resourceGroup);
    if (typeof parsed.clientId !== 'string' || !UUID_PATTERN.test(parsed.clientId) || parsed.clientId === NIL_UUID ||
      typeof parsed.principalId !== 'string' || !UUID_PATTERN.test(parsed.principalId) || parsed.principalId === NIL_UUID) {
      return { success: false, error: 'Identity response omitted valid non-nil clientId or principalId UUIDs.' };
    }
    return {
      success: true,
      identity: {
        id, name: identityName,
        clientId: parsed.clientId,
        principalId: parsed.principalId
      }
    };
  } catch (error) {
    return { success: false, error: invalidAzureResponse(error, 'managed identity') };
  }
}

export async function executeAzureAcrManifestsShow(
  runner: CommandRunner,
  projectRoot: string,
  subscriptionId: string,
  acrName: string,
  repository: string
): Promise<{ success: true; manifests: readonly { digest: string; tags: readonly string[]; timestamp?: string }[] } | { success: false; error: string }> {
  const result = await runCommand(runner, {
    executable: 'az',
    args: ['acr', 'repository', 'show-manifests', '--name', acrName, '--repository', repository, '--subscription', subscriptionId, '--output', 'json']
  }, projectRoot);

  if (!commandSucceeded(result) || !result.stdout) {
    return { success: false, error: sanitizeAzureOutput(commandFailure(result)) };
  }

  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed) || parsed.length > 1000) {
      return { success: false, error: 'ACR repository show-manifests did not return a bounded complete array.' };
    }
    const manifests = parsed.map((value) => {
      const entry = responseObject(value);
      if (typeof entry.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(entry.digest) ||
        entry.tags !== null && !Array.isArray(entry.tags) ||
        entry.timestamp !== undefined && (typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp)))) {
        throw new AzureResponseError('ACR manifest readback contains a malformed digest, tag inventory or timestamp; no entry was discarded. Genuine sha256 digest is required.');
      }
      const tags = (entry.tags === null ? [] : entry.tags).map((tag: unknown) => {
        if (typeof tag !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(tag)) {
          throw new AzureResponseError('ACR manifest readback contains a malformed tag; no entry was discarded.');
        }
        return tag;
      });
      return { digest: entry.digest, tags, ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}) };
    });
    if (new Set(manifests.map((entry) => entry.digest)).size !== manifests.length) {
      return { success: false, error: 'ACR manifest readback contains duplicate immutable digests; the inventory is not complete and stable.' };
    }
    return { success: true, manifests };
  } catch (error) {
    return { success: false, error: invalidAzureResponse(error, 'ACR repository manifests') };
  }
}

export async function executeAzureContainerAppShow(
  runner: CommandRunner,
  projectRoot: string,
  subscriptionId: string,
  resourceGroup: string,
  appName: string
): Promise<{ success: true; app: { id: string; name: string; provisioningState: string; runningStatus: string; fqdn?: string } } | { success: false; error: string }> {
  const result = await runCommand(runner, {
    executable: 'az',
    args: ['containerapp', 'show', '--name', appName, '--resource-group', resourceGroup, '--subscription', subscriptionId, '--output', 'json']
  }, projectRoot);

  if (!commandSucceeded(result) || !result.stdout) {
    return { success: false, error: sanitizeAzureOutput(commandFailure(result)) };
  }

  try {
    const parsed = responseObject(JSON.parse(result.stdout));
    const id = exactResourceId(parsed, subscriptionId, 'Microsoft.App/containerApps', appName, resourceGroup);
    if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string' || !parsed.id || !parsed.name) {
      return { success: false, error: 'ContainerApp response missing id or name.' };
    }
    const properties = responseObject(parsed.properties);
    if (typeof properties.provisioningState !== 'string' || !properties.provisioningState ||
      typeof properties.runningStatus !== 'string' || !properties.runningStatus) {
      return { success: false, error: 'ContainerApp readback omitted actual provisioningState or runningStatus; no Succeeded or Running default was inferred.' };
    }
    const configuration = properties.configuration === undefined ? undefined : responseObject(properties.configuration);
    const ingress = configuration?.ingress === undefined || configuration.ingress === null ? undefined : responseObject(configuration.ingress);
    if (ingress?.fqdn !== undefined && (typeof ingress.fqdn !== 'string' ||
      !DNS_NAME_PATTERN.test(ingress.fqdn) || ingress.fqdn.length > 253)) {
      return { success: false, error: 'ContainerApp ingress FQDN was malformed.' };
    }
    return {
      success: true,
      app: {
        id, name: parsed.name,
        provisioningState: properties.provisioningState,
        runningStatus: properties.runningStatus,
        ...(typeof ingress?.fqdn === 'string' ? { fqdn: ingress.fqdn } : {})
      }
    };
  } catch (error) {
    return { success: false, error: invalidAzureResponse(error, 'ContainerApp') };
  }
}
