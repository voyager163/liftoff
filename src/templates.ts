import { createHash } from 'node:crypto';
import { addGenAiExtensionArtifacts } from './genai-templates.js';
import {
  addStandardStackArtifacts,
  renderStandardDockerfile,
  renderStandardEnv
} from './standard-templates.js';
import type { AddArtifact } from './template-types.js';
import type { GeneratedArtifact, LiftoffManifest, PatternDefinition, ProjectPlan } from './types.js';
import { liftoffVersion } from './version.js';

const contentHash = (content: string) => `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
const DEFAULT_FUNCTION_WORKER_QUEUE_NAME = 'events';

export const AZURE_NAME_LIMITS = {
  resourceGroup: 90,
  containerRegistry: 50,
  identity: 128,
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

const boundedToken = (value: string, length: number) =>
  value.slice(0, length).replace(/-+$/g, '') || 'app';

export function buildAzureResourceNames(
  plan: ProjectPlan,
  environment: string,
  resourceSuffix: string
): AzureResourceNames {
  const workload = boundedToken(plan.safeProjectName, 12);
  const compactWorkload = boundedToken(plan.safeProjectName.replace(/-/g, ''), 8);
  return {
    resourceGroup: `rg-${workload}-${environment}`,
    containerRegistry: `acr${compactWorkload}${resourceSuffix}`,
    identity: `id-${workload}-${environment}`,
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
    keyVault: `kv-${compactWorkload}-${resourceSuffix}`
  };
}

function stableResourceSuffix(plan: ProjectPlan, environment: string): string {
  return createHash('sha256')
    .update(`${plan.safeProjectName}:${environment}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
}

const pyModule = (value: string) => value.replace(/-/g, '_');
const titleCase = (value: string) => value.replace(/(^|[-_\s])([a-z])/g, (_match, prefix: string, letter: string) => `${prefix ? ' ' : ''}${letter.toUpperCase()}`).trim();
const sourceString = (value: string) => JSON.stringify(value);
const scriptSourceString = (value: string) => sourceString(value).replaceAll('<', '\\u003c');
const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const genAiPattern = (plan: ProjectPlan): PatternDefinition => {
  if (plan.projectType.id !== 'genai' || !plan.pattern) {
    throw new Error('GenAI template rendering requires a GenAI pattern.');
  }
  return plan.pattern;
};
const hasFunctionWorker = (plan: ProjectPlan) =>
  plan.projectType.id === 'genai' && plan.provider.id === 'azure' && genAiPattern(plan).worker;
const functionWorkerName = (plan: ProjectPlan) => `${genAiPattern(plan).id}-worker`;

export function buildArtifacts(plan: ProjectPlan): GeneratedArtifact[] {
  const artifacts: GeneratedArtifact[] = [];
  const add: AddArtifact = (logicalName, category, pathParts, content) => {
    artifacts.push({ logicalName, category, pathParts, content: ensureTrailingNewline(content) });
  };

  addBaseArtifacts(add, plan);
  if (plan.projectType.id === 'genai') {
    addGenAiExtensionArtifacts(add, plan, {
      backend: addBackendArtifacts,
      database: addDatabaseArtifacts,
      pattern: addPatternArtifacts,
      functions: addFunctionArtifacts
    });
  } else {
    addStandardStackArtifacts(add, plan);
  }
  addEnvironmentArtifacts(add, plan);
  addDockerArtifacts(add, plan);
  addInfrastructureArtifacts(add, plan);
  addGovernanceArtifacts(add, plan);
  if (plan.includeFrontend) {
    addFrontendArtifacts(add, plan);
  }

  const manifest = buildManifest(plan, artifacts);
  artifacts.push({
    logicalName: 'manifest',
    category: 'manifest',
    pathParts: ['liftoff.manifest.json'],
    content: `${JSON.stringify(manifest, null, 2)}\n`
  });

  return artifacts;
}

export function buildManifest(plan: ProjectPlan, artifacts: GeneratedArtifact[]): LiftoffManifest {
  return {
    artifactVersion: 2,
    generatedBy: 'Mission Control Liftoff',
    liftoffVersion,
    project: {
      name: plan.projectName,
      projectType: plan.projectType.id,
      apiStack: plan.apiStack.id,
      ...(plan.pattern ? { pattern: plan.pattern.id } : {}),
      cloud: plan.provider.id,
      region: plan.region.slug,
      frontend: plan.includeFrontend,
      specWorkflow: plan.specWorkflow.id,
      environments: plan.environments.map((environment) => environment.id)
    },
    artifacts: artifacts
      .filter((artifact) => artifact.category !== 'seed') // seed content is written once, never tracked
      .map((artifact) => ({
        logicalName: artifact.logicalName,
        category: artifact.category,
        pathParts: artifact.pathParts,
        contentHash: contentHash(artifact.content)
      }))
  };
}

function addBaseArtifacts(add: AddArtifact, plan: ProjectPlan): void {
  add('root-readme', 'documentation', ['README.md'], renderRootReadme(plan));
  add('root-gitignore', 'project', ['.gitignore'], renderGeneratedGitignore());
  add('liftoff-config', 'project', ['liftoff.config.json'], JSON.stringify({
    projectName: plan.projectName,
    projectType: plan.projectType.id,
    apiStack: plan.apiStack.id,
    ...(plan.pattern ? { pattern: plan.pattern.id } : {}),
    cloud: plan.provider.id,
    region: plan.region.slug,
    includeFrontend: plan.includeFrontend,
    environments: plan.environments.map((environment) => environment.id),
    specWorkflow: plan.specWorkflow.id
  }, null, 2));
  add('env-example', 'configuration', ['.env.example'], renderEnvExample(plan));
  add(
    'backend-dockerfile',
    'runtime',
    ['Dockerfile'],
    plan.projectType.id === 'genai' ? renderBackendDockerfile() : renderStandardDockerfile(plan)
  );
}

function addBackendArtifacts(add: AddArtifact, plan: ProjectPlan): void {
  const routeModule = pyModule(genAiPattern(plan).id);
  add('backend-pyproject', 'backend', ['backend', 'pyproject.toml'], renderBackendPyproject(plan));
  add('backend-package', 'backend', ['backend', '__init__.py'], '');
  add('backend-api-package', 'backend', ['backend', 'apis', '__init__.py'], '');
  add('backend-main', 'backend', ['backend', 'apis', 'main.py'], renderFastApiMain(plan, routeModule));
  add('backend-health-routes', 'backend', ['backend', 'apis', 'routes', 'health.py'], renderHealthRoutes());
  add('backend-pattern-routes', 'backend', ['backend', 'apis', 'routes', `${routeModule}.py`], renderPatternRoutes(plan));
  add('backend-routes-package', 'backend', ['backend', 'apis', 'routes', '__init__.py'], '');
  add('backend-auth-dependency', 'backend', ['backend', 'apis', 'dependencies', 'auth.py'], renderAuthDependency());
  add('backend-config-package', 'backend', ['backend', 'config', '__init__.py'], '');
  add('backend-settings', 'backend', ['backend', 'config', 'settings.py'], renderSettings(plan));
  add('backend-orchestration-package', 'backend', ['backend', 'orchestration', '__init__.py'], '');
  add('backend-model-config', 'backend', ['backend', 'orchestration', 'model_config.py'], renderModelConfig(plan));
  add('backend-messaging-tool', 'backend', ['backend', 'orchestration', 'tools', 'messaging.py'], renderMessagingBoundary());
  add('backend-tools-package', 'backend', ['backend', 'orchestration', 'tools', '__init__.py'], '');
  add('backend-observability', 'backend', ['backend', 'observability', 'tracing.py'], renderTracing());
  add('backend-observability-package', 'backend', ['backend', 'observability', '__init__.py'], '');
  add('backend-test-health', 'backend-test', ['backend', 'tests', 'test_health.py'], renderBackendHealthTest());
  add('backend-test-messaging', 'backend-test', ['backend', 'tests', 'test_messaging.py'], renderMessagingTest());
  add('backend-test-tracing', 'backend-test', ['backend', 'tests', 'test_tracing.py'], renderTracingTest());
}

function addDatabaseArtifacts(add: AddArtifact, plan: ProjectPlan): void {
  add('database-alembic-ini', 'database', ['database', 'alembic.ini'], renderAlembicIni());
  add('database-alembic-env', 'database', ['database', 'migrations', 'env.py'], renderAlembicEnv());
  add('database-initial-migration', 'database', ['database', 'migrations', 'versions', '0001_initial.py'], renderInitialMigration(plan));
  add('database-schema', 'database', ['database', 'models', 'schema.sql'], renderDatabaseSchema(plan));
}

function addPatternArtifacts(add: AddArtifact, plan: ProjectPlan): void {
  const pattern = genAiPattern(plan);
  const routeModule = pyModule(pattern.id);
  add('pattern-agent', 'pattern', ['backend', 'orchestration', 'agents', `${routeModule}_agent.py`], renderPatternAgent(plan));
  add('pattern-agent-test', 'backend-test', ['backend', 'tests', `test_${routeModule}_orchestration.py`], renderPatternAgentTest(plan));
  add('pattern-prompt', 'pattern', ['backend', 'orchestration', 'prompts', `${pattern.id}.md`], renderPromptTemplate(plan));
  add('pattern-agent-package', 'pattern', ['backend', 'orchestration', 'agents', '__init__.py'], '');
  add('pattern-prompt-readme', 'pattern', ['backend', 'orchestration', 'prompts', 'README.md'], renderPromptReadme());

  if (pattern.id === 'rag') {
    add('rag-vector-store', 'pattern', ['backend', 'orchestration', 'retrieval', 'vector_store.py'], renderVectorStore());
    add('rag-retrieval-package', 'pattern', ['backend', 'orchestration', 'retrieval', '__init__.py'], '');
  }

  if (pattern.worker) {
    add('pattern-worker', 'pattern', ['backend', 'workers', `${routeModule}_worker.py`], renderPatternWorker(plan));
    add('backend-workers-package', 'pattern', ['backend', 'workers', '__init__.py'], '');
  }

  if (pattern.id === 'fine-tuned') {
    add('fine-tuned-eval-dataset', 'pattern', ['backend', 'evaluation', 'datasets', 'sample.jsonl'], '{"input":"Example request","expected":"Expected response placeholder"}');
  }
}

