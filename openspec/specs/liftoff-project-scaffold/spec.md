## Purpose

Define the generated GenAI application scaffold produced by Liftoff, including the approved backend stack, optional frontend, local development services, and pattern-specific output.

## Requirements

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

### Requirement: Generated projects support all GenAI patterns
The system SHALL generate pattern-aware backend scaffolds for RAG, chatbot/conversational AI, agent-based, prompt-based app, multi-agent system, fine-tuned model app, real-time/streaming AI, and AI workflow/pipeline applications.

#### Scenario: Generate RAG scaffold
- **WHEN** a developer selects the RAG pattern
- **THEN** the generated project includes retrieval orchestration, prompt templates, ingestion worker structure, embedding pipeline structure, PostgreSQL pgvector integration points, and document storage configuration

#### Scenario: Generate chatbot scaffold
- **WHEN** a developer selects the chatbot/conversational AI pattern
- **THEN** the generated project includes conversation routes, message persistence structure, prompt templates, and PydanticAI orchestration for conversational turns

#### Scenario: Generate agent-based scaffold
- **WHEN** a developer selects the agent-based pattern
- **THEN** the generated project includes agent orchestration, tool boundary structure, task execution routes, and worker structure when background execution is part of the scaffold

#### Scenario: Generate prompt-based scaffold
- **WHEN** a developer selects the prompt-based app pattern
- **THEN** the generated project includes named prompt template structure, invocation routes, and structured output validation examples

#### Scenario: Generate multi-agent scaffold
- **WHEN** a developer selects the multi-agent system pattern
- **THEN** the generated project includes coordination structure, agent role folders, shared state boundaries, and run orchestration routes

#### Scenario: Generate fine-tuned model scaffold
- **WHEN** a developer selects the fine-tuned model app pattern
- **THEN** the generated project includes deployed model endpoint configuration, invocation routes, and evaluation dataset structure

#### Scenario: Generate streaming scaffold
- **WHEN** a developer selects the real-time/streaming AI pattern
- **THEN** the generated project includes streaming response routes and frontend-compatible streaming configuration

#### Scenario: Generate workflow scaffold
- **WHEN** a developer selects the AI workflow/pipeline pattern
- **THEN** the generated project includes pipeline stage structure, run persistence structure, trigger configuration, and worker structure

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

### Requirement: Generated projects use local service substitutes behind stable interfaces
The system SHALL configure cloud services and local substitutes behind stable application interfaces so local development can run without Azure dependencies.

#### Scenario: Local messaging substitute
- **WHEN** the generated project runs in local development mode
- **THEN** the application uses Redis Streams through the messaging interface instead of requiring Azure Service Bus

#### Scenario: Cloud messaging configuration
- **WHEN** the generated project runs with Azure cloud configuration
- **THEN** the application uses Azure Service Bus through the same messaging interface

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

### Requirement: Generated worker-enabled Azure projects include Azure Functions trigger adapters
The system SHALL generate Azure Functions trigger adapter scaffolds for worker-enabled GenAI patterns while keeping reusable GenAI orchestration code under the backend orchestration layer.

#### Scenario: Generate Function worker for worker-enabled pattern
- **WHEN** a developer creates an Azure project for a pattern whose catalog definition includes worker support
- **THEN** the generated project includes a deterministic Azure Functions worker folder under `functions`
- **AND** the generated worker adapter references the selected pattern and its messaging boundary

#### Scenario: Omit Function worker for non-worker pattern
- **WHEN** a developer creates an Azure project for a pattern whose catalog definition does not include worker support
- **THEN** the generated project does not include an Azure Functions worker scaffold

#### Scenario: Track Function worker artifacts in manifest
- **WHEN** Azure Functions worker artifacts are generated
- **THEN** `liftoff.manifest.json` includes each Function artifact using path parts rather than platform-specific path strings

### Requirement: Generated documentation distinguishes backend workers from Azure Functions workers
The system SHALL document that `backend/workers` is for backend-adjacent or containerized worker code and `functions/<worker-name>` is for Azure Functions trigger adapters and Function app runtime files.

#### Scenario: Review generated project documentation
- **WHEN** a developer reads the generated project README or functions documentation
- **THEN** the documentation explains where to place Azure Functions workers and where to place reusable orchestration logic

### Requirement: Generated projects include a v5 Liftoff manifest
The system SHALL include `liftoff.manifest.json` at the root of every generated project using manifest schema v5. It SHALL record generating CLI version, discriminated workload identity, selected spec workflow, selected coding agents, applicable default agent, tested framework contract, repository-governance profile and handoff state, optional workload preferences, and every durable Liftoff-generated artifact with logical name, category, OS-neutral path parts, and `sha256:` content hash. Framework-owned output and one-time seed content SHALL remain outside durable hash ownership.

