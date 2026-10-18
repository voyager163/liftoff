import type {
  PhaseAdapterExecutionInput, PhasePlanningInput
} from './transition-ports.js';
import {
  AzureDiscoveryError, azureObject, runAzureJson
} from './azure-discovery.js';

const permissionApiVersion = '2022-04-01';

function wildcardMatches(pattern: string, action: string): boolean {
  if (!pattern || pattern.length > 512 || /[\u0000-\u001f\u007f]/u.test(pattern)) return false;
  const expression = pattern
    .replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
    .replace(/\\\*/gu, '.*');
  return new RegExp(`^${expression}$`, 'iu').test(action);
}

function stringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 1_000 ||
    value.some((entry) => typeof entry !== 'string' || entry.length > 512)) {
    throw new AzureDiscoveryError(
      'permission-invalid',
      `${label} is invalid or exceeds its qualification bound.`
    );
  }
  return value as string[];
}

export function azurePermissionEntries(value: unknown): readonly Record<string, unknown>[] {
  const response = azureObject(value, 'Azure effective permissions');
  if (response.nextLink !== undefined && response.nextLink !== null) {
    throw new AzureDiscoveryError(
      'permission-bound',
      'Azure effective permissions were paginated; complete permission proof is required before Azure writes.'
    );
  }
  if (!Array.isArray(response.value) || response.value.length > 1_000) {
    throw new AzureDiscoveryError(
      'permission-bound',
      'Azure effective permissions are invalid or exceed the 1,000-entry qualification bound.'
    );
  }
  return response.value.map((entry) => azureObject(entry, 'Azure effective permission'));
}

export function azurePermits(
  entries: readonly Record<string, unknown>[],
  action: string
): boolean {
  return entries.some((entry) => {
    const actions = stringList(entry.actions, 'Azure effective permission actions');
    const notActions = stringList(entry.notActions ?? [], 'Azure effective permission exclusions');
    return actions.some((candidate) => wildcardMatches(candidate, action)) &&
      !notActions.some((candidate) => wildcardMatches(candidate, action));
  });
}

export async function observeAzureEffectivePermissions(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  binding: {
    subscriptionId: string;
    resourceManager: string;
    resourceManagerAudience: string;
  },
  label: string
): Promise<readonly Record<string, unknown>[]> {
  const url = new URL(
    `subscriptions/${binding.subscriptionId}/providers/Microsoft.Authorization/permissions?api-version=${permissionApiVersion}`,
    binding.resourceManager
  ).toString();
  return azurePermissionEntries(await runAzureJson(input, [
    'rest', '--method', 'GET', '--url', url, '--resource', binding.resourceManagerAudience
  ], label));
}
