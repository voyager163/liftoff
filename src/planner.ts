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
  getGovernanceProfile,
  getPattern,
  getProvider,
  getProjectType,
  getSpecWorkflow,
  powerAppsCodeAppStarter,
  governanceProfiles,
  resolveRegion,
  specWorkflows
} from './catalogs.js';
import type {
  EnvironmentDefinition,
  ProjectOptions,
  ProjectPlan,
  WorkloadPlan
} from './types.js';

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
  'defaultAgent',
  'codeAppsPlugin',
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
  const governanceProfile = resolveConfigCatalogValue(
    parsed,
    'governanceProfile',
    getGovernanceProfile
  );

  const includeFrontendValue = parsed.includeFrontend;
  if (includeFrontendValue !== undefined && typeof includeFrontendValue !== 'boolean') {
    throw new PlanValidationError(['Configuration field includeFrontend must be a boolean.']);
  }
  const codeAppsPluginValue = parsed.codeAppsPlugin;
  if (codeAppsPluginValue !== undefined && typeof codeAppsPluginValue !== 'boolean') {
    throw new PlanValidationError(['Configuration field codeAppsPlugin must be a boolean.']);
  }

  if (projectType === 'power-apps-code-app') {
    const inapplicable = ['apiStack', 'pattern', 'cloud', 'region', 'includeFrontend', 'environments']
      .filter((field) => Object.hasOwn(parsed, field));
    if (inapplicable.length > 0) {
      throw new PlanValidationError([
        `Power Apps code app configuration cannot include: ${inapplicable.join(', ')}.`
      ]);
    }
  } else if (projectType && Object.hasOwn(parsed, 'codeAppsPlugin')) {
    throw new PlanValidationError([
      'Configuration field codeAppsPlugin is only valid for Power Apps code apps.'
    ]);
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
    codeAppsPlugin: codeAppsPluginValue,
    governanceProfile
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

  const explicitProjectType = input.projectType ? getProjectType(input.projectType) : undefined;
  if (input.projectType && !explicitProjectType) {
    issues.push(`Unknown project type: ${input.projectType}.`);
  }
  const inferredTypeSignals = [
    input.genai === undefined ? undefined : input.genai ? 'genai' : 'standard',
    input.pattern ? 'genai' : undefined,
    input.apiStack && !input.pattern && input.genai !== true && explicitProjectType?.id !== 'genai'
      ? 'standard'
      : undefined
  ].filter((value): value is 'genai' | 'standard' => value !== undefined);
  const uniqueTypeSignals = [...new Set(inferredTypeSignals)];
  if (uniqueTypeSignals.length > 1) {
    issues.push('Project type inputs conflict: GenAI pattern/flags cannot be combined with standard API inputs.');
  }
  if (
    explicitProjectType &&
    uniqueTypeSignals.some((signal) => signal !== explicitProjectType.id)
  ) {
    issues.push(
      `Project type ${explicitProjectType.id} conflicts with legacy project-type, pattern, or API-stack inputs.`
    );
  }
  const inferredProjectType = explicitProjectType?.id ?? uniqueTypeSignals[0];
  const projectType = inferredProjectType ? getProjectType(inferredProjectType) : undefined;
  if (!projectType) {
    if (!input.projectType) {
      issues.push('Project type is required.');
    }
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
  } else if (projectType?.id === 'power-apps-code-app') {
    const inapplicable = [
      input.apiStack ? '--api' : undefined,
      input.pattern ? '--pattern' : undefined,
      input.cloud ? '--cloud' : undefined,
      input.region ? '--region' : undefined,
      input.includeFrontend !== undefined ? '--frontend/--no-frontend' : undefined,
      input.environments !== undefined ? '--environments' : undefined
    ].filter((value): value is string => value !== undefined);
    if (inapplicable.length > 0) {
      issues.push(
        `Power Apps code apps do not use API, cloud, frontend, or API-environment options. Remove: ${inapplicable.join(', ')}.`
      );
    }
    apiStack = undefined;
  }
  if (projectType?.id !== 'power-apps-code-app' && input.codeAppsPlugin !== undefined) {
    issues.push('The Code Apps plugin preference is only valid for Power Apps code apps.');
  }

  const provider = projectType?.id === 'power-apps-code-app'
    ? undefined
    : getProvider(input.cloud ?? 'azure');
  if (projectType?.id !== 'power-apps-code-app') {
    if (!provider) {
      issues.push(`Unknown cloud provider: ${input.cloud}.`);
    } else if (provider.status !== 'available') {
      issues.push(`${provider.label} is a planned provider adapter and is not available in V1.`);
    }
  }

  const specWorkflow = getSpecWorkflow(input.specWorkflow ?? specWorkflows.find((workflow) => workflow.default)?.id ?? 'openspec');
  if (!specWorkflow) {
    issues.push(`Unknown spec-driven workflow: ${input.specWorkflow}.`);
  }
  const governanceProfile = getGovernanceProfile(
    input.governanceProfile ??
      governanceProfiles.find((profile) => profile.default)?.id ??
      'single-maintainer-gitflow'
  );
  if (!governanceProfile) {
    issues.push(
      `Unknown repository governance profile: ${input.governanceProfile}. ` +
      `Use one of: ${governanceProfiles.map((profile) => profile.id).join(', ')}.`
    );
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
  const includesGitHubCopilot = selectedAgents.agents.some((agent) => agent.id === 'github-copilot');
  if (
    input.copilotCloud !== undefined &&
    (specWorkflow?.id !== 'openspec' || !includesGitHubCopilot)
  ) {
    issues.push(
      '--copilot-cloud/--no-copilot-cloud requires OpenSpec with GitHub Copilot selected.'
    );
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

  const selectedEnvironments = projectType?.id === 'power-apps-code-app'
    ? undefined
    : resolveEnvironments(input.environments);
  if (selectedEnvironments?.issues.length) {
    issues.push(...selectedEnvironments.issues);
  }

  const regionResolution = provider?.status === 'available'
    ? resolveRegion(provider.id, input.region)
    : undefined;
  if (regionResolution?.status === 'ambiguous') {
    issues.push(`Region "${input.region}" is ambiguous for ${provider?.label}. Use one of: ${regionResolution.matches.map((region) => region.slug).join(', ')}.`);
  } else if (regionResolution?.status === 'unknown') {
    issues.push(`Unknown region "${regionResolution.input}" for ${provider?.label}.`);
  }

  if (
    issues.length > 0 ||
    !projectName && options.requireProjectName ||
    !projectType ||
    !specWorkflow ||
    !governanceProfile ||
    selectedAgents.agents.length === 0 ||
    projectType.id !== 'power-apps-code-app' && (
      !apiStack ||
      projectType.id === 'genai' && !pattern ||
      !provider ||
      provider.status !== 'available' ||
      !selectedEnvironments ||
      !regionResolution ||
      regionResolution.status !== 'resolved'
    )
  ) {
    throw new PlanValidationError(issues);
  }

  const effectiveProjectName = projectName || 'liftoff-preview';
  const safeProjectName = toSafeProjectName(effectiveProjectName);

  let workload: WorkloadPlan;
  if (projectType.id === 'power-apps-code-app') {
    workload = {
      workload: 'power-apps-code-app',
      starter: powerAppsCodeAppStarter,
      codeAppsPlugin: input.codeAppsPlugin ?? false
    };
  } else {
    if (
      !apiStack ||
      !provider ||
      !selectedEnvironments ||
      !regionResolution ||
      regionResolution.status !== 'resolved'
    ) {
      throw new PlanValidationError(['API workload planning did not resolve all required fields.']);
    }
    if (projectType.id === 'genai') {
      if (!pattern) {
        throw new PlanValidationError(['GenAI pattern is required.']);
      }
      workload = {
        workload: 'genai',
        apiStack,
        pattern,
        provider,
        region: regionResolution.region,
        includeFrontend: input.includeFrontend ?? false,
        frontendStarter: pattern.frontendStarter,
        environments: selectedEnvironments.values
      };
    } else {
      workload = {
        workload: 'standard',
        apiStack,
        provider,
        region: regionResolution.region,
        includeFrontend: input.includeFrontend ?? false,
        frontendStarter: 'API starter',
        environments: selectedEnvironments.values
      };
    }
  }

  return {
    projectName: effectiveProjectName,
    safeProjectName,
    packageName: safeProjectName.replace(/_/g, '-'),
    projectType,
    ...workload,
    specWorkflow,
    agents: selectedAgents.agents,
    ...(defaultAgent ? { defaultAgent } : {}),
    copilotCloud: specWorkflow.id === 'openspec' && includesGitHubCopilot
      ? input.copilotCloud ?? false
      : false,
    framework: getFrameworkDefinition(specWorkflow.id),
    governanceProfile,
    approvedStack: approvedStackFor(workload)
  };
}

function approvedStackFor(workload: WorkloadPlan): string[] {
  if (workload.workload === 'power-apps-code-app') {
    return [
      'React',
      'Vite',
      'TypeScript',
      'Tailwind CSS',
      'Power Apps SDK',
      'Power Apps Vite plugin'
    ];
  }
  if (workload.workload === 'genai') {
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

  const stackSpecific: Record<typeof workload.apiStack.id, string[]> = {
    'python-fastapi': ['FastAPI', 'Pydantic settings', 'SQLAlchemy', 'Alembic', 'pytest'],
    'node-fastify': ['Fastify', 'TypeScript', 'Drizzle', 'Vitest'],
    'go-huma': ['Huma v2', 'Chi', 'pgx', 'Goose', 'go test']
  };
  return [
    ...stackSpecific[workload.apiStack.id],
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

export interface ProjectPlanEntry {
  label: string;
  value: string;
}

export function projectPlanEntries(plan: ProjectPlan): ProjectPlanEntry[] {
  const common = [
    { label: 'Project', value: plan.projectName },
    { label: 'Project type', value: plan.projectType.label }
  ];
  const integrations = [
    { label: 'Spec workflow', value: plan.specWorkflow.label },
    { label: 'Coding agents', value: plan.agents.map((agent) => agent.label).join(', ') },
    ...(plan.defaultAgent ? [{ label: 'Default agent', value: plan.defaultAgent.label }] : []),
    ...(plan.specWorkflow.id === 'openspec'
      ? [{ label: 'OpenSpec workflows', value: '12 workflows; skills and commands' }]
      : []),
    ...(plan.specWorkflow.id === 'openspec' &&
      plan.agents.some((agent) => agent.id === 'github-copilot')
      ? [{
          label: 'Copilot cloud agent',
          value: plan.copilotCloud ? 'Enabled' : 'Disabled (default)'
        }]
      : [])
  ];
  const governance = plan.governanceProfile.id === 'none'
    ? [{
        label: 'Repository governance',
        value: 'Disabled; no local handoff or remote action'
      }]
    : [
        {
          label: 'Repository governance',
          value: `${plan.governanceProfile.label} policy ${plan.governanceProfile.policyVersion}`
        },
        {
          label: 'Governance handoff',
          value: 'Local handoff generated; live enforcement is not active'
        },
        {
          label: 'Governance setup integrations',
          value: plan.agents.map((agent) =>
            agent.id === 'github-copilot'
              ? '.github/prompts/liftoff-setup.prompt.md'
              : '.claude/commands/liftoff-setup.md'
          ).join(', ')
        },
        {
          label: 'Governance activation',
          value: 'Deferred until commit, push, read-only Phase 0, and explicit plan approval'
        }
      ];
  if (plan.workload === 'power-apps-code-app') {
    return [
      ...common,
      {
        label: 'Official starter',
        value: `${plan.starter.repository}/${plan.starter.path} @ ${plan.starter.commit}`
      },
      { label: 'Root application stack', value: plan.approvedStack.join(', ') },
      ...integrations,
      ...governance,
      {
        label: 'Code Apps plugin',
        value: plan.codeAppsPlugin ? 'Requested (Preview)' : 'Not requested'
      },
      { label: 'Project dependencies', value: 'npm ci' },
      { label: 'Environment binding', value: 'Deferred: npx --no-install power-apps init' },
      { label: 'Infrastructure', value: 'Managed by Power Platform; no Liftoff-owned API or Azure infrastructure' }
    ];
  }
  const frontendLine = plan.includeFrontend
    ? `Vue 3 + Tailwind (${plan.frontendStarter})`
    : 'Not generated';
  return [
    ...common,
    plan.workload === 'genai'
      ? { label: 'Pattern', value: `${plan.pattern.label} (${plan.pattern.scaffoldStatus})` }
      : { label: 'API stack', value: plan.apiStack.label },
    { label: 'Cloud', value: plan.provider.label },
    { label: 'Region', value: `${plan.region.displayName} / ${plan.region.slug}` },
    { label: 'Frontend', value: frontendLine },
    ...integrations,
    ...governance,
    { label: 'Environments', value: plan.environments.map((environment) => environment.id).join(', ') },
    { label: 'Approved stack', value: plan.approvedStack.join(', ') },
    {
      label: 'Local development',
      value: plan.workload === 'genai'
        ? 'Docker Compose with PostgreSQL/pgvector as required, Redis, Azurite, Mailpit, and optional Langfuse profile'
        : 'Docker Compose with PostgreSQL, Redis, Azurite, and Mailpit'
    },
    { label: 'Infrastructure', value: 'OpenTofu for Azure' }
  ];
}

export function formatProjectPlan(plan: ProjectPlan): string {
  return projectPlanEntries(plan)
    .map((entry) => `${entry.label}: ${entry.value}`)
    .join('\n');
}