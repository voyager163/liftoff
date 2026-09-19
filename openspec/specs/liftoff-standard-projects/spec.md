## Purpose

Define standard Liftoff projects, their approved API stacks, shared operational contract, GenAI exclusions, stable layout, and language-specific database tooling.

## Requirements

### Requirement: Developers can create standard projects
The system SHALL let developers identify a project as either GenAI or standard during `liftoff init` before collecting type-specific project decisions, SHALL require a GenAI pattern only for GenAI projects, and SHALL require an approved API stack only for standard projects.

#### Scenario: Select a standard project interactively
- **WHEN** a developer runs `liftoff init` interactively and answers no to the GenAI project question
- **THEN** the CLI skips the GenAI pattern prompt
- **AND** the CLI asks the developer to select an approved standard API stack

#### Scenario: Select a GenAI project interactively
- **WHEN** a developer answers yes to the GenAI project question
- **THEN** the CLI asks for one of the supported GenAI patterns
- **AND** the generated API stack remains Python/FastAPI with PydanticAI

### Requirement: Standard projects support three approved API stacks
The system SHALL support exactly one approved standard API stack for each offered language: Python with FastAPI, Node.js with Fastify and TypeScript, and Go with Huma v2 and Chi.

#### Scenario: Select Python API
- **WHEN** a developer selects the Python standard API stack
- **THEN** the generated backend uses FastAPI and Python-native project, configuration, test, and packaging conventions

#### Scenario: Select Node.js API
- **WHEN** a developer selects the Node.js standard API stack
- **THEN** the generated backend uses Fastify with TypeScript and Node.js-native project, configuration, test, and packaging conventions

#### Scenario: Select Go API
- **WHEN** a developer selects the Go standard API stack
- **THEN** the generated backend uses Huma v2 with Chi and Go-native module, package, configuration, and test conventions

### Requirement: Standard API stacks share an operational contract
The system SHALL generate every standard API stack with port `8000`, health and readiness endpoints, an OpenAPI document, a Scalar API reference, PostgreSQL integration, a stack-native health test, and one documented runtime configuration contract. Supplied process environment MUST override the selected project configuration file, and that file MUST override nonsecret defaults. Native startup and Docker Compose recipes SHALL resolve the same applicable application, database, service, and readiness settings. Omitted messaging or tracing boundaries SHALL NOT create configuration prerequisites, and standard stacks SHALL NOT require pgvector or pattern-specific worker behavior.

Scalar and schema routes SHALL retain their published canonical locations and satisfy the shared prefix-safe direct/proxy contract, including trailing-slash forms, relative canonicalization redirects, query preservation, actual JSON content type, and the application's actual schema identity. Documentation SHALL NOT depend on frontend-root routing.

#### Scenario: Inspect a generated standard API
- **WHEN** a developer generates any supported standard API stack
- **THEN** the backend exposes `GET /health` and `GET /ready`
- **AND** the backend exposes OpenAPI-backed Scalar API documentation
- **AND** the generated runtime listens on port `8000`

#### Scenario: Process environment overrides the selected standard configuration
- **WHEN** a supported standard runtime value is set in both process environment and the selected project configuration file
- **THEN** the generated application uses the process-environment value
- **AND** the documented precedence matches the running application behavior

#### Scenario: Native and Compose recipes agree for standard projects
- **WHEN** a developer starts the same generated standard project natively and through Docker Compose
- **THEN** both startup paths resolve the same selected configuration values
- **AND** Docker Compose changes only the service addresses needed for container networking

### Requirement: Standard projects exclude GenAI components
The system SHALL omit PydanticAI, model configuration, agents, prompts, retrieval, evaluation, AI orchestration, GenAI pattern settings, Langfuse integration, pattern workers, pattern-driven Azure Functions, pgvector-only storage, and specialized publisher wiring from standard projects.

#### Scenario: Generate a standard project
- **WHEN** a developer generates a standard project with any approved API stack
- **THEN** no generated path is under `backend/orchestration` or `functions`
- **AND** generated dependencies, configuration, documentation, and governance contain no required GenAI runtime components

#### Scenario: Standard local and container output stays non-GenAI
- **WHEN** a generated standard project uses its native or Docker Compose local workflow
- **THEN** no pgvector image, GenAI worker, Langfuse dependency, or pattern-specific publisher configuration is required

