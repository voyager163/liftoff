## Why

The Liftoff CLI currently has reproducible safety, validation, and generated-output defects that can overwrite user files, escape the project boundary, silently accept mistyped commands, or emit scaffolds that cannot satisfy their documented contracts. These gaps should be closed before treating Liftoff updates and generated Azure projects as production-safe.

## What Changes

- Constrain every manifest artifact path and filesystem mutation to the discovered project root, including protection against `..`, absolute paths, malformed path parts, and symlink escapes.
- Make reconciliation destination-aware so new and moved artifacts never overwrite an existing user-owned file unless it is an explicitly forced conflict.
- Surface filesystem failures accurately and avoid reporting successful applies when writes, moves, or deletions did not complete.
- **BREAKING**: reject unknown flags, unsupported subcommands, invalid boolean/config values, and unsafe manifests instead of silently accepting or normalizing them; render expected usage errors without Node.js stack traces.
- Generate Azure resource names that satisfy service-specific limits and uniqueness requirements.
- Complete Azure Functions managed-identity settings, role assignments, storage configuration, and queue-variable wiring for worker-enabled projects.
- Generate formatter-clean OpenTofu and add deployability-oriented infrastructure regression checks.
- Make generated Go projects immediately testable with complete module checksum metadata.
- Replace advertised GenAI, messaging, observability, and frontend no-op paths with minimal working integrations that satisfy the existing scaffold contracts while retaining clear extension points.
- Add focused regression coverage for project-boundary enforcement, destination collisions, CLI parsing failures, generated stack builds, and infrastructure invariants.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-project-update`: Require project-confined, collision-safe, failure-accurate reconciliation and apply behavior.
- `liftoff-manifest-contract`: Require strict manifest shape and portable path validation before any artifact access or mutation.
- `liftoff-cli-workflow`: Require strict command, subcommand, flag, and configuration validation with concise user-facing errors.
- `liftoff-infrastructure-governance`: Require deployable Azure naming, complete Function worker identity/queue wiring, and formatter-clean OpenTofu.
- `liftoff-project-scaffold`: Require immediately testable generated stacks and minimally functional integrations for advertised GenAI, messaging, observability, and frontend behavior.

## Impact

- Affected implementation: `src/args.ts`, `cli.ts`, `commands.ts`, `file-system.ts`, `reconcile.ts`, `planner.ts`, and generated template modules.
- Affected tests: CLI command tests, manifest contract tests, update/reconciliation tests, generated-stack smoke tests, and infrastructure template tests.
- Affected generated projects: future `create`, `migrate`, and `update --apply` output; existing valid schema-v2 projects remain supported.
- No new runtime dependency is expected for the CLI itself, though generated project dependency metadata and templates will change.
