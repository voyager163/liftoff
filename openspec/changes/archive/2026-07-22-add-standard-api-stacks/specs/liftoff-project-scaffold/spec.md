## MODIFIED Requirements

### Requirement: Generated projects use the approved backend stack
The system SHALL generate a backend using the stack approved for the selected project type. GenAI projects SHALL use FastAPI, PydanticAI, Pydantic runtime configuration models, Scalar, SQLAlchemy, Alembic, PostgreSQL, Redis, Langfuse tracing hooks, and Docker-compatible runtime configuration. Standard projects SHALL use the selected approved Python/FastAPI, Node.js/Fastify, or Go/Huma API stack with its approved runtime configuration, PostgreSQL integration, migration tooling, testing framework, Scalar portal, and Docker-compatible runtime configuration.

#### Scenario: Generate GenAI backend scaffold
- **WHEN** a developer creates a GenAI Liftoff project
- **THEN** the generated backend includes API entrypoints, PydanticAI orchestration structure, model configuration, prompt templates, runtime settings, tests, and Scalar developer portal wiring

#### Scenario: GenAI framework choices are standardized
- **WHEN** a GenAI backend scaffold is generated
- **THEN** the generated project uses PydanticAI for GenAI orchestration and does not include alternate GenAI framework scaffolds

#### Scenario: Generate standard backend scaffold
- **WHEN** a developer creates a standard Liftoff project
- **THEN** the generated backend includes stack-native API entrypoints, runtime configuration, database integration, tests, OpenAPI, and Scalar developer portal wiring
- **AND** it excludes PydanticAI and other GenAI runtime dependencies

### Requirement: Generated projects use the standard folder layout
The system SHALL place generated backend code under `backend`, database-related artifacts under `database`, environment configuration under `environments`, infrastructure under `infrastructure`, and optional frontend code under `frontend`. Python backends SHALL retain API code under `backend/apis`; Node.js and Go backends SHALL use their approved idiomatic internal layouts under `backend`. Azure Functions worker code SHALL appear under `functions/<worker-name>` only when a generated GenAI pattern includes worker support.

#### Scenario: Standard backend-only project layout
- **WHEN** a developer creates a standard project without a frontend
- **THEN** the generated project includes `backend` and `database` folders using the selected API stack's internal layout
- **AND** it does not include `frontend`, `backend/orchestration`, or `functions` folders

#### Scenario: Frontend project layout
- **WHEN** a developer creates a project with a frontend
- **THEN** the generated project includes a Vue 3/Tailwind frontend under `frontend` in addition to backend and database folders

#### Scenario: Azure Functions worker layout
- **WHEN** a developer creates an Azure GenAI project for a pattern that includes generated worker support
- **THEN** the generated project includes an Azure Functions worker scaffold under `functions/<worker-name>`
- **AND** the worker scaffold includes Function app runtime files, local settings examples, trigger adapter code, tests, and documentation

#### Scenario: Cross-platform layout creation
- **WHEN** the CLI creates the standard folders on Windows, macOS, or Linux
- **THEN** the same logical folders are generated using platform-correct path handling

### Requirement: Generated projects include optional pattern-aware frontend
The system SHALL ask whether to generate a frontend and, when selected, generate a Vue 3/Tailwind frontend suited to the project type. GenAI frontends SHALL remain suited to the selected GenAI pattern; standard frontends SHALL provide a generic API starter that uses the selected stack's common API contract.

#### Scenario: Frontend selected for RAG
- **WHEN** a developer selects the RAG pattern and chooses to include a frontend
- **THEN** the generated frontend provides a retrieval/search starter experience that can call the generated backend API

#### Scenario: Frontend selected for standard API
- **WHEN** a developer creates a standard project and chooses to include a frontend
- **THEN** the generated frontend provides a generic API starter without GenAI pattern language or AI-specific controls

#### Scenario: Frontend omitted
- **WHEN** a developer chooses not to include a frontend
- **THEN** the generated project remains API-first and still includes Scalar for backend API exploration

### Requirement: Generated projects include local Docker Compose development
The system SHALL generate Docker Compose local development configuration for the backend, PostgreSQL, Redis, Azurite, Mailpit, and the optional frontend. GenAI projects SHALL use pgvector when required by the selected pattern and SHALL include the optional Langfuse observability profile. Standard projects SHALL use PostgreSQL without pgvector and SHALL omit Langfuse.

#### Scenario: Start standard local stack
- **WHEN** a generated standard project runs its default local Docker Compose command
- **THEN** the selected backend runtime, PostgreSQL, Redis, Azurite, and Mailpit services are available for local development
- **AND** no Langfuse service or pgvector image is required

#### Scenario: Start GenAI default local stack
- **WHEN** a generated GenAI project runs its default local Docker Compose command
- **THEN** the backend, PostgreSQL or PostgreSQL/pgvector as required, Redis, Azurite, and Mailpit services are available for local development

#### Scenario: Start GenAI observability profile
- **WHEN** a developer runs the generated GenAI Docker Compose command with the observability profile
- **THEN** Langfuse services are included in the local stack

### Requirement: Packaged README documents generated project structure
The system SHALL document the generated Liftoff project structure in the packaged root `README.md`, including stable top-level folders, API-stack-specific backend internals, conditional folders, and the ownership model for generated configuration and manifest files.

#### Scenario: Review core project layout
- **WHEN** a developer reads the generated structure documentation
- **THEN** the README identifies the stable top-level boundaries for backend, database, environment configuration, Docker Compose local development, OpenTofu Azure infrastructure, and spec-driven governance assets

#### Scenario: Review API-stack layouts
- **WHEN** a developer reads the generated structure documentation
- **THEN** the README distinguishes the Python/FastAPI, Node.js/Fastify, and Go/Huma backend layouts and their database tooling

#### Scenario: Review conditional project layout
- **WHEN** a developer reads the generated structure documentation
- **THEN** the README explains that `frontend` is generated only when frontend support is selected, `functions/<worker-name>` is generated only for worker-enabled GenAI patterns, and `migration/legacy` appears only in projects created by `liftoff migrate`

#### Scenario: Understand generated file ownership
- **WHEN** a developer reads the generated structure documentation
- **THEN** the README distinguishes `liftoff.config.json` as user-owned desired state from `liftoff.manifest.json` as the CLI-owned manifest record of generated artifacts, project type, API stack, logical names, path parts, and content hashes

#### Scenario: Understand path examples as logical structure
- **WHEN** the README displays generated paths such as stack-specific backend paths or `infrastructure/opentofu/azure`
- **THEN** the documentation presents them as logical project structure while the CLI continues to generate paths using platform-correct filesystem handling on Windows, macOS, and Linux
