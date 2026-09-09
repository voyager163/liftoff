## MODIFIED Requirements

### Requirement: Generated projects use the approved backend stack
The system SHALL generate a backend using the stack approved for a GenAI or standard API workload. GenAI projects SHALL use FastAPI, PydanticAI, Pydantic runtime configuration models, Scalar, SQLAlchemy, Alembic, PostgreSQL, Redis, Langfuse tracing hooks, and Docker-compatible runtime configuration. Standard projects SHALL use the selected approved Python/FastAPI, Node.js/Fastify, or Go/Huma API stack with its approved runtime configuration, PostgreSQL integration, migration tooling, testing framework, Scalar portal, and Docker-compatible runtime configuration. Liftoff SHALL NOT generate a Power Apps application scaffold or reinterpret a retired Power Apps selection as an API workload.

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
- **WHEN** a developer selects or passes `power-apps-code-app` after Power Apps retirement
- **THEN** Liftoff reports the retired workload before scaffold generation
- **AND** it generates neither an API backend nor a substitute root application

### Requirement: Generated projects use the standard folder layout
The system SHALL use the folder layout defined by the selected supported workload. GenAI and standard API projects SHALL place backend code under `backend`, database-related artifacts under `database`, environment configuration under `environments`, infrastructure under `infrastructure`, and optional frontend code under `frontend`; Azure OpenTofu environments SHALL use explicit roots under `infrastructure/opentofu/azure/environments/<environment>` with the shared application module under `infrastructure/opentofu/azure/modules/application`; their stack-specific internal and worker rules remain unchanged. Liftoff SHALL NOT generate a retired Power Apps root layout.

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

#### Scenario: Azure Functions worker layout
- **WHEN** a developer creates an Azure GenAI project for a pattern that includes generated worker support
- **THEN** the generated project includes an Azure Functions worker scaffold under `functions/<worker-name>`
- **AND** the worker scaffold includes Function app runtime files, local settings examples, trigger adapter code, tests, and documentation

#### Scenario: Cross-platform layout creation
- **WHEN** the CLI creates any supported workload layout on Windows, macOS, or Linux
- **THEN** the same logical folders are generated using platform-correct path handling

#### Scenario: Power Apps root application layout
- **WHEN** a developer requests the retired Power Apps workload
- **THEN** Liftoff creates no root starter layout for that workload
- **AND** it does not substitute the API folder layout automatically

### Requirement: Generated projects support all GenAI patterns
The system SHALL preserve the nine supported GenAI pattern identifiers: generic/undecided GenAI application, RAG, chatbot/conversational AI, agent-based, prompt-based app, multi-agent system, fine-tuned model app, real-time/streaming AI, and AI workflow/pipeline applications. It SHALL generate a pattern-aware backend scaffold for each. Each scaffold SHALL expose only the runtime behavior, configuration, and artifacts actually implemented by the selected release. Generated code, manifests, and documentation MUST label deferred specialization honestly instead of implying retrieval, chat history, tool execution, multi-agent coordination, workflow execution, fine-tuning, or incremental streaming where those behaviors are absent. The generic scaffold SHALL contain the common GenAI runtime and a neutral invocation boundary without indirectly enabling specialized storage or worker components.

#### Scenario: Generate generic GenAI scaffold
- **WHEN** a developer selects the generic pattern
- **THEN** the generated project includes a neutral FastAPI invocation route, PydanticAI runner, generic system prompt, tracing boundary, and offline test
- **AND** it excludes retrieval and pgvector, ingestion or task workers, chat persistence, specialized agent tools, streaming transport, fine-tuning datasets, and workflow-specific output

#### Scenario: Generate RAG scaffold
- **WHEN** a developer selects the RAG pattern
- **THEN** the generated project includes a knowledge-ingestion or publication path, prompt templates, messaging configuration, and document storage configuration suited to the generated starter
- **AND** generated code and documentation label retrieval, citations, and long-lived history as deferred where they are not implemented