function addFunctionArtifacts(add: AddArtifact, plan: ProjectPlan): void {
  if (!hasFunctionWorker(plan)) {
    return;
  }

  const workerName = functionWorkerName(plan);
  const workerBase = ['functions', workerName];
  add('functions-readme', 'functions', ['functions', 'README.md'], renderFunctionsReadme());
  add('function-worker-readme', 'functions', [...workerBase, 'README.md'], renderFunctionWorkerReadme(plan));
  add('function-worker-host', 'functions', [...workerBase, 'host.json'], renderFunctionHostJson());
  add('function-worker-local-settings', 'functions', [...workerBase, 'local.settings.example.json'], renderFunctionLocalSettings(plan));
  add('function-worker-requirements', 'functions', [...workerBase, 'requirements.txt'], renderFunctionRequirements());
  add('function-worker-app', 'functions', [...workerBase, 'function_app.py'], renderFunctionApp(plan));
  add('function-worker-test', 'functions-test', [...workerBase, 'tests', 'test_function_app.py'], renderFunctionTest());
  add('function-worker-funcignore', 'functions', [...workerBase, '.funcignore'], renderFunctionFuncIgnore());
  add('function-worker-gitignore', 'functions', [...workerBase, '.gitignore'], renderFunctionGitIgnore());
}

function addEnvironmentArtifacts(add: AddArtifact, plan: ProjectPlan): void {
  for (const environment of plan.environments) {
    add(
      `environment-${environment.id}-backend`,
      'environment',
      ['environments', environment.id, 'backend.env'],
      plan.projectType.id === 'genai' ? renderBackendEnv(plan, environment.id) : renderStandardEnv(plan, environment.id)
    );
    if (hasFunctionWorker(plan)) {
      add(`environment-${environment.id}-functions`, 'environment', ['environments', environment.id, 'functions.env'], renderFunctionsEnv(plan, environment.id));
    }
  }
}

function addDockerArtifacts(add: AddArtifact, plan: ProjectPlan): void {
  add('docker-compose', 'local-development', ['docker-compose.yml'], renderDockerCompose(plan));
}

function addInfrastructureArtifacts(add: AddArtifact, plan: ProjectPlan): void {
  const base = ['infrastructure', 'opentofu', 'azure'];
  add('opentofu-versions', 'infrastructure', [...base, 'versions.tf'], renderTofuVersions());
  add('opentofu-providers', 'infrastructure', [...base, 'providers.tf'], renderTofuProviders());
  add('opentofu-variables', 'infrastructure', [...base, 'variables.tf'], renderTofuVariables(plan));
  add('opentofu-main', 'infrastructure', [...base, 'main.tf'], renderTofuMain(plan));
  add('opentofu-outputs', 'infrastructure', [...base, 'outputs.tf'], renderTofuOutputs(plan));
  add('opentofu-local-state', 'infrastructure', [...base, 'backend.local.tf'], renderTofuLocalState());
  add('opentofu-remote-state-example', 'infrastructure', [...base, 'backend.remote.example.tf'], renderTofuRemoteStateExample());
  add('opentofu-readme', 'infrastructure', [...base, 'README.md'], renderTofuReadme(plan));
  for (const environment of plan.environments) {
    add(`opentofu-${environment.id}-tfvars`, 'infrastructure', [...base, 'environments', `${environment.id}.tfvars`], renderTofuTfvars(plan, environment.id));
  }
}

function addGovernanceArtifacts(add: AddArtifact, plan: ProjectPlan): void {
  if (plan.specWorkflow.id === 'openspec') {
    const changeName = `bootstrap-${plan.safeProjectName}`;
    add('openspec-config', 'governance', ['openspec', 'config.yaml'], renderOpenSpecConfig(plan));
    add('openspec-seed-change-metadata', 'seed', ['openspec', 'changes', changeName, '.openspec.yaml'], 'schema: spec-driven');
    add('openspec-seed-proposal', 'seed', ['openspec', 'changes', changeName, 'proposal.md'], renderSeedProposal(plan));
    add('openspec-seed-design', 'seed', ['openspec', 'changes', changeName, 'design.md'], renderSeedDesign(plan));
    add('openspec-seed-tasks', 'seed', ['openspec', 'changes', changeName, 'tasks.md'], renderSeedTasks());
    add('openspec-spec-placeholder', 'governance', ['openspec', 'specs', '.gitkeep'], '');
  } else {
    add('spec-kit-constitution', 'governance', ['.specify', 'memory', 'constitution.md'], renderSpecKitConstitution(plan));
    add('spec-kit-spec-template', 'governance', ['.specify', 'templates', 'spec-template.md'], renderSpecKitSpecTemplate());
    add('spec-kit-plan-template', 'governance', ['.specify', 'templates', 'plan-template.md'], renderSpecKitPlanTemplate());
    add('specs-placeholder', 'governance', ['specs', '.gitkeep'], '');
  }
}

function addFrontendArtifacts(add: AddArtifact, plan: ProjectPlan): void {
  add('frontend-package', 'frontend', ['frontend', 'package.json'], renderFrontendPackage(plan));
  add('frontend-index', 'frontend', ['frontend', 'index.html'], renderFrontendIndex(plan));
  add('frontend-main', 'frontend', ['frontend', 'src', 'main.ts'], renderFrontendMain());
  add('frontend-app', 'frontend', ['frontend', 'src', 'App.vue'], renderFrontendApp(plan));
  add('frontend-env-example', 'frontend', ['frontend', '.env.example'], 'VITE_API_BASE_URL=http://localhost:8000');
  add('frontend-styles', 'frontend', ['frontend', 'src', 'styles.css'], renderFrontendStyles());
  add('frontend-vite-config', 'frontend', ['frontend', 'vite.config.ts'], renderFrontendViteConfig());
  add('frontend-tailwind-config', 'frontend', ['frontend', 'tailwind.config.ts'], renderFrontendTailwindConfig());
  add('frontend-dockerfile', 'frontend', ['frontend', 'Dockerfile'], renderFrontendDockerfile());
}

function renderDirectBuildAndTestGuide(plan: ProjectPlan): string {
  let backendCommands: string;
  if (plan.projectType.id === 'genai' || plan.apiStack.id === 'python-fastapi') {
    backendCommands = `python -m venv .venv
. .venv/bin/activate
python -m pip install -e "./backend[test]"
(cd backend && python -m pytest -q)`;
  } else if (plan.apiStack.id === 'node-fastify') {
    backendCommands = `cd backend
npm install
npm run build
npm test`;
  } else {
    backendCommands = `cd backend
go test ./...`;
  }
  const frontendCommands = plan.includeFrontend ? `

Build the frontend without a running backend:

\`\`\`bash
cp frontend/.env.example frontend/.env
cd frontend
npm install
npm run build
\`\`\`
` : '';
  const functionCommands = hasFunctionWorker(plan) ? `

Run the Function worker unit tests from the same Python virtual environment:

\`\`\`bash
cd functions/${functionWorkerName(plan)}
python -m pip install -r requirements.txt
python -m pytest -q
\`\`\`
` : '';
  return `## Direct Build And Test

\`\`\`bash
${backendCommands}
\`\`\`

On Windows, activate Python virtual environments with \`.venv\\Scripts\\activate\`.
${frontendCommands}${functionCommands}`;
}

function renderGeneratedConfigurationGuide(plan: ProjectPlan): string {
  const frontendConfiguration = plan.includeFrontend
    ? '\n- `frontend/.env` configures `VITE_API_BASE_URL`; the production build does not contact the backend.'
    : '';
  if (plan.projectType.id === 'standard') {
    return `## Runtime Configuration

Copy \`.env.example\` to \`.env\` before running outside Docker Compose. The backend requires \`DATABASE_URL\` and \`REDIS_URL\`. \`CORS_ALLOWED_ORIGINS\` is a comma-separated allowlist and defaults to the local frontend at \`http://localhost:5173\`.${frontendConfiguration}
`;
  }
  return `## Starter Integration Configuration

Copy \`.env.example\` to \`.env\`, then configure only the integrations you use:

- \`PYDANTIC_AI_MODEL\` is required when production orchestration is invoked. If it is absent, the agent raises an explicit configuration error rather than returning a placeholder answer.
- Redis Streams uses \`REDIS_URL\` and \`REDIS_STREAM_NAME\`.
- Azure Service Bus uses \`SERVICE_BUS_QUEUE_NAME\` plus either \`SERVICE_BUS_CONNECTION_STRING\` or \`SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE\`; set \`AZURE_CLIENT_ID\` when selecting a user-assigned managed identity.
- Langfuse requires both \`LANGFUSE_PUBLIC_KEY\` and \`LANGFUSE_SECRET_KEY\`, with optional \`LANGFUSE_HOST\`. Without both keys, tracing is explicitly disabled and no remote trace ID is reported.${frontendConfiguration}
- \`CORS_ALLOWED_ORIGINS\` is a comma-separated frontend-origin allowlist and defaults to \`http://localhost:5173\`.
`;
}

function renderGeneratedUpdateGuide(): string {
  return `## Safe Liftoff Updates

\`liftoff update\` is a read-only drift check; \`liftoff update --apply\` writes only preflighted changes. An occupied destination with different user bytes is reported and skipped, while an identical destination is adopted without rewriting it. Use \`--force\` only after reviewing each conflict.

Liftoff rejects malformed, traversal, absolute, drive-qualified, UNC, separator-containing, or symlink-escaping manifest paths before artifact access. If the manifest is unsafe or malformed, restore \`liftoff.manifest.json\` from version control or regenerate the project with a matching Liftoff version; do not hand-edit unsafe paths. Run \`liftoff <command> --help\` for command-specific syntax because unknown flags, subcommands, values, and extra arguments fail before any write.
`;
}

