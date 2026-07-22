## Purpose

Define the user-facing Liftoff CLI workflow for creating, previewing, validating, and inspecting Mission Control GenAI application scaffolds.

## Requirements

### Requirement: Liftoff exposes a Node-based CLI
The system SHALL provide a Node.js command-line interface named `liftoff` that is installable from the published `@msn-control/liftoff` npm package without requiring Python to run the generator.

#### Scenario: Run create command
- **WHEN** a developer runs `liftoff create`
- **THEN** the system starts the project creation flow without requiring Python to run the generator

#### Scenario: Run non-interactive create command
- **WHEN** a developer runs `liftoff create my-app --pattern rag --cloud azure --region eastus --spec openspec --no-frontend --yes`
- **THEN** the system resolves the provided options into a project plan without prompting for framework, API framework, infrastructure tool, database, cache, observability, or developer portal choices

#### Scenario: Run CLI after global npm install
- **WHEN** a developer installs Liftoff with `npm install -g @msn-control/liftoff@latest`
- **THEN** the `liftoff` command is available from the developer's shell
- **AND** running `liftoff help` displays the Liftoff command help

### Requirement: CLI captures required project decisions
The system SHALL capture the project name, project type, target cloud provider, deployment region, frontend selection, environment selection, and spec-driven workflow before generating files. For GenAI projects the system SHALL also capture the GenAI application pattern and use the approved Python/FastAPI/PydanticAI stack. For standard projects the system SHALL capture one approved API stack and SHALL NOT require a GenAI pattern.

#### Scenario: Interactive GenAI project decisions
- **WHEN** a developer runs `liftoff create` without all required options and selects a GenAI project
- **THEN** the system prompts for missing common decisions and the GenAI pattern
- **AND** the system defaults the spec-driven workflow to OpenSpec

#### Scenario: Interactive standard project decisions
- **WHEN** a developer runs `liftoff create` without all required options and selects a standard project
- **THEN** the system prompts for missing common decisions and the standard API stack
- **AND** the system does not prompt for a GenAI pattern

#### Scenario: Approved GenAI stack is not prompted
- **WHEN** the CLI prompts for a GenAI project's decisions
- **THEN** the system does not ask the developer to choose the generated application framework because PydanticAI with FastAPI remains the approved GenAI default

#### Scenario: Approved standard framework is derived from API stack
- **WHEN** the CLI prompts for a standard project's decisions
- **THEN** each offered API stack identifies its approved language and framework
- **AND** the system does not ask a separate framework-selection question

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

#### Scenario: Interactive GenAI plan confirmation
- **WHEN** a developer completes the interactive prompts for a GenAI project
- **THEN** the system displays the project type, selected stack, pattern, provider, region, environments, frontend choice, local development stack, infrastructure output, and spec workflow before asking for confirmation

#### Scenario: Interactive standard plan confirmation
- **WHEN** a developer completes the interactive prompts for a standard project
- **THEN** the system displays the project type, API stack, provider, region, environments, frontend choice, local development stack, infrastructure output, and spec workflow without displaying a GenAI pattern

#### Scenario: Standalone GenAI plan command
- **WHEN** a developer runs `liftoff plan --pattern rag --cloud azure --frontend`
- **THEN** the system displays the files and major components that would be generated without creating the project directory

#### Scenario: Standalone standard plan command
- **WHEN** a developer runs `liftoff plan --no-genai --api node --cloud azure`
- **THEN** the system displays the standard Node.js/Fastify files and major components that would be generated without creating the project directory

### Requirement: CLI supports compatible non-interactive project-type inputs
The system SHALL support explicit standard-project and API-stack flags, SHALL infer GenAI project type when an existing GenAI pattern flag is provided without a project type, and SHALL reject contradictory project-type, pattern, and API-stack combinations before generation.

#### Scenario: Existing GenAI command remains valid
- **WHEN** a developer runs `liftoff create my-app --pattern rag --cloud azure --region eastus --spec openspec --no-frontend --yes`
- **THEN** the system infers a GenAI project using the Python/FastAPI API stack
- **AND** generation proceeds without requiring a new project-type flag

#### Scenario: Create a standard Node.js project non-interactively
- **WHEN** a developer runs `liftoff create my-api --no-genai --api node --cloud azure --region eastus --spec openspec --no-frontend --yes`
- **THEN** the system resolves `node` to the approved Node.js/Fastify API stack and generates without prompting

#### Scenario: Reject conflicting project decisions
- **WHEN** a developer supplies `--no-genai` together with a GenAI pattern
- **THEN** the system stops before generation and explains that standard projects cannot select a GenAI pattern

### Requirement: CLI creates files safely across platforms
The system SHALL generate only into a new or empty target directory by default and SHALL use cross-platform path handling for all generated paths.

#### Scenario: Non-empty target directory
- **WHEN** a developer runs `liftoff create existing-project` and the target directory exists with files
- **THEN** the system stops before writing files and explains that the target must be new or empty

#### Scenario: Windows path generation
- **WHEN** the CLI creates a project on Windows
- **THEN** the system uses platform-correct path handling while preserving the same generated project structure and manifest semantics as macOS and Linux