### Requirement: Standard projects retain stable top-level boundaries
The system SHALL keep backend, database, environment, infrastructure, governance, and optional frontend output under stable top-level boundaries while allowing each API stack to use idiomatic backend internals.

#### Scenario: Compare standard API stack layouts
- **WHEN** Python, Node.js, and Go standard projects are generated with equivalent project decisions
- **THEN** each project contains `backend`, `database`, `environments`, and `infrastructure` top-level folders
- **AND** each backend uses the approved internal layout for its selected language

#### Scenario: Generate paths across operating systems
- **WHEN** a standard project is generated on Windows, macOS, or Linux
- **THEN** the same logical top-level folders and manifest path parts are produced using platform-correct filesystem paths

### Requirement: Standard projects use approved language-specific database tooling
The system SHALL keep database artifacts under the common `database` boundary while generating SQLAlchemy and Alembic for Python, Drizzle for Node.js, and pgx with Goose migrations for Go.

#### Scenario: Generate database integration
- **WHEN** a developer creates a standard project
- **THEN** the backend dependencies and database artifacts use the approved tooling for the selected API stack
- **AND** an initial PostgreSQL migration is generated

### Requirement: Standard project workstation readiness is stack-specific
The system SHALL select blocking runtime requirements and project dependency commands from the approved standard API stack. It SHALL NOT block a standard project on runtimes used only by unselected stacks.

#### Scenario: Python standard project readiness
- **WHEN** a developer initializes a standard Python/FastAPI project
- **THEN** Liftoff requires the supported Python runtime and offers the Python virtual-environment dependency flow
- **AND** it does not require Go

#### Scenario: Node.js standard project readiness
- **WHEN** a developer initializes a standard Node.js/Fastify project
- **THEN** Liftoff requires the supported Node.js runtime and offers the lockfile-preserving Node.js dependency flow
- **AND** it does not require the Python backend runtime or Go

#### Scenario: Go standard project readiness
- **WHEN** a developer initializes a standard Go/Huma project
- **THEN** Liftoff requires the supported Go toolchain and offers the generated-module download flow
- **AND** it does not require the Python backend runtime

#### Scenario: Spec Kit adds only its own prerequisite
- **WHEN** a Node.js or Go standard project selects Spec Kit
- **THEN** Python and `uv` requirements needed by the pinned Spec Kit CLI are identified as framework prerequisites
- **AND** they are not presented as backend runtime requirements

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

### Requirement: Scalar schema references preserve the browser-visible prefix
Generated Go/Huma and Node.js/Fastify APIs SHALL use schema references that resolve under the browser-visible application prefix rather than hard-coded origin-root URLs. Standard Python/FastAPI and every supported GenAI variant SHALL satisfy the same contract. Direct and prefix-stripping proxy access SHALL preserve the existing canonical documentation and schema endpoints without requiring trusted forwarded-host headers, absolute host reconstruction, a fixed deployment prefix, or a frontend-root schema workaround.

#### Scenario: Open documentation directly
- **WHEN** the canonical documentation endpoint is opened without a proxy
- **THEN** Scalar resolves and loads the application's own OpenAPI document
- **AND** its reference does not depend on a particular public host or deployment prefix

#### Scenario: Open documentation behind a prefix-stripping proxy
- **WHEN** the browser accesses the application under a non-root prefix that the proxy removes before forwarding
- **THEN** Scalar's schema request retains that browser-visible prefix and reaches the same application schema
- **AND** it does not request an origin-root schema outside the selected application

#### Scenario: Go and Node share the defect correction
- **WHEN** the supported Go/Huma and Node.js/Fastify outputs are qualified
- **THEN** both satisfy the same prefix-preserving reference behavior
- **AND** fixing only the reported Go URL does not qualify the unchanged Node defect

#### Scenario: Forwarded host metadata is untrusted
- **WHEN** a direct or proxied request supplies absent, unexpected, or attacker-controlled forwarded-host metadata
- **THEN** documentation links and canonicalization do not reconstruct a destination from that metadata
- **AND** schema navigation stays relative to the actual application entry point