function renderRootReadme(plan: ProjectPlan): string {
  if (plan.projectType.id === 'standard') {
    return `# ${plan.projectName}

Generated by Mission Control Liftoff.

## Stack

- Project type: Standard application
- API: ${plan.apiStack.label}
- Database tooling: ${plan.apiStack.databaseTooling}
- API reference: Scalar with OpenAPI
- Cloud: ${plan.provider.label} (${plan.region.slug})
- Infrastructure: OpenTofu
- Database: PostgreSQL
- Cache and local messaging: Redis
- Local development: Docker Compose
${plan.includeFrontend ? '- Frontend: Vue 3 with Tailwind\n' : ''}
## Local Development

\`\`\`bash
docker compose up --build
\`\`\`

The backend API is available on port 8000. Health and readiness endpoints are available at \`/health\` and \`/ready\`; Scalar is exposed at \`/scalar\`.

${renderGeneratedConfigurationGuide(plan)}
${renderDirectBuildAndTestGuide(plan)}
${renderGeneratedUpdateGuide()}
## Infrastructure

\`\`\`bash
cd infrastructure/opentofu/azure
tofu init
tofu plan -var-file=environments/dev.tfvars
tofu apply -var-file=environments/dev.tfvars
\`\`\`

The first apply uses a public bootstrap image. Follow \`infrastructure/opentofu/azure/README.md\` to build the generated backend in ACR and apply its image.

## Spec-Driven Workflow

Selected workflow: ${plan.specWorkflow.label}.
`;
  }

  const pattern = genAiPattern(plan);
  const functionsStackLine = hasFunctionWorker(plan) ? `- Azure Functions worker: Python v2 Service Bus trigger under \`functions/${functionWorkerName(plan)}\`
` : '';
  const functionsSection = hasFunctionWorker(plan) ? `
## Azure Functions Worker

Azure Functions trigger adapters live under \`functions/${functionWorkerName(plan)}\`. Keep reusable GenAI orchestration under \`backend/orchestration\`; \`backend/workers\` remains the place for backend-adjacent or containerized worker code.
` : '';
  return `# ${plan.projectName}

Generated by Mission Control Liftoff.

## Stack

- Backend: FastAPI, PydanticAI, Pydantic settings, Scalar
- Pattern: ${pattern.label}
- Cloud: ${plan.provider.label} (${plan.region.slug})
- Infrastructure: OpenTofu
- Database: PostgreSQL with Alembic migrations${pattern.id === 'rag' ? ' and pgvector retrieval' : ''}
- Cache and local messaging: Redis
- Observability: Langfuse
- Local development: Docker Compose
${functionsStackLine}
${plan.includeFrontend ? '- Frontend: Vue 3 with Tailwind\n' : ''}
## Local Development

\`\`\`bash
docker compose up --build
docker compose --profile observability up --build
\`\`\`

The backend API is available on port 8000. Scalar is exposed at \`/scalar\`.

${renderGeneratedConfigurationGuide(plan)}
${renderDirectBuildAndTestGuide(plan)}
${renderGeneratedUpdateGuide()}
## Infrastructure

\`\`\`bash
cd infrastructure/opentofu/azure
tofu init
tofu plan -var-file=environments/dev.tfvars
tofu apply -var-file=environments/dev.tfvars
\`\`\`

The first apply uses a public bootstrap image. Follow \`infrastructure/opentofu/azure/README.md\` to build the generated backend in ACR and apply its image.

## Spec-Driven Workflow

Selected workflow: ${plan.specWorkflow.label}.
${functionsSection}
`;
}

function renderGeneratedGitignore(): string {
  return `.venv/
__pycache__/
.pytest_cache/
node_modules/
dist/
.env
migration/legacy/
*.tfstate
*.tfstate.*
.terraform/
`;
}

function renderEnvExample(plan: ProjectPlan): string {
  if (plan.projectType.id === 'standard') {
    return renderStandardEnv(plan);
  }
  const pattern = genAiPattern(plan);
  return `APP_ENV=dev
APP_NAME=${plan.safeProjectName}
GENAI_PATTERN=${pattern.id}
CLOUD_PROVIDER=${plan.provider.id}
AZURE_REGION=${plan.region.slug}
DATABASE_URL=postgresql+asyncpg://postgres:postgres@postgres:5432/${plan.safeProjectName.replace(/-/g, '_')}
REDIS_URL=redis://redis:6379/0
REDIS_STREAM_NAME=liftoff-events
MESSAGING_TRANSPORT=redis-streams
SERVICE_BUS_QUEUE_NAME=${DEFAULT_FUNCTION_WORKER_QUEUE_NAME}
SERVICE_BUS_CONNECTION_STRING=
SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE=
AZURE_CLIENT_ID=
BLOB_ENDPOINT=http://azurite:10000/devstoreaccount1
CORS_ALLOWED_ORIGINS=http://localhost:5173
PYDANTIC_AI_MODEL=
LANGFUSE_HOST=http://langfuse:3000
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
`;
}

function renderBackendDockerfile(): string {
  return `FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

COPY backend/pyproject.toml /app/backend/pyproject.toml
RUN pip install --no-cache-dir /app/backend

COPY backend /app/backend
COPY database /app/database

EXPOSE 8000
CMD ["uvicorn", "backend.apis.main:app", "--host", "0.0.0.0", "--port", "8000"]
`;
}

function renderBackendPyproject(plan: ProjectPlan): string {
  return `[project]
name = "${plan.safeProjectName}-backend"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.111",
  "uvicorn[standard]>=0.30",
  "pydantic>=2.7",
  "pydantic-settings>=2.3",
  "pydantic-ai-slim[openai]==1.107.1",
  "scalar-fastapi>=1.0",
  "sqlalchemy[asyncio]>=2.0",
  "asyncpg>=0.29",
  "psycopg[binary]>=3.2",
  "alembic>=1.13",
  "redis>=5.0",
  "langfuse==2.60.10",
  "azure-servicebus>=7.12",
  "azure-identity>=1.17",
  "azure-storage-blob>=12.20",
  "azure-communication-email>=1.0"
]

[project.optional-dependencies]
test = ["pytest>=8.2", "httpx>=0.27"]

[build-system]
requires = ["setuptools>=70"]
build-backend = "setuptools.build_meta"

[tool.setuptools]
packages = []

[tool.pytest.ini_options]
pythonpath = [".."]
testpaths = ["tests"]
`;
}

function renderFastApiMain(plan: ProjectPlan, routeModule: string): string {
  return `from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

try:
    from scalar_fastapi import get_scalar_api_reference
except ImportError:  # pragma: no cover - dependency is present in generated runtime
    get_scalar_api_reference = None

from backend.apis.routes import health, ${routeModule}
from backend.config.settings import get_settings


settings = get_settings()
app = FastAPI(title=settings.app_name, version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in settings.cors_allowed_origins.split(",")
        if origin.strip()
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(${routeModule}.router)


@app.get("/scalar", include_in_schema=False)
def scalar_reference():
    if get_scalar_api_reference is None:
        return {"message": "Install scalar-fastapi to enable the Scalar developer portal."}
    return get_scalar_api_reference(openapi_url=app.openapi_url, title=f"{app.title} API")
`;
}

function renderHealthRoutes(): string {
  return `from fastapi import APIRouter

router = APIRouter(tags=["operations"])


@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/ready")
def ready():
    return {"status": "ready"}
`;
}

function renderPatternRoutes(plan: ProjectPlan): string {
  const pattern = genAiPattern(plan);
  const moduleName = pyModule(pattern.id);
  const agentName = `${moduleName}_agent`;
  const prefix = pattern.routePrefix;
  if (pattern.id === 'streaming') {
    return `from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from backend.orchestration.agents.${agentName} import stream_response

router = APIRouter(prefix="${prefix}", tags=["${pattern.id}"])


@router.get("")
def stream(prompt: str):
    return StreamingResponse(stream_response(prompt), media_type="text/event-stream")
`;
  }

  if (pattern.id === 'rag') {
    return `from fastapi import APIRouter
from pydantic import BaseModel

from backend.orchestration.agents.${agentName} import answer_question, enqueue_ingestion

router = APIRouter(prefix="${prefix}", tags=["rag"])


class QueryRequest(BaseModel):
    question: str


class IngestionRequest(BaseModel):
    source_uri: str


@router.post("/query")
async def query(request: QueryRequest):
    return await answer_question(request.question)


@router.post("/ingest")
async def ingest(request: IngestionRequest):
    return await enqueue_ingestion(request.source_uri)
`;
  }

  const bodyClass = `${titleCase(pattern.id).replace(/\s/g, '')}Request`;
  return `from fastapi import APIRouter
from pydantic import BaseModel

from backend.orchestration.agents.${agentName} import run_${moduleName}

router = APIRouter(prefix="${prefix}", tags=["${pattern.id}"])


class ${bodyClass}(BaseModel):
    input: str


@router.post("/run")
async def run(request: ${bodyClass}):
    return await run_${moduleName}(request.input)
`;
}

function renderAuthDependency(): string {
  return `from dataclasses import dataclass


@dataclass(frozen=True)
class CurrentUser:
    subject: str = "local-developer"


async def get_current_user() -> CurrentUser:
    return CurrentUser()
`;
}

function renderSettings(plan: ProjectPlan): string {
  const pattern = genAiPattern(plan);
  return `from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = ${sourceString(plan.projectName)}
    app_env: str = "dev"
    genai_pattern: str = "${pattern.id}"
    cloud_provider: str = "${plan.provider.id}"
    azure_region: str = "${plan.region.slug}"
    database_url: str
    redis_url: str
    redis_stream_name: str = "liftoff-events"
    messaging_transport: str = "redis-streams"
    service_bus_queue_name: str = "${DEFAULT_FUNCTION_WORKER_QUEUE_NAME}"
    service_bus_connection_string: str | None = None
    service_bus_fully_qualified_namespace: str | None = None
    azure_client_id: str | None = None
    blob_endpoint: str | None = None
    cors_allowed_origins: str = "http://localhost:5173"
    pydantic_ai_model: str | None = None
    langfuse_host: str | None = None
    langfuse_public_key: str | None = None
    langfuse_secret_key: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
`;
}

function renderModelConfig(plan: ProjectPlan): string {
  const pattern = genAiPattern(plan);
  return `import os
from dataclasses import dataclass
from typing import Protocol


class ModelConfigurationError(RuntimeError):
    pass


class AgentRunner(Protocol):
    async def run(self, prompt: str) -> str:
        ...


@dataclass(frozen=True)
class ModelConfig:
    model_name: str
    pattern: str = "${pattern.id}"

    @classmethod
    def from_environment(cls) -> "ModelConfig":
        model_name = os.getenv("PYDANTIC_AI_MODEL", "").strip()
        if not model_name:
            raise ModelConfigurationError(
                "PYDANTIC_AI_MODEL is required before invoking production GenAI orchestration. "
                "Use a PydanticAI model name such as 'openai:gpt-4.1-mini'."
            )
        return cls(model_name=model_name)


class PydanticAgentRunner:
    def __init__(self, config: ModelConfig):
        from pydantic_ai import Agent

        self._agent = Agent(config.model_name)

    async def run(self, prompt: str) -> str:
        result = await self._agent.run(prompt)
        output = getattr(result, "output", None)
        if output is None:
            output = getattr(result, "data", None)
        if output is None:
            raise RuntimeError("PydanticAI returned a result without output data.")
        return str(output)


def build_agent_runner(config: ModelConfig | None = None) -> AgentRunner:
    return PydanticAgentRunner(config or ModelConfig.from_environment())
`;
}

