## 1. CLI Foundation

- [x] 1.1 Initialize the TypeScript/Node.js CLI package structure with a `liftoff` binary entrypoint suitable for future `@mission-control/liftoff` npm packaging.
- [x] 1.2 Add command routing for `create`, `plan`, `patterns`, `providers`, `regions`, `validate`, `doctor`, `dev`, and `infra`.
- [x] 1.3 Add shared option parsing for interactive and non-interactive creation flows.
- [x] 1.4 Add cross-platform filesystem utilities that use `path.join()` and `path.resolve()` for all generated paths.

## 2. Catalogs And Planning

- [x] 2.1 Define explicit GenAI pattern catalog entries for RAG, chatbot, agent-based, prompt-based, multi-agent, fine-tuned model, real-time/streaming, and workflow/pipeline scaffolds.
- [x] 2.2 Define provider catalog entries with Azure marked available and AWS/GCP marked planned.
- [x] 2.3 Define Azure region catalog entries and aliases, including East US as `eastus` and ambiguous Korea matches for `koreacentral` and `koreasouth`.
- [x] 2.4 Define environment defaults for dev, test, and prod.
- [x] 2.5 Define spec workflow catalog entries for OpenSpec default and Spec Kit selectable output.
- [x] 2.6 Implement `ProjectPlan` construction from prompts, flags, or config file input.
- [x] 2.7 Implement plan validation that rejects unsupported providers, ambiguous non-interactive regions, missing required decisions, and invalid environment selections.

## 3. Interactive And Non-Interactive Workflows

- [x] 3.1 Implement interactive `liftoff create` prompts for project name, pattern, cloud, region, frontend, spec workflow, and environments.
- [x] 3.2 Ensure PydanticAI, FastAPI, Scalar, OpenTofu, PostgreSQL, Redis, Langfuse, and Alembic are applied as defaults without framework prompts.
- [x] 3.3 Implement interactive region disambiguation for human-friendly inputs such as `korea`.
- [x] 3.4 Implement create confirmation that displays the resolved stack, files, local development services, Azure region, frontend choice, and spec workflow before writing.
- [x] 3.5 Implement non-interactive `liftoff create` support for flags such as `--pattern`, `--cloud`, `--region`, `--frontend`, `--no-frontend`, `--spec`, `--environments`, `--config`, and `--yes`.
- [x] 3.6 Implement `liftoff plan` so generation can be previewed without writing files.

## 4. Safe Rendering And Manifests

- [x] 4.1 Implement target directory validation that permits only new or empty directories by default.
- [x] 4.2 Implement explicit generated artifact manifests for base, pattern, provider, frontend, environment, and spec workflow outputs.
- [x] 4.3 Implement template rendering using manifest entries rather than filesystem glob discovery.
- [x] 4.4 Validate generated manifests before reporting success and report missing artifacts by explicit logical name.
- [x] 4.5 Add tests for Windows, macOS, and Linux path behavior using Node path utilities rather than hardcoded separators.

## 5. Backend Scaffold Templates

- [x] 5.1 Generate FastAPI backend entrypoints, health/readiness routes, dependency wiring, and Scalar developer portal configuration.
- [x] 5.2 Generate PydanticAI orchestration structure, prompt templates, model configuration, and Pydantic runtime settings.
- [x] 5.3 Generate PostgreSQL persistence structure, Alembic migration scaffolding, and database folder contents.
- [x] 5.4 Generate Redis integration and messaging boundary structure.
- [x] 5.5 Generate Langfuse tracing hooks and structured logging placeholders.
- [x] 5.6 Generate backend tests and README instructions for local and generated API workflows.

## 6. Pattern Scaffold Templates

- [x] 6.1 Generate RAG-specific retrieval orchestration, ingestion worker structure, embedding pipeline structure, pgvector integration points, and document storage configuration.
- [x] 6.2 Generate chatbot-specific routes, conversation persistence structure, prompt templates, and orchestration modules.
- [x] 6.3 Generate agent-based task execution routes, agent orchestration modules, tool boundary placeholders, and worker structure.
- [x] 6.4 Generate prompt-based named prompt templates, invocation routes, and structured output validation examples.
- [x] 6.5 Generate multi-agent coordination structure, agent role folders, shared state boundaries, and run orchestration routes.
- [x] 6.6 Generate fine-tuned model endpoint configuration, invocation routes, and evaluation dataset structure.
- [x] 6.7 Generate real-time/streaming response routes and streaming configuration.
- [x] 6.8 Generate workflow/pipeline stage structure, run persistence structure, trigger configuration, and worker structure.