### Requirement: Documentation and schema canonicalization preserves prefix and query
Both canonical and trailing-slash forms of the published documentation and OpenAPI routes SHALL resolve successfully under direct access and a prefix-stripping proxy. A form that requires canonicalization SHALL return a relative, prefix-preserving `Location` and retain the original query string without loss or double encoding. A form served without redirection SHALL provide the same declared documentation or schema response. Canonicalization SHALL NOT redirect to an origin-root path, derive an authority from forwarding headers, or create a loop.

#### Scenario: Canonical and trailing-slash documentation URLs are opened
- **WHEN** each form is requested directly and under a non-root application prefix
- **THEN** the final documentation page loads the correct same-application schema in every case
- **AND** any redirect keeps the visible prefix rather than escaping to the host root

#### Scenario: A schema URL requires a redirect
- **WHEN** a schema route's noncanonical slash form is requested with a query string
- **THEN** its `Location` is relative and resolves to the canonical schema within the original visible prefix
- **AND** the query string retains duplicate keys, blank values, and encoded characters without dropping or double encoding them

#### Scenario: Canonicalization is followed through a proxy
- **WHEN** a client follows the returned relative redirect behind a prefix-stripping proxy
- **THEN** it reaches the intended canonical endpoint without an additional prefix, lost prefix, or redirect loop
- **AND** the same request has equivalent route semantics without the proxy

### Requirement: Schema qualification verifies JSON content and application identity
Qualification SHALL exercise the actual generated application routes for Go/Huma, Node.js/Fastify, standard Python/FastAPI, and supported GenAI variants, directly and through a prefix-stripping proxy, using canonical and trailing-slash forms with representative queries. Schema responses SHALL have a real JSON media type, parse as OpenAPI, and preserve the application's actual `paths` and `components` structure and content across variants, including whether optional structures are present. HTTP 200, a nonempty body, a Scalar page, an empty substitute schema, or SPA HTML SHALL NOT count as schema proof. HTTP URL semantics SHALL remain independent from native filesystem separators.

#### Scenario: Every route variant returns the same schema
- **WHEN** the qualification matrix fetches the real document through direct/proxied canonical/trailing-slash entry points
- **THEN** each result has the declared JSON content type and valid OpenAPI structure
- **AND** its `paths` and `components` match the actual canonical application schema rather than a separately maintained fixture document

#### Scenario: A fallback page returns HTTP 200
- **WHEN** a schema request returns HTML from a frontend or catch-all route
- **THEN** qualification fails despite the successful status code
- **AND** the diagnostic identifies the content-type or schema mismatch

#### Scenario: A schema silently loses routes or models
- **WHEN** a proxied response parses as JSON but omits or changes application paths or components
- **THEN** schema identity comparison fails
- **AND** a syntactically valid or empty document is not accepted as equivalent

#### Scenario: Python and GenAI require the same evidence
- **WHEN** Python standard and supported GenAI variants are qualified without production model credentials
- **THEN** their documentation, redirects, query handling, JSON media type, and schema identity pass the same matrix
- **AND** their framework defaults are not assumed correct without evidence

#### Scenario: Qualify generated projects across host platforms
- **WHEN** affected projects are generated and exercised on Windows, macOS, and Linux using native project paths with spaces
- **THEN** generated logical artifact identities remain stable and HTTP paths use URL semantics
- **AND** filesystem path handling cannot introduce backslashes or host-dependent behavior into public routes

### Requirement: Existing documentation handlers evolve only through reviewed per-file changes
Fixing generated Scalar/OpenAPI output SHALL NOT authorize ordinary update or CLI installation to overwrite existing project-owned handlers. Supported existing-project remediation SHALL use explicit observed application mappings, exact before/after effects, preserved business routes and references, independently authorized staged checks, and separate file approval. Unsupported or ambiguous custom routing SHALL remain a blocker rather than trigger whole-template replacement.

#### Scenario: An existing Go or Node application has custom handlers
- **WHEN** a reviewed repair or adoption plan applies the known prefix-safe routing correction
- **THEN** only its exact mapped handler and reference changes commit after matching route qualification
- **AND** custom business endpoints, unrelated files, and original provenance remain protected

#### Scenario: A managed update sees newer backend templates
- **WHEN** `liftoff update` runs after the generator fix is installed
- **THEN** it does not overwrite, restore, or classify project handlers as managed template drift
- **AND** an assessment finding can recommend the separate supported per-file evolution preview
