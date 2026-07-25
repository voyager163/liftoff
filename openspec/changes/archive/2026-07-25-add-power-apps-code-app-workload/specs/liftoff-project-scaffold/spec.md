## MODIFIED Requirements

### Requirement: Generated projects use the approved backend stack
The system SHALL generate a backend using the stack approved for a GenAI or standard API workload. GenAI projects SHALL use FastAPI, PydanticAI, Pydantic runtime configuration models, Scalar, SQLAlchemy, Alembic, PostgreSQL, Redis, Langfuse tracing hooks, and Docker-compatible runtime configuration. Standard projects SHALL use the selected approved Python/FastAPI, Node.js/Fastify, or Go/Huma API stack with its approved runtime configuration, PostgreSQL integration, migration tooling, testing framework, Scalar portal, and Docker-compatible runtime configuration. Power Apps code apps SHALL instead use the approved root React, Vite, TypeScript, and Power Apps starter and SHALL NOT receive a Liftoff API backend.

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

#### Scenario: Generate Power Apps application scaffold
- **WHEN** a developer creates a Power Apps code app
- **THEN** the generated root application uses the tested Power Apps starter stack
- **AND** it excludes Liftoff backend, database, API worker, and Scalar output

### Requirement: Generated projects use the standard folder layout
The system SHALL use the folder layout defined by the selected workload. GenAI and standard API projects SHALL place backend code under `backend`, database-related artifacts under `database`, environment configuration under `environments`, infrastructure under `infrastructure`, and optional frontend code under `frontend`; their stack-specific internal and worker rules remain unchanged. Power Apps code apps SHALL place the official application package, Vite configuration, and source tree at the project root and SHALL omit those API-oriented top-level areas.

#### Scenario: GenAI backend-only project layout
- **WHEN** a developer creates a GenAI project without a frontend
- **THEN** the generated project includes `backend/apis` and `database` folders and does not include a `frontend` folder

#### Scenario: Standard backend-only project layout
- **WHEN** a developer creates a standard project without a frontend
- **THEN** the generated project includes `backend` and `database` folders using the selected API stack's internal layout
- **AND** it does not include `frontend`, `backend/orchestration`, or `functions` folders

#### Scenario: Frontend project layout
- **WHEN** a developer creates an API workload with a frontend
- **THEN** the generated project includes a Vue 3/Tailwind frontend under `frontend` in addition to backend and database folders

#### Scenario: Power Apps root application layout
- **WHEN** a developer creates a Power Apps code app
- **THEN** the generated project contains root package and Vite files plus the starter's `src` and public assets
- **AND** it does not contain Liftoff-generated `backend`, `database`, `frontend`, `functions`, `environments`, or `infrastructure` folders

#### Scenario: Azure Functions worker layout
- **WHEN** a developer creates an Azure GenAI project for a pattern that includes generated worker support
- **THEN** the generated project includes an Azure Functions worker scaffold under `functions/<worker-name>`
- **AND** the worker scaffold includes Function app runtime files, local settings examples, trigger adapter code, tests, and documentation

#### Scenario: Cross-platform layout creation
- **WHEN** the CLI creates any workload layout on Windows, macOS, or Linux
- **THEN** the same logical folders are generated using platform-correct path handling

### Requirement: Generated projects include optional pattern-aware frontend
The system SHALL ask GenAI and standard API projects whether to generate a Vue 3/Tailwind frontend suited to the project type. GenAI frontends SHALL remain suited to the selected GenAI pattern; standard frontends SHALL provide a generic API starter that uses the selected stack's common API contract. Power Apps code apps SHALL use their root React application as the workload and SHALL NOT ask the optional API-frontend question or generate a nested `frontend` project.

#### Scenario: Frontend selected for RAG
- **WHEN** a developer selects the RAG pattern and chooses to include a frontend
- **THEN** the generated frontend provides a retrieval/search starter experience that can call the generated backend API