function renderMessagingBoundary(): string {
  return `import json
import os
from collections.abc import Callable
from typing import Any, Protocol


class MessagingConfigurationError(RuntimeError):
    pass


class MessagePublisher(Protocol):
    async def publish(self, topic: str, payload: dict) -> None:
        ...


class RedisStreamClient(Protocol):
    async def xadd(self, name: str, fields: dict[str, str]) -> Any:
        ...


class ServiceBusSender(Protocol):
    async def __aenter__(self) -> "ServiceBusSender":
        ...

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        ...

    async def send_messages(self, message: Any) -> None:
        ...


class ServiceBusClient(Protocol):
    def get_queue_sender(self, *, queue_name: str) -> ServiceBusSender:
        ...


def _serialize(topic: str, payload: dict) -> str:
    return json.dumps({"topic": topic, "payload": payload}, separators=(",", ":"), sort_keys=True)


class RedisStreamPublisher:
    def __init__(self, client: RedisStreamClient, stream_name: str):
        self._client = client
        self._stream_name = stream_name

    async def publish(self, topic: str, payload: dict) -> None:
        await self._client.xadd(
            self._stream_name,
            {"topic": topic, "payload": _serialize(topic, payload)},
        )


class AzureServiceBusPublisher:
    def __init__(
        self,
        client: ServiceBusClient,
        queue_name: str,
        message_factory: Callable[[str], Any] | None = None,
    ):
        self._client = client
        self._queue_name = queue_name
        self._message_factory = message_factory or self._default_message_factory

    @staticmethod
    def _default_message_factory(body: str) -> Any:
        from azure.servicebus import ServiceBusMessage

        return ServiceBusMessage(body)

    async def publish(self, topic: str, payload: dict) -> None:
        message = self._message_factory(_serialize(topic, payload))
        async with self._client.get_queue_sender(queue_name=self._queue_name) as sender:
            await sender.send_messages(message)


def build_message_publisher(
    transport: str,
    *,
    redis_client: RedisStreamClient | None = None,
    service_bus_client: ServiceBusClient | None = None,
    message_factory: Callable[[str], Any] | None = None,
) -> MessagePublisher:
    if transport == "redis-streams":
        stream_name = os.getenv("REDIS_STREAM_NAME", "liftoff-events").strip()
        if not stream_name:
            raise MessagingConfigurationError("REDIS_STREAM_NAME must not be empty.")
        if redis_client is None:
            redis_url = os.getenv("REDIS_URL", "").strip()
            if not redis_url:
                raise MessagingConfigurationError("REDIS_URL is required for redis-streams messaging.")
            from redis.asyncio import Redis

            redis_client = Redis.from_url(redis_url, decode_responses=True)
        return RedisStreamPublisher(redis_client, stream_name)

    if transport == "azure-service-bus":
        queue_name = os.getenv("SERVICE_BUS_QUEUE_NAME", "").strip()
        if not queue_name:
            raise MessagingConfigurationError(
                "SERVICE_BUS_QUEUE_NAME is required for azure-service-bus messaging."
            )
        if service_bus_client is None:
            connection_string = os.getenv("SERVICE_BUS_CONNECTION_STRING", "").strip()
            namespace = os.getenv("SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE", "").strip()
            from azure.servicebus.aio import ServiceBusClient as AzureServiceBusClient

            if connection_string:
                service_bus_client = AzureServiceBusClient.from_connection_string(connection_string)
            elif namespace:
                from azure.identity.aio import DefaultAzureCredential

                client_id = os.getenv("AZURE_CLIENT_ID", "").strip() or None
                credential = DefaultAzureCredential(managed_identity_client_id=client_id)
                service_bus_client = AzureServiceBusClient(namespace, credential)
            else:
                raise MessagingConfigurationError(
                    "Set SERVICE_BUS_CONNECTION_STRING or SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE "
                    "for azure-service-bus messaging."
                )
        return AzureServiceBusPublisher(service_bus_client, queue_name, message_factory)

    raise MessagingConfigurationError(
        f"Unsupported MESSAGING_TRANSPORT '{transport}'. "
        "Expected 'redis-streams' or 'azure-service-bus'."
    )
`;
}

function renderTracing(): string {
  return `import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncContextManager, Protocol


class TracingConfigurationError(RuntimeError):
    pass


@dataclass
class TraceHandle:
    enabled: bool
    trace_id: str | None
    output: Any = None

    def set_output(self, output: Any) -> None:
        self.output = output


class Tracer(Protocol):
    def trace(self, name: str, input_data: Any = None) -> AsyncContextManager[TraceHandle]:
        ...


class DisabledTracer:
    @asynccontextmanager
    async def trace(self, name: str, input_data: Any = None):
        del name, input_data
        yield TraceHandle(enabled=False, trace_id=None)


class LangfuseTracer:
    def __init__(self, client: Any):
        self._client = client


    @asynccontextmanager
    async def trace(self, name: str, input_data: Any = None):
        remote_trace = self._client.trace(name=name, input=input_data)
        remote_id = getattr(remote_trace, "id", None)
        handle = TraceHandle(
            enabled=True,
            trace_id=str(remote_id) if remote_id is not None else None,
        )
        try:
            yield handle
        except Exception as error:
            remote_trace.update(level="ERROR", status_message=str(error))
            raise
        else:
            remote_trace.update(output=handle.output)


def build_tracer(
    *,
    client: Any = None,
    public_key: str | None = None,
    secret_key: str | None = None,
    host: str | None = None,
) -> Tracer:
    if client is not None:
        return LangfuseTracer(client)

    resolved_public_key = public_key or os.getenv("LANGFUSE_PUBLIC_KEY", "").strip()
    resolved_secret_key = secret_key or os.getenv("LANGFUSE_SECRET_KEY", "").strip()
    if not resolved_public_key and not resolved_secret_key:
        return DisabledTracer()
    if not resolved_public_key or not resolved_secret_key:
        raise TracingConfigurationError(
            "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be configured together."
        )

    from langfuse import Langfuse

    resolved_host = host or os.getenv("LANGFUSE_HOST", "").strip() or None
    kwargs = {
        "public_key": resolved_public_key,
        "secret_key": resolved_secret_key,
    }
    if resolved_host:
        kwargs["host"] = resolved_host
    return LangfuseTracer(Langfuse(**kwargs))
`;
}

function renderBackendHealthTest(): string {
  return `from fastapi.testclient import TestClient

from backend.apis.main import app


def test_health():
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_cors_preflight_for_local_frontend():
    response = TestClient(app).options(
        "/health",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
`;
}

function renderMessagingTest(): string {
  return `import asyncio
import json

from backend.orchestration.tools.messaging import build_message_publisher


class FakeRedisClient:
    def __init__(self):
        self.calls = []

    async def xadd(self, name, fields):
        self.calls.append((name, fields))


class FakeSender:
    def __init__(self):
        self.messages = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return None

    async def send_messages(self, message):
        self.messages.append(message)


class FakeServiceBusClient:
    def __init__(self, sender):
        self.sender = sender
        self.queue_names = []

    def get_queue_sender(self, *, queue_name):
        self.queue_names.append(queue_name)
        return self.sender


def test_redis_stream_publisher_uses_xadd(monkeypatch):
    monkeypatch.setenv("REDIS_STREAM_NAME", "orchestration-events")
    client = FakeRedisClient()
    publisher = build_message_publisher("redis-streams", redis_client=client)

    asyncio.run(publisher.publish("rag.ingest", {"source_uri": "az://document"}))

    stream_name, fields = client.calls[0]
    assert stream_name == "orchestration-events"
    assert fields["topic"] == "rag.ingest"
    assert json.loads(fields["payload"]) == {
        "payload": {"source_uri": "az://document"},
        "topic": "rag.ingest",
    }


def test_service_bus_publisher_uses_async_sender(monkeypatch):
    monkeypatch.setenv("SERVICE_BUS_QUEUE_NAME", "orchestration-jobs")
    sender = FakeSender()
    client = FakeServiceBusClient(sender)
    publisher = build_message_publisher(
        "azure-service-bus",
        service_bus_client=client,
        message_factory=lambda body: body,
    )

    asyncio.run(publisher.publish("workflow.run", {"job_id": "job-1"}))

    assert client.queue_names == ["orchestration-jobs"]
    assert json.loads(sender.messages[0]) == {
        "payload": {"job_id": "job-1"},
        "topic": "workflow.run",
    }
`;
}

function renderTracingTest(): string {
  return `import asyncio

import pytest

from backend.observability.tracing import (
    TracingConfigurationError,
    build_tracer,
)


class FakeRemoteTrace:
    id = "trace-123"

    def __init__(self):
        self.updates = []

    def update(self, **values):
        self.updates.append(values)


class FakeLangfuse:
    def __init__(self):
        self.calls = []
        self.remote_trace = FakeRemoteTrace()

    def trace(self, **values):
        self.calls.append(values)
        return self.remote_trace


def test_unconfigured_tracing_is_explicitly_disabled(monkeypatch):
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)

    async def scenario():
        async with build_tracer().trace("offline") as trace:
            assert trace.enabled is False
            assert trace.trace_id is None

    asyncio.run(scenario())


def test_configured_tracing_updates_langfuse_operation():
    client = FakeLangfuse()

    async def scenario():
        async with build_tracer(client=client).trace(
            "agent.run",
            {"prompt": "hello"},
        ) as trace:
            assert trace.enabled is True
            assert trace.trace_id == "trace-123"
            trace.set_output({"answer": "world"})

    asyncio.run(scenario())
    assert client.calls == [{"name": "agent.run", "input": {"prompt": "hello"}}]
    assert client.remote_trace.updates == [{"output": {"answer": "world"}}]


def test_partial_langfuse_configuration_fails(monkeypatch):
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "public")
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    with pytest.raises(TracingConfigurationError, match="configured together"):
        build_tracer()
`;
}

function renderAlembicIni(): string {
  return `[alembic]
script_location = %(here)s/migrations
sqlalchemy.url = driver://user:pass@localhost/dbname
`;
}

function renderAlembicEnv(): string {
  return `import os

from alembic import context
from sqlalchemy import create_engine


def run_migrations_online():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required to run migrations")
    database_url = database_url.replace("postgresql+asyncpg://", "postgresql+psycopg://", 1)
    database_url = database_url.replace("postgresql://", "postgresql+psycopg://", 1)
    connectable = create_engine(database_url)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=None)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
`;
}

function renderInitialMigration(plan: ProjectPlan): string {
  const vectorExtension = genAiPattern(plan).id === 'rag' ? '    op.execute("CREATE EXTENSION IF NOT EXISTS vector")\n' : '';
  return `from alembic import op
import sqlalchemy as sa

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
${vectorExtension}    op.create_table(
        "events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_type", sa.String(length=120), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )


def downgrade():
    op.drop_table("events")
`;
}

function renderDatabaseSchema(plan: ProjectPlan): string {
  return `CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(120) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
${genAiPattern(plan).id === 'rag' ? '\nCREATE EXTENSION IF NOT EXISTS vector;\n' : ''}`;
}

