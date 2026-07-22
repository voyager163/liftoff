## Why

Liftoff currently requires every generated project to select a GenAI pattern and always emits a Python FastAPI/PydanticAI backend. Developers need the same governed project foundation for standard applications, with an approved choice of Python, Node.js, or Go API stack and no AI-specific artifacts when GenAI is not selected.

## What Changes

- Ask whether a new or migrated project is a GenAI project before collecting pattern-specific decisions.
- Add a standard-project flow with approved API stacks: Python/FastAPI, Node.js/Fastify with TypeScript, and Go/Huma v2 with Chi.
- Preserve stable top-level project boundaries while generating idiomatic backend internals and language-specific database tooling for each API stack.
- Keep GenAI projects on the existing Python/FastAPI/PydanticAI stack and require a GenAI pattern only for those projects.
- Remove AI-only dependencies, folders, configuration, workers, local services, documentation, and governance language from standard projects.
- Record project type and API stack in desired state and generated manifests, infer legacy projects as GenAI, and reject project-type or API-stack changes through `liftoff update`.
- Make planning, migration, diagnostics, documentation, and contract coverage aware of the selected project type and API stack.

## Capabilities

### New Capabilities

- `liftoff-standard-projects`: Standard non-GenAI project selection, approved API-stack choices, common operational contracts, and stable top-level layout.

### Modified Capabilities

- `liftoff-cli-workflow`: Capture project type and conditionally collect either a GenAI pattern or a standard API stack.
- `liftoff-project-scaffold`: Generate stack-specific backend, database, Docker, frontend integration, and documentation artifacts without AI content for standard projects.
- `liftoff-infrastructure-governance`: Tailor infrastructure, local development, and governance output to the selected project type and API stack.
- `liftoff-manifest-contract`: Persist project type and API-stack identity while remaining compatible with existing GenAI manifests.
- `liftoff-project-migration`: Detect and preserve standard Python, Node.js, and Go API projects during migration.
- `liftoff-project-update`: Treat project-type and API-stack changes as migrations rather than safe template updates.
- `liftoff-project-doctor`: Run runtime and tooling diagnostics appropriate to the generated API stack.

## Impact

- Affects Liftoff option parsing, interactive prompts, catalogs, plan validation, artifact rendering, manifests, reconciliation, migration scanning, diagnostics, documentation, and test fixtures in the repository root.
- Introduces generated runtime dependencies for Fastify/TypeScript and Huma/Chi, plus approved language-specific PostgreSQL migration tooling.
- Expands OpenSpec contracts and generated governance content while preserving existing GenAI command compatibility and cross-platform path semantics.
