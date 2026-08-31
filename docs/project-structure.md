# Generated project structure

Generated paths are logical examples. Liftoff uses platform-correct filesystem
handling on Windows, macOS, and Linux, and manifests store path-part arrays
instead of joined strings.

## GenAI and API projects

```text
project/
|-- README.md
|-- liftoff.config.json
|-- liftoff.manifest.json
|-- .env.example
|-- Dockerfile
|-- docker-compose.yml
|-- .liftoff/
|   `-- governance/             # durable local handoff when enabled
|       |-- policy.md
|       |-- context.json
|       `-- README.md
|-- backend/
|   `-- uv.lock                 # Python stacks only
|-- database/
|   |-- alembic.ini or stack-native migration config
|   |-- migrations/
|   `-- models/ or schema/
|-- environments/
|   |-- dev/
|   |-- test/
|   `-- prod/
|-- infrastructure/
|   `-- opentofu/
|       `-- azure/
|           `-- .terraform.lock.hcl
|-- openspec/ or .specify/
|-- .github/prompts/liftoff-repository-governance.prompt.md
|   or .claude/commands/liftoff-repository-governance.md
|-- frontend/                  # only when selected
|-- functions/<worker-name>/  # only for worker-enabled GenAI patterns
`-- migration/legacy/         # only after liftoff migrate
```

### Core areas

- `backend` contains the selected API stack and Scalar/OpenAPI wiring. Python
  uses `backend/apis`, Node.js uses `backend/src`, and Go uses
  `backend/cmd/api` plus `backend/internal`.
- `backend/orchestration` appears only in GenAI projects and contains
  PydanticAI agents, prompts, model configuration, and integration boundaries.
- `database` contains SQLAlchemy/Alembic for Python, Drizzle for Node.js, or
  pgx/Goose for Go.
- `environments/<env>` contains environment-specific backend settings and
  Functions settings when a worker is generated.
- `docker-compose.yml` starts the selected backend, PostgreSQL, Redis,
  Azurite, and Mailpit. GenAI projects use pgvector where needed and include an
  optional Langfuse v4 web/worker profile backed by ClickHouse, dedicated Redis,
  and MinIO.
- Python Docker builds export the committed `uv.lock` in frozen mode and install
  only hash-verified requirements. `UV_DEFAULT_INDEX` can select a
  credential-free managed mirror without changing the lock.
- `infrastructure/opentofu/azure` contains modules, environment tfvars, local
  state configuration, and a remote-state example.
- `openspec` is created for OpenSpec. `.specify` and `specs` are created for
  Spec Kit.

### Conditional areas

- `frontend` is generated only when selected. It uses Vue 3 and Tailwind with
  a generic API starter or a GenAI experience matched to the pattern.
- `functions/<worker-name>` appears for worker-enabled RAG, agent, multi-agent,
  and workflow patterns.
- `backend/workers` contains backend-adjacent or containerized worker code,
  separate from Azure Functions runtime files.
- `migration/legacy` contains the filtered source copy created by migration.

## Power Apps code app

```text
project/
|-- README.md
|-- THIRD_PARTY_NOTICES.md
|-- liftoff.config.json
|-- liftoff.manifest.json
|-- package.json
|-- package-lock.json
|-- index.html
|-- vite.config.ts
|-- eslint.config.js
|-- tsconfig.json
|-- public/
|-- src/
|   |-- App.tsx
|   |-- main.tsx
|   |-- router.tsx
|   |-- components/
|   |-- hooks/
|   |-- pages/
|   `-- providers/
`-- openspec/ or .specify/
```

The exact selected-agent governance launcher is generated only when the
repository-governance profile is enabled. It is Liftoff-owned; neighboring
framework files remain framework-owned. Agent-created governance changes and
`governance/activation-baseline.json` remain user-owned and are not listed in
the manifest.

This root follows the pinned official Microsoft starter. It includes the
Power Apps SDK, Vite plugin, and project-local CLI through locked npm
dependencies.

Liftoff intentionally does not generate `backend/`, `database/`,
`docker-compose.yml`, `environments/`, `infrastructure/`, or
`power.config.json` for this workload.

## GenAI integration configuration

Generated GenAI projects expose real configuration boundaries instead of
success-shaped placeholders:

- `PYDANTIC_AI_MODEL` selects the production model. An unconfigured production
  invocation fails clearly.
- Redis Streams uses `REDIS_URL` and `REDIS_STREAM_NAME`.
- Azure Service Bus uses `SERVICE_BUS_QUEUE_NAME` and either
  `SERVICE_BUS_CONNECTION_STRING` or
  `SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE`; `AZURE_CLIENT_ID` selects a
  user-assigned managed identity.
- Langfuse requires both `LANGFUSE_PUBLIC_KEY` and
  `LANGFUSE_SECRET_KEY`, with optional `LANGFUSE_HOST`. Without both keys,
  tracing is explicitly disabled.
- Frontends read `VITE_API_BASE_URL`, call the route selected by the pattern or
  API stack, and expose loading, response, and failure states.
- Backends allow the local frontend origin by default.
  `CORS_ALLOWED_ORIGINS` configures additional origins.

Generated backend, messaging, tracing, orchestration, and frontend tests do not
require a live model, Redis, Service Bus, or Langfuse service.