#### Scenario: Manifest accompanies every initialized workload
- **WHEN** a developer initializes a GenAI, standard API, or Power Apps project
- **THEN** the project root contains a schema-v5 manifest with exactly the workload and governance fields applicable to that project

#### Scenario: Manifest validates against generated files
- **WHEN** `liftoff validate` runs against a freshly initialized project
- **THEN** validation confirms every manifest artifact and declared framework integration marker exists on disk

#### Scenario: Enabled governance records only handoff state
- **WHEN** a project enables `single-maintainer-gitflow`
- **THEN** its v5 manifest records the profile, policy version, and `handoff-generated` state
- **AND** it does not claim live GitHub enforcement

#### Scenario: Disabled governance omits handoff artifacts
- **WHEN** a project selects `none`
- **THEN** its v5 manifest records governance as disabled
- **AND** contains no governance policy, context, guide, or launcher artifact entry

#### Scenario: Power Apps manifest omits API identity
- **WHEN** a Power Apps code app is initialized
- **THEN** its v5 workload identity records the pinned starter source and plugin preference
- **AND** it does not invent an API stack, GenAI pattern, cloud, region, API frontend flag, or API environments

#### Scenario: Framework and seed ownership remains external
- **WHEN** an official framework initializer or Liftoff seed writes content
- **THEN** those files are validated by their declared contracts without being added to the durable Liftoff artifact hash list
- **AND** the separate repository-governance handoff remains durably hash-managed by exact logical name

### Requirement: Governance handoff participates in transactional staging
Enabled governance artifacts SHALL be rendered into the same temporary staging area, assigned explicit ownership, validated, preflighted, and merged under the same collision, symlink, authorization, lock, and rollback contract as other durable Liftoff files.

#### Scenario: Governance launcher collides with a file
- **WHEN** an existing target contains different bytes at an enabled governance launcher path
- **THEN** initialization reports that exact regular-file replacement
- **AND** does not overwrite it without the existing interactive authorization or `--force`

#### Scenario: Governance path is structurally unsafe
- **WHEN** a destination ancestor is a symlink, non-directory, or resolves outside the target
- **THEN** initialization stops before any destination mutation

#### Scenario: Merge fails after writing governance files
- **WHEN** a later staged artifact cannot be merged
- **THEN** rollback removes or restores Liftoff-owned governance writes under the existing transaction contract

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

### Requirement: Generated GenAI orchestration is executable and explicit about configuration
The system SHALL generate a minimal PydanticAI-backed orchestration path for each GenAI scaffold rather than returning a successful placeholder result. The generated path MUST support offline tests through model injection or PydanticAI test models, and missing production model configuration MUST produce an explicit configuration error.

#### Scenario: Generated agent uses PydanticAI
- **WHEN** a GenAI project is generated
- **THEN** its orchestration module imports and constructs the approved PydanticAI agent boundary used by its API route

#### Scenario: Generated orchestration test stays offline
- **WHEN** the generated backend test suite runs without cloud model credentials
- **THEN** it exercises the agent contract through an injected or test model and performs no network model request

#### Scenario: Missing model configuration is not a fake success
- **WHEN** a generated application invokes production orchestration without required model configuration
- **THEN** it returns or raises a clear configuration failure instead of a placeholder answer presented as successful output

### Requirement: Generated messaging adapters perform the selected transport operation
The system SHALL generate Redis Streams and Azure Service Bus implementations behind the shared messaging interface. Redis publishing MUST append the payload to the configured stream, Azure publishing MUST send the payload to the configured queue or topic, and both implementations MUST be testable with injected clients.

#### Scenario: Local publisher appends to Redis Streams
- **WHEN** local configuration selects `redis-streams` and orchestration publishes a message
- **THEN** the generated adapter issues an `XADD`-equivalent operation with the configured stream and serialized payload

#### Scenario: Cloud publisher sends to Azure Service Bus
- **WHEN** cloud configuration selects `azure-service-bus` and orchestration publishes a message
- **THEN** the generated adapter sends the serialized payload through the configured asynchronous Service Bus sender

#### Scenario: Messaging tests require no external service
- **WHEN** the generated messaging unit tests run
- **THEN** injected fake clients verify the Redis and Azure operations without requiring Redis or Azure credentials

### Requirement: Generated observability reflects actual tracing state
The system SHALL generate a tracing boundary that initializes Langfuse when valid configuration is present and otherwise reports tracing as disabled. It MUST NOT emit a successful-looking remote trace identifier when no trace was sent.

#### Scenario: Configured tracing creates a Langfuse operation
- **WHEN** valid Langfuse configuration is present and a GenAI operation runs
- **THEN** the generated tracing boundary records the operation through the Langfuse client

