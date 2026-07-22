import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { apiStacks, patterns } from '../src/catalogs.js';
import { artifactPath, assertNewOrEmptyDirectory, validateGeneratedProject, writeArtifacts } from '../src/file-system.js';
import { buildProjectPlan } from '../src/planner.js';
import { AZURE_NAME_LIMITS, buildArtifacts, buildAzureResourceNames } from '../src/templates.js';

describe('templates and filesystem', () => {
  it('omits frontend artifacts when frontend is disabled', () => {
    const plan = buildProjectPlan({ projectName: 'API Only', pattern: 'prompt', cloud: 'azure', includeFrontend: false }, { requireProjectName: true });
    const artifacts = buildArtifacts(plan);

    expect(artifacts.some((artifact) => artifact.pathParts[0] === 'frontend')).toBe(false);
    expect(artifacts.some((artifact) => artifact.pathParts.join('/') === 'backend/apis/main.py')).toBe(true);
    expect(artifacts.some((artifact) => artifact.pathParts.join('/') === 'database/alembic.ini')).toBe(true);
  });

  it('includes pattern-aware frontend and RAG vector artifacts when enabled', () => {
    const plan = buildProjectPlan({ projectName: 'RAG UI', pattern: 'rag', cloud: 'azure', region: 'eastus', includeFrontend: true }, { requireProjectName: true });
    const artifacts = buildArtifacts(plan);

    expect(artifacts.some((artifact) => artifact.pathParts.join('/') === 'frontend/src/App.vue')).toBe(true);
    expect(artifacts.some((artifact) => artifact.pathParts.join('/') === 'backend/orchestration/retrieval/vector_store.py')).toBe(true);
    expect(artifacts.find((artifact) => artifact.pathParts.join('/') === 'docker-compose.yml')?.content).toContain('profiles:');
    expect(artifacts.find((artifact) => artifact.pathParts.join('/') === 'infrastructure/opentofu/azure/main.tf')?.content).toContain('azurerm_servicebus_namespace');
  });

  it('renders functional and offline-testable GenAI integration boundaries', () => {
    const artifacts = buildArtifacts(buildProjectPlan({
      projectName: 'Functional RAG',
      pattern: 'rag',
      cloud: 'azure'
    }, { requireProjectName: true }));
    const contentAt = (artifactPath: string) =>
      artifacts.find((artifact) => artifact.pathParts.join('/') === artifactPath)?.content ?? '';

    expect(contentAt('backend/orchestration/model_config.py')).toContain('from pydantic_ai import Agent');
    expect(contentAt('backend/pyproject.toml')).toContain('pydantic-ai-slim[openai]==1.107.1');
    expect(contentAt('backend/pyproject.toml')).toContain('langfuse==2.60.10');
    expect(contentAt('backend/orchestration/model_config.py')).toContain('PYDANTIC_AI_MODEL is required');
    expect(contentAt('backend/orchestration/agents/rag_agent.py')).toContain('build_agent_runner');
    expect(contentAt('backend/orchestration/agents/rag_agent.py')).toContain('selected_tracer.trace');
    expect(contentAt('backend/orchestration/agents/rag_agent.py')).not.toContain('Replace this placeholder');
    expect(contentAt('backend/tests/test_rag_orchestration.py')).toContain('FakeRunner');
    expect(contentAt('backend/tests/test_rag_orchestration.py')).toContain('without_network');

    const messaging = contentAt('backend/orchestration/tools/messaging.py');
    expect(messaging).toContain('self._client.xadd');
    expect(messaging).toContain('await sender.send_messages');
    expect(contentAt('backend/tests/test_messaging.py')).toContain('FakeServiceBusClient');

    const tracing = contentAt('backend/observability/tracing.py');
    expect(tracing).toContain('class DisabledTracer');
    expect(tracing).toContain('trace_id=None');
    expect(tracing).toContain('self._client.trace');
    expect(contentAt('backend/tests/test_tracing.py')).toContain('trace.trace_id is None');
  });

  it('generates Azure Functions workers only for worker-enabled patterns', () => {
    const workerPlan = buildProjectPlan({ projectName: 'RAG Worker', pattern: 'rag', cloud: 'azure', region: 'eastus' }, { requireProjectName: true });
    const workerArtifacts = buildArtifacts(workerPlan);
    const workerPaths = workerArtifacts.map((artifact) => path.join(...artifact.pathParts));

    expect(workerPaths).toContain(path.join('functions', 'rag-worker', 'function_app.py'));
    expect(workerPaths).toContain(path.join('functions', 'rag-worker', 'host.json'));
    expect(workerPaths).toContain(path.join('environments', 'dev', 'functions.env'));
    expect(workerArtifacts.find((artifact) => artifact.pathParts.join('/') === 'functions/rag-worker/function_app.py')?.content).toContain('@app.service_bus_queue_trigger');
    expect(workerArtifacts.find((artifact) => artifact.pathParts.join('/') === 'functions/rag-worker/function_app.py')?.content).toContain('backend.orchestration');
    expect(workerArtifacts.find((artifact) => artifact.pathParts.join('/') === 'README.md')?.content).toContain('functions/rag-worker');

    const nonWorkerPlan = buildProjectPlan({ projectName: 'Prompt App', pattern: 'prompt', cloud: 'azure', region: 'eastus' }, { requireProjectName: true });
    const nonWorkerArtifacts = buildArtifacts(nonWorkerPlan);

    expect(nonWorkerArtifacts.some((artifact) => artifact.pathParts[0] === 'functions')).toBe(false);
    expect(nonWorkerArtifacts.some((artifact) => artifact.pathParts.join('/') === 'environments/dev/functions.env')).toBe(false);
  });

  it('generates Spec Kit governance when selected', () => {
    const plan = buildProjectPlan({ projectName: 'Spec Kit App', pattern: 'chatbot', cloud: 'azure', specWorkflow: 'spec-kit' }, { requireProjectName: true });
    const artifacts = buildArtifacts(plan);

    expect(artifacts.some((artifact) => artifact.pathParts.join('/') === '.specify/memory/constitution.md')).toBe(true);
    expect(artifacts.some((artifact) => artifact.pathParts.join('/') === 'openspec/config.yaml')).toBe(false);
    expect(artifacts.find((artifact) => artifact.pathParts.join('/') === '.specify/memory/constitution.md')?.content).not.toContain('functions/');

    const workerPlan = buildProjectPlan({ projectName: 'Workflow Kit App', pattern: 'workflow', cloud: 'azure', specWorkflow: 'spec-kit' }, { requireProjectName: true });
    const workerArtifacts = buildArtifacts(workerPlan);
    expect(workerArtifacts.find((artifact) => artifact.pathParts.join('/') === '.specify/memory/constitution.md')?.content).toContain('functions/workflow-worker');
  });

  it('tracks generated artifacts with path parts instead of slash-delimited paths', () => {
    const plan = buildProjectPlan({ projectName: 'Manifest App', pattern: 'workflow', cloud: 'azure' }, { requireProjectName: true });
    const artifacts = buildArtifacts(plan);
    const manifest = JSON.parse(artifacts.find((artifact) => artifact.logicalName === 'manifest')?.content ?? '{}');
    const functionArtifact = manifest.artifacts.find((artifact: { logicalName: string }) => artifact.logicalName === 'function-worker-app');

    expect(manifest.artifacts.every((artifact: { pathParts: string[] }) => Array.isArray(artifact.pathParts))).toBe(true);
    expect(manifest.artifacts.some((artifact: { pathParts: string[] }) => artifact.pathParts.includes('backend'))).toBe(true);
    expect(functionArtifact?.pathParts).toEqual(['functions', 'workflow-worker', 'function_app.py']);
    expect(artifactPath(path.join('generated-root'), functionArtifact.pathParts)).toBe(path.join('generated-root', 'functions', 'workflow-worker', 'function_app.py'));
  });

  it('generates manifests for every pattern with frontend enabled and disabled', () => {
    for (const pattern of patterns) {
      for (const includeFrontend of [false, true]) {
        const plan = buildProjectPlan({
          projectName: `${pattern.id} app`,
          pattern: pattern.id,
          cloud: 'azure',
          includeFrontend
        }, { requireProjectName: true });
        const artifacts = buildArtifacts(plan);
        const paths = artifacts.map((artifact) => artifact.pathParts.join('/'));

        expect(paths).toContain('backend/apis/main.py');
        expect(paths).toContain('database/alembic.ini');
        expect(paths).toContain('docker-compose.yml');
        expect(paths).toContain('infrastructure/opentofu/azure/main.tf');
        expect(paths).toContain('liftoff.manifest.json');
        expect(paths.some((artifactPath) => artifactPath.startsWith('frontend/'))).toBe(includeFrontend);
        expect(artifacts.some((artifact) => artifact.pathParts[0] === 'functions')).toBe(pattern.worker);
      }
    }
  });

  it('generates complete standard projects for every API stack without GenAI artifacts', () => {
    const expectedEntrypoints = {
      'python-fastapi': 'backend/apis/main.py',
      'node-fastify': 'backend/src/server.ts',
      'go-huma': 'backend/cmd/api/main.go'
    };

    for (const stack of apiStacks) {
      const plan = buildProjectPlan({
        projectName: `${stack.id} app`,
        projectType: 'standard',
        apiStack: stack.id,
        cloud: 'azure'
      }, { requireProjectName: true });
      const artifacts = buildArtifacts(plan);
      const paths = artifacts.map((artifact) => artifact.pathParts.join('/'));
      const allContent = artifacts.map((artifact) => artifact.content).join('\n');

      expect(paths).toContain(expectedEntrypoints[stack.id]);
      expect(paths).toContain('database/models/schema.sql');
      expect(paths).toContain('docker-compose.yml');
      expect(paths).toContain('infrastructure/opentofu/azure/main.tf');
      expect(paths.some((artifactPath) => artifactPath.startsWith('backend/orchestration/'))).toBe(false);
      expect(paths.some((artifactPath) => artifactPath.startsWith('functions/'))).toBe(false);
      expect(allContent).not.toContain('PydanticAI');
      expect(allContent).not.toContain('Langfuse');
      expect(artifacts.find((artifact) => artifact.pathParts.join('/') === '.env.example')?.content).toContain('DATABASE_URL=postgresql:');
      expect(artifacts.find((artifact) => artifact.pathParts.join('/') === '.env.example')?.content).not.toContain('******');
      expect(artifacts.find((artifact) => artifact.pathParts.join('/') === 'docker-compose.yml')?.content).toContain('postgres:16-alpine');
      expect(artifacts.find((artifact) => artifact.pathParts.join('/') === 'docker-compose.yml')?.content).not.toContain('profiles:');
    }
  });

  it('renders stack-native dependencies and database tooling', () => {
    const pythonArtifacts = buildArtifacts(buildProjectPlan({
      projectName: 'Python API',
      projectType: 'standard',
      apiStack: 'python',
      cloud: 'azure'
    }, { requireProjectName: true }));
    expect(pythonArtifacts.find((artifact) => artifact.pathParts.join('/') === 'backend/pyproject.toml')?.content).toContain('sqlalchemy');
    expect(pythonArtifacts.find((artifact) => artifact.pathParts.join('/') === 'backend/pyproject.toml')?.content).not.toContain('pydantic-ai');
    expect(pythonArtifacts.some((artifact) => artifact.pathParts.join('/') === 'database/alembic.ini')).toBe(true);
    expect(pythonArtifacts.find((artifact) => artifact.pathParts.join('/') === 'database/migrations/env.py')?.content).toContain('DATABASE_URL');

    const nodeArtifacts = buildArtifacts(buildProjectPlan({
      projectName: 'Node API',
      projectType: 'standard',
      apiStack: 'node',
      cloud: 'azure'
    }, { requireProjectName: true }));
    const nodePackage = nodeArtifacts.find((artifact) => artifact.pathParts.join('/') === 'backend/package.json')?.content ?? '';
    const nodeDrizzle = nodeArtifacts.find((artifact) => artifact.pathParts.join('/') === 'backend/drizzle.config.ts')?.content ?? '';
    expect(nodePackage).toContain('"fastify"');
    expect(nodePackage).toContain('"drizzle-orm"');
    expect(nodeDrizzle).toContain('postgresql:');
    expect(nodeDrizzle).not.toContain('******');
    expect(nodeArtifacts.some((artifact) => artifact.pathParts.join('/') === 'database/migrations/0000_initial.sql')).toBe(true);
    expect(nodeArtifacts.some((artifact) => artifact.pathParts.join('/') === 'database/migrations/meta/_journal.json')).toBe(true);
    expect(nodeArtifacts.some((artifact) => artifact.pathParts.join('/') === 'database/migrations/meta/0000_snapshot.json')).toBe(true);

    const goArtifacts = buildArtifacts(buildProjectPlan({
      projectName: 'Go API',
      projectType: 'standard',
      apiStack: 'go',
      cloud: 'azure'
    }, { requireProjectName: true }));
    expect(goArtifacts.find((artifact) => artifact.pathParts.join('/') === 'backend/go.mod')?.content).toContain('huma/v2');
    expect(goArtifacts.find((artifact) => artifact.pathParts.join('/') === 'backend/Makefile')?.content).toContain('pressly/goose');
    expect(goArtifacts.find((artifact) => artifact.pathParts.join('/') === 'backend/internal/database/database.go')?.content).toContain('pgxpool');
    const goApi = goArtifacts.find((artifact) => artifact.pathParts.join('/') === 'backend/internal/api/api.go')?.content ?? '';
    expect(goApi).toContain('config.OpenAPIPath = "/openapi"');
    expect(goApi).toContain('data-url="/openapi.json"');
  });

  it('renders standard frontend, governance, and infrastructure without AI requirements', () => {
    const artifacts = buildArtifacts(buildProjectPlan({
      projectName: 'Standard UI',
      projectType: 'standard',
      apiStack: 'node',
      cloud: 'azure',
      includeFrontend: true
    }, { requireProjectName: true }));
    const frontend = artifacts.find((artifact) => artifact.pathParts.join('/') === 'frontend/src/App.vue')?.content ?? '';
    const governance = artifacts.find((artifact) => artifact.pathParts.join('/') === 'openspec/config.yaml')?.content ?? '';
    const tofu = artifacts.find((artifact) => artifact.pathParts.join('/') === 'infrastructure/opentofu/azure/main.tf')?.content ?? '';

    expect(frontend).toContain('Node.js / Fastify / TypeScript starter');
    expect(frontend).not.toContain('GenAI');
    expect(governance).toContain('Fastify with TypeScript');
    expect(governance).not.toContain('PydanticAI');
    expect(tofu).toContain('azurerm_container_app');
    expect(tofu).toContain('role_definition_name = "AcrPull"');
    expect(tofu).toContain('name        = "DATABASE_URL"');
    expect(tofu).toContain('name  = "API_STACK"');
    expect(tofu).toContain('image  = var.backend_image');
    expect(tofu).toContain('azurerm_postgresql_flexible_server_firewall_rule');
    expect(tofu).not.toContain('azurerm_linux_function_app');
    const tfvars = artifacts.find((artifact) => artifact.pathParts.join('/') === 'infrastructure/opentofu/azure/environments/dev.tfvars')?.content ?? '';
    const tofuReadme = artifacts.find((artifact) => artifact.pathParts.join('/') === 'infrastructure/opentofu/azure/README.md')?.content ?? '';
    expect(tfvars).toContain('backend_image');
    expect(tfvars).toContain('backend_target_port');
    expect(tofuReadme).toContain('Persist the deployed images');
  });

  it('escapes project names embedded in generated frontend scripts', () => {
    const artifacts = buildArtifacts(buildProjectPlan({
      projectName: '</script><script>alert("x")</script>',
      projectType: 'standard',
      apiStack: 'node',
      cloud: 'azure',
      includeFrontend: true
    }, { requireProjectName: true }));
    const frontend = artifacts.find((artifact) => artifact.pathParts.join('/') === 'frontend/src/App.vue')?.content ?? '';

    expect(frontend).toContain('\\u003c/script>');
    expect(frontend).not.toContain('const title = "</script>');
  });

  it('renders a route-aware frontend with observable request states', () => {
    const artifacts = buildArtifacts(buildProjectPlan({
      projectName: 'RAG Frontend',
      pattern: 'rag',
      cloud: 'azure',
      includeFrontend: true
    }, { requireProjectName: true }));
    const frontend = artifacts.find((artifact) => artifact.pathParts.join('/') === 'frontend/src/App.vue')?.content ?? '';
    const frontendEnv = artifacts.find((artifact) => artifact.pathParts.join('/') === 'frontend/.env.example')?.content ?? '';

    expect(frontend).toContain("const route = \"/api/rag/query\"");
    expect(frontend).toContain("const bodyField = \"question\"");
    expect(frontend).toContain('VITE_API_BASE_URL');
    expect(frontend).toContain('encodeURIComponent');
    expect(frontend).toContain('loading.value = true');
    expect(frontend).toContain('errorMessage.value');
    expect(frontend).toContain('await fetch');
    expect(frontendEnv).toContain('VITE_API_BASE_URL=http://localhost:8000');
  });

  it('configures CORS for every generated backend and deployed frontend', () => {
    const genAiArtifacts = buildArtifacts(buildProjectPlan({
      projectName: 'CORS RAG',
      pattern: 'rag',
      cloud: 'azure',
      includeFrontend: true
    }, { requireProjectName: true }));
    const genAiMain = genAiArtifacts.find((artifact) => artifact.pathParts.join('/') === 'backend/apis/main.py')?.content ?? '';
    const genAiEnv = genAiArtifacts.find((artifact) => artifact.pathParts.join('/') === 'environments/dev/backend.env')?.content ?? '';
    const tofu = genAiArtifacts.find((artifact) => artifact.pathParts.join('/') === 'infrastructure/opentofu/azure/main.tf')?.content ?? '';
    const tofuReadme = genAiArtifacts.find((artifact) => artifact.pathParts.join('/') === 'infrastructure/opentofu/azure/README.md')?.content ?? '';

    expect(genAiMain).toContain('CORSMiddleware');
    expect(genAiEnv).toContain('CORS_ALLOWED_ORIGINS=http://localhost:5173');
    expect(tofu).toContain('name  = "CORS_ALLOWED_ORIGINS"');
    expect(tofu).toContain('azurerm_container_app.frontend.ingress[0].fqdn');
    expect(tofuReadme).toContain('--build-arg VITE_API_BASE_URL="$BACKEND_URL"');

    const standardContents = Object.fromEntries(['python', 'node', 'go'].map((apiStack) => {
      const artifacts = buildArtifacts(buildProjectPlan({
        projectName: `${apiStack} CORS`,
        projectType: 'standard',
        apiStack,
        cloud: 'azure',
        includeFrontend: true
      }, { requireProjectName: true }));
      return [apiStack, artifacts.map((artifact) => artifact.content).join('\n')];
    }));
    expect(standardContents.python).toContain('CORSMiddleware');
    expect(standardContents.node).toContain('@fastify/cors');
    expect(standardContents.go).toContain('Access-Control-Allow-Origin');
  });

  it('documents safe updates, starter configuration, Azure suffixes, and Function identity', () => {
    const artifacts = buildArtifacts(buildProjectPlan({
      projectName: 'Documented RAG',
      pattern: 'rag',
      cloud: 'azure',
      includeFrontend: true
    }, { requireProjectName: true }));
    const contentAt = (artifactPath: string) =>
      artifacts.find((artifact) => artifact.pathParts.join('/') === artifactPath)?.content ?? '';
    const readme = contentAt('README.md');
    const tofuReadme = contentAt('infrastructure/opentofu/azure/README.md');
    const functionReadme = contentAt('functions/rag-worker/README.md');

    expect(readme).toContain('PYDANTIC_AI_MODEL');
    expect(readme).toContain('VITE_API_BASE_URL');
    expect(readme).toContain('occupied destination');
    expect(readme).toContain('symlink-escaping manifest paths');
    expect(readme).toContain('liftoff <command> --help');
    expect(tofuReadme).toContain('resource_suffix');
    expect(tofuReadme).toContain('^[a-z0-9]{12}$');
    expect(tofuReadme).toContain('ServiceBusConnection__clientId');
    expect(functionReadme).toContain('AzureWebJobsStorage');
    expect(functionReadme).toContain('python -m pytest -q');
  });

  it('generates OpenTofu and Docker Compose validation hooks', () => {
    const plan = buildProjectPlan({ projectName: 'Infra App', pattern: 'rag', cloud: 'azure', includeFrontend: true }, { requireProjectName: true });
    const artifacts = buildArtifacts(plan);
    const tofuMain = artifacts.find((artifact) => artifact.pathParts.join('/') === 'infrastructure/opentofu/azure/main.tf')?.content ?? '';
    const compose = artifacts.find((artifact) => artifact.pathParts.join('/') === 'docker-compose.yml')?.content ?? '';

    expect(tofuMain).toContain('azurerm_container_app');
    expect(tofuMain).toContain('azurerm_key_vault');
    expect(tofuMain).toContain('azurerm_servicebus_namespace');
    expect(tofuMain).toContain('azurerm_linux_function_app');
    expect(tofuMain).toContain('Azure Service Bus Data Receiver');
    expect(tofuMain).toContain('ServiceBusConnection__clientId');
    expect(tofuMain).toContain('azurerm_user_assigned_identity.app.client_id');
    expect(tofuMain).not.toContain('AzureWebJobsStorage__accountName');
    expect(tofuMain).toMatch(/resource "azurerm_servicebus_queue" "events" \{\s+name\s+= var\.function_worker_queue_name/s);
    expect(artifacts.find((artifact) => artifact.pathParts.join('/') === 'infrastructure/opentofu/azure/outputs.tf')?.content).toContain('function_app_name');
    const devTfvars = artifacts.find(
      (artifact) => artifact.pathParts.join('/') === 'infrastructure/opentofu/azure/environments/dev.tfvars'
    )?.content ?? '';
    expect(devTfvars).toContain('function_worker_queue_name');
    expect(devTfvars).toMatch(/resource_suffix\s+= "[a-f0-9]{12}"/);
    expect(compose).toContain('pgvector/pgvector:pg16');
    expect(compose).toContain('azurite');
    expect(compose).toContain('mailpit');
    expect(compose).toContain('profiles:');
  });

  it('bounds Azure resource names and creates deterministic environment suffixes', () => {
    const plan = buildProjectPlan({
      projectName: 'Claims Copilot With An Extremely Long Workload Name That Exceeds Azure Limits',
      pattern: 'rag',
      cloud: 'azure',
      environments: ['dev', 'test', 'prod']
    }, { requireProjectName: true });
    const names = buildAzureResourceNames(plan, 'prod', 'abcdef123456');

    for (const [name, value] of Object.entries(names) as Array<[keyof typeof names, string]>) {
      expect(value.length, `${name} exceeds its Azure limit`).toBeLessThanOrEqual(AZURE_NAME_LIMITS[name]);
      expect(value, `${name} contains unsupported characters`).toMatch(/^[a-z0-9-]+$/);
    }
    expect(names.containerRegistry).toMatch(/^[a-z0-9]+$/);
    expect(names.storage).toMatch(/^[a-z0-9]+$/);
    expect(names.keyVault.length).toBeLessThanOrEqual(24);

    const artifacts = buildArtifacts(plan);
    const suffixes = ['dev', 'test', 'prod'].map((environment) => {
      const content = artifacts.find(
        (artifact) => artifact.pathParts.join('/') === `infrastructure/opentofu/azure/environments/${environment}.tfvars`
      )?.content ?? '';
      return content.match(/resource_suffix\s+= "([a-f0-9]{12})"/)?.[1];
    });
    expect(suffixes.every(Boolean)).toBe(true);
    expect(new Set(suffixes).size).toBe(3);
    const variables = artifacts.find(
      (artifact) => artifact.pathParts.join('/') === 'infrastructure/opentofu/azure/variables.tf'
    )?.content ?? '';
    expect(variables).toContain('^[a-z0-9]{12}$');
  });

  it('uses an available selected environment for local Docker Compose', () => {
    const artifacts = buildArtifacts(buildProjectPlan({
      projectName: 'Production Only',
      projectType: 'standard',
      apiStack: 'node',
      cloud: 'azure',
      environments: ['prod']
    }, { requireProjectName: true }));
    const compose = artifacts.find((artifact) => artifact.pathParts.join('/') === 'docker-compose.yml')?.content ?? '';

    expect(compose).toContain('./environments/prod/backend.env');
    expect(compose).not.toContain('./environments/dev/backend.env');
    expect(compose).toContain('MESSAGING_TRANSPORT: redis-streams');
    expect(compose).toContain('BLOB_ENDPOINT: http://azurite:10000/devstoreaccount1');
  });

  it('writes and validates a generated project manifest', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-test-'));
    const targetRoot = path.join(tempRoot, 'claims-rag');
    try {
      const plan = buildProjectPlan({ projectName: 'Claims RAG', pattern: 'rag', cloud: 'azure', includeFrontend: true }, { requireProjectName: true });
      await writeArtifacts(targetRoot, buildArtifacts(plan));

      expect(await validateGeneratedProject(targetRoot)).toEqual([]);
      expect(await readFile(path.join(targetRoot, 'backend', 'apis', 'main.py'), 'utf8')).toContain('/scalar');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('reports missing generated Function worker artifacts from the manifest', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-functions-missing-'));
    const targetRoot = path.join(tempRoot, 'claims-rag');
    try {
      const plan = buildProjectPlan({ projectName: 'Claims RAG', pattern: 'rag', cloud: 'azure' }, { requireProjectName: true });
      await writeArtifacts(targetRoot, buildArtifacts(plan));
      await rm(path.join(targetRoot, 'functions', 'rag-worker', 'function_app.py'));

      expect(await validateGeneratedProject(targetRoot)).toContain('Missing artifact function-worker-app at functions/rag-worker/function_app.py');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects non-empty target directories', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-nonempty-'));
    try {
      await writeFile(path.join(tempRoot, 'existing.txt'), 'content', 'utf8');
      await expect(assertNewOrEmptyDirectory(tempRoot)).rejects.toThrow(/must be new or empty/);
      expect(await readdir(tempRoot)).toEqual(['existing.txt']);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});