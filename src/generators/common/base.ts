import type { GeneratorContext as ResolvedGeneratorContext } from '../context.js';
type GeneratorContext = Pick<ResolvedGeneratorContext, 'stack'>;
import type { AddArtifact } from '../../template-types.js';
import type { ApiProjectPlan } from '../../domain/project/contracts.js';
import { DEFAULT_FUNCTION_WORKER_QUEUE_NAME } from './values.js';
import { formatCommand } from '../../process-runner.js';
import { functionWorkerName } from './values.js';
import { genAiPattern } from './values.js';
import { hasFunctionWorker } from './values.js';
import { OPEN_SPEC_DELIVERY } from '../../openspec-profile.js';
import { OPEN_SPEC_PROFILE } from '../../openspec-profile.js';
import { OPEN_SPEC_WORKFLOW_IDS } from '../../openspec-profile.js';
import type { ProjectPlan } from '../../domain/project/contracts.js';
import { renderBackendDockerfile } from '../containers/images.js';
import { renderGovernanceAssessmentGuide } from '../../repository-governance.js';
import { renderStandardDockerfile } from '../containers/images.js';
import { renderStandardEnv } from '../standard/configuration.js';
import { renderDockerignore } from '../containers/context.js';
import { selectedEnvironmentId } from './values.js';
import { workstationRequirementCatalog } from '../../workstation-catalog.js';
import type { WorkstationRequirementId } from '../../workstation-catalog.js';

export function addBaseArtifacts(
  add: AddArtifact,
  addDesiredState: AddArtifact,
  plan: ApiProjectPlan, context: GeneratorContext
): void {
  add('root-readme', 'documentation', ['README.md'], renderRootReadme(plan));
  add('root-gitignore', 'project', ['.gitignore'], renderGeneratedGitignore());
  add('root-dockerignore', 'runtime', ['.dockerignore'], renderDockerignore());
  addDesiredState('liftoff-config', 'project', ['liftoff.config.json'], JSON.stringify({
    projectName: plan.projectName,
    projectType: plan.projectType.id,
    apiStack: plan.apiStack.id,
    ...(plan.workload === 'genai' ? { pattern: plan.pattern.id } : {}),
    cloud: plan.provider.id,
    region: plan.region.slug,
    includeFrontend: plan.includeFrontend,
    environments: plan.environments.map((environment) => environment.id),
    specWorkflow: plan.specWorkflow.id,
    agents: plan.agents.map((agent) => agent.id),
    ...(plan.defaultAgent ? { defaultAgent: plan.defaultAgent.id } : {}),
    governanceProfile: plan.governanceProfile.id
  }, null, 2));
  add('env-example', 'configuration', ['.env.example'], renderEnvExample(plan)
    .replaceAll('@postgres:', '@localhost:')
    .replaceAll('redis://redis:', 'redis://localhost:')
    .replaceAll('http://azurite:', 'http://localhost:')
    .replaceAll('http://langfuse:', 'http://localhost:'));
  add(
    'backend-dockerfile',
    'runtime',
    ['Dockerfile'],
    plan.workload === 'genai' ? renderBackendDockerfile(context) : renderStandardDockerfile(plan, context)
  );
}