function renderPatternAgent(plan: ProjectPlan): string {
  const pattern = genAiPattern(plan);
  const moduleName = pyModule(pattern.id);
  if (pattern.id === 'rag') {
    return `import os

from backend.observability.tracing import Tracer, build_tracer
from backend.orchestration.model_config import AgentRunner, build_agent_runner
from backend.orchestration.tools.messaging import MessagePublisher, build_message_publisher


async def _run_agent(
    operation: str,
    prompt: str,
    runner: AgentRunner | None,
    tracer: Tracer | None,
) -> str:
    selected_runner = runner or build_agent_runner()
    selected_tracer = tracer or build_tracer()
    async with selected_tracer.trace(operation, {"prompt": prompt}) as trace:
        output = await selected_runner.run(prompt)
        trace.set_output({"text": output})
        return output


async def answer_question(
    question: str,
    *,
    runner: AgentRunner | None = None,
    tracer: Tracer | None = None,
) -> dict:
    answer = await _run_agent(
        "rag.query",
        f"Answer the question using retrieved evidence when available.\\nQuestion: {question}",
        runner,
        tracer,
    )
    return {
        "answer": answer,
        "question": question,
        "citations": [],
    }


async def enqueue_ingestion(
    source_uri: str,
    *,
    publisher: MessagePublisher | None = None,
) -> dict:
    selected_publisher = publisher or build_message_publisher(
        os.getenv("MESSAGING_TRANSPORT", "redis-streams")
    )
    await selected_publisher.publish("rag.ingest", {"source_uri": source_uri})
    return {"status": "queued", "source_uri": source_uri}
`;
  }
  if (pattern.id === 'streaming') {
    return `import json

from backend.observability.tracing import Tracer, build_tracer
from backend.orchestration.model_config import AgentRunner, build_agent_runner


async def stream_response(
    prompt: str,
    *,
    runner: AgentRunner | None = None,
    tracer: Tracer | None = None,
):
    selected_runner = runner or build_agent_runner()
    selected_tracer = tracer or build_tracer()
    async with selected_tracer.trace("streaming.run", {"prompt": prompt}) as trace:
        output = await selected_runner.run(
            f"Respond concisely and safely to this streaming request:\\n{prompt}"
        )
        trace.set_output({"text": output})
    yield f"data: {json.dumps({'text': output})}\\n\\n"
`;
  }
  return `from backend.observability.tracing import Tracer, build_tracer
from backend.orchestration.model_config import AgentRunner, build_agent_runner


async def run_${moduleName}(
    input_text: str,
    *,
    runner: AgentRunner | None = None,
    tracer: Tracer | None = None,
) -> dict:
    selected_runner = runner or build_agent_runner()
    selected_tracer = tracer or build_tracer()
    prompt = (
        "Run the ${pattern.label} orchestration contract for this input:\\n"
        f"{input_text}"
    )
    async with selected_tracer.trace("${pattern.id}.run", {"input": input_text}) as trace:
        output = await selected_runner.run(prompt)
        trace.set_output({"result": output})
    return {
        "result": output,
        "input": input_text,
    }
`;
}

function renderPatternAgentTest(plan: ProjectPlan): string {
  const pattern = genAiPattern(plan);
  const moduleName = pyModule(pattern.id);
  const agentModule = `backend.orchestration.agents.${moduleName}_agent`;
  if (pattern.id === 'rag') {
    return `import asyncio

import pytest

from ${agentModule} import answer_question, enqueue_ingestion
from backend.observability.tracing import DisabledTracer
from backend.orchestration.model_config import ModelConfigurationError


class FakeRunner:
    async def run(self, prompt):
        assert "Question: What is Liftoff?" in prompt
        return "Liftoff is the generated orchestration starter."


class FakePublisher:
    def __init__(self):
        self.messages = []

    async def publish(self, topic, payload):
        self.messages.append((topic, payload))


def test_rag_query_uses_injected_runner_without_network():
    result = asyncio.run(
        answer_question(
            "What is Liftoff?",
            runner=FakeRunner(),
            tracer=DisabledTracer(),
        )
    )
    assert result == {
        "answer": "Liftoff is the generated orchestration starter.",
        "question": "What is Liftoff?",
        "citations": [],
    }


def test_rag_ingestion_uses_injected_publisher():
    publisher = FakePublisher()
    result = asyncio.run(
        enqueue_ingestion("az://documents/one.pdf", publisher=publisher)
    )
    assert result == {
        "status": "queued",
        "source_uri": "az://documents/one.pdf",
    }
    assert publisher.messages == [
        ("rag.ingest", {"source_uri": "az://documents/one.pdf"})
    ]


def test_missing_model_configuration_is_explicit(monkeypatch):
    monkeypatch.delenv("PYDANTIC_AI_MODEL", raising=False)
    with pytest.raises(ModelConfigurationError, match="PYDANTIC_AI_MODEL is required"):
        asyncio.run(answer_question("unconfigured"))
`;
  }
  if (pattern.id === 'streaming') {
    return `import asyncio

import pytest

from ${agentModule} import stream_response
from backend.observability.tracing import DisabledTracer
from backend.orchestration.model_config import ModelConfigurationError


class FakeRunner:
    async def run(self, prompt):
        assert "stream this" in prompt
        return "offline streamed answer"


def test_streaming_uses_injected_runner_without_network():
    async def collect():
        return [
            chunk
            async for chunk in stream_response(
                "stream this",
                runner=FakeRunner(),
                tracer=DisabledTracer(),
            )
        ]

    chunks = asyncio.run(collect())
    assert chunks == ['data: {"text": "offline streamed answer"}\\n\\n']


def test_missing_model_configuration_is_explicit(monkeypatch):
    monkeypatch.delenv("PYDANTIC_AI_MODEL", raising=False)

    async def collect():
        return [chunk async for chunk in stream_response("unconfigured")]

    with pytest.raises(ModelConfigurationError, match="PYDANTIC_AI_MODEL is required"):
        asyncio.run(collect())
`;
  }
  return `import asyncio

import pytest

from ${agentModule} import run_${moduleName}
from backend.observability.tracing import DisabledTracer
from backend.orchestration.model_config import ModelConfigurationError


class FakeRunner:
    async def run(self, prompt):
        assert "offline input" in prompt
        return "offline ${pattern.id} result"


def test_${moduleName}_uses_injected_runner_without_network():
    result = asyncio.run(
        run_${moduleName}(
            "offline input",
            runner=FakeRunner(),
            tracer=DisabledTracer(),
        )
    )
    assert result == {
        "result": "offline ${pattern.id} result",
        "input": "offline input",
    }


def test_missing_model_configuration_is_explicit(monkeypatch):
    monkeypatch.delenv("PYDANTIC_AI_MODEL", raising=False)
    with pytest.raises(ModelConfigurationError, match="PYDANTIC_AI_MODEL is required"):
        asyncio.run(run_${moduleName}("unconfigured"))
`;
}

function renderPromptTemplate(plan: ProjectPlan): string {
  const pattern = genAiPattern(plan);
  return `# ${pattern.label} Prompt

You are implementing a ${pattern.label} generated by Mission Control Liftoff.

Use PydanticAI orchestration and return outputs that match the API contract.
`;
}

function renderPromptReadme(): string {
  return `# Prompt Templates

Store prompt templates here and reference them from the PydanticAI orchestration layer.
`;
}

function renderVectorStore(): string {
  return `from typing import Protocol


class VectorStore(Protocol):
    async def search(self, query: str, limit: int = 5) -> list[dict]:
        ...


class PgVectorStore:
    async def search(self, query: str, limit: int = 5) -> list[dict]:
        return []
`;
}

function renderPatternWorker(plan: ProjectPlan): string {
  const pattern = genAiPattern(plan);
  return `async def run_worker() -> None:
    # Consume ${pattern.label} jobs from the configured messaging boundary.
    return None
`;
}

function renderFunctionsReadme(): string {
  return `# Azure Functions Workers

Azure Functions trigger adapters live under \`functions/<worker-name>\`.

Keep reusable GenAI orchestration, model configuration, prompt handling, and domain logic under \`backend/orchestration\`. Use \`backend/workers\` for backend-adjacent or containerized workers; use this folder for Azure Functions runtime files such as \`host.json\`, trigger bindings, local settings, and Function app tests.
`;
}

function renderFunctionWorkerReadme(plan: ProjectPlan): string {
  const workerName = functionWorkerName(plan);
  const pattern = genAiPattern(plan);
  return `# ${workerName}

Azure Functions worker scaffold for ${pattern.label}.

This Function app uses the Python v2 decorator programming model and a Service Bus queue trigger. The trigger adapter should stay thin: decode the message, validate the envelope, and call shared code from \`backend/orchestration\` after that shared code is packaged with the Function app.

Deployed triggers use \`ServiceBusConnection__fullyQualifiedNamespace\` and \`ServiceBusConnection__clientId\` to select the same user-assigned identity that OpenTofu grants the Service Bus Data Receiver role. \`SERVICEBUS_QUEUE_NAME\` is populated from \`function_worker_queue_name\`. Function host storage uses the complete \`AzureWebJobsStorage\` connection setting.

## Local Development

\`\`\`bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp local.settings.example.json local.settings.json
python -m pytest -q
func start
\`\`\`

On Windows, activate the virtual environment with \`.venv\\Scripts\\activate\`.
`;
}

function renderFunctionHostJson(): string {
  return JSON.stringify({
    version: '2.0',
    extensionBundle: {
      id: 'Microsoft.Azure.Functions.ExtensionBundle',
      version: '[4.*, 5.0.0)'
    }
  }, null, 2);
}

function renderFunctionLocalSettings(plan: ProjectPlan): string {
  const pattern = genAiPattern(plan);
  return JSON.stringify({
    IsEncrypted: false,
    Values: {
      AzureWebJobsStorage: 'UseDevelopmentStorage=true',
      FUNCTIONS_WORKER_RUNTIME: 'python',
      SERVICEBUS_QUEUE_NAME: DEFAULT_FUNCTION_WORKER_QUEUE_NAME,
      ServiceBusConnection__fullyQualifiedNamespace: '<service-bus-namespace>.servicebus.windows.net',
      GENAI_PATTERN: pattern.id,
      SHARED_ORCHESTRATION_ROOT: '../../backend'
    }
  }, null, 2);
}

function renderFunctionRequirements(): string {
  return `azure-functions>=1.21.0
pytest>=8.2
`;
}

function renderFunctionApp(plan: ProjectPlan): string {
  const pattern = genAiPattern(plan);
  const moduleName = pyModule(pattern.id);
  return `import json
import logging

import azure.functions as func


app = func.FunctionApp()


def decode_message_payload(body: str) -> dict:
    try:
        value = json.loads(body)
    except json.JSONDecodeError:
        return {"raw": body}
    if isinstance(value, dict):
        return value
    return {"value": value}


@app.service_bus_queue_trigger(
    arg_name="message",
    queue_name="%SERVICEBUS_QUEUE_NAME%",
    connection="ServiceBusConnection",
)
def process_${moduleName}_work(message: func.ServiceBusMessage) -> None:
    payload = decode_message_payload(message.get_body().decode("utf-8"))
    logging.info("Received ${pattern.id} worker message with keys: %s", sorted(payload.keys()))
    # Keep this adapter thin; call backend.orchestration code from packaged shared modules.
`;
}

