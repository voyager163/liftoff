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
|-- runtime.config.example.json # Go native configuration only
|-- Dockerfile
|-- .dockerignore
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
|           |-- modules/application/
|           `-- environments/<env>/ # independent root, <env>.tfvars and provider lock
|-- openspec/ or .specify/
|-- specs/000-liftoff-bootstrap/ # Spec Kit only: one-time spec.md, plan.md, tasks.md
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
  `backend/cmd/api` plus `backend/internal`. Node includes an explicit
  `backend/vitest.config.ts`; Go's `backend/cmd/migrate/main.go` passes resolved
  configuration to the existing pinned Goose migration tool.
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
- `infrastructure/opentofu/azure/modules/application` contains the shared module.
  Each selected `infrastructure/opentofu/azure/environments/<env>` root owns its
  named tfvars, provider lock, and independent local/remote state configuration.
  Existing shared-state projects are not relocated by update or force.
  The eight [retired flat-root identities](azure-deployment.md#explicit-flat-root-identity-retirement)
  remain historical provenance; new root-looking files do not establish eligibility.
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

### Runtime configuration and image boundaries

Python and Node.js native startup read the project-root `.env`; process
environment values take precedence over file-backed settings and nonsecret
defaults. Go native startup from `backend/` reads `../runtime.config.json`;
copy `runtime.config.example.json` to that path or select explicit JSON with
`LIFTOFF_ENV_FILE`. It does not shell-source `.env`. Configuration is resolved
once per process; restart after editing the selected file.
Explicit missing, unreadable, or malformed selected files fail before fallback.
See [configuration syntax and native commands](configuration-and-manifests.md#application-runtime-configuration)
for strict dotenv quoting and Go's string-valued JSON contract.

Compose passes applicable runtime settings explicitly while keeping PostgreSQL,
Redis, and other generated service addresses container-reachable. Root and
frontend `.dockerignore` files exclude host virtual environments, `node_modules`,
build outputs, VCS metadata, state, and local secrets. Installing dependencies
locally must not copy a host environment over dependencies installed in an image.

## Retired project layouts

Power Apps code app generation and maintenance are retired. An existing
Power Apps manifest is rejected without converting its root layout or modifying
application, framework, dependency, or governance files. The remaining generated
layouts are the API and GenAI layouts above.

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
  `SERVICE_BUS_AUTH_MODE=connection-string` with `SERVICE_BUS_CONNECTION_STRING`,
  or `managed-identity` with `SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE` and
  `AZURE_CLIENT_ID` for the selected user-assigned identity.
- Langfuse requires both `LANGFUSE_PUBLIC_KEY` and
  `LANGFUSE_SECRET_KEY`, with optional `LANGFUSE_HOST`. Both blank disables
  tracing; only one configured key is an error.
- Frontends read `VITE_API_BASE_URL`, call the route selected by the pattern or
  API stack, and expose loading, response, and failure states.
- Backends allow the local frontend origin by default.
  `CORS_ALLOWED_ORIGINS` configures additional origins.

Generated backend, messaging, tracing, orchestration, and frontend tests do not
require a live model, Redis, Service Bus, or Langfuse service.