export function renderDirectBuildAndTestGuide(plan: ApiProjectPlan): string {
  let backendCommands: string;
  if (plan.workload === 'genai' || plan.apiStack.id === 'python-fastapi') {
    const extras = plan.workload === 'genai' && hasFunctionWorker(plan)
      ? ' --extra functions'
      : '';
    backendCommands = `uv sync --frozen --project backend --extra test${extras}
uv run --project backend python -m pytest -q backend/tests`;
  } else if (plan.apiStack.id === 'node-fastify') {
    backendCommands = `cd backend
npm ci
npm run build
npm test`;
  } else {
    backendCommands = `cd backend
go mod download
go test ./...`;
  }
  const frontendCommands = plan.includeFrontend ? `

Build the frontend without a running backend:

\`\`\`bash
cp frontend/.env.example frontend/.env
cd frontend
npm ci
npm run build
\`\`\`
` : '';
  const functionCommands = plan.workload === 'genai' && hasFunctionWorker(plan) ? `

Run the Function worker unit tests from the same locked Python environment:

\`\`\`bash
(cd functions/${functionWorkerName(plan)} && uv run --project ../../backend --directory . python -m pytest -q)
\`\`\`
` : '';
  return `## Project Dependencies, Build, And Test

\`liftoff init --install-dependencies\` runs the selected stack's locked project-local dependency commands. To run or resume them manually:

\`\`\`bash
${backendCommands}
\`\`\`

${frontendCommands}${functionCommands}`;
}

export function renderDeterministicSetupGuide(plan: ApiProjectPlan): string {
  const backend = plan.workload === 'genai' || plan.apiStack.id === 'python-fastapi'
    ? '`uv run --project backend python -m pytest -q backend/tests`'
    : plan.apiStack.id === 'node-fastify'
      ? '`npm test` from `backend/` after `npm ci` and `npm run build`'
      : '`go test ./...` from `backend/`';
  const frontend = plan.includeFrontend
    ? '- Frontend build: `npm run build` from `frontend/` after `npm ci`.'
    : '- Frontend build: inapplicable because no frontend was generated.';
  const governance = plan.governanceProfile.id === 'none'
    ? 'Repository governance is disabled, so there is no `/liftoff-setup` integration, managed phase graph, or post-init governance activation path.'
    : plan.specWorkflow.id === 'openspec'
      ? 'Run `/liftoff-setup` from a selected agent. It verifies, syncs, and archives the generated OpenSpec bootstrap seed, then stops at explicit authority gates. Commit and push require separate approvals.'
      : 'Run `/liftoff-setup` from a selected agent. It verifies the real `specs/000-liftoff-bootstrap` bundle and official Spec Kit markers, runs applicable checks, and only then finalizes the local bootstrap projection and receipt. It creates no branch or external archive.';
  return `## Deterministic Setup

${governance}

The local baseline contains only applicable checks:

- \`liftoff validate\`
- Backend tests: ${backend}
${frontend}
- \`docker compose config -q\`
- \`tofu fmt -check -recursive\`
${plan.environments.map(({ id }) => `- From \`infrastructure/opentofu/azure/environments/${id}\`: \`tofu init -backend=false\`, then \`tofu validate\`.`).join('\n')}
- ${plan.specWorkflow.id === 'openspec' ? 'strict OpenSpec validation' : 'validation of the real Spec Kit bootstrap spec, plan, tasks, and separate official initialization markers'}

No baseline step runs a live OpenTofu plan or apply, starts containers, deploys,
mutates GitHub, or asks for cloud credentials. Absent components are recorded as
inapplicable rather than simulated. After setup finalizes the seed, use normal
OpenSpec or Spec Kit changes for features and the governed GitFlow release path
after activation evidence is green.
`;
}

export function renderAdvisoryReadinessGuide(plan: ApiProjectPlan): string {
  const selected: WorkstationRequirementId[] = [
    'docker',
    'opentofu',
    ...(plan.provider.id === 'azure' ? ['azure-cli' as const] : [])
  ];
  return selected.map((id) => {
    const requirement = workstationRequirementCatalog[id];
    const mac = requirement.install.darwin;
    const windows = requirement.install.win32;
    const commands = [
      ...(mac ? [`macOS: \`${formatCommand(mac.command)}\``] : []),
      ...(windows ? [`Windows: \`${formatCommand(windows.command)}\``] : []),
      `Linux: ${requirement.linuxRemedies.unknown}`
    ].join('; ');
    const health = id === 'docker'
      ? ' After installation, start Docker Desktop or the Docker daemon.'
      : id === 'azure-cli'
        ? ' After installation, run `az login` if authentication is not ready.'
        : '';
    return `- ${requirement.label}: ${commands}.${health}`;
  }).join('\n');
}

