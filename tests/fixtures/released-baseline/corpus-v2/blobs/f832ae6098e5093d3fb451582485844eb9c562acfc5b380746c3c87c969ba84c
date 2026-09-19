import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectOptions } from '../../domain/project/contracts.js';
import type { ProjectCatalog } from '../../domain/project/catalog.js';
import { PlanValidationError } from '../../domain/project/planning.js';
import {
  isRetiredPowerAppsWorkload,
  retiredPowerAppsMessage
} from '../../domain/project/retired-workload.js';

export type ProjectConfigCatalog = Pick<
  ProjectCatalog,
  | 'canonicalizeCodingAgents'
  | 'getApiStack'
  | 'getCodingAgent'
  | 'getEnvironment'
  | 'getGovernanceProfile'
  | 'getPattern'
  | 'getProjectType'
  | 'getProvider'
  | 'getSpecWorkflow'
  | 'resolveRegion'
>;

const CONFIG_FIELDS = new Set([
  'projectName',
  'projectType',
  'apiStack',
  'pattern',
  'cloud',
  'region',
  'includeFrontend',
  'environments',
  'specWorkflow',
  'agents',
  'defaultAgent',
  'governanceProfile'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalConfigString(
  config: Record<string, unknown>,
  field: string
): string | undefined {
  const value = config[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PlanValidationError([`Configuration field ${field} must be a non-empty string.`]);
  }
  return value;
}

function resolveConfigCatalogValue(
  config: Record<string, unknown>,
  field: string,
  resolver: (value: string) => { id: string } | undefined
): string | undefined {
  const value = optionalConfigString(config, field);
  if (value === undefined) {
    return undefined;
  }
  const resolved = resolver(value);
  if (!resolved) {
    throw new PlanValidationError([`Configuration field ${field} has unsupported value ${JSON.stringify(value)}.`]);
  }
  return resolved.id;
}

export async function loadProjectConfigOptions(
  configPath: string,
  cwd: string,
  catalog: ProjectConfigCatalog
): Promise<ProjectOptions> {
  const {
    canonicalizeCodingAgents,
    getApiStack,
    getCodingAgent,
    getEnvironment,
    getGovernanceProfile,
    getPattern,
    getProjectType,
    getProvider,
    getSpecWorkflow,
    resolveRegion
  } = catalog;
  const resolvedPath = path.resolve(cwd, configPath);
  let raw: string;
  try {
    raw = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    throw new PlanValidationError([
      `Unable to read configuration ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new PlanValidationError([
      `Unable to parse configuration ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`
    ]);
  }
  if (!isRecord(parsed)) {
    throw new PlanValidationError(['Configuration root must be a JSON object.']);
  }
  if (isRetiredPowerAppsWorkload(parsed.projectType)) {
    throw new PlanValidationError([retiredPowerAppsMessage(String(parsed.projectType))]);
  }
  if (Object.hasOwn(parsed, 'codeAppsPlugin')) {
    throw new PlanValidationError([
      'Configuration field codeAppsPlugin was removed because Power Apps code apps are retired and unsupported.'
    ]);
  }
  const unknownFields = Object.keys(parsed).filter((field) => !CONFIG_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new PlanValidationError([`Unknown configuration field${unknownFields.length === 1 ? '' : 's'}: ${unknownFields.join(', ')}.`]);
  }

  const projectName = optionalConfigString(parsed, 'projectName');
  const projectType = resolveConfigCatalogValue(parsed, 'projectType', getProjectType);
  const apiStack = resolveConfigCatalogValue(parsed, 'apiStack', getApiStack);
  const pattern = resolveConfigCatalogValue(parsed, 'pattern', getPattern);
  const cloud = resolveConfigCatalogValue(parsed, 'cloud', getProvider);
  const specWorkflow = resolveConfigCatalogValue(parsed, 'specWorkflow', getSpecWorkflow);
  const defaultAgent = resolveConfigCatalogValue(parsed, 'defaultAgent', getCodingAgent);
  const governanceProfile = resolveConfigCatalogValue(
    parsed,
    'governanceProfile',
    getGovernanceProfile
  );

  const includeFrontendValue = parsed.includeFrontend;
  if (includeFrontendValue !== undefined && typeof includeFrontendValue !== 'boolean') {
    throw new PlanValidationError(['Configuration field includeFrontend must be a boolean.']);
  }
  let selectedEnvironments: string[] | undefined;
  if (parsed.environments !== undefined) {
    if (!Array.isArray(parsed.environments) || parsed.environments.length === 0) {
      throw new PlanValidationError(['Configuration field environments must be a non-empty string array.']);
    }
    selectedEnvironments = parsed.environments.map((value, index) => {
      if (typeof value !== 'string') {
        throw new PlanValidationError([`Configuration field environments[${index}] must be a string.`]);
      }
      const environment = getEnvironment(value);
      if (!environment) {
        throw new PlanValidationError([`Configuration field environments contains unsupported value ${JSON.stringify(value)}.`]);
      }
      return environment.id;
    });
    if (new Set(selectedEnvironments).size !== selectedEnvironments.length) {
      throw new PlanValidationError(['Configuration field environments must not contain duplicates.']);
    }
  }

  let selectedAgents: string[] | undefined;
  if (parsed.agents !== undefined) {
    if (!Array.isArray(parsed.agents) || parsed.agents.length === 0) {
      throw new PlanValidationError(['Configuration field agents must be a non-empty string array.']);
    }
    const values = parsed.agents.map((value, index) => {
      if (typeof value !== 'string') {
        throw new PlanValidationError([`Configuration field agents[${index}] must be a string.`]);
      }
      return value;
    });
    const resolved = canonicalizeCodingAgents(values);
    if (resolved.unknown.length > 0) {
      throw new PlanValidationError([
        `Configuration field agents contains unsupported value ${JSON.stringify(resolved.unknown[0])}.`
      ]);
    }
    selectedAgents = resolved.agents.map((agent) => agent.id);
  }

  let region = optionalConfigString(parsed, 'region');
  const provider = cloud ? getProvider(cloud) : getProvider('azure');
  if (region && provider?.status === 'available') {
    const resolution = resolveRegion(provider.id, region);
    if (resolution.status !== 'resolved') {
      throw new PlanValidationError([
        resolution.status === 'ambiguous'
          ? `Configuration field region ${JSON.stringify(region)} is ambiguous. Use one of: ${resolution.matches.map((match) => match.slug).join(', ')}.`
          : `Configuration field region has unsupported value ${JSON.stringify(region)}.`
      ]);
    }
    region = resolution.region.slug;
  }

  return {
    projectName,
    projectType,
    apiStack,
    pattern,
    cloud,
    region,
    includeFrontend: includeFrontendValue,
    environments: selectedEnvironments,
    specWorkflow,
    agents: selectedAgents,
    defaultAgent,
    governanceProfile
  };
}
