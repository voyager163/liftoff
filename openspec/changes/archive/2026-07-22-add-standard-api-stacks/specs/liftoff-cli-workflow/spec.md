## MODIFIED Requirements

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

### Requirement: CLI previews generation before writing files
The system SHALL provide a project plan preview before writing files in interactive create flows and through a standalone plan command.

#### Scenario: Interactive GenAI plan confirmation
- **WHEN** a developer completes the interactive prompts for a GenAI project
- **THEN** the system displays the project type, selected stack, pattern, provider, region, environments, frontend choice, local development stack, infrastructure output, and spec workflow before asking for confirmation

#### Scenario: Interactive standard plan confirmation
- **WHEN** a developer completes the interactive prompts for a standard project
- **THEN** the system displays the project type, API stack, provider, region, environments, frontend choice, local development stack, infrastructure output, and spec workflow without displaying a GenAI pattern

#### Scenario: Standalone standard plan command
- **WHEN** a developer runs `liftoff plan --no-genai --api node --cloud azure`
- **THEN** the system displays the standard Node.js/Fastify files and major components that would be generated without creating the project directory

## ADDED Requirements

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
