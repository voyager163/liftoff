## MODIFIED Requirements

### Requirement: CLI captures required project decisions
The system SHALL capture the project name, project type, spec-driven workflow, and one or more AI coding agents before generating files. For GenAI projects it SHALL also capture the GenAI pattern, target cloud provider, deployment region, frontend selection, and environment selection while using the approved Python/FastAPI/PydanticAI stack. The GenAI pattern choice SHALL offer an explicit generic option for users who are not ready to select a specialization and SHALL default to that option. For standard projects it SHALL capture one approved API stack, target cloud provider, deployment region, frontend selection, and environment selection without requiring a GenAI pattern. For Power Apps code apps it SHALL capture the optional Microsoft Code Apps plugin preference without requiring API, GenAI, cloud, region, frontend, or API environment decisions. When Spec Kit has multiple selected agents, the system SHALL also capture exactly one default agent.

#### Scenario: Interactive GenAI project decisions
- **WHEN** a developer runs `liftoff init` without all required options and selects a GenAI project
- **THEN** the system prompts for missing common decisions, offers `I'm not sure yet - Generic GenAI starter` before specialized patterns, captures cloud decisions and one or more coding agents
- **AND** the generic option is selected when the developer accepts the pattern default
- **AND** the system defaults the spec-driven workflow to OpenSpec

#### Scenario: Interactive standard project decisions
- **WHEN** a developer runs `liftoff init` without all required options and selects a standard project
- **THEN** the system prompts for missing common decisions, the standard API stack, cloud decisions, and one or more coding agents
- **AND** the system does not prompt for a GenAI pattern

#### Scenario: Interactive Power Apps project decisions
- **WHEN** a developer runs `liftoff init` without all required options and selects a Power Apps code app
- **THEN** the system prompts for the common spec workflow and coding agents followed by the optional preview-plugin preference
- **AND** it does not prompt for an API stack, GenAI pattern, cloud, region, frontend, or API environments

#### Scenario: Approved GenAI stack is not prompted
- **WHEN** the CLI prompts for a GenAI project's decisions
- **THEN** the system does not ask the developer to choose the generated application framework because PydanticAI with FastAPI remains the approved GenAI default

#### Scenario: Approved standard framework is derived from API stack
- **WHEN** the CLI prompts for a standard project's decisions
- **THEN** each offered API stack identifies its approved language and framework
- **AND** the system does not ask a separate framework-selection question

#### Scenario: Both agents are selected for Spec Kit
- **WHEN** a developer selects GitHub Copilot and Claude Code with Spec Kit for any workload
- **THEN** the system asks which selected agent is the default integration before generation

### Requirement: CLI supports all approved GenAI patterns
The system SHALL allow developers to select generic/undecided, RAG, chatbot/conversational AI, agent-based, prompt-based app, multi-agent system, fine-tuned model app, real-time/streaming AI, or AI workflow/pipeline as the GenAI application pattern. Interactive and noninteractive selection SHALL resolve the stable identifier `generic` rather than silently mapping uncertainty to another specialization.

#### Scenario: Select generic pattern
- **WHEN** a developer chooses `I'm not sure yet - Generic GenAI starter` or supplies `--pattern generic`
- **THEN** the system records the `generic` pattern and resolves a neutral GenAI project plan

#### Scenario: Select RAG pattern
- **WHEN** a developer selects the RAG pattern
- **THEN** the system includes RAG-specific decisions in the project plan, including retrieval and ingestion scaffold decisions

#### Scenario: Select each supported pattern
- **WHEN** a developer selects any one of the nine approved GenAI patterns
- **THEN** the system accepts the pattern and maps it to its explicit scaffold definition

### Requirement: CLI exposes discovery and validation commands
The system SHALL expose commands for project initialization, planning, managed-core project update, explicit managed-core update checks, project migration, pattern discovery, provider discovery, region discovery, validation, local development helpers, infrastructure helpers, and environment diagnostics.

#### Scenario: List supported patterns
- **WHEN** a developer runs `liftoff patterns`
- **THEN** the system lists all nine GenAI patterns, including the generic uncertainty option, with their scaffold status

#### Scenario: Search regions
- **WHEN** a developer runs `liftoff regions search korea --cloud azure`
- **THEN** the system lists matching Azure regions with display names and slugs

#### Scenario: Run diagnostics
- **WHEN** a developer runs `liftoff doctor`
- **THEN** the system reports local readiness for the context-selected runtimes, spec framework, coding agents, Docker, and OpenTofu without modifying the project or workstation

#### Scenario: Check a project for drift
- **WHEN** a developer or automation runs `liftoff update --check`
- **THEN** the system reports only managed-core drift and configuration-authorized component provisioning without requesting input or writing files
- **AND** it does not compare production project files with current starter templates

#### Scenario: Apply safe drift by default
- **WHEN** a developer or automation runs plain `liftoff update` and actionable managed-core drift exists
- **THEN** the system applies safe core changes without requesting input
- **AND** core conflicts remain untouched unless `--force` is supplied

#### Scenario: Force stays inside the core boundary
- **WHEN** a developer runs `liftoff update --force`
- **THEN** only listed managed-core conflicts are eligible for overwrite
- **AND** project-owned files and provisioning collisions remain untouched

#### Scenario: Migrate an existing project
- **WHEN** a developer runs `liftoff migrate ../legacy-app`
- **THEN** the system scans the source project, generates a fresh Liftoff scaffold beside it, and emits a migration plan without modifying the source project
