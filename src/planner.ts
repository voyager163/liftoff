import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  apiStacks,
  canonicalizeCodingAgents,
  environments,
  getApiStack,
  getCodingAgent,
  getEnvironment,
  getFrameworkDefinition,
  getPattern,
  getProvider,
  getProjectType,
  getSpecWorkflow,
  resolveRegion,
  specWorkflows
} from './catalogs.js';
import type { EnvironmentDefinition, ProjectOptions, ProjectPlan } from './types.js';

export class PlanValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join('\n'));
    this.name = 'PlanValidationError';
  }
}

interface BuildPlanOptions {
  requireProjectName: boolean;
}

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
  'defaultAgent'
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

export async function loadConfigOptions(configPath: string, cwd: string): Promise<ProjectOptions> {
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
    defaultAgent
  };
}

export function mergeOptions(base: ProjectOptions, override: ProjectOptions): ProjectOptions {
  const definedOverride = Object.fromEntries(
    Object.entries(override).filter(([, value]) => value !== undefined)
  ) as ProjectOptions;

  return {
    ...base,
    ...definedOverride,
    includeFrontend: definedOverride.includeFrontend ?? base.includeFrontend,
    environments: definedOverride.environments ?? base.environments
  };
}

export function buildProjectPlan(input: ProjectOptions, options: BuildPlanOptions): ProjectPlan {
  const issues: string[] = [];
  const projectName = input.projectName?.trim();
  if (options.requireProjectName && !projectName) {
    issues.push('Project name is required.');
  }

  const inferredProjectType = input.projectType ?? (input.pattern ? 'genai' : input.apiStack ? 'standard' : undefined);
  const projectType = inferredProjectType ? getProjectType(inferredProjectType) : undefined;
  if (!projectType) {
    issues.push(inferredProjectType ? `Unknown project type: ${inferredProjectType}.` : 'Project type is required.');
  }

  const pattern = input.pattern ? getPattern(input.pattern) : undefined;
  let apiStack = input.apiStack ? getApiStack(input.apiStack) : undefined;
  if (input.apiStack && !apiStack) {
    issues.push(`Unknown API stack: ${input.apiStack}. Use one of: ${apiStacks.map((stack) => stack.id).join(', ')}.`);
  }

  if (projectType?.id === 'genai') {
    if (!pattern) {
      issues.push(input.pattern ? `Unknown GenAI pattern: ${input.pattern}.` : 'GenAI pattern is required.');
    }
    if (apiStack && apiStack.id !== 'python-fastapi') {
      issues.push('GenAI projects use the python-fastapi API stack.');
    }
    apiStack = getApiStack('python-fastapi');
  } else if (projectType?.id === 'standard') {
    if (input.pattern) {
      issues.push('Standard projects cannot select a GenAI pattern. Remove --pattern or choose a GenAI project.');
    }
    if (!apiStack) {
      issues.push('API stack is required for standard projects.');
    }
  }

  const provider = getProvider(input.cloud ?? 'azure');
  if (!provider) {
    issues.push(`Unknown cloud provider: ${input.cloud}.`);
  } else if (provider.status !== 'available') {
    issues.push(`${provider.label} is a planned provider adapter and is not available in V1.`);
  }

  const specWorkflow = getSpecWorkflow(input.specWorkflow ?? specWorkflows.find((workflow) => workflow.default)?.id ?? 'openspec');
  if (!specWorkflow) {
    issues.push(`Unknown spec-driven workflow: ${input.specWorkflow}.`);
  }

  const selectedAgents = canonicalizeCodingAgents(input.agents);
  if (input.agents?.length === 0) {
    issues.push('At least one AI coding agent is required.');
  }
  if (selectedAgents.unknown.length > 0) {
    issues.push(`Unknown AI coding agent${selectedAgents.unknown.length === 1 ? '' : 's'}: ${selectedAgents.unknown.join(', ')}.`);
  }
  if (selectedAgents.agents.length === 0) {
    issues.push('At least one supported AI coding agent is required.');
  }

  const requestedDefaultAgent = input.defaultAgent ? getCodingAgent(input.defaultAgent) : undefined;
  if (input.defaultAgent && !requestedDefaultAgent) {
    issues.push(`Unknown default AI coding agent: ${input.defaultAgent}.`);
  }
  let defaultAgent = requestedDefaultAgent;
  if (specWorkflow?.id === 'spec-kit') {
    if (selectedAgents.agents.length === 1 && !defaultAgent) {
      defaultAgent = selectedAgents.agents[0];
    } else if (!defaultAgent) {
      issues.push('Spec Kit requires --default-agent when multiple AI coding agents are selected.');
    }
    if (defaultAgent && !selectedAgents.agents.some((agent) => agent.id === defaultAgent?.id)) {
      issues.push('The Spec Kit default agent must also be present in the selected agents.');
    }
  } else if (input.defaultAgent) {
    issues.push('--default-agent is only valid with Spec Kit.');
  }

  const selectedEnvironments = resolveEnvironments(input.environments);
  if (selectedEnvironments.issues.length > 0) {
    issues.push(...selectedEnvironments.issues);
  }

  const regionResolution = provider && provider.status === 'available' ? resolveRegion(provider.id, input.region) : undefined;
  if (regionResolution?.status === 'ambiguous') {
    issues.push(`Region "${input.region}" is ambiguous for ${provider?.label}. Use one of: ${regionResolution.matches.map((region) => region.slug).join(', ')}.`);
  } else if (regionResolution?.status === 'unknown') {
    issues.push(`Unknown region "${regionResolution.input}" for ${provider?.label}.`);
  }

  if (
    issues.length > 0 ||
    !projectName && options.requireProjectName ||
    !projectType ||
    !apiStack ||
    projectType.id === 'genai' && !pattern ||
    !provider ||
    !specWorkflow ||
    selectedAgents.agents.length === 0 ||
    provider.status !== 'available' ||
    !regionResolution ||
    regionResolution.status !== 'resolved'
  ) {
    throw new PlanValidationError(issues);
  }

  const effectiveProjectName = projectName || 'liftoff-preview';
  const safeProjectName = toSafeProjectName(effectiveProjectName);

  return {
    projectName: effectiveProjectName,
    safeProjectName,
    packageName: safeProjectName.replace(/_/g, '-'),
    projectType,
    apiStack,
    pattern,
    provider,
    region: regionResolution.region,
    includeFrontend: input.includeFrontend ?? false,
    frontendStarter: pattern?.frontendStarter ?? 'API starter',
    environments: selectedEnvironments.values,
    specWorkflow,
    agents: selectedAgents.agents,
    ...(defaultAgent ? { defaultAgent } : {}),
    framework: getFrameworkDefinition(specWorkflow.id),
    approvedStack: approvedStackFor(projectType.id, apiStack.id)
  };
}

