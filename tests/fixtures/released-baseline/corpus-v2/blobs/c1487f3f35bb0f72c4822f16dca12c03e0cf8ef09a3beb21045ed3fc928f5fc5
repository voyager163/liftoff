import type {
  ApiStackDefinition,
  ApiStackId,
  CodingAgentDefinition,
  CodingAgentId,
  EnvironmentDefinition,
  EnvironmentId,
  PatternDefinition,
  PatternId,
  ProviderDefinition,
  ProviderId,
  ProjectTypeDefinition,
  ProjectTypeId,
  RegionDefinition,
  FrameworkDefinition,
  GovernanceProfileDefinition,
  SpecWorkflowDefinition,
  SpecWorkflowId
} from './contracts.js';
import {
  catalogKey as normalize,
  type ProjectInputCatalog
} from './inputs.js';

import type { RegionResolution } from './contracts.js';

export interface ProjectCatalogContext {
  frameworkVersions: Record<SpecWorkflowId, string>;
  governancePolicyVersion: string;
}

export function createProjectCatalog(context: ProjectCatalogContext) {
  const governancePolicyVersion = context.governancePolicyVersion;
  const approvedStack = [
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

  const projectTypes: ProjectTypeDefinition[] = [
    {
      id: 'genai',
      label: 'GenAI application',
      description: 'Python/FastAPI application with PydanticAI and a selected GenAI pattern.'
    },
    {
      id: 'standard',
      label: 'Standard application',
      description: 'Non-GenAI API application using an approved Python, Node.js, or Go stack.'
    }
  ];

  const apiStacks: ApiStackDefinition[] = [
    {
      id: 'python-fastapi',
      label: 'Python / FastAPI',
      aliases: ['python', 'py', 'fastapi', 'python-fastapi'],
      language: 'Python',
      framework: 'FastAPI',
      databaseTooling: 'SQLAlchemy + Alembic',
      testFramework: 'pytest'
    },
    {
      id: 'node-fastify',
      label: 'Node.js / Fastify / TypeScript',
      aliases: ['node', 'nodejs', 'node.js', 'fastify', 'typescript', 'node-fastify'],
      language: 'Node.js',
      framework: 'Fastify with TypeScript',
      databaseTooling: 'Drizzle',
      testFramework: 'Vitest'
    },
    {
      id: 'go-huma',
      label: 'Go / Huma / Chi',
      aliases: ['go', 'golang', 'huma', 'chi', 'go-huma'],
      language: 'Go',
      framework: 'Huma v2 with Chi',
      databaseTooling: 'pgx + Goose',
      testFramework: 'go test'
    }
  ];

  const patterns: PatternDefinition[] = [
    {
      id: 'generic',
      label: 'Generic GenAI Starter',
      aliases: ['generic', 'undecided', 'unsure', 'not-sure'],
      description: 'General FastAPI/PydanticAI request-response foundation without specialized orchestration.',
      scaffoldStatus: 'foundation',
      frontendStarter: 'Generic AI playground',
      routePrefix: '/api/ai',
      worker: false,
      requiresVectorStore: false
    },
    {
      id: 'rag',
      label: 'RAG (Knowledge Retrieval)',
      aliases: ['rag', 'retrieval', 'knowledge', 'knowledge-retrieval'],
      description: 'RAG integration foundation with query, ingestion, and vector-store boundaries; retrieval and citation generation are deferred.',
      scaffoldStatus: 'foundation',
      frontendStarter: 'RAG foundation interface',
      routePrefix: '/api/rag',
      worker: true,
      requiresVectorStore: true
    },
    {
      id: 'chatbot',
      label: 'Chatbot / Conversational AI',
      aliases: ['chatbot', 'chat', 'conversational', 'conversational-ai'],
      description: 'Conversational request-response foundation; message history, persistence, and memory are deferred.',
      scaffoldStatus: 'foundation',
      frontendStarter: 'Chat foundation interface',
      routePrefix: '/api/chat',
      worker: false,
      requiresVectorStore: false
    },
    {
      id: 'agent',
      label: 'Agent-based (Task Automation)',
      aliases: ['agent', 'agent-based', 'automation', 'task-automation'],
      description: 'Agent invocation and worker foundation; tools and task execution are deferred.',
      scaffoldStatus: 'foundation',
      frontendStarter: 'Agent foundation interface',
      routePrefix: '/api/agent',
      worker: true,
      requiresVectorStore: false
    },
    {
      id: 'prompt',
      label: 'Prompt-based App (Simple LLM)',
      aliases: ['prompt', 'prompt-based', 'simple-llm', 'llm'],
      description: 'Prompt invocation foundation; external prompt loading and specialized structured-output workflows are deferred.',
      scaffoldStatus: 'foundation',
      frontendStarter: 'Prompt foundation interface',
      routePrefix: '/api/invoke',
      worker: false,
      requiresVectorStore: false
    },
    {
      id: 'multi-agent',
      label: 'Multi-Agent System',
      aliases: ['multi-agent', 'multiagent', 'multi-agent-system'],
      description: 'Multi-agent invocation and worker foundation; supervisor-worker coordination and shared orchestration are deferred.',
      scaffoldStatus: 'foundation',
      frontendStarter: 'Multi-agent foundation interface',
      routePrefix: '/api/multi-agent',
      worker: true,
      requiresVectorStore: false
    },
    {
      id: 'fine-tuned',
      label: 'Fine-tuned Model App',
      aliases: ['fine-tuned', 'finetuned', 'fine-tune', 'fine-tuning'],
      description: 'Fine-tuned endpoint and evaluation-data foundation; training, fine-tuning, and model deployment are deferred.',
      scaffoldStatus: 'foundation',
      frontendStarter: 'Fine-tuned model foundation interface',
      routePrefix: '/api/fine-tuned',
      worker: false,
      requiresVectorStore: false
    },
    {
      id: 'streaming',
      label: 'Real-time / Streaming AI',
      aliases: ['streaming', 'real-time', 'realtime', 'sse', 'websocket'],
      description: 'Buffered SSE response foundation; incremental model streaming is deferred.',
      scaffoldStatus: 'foundation',
      frontendStarter: 'Buffered SSE foundation interface',
      routePrefix: '/api/stream',
      worker: false,
      requiresVectorStore: false
    },
    {
      id: 'workflow',
      label: 'AI Workflow / Pipeline',
      aliases: ['workflow', 'pipeline', 'ai-workflow', 'ai-pipeline'],
      description: 'Workflow invocation and worker foundation; pipeline execution, trigger orchestration, and run persistence are deferred.',
      scaffoldStatus: 'foundation',
      frontendStarter: 'Workflow foundation interface',
      routePrefix: '/api/workflows',
      worker: true,
      requiresVectorStore: false
    }
  ];

  const providers: ProviderDefinition[] = [
    {
      id: 'azure',
      label: 'Azure',
      status: 'available',
      description: 'Complete V1 provider with Azure OpenTofu infrastructure.'
    },
    {
      id: 'aws',
      label: 'AWS',
      status: 'planned',
      description: 'Planned provider adapter; not available for V1 generation.'
    },
    {
      id: 'gcp',
      label: 'GCP',
      status: 'planned',
      description: 'Planned provider adapter; not available for V1 generation.'
    }
  ];

  const azureRegions: RegionDefinition[] = [
    {
      provider: 'azure',
      slug: 'eastus',
      displayName: 'East US',
      geography: 'United States',
      aliases: ['east us', 'eastus', 'virginia', 'us east'],
      default: true
    },
    {
      provider: 'azure',
      slug: 'eastus2',
      displayName: 'East US 2',
      geography: 'United States',
      aliases: ['east us 2', 'eastus2', 'us east 2']
    },
    {
      provider: 'azure',
      slug: 'westus2',
      displayName: 'West US 2',
      geography: 'United States',
      aliases: ['west us 2', 'westus2', 'us west 2']
    },
    {
      provider: 'azure',
      slug: 'westeurope',
      displayName: 'West Europe',
      geography: 'Europe',
      aliases: ['west europe', 'westeurope', 'netherlands', 'amsterdam']
    },
    {
      provider: 'azure',
      slug: 'southeastasia',
      displayName: 'Southeast Asia',
      geography: 'Asia Pacific',
      aliases: ['southeast asia', 'southeastasia', 'singapore']
    },
    {
      provider: 'azure',
      slug: 'koreacentral',
      displayName: 'Korea Central',
      geography: 'Korea',
      aliases: ['korea', 'korea central', 'koreacentral', 'seoul']
    },
    {
      provider: 'azure',
      slug: 'koreasouth',
      displayName: 'Korea South',
      geography: 'Korea',
      aliases: ['korea', 'korea south', 'koreasouth', 'busan']
    }
  ];

  const canonicalDefaultEnvironmentIds = [
    'dev',
    'staging',
    'prod'
  ] as const satisfies readonly EnvironmentId[];

  const environments: EnvironmentDefinition[] = [
    { id: 'dev', label: 'Development', description: 'Low-cost local and Azure development defaults.' },
    { id: 'staging', label: 'Staging', description: 'Production-like validation configuration with modest scale.' },
    { id: 'prod', label: 'Production', description: 'Production-oriented settings and stricter security controls.' }
  ];

  const canonicalDefaultEnvironments: EnvironmentDefinition[] =
    canonicalDefaultEnvironmentIds.map((id) => {
      const environment = environments.find((candidate) => candidate.id === id);
      if (!environment) {
        throw new Error(`Default environment ${id} is missing from the environment catalog.`);
      }
      return environment;
    });

  const specWorkflows: SpecWorkflowDefinition[] = [
    {
      id: 'openspec',
      label: 'OpenSpec',
      default: true,
      description: 'Generate OpenSpec config, specs, changes, and a seed bootstrap change.'
    },
    {
      id: 'spec-kit',
      label: 'Spec Kit',
      default: false,
      description: 'Generate Spec Kit constitution and supporting templates.'
    }
  ];

  const governanceProfiles: GovernanceProfileDefinition[] = [
    {
      id: 'single-maintainer-gitflow',
      label: 'Single-maintainer GitFlow',
      description: 'Generate the versioned local repository-governance handoff; live activation is deferred.',
      default: true,
      policyVersion: governancePolicyVersion
    },
    {
      id: 'none',
      label: 'None',
      description: 'Do not generate repository-governance handoff artifacts.',
      default: false
    }
  ];

  const codingAgents: CodingAgentDefinition[] = [
    {
      id: 'github-copilot',
      inputName: 'copilot',
      label: 'GitHub Copilot',
      aliases: ['copilot', 'github-copilot', 'github copilot', 'gh-copilot'],
      executable: 'copilot',
      integrationIds: {
        openspec: 'github-copilot',
        'spec-kit': 'copilot'
      }
    },
    {
      id: 'claude',
      inputName: 'claude',
      label: 'Claude Code',
      aliases: ['claude', 'claude-code', 'claude code'],
      executable: 'claude',
      integrationIds: {
        openspec: 'claude',
        'spec-kit': 'claude'
      }
    }
  ];

  const frameworkDefinitions: Record<SpecWorkflowId, FrameworkDefinition> = {
    openspec: {
      id: 'openspec',
      executable: 'openspec',
      version: context.frameworkVersions.openspec,
      installCommand: {
        executable: 'npm',
        args: ['install', '-g', `@fission-ai/openspec@${context.frameworkVersions.openspec}`]
      },
      allowedRoots: ['.claude', '.github', 'openspec'],
      baseMarkers: [['openspec', 'config.yaml']],
      agentMarkers: {
        'github-copilot': [['.github', 'skills', 'openspec-apply-change', 'SKILL.md']],
        claude: [['.claude', 'skills', 'openspec-apply-change', 'SKILL.md']]
      }
    },
    'spec-kit': {
      id: 'spec-kit',
      executable: 'specify',
      version: context.frameworkVersions['spec-kit'],
      installCommand: {
        executable: 'uv',
        args: ['tool', 'install', `specify-cli==${context.frameworkVersions['spec-kit']}`]
      },
      allowedRoots: ['.claude', '.github', '.specify', 'specs'],
      baseMarkers: [
        ['.specify', 'init-options.json'],
        ['.specify', 'integration.json']
      ],
      agentMarkers: {
        'github-copilot': [['.github', 'skills', 'speckit-specify', 'SKILL.md']],
        claude: [['.claude', 'skills', 'speckit-specify', 'SKILL.md']]
      }
    }
  };

  function getPattern(value: string): PatternDefinition | undefined {
    const normalized = normalize(value);
    return patterns.find((pattern) => normalize(pattern.id) === normalized || pattern.aliases.some((alias) => normalize(alias) === normalized));
  }

  function getProjectType(value: string): ProjectTypeDefinition | undefined {
    const normalized = normalize(value);
    return projectTypes.find((projectType) => normalize(projectType.id) === normalized || normalize(projectType.label) === normalized);
  }

  function getApiStack(value: string): ApiStackDefinition | undefined {
    const normalized = normalize(value);
    return apiStacks.find((stack) => normalize(stack.id) === normalized || stack.aliases.some((alias) => normalize(alias) === normalized));
  }

  function getProvider(value: string): ProviderDefinition | undefined {
    const normalized = normalize(value);
    return providers.find((provider) => normalize(provider.id) === normalized || normalize(provider.label) === normalized);
  }

  function getSpecWorkflow(value: string): SpecWorkflowDefinition | undefined {
    const normalized = normalize(value);
    return specWorkflows.find((workflow) => normalize(workflow.id) === normalized || normalize(workflow.label) === normalized);
  }

  function getGovernanceProfile(
    value: string
  ): GovernanceProfileDefinition | undefined {
    const normalized = normalize(value);
    return governanceProfiles.find((profile) =>
      normalize(profile.id) === normalized ||
      normalize(profile.label) === normalized
    );
  }

  function getCodingAgent(value: string): CodingAgentDefinition | undefined {
    const normalized = normalize(value);
    return codingAgents.find((agent) =>
      normalize(agent.id) === normalized ||
      normalize(agent.inputName) === normalized ||
      agent.aliases.some((alias) => normalize(alias) === normalized)
    );
  }

  function getFrameworkDefinition(value: SpecWorkflowId): FrameworkDefinition {
    return frameworkDefinitions[value];
  }

  function canonicalizeCodingAgents(values?: string[]): {
    agents: CodingAgentDefinition[];
    unknown: string[];
  } {
    const selected = values === undefined ? ['github-copilot'] : values;
    const ids = new Set<CodingAgentId>();
    const unknown: string[] = [];
    for (const value of selected) {
      const agent = getCodingAgent(value);
      if (agent) {
        ids.add(agent.id);
      } else {
        unknown.push(value);
      }
    }
    return {
      agents: codingAgents.filter((agent) => ids.has(agent.id)),
      unknown
    };
  }

  function getEnvironment(value: string): EnvironmentDefinition | undefined {
    const normalized = normalize(value);
    return environments.find((environment) => normalize(environment.id) === normalized || normalize(environment.label) === normalized);
  }

  function getDefaultRegion(provider: ProviderId): RegionDefinition {
    if (provider !== 'azure') {
      throw new Error(`No default region catalog is available for planned provider ${provider}.`);
    }

    const region = azureRegions.find((candidate) => candidate.default);
    if (!region) {
      throw new Error('Azure region catalog is missing a default region.');
    }
    return region;
  }

  function listRegions(provider: ProviderId): RegionDefinition[] {
    if (provider === 'azure') {
      return azureRegions;
    }
    return [];
  }

  function searchRegions(provider: ProviderId, input: string): RegionDefinition[] {
    const normalized = normalize(input);
    if (!normalized) {
      return listRegions(provider);
    }

    return listRegions(provider).filter((region) => {
      const searchable = [region.slug, region.displayName, region.geography, ...region.aliases].map(normalize);
      return searchable.some((value) => value === normalized || value.includes(normalized));
    });
  }

  function resolveRegion(provider: ProviderId, input?: string): RegionResolution {
    if (!input || input.trim().length === 0) {
      return { status: 'resolved', region: getDefaultRegion(provider) };
    }

    const normalized = normalize(input);
    const exact = listRegions(provider).find((region) => normalize(region.slug) === normalized);
    if (exact) {
      return { status: 'resolved', region: exact };
    }

    const matches = searchRegions(provider, input);
    if (matches.length === 1) {
      return { status: 'resolved', region: matches[0] };
    }
    if (matches.length > 1) {
      return { status: 'ambiguous', matches };
    }
    return { status: 'unknown', input };
  }

  function isPatternId(value: string): value is PatternId {
    return patterns.some((pattern) => pattern.id === value);
  }

  function isProjectTypeId(value: string): value is ProjectTypeId {
    return projectTypes.some((projectType) => projectType.id === value);
  }

  function isApiStackId(value: string): value is ApiStackId {
    return apiStacks.some((stack) => stack.id === value);
  }

  function isProviderId(value: string): value is ProviderId {
    return providers.some((provider) => provider.id === value);
  }

  function isEnvironmentId(value: string): value is EnvironmentId {
    return environments.some((environment) => environment.id === value);
  }

  function isSpecWorkflowId(value: string): value is SpecWorkflowId {
    return specWorkflows.some((workflow) => workflow.id === value);
  }

  function isCodingAgentId(value: string): value is CodingAgentId {
    return codingAgents.some((agent) => agent.id === value);
  }

  const projectInputCatalog: ProjectInputCatalog = {
    getProjectType,
    getApiStack,
    getPattern,
    getProvider,
    getSpecWorkflow,
    getGovernanceProfile,
    getCodingAgent,
    getEnvironment
  };
  return {
    approvedStack,
    projectTypes,
    apiStacks,
    patterns,
    providers,
    azureRegions,
    canonicalDefaultEnvironmentIds,
    environments,
    canonicalDefaultEnvironments,
    specWorkflows,
    governanceProfiles,
    codingAgents,
    frameworkDefinitions,
    getPattern,
    getProjectType,
    getApiStack,
    getProvider,
    getSpecWorkflow,
    getGovernanceProfile,
    getCodingAgent,
    getFrameworkDefinition,
    canonicalizeCodingAgents,
    getEnvironment,
    getDefaultRegion,
    listRegions,
    searchRegions,
    resolveRegion,
    isPatternId,
    isProjectTypeId,
    isApiStackId,
    isProviderId,
    isEnvironmentId,
    isSpecWorkflowId,
    isCodingAgentId,
    projectInputCatalog,
  };
}

export type ProjectCatalog = ReturnType<typeof createProjectCatalog>;