export function renderSpecWorkflowGuide(plan: ApiProjectPlan): string {
  const agents = plan.agents.map((agent) =>
    `${agent.label}${plan.defaultAgent?.id === agent.id ? ' (default integration)' : ''}`
  ).join(', ');
  const ownership = plan.specWorkflow.id === 'openspec'
    ? 'OpenSpec workflow skills, commands, configuration, and optional cloud-agent files'
    : 'Spec Kit core files, integration state, and the selected Copilot or Claude skill integrations';
  const openSpecDetails = plan.specWorkflow.id === 'openspec'
    ? [
        `- OpenSpec profile: ${OPEN_SPEC_PROFILE}; delivery: ${OPEN_SPEC_DELIVERY}; workflows: ${OPEN_SPEC_WORKFLOW_IDS.join(', ')}`,
        ...(plan.agents.some((agent) => agent.id === 'github-copilot')
          ? ['- GitHub Copilot cloud agent: controlled by `githubCopilot.cloudAgent` in `openspec/config.yaml`']
          : [])
      ].join('\n')
    : '';
  return `## Spec-Driven Workflow And Validation

- Workflow: ${plan.specWorkflow.label} ${plan.framework.version}
- AI coding agents: ${agents}
${openSpecDetails ? `${openSpecDetails}\n` : ''}
- Framework ownership: the official initializer owns ${ownership}. Liftoff validates these files but excludes framework-owned output and one-time seed content from managed-core hashes.
- Deferred tools: advisory workstation checks may be deferred. Liftoff never claims they are installed and never installs them without \`--install-tools\`.

If \`liftoff doctor\` reports a selected advisory tool as missing, use its registered readiness remedy:

${renderAdvisoryReadinessGuide(plan)}

Validate the scaffold and workstation after setup:

\`\`\`bash
liftoff validate
liftoff doctor
\`\`\`

For an existing OpenSpec project, change workflow delivery with \`openspec config profile\` and refresh framework-owned files with \`openspec update\`. Plain \`liftoff update\` does not regenerate OpenSpec integrations.
`;
}