#### Scenario: Frontend selected for standard API
- **WHEN** a developer creates a standard project and chooses to include a frontend
- **THEN** the generated frontend provides a generic API starter without GenAI pattern language or AI-specific controls

#### Scenario: Frontend omitted
- **WHEN** a developer chooses not to include a frontend for an API workload
- **THEN** the generated project remains API-first and still includes Scalar for backend API exploration

#### Scenario: Power Apps does not create a nested frontend
- **WHEN** a Power Apps code app is generated
- **THEN** its React application is generated at the project root
- **AND** no optional frontend decision or nested Liftoff Vue frontend is present

### Requirement: Generated projects include local Docker Compose development
The system SHALL generate Docker Compose local development configuration for GenAI and standard API workloads, covering their applicable backend, PostgreSQL, Redis, Azurite, Mailpit, and optional frontend services. GenAI projects SHALL use pgvector when required and include the optional Langfuse profile; standard projects SHALL omit Langfuse. Power Apps code apps SHALL use the official Vite and Power Apps local workflow and SHALL NOT receive Liftoff Docker Compose output.

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

#### Scenario: Power Apps omits Docker Compose
- **WHEN** a Power Apps code app is generated
- **THEN** no Liftoff Dockerfile or Docker Compose file is generated
- **AND** its documentation identifies the official local Code Apps command instead

### Requirement: Generated projects include environment-specific configuration
The system SHALL generate selected dev, test, and prod configuration templates for GenAI and standard API application runtime, applicable Azure Functions workers, local development, and infrastructure. Power Apps code apps SHALL not generate those API environment templates or invent Power Platform environment configuration.

#### Scenario: Generate selected environments
- **WHEN** a developer selects dev, test, and prod environments for an API workload
- **THEN** the generated project includes environment-specific configuration files for all selected environments

#### Scenario: Generate Function worker settings templates
- **WHEN** the generated project includes Azure Functions workers
- **THEN** each selected environment includes Function worker settings templates separate from backend API settings

#### Scenario: Protect secrets
- **WHEN** environment configuration templates are generated
- **THEN** the generated files avoid committed secret values and provide placeholders or secret references instead

#### Scenario: Power Apps environment remains unbound
- **WHEN** a Power Apps code app is generated
- **THEN** Liftoff emits no API environment folders and no fabricated Power Platform environment identifier

### Requirement: Packaged README documents generated project structure
The system SHALL document workload-specific generated project structures through the public root README's overview and linked packaged documentation. The detailed documentation SHALL cover stable and conditional GenAI and standard API folders, the Power Apps root application layout, stack-specific internals, and the ownership model for generated configuration, manifest, official-framework, and upstream starter files.

#### Scenario: Review API project layout
- **WHEN** a developer follows the generated-structure documentation for GenAI or standard API workloads
- **THEN** it identifies backend, database, API environment, Docker Compose, applicable OpenTofu infrastructure, optional frontend, and spec-driven boundaries

#### Scenario: Review Power Apps project layout
- **WHEN** a developer follows the generated-structure documentation for Power Apps
- **THEN** it identifies the root official starter application, dependency metadata, Liftoff metadata, framework output, and omitted API-oriented folders

#### Scenario: Review conditional project layout
- **WHEN** the documentation describes conditional output
- **THEN** it explains that API `frontend` and GenAI `functions` are conditional, migration output is migration-only, and Power Apps uses neither API layout

#### Scenario: Understand generated file ownership
- **WHEN** a developer reads the generated structure documentation
- **THEN** it distinguishes user-owned desired state, the CLI-owned manifest, named Liftoff artifacts, framework-owned output, and attributed upstream starter files

#### Scenario: Understand path examples as logical structure
- **WHEN** documentation displays generated paths
- **THEN** it presents them as logical project structure while the CLI continues to generate paths using platform-correct filesystem handling on Windows, macOS, and Linux

