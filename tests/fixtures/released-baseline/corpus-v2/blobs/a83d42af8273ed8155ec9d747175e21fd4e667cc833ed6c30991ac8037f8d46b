import type { ApiProjectPlan } from '../../domain/project/contracts.js';
import { createHash } from 'node:crypto';

export const AZURE_NAME_LIMITS = {
  resourceGroup: 90,
  containerRegistry: 50,
  identity: 128,
  functionIdentity: 128,
  containerAppEnvironment: 60,
  backendContainerApp: 32,
  frontendContainerApp: 32,
  functionServicePlan: 40,
  functionApp: 60,
  postgres: 63,
  redis: 63,
  storage: 24,
  serviceBus: 50,
  communication: 63,
  keyVault: 24
} as const;

export type AzureResourceNames = Record<keyof typeof AZURE_NAME_LIMITS, string>;

export const boundedToken = (value: string, length: number) =>
  value.slice(0, length).replace(/-+$/g, '') || 'app';

export function buildAzureResourceNames(
  plan: ApiProjectPlan,
  environment: string,
  resourceSuffix: string
): AzureResourceNames {
  const digest = projectIdentityDigest(plan);
  const workload = `${boundedToken(plan.safeProjectName, 9)}-${digest}`;
  const compactWorkload = `${boundedToken(plan.safeProjectName.replace(/-/g, ''), 2)}${digest}`;
  return {
    resourceGroup: `rg-${workload}-${environment}`,
    containerRegistry: `acr${compactWorkload}${resourceSuffix}`,
    identity: `id-${workload}-${environment}`,
    functionIdentity: `id-${workload}-fn-${environment}`,
    containerAppEnvironment: `cae-${workload}-${environment}`,
    backendContainerApp: `ca-${workload}-be-${environment}`,
    frontendContainerApp: `ca-${workload}-fe-${environment}`,
    functionServicePlan: `asp-${workload}-fn-${environment}`,
    functionApp: `func-${workload}-${environment}-${resourceSuffix}`,
    postgres: `psql-${workload}-${environment}-${resourceSuffix}`,
    redis: `redis-${workload}-${environment}-${resourceSuffix}`,
    storage: `st${compactWorkload}${resourceSuffix}`,
    serviceBus: `sb-${workload}-${environment}-${resourceSuffix}`,
    communication: `acs-${workload}-${environment}-${resourceSuffix}`,
    keyVault: `kv-${digest}-${resourceSuffix}`
  };
}

export function stableResourceSuffix(plan: ApiProjectPlan, environment: string): string {
  return createHash('sha256')
    .update(`${plan.projectName}:${environment}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
}

export function projectIdentityDigest(plan: ApiProjectPlan): string {
  return createHash('sha256').update(plan.projectName, 'utf8').digest('hex').slice(0, 8);
}