export function renderGeneratedConfigurationGuide(plan: ApiProjectPlan): string {
  const frontendConfiguration = plan.includeFrontend
    ? '\n- `frontend/.env` configures `VITE_API_BASE_URL`; the production build does not contact the backend.'
    : '';
  const nativeCommand = plan.workload === 'genai' || plan.apiStack.id === 'python-fastapi'
    ? 'uv run --project backend uvicorn backend.apis.main:app --host 127.0.0.1 --port 8000'
    : plan.apiStack.id === 'node-fastify'
      ? '(cd backend && npm run build && npm start)'
      : '(cd backend && go run ./cmd/api)';
  const go = plan.workload === 'standard' && plan.apiStack.id === 'go-huma';
  const python = plan.workload === 'genai' || plan.apiStack.id === 'python-fastapi';
  const contract = `Copy \`.env.example\` to root \`.env\` for Compose.${go ? ' For native Go, also copy `runtime.config.example.json` to root `runtime.config.json`.' : ''} Resolution is process environment > selected local configuration file > nonsecret defaults.
${go
  ? 'The documented backend-CWD startup uses the Go standard library to read `../runtime.config.json`, a JSON object of string settings (not dotenv).'
  : 'The backend resolves the default dotenv file from source location, so backend-CWD startup also reads root `.env`.'}
To select another file, set \`LIFTOFF_ENV_FILE\` to its path relative to the startup working directory; this backend expects ${go ? 'JSON' : 'dotenv'}.
An explicitly selected missing/unreadable file fails; configuration is never shell-sourced.
${go
  ? 'Malformed JSON or non-string values fail before environment overrides are applied.'
  : 'Malformed dotenv assignments or unbalanced quotes fail rather than being silently ignored. Use `KEY=value`, optional `export`, comments, and single/double-quoted values.'}
${plan.workload === 'standard' && plan.apiStack.id === 'node-fastify' ? 'Node uses the runtime dotenv parser; escaped quote delimiters are rejected to avoid truncation. Use the other quote style when a value contains a quote.\n' : ''}
Local native URLs use localhost. Start supporting services and then the native backend:

\`\`\`bash
cp .env.example .env
${go ? 'cp runtime.config.example.json runtime.config.json\n' : ''}docker compose up -d postgres redis azurite mailpit
${nativeCommand}
\`\`\`

${python ? 'For a Python backend-CWD launch, use `uv run uvicorn --app-dir .. backend.apis.main:app --port 8000` from `backend/`.\n' : ''}
Compose reads root \`.env\` for interpolation; select another file with \`docker compose --env-file environments/${selectedEnvironmentId(plan)}/backend.env up --build\`.
Compose deliberately replaces database, Redis, and blob service addresses with container-reachable names while forwarding applicable model, transport, and tracing inputs.
\`/health\` and \`/ready\` are local process/configuration endpoints, not proof of external-service connectivity or production readiness.
`;
  if (plan.workload === 'standard') {
    return `## Runtime Configuration

${contract}
The backend requires \`DATABASE_URL\` and \`REDIS_URL\`. \`CORS_ALLOWED_ORIGINS\` is a comma-separated allowlist and defaults to the local frontend at \`http://localhost:5173\`. No GenAI model or tracing credentials are required.${frontendConfiguration}
`;
  }
  return `## Starter Integration Configuration

${contract}
Configure only the integrations you use:

- \`PYDANTIC_AI_MODEL\` is required when production orchestration is invoked. If it is absent, the agent raises an explicit configuration error rather than returning a placeholder answer.
- The locked model provider supports \`openai:\`, \`openai-chat:\`, and \`openai-responses:\` identifiers. Set \`OPENAI_API_KEY\`; \`OPENAI_BASE_URL\` optionally selects an OpenAI-compatible endpoint. Other providers require a reviewed dependency/configuration change.
- Redis Streams uses \`REDIS_URL\` and \`REDIS_STREAM_NAME\`.
- Azure Service Bus uses \`SERVICE_BUS_QUEUE_NAME\` and explicit \`SERVICE_BUS_AUTH_MODE\`: \`managed-identity\` requires \`SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE\` plus \`AZURE_CLIENT_ID\`; \`connection-string\` requires \`SERVICE_BUS_CONNECTION_STRING\`. Missing publisher configuration fails before ingestion can report success.
- Langfuse requires both \`LANGFUSE_PUBLIC_KEY\` and \`LANGFUSE_SECRET_KEY\`, with optional \`LANGFUSE_HOST\`. Without both keys, tracing is explicitly disabled and no remote trace ID is reported.${frontendConfiguration}
- \`CORS_ALLOWED_ORIGINS\` is a comma-separated frontend-origin allowlist and defaults to \`http://localhost:5173\`.
`;
}