function renderFunctionTest(): string {
  return `from function_app import decode_message_payload


def test_decode_message_payload_for_json_object():
    assert decode_message_payload('{"source_uri":"az://documents/example.pdf"}') == {
        "source_uri": "az://documents/example.pdf"
    }


def test_decode_message_payload_for_plain_text():
    assert decode_message_payload("plain text") == {"raw": "plain text"}
`;
}

function renderFunctionFuncIgnore(): string {
  return `.venv/
__pycache__/
.pytest_cache/
local.settings.json
tests/
`;
}

function renderFunctionGitIgnore(): string {
  return `.venv/
__pycache__/
.pytest_cache/
local.settings.json
`;
}

function renderBackendEnv(plan: ProjectPlan, environment: string): string {
  const pattern = genAiPattern(plan);
  const transport = environment === 'dev' ? 'redis-streams' : 'azure-service-bus';
  return `APP_ENV=${environment}
APP_NAME=${plan.safeProjectName}
GENAI_PATTERN=${pattern.id}
CLOUD_PROVIDER=${plan.provider.id}
AZURE_REGION=${plan.region.slug}
DATABASE_URL=postgresql+asyncpg://postgres:postgres@postgres:5432/${plan.safeProjectName.replace(/-/g, '_')}
REDIS_URL=redis://redis:6379/0
REDIS_STREAM_NAME=liftoff-events
MESSAGING_TRANSPORT=${transport}
SERVICE_BUS_QUEUE_NAME=${DEFAULT_FUNCTION_WORKER_QUEUE_NAME}
SERVICE_BUS_CONNECTION_STRING=
SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE=${environment === 'dev' ? '' : '<service-bus-namespace>.servicebus.windows.net'}
AZURE_CLIENT_ID=
BLOB_ENDPOINT=
CORS_ALLOWED_ORIGINS=http://localhost:5173
PYDANTIC_AI_MODEL=
LANGFUSE_HOST=${environment === 'dev' ? 'http://langfuse:3000' : ''}
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
`;
}

function renderFunctionsEnv(plan: ProjectPlan, environment: string): string {
  const pattern = genAiPattern(plan);
  return `APP_ENV=${environment}
APP_NAME=${plan.safeProjectName}
GENAI_PATTERN=${pattern.id}
FUNCTIONS_WORKER_RUNTIME=python
SERVICEBUS_QUEUE_NAME=${DEFAULT_FUNCTION_WORKER_QUEUE_NAME}
ServiceBusConnection__fullyQualifiedNamespace=<service-bus-namespace>.servicebus.windows.net
ServiceBusConnection__clientId=<managed-identity-client-id>
AzureWebJobsStorage=<storage-connection-string>
SHARED_ORCHESTRATION_ROOT=../../backend
`;
}

function renderDockerCompose(plan: ProjectPlan): string {
  const localEnvironment = plan.environments.find((environment) => environment.id === 'dev') ?? plan.environments[0];
  const frontendService = plan.includeFrontend ? `
  frontend:
    build:
      context: ./frontend
    ports:
      - "5173:80"
    depends_on:
      - backend
` : '';
  const postgresImage = plan.projectType.id === 'genai' ? 'pgvector/pgvector:pg16' : 'postgres:16-alpine';
  return `services:
  backend:
    build:
      context: .
      dockerfile: Dockerfile
    env_file:
      - ./environments/${localEnvironment.id}/backend.env
    environment:
      MESSAGING_TRANSPORT: redis-streams
      BLOB_ENDPOINT: http://azurite:10000/devstoreaccount1
    ports:
      - "8000:8000"
    depends_on:
      - postgres
      - redis
      - azurite
      - mailpit
${frontendService}
  postgres:
    image: ${postgresImage}
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: ${plan.safeProjectName.replace(/-/g, '_')}
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  azurite:
    image: mcr.microsoft.com/azure-storage/azurite
    command: azurite --blobHost 0.0.0.0
    ports:
      - "10000:10000"

  mailpit:
    image: axllent/mailpit:latest
    ports:
      - "8025:8025"

${plan.projectType.id === 'genai' ? `  langfuse:
    image: langfuse/langfuse:2
    profiles:
      - observability
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/${plan.safeProjectName.replace(/-/g, '_')}
      NEXTAUTH_SECRET: local-development-placeholder
      SALT: local-development-placeholder
    ports:
      - "3000:3000"
` : ''}
`;
}

function renderTofuVersions(): string {
  return `terraform {
  required_version = ">= 1.6.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.110"
    }
  }
}
`;
}

function renderTofuProviders(): string {
  return `provider "azurerm" {
  features {}
}
`;
}

function renderTofuVariables(plan: ProjectPlan): string {
  const frontendVariables = plan.includeFrontend ? `
variable "frontend_image" {
  type        = string
  default     = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
  description = "Frontend image. Replace the bootstrap image with the generated frontend image after pushing it to ACR."
}
` : '';
  const functionVariables = hasFunctionWorker(plan) ? `
variable "function_worker_queue_name" {
  type        = string
  default     = "events"
  description = "Service Bus queue consumed by the generated Azure Functions worker."
}

variable "functions_python_version" {
  type        = string
  default     = "3.12"
  description = "Python runtime version for the generated Azure Functions worker."
}
` : '';
  return `variable "environment" {
  type        = string
  description = "Deployment environment name."
}

variable "location" {
  type        = string
  description = "Azure region slug."
  default     = "${plan.region.slug}"
}

variable "resource_suffix" {
  type        = string
  description = "Twelve-character lowercase alphanumeric suffix for globally scoped Azure resource names."

  validation {
    condition     = can(regex("^[a-z0-9]{12}$", var.resource_suffix))
    error_message = "resource_suffix must contain exactly 12 lowercase letters or numbers."
  }
}

variable "backend_image" {
  type        = string
  default     = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
  description = "Backend image. Replace the bootstrap image with the generated backend image after pushing it to ACR."
}

variable "backend_target_port" {
  type        = number
  default     = 80
  description = "Backend ingress port. Set to 8000 when switching from the bootstrap image to the generated backend."
}
${frontendVariables}
variable "postgres_admin_password" {
  type        = string
  sensitive   = true
  description = "PostgreSQL administrator password supplied at apply time."
}

variable "enable_private_networking" {
  type        = bool
  default     = false
  description = "Enable production-oriented private-networking-ready settings."
}
${functionVariables}
`;
}

function renderTofuMain(plan: ProjectPlan): string {
  const functionPattern = hasFunctionWorker(plan) ? genAiPattern(plan) : undefined;
  const names = buildAzureResourceNames(plan, '${var.environment}', '${var.resource_suffix}');
  const queueName = hasFunctionWorker(plan)
    ? 'var.function_worker_queue_name'
    : JSON.stringify(DEFAULT_FUNCTION_WORKER_QUEUE_NAME);
  const projectIdentityEnv = plan.projectType.id === 'genai' ? `
      env {
        name  = "GENAI_PATTERN"
        value = "${genAiPattern(plan).id}"
      }
` : `
      env {
        name  = "API_STACK"
        value = "${plan.apiStack.id}"
      }
`;
  const frontendCorsEnvironment = plan.includeFrontend ? `
      env {
        name  = "CORS_ALLOWED_ORIGINS"
        value = "https://\${azurerm_container_app.frontend.ingress[0].fqdn}"
      }
` : '';
  const frontendContainer = plan.includeFrontend ? `
resource "azurerm_container_app" "frontend" {
  name                         = "${names.frontendContainerApp}"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  template {
    container {
      name   = "frontend"
      image  = var.frontend_image
      cpu    = 0.25
      memory = "0.5Gi"
    }
  }

  ingress {
    external_enabled = true
    target_port      = 80
    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  depends_on = [azurerm_role_assignment.acr_pull]
}
` : '';
  const functionWorker = hasFunctionWorker(plan) ? `
resource "azurerm_service_plan" "functions" {
  name                = "${names.functionServicePlan}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = "Y1"
}

resource "azurerm_linux_function_app" "worker" {
  name                       = "${names.functionApp}"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  service_plan_id            = azurerm_service_plan.functions.id
  storage_account_name       = azurerm_storage_account.main.name
  storage_account_access_key = azurerm_storage_account.main.primary_access_key

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  site_config {
    application_stack {
      python_version = var.functions_python_version
    }
  }

  app_settings = {
    APP_ENV                                       = var.environment
    APP_NAME                                      = "${plan.safeProjectName}"
    GENAI_PATTERN                                 = "${functionPattern?.id}"
    FUNCTIONS_WORKER_RUNTIME                      = "python"
    SERVICEBUS_QUEUE_NAME                         = var.function_worker_queue_name
    ServiceBusConnection__clientId                = azurerm_user_assigned_identity.app.client_id
    ServiceBusConnection__fullyQualifiedNamespace = "\${azurerm_servicebus_namespace.main.name}.servicebus.windows.net"
    SHARED_ORCHESTRATION_ROOT                     = "../../backend"
  }
}

resource "azurerm_role_assignment" "function_servicebus_receiver" {
  scope                = azurerm_servicebus_namespace.main.id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "function_storage_blob_contributor" {
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}
` : '';
  return `resource "azurerm_resource_group" "main" {
  name     = "${names.resourceGroup}"
  location = var.location
}

resource "azurerm_container_registry" "main" {
  name                = "${names.containerRegistry}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Basic"
  admin_enabled       = false
}

resource "azurerm_user_assigned_identity" "app" {
  name                = "${names.identity}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_container_app_environment" "main" {
  name                = "${names.containerAppEnvironment}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
}

resource "azurerm_container_app" "backend" {
  name                         = "${names.backendContainerApp}"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  secret {
    name  = "database-url"
    value = "postgresql://liftoffadmin:\${urlencode(var.postgres_admin_password)}@\${azurerm_postgresql_flexible_server.main.fqdn}:5432/postgres?sslmode=require"
  }

  secret {
    name  = "redis-url"
    value = "rediss://:\${urlencode(azurerm_redis_cache.main.primary_access_key)}@\${azurerm_redis_cache.main.hostname}:\${azurerm_redis_cache.main.ssl_port}/0"
  }

  template {
    container {
      name   = "backend"
      image  = var.backend_image
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "APP_ENV"
        value = var.environment
      }

      env {
        name  = "APP_NAME"
        value = "${plan.safeProjectName}"
      }

      env {
        name  = "PROJECT_TYPE"
        value = "${plan.projectType.id}"
      }
${projectIdentityEnv}
      env {
        name  = "CLOUD_PROVIDER"
        value = "azure"
      }

      env {
        name  = "AZURE_REGION"
        value = var.location
      }
${frontendCorsEnvironment}

      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }

      env {
        name        = "REDIS_URL"
        secret_name = "redis-url"
      }

      env {
        name  = "MESSAGING_TRANSPORT"
        value = "azure-service-bus"
      }

      env {
        name  = "BLOB_ENDPOINT"
        value = azurerm_storage_account.main.primary_blob_endpoint
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = var.backend_target_port
    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  depends_on = [azurerm_role_assignment.acr_pull]
}
${frontendContainer}
resource "azurerm_postgresql_flexible_server" "main" {
  name                   = "${names.postgres}"
  resource_group_name    = azurerm_resource_group.main.name
  location               = azurerm_resource_group.main.location
  version                = "16"
  administrator_login    = "liftoffadmin"
  administrator_password = var.postgres_admin_password
  storage_mb             = 32768
  sku_name               = "B_Standard_B1ms"
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  count            = var.enable_private_networking ? 0 : 1
  name             = "AllowAzureServices"
  server_id        = azurerm_postgresql_flexible_server.main.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

resource "azurerm_redis_cache" "main" {
  name                = "${names.redis}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  capacity            = 0
  family              = "C"
  sku_name            = "Basic"
}

resource "azurerm_storage_account" "main" {
  name                     = "${names.storage}"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_storage_container" "documents" {
  name                  = "documents"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

resource "azurerm_servicebus_namespace" "main" {
  name                = "${names.serviceBus}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "Standard"
}

resource "azurerm_servicebus_queue" "events" {
  name         = ${queueName}
  namespace_id = azurerm_servicebus_namespace.main.id
}
${functionWorker}

resource "azurerm_communication_service" "main" {
  name                = "${names.communication}"
  resource_group_name = azurerm_resource_group.main.name
  data_location       = "United States"
}

resource "azurerm_key_vault" "main" {
  name                = "${names.keyVault}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"
}

data "azurerm_client_config" "current" {}
`;
}

