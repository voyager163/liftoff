## Why

Developers need a guided, repeatable way to bootstrap enterprise GenAI applications without re-deciding the approved stack, folder structure, infrastructure baseline, and spec-driven workflow for every project. Mission Control should provide Liftoff as a Node-based npm CLI that turns a small set of product decisions into a ready-to-use GenAI application scaffold.

## What Changes

- Add the Liftoff CLI as the Mission Control project bootstrapper, packaged for future npm distribution with a `liftoff` binary.
- Provide an interactive `liftoff create` flow that captures project name, GenAI pattern, target cloud, deployment region, optional frontend, environments, and spec-driven workflow.
- Default generated applications to FastAPI, PydanticAI, Scalar, PostgreSQL, Redis, Langfuse, Alembic, Docker Compose, and OpenTofu without prompting for framework selection.
- Support all eight GenAI application patterns in V1, with pattern-aware scaffold depth and generated routes, orchestration, prompts, workers, and local development services.
- Make Azure the complete V1 cloud provider, expose AWS and GCP as planned provider adapters, and generate Azure OpenTofu infrastructure with dev/test/prod configuration.
- Generate OpenSpec by default, allow Spec Kit selection, and create workflow-specific governance files based on the selected stack.

## Capabilities

### New Capabilities

- `liftoff-cli-workflow`: Interactive and non-interactive CLI behavior, command surface, input validation, region resolution, generation planning, and safe file creation.
- `liftoff-project-scaffold`: Generated GenAI application structure, approved framework defaults, pattern-specific backend scaffolds, optional Vue frontend, local Docker Compose development, and standardized best practices.
- `liftoff-infrastructure-governance`: Azure-complete OpenTofu output, provider adapter modeling, environment configuration, and generated spec-driven development assets for OpenSpec or Spec Kit.

### Modified Capabilities

- None.

## Impact

- Adds a Node.js CLI surface intended for future npm packaging as `@mission-control/liftoff` with a `liftoff` binary.
- Adds template/rendering logic for generated Python FastAPI/PydanticAI backends, optional Vue 3/Tailwind frontends, database artifacts, Docker Compose files, and OpenTofu infrastructure.
- Introduces provider and pattern catalogs, including Azure region aliases and planned AWS/GCP adapter metadata.
- Introduces generated governance artifacts for OpenSpec and Spec Kit workflows.
- Requires cross-platform path handling and tests for macOS, Linux, and Windows because the CLI creates directories and files.