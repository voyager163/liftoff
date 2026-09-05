import { environments } from './catalogs.js';
import type { ProjectProvisioningGroup } from './types.js';

export const managedCoreLogicalNames = [
  'repository-governance-policy',
  'repository-governance-context',
  'repository-governance-guide',
  'repository-governance-phase-graph',
  'repository-governance-compatibility',
  'repository-governance-credential-policy-schema',
  'liftoff-setup-copilot',
  'liftoff-setup-claude',
  'liftoff-governance-assess-copilot',
  'liftoff-governance-assess-claude'
] as const;

const managedCoreLogicalNameSet = new Set<string>(managedCoreLogicalNames);

export function isManagedCoreLogicalName(logicalName: string): boolean {
  return managedCoreLogicalNameSet.has(logicalName);
}

export const retiredManagedCoreIdentities = [
  {
    logicalName: 'repository-governance-copilot-launcher',
    category: 'governance',
    pathParts: ['.github', 'prompts', 'liftoff-repository-governance.prompt.md'],
    replacementLogicalName: 'liftoff-setup-copilot'
  },
  {
    logicalName: 'repository-governance-claude-launcher',
    category: 'governance',
    pathParts: ['.claude', 'commands', 'liftoff-repository-governance.md'],
    replacementLogicalName: 'liftoff-setup-claude'
  }
] as const;

export type RetiredManagedCoreIdentity = (typeof retiredManagedCoreIdentities)[number];

export const retiredManagedCoreIdentityMap: ReadonlyMap<string, RetiredManagedCoreIdentity> =
  new Map(retiredManagedCoreIdentities.map((identity) => [identity.logicalName, identity]));

const retiredManagedCoreLogicalNameSet = new Set<string>(
  retiredManagedCoreIdentities.map((identity) => identity.logicalName)
);

export function isRetiredManagedCoreLogicalName(logicalName: string): boolean {
  return retiredManagedCoreLogicalNameSet.has(logicalName);
}

export function isUnknownRetiredManagedCoreAliasLogicalName(
  logicalName: string
): boolean {
  return (
    /^repository-governance(?:-.+)?-launcher$/.test(logicalName) ||
    logicalName === 'liftoff-repository-governance'
  ) &&
    !isRetiredManagedCoreLogicalName(logicalName);
}

export function retiredManagedCoreIdentityFor(
  logicalName: string
): RetiredManagedCoreIdentity | undefined {
  return retiredManagedCoreIdentityMap.get(logicalName);
}

export function isRetiredManagedCoreArtifactIdentity(
  logicalName: string,
  category: string,
  pathParts: readonly string[]
): boolean {
  const identity = retiredManagedCoreIdentityFor(logicalName);
  return identity !== undefined &&
    category === identity.category &&
    pathParts.join('\0') === identity.pathParts.join('\0');
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