function approvedStackFor(projectType: 'genai' | 'standard', apiStack: 'python-fastapi' | 'node-fastify' | 'go-huma'): string[] {
  if (projectType === 'genai') {
    return [
      'FastAPI',
      'PydanticAI',
      'Pydantic settings',
      'Scalar',
      'PostgreSQL',
      'Alembic',
      'Redis',
      'Azure Service Bus',
      'Azure Blob Storage',
      'Azure Communication Services',
      'Langfuse',
      'Docker Compose',
      'OpenTofu'
    ];
  }

  const stackSpecific: Record<typeof apiStack, string[]> = {
    'python-fastapi': ['FastAPI', 'Pydantic settings', 'SQLAlchemy', 'Alembic', 'pytest'],
    'node-fastify': ['Fastify', 'TypeScript', 'Drizzle', 'Vitest'],
    'go-huma': ['Huma v2', 'Chi', 'pgx', 'Goose', 'go test']
  };
  return [
    ...stackSpecific[apiStack],
    'Scalar',
    'PostgreSQL',
    'Redis',
    'Azure Service Bus',
    'Azure Blob Storage',
    'Azure Communication Services',
    'Docker Compose',
    'OpenTofu'
  ];
}

function resolveEnvironments(values?: string[]): { values: EnvironmentDefinition[]; issues: string[] } {
  if (!values || values.length === 0) {
    return { values: environments, issues: [] };
  }

  const issues: string[] = [];
  const resolved: EnvironmentDefinition[] = [];
  for (const value of values) {
    const environment = getEnvironment(value);
    if (!environment) {
      issues.push(`Unknown environment: ${value}.`);
    } else if (!resolved.some((existing) => existing.id === environment.id)) {
      resolved.push(environment);
    }
  }

  return { values: resolved, issues };
}

export function toSafeProjectName(projectName: string): string {
  const safe = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe || 'liftoff-project';
}

export function formatProjectPlan(plan: ProjectPlan): string {
  const frontendLine = plan.includeFrontend ? `Vue 3 + Tailwind (${plan.frontendStarter})` : 'Not generated';
  if (plan.projectType.id === 'genai' && !plan.pattern) {
    throw new Error('GenAI project plan is missing its pattern.');
  }
  const typeSpecificLine = plan.pattern
    ? `Pattern: ${plan.pattern.label} (${plan.pattern.scaffoldStatus})`
    : `API stack: ${plan.apiStack.label}`;
  return [
    `Project: ${plan.projectName}`,
    `Project type: ${plan.projectType.label}`,
    typeSpecificLine,
    `Cloud: ${plan.provider.label}`,
    `Region: ${plan.region.displayName} / ${plan.region.slug}`,
    `Frontend: ${frontendLine}`,
    `Spec workflow: ${plan.specWorkflow.label}`,
    `Coding agents: ${plan.agents.map((agent) => agent.label).join(', ')}`,
    ...(plan.defaultAgent ? [`Default agent: ${plan.defaultAgent.label}`] : []),
    `Environments: ${plan.environments.map((environment) => environment.id).join(', ')}`,
    `Approved stack: ${plan.approvedStack.join(', ')}`,
    plan.projectType.id === 'genai'
      ? 'Local development: Docker Compose with PostgreSQL/pgvector as required, Redis, Azurite, Mailpit, and optional Langfuse profile'
      : 'Local development: Docker Compose with PostgreSQL, Redis, Azurite, and Mailpit',
    'Infrastructure: OpenTofu for Azure'
  ].join('\n');
}