### Requirement: Generated language stacks include complete dependency metadata
The system SHALL emit all deterministic dependency metadata required for every freshly generated workload to execute its documented install, build, lint, and test commands without a preparatory dependency-manifest rewrite.

#### Scenario: Fresh Go project tests without editing module metadata
- **WHEN** a standard Go project is generated and dependencies are downloaded
- **THEN** `go test ./...` succeeds without requiring `go mod tidy`, `go get`, or an unrecorded `go.sum` mutation

#### Scenario: Go checksums are tracked as a generated artifact
- **WHEN** the Go stack is rendered
- **THEN** its pinned `go.sum` content is recorded under an append-only logical name in `liftoff.manifest.json`

#### Scenario: Fresh Node and Python stacks retain their build contracts
- **WHEN** representative Node.js and Python projects are freshly generated
- **THEN** their documented dependency installation, build, and test commands continue to succeed

#### Scenario: Fresh Power Apps project has a tested lockfile
- **WHEN** a Power Apps code app is freshly generated
- **THEN** its root package and lockfile identities match
- **AND** `npm ci`, lint, and production build succeed without rewriting package metadata

### Requirement: Generated documentation explains workstation and framework readiness
The system SHALL generate workload-specific project documentation that identifies the selected spec workflow, all configured coding agents, the default agent when applicable, framework-owned directories, applicable deferred advisory tools, and exact dependency, validation, and next-step commands.

#### Scenario: Read configured workflow documentation
- **WHEN** a developer opens the generated project README
- **THEN** it names every configured agent and explains how to start the selected official spec workflow

#### Scenario: Read deferred API-tool guidance
- **WHEN** an API workload completed after an advisory Docker, OpenTofu, or Azure CLI requirement was declined
- **THEN** completion and generated setup guidance provide the exact readiness remedy without claiming the tool was installed

#### Scenario: Read Power Apps next steps
- **WHEN** a developer opens a generated Power Apps project README
- **THEN** it documents root dependency installation, local development, `npx --no-install power-apps init`, optional plugin guidance, and the selected spec workflow

#### Scenario: Read project dependency commands
- **WHEN** a developer declines project dependency installation
- **THEN** the generated README contains the same workload-specific install command printed by Liftoff

## REMOVED Requirements

### Requirement: Generated projects include a v3 Liftoff manifest
**Reason**: New projects require schema v4 to represent a discriminated workload without fabricating API and cloud fields for Power Apps code apps.

**Migration**: The new CLI continues reading v2 and v3 manifests, normalizes them to GenAI or standard workload identity, and writes schema v4 only for new projects or after a successful update apply.

## ADDED Requirements

### Requirement: Generated projects include a v4 Liftoff manifest
The system SHALL include `liftoff.manifest.json` at the root of every generated project using manifest schema v4. It SHALL record generating CLI version, discriminated workload identity, selected spec workflow, selected coding agents, applicable default agent, tested framework contract, optional workload preferences, and every durable Liftoff-generated artifact with logical name, category, OS-neutral path parts, and `sha256:` content hash. Framework-owned output and seed content SHALL remain outside durable hash ownership.

#### Scenario: Manifest accompanies every initialized workload
- **WHEN** a developer initializes a GenAI, standard API, or Power Apps project
- **THEN** the project root contains a schema-v4 manifest with exactly the workload fields applicable to that project

#### Scenario: Manifest validates against generated files
- **WHEN** `liftoff validate` runs against a freshly initialized project
- **THEN** validation confirms every manifest artifact and declared framework integration marker exists on disk

#### Scenario: Power Apps manifest omits API identity
- **WHEN** a Power Apps code app is initialized
- **THEN** its v4 workload identity records the pinned starter source and plugin preference
- **AND** it does not invent an API stack, GenAI pattern, cloud, region, API frontend flag, or API environments

#### Scenario: Framework and seed ownership remains external
- **WHEN** an official framework initializer or Liftoff seed writes content
- **THEN** those files are validated by their declared contracts without being added to the durable Liftoff artifact hash list