function renderTofuOutputs(plan: ProjectPlan): string {
  const functionOutputs = hasFunctionWorker(plan) ? `
output "function_app_name" {
  value = azurerm_linux_function_app.worker.name
}

output "function_worker_queue_name" {
  value = azurerm_servicebus_queue.events.name
}
` : '';
  return `output "backend_url" {
  value = azurerm_container_app.backend.ingress[0].fqdn
}

${plan.includeFrontend ? `output "frontend_url" {
  value = azurerm_container_app.frontend.ingress[0].fqdn
}
` : ''}${functionOutputs}output "container_registry" {
  value = azurerm_container_registry.main.login_server
}

output "container_registry_name" {
  value = azurerm_container_registry.main.name
}
`;
}

function renderTofuLocalState(): string {
  return `# Local state is the V1 default for first-use simplicity.
# Teams can replace this file with backend.remote.example.tf when adopting shared state.
`;
}

function renderTofuRemoteStateExample(): string {
  return `# Rename to backend.tf and configure values for shared state.
# terraform {
#   backend "azurerm" {
#     resource_group_name  = "rg-opentofu-state"
#     storage_account_name = "stliftoffstate"
#     container_name       = "tfstate"
#     key                  = "mission-control/liftoff.tfstate"
#   }
# }
`;
}

function renderTofuReadme(plan: ProjectPlan): string {
  const env = plan.environments[0]?.id ?? 'dev';
  const functionSection = hasFunctionWorker(plan) ? `
## Azure Functions Worker

This project includes an Azure Functions worker under \`functions/${functionWorkerName(plan)}\`. The OpenTofu configuration attaches one user-assigned identity, grants its principal the Service Bus Data Receiver role, and selects it through \`ServiceBusConnection__clientId\` plus \`ServiceBusConnection__fullyQualifiedNamespace\`. \`function_worker_queue_name\` provisions the queue, configures \`SERVICEBUS_QUEUE_NAME\`, and drives the worker queue output. Function host storage uses the complete key-backed \`AzureWebJobsStorage\` connection setting.
` : '';
  return `# Azure OpenTofu

Azure is the complete V1 provider for this Liftoff project.

## Bootstrap Infrastructure

The first apply uses a public bootstrap image so Azure Container Apps can start before the new ACR contains application images.

\`\`\`bash
tofu init
tofu plan -var-file=environments/${env}.tfvars
tofu apply -var-file=environments/${env}.tfvars
\`\`\`

Build the generated backend in ACR, then replace the bootstrap image:

\`\`\`bash
ACR_NAME="$(tofu output -raw container_registry_name)"
az acr build --registry "$ACR_NAME" --image ${plan.safeProjectName}-backend:latest ../../..
${plan.includeFrontend ? `BACKEND_URL="https://$(tofu output -raw backend_url)"
az acr build --registry "$ACR_NAME" --image ${plan.safeProjectName}-frontend:latest --build-arg VITE_API_BASE_URL="$BACKEND_URL" ../../../frontend
` : ''}\`\`\`

Persist the deployed images in \`environments/${env}.tfvars\` so future applies do not restore the bootstrap image:

\`\`\`hcl
backend_image       = "<login-server>/${plan.safeProjectName}-backend:latest"
backend_target_port = 8000
${plan.includeFrontend ? `frontend_image      = "<login-server>/${plan.safeProjectName}-frontend:latest"
` : ''}\`\`\`

\`\`\`bash
tofu apply -var-file=environments/${env}.tfvars
\`\`\`

Local OpenTofu state is generated by default. Use \`backend.remote.example.tf\` as the starting point for team remote state.
The default PostgreSQL firewall permits Azure-hosted services. Replace it with private networking before production; set \`enable_private_networking=true\` only when the required VNet, delegated subnet, and private DNS resources are added.

## Azure Name Suffixes

Each environment tfvars file contains a deterministic 12-character lowercase alphanumeric \`resource_suffix\` used by globally scoped Azure names. If Azure reports that a name is already taken, replace that environment's suffix with another unique value matching \`^[a-z0-9]{12}$\`; \`tofu validate\` rejects invalid overrides before deployment.
${functionSection}
`;
}

function renderTofuTfvars(plan: ProjectPlan, environment: string): string {
  const values: Array<[string, string]> = [
    ['environment', JSON.stringify(environment)],
    ['location', JSON.stringify(plan.region.slug)],
    ['resource_suffix', JSON.stringify(stableResourceSuffix(plan, environment))],
    ['backend_image', JSON.stringify('mcr.microsoft.com/azuredocs/containerapps-helloworld:latest')],
    ['backend_target_port', '80'],
    ['enable_private_networking', 'false']
  ];
  if (plan.includeFrontend) {
    values.push(['frontend_image', JSON.stringify('mcr.microsoft.com/azuredocs/containerapps-helloworld:latest')]);
  }
  if (hasFunctionWorker(plan)) {
    values.push(
      ['function_worker_queue_name', JSON.stringify(DEFAULT_FUNCTION_WORKER_QUEUE_NAME)],
      ['functions_python_version', JSON.stringify('3.12')]
    );
  }
  const width = Math.max(...values.map(([key]) => key.length));
  return values.map(([key, value]) => `${key.padEnd(width)} = ${value}`).join('\n');
}

function renderOpenSpecConfig(plan: ProjectPlan): string {
  const frontendRule = plan.includeFrontend ? '\n    - Keep frontend code under frontend.' : '';
  if (plan.projectType.id === 'standard') {
    const backendRule = plan.apiStack.id === 'python-fastapi'
      ? 'Keep backend API code under backend/apis.'
      : plan.apiStack.id === 'node-fastify'
        ? 'Keep backend API code under backend/src.'
        : 'Keep the Go entrypoint under backend/cmd/api and reusable code under backend/internal.';
    return `schema: spec-driven

context: |
  Project generated by Mission Control Liftoff.
  Project type: Standard application.
  API stack: ${plan.apiStack.label}.
  Database tooling: ${plan.apiStack.databaseTooling}.
  API developer portal: Scalar.
  Infrastructure: OpenTofu.
  Primary cloud: Azure (${plan.region.slug}).
  Local development: Docker Compose.
  Database: PostgreSQL.
  Cache and local messaging: Redis.
  Environments: ${plan.environments.map((environment) => environment.id).join(', ')}.

rules:
  specs:
    - Requirements must describe observable product behavior.
    - Cloud behavior must identify environment differences for generated environments.
  design:
    - Use ${plan.apiStack.framework} for backend APIs.
    - Use ${plan.apiStack.databaseTooling} for database access and migrations.
    - Use OpenTofu for infrastructure changes.${frontendRule}
    - ${backendRule}
    - Keep database artifacts under database.
  tasks:
    - Include local Docker Compose verification.
    - Include OpenTofu validation for generated infrastructure.
`;
  }

  const pattern = genAiPattern(plan);
  const functionsContext = hasFunctionWorker(plan) ? `
  Azure Functions worker: functions/${functionWorkerName(plan)}.` : '';
  const functionsRule = hasFunctionWorker(plan) ? `
    - Keep Azure Functions trigger adapters under functions/${functionWorkerName(plan)}.
    - Keep reusable GenAI orchestration under backend/orchestration.` : '';
  return `schema: spec-driven

context: |
  Project generated by Mission Control Liftoff.
  GenAI pattern: ${pattern.label}
  Application framework: FastAPI + PydanticAI.
  API developer portal: Scalar.
  Infrastructure: OpenTofu.
  Primary cloud: Azure (${plan.region.slug}).
  Local development: Docker Compose.
  Database: PostgreSQL with Alembic migrations.
  Cache and local messaging: Redis.
  Observability: Langfuse.
  Environments: ${plan.environments.map((environment) => environment.id).join(', ')}.
${functionsContext}

rules:
  specs:
    - Requirements must describe observable product behavior.
    - Cloud behavior must identify environment differences for generated environments.
  design:
    - Use PydanticAI for orchestration logic.
    - Use Pydantic settings models for runtime configuration.
    - Use OpenTofu for infrastructure changes.${frontendRule}
    - Keep backend API code under backend/apis.
${functionsRule}
    - Keep database artifacts under database.
  tasks:
    - Include local Docker Compose verification.
    - Include OpenTofu validation for generated infrastructure.
`;
}

