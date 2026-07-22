## Why

The Liftoff CLI README still describes installation, contracts, and release mechanics, but it does not explain the current generated project structure or the newer lifecycle commands added around manifest v2, update, migrate, and doctor. Developers need the packaged README to answer "what will this create?" and "how do I operate or update it after creation?" before they install or run the CLI.

## What Changes

- Expand the Liftoff CLI README with a quick-start flow for previewing, creating, validating, diagnosing, and running a generated project.
- Document the generated project layout, including always-generated backend/database/docker/infra/governance files and conditional frontend, Azure Functions worker, and migration folders.
- Explain how the new CLI version works across `plan`, `create`, `migrate`, `validate`, `doctor`, `update`, `dev`, and `infra`.
- Clarify the roles of `liftoff.config.json` as user-owned desired state and `liftoff.manifest.json` as the CLI-owned manifest v2 compatibility record.
- Keep this documentation-only: no command behavior, generated artifacts, package metadata, or dependencies change.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `liftoff-cli-workflow`: The packaged README must document the current CLI command lifecycle and explain how developers move from preview to create/migrate to validation, diagnostics, update checks, and helper commands.
- `liftoff-project-scaffold`: The packaged README must document the generated project structure, including conditional folders and the manifest/config ownership model.

## Impact

- Affected files: root `README.md` and OpenSpec delta specs for the two documentation requirements.
- No runtime code, generated template output, public CLI flags, package dependencies, or release automation are expected to change.
- Validation should include a package check or targeted documentation review to ensure README commands stay aligned with the implemented command surface.