export function renderGeneratedUpdateGuide(plan: ProjectPlan): string {
  const governance = plan.governanceProfile.id === 'none'
    ? 'Repository governance is disabled for this project, so Liftoff does not generate setup integrations, a managed phase graph, credential-policy schema, or post-init setup command.'
    : '`single-maintainer-gitflow` repository governance generates deterministic setup artifacts only. Review `.liftoff/governance/README.md`, then run `/liftoff-setup` from a selected agent. Live enforcement requires evidence and explicit approval; it is never inferred from generated files.';
  return `## Safe Liftoff Updates

\`liftoff upgrade\` replaces a supported global Liftoff CLI installation; it does not inspect or modify this project. Check and apply CLI replacement separately with \`liftoff upgrade --check\` and \`liftoff upgrade\`.

${governance}

\`liftoff update\` maintains explicit Liftoff core files, currently the repository-governance policy, context, guide, phase graph, compatibility metadata, credential-policy schema, and selected-agent \`/liftoff-setup\` and \`/liftoff-governance-assess\` integrations. Start with \`liftoff update --check\` for the human compatibility and migration preview. Check changes no project bytes and discloses a preview receipt stored outside the repository; this receipt is not approval. Plain update requires the matching preview and explicit approval. Automation can use \`liftoff update --check --json\` and approve the exact effective fingerprint with \`liftoff update --approve-plan <fingerprint> --json\`.

Application source, tests, dependencies and locks, schemas, containers, environment files, documentation, and infrastructure become project-owned after generation. No update mode, including \`--force\`, can restore or replace them. Enabling a previously absent frontend or environment in \`liftoff.config.json\` may provision that component once at absent destinations; a collision blocks the whole component and cannot be forced.

Project template modernization is a separately reviewed production change and is not performed by ordinary update or by the existing non-Liftoff \`migrate\` command. Managed-core conflicts are skipped by default; after reviewing every listed core path, \`liftoff update --force\` may replace only those core conflicts. Managed-core orphans remain on disk, and update never installs dependencies. A failed transaction is rolled back, but Liftoff retains no backup after a successful core overwrite.

Activation migration is a separate explicitly approved write set. A supported v1 source retains original state, evidence, plans, approvals, and source metadata in \`governance/history\` before a linked v2 successor is created. History never becomes managed core or current execution proof. Revalidation uses only the finite reviewed local operations and stops before provider access, publication, or independent authority gates. Failure after migration commits leaves v2 blocked and resumable; repair the named cause, run check again, and approve the remaining work. History is not automatically committed, pushed, or removed with preview receipts. Force never bypasses preview, approval, compatibility, or ownership checks.

Update JSON uses schema 3. Exit 0 means clean state or completion of the approved scope, 2 means differences or committed migration with incomplete revalidation, and 1 means a rejected or failed operation. Local migration completion does not establish live governance.

Liftoff rejects malformed, traversal, absolute, drive-qualified, UNC, separator-containing, or symlink-escaping manifest paths before artifact access. If the manifest is unsafe or malformed, restore \`liftoff.manifest.json\` from version control or regenerate the project with a matching Liftoff version; do not hand-edit unsafe paths. Run \`liftoff <command> --help\` for command-specific syntax because unknown flags, subcommands, values, and extra arguments fail before any write.

${plan.governanceProfile.id === 'none'
  ? 'No `/liftoff-governance-assess` integration is generated while governance is disabled.'
  : renderGovernanceAssessmentGuide()}
`;
}

export function renderRootInfrastructureGuide(plan: ApiProjectPlan): string {
  const environment = selectedEnvironmentId(plan);
  const governanceGate = plan.governanceProfile.id === 'none'
    ? ''
    : `These commands are reference material, not the next setup action. Do not run this
sequence until the separately approved \`application-foundation\` governance phase
authorizes the exact infrastructure mutation. \`/liftoff-setup\` can evaluate and
resume managed phases, but it does not imply that every managed phase has an
executable production adapter. An unavailable production adapter remains a
blocker; do not bypass it by running the reference commands directly.

`;
  return `## Infrastructure

${governanceGate}\`\`\`bash
cd infrastructure/opentofu/azure/environments/${environment}
tofu init
tofu plan -var-file=${environment}.tfvars
tofu apply -var-file=${environment}.tfvars
\`\`\`

The first apply uses a public bootstrap image. Follow \`infrastructure/opentofu/azure/README.md\` to build the generated backend in ACR and apply its image.
`;
}

