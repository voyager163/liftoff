## 1. Project Identity and CLI Decisions

- [x] 1.1 Add typed project-type and API-stack catalogs for `genai`, `standard`, `python-fastapi`, `node-fastify`, and `go-huma`, including explicit human-friendly aliases.
- [x] 1.2 Extend project options, resolved plans, and validation so GenAI plans require a pattern and Python/FastAPI while standard plans require an API stack and reject patterns.
- [x] 1.3 Add `--genai`/`--no-genai` and `--api` parsing, preserve GenAI inference from existing `--pattern` commands, and reject contradictory non-interactive inputs.
- [x] 1.4 Update create and migrate prompts to ask project type first, conditionally prompt for pattern or API stack, and keep GenAI as the interactive default.
- [x] 1.5 Update plan formatting and CLI help to display project type and the applicable API stack or GenAI pattern.
- [x] 1.6 Add catalog, planner, argument, and command tests for aliases, inference, missing inputs, conflicts, and interactive decision branching.

## 2. Rendering Architecture and Python Output

- [x] 2.1 Refactor artifact rendering into explicit common, API-stack adapter, and GenAI-extension modules without changing existing GenAI logical names or bytes unintentionally.
- [x] 2.2 Gate PydanticAI orchestration, agents, prompts, retrieval, evaluation, Langfuse, pgvector, workers, and Azure Functions behind GenAI plan checks.
- [x] 2.3 Implement the standard Python/FastAPI adapter with configuration, health/readiness routes, OpenAPI/Scalar, SQLAlchemy/Alembic integration, pytest coverage, and no AI dependencies.
- [x] 2.4 Add regression tests proving existing GenAI patterns retain their expected files, worker behavior, and deterministic output after the renderer extraction.

## 3. Node.js/Fastify Adapter

- [x] 3.1 Generate the Node.js backend package, TypeScript configuration, Fastify server, stack-native configuration, health/readiness routes, OpenAPI, and Scalar reference under idiomatic `backend/src` paths.
- [x] 3.2 Generate Drizzle PostgreSQL schema and migration integration under the shared `database` boundary with backend scripts for applying migrations.
- [x] 3.3 Generate Vitest health tests and a production-oriented multi-stage Node.js Dockerfile that serves port 8000.
- [x] 3.4 Add template tests for Node.js paths, dependencies, endpoint wiring, database artifacts, deterministic rendering, and absence of GenAI content.

## 4. Go/Huma Adapter

- [x] 4.1 Generate `go.mod`, the `backend/cmd/api` entrypoint, Huma v2/Chi routing, stack-native configuration, health/readiness operations, OpenAPI, and Scalar reference.
- [x] 4.2 Generate pgx database integration and Goose migrations under the shared `database` boundary.
- [x] 4.3 Generate Go health tests and a production-oriented multi-stage Go Dockerfile that serves port 8000.
- [x] 4.4 Add template tests for Go paths, modules, endpoint wiring, database artifacts, deterministic rendering, and absence of GenAI content.

## 5. Shared Runtime, Infrastructure, and Governance

- [x] 5.1 Render stack-aware root documentation, environment examples, environment-specific configuration, generic standard frontend copy, and seed content without GenAI language for standard projects.
- [x] 5.2 Render standard Docker Compose with the selected backend, PostgreSQL without pgvector, Redis, Azurite, Mailpit, and optional frontend while omitting Langfuse.
- [x] 5.3 Keep Azure OpenTofu output runtime-neutral for all API stacks and omit pattern-driven Function resources, settings, and outputs for standard projects.
- [x] 5.4 Tailor OpenSpec and Spec Kit governance to the project type, API stack, stack-specific backend paths, and database tooling.
- [x] 5.5 Add tests for standard and GenAI Docker, OpenTofu, frontend, environment, documentation, and governance differences.

## 6. Manifest, Update, and Doctor

- [x] 6.1 Record project type and API stack in `liftoff.config.json` and manifest v2, make the manifest pattern conditional, and validate supported identity combinations.
- [x] 6.2 Normalize legacy manifests and configurations without project identity as GenAI plus Python/FastAPI and cover the frozen v2 fixture.
- [x] 6.3 Extend update guards to refuse project-type, API-stack, and GenAI-pattern changes while preserving normal environment and frontend reconciliation.
- [x] 6.4 Add stack-specific doctor runtime and read-only project checks for Python, Node.js, and Go without requiring unrelated runtimes.
- [x] 6.5 Add manifest, validate, update, and doctor tests for standard projects, legacy normalization, unsafe identity changes, and missing toolchains.

## 7. Migration Support

- [x] 7.1 Extend the explicit legacy scan catalog for `go.mod`, Go source, Fastify/TypeScript, Huma/Chi, PydanticAI, and retrieval evidence using cross-platform path handling.
- [x] 7.2 Resolve strong scan evidence into project-type, API-stack, and pattern defaults with visible provenance, and leave weak or conflicting evidence for developer selection.
- [x] 7.3 Render migration proposals and placement tasks with the selected stack's idiomatic backend and database destinations and omit AI tasks for standard targets.
- [x] 7.4 Add Python, Node.js, Go, GenAI, weak-evidence, conflicting-evidence, and source-immutability migration tests.

## 8. Contracts, Documentation, and Cross-Platform Verification

- [x] 8.1 Update the packaged Liftoff README and package description to present both standard and GenAI creation flows, API-stack commands, layouts, and conditional folders.
- [x] 8.2 Expand the deterministic render and append-only logical-name fixture matrix with standard Python, Node.js, and Go projects and optional frontend coverage.
- [x] 8.3 Add end-to-end create, plan, validate, update, doctor, and migrate command coverage for all three standard API stacks while retaining existing GenAI command compatibility.
- [x] 8.4 Add generated-project smoke checks that parse or compile stack-native configuration with existing toolchains and verify health tests where the runtime is available.
- [x] 8.5 Add Windows CI verification and ensure path assertions use `path.join` or path-part arrays across Windows, macOS, and Linux.
- [x] 8.6 Run the Liftoff workspace check and existing package smoke test, then resolve all failures without changing unrelated packages.
