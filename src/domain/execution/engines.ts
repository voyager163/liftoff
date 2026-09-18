/**
 * Exactly six capability engines partition Liftoff's public lifecycle capabilities.
 * The shared execution kernel is common infrastructure, not a 7th capability engine.
 */

export const engineIds = [
  'standards-assessment',
  'project-generation',
  'project-evolution',
  'repository-governance',
  'azure-activation',
  'distribution'
] as const;

export type EngineId = (typeof engineIds)[number];

export const engineOwners = [
  'Standards and Assessment',
  'Project Generation',
  'Project Evolution',
  'Repository Governance',
  'Azure Activation',
  'Distribution and CLI Upgrade'
] as const;

export type EngineOwner = (typeof engineOwners)[number];

export interface EngineDescriptor {
  id: EngineId;
  owner: EngineOwner;
  title: string;
  description: string;
  applicationModule: string;
}

export const canonicalEngines: Readonly<Record<EngineId, EngineDescriptor>> = {
  'standards-assessment': {
    id: 'standards-assessment',
    owner: 'Standards and Assessment',
    title: 'Standards and Assessment',
    description: 'Profile selection, bounded inventory, standards findings and evidence coverage',
    applicationModule: 'application/standards-assessment'
  },
  'project-generation': {
    id: 'project-generation',
    owner: 'Project Generation',
    title: 'Project Generation',
    description: 'Compose and stage approved new-project artifacts',
    applicationModule: 'application/project-generation'
  },
  'project-evolution': {
    id: 'project-evolution',
    owner: 'Project Evolution',
    title: 'Project Evolution',
    description: 'Adoption, existing fresh-target migration, managed update and reviewed repair',
    applicationModule: 'application/project-evolution'
  },
  'repository-governance': {
    id: 'repository-governance',
    owner: 'Repository Governance',
    title: 'Repository Governance',
    description: 'GitFlow, source workflows, checks, approved settings/rulesets and repository readback',
    applicationModule: 'application/repository-governance'
  },
  'azure-activation': {
    id: 'azure-activation',
    owner: 'Azure Activation',
    title: 'Azure Activation',
    description: 'Explicit environment discovery, approved provisioning/deployment and qualification',
    applicationModule: 'application/azure-activation'
  },
  distribution: {
    id: 'distribution',
    owner: 'Distribution and CLI Upgrade',
    title: 'Distribution and CLI Upgrade',
    description: 'Installation ownership, release discovery, native upgrades and installation handover',
    applicationModule: 'application/distribution'
  }
} as const;

export function isEngineId(value: unknown): value is EngineId {
  return typeof value === 'string' && (engineIds as readonly string[]).includes(value);
}

export function isEngineOwner(value: unknown): value is EngineOwner {
  return typeof value === 'string' && (engineOwners as readonly string[]).includes(value);
}

export function engineOwnerForId(id: EngineId): EngineOwner {
  return canonicalEngines[id].owner;
}

export function engineIdForOwner(owner: EngineOwner): EngineId {
  const match = Object.values(canonicalEngines).find((engine) => engine.owner === owner);
  if (!match) {
    throw new Error(`Unknown engine owner: ${owner}`);
  }
  return match.id;
}