export function renderRootReadme(plan: ApiProjectPlan): string {
  if (plan.workload === 'standard') {
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
${renderDeterministicSetupGuide(plan)}
## Local Development

\`\`\`bash
docker compose up --build
\`\`\`

The backend API is available on port 8000. Health and readiness endpoints are available at \`/health\` and \`/ready\`; Scalar is exposed at \`/scalar\`.

${renderGeneratedConfigurationGuide(plan)}
${renderDirectBuildAndTestGuide(plan)}
${renderGeneratedUpdateGuide(plan)}
${renderRootInfrastructureGuide(plan)}
${renderSpecWorkflowGuide(plan)}
`;
  }

  const pattern = genAiPattern(plan);
  const functionsStackLine = hasFunctionWorker(plan) ? `- Azure Functions worker: Python v2 Service Bus trigger under \`functions/${functionWorkerName(plan)}\`
` : '';
  const functionsSection = hasFunctionWorker(plan) ? `
## Azure Functions Worker

Azure Functions trigger adapters live under \`functions/${functionWorkerName(plan)}\`. Keep reusable GenAI orchestration under \`backend/orchestration\`; \`backend/workers\` remains the place for backend-adjacent or containerized worker code.
` : '';
  const genericSection = pattern.id === 'generic' ? `
## Choosing A Specialization Later

This project intentionally starts with a neutral text-in/result-out GenAI boundary. It does not assume RAG, conversation history, agent tools, streaming, fine-tuning, multi-agent coordination, or workflow orchestration.

Generated application files are project-owned. When requirements become clear, specialize through a reviewed project change; \`liftoff update\` and \`--force\` do not convert this project to another GenAI pattern.
` : '';
  return `# ${plan.projectName}

Generated by Mission Control Liftoff.

## Stack

- Backend: FastAPI, PydanticAI, Pydantic settings, Scalar
- Pattern: ${pattern.label}
- Starter maturity: ${pattern.scaffoldStatus}
- Generated capability: ${pattern.description}
- Cloud: ${plan.provider.label} (${plan.region.slug})
- Infrastructure: OpenTofu
- Database: PostgreSQL with Alembic migrations${pattern.id === 'rag' ? ' and a pgvector storage foundation (retrieval is not implemented)' : ''}
- Cache and local messaging: Redis
- Observability: Langfuse
- Local development: Docker Compose
${functionsStackLine}
${plan.includeFrontend ? '- Frontend: Vue 3 with Tailwind\n' : ''}
## Starter Capability Limits

This release provides model invocation, injectable messaging publishers, and optional tracing.
Pattern names identify extension points, not implemented specialization. Retrieval/citations,
conversation history, tools, prompt-file loading, multi-agent coordination, fine-tuning,
workflow stages, and incremental streaming remain project work. The streaming pattern
emits one buffered SSE result after model completion; it is not real-time token streaming.

${renderDeterministicSetupGuide(plan)}
## Local Development

\`\`\`bash
docker compose up --build
docker compose --profile observability up --build
\`\`\`

The backend API is available on port 8000. Scalar is exposed at \`/scalar\`.

${renderGeneratedConfigurationGuide(plan)}
${renderDirectBuildAndTestGuide(plan)}
${renderGeneratedUpdateGuide(plan)}
${renderRootInfrastructureGuide(plan)}
${renderSpecWorkflowGuide(plan)}
${functionsSection}
${genericSection}
`;
}

export function renderGeneratedGitignore(): string {
  return `.venv/
__pycache__/
.pytest_cache/
node_modules/
dist/
.env
runtime.config.json
migration/legacy/
*.tfstate
*.tfstate.*
.terraform/
`;
}

export function renderEnvExample(plan: ApiProjectPlan): string {
  if (plan.workload === 'standard') {
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
SERVICE_BUS_AUTH_MODE=managed-identity
SERVICE_BUS_CONNECTION_STRING=
SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE=
AZURE_CLIENT_ID=
BLOB_ENDPOINT=http://azurite:10000/devstoreaccount1
CORS_ALLOWED_ORIGINS=http://localhost:5173
PYDANTIC_AI_MODEL=
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
LANGFUSE_HOST=http://langfuse:3000
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
`;
}
