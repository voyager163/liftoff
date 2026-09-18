import type { ProjectOptions, ProjectTypeDefinition, ProjectTypeId } from './contracts.js';

type CatalogLookup = (value: string) => { id: string } | undefined;

export interface ProjectInputCatalog {
  getProjectType(value: string): ProjectTypeDefinition | undefined;
  getApiStack: CatalogLookup;
  getPattern: CatalogLookup;
  getProvider: CatalogLookup;
  getSpecWorkflow: CatalogLookup;
  getGovernanceProfile: CatalogLookup;
  getCodingAgent: CatalogLookup;
  getEnvironment: CatalogLookup;
}

export function catalogKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function normalizeProjectOptions(
  input: ProjectOptions,
  catalog: ProjectInputCatalog
): ProjectOptions {
  const canonical = (value: string | undefined, lookup: CatalogLookup) =>
    value === undefined ? undefined : lookup(value)?.id ?? value;
  return {
    ...input,
    projectType: canonical(input.projectType, catalog.getProjectType),
    apiStack: canonical(input.apiStack, catalog.getApiStack),
    pattern: canonical(input.pattern, catalog.getPattern),
    cloud: canonical(input.cloud, catalog.getProvider),
    specWorkflow: canonical(input.specWorkflow, catalog.getSpecWorkflow),
    governanceProfile: canonical(input.governanceProfile, catalog.getGovernanceProfile),
    agents: input.agents?.map((value) => catalog.getCodingAgent(value)?.id ?? value),
    defaultAgent: canonical(input.defaultAgent, catalog.getCodingAgent),
    environments: input.environments?.map((value) => catalog.getEnvironment(value)?.id ?? value)
  };
}

export function resolveProjectTypeInput(
  input: ProjectOptions,
  lookup: ProjectInputCatalog['getProjectType']
): { projectType: ProjectTypeDefinition | undefined; issues: string[] } {
  const issues: string[] = [];
  const explicit = input.projectType ? lookup(input.projectType) : undefined;
  if (input.projectType && !explicit) issues.push(`Unknown project type: ${input.projectType}.`);
  const signals = [
    input.genai === undefined ? undefined : input.genai ? 'genai' : 'standard',
    input.pattern ? 'genai' : undefined,
    input.apiStack && !input.pattern && input.genai !== true && explicit?.id !== 'genai'
      ? 'standard'
      : undefined
  ].filter((value): value is ProjectTypeId => value !== undefined);
  const unique = [...new Set(signals)];
  if (unique.length > 1) {
    issues.push('Project type inputs conflict: GenAI pattern/flags cannot be combined with standard API inputs.');
  }
  if (explicit && unique.some((signal) => signal !== explicit.id)) {
    issues.push(`Project type ${explicit.id} conflicts with legacy project-type, pattern, or API-stack inputs.`);
  }
  const inferred = explicit?.id ?? unique[0];
  return { projectType: inferred ? lookup(inferred) : undefined, issues };
}