#### Scenario: Generate chatbot scaffold
- **WHEN** a developer selects the chatbot/conversational AI pattern
- **THEN** the generated project includes conversation-oriented routes, prompt templates, and PydanticAI orchestration for turn handling
- **AND** generated code and documentation label persisted chat history as deferred where it is not implemented

#### Scenario: Generate agent-based scaffold
- **WHEN** a developer selects the agent-based pattern
- **THEN** the generated project includes agent orchestration boundaries and task execution routes
- **AND** generated code and documentation label external tool execution and autonomous coordination as deferred where they are not implemented

#### Scenario: Generate prompt-based scaffold
- **WHEN** a developer selects the prompt-based app pattern
- **THEN** the generated project includes named prompt template structure, invocation routes, and structured output validation examples
- **AND** it distinguishes those examples from deferred runtime prompt selection, template loading, or specialized model-output behavior

#### Scenario: Generate multi-agent scaffold
- **WHEN** a developer selects the multi-agent system pattern
- **THEN** the generated project includes role-oriented structure and run orchestration entrypoints
- **AND** generated code and documentation label inter-agent coordination and shared execution state as deferred where they are not implemented

#### Scenario: Generate fine-tuned model scaffold
- **WHEN** a developer selects the fine-tuned model app pattern
- **THEN** the generated project includes deployed model endpoint configuration and invocation routes
- **AND** generated code and documentation label fine-tuning dataset preparation and training workflows as deferred where they are not implemented

#### Scenario: Generate streaming scaffold
- **WHEN** a developer selects the real-time/streaming AI pattern
- **THEN** the generated project includes a buffered SSE-compatible response route and frontend-compatible configuration
- **AND** generated code and documentation label incremental token streaming as deferred where it is not implemented

#### Scenario: Generate workflow scaffold
- **WHEN** a developer selects the AI workflow/pipeline pattern
- **THEN** the generated project includes stage-oriented structure and run or trigger entrypoints
- **AND** generated code and documentation label durable workflow execution and stage persistence as deferred where they are not implemented

### Requirement: Generated projects include optional pattern-aware frontend
The system SHALL ask GenAI and standard API projects whether to generate a Vue 3/Tailwind frontend suited to the project type. Generic GenAI frontends SHALL provide a neutral prompt playground. Specialized GenAI frontends SHALL align with the generated backend capability that actually exists and SHALL label deferred retrieval, history, tools, coordination, fine-tuning, or incremental streaming capabilities rather than implying they are implemented. Standard frontends SHALL provide a generic API starter that uses the selected stack's common API contract.

#### Scenario: Frontend selected for generic GenAI
- **WHEN** a developer selects the generic GenAI pattern and chooses to include a frontend
- **THEN** the generated frontend provides a neutral text-input playground that calls the generic invocation route
- **AND** it contains no RAG, chatbot, agent, streaming, fine-tuning, or workflow claims

#### Scenario: Frontend selected for RAG
- **WHEN** a developer selects the RAG pattern and chooses to include a frontend
- **THEN** the generated frontend provides a knowledge-base starter experience that calls the generated backend API
- **AND** it explicitly identifies any deferred retrieval or citation automation instead of implying those behaviors already exist

#### Scenario: Frontend selected for standard API
- **WHEN** a developer creates a standard project and chooses to include a frontend
- **THEN** the generated frontend provides a generic API starter without GenAI pattern language or AI-specific controls

#### Scenario: Frontend omitted
- **WHEN** a developer chooses not to include a frontend for an API workload
- **THEN** the generated project remains API-first and still includes Scalar for backend API exploration

#### Scenario: Power Apps does not create a nested frontend
- **WHEN** a developer requests the retired Power Apps workload
- **THEN** Liftoff generates no nested frontend and no supported root React workload scaffold
- **AND** it reports the workload as retired instead of presenting frontend choices

### Requirement: Generated projects include local Docker Compose development
The system SHALL generate Docker Compose local development configuration for GenAI and standard API workloads, covering their applicable backend, PostgreSQL, Redis, Azurite, Mailpit, and optional frontend services. Docker Compose recipes SHALL pass the same documented model, messaging, and tracing configuration contract used by native startup while retaining correct container service addresses. GenAI projects SHALL use pgvector only when the selected pattern requires it and SHALL include the optional Langfuse profile where applicable. Standard projects SHALL omit Langfuse and pgvector.