#### Scenario: Unconfigured tracing is explicitly disabled
- **WHEN** Langfuse configuration is absent
- **THEN** the operation proceeds through an explicit disabled tracer without claiming that a remote trace exists

### Requirement: Generated frontends call the generated backend contract
The system SHALL generate a frontend starter that invokes the selected backend route through a configurable API base URL and exposes observable loading, success, and failure states. Generated source MUST safely encode project-derived text and MUST remain buildable without a running backend.

#### Scenario: Starter submits input to the backend
- **WHEN** a developer enters starter input and activates the generated action
- **THEN** the frontend calls the selected generated API route and displays the response

#### Scenario: Starter reports backend failure
- **WHEN** the generated backend request fails or returns a non-success status
- **THEN** the frontend clears its loading state and displays an actionable error

#### Scenario: Frontend build remains offline
- **WHEN** the generated frontend dependency install and production build run
- **THEN** the build succeeds without contacting a generated backend

### Requirement: Generated language stacks include complete dependency metadata
The system SHALL emit all deterministic dependency metadata required for every freshly generated workload to execute its documented install, build, lint, and test commands without a preparatory dependency-manifest rewrite. npm projects SHALL include tested lockfiles, Python projects SHALL include tracked `uv.lock` files and frozen synchronization commands, Go projects SHALL include complete module checksums, and Azure Functions dependency exports SHALL be reproducible from the corresponding locked Python graph.

#### Scenario: Fresh Go project tests without editing module metadata
- **WHEN** a standard Go project is generated and dependencies are downloaded
- **THEN** `go test ./...` succeeds without requiring `go mod tidy`, `go get`, or an unrecorded `go.sum` mutation

#### Scenario: Go checksums are tracked as a generated artifact
- **WHEN** the Go stack is rendered
- **THEN** its pinned `go.sum` content is recorded under an append-only logical name in `liftoff.manifest.json`

#### Scenario: Fresh Node and Python stacks retain their build contracts
- **WHEN** representative Node.js and Python projects are freshly generated
- **THEN** their documented dependency installation, build, and test commands continue to succeed

#### Scenario: Fresh Node stack retains its build contract
- **WHEN** a representative Node.js project is freshly generated
- **THEN** its documented `npm ci`, build, and test commands succeed
- **AND** package metadata remains byte-for-byte unchanged

#### Scenario: Fresh Python stack installs from a frozen lock
- **WHEN** a representative Python project is freshly generated
- **THEN** its documented `uv sync --frozen` command succeeds from the tracked lock
- **AND** build and test commands use the synchronized project environment without changing dependency metadata

#### Scenario: Fresh Power Apps project has a tested lockfile
- **WHEN** a Power Apps code app is freshly generated
- **THEN** its root package and lockfile identities match
- **AND** `npm ci`, lint, and production build succeed without rewriting package metadata

#### Scenario: Generate dependency paths across platforms
- **WHEN** the same project is rendered on Windows, macOS, and Linux
- **THEN** each lock or dependency artifact uses the same logical name and path-part array
- **AND** platform-specific execution commands resolve the project environment without hardcoded path separators

### Requirement: Selected spec workflows are initialized through their official CLI
The system SHALL create complete spec-driven framework infrastructure by running the exact tested official OpenSpec or Spec Kit CLI in the staged project. For OpenSpec, Liftoff SHALL require the `custom` profile with `both` delivery and the explicit workflow set `propose`, `explore`, `new`, `continue`, `apply`, `update`, `ff`, `sync`, `archive`, `bulk-archive`, `verify`, and `onboard`. Liftoff SHALL validate the selected profile, framework markers, and integration output before committing the staged tree and SHALL NOT substitute a partial hand-written framework layout when the official command fails.

#### Scenario: Initialize OpenSpec officially
- **WHEN** a developer initializes a project with the OpenSpec workflow
- **THEN** Liftoff verifies the required global profile and runs the pinned OpenSpec initializer with the `custom` profile and every selected agent identifier in the staging root
- **AND** the committed project contains official skills and commands for all 12 required workflows for every selected agent surface that supports them

#### Scenario: Fresh OpenSpec output has no immediate profile drift
- **WHEN** a developer reruns the pinned OpenSpec initializer on a fresh Liftoff project without changing the selected tools, global OpenSpec profile, delivery, or cloud-agent preference
- **THEN** OpenSpec does not require a legacy upgrade or replace workflow files merely to align the project with the required profile

#### Scenario: Initialize Spec Kit officially
- **WHEN** a developer initializes a project with the Spec Kit workflow
- **THEN** Liftoff runs the pinned Spec Kit initializer in the staging root using the selected default agent
- **AND** it installs and validates every additional selected integration through the official integration command

