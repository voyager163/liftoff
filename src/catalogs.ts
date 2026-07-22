import type {
  ApiStackDefinition,
  ApiStackId,
  EnvironmentDefinition,
  EnvironmentId,
  PatternDefinition,
  PatternId,
  ProviderDefinition,
  ProviderId,
  ProjectTypeDefinition,
  ProjectTypeId,
  RegionDefinition,
  SpecWorkflowDefinition,
  SpecWorkflowId
} from './types.js';

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

export const approvedStack = [
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

export const projectTypes: ProjectTypeDefinition[] = [
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

export const apiStacks: ApiStackDefinition[] = [
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

export const patterns: PatternDefinition[] = [
  {
    id: 'rag',
    label: 'RAG (Knowledge Retrieval)',
    aliases: ['rag', 'retrieval', 'knowledge', 'knowledge-retrieval'],
    description: 'Retrieval augmented generation with ingestion, embeddings, pgvector retrieval, and answer synthesis.',
    scaffoldStatus: 'full',
    frontendStarter: 'Retrieval/search interface',
    routePrefix: '/api/rag',
    worker: true
  },
  {
    id: 'chatbot',
    label: 'Chatbot / Conversational AI',
    aliases: ['chatbot', 'chat', 'conversational', 'conversational-ai'],
    description: 'Conversation APIs, message persistence, prompt templates, and PydanticAI chat orchestration.',
    scaffoldStatus: 'full',
    frontendStarter: 'Chat interface',
    routePrefix: '/api/chat',
    worker: false
  },
  {
    id: 'agent',
    label: 'Agent-based (Task Automation)',
    aliases: ['agent', 'agent-based', 'automation', 'task-automation'],
    description: 'Agent orchestration, tool boundaries, task execution routes, and background worker structure.',
    scaffoldStatus: 'full',
    frontendStarter: 'Task run console',
    routePrefix: '/api/agent',
    worker: true
  },
  {
    id: 'prompt',
    label: 'Prompt-based App (Simple LLM)',
    aliases: ['prompt', 'prompt-based', 'simple-llm', 'llm'],
    description: 'Named prompt templates, invocation API, and structured output validation examples.',
    scaffoldStatus: 'full',
    frontendStarter: 'Prompt playground',
    routePrefix: '/api/invoke',
    worker: false
  },
  {
    id: 'multi-agent',
    label: 'Multi-Agent System',
    aliases: ['multi-agent', 'multiagent', 'multi-agent-system'],
    description: 'Supervisor/worker coordination structure, agent roles, shared state boundaries, and run orchestration.',
    scaffoldStatus: 'foundation',
    frontendStarter: 'Agent run console',
    routePrefix: '/api/multi-agent',
    worker: true
  },
  {
    id: 'fine-tuned',
    label: 'Fine-tuned Model App',
    aliases: ['fine-tuned', 'finetuned', 'fine-tune', 'fine-tuning'],
    description: 'Endpoint configuration, invocation API, and evaluation dataset structure for deployed fine-tuned models.',
    scaffoldStatus: 'integration-shell',
    frontendStarter: 'Model invocation playground',
    routePrefix: '/api/fine-tuned',
    worker: false
  },
  {
    id: 'streaming',
    label: 'Real-time / Streaming AI',
    aliases: ['streaming', 'real-time', 'realtime', 'sse', 'websocket'],
    description: 'Streaming response routes and frontend-compatible streaming configuration.',
    scaffoldStatus: 'full',
    frontendStarter: 'Live response interface',
    routePrefix: '/api/stream',
    worker: false
  },
  {
    id: 'workflow',
    label: 'AI Workflow / Pipeline',
    aliases: ['workflow', 'pipeline', 'ai-workflow', 'ai-pipeline'],
    description: 'Pipeline stage structure, run persistence, trigger configuration, and worker structure.',
    scaffoldStatus: 'foundation',
    frontendStarter: 'Workflow run dashboard',
    routePrefix: '/api/workflows',
    worker: true
  }
];

export const providers: ProviderDefinition[] = [
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

export const azureRegions: RegionDefinition[] = [
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

export const environments: EnvironmentDefinition[] = [
  { id: 'dev', label: 'Development', description: 'Low-cost local and Azure development defaults.' },
  { id: 'test', label: 'Test', description: 'Production-like validation configuration with modest scale.' },
  { id: 'prod', label: 'Production', description: 'Production-oriented settings and stricter security controls.' }
];

export const specWorkflows: SpecWorkflowDefinition[] = [
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

export function getPattern(value: string): PatternDefinition | undefined {
  const normalized = normalize(value);
  return patterns.find((pattern) => normalize(pattern.id) === normalized || pattern.aliases.some((alias) => normalize(alias) === normalized));
}

export function getProjectType(value: string): ProjectTypeDefinition | undefined {
  const normalized = normalize(value);
  return projectTypes.find((projectType) => normalize(projectType.id) === normalized || normalize(projectType.label) === normalized);
}

export function getApiStack(value: string): ApiStackDefinition | undefined {
  const normalized = normalize(value);
  return apiStacks.find((stack) => normalize(stack.id) === normalized || stack.aliases.some((alias) => normalize(alias) === normalized));
}

export function getProvider(value: string): ProviderDefinition | undefined {
  const normalized = normalize(value);
  return providers.find((provider) => normalize(provider.id) === normalized || normalize(provider.label) === normalized);
}

export function getSpecWorkflow(value: string): SpecWorkflowDefinition | undefined {
  const normalized = normalize(value);
  return specWorkflows.find((workflow) => normalize(workflow.id) === normalized || normalize(workflow.label) === normalized);
}

export function getEnvironment(value: string): EnvironmentDefinition | undefined {
  const normalized = normalize(value);
  return environments.find((environment) => normalize(environment.id) === normalized || normalize(environment.label) === normalized);
}

export function getDefaultRegion(provider: ProviderId): RegionDefinition {
  if (provider !== 'azure') {
    throw new Error(`No default region catalog is available for planned provider ${provider}.`);
  }

  const region = azureRegions.find((candidate) => candidate.default);
  if (!region) {
    throw new Error('Azure region catalog is missing a default region.');
  }
  return region;
}

export function listRegions(provider: ProviderId): RegionDefinition[] {
  if (provider === 'azure') {
    return azureRegions;
  }
  return [];
}

export function searchRegions(provider: ProviderId, input: string): RegionDefinition[] {
  const normalized = normalize(input);
  if (!normalized) {
    return listRegions(provider);
  }

  return listRegions(provider).filter((region) => {
    const searchable = [region.slug, region.displayName, region.geography, ...region.aliases].map(normalize);
    return searchable.some((value) => value === normalized || value.includes(normalized));
  });
}

export type RegionResolution =
  | { status: 'resolved'; region: RegionDefinition }
  | { status: 'ambiguous'; matches: RegionDefinition[] }
  | { status: 'unknown'; input: string };

export function resolveRegion(provider: ProviderId, input?: string): RegionResolution {
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

export function isPatternId(value: string): value is PatternId {
  return patterns.some((pattern) => pattern.id === value);
}

export function isProjectTypeId(value: string): value is ProjectTypeId {
  return projectTypes.some((projectType) => projectType.id === value);
}

export function isApiStackId(value: string): value is ApiStackId {
  return apiStacks.some((stack) => stack.id === value);
}

export function isProviderId(value: string): value is ProviderId {
  return providers.some((provider) => provider.id === value);
}

export function isEnvironmentId(value: string): value is EnvironmentId {
  return environments.some((environment) => environment.id === value);
}

export function isSpecWorkflowId(value: string): value is SpecWorkflowId {
  return specWorkflows.some((workflow) => workflow.id === value);
}