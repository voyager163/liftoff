import { canonicalJson } from './canonical-json.js';

export interface ApprovalResourceValueV1 {
  type: string;
  identity: string;
}

export interface ApprovalDestinationValueV1 {
  type: 'repository' | 'subscription' | 'environment' | 'tenant' | 'local' | 'external';
  identity: string;
  repository: string | null;
  subscriptionId: string | null;
}

export interface ApprovalCostValueV1 {
  currency: string;
  fixedMonthlyCents: number;
  usageMonthlyCents: number;
}

const destinationTypes = new Set<ApprovalDestinationValueV1['type']>([
  'repository',
  'subscription',
  'environment',
  'tenant',
  'local',
  'external'
]);
const currencyPattern = /^[A-Z]{3}$/u;

export function cleanString(value: string, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string.`);
  }
  const cleaned = value.trim();
  if (cleaned.length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return cleaned;
}

export function sortedUnique<T>(
  values: readonly T[],
  path: string,
  normalize: (value: T, index: number) => T,
  keyFor: (value: T) => string
): T[] {
  const normalized = values.map((value, index) => normalize(value, index));
  const seen = new Set<string>();
  for (const value of normalized) {
    const key = keyFor(value);
    if (seen.has(key)) {
      throw new Error(`${path} must not contain duplicate ${key}.`);
    }
    seen.add(key);
  }
  return [...normalized].sort((left, right) => keyFor(left).localeCompare(keyFor(right), 'en'));
}

function normalizeResource(resource: ApprovalResourceValueV1, index: number): ApprovalResourceValueV1 {
  return {
    type: cleanString(resource.type, `approvalEnvelope.resources[${index}].type`).toLowerCase(),
    identity: cleanString(resource.identity, `approvalEnvelope.resources[${index}].identity`)
  };
}

export function resourceKey(resource: ApprovalResourceValueV1): string {
  return canonicalJson(resource);
}

function normalizeDestination(destination: ApprovalDestinationValueV1, index: number): ApprovalDestinationValueV1 {
  if (!destinationTypes.has(destination.type)) {
    throw new Error(`approvalEnvelope.destinations[${index}].type contains unsupported value ${JSON.stringify(destination.type)}.`);
  }
  return {
    type: destination.type,
    identity: cleanString(destination.identity, `approvalEnvelope.destinations[${index}].identity`),
    repository: destination.repository === null
      ? null
      : cleanString(destination.repository, `approvalEnvelope.destinations[${index}].repository`),
    subscriptionId: destination.subscriptionId === null
      ? null
      : cleanString(destination.subscriptionId, `approvalEnvelope.destinations[${index}].subscriptionId`)
  };
}

export function destinationKey(destination: ApprovalDestinationValueV1): string {
  return canonicalJson(destination);
}

function normalizePermission(permission: string, index: number): string {
  return cleanString(permission, `approvalEnvelope.permissions[${index}]`).toLowerCase();
}

function normalizePlainScope(scope: string, index: number, field: 'policyExceptions' | 'destructiveScope'): string {
  return cleanString(scope, `approvalEnvelope.${field}[${index}]`);
}

export function normalizeApprovalCostCeiling(cost: ApprovalCostValueV1): ApprovalCostValueV1 {
  const currency = cleanString(cost.currency, 'approvalEnvelope.costCeiling.currency');
  if (!currencyPattern.test(currency)) {
    throw new Error('approvalEnvelope.costCeiling.currency must be a three-letter uppercase ISO currency code.');
  }
  for (const key of ['fixedMonthlyCents', 'usageMonthlyCents'] as const) {
    if (!Number.isSafeInteger(cost[key]) || cost[key] < 0) {
      throw new Error(`approvalEnvelope.costCeiling.${key} must be a non-negative safe integer number of cents.`);
    }
  }
  return {
    currency,
    fixedMonthlyCents: cost.fixedMonthlyCents,
    usageMonthlyCents: cost.usageMonthlyCents
  };
}

export function normalizeApprovalResources(resources: readonly ApprovalResourceValueV1[]): ApprovalResourceValueV1[] {
  return sortedUnique(resources, 'approvalEnvelope.resources', normalizeResource, resourceKey);
}

export function normalizeApprovalDestinations(destinations: readonly ApprovalDestinationValueV1[]): ApprovalDestinationValueV1[] {
  return sortedUnique(destinations, 'approvalEnvelope.destinations', normalizeDestination, destinationKey);
}

export function normalizeApprovalPermissions(permissions: readonly string[]): string[] {
  return sortedUnique(permissions, 'approvalEnvelope.permissions', normalizePermission, (value) => value);
}

export function normalizeApprovalPolicyExceptions(exceptions: readonly string[]): string[] {
  return sortedUnique(
    exceptions,
    'approvalEnvelope.policyExceptions',
    (value, index) => normalizePlainScope(value, index, 'policyExceptions'),
    (value) => value
  );
}

export function normalizeApprovalDestructiveScope(scope: readonly string[]): string[] {
  return sortedUnique(
    scope,
    'approvalEnvelope.destructiveScope',
    (value, index) => normalizePlainScope(value, index, 'destructiveScope'),
    (value) => value
  );
}
