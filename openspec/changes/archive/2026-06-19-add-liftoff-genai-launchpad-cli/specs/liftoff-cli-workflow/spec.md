## ADDED Requirements

### Requirement: Liftoff exposes a Node-based CLI
The system SHALL provide a Node.js command-line interface named `liftoff` suitable for future npm packaging under `@mission-control/liftoff`.

#### Scenario: Run create command
- **WHEN** a developer runs `liftoff create`
- **THEN** the system starts the project creation flow without requiring Python to run the generator

#### Scenario: Run non-interactive create command
- **WHEN** a developer runs `liftoff create my-app --pattern rag --cloud azure --region eastus --spec openspec --no-frontend --yes`
- **THEN** the system resolves the provided options into a project plan without prompting for framework, API framework, infrastructure tool, database, cache, observability, or developer portal choices

### Requirement: CLI captures required project decisions
The system SHALL capture the project name, GenAI application pattern, target cloud provider, deployment region, frontend selection, environment selection, and spec-driven workflow before generating files.

#### Scenario: Interactive project decisions
- **WHEN** a developer runs `liftoff create` without all required options
- **THEN** the system prompts for missing required decisions and defaults the spec-driven workflow to OpenSpec

#### Scenario: Approved stack is not prompted
- **WHEN** the CLI prompts for project decisions
- **THEN** the system does not ask the developer to choose the generated application framework because PydanticAI is the approved default

### Requirement: CLI supports all approved GenAI patterns
The system SHALL allow developers to select RAG, chatbot/conversational AI, agent-based, prompt-based app, multi-agent system, fine-tuned model app, real-time/streaming AI, or AI workflow/pipeline as the GenAI application pattern.

#### Scenario: Select RAG pattern
- **WHEN** a developer selects the RAG pattern
- **THEN** the system includes RAG-specific decisions in the project plan, including retrieval and ingestion scaffold decisions

#### Scenario: Select each supported pattern
- **WHEN** a developer selects any one of the eight approved GenAI patterns
- **THEN** the system accepts the pattern and maps it to a pattern-specific scaffold module

### Requirement: CLI handles planned cloud providers explicitly
The system SHALL fully support Azure in V1 and identify AWS and GCP as planned provider adapters.

#### Scenario: Interactive planned provider visibility
- **WHEN** a developer is prompted for a target cloud provider
- **THEN** the system shows Azure as available and AWS/GCP as planned options

#### Scenario: Non-interactive unsupported provider
- **WHEN** a developer runs `liftoff create my-app --cloud aws --yes`
- **THEN** the system stops before generation and explains that AWS is a planned provider adapter, not a V1-supported provider

### Requirement: CLI resolves human-friendly deployment regions
The system SHALL resolve exact cloud region slugs and human-friendly region aliases for supported providers.

#### Scenario: Ambiguous interactive region
- **WHEN** a developer enters `korea` as the Azure region during an interactive create flow
- **THEN** the system presents matching Azure regions such as `koreacentral` and `koreasouth` and requires the developer to choose one before continuing

#### Scenario: Ambiguous non-interactive region
- **WHEN** a developer runs `liftoff create my-app --cloud azure --region korea --yes`
- **THEN** the system stops before generation and lists the matching Azure region slugs the developer can provide

#### Scenario: Default Azure region
- **WHEN** a developer accepts the default Azure region
- **THEN** the system uses East US with the slug `eastus`

### Requirement: CLI previews generation before writing files
The system SHALL provide a project plan preview before writing files in interactive create flows and through a standalone plan command.

#### Scenario: Interactive plan confirmation
- **WHEN** a developer completes the interactive prompts
- **THEN** the system displays the selected stack, pattern, provider, region, environments, frontend choice, local development stack, infrastructure output, and spec workflow before asking for confirmation

#### Scenario: Standalone plan command
- **WHEN** a developer runs `liftoff plan --pattern rag --cloud azure --frontend`
- **THEN** the system displays the files and major components that would be generated without creating the project directory

### Requirement: CLI creates files safely across platforms
The system SHALL generate only into a new or empty target directory by default and SHALL use cross-platform path handling for all generated paths.

#### Scenario: Non-empty target directory
- **WHEN** a developer runs `liftoff create existing-project` and the target directory exists with files
- **THEN** the system stops before writing files and explains that the target must be new or empty

#### Scenario: Windows path generation
- **WHEN** the CLI creates a project on Windows
- **THEN** the system uses platform-correct path handling while preserving the same generated project structure and manifest semantics as macOS and Linux

### Requirement: CLI exposes discovery and validation commands
The system SHALL expose commands for project creation, planning, pattern discovery, provider discovery, region discovery, validation, local development helpers, infrastructure helpers, and environment diagnostics.

#### Scenario: List supported patterns
- **WHEN** a developer runs `liftoff patterns`
- **THEN** the system lists all eight GenAI patterns and their V1 scaffold status

#### Scenario: Search regions
- **WHEN** a developer runs `liftoff regions search korea --cloud azure`
- **THEN** the system lists matching Azure regions with display names and slugs

#### Scenario: Run diagnostics
- **WHEN** a developer runs `liftoff doctor`
- **THEN** the system reports local readiness for required tools such as Node.js, Docker, and OpenTofu without modifying the project