## 7. Frontend And Local Development

- [x] 7.1 Generate no `frontend` folder when frontend is disabled.
- [x] 7.2 Generate Vue 3/Tailwind frontend structure when frontend is enabled.
- [x] 7.3 Generate pattern-aware frontend starters for RAG, chatbot, agent, prompt, multi-agent, fine-tuned, streaming, and workflow patterns.
- [x] 7.4 Generate Docker Compose configuration for backend, PostgreSQL with pgvector, Redis, Azurite, and Mailpit.
- [x] 7.5 Generate optional Docker Compose observability profile for Langfuse.
- [x] 7.6 Generate local Redis Streams messaging configuration behind the same application boundary used by Azure Service Bus cloud configuration.

## 8. Azure OpenTofu Infrastructure

- [x] 8.1 Generate Azure OpenTofu provider, variables, outputs, and environment tfvars structure.
- [x] 8.2 Generate Azure Container Apps infrastructure for backend and separate frontend workload when frontend is enabled.
- [x] 8.3 Generate Azure Container Registry infrastructure by default.
- [x] 8.4 Generate Azure Database for PostgreSQL and pgvector-ready configuration.
- [x] 8.5 Generate Azure Redis Cache, Azure Storage/Blob, Azure Service Bus, and Azure Communication Services infrastructure.
- [x] 8.6 Generate Azure Key Vault, managed identity, and secret reference wiring.
- [x] 8.7 Generate local OpenTofu state defaults plus remote-state example documentation.
- [x] 8.8 Generate infrastructure README commands for init, plan, apply, and output per selected environment.

## 9. Spec-Driven Governance

- [x] 9.1 Generate OpenSpec directory structure and stack-aware `openspec/config.yaml` when OpenSpec is selected or defaulted.
- [x] 9.2 Generate an initial OpenSpec seed bootstrap change for the generated application baseline.
- [x] 9.3 Generate Spec Kit constitution and supporting template structure when Spec Kit is selected.
- [x] 9.4 Ensure governance content reflects selected pattern, Azure/OpenTofu stack, optional frontend choice, environment list, and standard folder layout.

## 10. Discovery, Diagnostics, And Helpers

- [x] 10.1 Implement `liftoff patterns` with all eight patterns and scaffold status.
- [x] 10.2 Implement `liftoff providers` with Azure available and AWS/GCP planned.
- [x] 10.3 Implement `liftoff regions list` and `liftoff regions search` for Azure region discovery.
- [x] 10.4 Implement `liftoff validate` for generated project manifest and configuration checks.
- [x] 10.5 Implement `liftoff doctor` for local Node.js, Python, Docker, Docker Compose, and OpenTofu readiness checks.
- [x] 10.6 Implement optional Azure readiness checks for `liftoff doctor --cloud azure`.
- [x] 10.7 Implement `liftoff dev` helper commands that wrap generated Docker Compose workflows without hiding the underlying generated files.
- [x] 10.8 Implement `liftoff infra` helper commands that wrap generated OpenTofu workflows by selected environment.

## 11. Verification

- [x] 11.1 Add unit tests for catalog validation, ProjectPlan construction, provider availability, and region resolution.
- [x] 11.2 Add snapshot or fixture tests for generated manifests across all eight GenAI patterns with frontend enabled and disabled.
- [x] 11.3 Add tests for non-empty target directory rejection and plan mode no-write behavior.
- [x] 11.4 Add generated-project smoke tests for backend-only and frontend-enabled Azure RAG projects.
- [x] 11.5 Add OpenTofu formatting/validation checks for generated Azure infrastructure.
- [x] 11.6 Add Docker Compose config validation for generated local development files.
- [x] 11.7 Add Windows CI verification for path handling and generated manifest expectations.
- [x] 11.8 Run the full test suite and document any generated-project validation limitations before marking the change complete.