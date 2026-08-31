## ADDED Requirements

### Requirement: Standard stacks use the release-owned tested baseline
The system SHALL generate the Python/FastAPI, Node.js/Fastify/TypeScript, and Go/Huma/Chi stacks from exact dependency and runtime identities recorded by the current Liftoff supported-stack baseline. A baseline refresh MAY cross stable major versions only when the generated stack is migrated and its complete workload contract passes verification.

#### Scenario: Generate the Python standard stack
- **WHEN** a developer selects `python-fastapi`
- **THEN** the project uses Python 3.14-compatible packages from a generated `uv.lock`
- **AND** dependency synchronization is frozen

#### Scenario: Generate the Node.js standard stack
- **WHEN** a developer selects `node-fastify`
- **THEN** the backend uses the Node.js 24 LTS, Fastify, TypeScript, Drizzle, PostgreSQL, and Vitest identities recorded by the baseline
- **AND** its package lock installs without mutation

#### Scenario: Generate the Go standard stack
- **WHEN** a developer selects `go-huma`
- **THEN** the backend uses Go 1.27 and the tested Huma, Chi, pgx, and Goose identities recorded by the baseline
- **AND** module download and tests do not change `go.mod` or `go.sum`

#### Scenario: Generate the optional frontend
- **WHEN** a standard project includes a frontend
- **THEN** it uses the tested stable Vue, Vite, Tailwind, PostCSS, and plugin major versions recorded by the baseline
- **AND** its production build preserves package metadata

### Requirement: Major stack refreshes preserve the standard API contract
A dependency major upgrade SHALL preserve the selected stack's port, health, readiness, OpenAPI, Scalar, configuration, database, migration, and test behavior unless a separate approved capability change explicitly changes that product contract.

#### Scenario: Verify all three upgraded stacks
- **WHEN** the supported baseline changes one or more standard stack majors
- **THEN** representative Python, Node.js, and Go generated projects pass their install, build, and test commands
- **AND** each still satisfies the common standard API contract
