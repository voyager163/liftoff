import { environments } from './catalogs.js';
import type { ProjectProvisioningGroup } from './types.js';

export const managedCoreLogicalNames = [
  'repository-governance-policy',
  'repository-governance-context',
  'repository-governance-guide',
  'repository-governance-copilot-launcher',
  'repository-governance-claude-launcher'
] as const;

const managedCoreLogicalNameSet = new Set<string>(managedCoreLogicalNames);

export function isManagedCoreLogicalName(logicalName: string): boolean {
  return managedCoreLogicalNameSet.has(logicalName);
}

const frontendLogicalNames = new Set([
  'frontend-package',
  'frontend-lock',
  'frontend-index',
  'frontend-main',
  'frontend-app',
  'frontend-env-example',
  'frontend-styles',
  'frontend-vite-config',
  'frontend-tailwind-config',
  'frontend-dockerfile'
]);

const environmentProvisioningGroups = new Map<string, ProjectProvisioningGroup>();
for (const environment of environments) {
  const group = `environment:${environment.id}` as const;
  environmentProvisioningGroups.set(`environment-${environment.id}-backend`, group);
  environmentProvisioningGroups.set(`environment-${environment.id}-functions`, group);
  environmentProvisioningGroups.set(`opentofu-${environment.id}-tfvars`, group);
}

export function legacyProvisioningGroup(
  logicalName: string
): ProjectProvisioningGroup {
  if (frontendLogicalNames.has(logicalName)) {
    return 'frontend';
  }
  return environmentProvisioningGroups.get(logicalName) ?? 'base';
}
