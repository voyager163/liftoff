## Context

Liftoff currently resolves every create or migrate flow into a `ProjectPlan` with a required GenAI pattern and a single approved Python backend stack. Artifact rendering is centralized in one template module, and assumptions about PydanticAI, model configuration, pgvector, Langfuse, and pattern workers appear in base backend, Docker, infrastructure, frontend, governance, manifest, update, migration, and doctor behavior.

The change introduces a standard non-GenAI project path without weakening the existing GenAI defaults. Standard projects need one approved API stack per language:

- Python: FastAPI, SQLAlchemy, Alembic, and pytest.
- Node.js: Fastify with TypeScript, Drizzle for PostgreSQL, and Vitest.
- Go: Huma v2 with Chi, pgx, Goose migrations, and `go test`.

Generated projects must remain deterministic, cross-platform, and reconcilable through stable artifact logical names. Existing manifests and configuration files do not record project type or API stack and therefore need an explicit compatibility rule.

## Goals / Non-Goals

**Goals:**

- Ask whether a project is GenAI and branch subsequent decisions accordingly.
- Keep the existing GenAI experience compatible, including inference from `--pattern`.
- Generate complete standard API projects for Python, Node.js, and Go.
- Preserve stable top-level folders while allowing idiomatic backend internals.
- Give every API stack the same health, readiness, OpenAPI, Scalar, configuration, database, local-development, and deployment contract.
- Exclude AI-only code, dependencies, services, infrastructure adapters, and governance language from standard projects.
- Make create, plan, migrate, update, validate, doctor, manifests, and documentation understand the selected stack.

**Non-Goals:**

- Supporting Node.js or Go for GenAI orchestration in this change.
- Letting developers choose arbitrary frameworks, ORMs, routers, package managers, or migration tools.
- Adding standard-project background-worker selection or Azure Functions generation.
- Changing the optional Vue/Tailwind frontend choice, supported clouds, environments, or spec-workflow choices.
- Converting existing generated projects between project types or API stacks through `liftoff update`.

## Decisions

### Model project type and API stack separately

Add a project type catalog with `genai` and `standard`, plus an API stack catalog with stable identifiers:

| API stack id | Language | Framework | Database tooling | Tests |
| --- | --- | --- | --- | --- |
| `python-fastapi` | Python | FastAPI | SQLAlchemy + Alembic | pytest |
| `node-fastify` | Node.js/TypeScript | Fastify | Drizzle + PostgreSQL driver | Vitest |
| `go-huma` | Go | Huma v2 + Chi | pgx + Goose | `go test` |

`ProjectOptions` accepts optional project type and API stack inputs. A resolved `ProjectPlan` always has both values. GenAI plans require a pattern and force `python-fastapi`; standard plans require an API stack and have no pattern.

This is preferable to adding a fake `standard` GenAI pattern because pattern catalogs, worker behavior, documentation, and existing contracts all describe actual GenAI patterns. It is also preferable to a language-only field because the approved framework is part of the persistent scaffold contract.

### Preserve existing CLI compatibility through explicit inference

Interactive create and migrate flows ask `Is this a GenAI project?` before any pattern prompt. GenAI remains the default to preserve the current interactive experience. A standard answer skips the pattern prompt and asks for the API stack.

Non-interactive behavior follows these rules:

- `--pattern <id>` implies `genai` when project type is omitted.
- `--no-genai` selects `standard`; `--api <alias>` resolves an API stack.
- Existing GenAI commands with `--pattern` require no new flag.
- Conflicting inputs, such as `--no-genai --pattern rag`, fail before generation with a corrective message.
- `--yes` still requires enough explicit or inferred input to build a complete plan.

The parser exposes human-friendly aliases (`python`, `fastapi`, `node`, `nodejs`, `fastify`, `go`, `golang`, `huma`) through explicit catalog lookup rather than fuzzy matching.

### Persist additive project identity in manifest v2

New configuration and manifest output records:

```json
{
  "projectType": "standard",
  "apiStack": "node-fastify"
}
```

The manifest project object omits `pattern` for standard projects and retains it for GenAI projects. Readers normalize legacy v2 manifests and configurations that lack both new fields as `genai` plus `python-fastapi`. This additive normalization keeps existing projects readable without inventing a manifest v3 solely for inferred fields.

The running CLI's semver guard remains the protection against older CLIs updating projects written by a newer release. Manifest validation checks valid project-type/API-stack combinations after normalization.

### Split rendering into common, stack, and GenAI adapters

The existing single template module should become an orchestration layer over explicit builders:

```text
ProjectPlan
   |
   +-- common artifacts
   |   +-- root files
   |   +-- environments
   |   +-- Docker Compose
   |   +-- OpenTofu
   |   +-- governance
   |   `-- optional frontend
   |
   +-- API stack adapter
   |   +-- python-fastapi
   |   +-- node-fastify
   |   `-- go-huma
   |
   `-- GenAI extension (genai only)
       +-- orchestration
       +-- agents and prompts
       +-- retrieval/evaluation
       `-- pattern workers and Functions
```

Each adapter is selected through an explicit map keyed by API stack id. Artifact definitions retain explicit logical names and path-part arrays; generated files are never discovered or reconciled with globs. Existing GenAI logical names remain unchanged.

### Keep stable top-level boundaries and idiomatic backend internals

Every project keeps these logical top-level boundaries:

```text
backend/
database/
environments/
infrastructure/
openspec/ or .specify/
frontend/        optional
functions/       GenAI worker patterns only
migration/legacy only for migrate
```

Backend internals vary by stack:

- Python keeps `backend/apis`, `backend/config`, `backend/observability`, and `backend/tests`.
- Node.js uses `backend/src`, route/plugin/config modules, and `backend/test`.
- Go uses `backend/cmd/api`, `backend/internal/api`, `backend/internal/config`, and package-local tests.

Database migrations remain under the top-level `database` boundary but use the selected stack's tooling and file conventions. All path construction uses Node.js `path` utilities and path-part arrays so the logical layout is identical on Windows, macOS, and Linux.

### Standardize the API and runtime contract

All standard API stacks expose:

- Port `8000`.
- `GET /health` and `GET /ready`.
- An OpenAPI document and Scalar API reference.
- Environment-based application, cloud, database, Redis, messaging, and blob configuration.
- PostgreSQL integration and an initial migration.
- A stack-native health test.
- A stack-specific, production-oriented multi-stage Dockerfile.

Docker Compose retains PostgreSQL, Redis, Azurite, Mailpit, the backend, and the optional frontend. Standard projects use PostgreSQL without pgvector and omit the Langfuse profile. Azure OpenTofu remains runtime-neutral for Container Apps, PostgreSQL, Redis, storage, Service Bus, Communication Services, Container Registry, managed identity, and Key Vault. Standard projects omit pattern-driven Azure Functions resources.

Scalar remains the common developer portal: FastAPI exposes its generated OpenAPI, Fastify uses its schema/OpenAPI plugins, and Huma generates OpenAPI from typed operations.

### Keep GenAI output isolated

GenAI projects continue to generate PydanticAI orchestration, model configuration, agents, prompts, pattern routes, pgvector for RAG, Langfuse hooks, backend workers, and pattern-driven Azure Functions. Standard projects do not generate those artifacts and do not carry `GENAI_PATTERN` or model deployment configuration.

Common documentation, frontend copy, OpenSpec context, Spec Kit constitution, and seed changes render project-type-aware language. Standard content describes the selected API stack and never presents AI requirements as project standards.

### Make lifecycle commands stack-aware

`liftoff migrate` extends its explicit scan catalog for `go.mod`, Go source, Fastify dependencies, and existing framework indicators. Strong evidence may prefill standard project type and API stack; retrieval or PydanticAI evidence may prefill GenAI and its pattern. Weak or conflicting evidence leaves the relevant prompt unresolved and reports provenance.

`liftoff update` refuses configuration changes to project type, API stack, or GenAI pattern and directs the developer to migrate. Normal changes such as frontend and environments continue through reconciliation.

`liftoff doctor` keeps Node.js as a CLI prerequisite and adds project-specific runtime checks from the normalized manifest: Python for `python-fastapi`, Node.js for `node-fastify`, and Go for `go-huma`. It runs only checks relevant to generated artifacts and reports unavailable optional validation tools honestly.

### Extend contract coverage by project matrix

The deterministic render and logical-name contract matrix adds standard Python, Node.js, and Go plans with frontend variants where needed. Tests assert both positive and negative output: common artifacts exist, stack-native files compile or parse, and AI-only paths/content are absent from standard plans.

Cross-platform tests construct expected paths with `path.join`, exercise Windows-style path behavior where applicable, and verify manifest paths remain OS-neutral path-part arrays.

## Risks / Trade-offs

- [Three backend ecosystems increase maintenance and dependency churn] -> Keep one approved stack per language, isolate adapters, and pin generated dependency ranges deliberately.
- [A shared top-level structure can conflict with language conventions] -> Standardize only top-level boundaries and allow idiomatic internals within `backend`.
- [Adding project identity to manifest v2 can expose assumptions in older code] -> Normalize legacy manifests centrally and require all consumers to use the normalized type.
- [Standard and GenAI templates may drift apart] -> Share common artifact builders and test the complete plan matrix while keeping GenAI additions in one extension.
- [Migration scans may misclassify mixed-language repositories] -> Use explicit strong-evidence lookups, display provenance, and prompt when evidence conflicts.
- [Generated dependency smoke tests can be slow or require network access] -> Keep unit tests deterministic and use existing package smoke/release coverage for isolated generated-project checks.
- [Windows path differences can break stack-specific output] -> Store paths as parts, construct them with `path.join`/`path.resolve`, and add Windows CI coverage.

## Migration Plan

1. Add project-type and API-stack catalogs, normalization, validation, and CLI inputs while preserving current GenAI inference.
2. Extract the existing Python/GenAI rendering behind the adapter boundary without changing its logical names or output contract.
3. Add the standard Python adapter and conditional common templates, then add Node.js and Go adapters.
4. Extend manifests, update, doctor, migration scanning, generated governance, and documentation.
5. Expand contract fixtures and cross-platform test matrices before publishing the next Liftoff release.

Rollback removes the new standard catalog entries and adapters before release. Existing GenAI projects remain on their prior manifest and artifact contract. Standard projects created by a released version remain readable by that version and are protected from incompatible older updates by the `liftoffVersion` guard.

## Open Questions

- Exact dependency version ranges should be selected during implementation from versions compatible with the repository's supported Node.js, Python, and Go runtime baselines.
- Generic distributed tracing for standard projects is deferred; the initial standard scaffold provides structured logging boundaries and excludes AI-specific Langfuse integration.
