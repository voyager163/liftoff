# Workloads

Liftoff generates starter projects and governance definitions, not a blanket
production-readiness guarantee. Catalog scaffold labels and complete file
generation do not prove every GenAI behavior, worker deployment, authentication,
private-network path, or operational safeguard is implemented. Review the
[documented capability follow-ups](../DEVELOPER.md#broader-audit-follow-ups)
before deploying generated applications unchanged.

Liftoff asks for one workload first, then routes only the questions,
prerequisites, generated artifacts, and maintenance checks that apply to it.

## At a glance

| Workload | Primary choices | Required runtime | Liftoff-generated platform areas |
| --- | --- | --- | --- |
| GenAI application | Pattern, Azure region, environments, optional frontend | Python 3.14.x, `uv` 0.12.x, and Node.js 24.20+ within 24 LTS | API, orchestration, data, messaging, Docker, Azure OpenTofu |
| API application | Python 3.14, Node.js 24, or Go 1.27 API stack; Azure region; environments; optional frontend | Selected supported API release line and Node.js 24.20+ within 24 LTS | API, data, Docker, Azure OpenTofu |

Both workloads continue into the common OpenSpec or Spec Kit and coding
agent flow and the default local repository-governance handoff.
Required package managers are separate prerequisites: npm 12.x at 12.0.2 or
newer is required for Node.js dependencies, the optional frontend, or OpenSpec.

## GenAI application

### Questions

- Project name.
- GenAI pattern. **I'm not sure yet - Generic GenAI starter** is the default;
  specialized choices include prompt, chatbot, RAG, agent, multi-agent,
  fine-tuned, streaming, and workflow.
- Azure region and generated environments.
- Whether to generate a frontend.
- Spec workflow and coding agents.

The selected pattern fixes the API stack to Python, FastAPI, and PydanticAI.
Automation can select the neutral starting point explicitly with
`--type genai --pattern generic`.

### Generated output

- FastAPI backend and Scalar/OpenAPI integration.
- A committed `uv.lock` consumed through `uv sync --frozen`.
- PydanticAI orchestration, prompts, and model configuration boundaries.
- PostgreSQL and pattern-specific Redis or Azure Service Bus boundaries.
- Offline-testable tracing and integration adapters.
- Docker Compose and Azure OpenTofu.
- Optional Vue frontend and pattern-specific Azure Functions workers.
- Versioned repository-governance policy, workload context, guide, and
  selected-agent `/liftoff-setup` integration unless `none` is selected.

### Deferred actions

Liftoff does not insert model credentials, sign in to cloud services, or deploy
resources. Configure `.env`, authenticate separately, and review generated
infrastructure before applying it.

The generic pattern provides a neutral `/api/ai/run` boundary, PydanticAI
runner, prompt, tracing, offline test, and optional prompt playground. It does
not generate retrieval or pgvector, workers, chat persistence, specialized
tools, streaming adapters, fine-tuning datasets, or workflow structures.
Specializing it later is reviewed project migration work; `liftoff update` and
`--force` cannot convert project-owned application files.

### Pattern capability limits

All nine identifiers remain available and have `foundation` maturity.
That label describes starter boundaries, not a completed specialized application.

| Pattern ID | Existing boundary | Deliberately not implemented |
| --- | --- | --- |
| `generic` | Neutral model invocation | Retrieval, pgvector, workers, or other specialization |
| `rag` | Model-only answers, configured ingestion publication, pgvector/worker extension points | Retrieval, citations, embeddings, indexing, and grounded RAG answers |
| `chatbot` | Single-turn model invocation | Persisted conversation history and memory |
| `agent` | Model invocation and worker extension points | Tool execution and task automation |
| `prompt` | Invocation and prompt artifacts | Loading named prompt files into the model call |
| `multi-agent` | Single-model invocation and worker extension points | Multi-agent coordination |
| `fine-tuned` | Configured-model invocation and sample evaluation dataset | Fine-tuning and evaluation execution |
| `streaming` | One completed model response wrapped as buffered SSE | Incremental token streaming |
| `workflow` | Invocation and worker extension points | Workflow stages and durable pipeline execution |

Generic's default Python `pyproject.toml` and `uv.lock` have no `pgvector`
dependency. Only RAG requests the pgvector database extension/image; generic
has no application worker. The optional Langfuse observability-profile worker
is not application-worker specialization. Generated Function triggers log
message keys rather than implementing indexing or orchestration.

See [runtime configuration](configuration-and-manifests.md#application-runtime-configuration)
for Python/Node dotenv, Go JSON, explicit-file validation, and native/Compose
recipes. No API stack inherits GenAI-only model or tracing credentials.

## API application

### Questions

- Project name.
- API stack: Python/FastAPI, Node.js/Fastify with TypeScript, or Go/Huma v2
  with Chi.
- Azure region and generated environments.
- Whether to generate a frontend.
- Spec workflow and coding agents.

### Generated output

- Stack-native API, OpenAPI, tests, and database migrations.
- Ecosystem-native locked metadata: `uv.lock`, `package-lock.json`, or
  `go.mod` plus `go.sum`.
- PostgreSQL, Redis, Azurite, and Mailpit local services where applicable.
- Docker Compose and Azure OpenTofu.
- Optional Vue frontend.
- Versioned local repository-governance handoff unless explicitly disabled.

### Deferred actions

Service secrets, cloud authentication, external integrations, and deployment
remain explicit developer or delivery-pipeline actions.

## Retired Power Apps workload

Power Apps code apps and the Code Apps preview-plugin integration are no longer
supported. The retired `power-apps-code-app` type and plugin options are rejected
before preparation or generation.

Existing Power Apps manifests are also rejected, including by update, force,
doctor, and governance assessment. Liftoff does not convert the project, delete
application files, update its dependencies, or fall back to a different workload.
Existing Power Platform applications and machine-wide tooling remain under
their owners' control outside Liftoff.

## Change workload later

`liftoff update` maintains explicit Liftoff core files and can provision a
previously absent frontend or environment once after a corresponding desired
state edit. New environments additionally require recorded independent-root
infrastructure; legacy or unknown shared-state layouts need reviewed migration.
It does not convert workloads, change API stacks or GenAI patterns,
or modernize production project templates. Retired workloads have no update or
automatic migration path.

Start with `liftoff update --check`, which changes no project bytes and discloses
an external preview receipt. Plain update requires that matching preview and
explicit approval. `--force` applies only to its separately reviewed core
conflicts; project-owned source, dependencies, schemas, containers, environments,
documentation, and infrastructure remain outside replacement authority.