### Requirement: CLI exposes discovery and validation commands
The system SHALL expose commands for project creation, planning, project update, project migration, pattern discovery, provider discovery, region discovery, validation, local development helpers, infrastructure helpers, and environment diagnostics.

#### Scenario: List supported patterns
- **WHEN** a developer runs `liftoff patterns`
- **THEN** the system lists all eight GenAI patterns and their V1 scaffold status

#### Scenario: Search regions
- **WHEN** a developer runs `liftoff regions search korea --cloud azure`
- **THEN** the system lists matching Azure regions with display names and slugs

#### Scenario: Run diagnostics
- **WHEN** a developer runs `liftoff doctor`
- **THEN** the system reports local readiness for required tools such as Node.js, Docker, and OpenTofu without modifying the project

#### Scenario: Check a project for drift
- **WHEN** a developer runs `liftoff update` inside a generated project
- **THEN** the system reports scaffold drift between the project and the current CLI templates without writing files

#### Scenario: Migrate an existing project
- **WHEN** a developer runs `liftoff migrate ../legacy-app`
- **THEN** the system scans the source project, generates a fresh Liftoff scaffold beside it, and emits a migration plan without modifying the source project

### Requirement: Packaged README documents the current CLI lifecycle
The system SHALL document the current Liftoff CLI lifecycle in the public repository root `README.md` included with the npm package, including first-use commands, project creation and migration flows, project validation and diagnostics, update reconciliation, local development/infrastructure helper commands, and standalone contributor commands.

#### Scenario: Review first-use workflow
- **WHEN** a developer reads the Liftoff CLI README after installing or inspecting `@msn-control/liftoff`
- **THEN** the README shows a quick-start path that includes previewing or creating a project, validating it, running diagnostics, and starting local development

#### Scenario: Review command lifecycle
- **WHEN** a developer reads the command workflow documentation
- **THEN** the README explains the roles of `plan`, `create`, `migrate`, `validate`, `doctor`, `update`, `dev`, and `infra`

#### Scenario: Understand update safety
- **WHEN** a developer reads the update documentation
- **THEN** the README states that `liftoff update` checks for drift without writing by default, `liftoff update --apply` writes safe changes, conflicts require `--force` to overwrite, and orphaned files are not automatically deleted

#### Scenario: Understand machine-readable and exit-code behavior
- **WHEN** a developer reads the lifecycle or contract documentation
- **THEN** the README states that check-mode drift uses exit code 2 and that JSON-capable commands emit a top-level numeric `schemaVersion`

#### Scenario: Review contributor workflow
- **WHEN** a contributor reads the public repository development instructions
- **THEN** the README documents root-level build, test, check, and package smoke commands
- **AND** none of those commands require a Mission Control workspace selector

### Requirement: CLI syntax is command-specific and strict
The system SHALL validate commands, subcommands, positional arguments, and flags against an explicit command definition before executing command behavior. Unknown flags, unsupported subcommands, missing values, invalid boolean forms, and unexpected positional arguments MUST exit 1, identify the invalid token, and produce no project or cloud side effects.

#### Scenario: Reject a misspelled create flag
- **WHEN** a developer supplies an unknown flag such as `--cluod` or `--frontned`
- **THEN** Liftoff exits 1, identifies the unknown flag, and does not generate a project using fallback defaults

#### Scenario: Reject an unsupported helper subcommand
- **WHEN** a developer runs a helper with an unsupported subcommand such as `liftoff dev destroy`
- **THEN** Liftoff exits 1 and lists the supported subcommands instead of printing a default command

#### Scenario: Reject an unsupported region subcommand
- **WHEN** a developer runs `liftoff regions typo`
- **THEN** Liftoff exits 1 rather than listing all regions

#### Scenario: Render a missing-value error without a stack trace
- **WHEN** a value-taking flag such as `--pattern` has no value
- **THEN** Liftoff exits 1 with concise usage guidance and does not print a JavaScript stack trace

#### Scenario: Show command-specific help
- **WHEN** a developer runs a supported command with `--help`
- **THEN** Liftoff exits 0 and prints that command's supported arguments, flags, and subcommands without validating required project options

### Requirement: Configuration files are runtime-validated
The system SHALL validate JSON configuration values by field name and runtime type before merging them with flags. Catalog-backed strings MUST resolve through existing catalog lookups, booleans MUST be JSON booleans, lists MUST contain strings, and invalid configuration MUST exit 1 before planning or generation.

#### Scenario: Reject a string boolean
- **WHEN** `liftoff.config.json` contains `"includeFrontend": "false"`
- **THEN** Liftoff reports that `includeFrontend` must be a boolean and does not generate a frontend

#### Scenario: Reject a non-string catalog value
- **WHEN** a configuration supplies a non-string project type, API stack, pattern, provider, region, or spec workflow
- **THEN** Liftoff exits 1 with the field name instead of exposing a JavaScript type error

#### Scenario: Reject an invalid environment list
- **WHEN** a configuration environment value is not an array of supported environment strings
- **THEN** Liftoff reports the invalid field and performs no write

#### Scenario: Flags override a valid configuration
- **WHEN** a valid command flag overrides a compatible value from a valid configuration file
- **THEN** the normal documented flag precedence remains unchanged