#### Scenario: Start standard local stack
- **WHEN** a generated standard project runs its default local Docker Compose command
- **THEN** the selected backend runtime, PostgreSQL, Redis, Azurite, and Mailpit services are available for local development
- **AND** no Langfuse service or pgvector image is required

#### Scenario: Start GenAI default local stack
- **WHEN** a generated GenAI project runs its default local Docker Compose command
- **THEN** the backend, PostgreSQL or PostgreSQL/pgvector as required by the selected pattern, Redis, Azurite, and Mailpit services are available for local development
- **AND** a generic GenAI project does not require a pgvector image or worker-only service

#### Scenario: Start GenAI observability profile
- **WHEN** a developer runs the generated GenAI Docker Compose command with the observability profile
- **THEN** Langfuse services are included in the local stack

#### Scenario: Compose preserves the selected configuration contract
- **WHEN** a developer supplies process-environment overrides or selects a documented project configuration file before starting the generated app natively or through Docker Compose
- **THEN** both startup paths resolve the same model, messaging, tracing, and readiness settings
- **AND** Docker Compose substitutes only the container-reachable service addresses required for local networking

#### Scenario: Power Apps omits Docker Compose
- **WHEN** a developer requests the retired Power Apps workload
- **THEN** Liftoff generates no Liftoff Dockerfile or Docker Compose file for that request
- **AND** it reports the workload as retired instead of claiming a supported local Code Apps workflow

### Requirement: Generated projects include environment-specific configuration
The system SHALL generate selected dev, staging, and prod configuration templates for GenAI and standard API application runtime, applicable Azure Functions workers, local development, and infrastructure. Supplied process environment MUST override the documented selected project configuration file, and that file MUST override nonsecret defaults. Backend, worker, messaging, tracing, readiness, and container launch consumers SHALL use the same resolved configuration contract. Retired Power Apps workloads SHALL not generate API environment templates or invented Power Platform environment configuration.

#### Scenario: Generate selected environments
- **WHEN** a developer selects dev, staging, and prod environments for an API workload
- **THEN** the generated project includes environment-specific configuration files for all selected environments

#### Scenario: Generate Function worker settings templates
- **WHEN** the generated project includes Azure Functions workers
- **THEN** each selected environment includes Function worker settings templates separate from backend API settings

#### Scenario: Protect secrets
- **WHEN** environment configuration templates are generated
- **THEN** the generated files avoid committed secret values and provide placeholders or secret references instead

#### Scenario: Process environment overrides the selected configuration
- **WHEN** a developer sets a supported runtime or messaging value both in process environment and in the selected project configuration file
- **THEN** the generated application uses the process-environment value
- **AND** generated documentation describes that precedence explicitly

#### Scenario: Native and Compose startup resolve the same selected configuration
- **WHEN** a developer starts a generated application natively and through Docker Compose using the same selected project configuration file
- **THEN** both startup paths resolve the same nonsecret defaults and file-backed settings
- **AND** they do not disagree because different consumers reread configuration independently

#### Scenario: Power Apps environment remains unbound
- **WHEN** a developer requests the retired Power Apps workload or Liftoff inspects a retired Power Apps manifest for rejection
- **THEN** Liftoff emits no API environment folders and no fabricated Power Platform environment identifier
- **AND** it reports the workload as retired

### Requirement: Generated projects include a v7 Liftoff manifest
The system SHALL include `liftoff.manifest.json` at the root of every generated GenAI or standard API project using manifest schema v7. It SHALL record the manifest-writing CLI version, discriminated workload identity, selected spec workflow, selected coding agents, applicable default agent, tested framework contract, repository-governance profile and handoff state, activation identity, the selected API stack or one of the nine supported GenAI pattern identifiers, applicable workload preferences, managed-core artifacts with reconciliation hashes, and project artifacts with generation provenance. Actual capability descriptions SHALL come from the release-owned catalog and applicable governance context without adding an unversioned required manifest field. Framework-owned, desired-state, and one-time seed content SHALL remain outside managed-core hash authority.