function renderSeedProposal(plan: ProjectPlan): string {
  if (plan.projectType.id === 'standard') {
    return `## Why

Bootstrap the generated ${plan.apiStack.label} standard application baseline created by Mission Control Liftoff.

## What Changes

- Establish the approved backend, infrastructure, local development, and governance baseline.
- Capture follow-up product requirements through spec-driven changes.

## Capabilities

### New Capabilities

- \`${plan.apiStack.id}-application-baseline\`: Generated standard application baseline for this Liftoff project.

### Modified Capabilities

- None.

## Impact

- Generated ${plan.apiStack.label} backend, OpenTofu infrastructure, Docker Compose local development, and governance files.
`;
  }

  const pattern = genAiPattern(plan);
  const functionsChange = hasFunctionWorker(plan) ? '\n- Establish Azure Functions worker trigger adapters for event-driven processing.' : '';
  return `## Why

Bootstrap the generated ${pattern.label} application baseline created by Mission Control Liftoff.

## What Changes

- Establish the approved backend, infrastructure, local development, and governance baseline.
- Capture follow-up product requirements through spec-driven changes.
${functionsChange}

## Capabilities

### New Capabilities

- \`${pattern.id}-application-baseline\`: Generated application baseline for this Liftoff project.

### Modified Capabilities

- None.

## Impact

- Generated FastAPI/PydanticAI backend, OpenTofu infrastructure, Docker Compose local development, and governance files.
`;
}

function renderSeedDesign(plan: ProjectPlan): string {
  if (plan.projectType.id === 'standard') {
    return `## Context

This standard project was generated with Liftoff using ${plan.apiStack.label}, Azure, OpenTofu, and ${plan.specWorkflow.label}.

## Goals / Non-Goals

**Goals:**

- Keep the generated baseline aligned to the approved Mission Control stack.

**Non-Goals:**

- Define domain-specific product behavior in the bootstrap change.

## Decisions

- Use ${plan.apiStack.framework} for backend APIs.
- Use ${plan.apiStack.databaseTooling} for PostgreSQL integration.
- Use OpenTofu for Azure infrastructure.
- Use Docker Compose for local development.

## Risks / Trade-offs

- The baseline contains placeholders that product-specific changes should replace.
`;
  }

  const pattern = genAiPattern(plan);
  const functionsDecision = hasFunctionWorker(plan) ? '\n- Keep Azure Functions trigger adapters under functions/' + functionWorkerName(plan) + ' and shared GenAI logic under backend/orchestration.' : '';
  return `## Context

This project was generated with Liftoff using ${pattern.label}, Azure, OpenTofu, and ${plan.specWorkflow.label}.

## Goals / Non-Goals

**Goals:**

- Keep the generated baseline aligned to the approved Mission Control stack.

**Non-Goals:**

- Define domain-specific product behavior in the bootstrap change.

## Decisions

- Use FastAPI and PydanticAI for backend APIs and orchestration.
- Use OpenTofu for Azure infrastructure.
- Use Docker Compose for local development.
${functionsDecision}

## Risks / Trade-offs

- The baseline contains placeholders that product-specific changes should replace.
`;
}

function renderSeedTasks(): string {
  return `## 1. Bootstrap Review

- [ ] 1.1 Review generated baseline and replace placeholders with domain-specific requirements.
- [ ] 1.2 Validate local Docker Compose startup.
- [ ] 1.3 Validate OpenTofu plan for the first target environment.
`;
}

function renderSpecKitConstitution(plan: ProjectPlan): string {
  if (plan.projectType.id === 'standard') {
    const backendLayout = plan.apiStack.id === 'python-fastapi'
      ? 'backend/apis'
      : plan.apiStack.id === 'node-fastify' ? 'backend/src' : 'backend/cmd/api and backend/internal';
    return `# Mission Control Liftoff Constitution

## Principle 1: Approved Application Stack
Generated backend services MUST use ${plan.apiStack.framework}, ${plan.apiStack.databaseTooling}, and Scalar for API documentation.

## Principle 2: Standard Project Layout
Backend APIs live under ${backendLayout}. Database artifacts live under database.${plan.includeFrontend ? ' Frontend code lives under frontend.' : ''}

## Principle 3: Infrastructure As Code
Cloud infrastructure MUST be defined with OpenTofu. Azure is the supported V1 provider.

## Principle 4: Local Development Parity
Projects MUST include Docker Compose for local development with PostgreSQL, Redis, local blob storage, and local messaging behavior.

## Principle 5: Observability And Operations
Services MUST use structured logging and environment-specific configuration for ${plan.environments.map((environment) => environment.id).join(', ')}.
`;
  }

  const functionsLayout = hasFunctionWorker(plan) ? ` Azure Functions trigger adapters live under functions/${functionWorkerName(plan)} and call shared orchestration from backend/orchestration.` : '';
  return `# Mission Control Liftoff Constitution

## Principle 1: Approved Application Stack
Generated backend services MUST use FastAPI, PydanticAI, Pydantic configuration models, and Scalar for API documentation.

## Principle 2: Standard Project Layout
Backend APIs live under backend/apis. Database artifacts live under database.${plan.includeFrontend ? ' Frontend code lives under frontend.' : ''}${functionsLayout}

## Principle 3: Infrastructure As Code
Cloud infrastructure MUST be defined with OpenTofu. Azure is the supported V1 provider.

## Principle 4: Local Development Parity
Projects MUST include Docker Compose for local development with PostgreSQL, Redis, local blob storage, and local messaging behavior.

## Principle 5: Observability And Operations
LLM workflows MUST include Langfuse tracing hooks and environment-specific configuration for ${plan.environments.map((environment) => environment.id).join(', ')}.
`;
}

function renderSpecKitSpecTemplate(): string {
  return `# Feature Specification

## User Scenarios

## Requirements

## Success Criteria
`;
}

function renderSpecKitPlanTemplate(): string {
  return `# Implementation Plan

## Technical Context

## Constitution Check

## Tasks
`;
}

function renderFrontendPackage(plan: ProjectPlan): string {
  return JSON.stringify({
    name: `${plan.safeProjectName}-frontend`,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview'
    },
    dependencies: {
      '@vitejs/plugin-vue': '^5.0.5',
      vite: '^5.3.1',
      vue: '^3.4.29',
      tailwindcss: '^3.4.4',
      autoprefixer: '^10.4.19',
      postcss: '^8.4.38'
    }
  }, null, 2);
}

function renderFrontendIndex(plan: ProjectPlan): string {
  return `<div id="app"></div><script type="module" src="/src/main.ts"></script><title>${escapeHtml(plan.projectName)}</title>`;
}

function renderFrontendMain(): string {
  return `import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';

createApp(App).mount('#app');
`;
}

function renderFrontendApp(plan: ProjectPlan): string {
  const descriptor = plan.projectType.id === 'genai' ? `${genAiPattern(plan).label} starter` : `${plan.apiStack.label} starter`;
  const apiContract = plan.projectType.id === 'standard'
    ? { route: '/api', method: 'GET', bodyField: '', queryParameter: '', requiresInput: false }
    : genAiPattern(plan).id === 'rag'
      ? { route: `${genAiPattern(plan).routePrefix}/query`, method: 'POST', bodyField: 'question', queryParameter: '', requiresInput: true }
      : genAiPattern(plan).id === 'streaming'
        ? { route: genAiPattern(plan).routePrefix, method: 'GET', bodyField: '', queryParameter: 'prompt', requiresInput: true }
        : { route: `${genAiPattern(plan).routePrefix}/run`, method: 'POST', bodyField: 'input', queryParameter: '', requiresInput: true };
  return `<script setup lang="ts">
import { ref } from 'vue';

const title = ${scriptSourceString(plan.projectName)};
const starter = ${scriptSourceString(plan.frontendStarter)};
const descriptor = ${scriptSourceString(descriptor)};
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\\/+$/, '');
const route = ${scriptSourceString(apiContract.route)};
const method = ${scriptSourceString(apiContract.method)};
const bodyField = ${scriptSourceString(apiContract.bodyField)};
const queryParameter = ${scriptSourceString(apiContract.queryParameter)};
const requiresInput = ${apiContract.requiresInput};

const input = ref('');
const loading = ref(false);
const result = ref('');
const errorMessage = ref('');

async function submit(): Promise<void> {
  const value = input.value.trim();
  if (requiresInput && !value) {
    errorMessage.value = 'Enter a value before running the starter.';
    return;
  }

  loading.value = true;
  result.value = '';
  errorMessage.value = '';
  try {
    const query = queryParameter
      ? '?' + queryParameter + '=' + encodeURIComponent(value)
      : '';
    const request: RequestInit = { method };
    if (method === 'POST') {
      request.headers = { 'Content-Type': 'application/json' };
      request.body = JSON.stringify({ [bodyField]: value });
    }
    const response = await fetch(apiBaseUrl + route + query, request);
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        'Backend request failed (' + response.status + '): ' +
        (responseText || response.statusText)
      );
    }
    if ((response.headers.get('content-type') || '').includes('application/json')) {
      result.value = JSON.stringify(JSON.parse(responseText), null, 2);
    } else {
      result.value = responseText;
    }
  } catch (error) {
    errorMessage.value = error instanceof Error
      ? error.message
      : 'The backend request failed unexpectedly.';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 text-slate-950">
    <section class="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <header>
        <p class="text-sm font-semibold uppercase tracking-wide text-emerald-700">Mission Control Liftoff</p>
        <h1 class="mt-2 text-3xl font-bold">{{ title }}</h1>
        <p class="mt-2 text-slate-600">{{ descriptor }}</p>
      </header>
      <section class="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="text-xl font-semibold">{{ starter }}</h2>
        <p class="mt-2 text-sm text-slate-500">API: {{ apiBaseUrl }}{{ route }}</p>
        <textarea
          v-if="requiresInput"
          v-model="input"
          class="mt-4 min-h-40 w-full rounded-md border border-slate-300 p-3"
          :disabled="loading"
          placeholder="Enter input for the generated backend."
        />
        <button
          class="mt-4 rounded-md bg-emerald-700 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="loading"
          type="button"
          @click="submit"
        >
          {{ loading ? 'Running...' : 'Run' }}
        </button>
        <p v-if="errorMessage" class="mt-4 rounded-md bg-red-50 p-3 text-red-800" role="alert">
          {{ errorMessage }}
        </p>
        <pre v-if="result" class="mt-4 overflow-auto rounded-md bg-slate-950 p-4 text-sm text-white" aria-live="polite">{{ result }}</pre>
      </section>
    </section>
  </main>
</template>
`;
}

function renderFrontendStyles(): string {
  return `@tailwind base;
@tailwind components;
@tailwind utilities;
`;
}

function renderFrontendViteConfig(): string {
  return `import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({ plugins: [vue()] });
`;
}

function renderFrontendTailwindConfig(): string {
  return `import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: { extend: {} },
  plugins: []
} satisfies Config;
`;
}

function renderFrontendDockerfile(): string {
  return `FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
ARG VITE_API_BASE_URL=http://localhost:8000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
`;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}