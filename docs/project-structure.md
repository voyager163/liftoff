# Generated project structure

Generated paths are logical examples. Liftoff uses platform-correct filesystem
handling on Windows, macOS, and Linux, and manifests store path-part arrays
instead of joined strings.

After initialization, workload paths shown below are project-owned production
assets. Their manifest entries preserve generation provenance but
`liftoff update`, including `--force`, cannot compare, restore, move, or replace
them. Only exact files labeled as managed core retain Liftoff write authority.

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
|   `-- governance/             # managed-core local handoff when enabled
|       |-- policy.md
|       |-- context.json
|       |-- README.md
|       |-- phase-graph.json
|       |-- compatibility.json
|       `-- credential-policy.schema.json
|-- governance/                 # user-owned activation state after setup starts
|   |-- activation-state.json
|   |-- approvals/
|   |-- evidence/
|   `-- credentials/
|-- backend/
|   `-- uv.lock                 # Python stacks only
|-- database/
|   |-- alembic.ini or stack-native migration config
|   |-- migrations/
|   `-- models/ or schema/
|-- environments/
|   |-- dev/
|   |-- staging/
|   `-- prod/
|-- infrastructure/
|   `-- opentofu/
|       `-- azure/
|           `-- .terraform.lock.hcl
|-- openspec/ or .specify/
|-- .github/skills/openspec-*/ and .github/prompts/opsx-*  # OpenSpec + Copilot
|-- .claude/skills/openspec-*/ and .claude/commands/opsx/  # OpenSpec + Claude
|-- .github/workflows/copilot-setup-steps.yml              # optional hosted agent
|-- .github/agents/openspec.agent.md                       # optional hosted agent
|-- .github/prompts/liftoff-setup.prompt.md
|   or .claude/commands/liftoff-setup.md
|-- .github/prompts/liftoff-governance-assess.prompt.md
|   or .claude/commands/liftoff-governance-assess.md
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
  The generic pattern creates `generic_agent.py`, `generic.md`, and the neutral
  `/api/ai/run` route without specialized subdirectories.
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
- OpenSpec projects receive all 12 pinned workflows as both skills and commands
  for supported selected-agent surfaces. The two hosted Copilot agent files are
  generated only after explicit opt-in.
- `/liftoff-setup` is generated when repository governance is enabled. It calls
  `liftoff governance status|plan|apply-next|resume|verify` and has no model
  selection or separate setup-skill version.
- `/liftoff-governance-assess` is a separate selected-agent, read-only wrapper
  around `liftoff governance assess --json`. It is local-only unless live reads
  are explicitly requested; it never runs automatically or replaces setup.

### Conditional areas

- `frontend` is generated only when selected. It uses Vue 3 and Tailwind with
  a generic API starter or a GenAI experience matched to the pattern.
- `functions/<worker-name>` appears for worker-enabled RAG, agent, multi-agent,
  and workflow patterns. It does not appear for the generic pattern.
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
|-- .liftoff/governance/        # managed-core setup files when enabled
|-- governance/                 # user-owned activation state after setup starts
`-- openspec/ or .specify/
```

The exact selected-agent setup and assessment launchers are generated only when the
repository-governance profile is enabled. They are Liftoff-owned; neighboring
framework files remain framework-owned. Agent-created governance changes and
`governance/activation-state.json`, approvals, evidence, credentials, and
supersession records remain user-owned and are not listed as managed artifacts.

This root follows the pinned official Microsoft starter. It includes the
Power Apps SDK, Vite plugin, and project-local CLI through locked npm
dependencies.

Liftoff intentionally does not generate `backend/`, `database/`,
`docker-compose.yml`, `environments/`, `infrastructure/`, or
`power.config.json` for this workload.

## Managed versus user-owned governance artifacts

`liftoff.manifest.json` v7 records managed-core hashes for the governance policy,
context, guide, phase graph, compatibility metadata, credential-policy schema,
and setup and assessment integrations. `liftoff update` may reconcile only those managed-core
paths. Forced update may remove exact retired generated setup-alias ownership
from older manifests after review. It preserves user-owned activation state,
immutable evidence, approvals, credential policies, active OpenSpec changes, and
project source.

Manifest paths are stored as path-part arrays and validated on Windows, macOS,
and Linux. Generated setup content is identified by managed content hashes; the
activation version vector and graph hash describe the behavior contract.

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
