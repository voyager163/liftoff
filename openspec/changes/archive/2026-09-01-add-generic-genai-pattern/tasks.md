## 1. Pattern catalog and selection

- [x] 1.1 Add the append-only `generic` `PatternId` and first catalog entry with neutral metadata, aliases, foundation status, `/api/ai` route prefix, and no worker; verify catalog tests list exactly nine stable pattern IDs in the intended order.
- [x] 1.2 Present `I'm not sure yet - Generic GenAI starter` as the first and default interactive pattern choice while retaining catalog-friendly labels elsewhere; verify scripted rich, compact, and plain prompt tests select `generic` when Enter accepts the default.
- [x] 1.3 Accept `--pattern generic`, documented aliases, and `pattern: generic` configuration through existing strict catalog validation; verify planner and command tests reject unknown values while resolving generic to Python/FastAPI/PydanticAI.

## 2. Generic backend and frontend scaffold

- [x] 2.1 Render a neutral `/api/ai/run` request route, generic PydanticAI runner, general-purpose prompt, tracing boundary, and injected-runner offline test; verify generated Python tests exercise the route contract without network access.
- [x] 2.2 Keep generic output free of RAG retrieval and pgvector, ingestion/task workers, chat persistence, specialized tools, streaming adapters, fine-tuning datasets, and workflow structures; verify exact forbidden logical names, paths, schema fragments, and worker files are absent.
- [x] 2.3 Render the optional generic Vue frontend as a neutral text-input playground calling `/api/ai/run`; verify its request method/body and visible copy contain no specialized pattern claims.
- [x] 2.4 Preserve the common tested GenAI dependencies, Docker services, environments, Azure OpenTofu, and governance applicability while omitting Function worker infrastructure; verify container configuration and OpenTofu validation cover the generic backend-only and frontend shapes.

## 3. Identity, provenance, and compatibility

- [x] 3.1 Propagate `generic` through `liftoff.config.json`, schema-v6 workload identity, `GENAI_PATTERN`, model configuration, generated README, governance context, and bootstrap capability naming; verify all rendered surfaces agree on the identifier.
- [x] 3.2 Extend logical-name and deterministic artifact fixtures for generic backend-only and frontend plans without changing existing pattern snapshots; verify project-owned lifecycle and generation hashes remain valid.
- [x] 3.3 Preserve the existing pattern-change migration guard for generic projects and all specialized projects; verify `liftoff update` rejects generic-to-specialized and specialized-to-generic desired-state changes without touching project files.
- [x] 3.4 Verify supported v2-v6 manifest readers accept explicit `generic` identity where structurally applicable, continue rejecting missing or unknown GenAI patterns, and require no manifest schema bump.

## 4. User-facing catalog and guidance

- [x] 4.1 Update `liftoff patterns`, plan output, help and lifecycle snapshots to show nine patterns and distinguish the interactive uncertainty wording from the stored `Generic GenAI Starter` label.
- [x] 4.2 Update generated project guidance to explain the neutral scaffold, intentionally absent specializations, and reviewed migration boundary; verify generated README tests never direct users to `liftoff update` or `--force` for specialization.
- [x] 4.3 Update README and workload, CLI, configuration, project-structure, migration, and troubleshooting documentation with the generic interactive and `--pattern generic` paths; verify documentation links and ownership language remain valid.

## 5. Complete verification

- [x] 5.1 Add catalog, interactive, planner, manifest, template, frontend, governance, update-guard, and command regression coverage for generic, and verify targeted Vitest suites pass.
- [x] 5.2 Confirm the shared generation and path suites containing generic run in the existing Windows, macOS, and Linux CI matrix and use platform path utilities for every expected filesystem path.
- [x] 5.3 Run the full TypeScript build, test suite, supported-stack checks, package smoke test, representative generated-template verification, strict OpenSpec validation, and diff checks.
