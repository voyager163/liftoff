## Why

Liftoff currently models generated workers as backend-adjacent code under `backend/workers`, which is useful for containerized background execution but does not match Azure Functions' separate runtime, trigger, binding, settings, and deployment contract. Adding an explicit Azure Functions worker scaffold gives generated projects a clear home for event-driven compute while keeping reusable GenAI orchestration code shared from the backend layer.

## What Changes

- Add Azure Functions worker scaffolding to generated Liftoff projects when a selected pattern needs event-driven or asynchronous processing.
- Introduce a top-level `functions/<worker-name>` layout with Function app runtime files, tests, local settings examples, and clear boundaries from `backend/workers`.
- Update environment templates so selected environments can include Function app settings without committing secrets.
- Update Azure OpenTofu output so generated infrastructure can provision and configure Function app hosting alongside the existing Azure resources.
- Update generated documentation and manifest entries to describe the distinction between backend workers and Azure Functions workers.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `liftoff-project-scaffold`: Generated project layout and pattern-aware worker output will include a top-level Azure Functions worker area where applicable.
- `liftoff-infrastructure-governance`: Azure infrastructure, environment configuration, and governance documentation will cover generated Azure Functions workers.

## Impact

- Affected code: `src/templates.ts`, planner/catalog types if worker placement becomes configurable, generated manifest content, and Liftoff tests.
- Affected generated files: top-level `functions/`, environment templates, Docker/local development documentation, and Azure OpenTofu files under `infrastructure/opentofu/azure`.
- Affected specs: `liftoff-project-scaffold` and `liftoff-infrastructure-governance`.
- No breaking changes are expected for existing generated projects or existing CLI commands.