#### Scenario: Manifest accompanies every initialized workload
- **WHEN** a developer initializes a GenAI or standard API project
- **THEN** the project root contains a schema-v7 manifest with exactly the workload, governance, managed-core, and project-provenance fields applicable to that project

#### Scenario: Manifest validates against generated files
- **WHEN** `liftoff validate` runs against a freshly initialized project
- **THEN** validation confirms every managed-core artifact and declared framework integration marker while structurally validating project provenance without requiring production bytes to remain unchanged

#### Scenario: Enabled governance records only handoff state
- **WHEN** a project enables `single-maintainer-gitflow`
- **THEN** its v7 manifest records the profile, policy version, activation identity, and `handoff-generated` state
- **AND** it does not claim live GitHub enforcement

#### Scenario: Disabled governance omits handoff artifacts
- **WHEN** a project selects `none`
- **THEN** its v7 manifest records governance as disabled
- **AND** contains no managed governance policy, context, guide, or setup integration entry

#### Scenario: GenAI manifest records the selected pattern without fabricating specialization
- **WHEN** a GenAI project is initialized for any supported pattern identifier
- **THEN** the manifest records that exact pattern identity and only its applicable workload preferences
- **AND** it does not claim retrieval, history, tools, coordination, fine-tuning, or incremental streaming capabilities that the generated project does not implement

#### Scenario: Power Apps manifest omits API identity
- **WHEN** a command encounters the retired Power Apps discriminator, with or without additional API fields
- **THEN** it rejects that boundary before validating the former workload's applicable fields
- **AND** it leaves the original manifest unchanged and emits no supported Power Apps manifest

#### Scenario: Framework and seed ownership remains external
- **WHEN** an official framework initializer or Liftoff seed writes content
- **THEN** those files are validated by their declared contracts without being added to managed-core hash authority
- **AND** the separate repository-governance handoff remains managed by exact logical name

### Requirement: Packaged README documents generated project structure
The system SHALL document workload-specific generated project structures through the public root README's overview and linked packaged documentation. The detailed documentation SHALL cover stable and conditional GenAI and standard API folders, explicit Azure OpenTofu environment roots when generated, stack-specific internals, and the ownership model for generated configuration, manifest, official-framework, and separately attributed packaged assets.

#### Scenario: Review API project layout
- **WHEN** a developer follows the generated-structure documentation for GenAI or standard API workloads
- **THEN** it identifies backend, database, API environment, Docker Compose, applicable OpenTofu environment roots, optional frontend, and spec-driven boundaries

#### Scenario: Review conditional project layout
- **WHEN** the documentation describes conditional output
- **THEN** it explains that API `frontend` and GenAI `functions` are conditional, migration output is migration-only, and Azure environment roots are explicit when Azure infrastructure is selected

#### Scenario: Review Power Apps project layout
- **WHEN** a developer follows retirement guidance for the retired Power Apps workload
- **THEN** the documentation explains that Liftoff no longer generates a Power Apps starter layout
- **AND** it does not describe a supported root application scaffold for that workload

#### Scenario: Understand generated file ownership
- **WHEN** a developer reads the generated structure documentation
- **THEN** it distinguishes user-owned desired state, the CLI-owned manifest, named Liftoff artifacts, framework-owned output, and any separately attributed packaged assets present in the selected workload

#### Scenario: Understand path examples as logical structure
- **WHEN** documentation displays generated paths
- **THEN** it presents them as logical project structure while the CLI continues to generate paths using platform-correct filesystem handling on Windows, macOS, and Linux

### Requirement: Generated messaging adapters perform the selected transport operation
The system SHALL generate Redis Streams and Azure Service Bus implementations behind the shared messaging interface. Configuration resolution for both adapters MUST use the same resolved runtime configuration contract consumed by the rest of the generated application. Redis publishing MUST append the payload to the configured stream. Azure publishing MUST send the payload to the configured queue or topic using the configured namespace and selected sender credentials or identity mode. Generated RAG publication paths MUST fail clearly when required namespace, entity, or sender configuration is missing rather than returning a successful-looking ingestion result. Both implementations MUST be testable with injected clients.