#### Scenario: Official initializer failure prevents project commit
- **WHEN** the selected framework CLI exits unsuccessfully or omits any required profile or integration marker
- **THEN** Liftoff exits unsuccessfully and leaves the destination unchanged
- **AND** it does not fall back to Liftoff's former partial templates

### Requirement: GitHub Copilot cloud-agent output is an explicit OpenSpec choice
The system SHALL treat the GitHub-hosted Copilot coding-agent integration as a default-off OpenSpec option. When applicable, Liftoff SHALL pass an explicit opt-in or opt-out to the official initializer and SHALL preserve the same `githubCopilot.cloudAgent` value in its write-once `openspec/config.yaml` overlay.

#### Scenario: Generate cloud-agent files after opt-in
- **WHEN** OpenSpec and GitHub Copilot are selected and the developer opts into the Copilot cloud coding agent
- **THEN** the staged output contains `.github/workflows/copilot-setup-steps.yml` and `.github/agents/openspec.agent.md`
- **AND** the final OpenSpec config records `githubCopilot.cloudAgent: true`

#### Scenario: Keep cloud-agent files absent after opt-out
- **WHEN** OpenSpec and GitHub Copilot are selected and the developer declines or explicitly disables the Copilot cloud coding agent
- **THEN** neither cloud-agent file is generated
- **AND** the final OpenSpec config records `githubCopilot.cloudAgent: false`

#### Scenario: Liftoff overlay preserves the official initializer decision
- **WHEN** Liftoff writes workload context and rules to `openspec/config.yaml` after official initialization
- **THEN** it retains the resolved cloud-agent preference instead of replacing it with a config that omits or changes the preference

### Requirement: Projects support GitHub Copilot and Claude Code together
The system SHALL configure the selected spec workflow for GitHub Copilot, Claude Code, or both. It SHALL map Liftoff's normalized agent identifiers to framework-owned integration identifiers and SHALL preserve the selected Spec Kit default while adding secondary integrations.

#### Scenario: Configure both agents for OpenSpec
- **WHEN** OpenSpec is selected with Copilot and Claude Code
- **THEN** the official initializer receives both tool identifiers in stable order
- **AND** the project contains valid integration output for both

#### Scenario: Configure both agents for Spec Kit
- **WHEN** Spec Kit is selected with Copilot as default and Claude Code as secondary
- **THEN** the official initializer creates Copilot's supported skills-based integration
- **AND** the official integration command installs Claude Code without changing the Copilot default

#### Scenario: Configure Copilot as a secondary Spec Kit integration
- **WHEN** Spec Kit is selected with Claude Code as default and Copilot as secondary
- **THEN** the Copilot integration is installed using the tested skills option rather than deprecated agent-file output

### Requirement: Framework output has an explicit ownership boundary
The system SHALL distinguish Liftoff durable artifacts, framework-owned output, and write-once seed or overlay content. Liftoff SHALL hash and reconcile only its named durable artifacts, SHALL validate declared framework markers without adopting all framework files, and SHALL never delete or overwrite framework-owned files through pattern-based reconciliation.

#### Scenario: Update excludes framework-owned core files
- **WHEN** a framework CLI created scripts, commands, skills, or core templates that are not named Liftoff durable artifacts
- **THEN** plain `liftoff update` does not overwrite or delete those files

#### Scenario: Validation checks framework integration markers
- **WHEN** `liftoff validate` runs on a new project
- **THEN** it verifies every Liftoff durable artifact and the declared framework and selected-agent markers
- **AND** it does not require a Liftoff content hash for framework-owned files

#### Scenario: Liftoff seed content is not reconciled
- **WHEN** Liftoff writes an initial OpenSpec change, constitution, or supported framework configuration overlay
- **THEN** the content is available in the new project but is not treated as a normal update-managed template artifact

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

### Requirement: Generated local services and runtime images are immutable
The system SHALL render each Dockerfile base and Docker Compose service image from an explicit supported-stack baseline entry containing a stable release tag and immutable multi-architecture manifest digest. Generated output SHALL NOT use `latest`, an unqualified image name, or a mutable major-only reference.

#### Scenario: Inspect generated Compose images
- **WHEN** a GenAI or standard API project is generated
- **THEN** PostgreSQL or pgvector, Redis, Azurite, Mailpit, and applicable Langfuse image references are bound to tested immutable digests

#### Scenario: Inspect generated runtime stages
- **WHEN** a Python, Node.js, Go, or frontend container file is rendered
- **THEN** every base stage is bound to the runtime and operating-system image digest recorded by the baseline

#### Scenario: Baseline image lacks a host architecture
- **WHEN** an image refresh does not expose every architecture required by the supported generated-project matrix
- **THEN** baseline verification fails before the image reference can be packaged