#### Scenario: Local publisher appends to Redis Streams
- **WHEN** local configuration selects `redis-streams` and orchestration publishes a message
- **THEN** the generated adapter issues an `XADD`-equivalent operation with the configured stream and serialized payload

#### Scenario: Cloud publisher sends to Azure Service Bus
- **WHEN** cloud configuration selects `azure-service-bus` and orchestration publishes a message
- **THEN** the generated adapter sends the serialized payload through the configured asynchronous Service Bus sender using the resolved namespace and entity settings

#### Scenario: Missing RAG publisher configuration is not a fake success
- **WHEN** a generated RAG publication path is invoked without its required Azure Service Bus namespace, entity, or sender configuration
- **THEN** the application returns or raises a clear configuration failure
- **AND** it does not report that publication succeeded

#### Scenario: Messaging tests require no external service
- **WHEN** the generated messaging unit tests run
- **THEN** injected fake clients verify the Redis and Azure operations without requiring Redis or Azure credentials

### Requirement: Generated language stacks include complete dependency metadata
The system SHALL emit all deterministic dependency metadata required for every freshly generated supported workload to execute its documented install, build, lint, and test commands without a preparatory dependency-manifest rewrite. npm projects SHALL include tested lockfiles, Python projects SHALL include tracked `uv.lock` files and frozen synchronization commands, Go projects SHALL include complete module checksums, and Azure Functions dependency exports SHALL be reproducible from the corresponding locked Python graph.

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

#### Scenario: Fresh frontend package metadata remains unchanged
- **WHEN** a generated frontend package is freshly rendered
- **THEN** its package and lockfile identities match
- **AND** `npm ci` and production build succeed without rewriting package metadata

#### Scenario: Fresh Power Apps project has a tested lockfile
- **WHEN** a developer requests the retired Power Apps workload
- **THEN** Liftoff generates no fresh Power Apps project and no supported Power Apps package metadata
- **AND** it does not claim a tested Power Apps lockfile contract

#### Scenario: Generate dependency paths across platforms
- **WHEN** the same project is rendered on Windows, macOS, and Linux
- **THEN** each lock or dependency artifact uses the same logical name and path-part array
- **AND** platform-specific execution commands resolve the project environment without hardcoded path separators

### Requirement: Generated documentation explains workstation and framework readiness
The system SHALL generate workload-specific project documentation that identifies the selected spec workflow, all configured coding agents, the default agent when applicable, framework-owned directories, applicable deferred advisory tools, exact dependency, validation, and next-step commands, and any deferred pattern capabilities that the generated starter does not yet implement.

#### Scenario: Read configured workflow documentation
- **WHEN** a developer opens the generated project README
- **THEN** it names every configured agent and explains how to start the selected official spec workflow

#### Scenario: Read deferred API-tool guidance
- **WHEN** an API workload completed after an advisory Docker, OpenTofu, or Azure CLI requirement was declined
- **THEN** completion and generated setup guidance provide the exact readiness remedy without claiming the tool was installed

#### Scenario: Read documented pattern limits
- **WHEN** a developer opens the generated README for a specialized GenAI pattern
- **THEN** it names the generated runtime capability that exists today
- **AND** it explicitly labels deferred retrieval, history, tools, coordination, workflow execution, fine-tuning, or incremental streaming where those capabilities are not implemented

#### Scenario: Read Power Apps next steps
- **WHEN** Liftoff shows guidance after a retired Power Apps request
- **THEN** it explains that the workload is unsupported and existing application files are unchanged
- **AND** it does not present dependency installation, local development, `npx --no-install power-apps init`, or plugin guidance as supported next steps

#### Scenario: Read project dependency commands
- **WHEN** a developer declines project dependency installation
- **THEN** the generated README contains the same workload-specific install command printed by Liftoff

### Requirement: Generated manifests identify the activation contract
Governed projects SHALL use `liftoff.manifest.json` artifact version 7. Its activation vector SHALL identify the creating Liftoff semantic version, policy version 6, activation-contract version 2, phase-graph schema version 1 and its computed content hash, activation-state schema version 2, evidence-header schema version 2, approval-envelope schema version 2, and supersession and credential-policy schema versions 1. The separate compatibility document SHALL identify compatibility-metadata schema version 2 without adding an unversioned required manifest field. Managed setup integrations SHALL retain normal content hashes instead of introducing an independent skill version, and planning artifacts SHALL NOT invent future graph hashes or contract digests.

#### Scenario: Generate a governed project
- **WHEN** initialization writes the version 7 manifest and governance artifacts
- **THEN** every activation identity matches the generated policy, phase graph, schemas, and supported engine constants

#### Scenario: Setup integration wording changes
- **WHEN** only the thin setup integration bytes change
- **THEN** its managed content hash changes
- **AND** no setup-skill version changes or is introduced

## ADDED Requirements

### Requirement: Spec Kit projects receive an explicit project-owned bootstrap bundle
New supported Spec Kit projects SHALL include `spec.md`, `plan.md`, and `tasks.md` under the explicit `specs/000-liftoff-bootstrap` path. The files SHALL use the logical identities `spec-kit-bootstrap-spec`, `spec-kit-bootstrap-plan`, and `spec-kit-bootstrap-tasks` and the one-time project-owned seed lifecycle. They SHALL describe generated-project baseline preparation and local checks without claiming completed product behavior, creating Git branches, or invoking an archive. Official framework initialization markers SHALL remain separate from these seed files.

#### Scenario: Generate a Spec Kit bootstrap bundle
- **WHEN** a supported API or GenAI project is initialized with Spec Kit
- **THEN** it includes all three explicit bootstrap files alongside the official framework integration
- **AND** their tasks describe the applicable local baseline rather than completed feature implementation

#### Scenario: Bootstrap content does not acquire managed-core ownership
- **WHEN** the bundle is generated or later modified by the developer
- **THEN** its files remain project-owned seed content outside ordinary update and force authority
- **AND** no template file is presented as a completed project plan

#### Scenario: Existing project lacks the bundle
- **WHEN** an existing Spec Kit project has official initialization markers but no bootstrap bundle
- **THEN** setup reports a specific seed-adoption blocker requiring separately reviewed project work
- **AND** update, force, assessment, and read-only setup inspection do not create missing seed files or infer prior completion

#### Scenario: Generate the bootstrap path on Windows
- **WHEN** initialization runs on Windows, macOS, or Linux
- **THEN** the same logical artifact identities and three-file bundle resolve through native paths and the existing staging/collision guards

### Requirement: Generated container build contexts exclude host-local artifacts
The system SHALL generate explicit container-context exclusions for backend, frontend, and worker build contexts. The exclusions SHALL prevent host virtual environments, dependency trees, caches, build outputs, VCS metadata, local state, and secret-bearing files from entering the image or overwriting image-installed dependencies. Every exclusion artifact SHALL have an explicit logical inventory entry with portable path parts and SHALL resolve equivalently on Windows, macOS, and Linux.

#### Scenario: Host Python virtual environments do not enter backend images
- **WHEN** a generated backend container is built from a project root that contains `.venv` or other local Python environments
- **THEN** the build context excludes those paths
- **AND** image-installed dependencies are not overwritten by host packages

#### Scenario: Host Node dependency trees and build outputs stay out of images
- **WHEN** a generated Node.js or frontend container is built from a project root that contains `node_modules`, `dist`, `build`, or similar local outputs
- **THEN** the build context excludes those paths
- **AND** the resulting image depends only on its declared install steps and copied source files

#### Scenario: Windows path exclusions remain portable
- **WHEN** container-context exclusion artifacts are generated or resolved on Windows
- **THEN** the exclusions cover `.venv`, `node_modules`, build outputs, `.git`, local state, and secret-bearing files using platform-correct path handling
- **AND** no exclusion depends on a hardcoded POSIX-only separator
