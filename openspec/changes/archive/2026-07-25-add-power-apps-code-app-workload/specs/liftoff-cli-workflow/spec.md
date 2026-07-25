## MODIFIED Requirements

### Requirement: CLI captures required project decisions
The system SHALL capture the project name, project type, spec-driven workflow, and one or more AI coding agents before generating files. For GenAI projects it SHALL also capture the GenAI pattern, target cloud provider, deployment region, frontend selection, and environment selection while using the approved Python/FastAPI/PydanticAI stack. For standard projects it SHALL capture one approved API stack, target cloud provider, deployment region, frontend selection, and environment selection without requiring a GenAI pattern. For Power Apps code apps it SHALL capture the optional Microsoft Code Apps plugin preference without requiring API, GenAI, cloud, region, frontend, or API environment decisions. When Spec Kit has multiple selected agents, the system SHALL also capture exactly one default agent.

#### Scenario: Interactive GenAI project decisions
- **WHEN** a developer runs `liftoff init` without all required options and selects a GenAI project
- **THEN** the system prompts for missing common decisions, the GenAI pattern, cloud decisions, and one or more coding agents
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

### Requirement: CLI previews generation before writing files
The system SHALL provide a workload-aware project plan preview before writing files in interactive init flows and through a standalone plan command. The preview SHALL include selected coding agents, the applicable default agent and optional plugin preference, generated boundaries, and the plan-derived workstation requirement summary without installing or writing anything.

#### Scenario: Interactive GenAI plan confirmation
- **WHEN** a developer completes the interactive prompts for a GenAI project
- **THEN** the system displays the project type, selected stack, pattern, provider, region, environments, frontend choice, local development stack, infrastructure output, spec workflow, coding agents, and required workstation tools before asking for confirmation

#### Scenario: Interactive standard plan confirmation
- **WHEN** a developer completes the interactive prompts for a standard project
- **THEN** the system displays the project type, API stack, provider, region, environments, frontend choice, local development stack, infrastructure output, spec workflow, coding agents, and required workstation tools without displaying a GenAI pattern

#### Scenario: Interactive Power Apps plan confirmation
- **WHEN** a developer completes the interactive prompts for a Power Apps code app
- **THEN** the system displays the Power Apps starter identity, root application stack, spec workflow, coding agents, optional plugin preference, project dependency command, deferred environment-binding action, and required workstation tools
- **AND** it does not display an API backend, Azure provider, region, Docker, or OpenTofu output

#### Scenario: Standalone GenAI plan command
- **WHEN** a developer runs `liftoff plan --pattern rag --cloud azure --frontend --agents copilot,claude`
- **THEN** the system displays the files, major components, selected agents, and workstation requirements without creating the project directory or installing tools

#### Scenario: Standalone standard plan command
- **WHEN** a developer runs `liftoff plan --no-genai --api node --cloud azure`
- **THEN** the system displays the standard Node.js/Fastify files, major components, default Copilot integration, and workstation requirements without creating files

#### Scenario: Standalone Power Apps plan command
- **WHEN** a developer runs `liftoff plan --type power-apps-code-app --agents copilot,claude`
- **THEN** the system displays the pinned starter files, both integrations, relevant readiness, and deferred Power Platform setup without creating files or contacting Power Platform

### Requirement: CLI supports compatible non-interactive project-type inputs
The system SHALL accept `--type genai|standard|power-apps-code-app`, SHALL retain existing `--genai`, `--no-genai`, pattern, and API-stack inference, SHALL accept a comma-separated selected-agent list, and SHALL reject contradictory or inapplicable project-type, pattern, API-stack, cloud, region, frontend, environment, workflow, selected-agent, default-agent, and Code Apps plugin combinations before generation.

#### Scenario: Existing GenAI options remain valid under init
- **WHEN** a developer runs `liftoff init my-app --pattern rag --cloud azure --region eastus --spec openspec --no-frontend --yes`
- **THEN** the system infers a GenAI project using the Python/FastAPI API stack and the default Copilot integration
- **AND** generation proceeds without requiring a new project-type flag

#### Scenario: Initialize a standard Node.js project non-interactively
- **WHEN** a developer runs `liftoff init my-api --no-genai --api node --cloud azure --region eastus --spec openspec --agents copilot,claude --no-frontend --yes`
- **THEN** the system resolves `node` to the approved Node.js/Fastify API stack and selects both coding agents without project-decision prompts

#### Scenario: Initialize a Power Apps project noninteractively
- **WHEN** a developer runs `liftoff init my-code-app --type power-apps-code-app --spec openspec --agents copilot,claude --yes`
- **THEN** the system resolves the Power Apps workload and both agents without API-oriented project-decision prompts

#### Scenario: Select a Spec Kit default agent non-interactively
- **WHEN** a developer selects Spec Kit with `--agents copilot,claude --default-agent claude`
- **THEN** the plan records both integrations and Claude Code as the default

#### Scenario: Missing Spec Kit default agent is rejected
- **WHEN** a non-interactive command selects Spec Kit with multiple agents and omits `--default-agent`
- **THEN** Liftoff exits 1 before tool installation or generation and identifies the missing flag

#### Scenario: Reject conflicting project decisions
- **WHEN** a developer supplies `--no-genai` together with a GenAI pattern
- **THEN** the system stops before generation and explains that standard projects cannot select a GenAI pattern

#### Scenario: Reject an inapplicable Power Apps option
- **WHEN** a developer selects `--type power-apps-code-app` together with `--api`, `--pattern`, `--cloud`, `--region`, `--frontend`, or `--environments`
- **THEN** Liftoff exits 1 before probes or writes and identifies the inapplicable option

#### Scenario: Reject Code Apps plugin for another workload
- **WHEN** a developer enables the Code Apps plugin preference for a GenAI or standard project
- **THEN** Liftoff exits 1 before probes or writes and explains that the option applies only to Power Apps code apps

#### Scenario: Reject Power Apps migration in this release
- **WHEN** a developer requests `liftoff migrate` with `--type power-apps-code-app`
- **THEN** Liftoff exits 1 before source copying or destination writes
- **AND** it directs the developer to initialize a fresh Power Apps project

#### Scenario: Reject an inapplicable default agent
- **WHEN** a developer supplies `--default-agent` for OpenSpec or names an agent not present in `--agents`
- **THEN** Liftoff exits 1 before tool installation or generation with corrective guidance

### Requirement: Configuration files are runtime-validated
The system SHALL validate JSON configuration values by field name, runtime type, selected workload, and applicability before merging them with flags. Catalog-backed strings MUST resolve through existing catalog lookups, booleans MUST be JSON booleans, lists MUST contain strings, and invalid or workload-inapplicable configuration MUST exit 1 before planning or generation.

#### Scenario: Reject a string boolean
- **WHEN** `liftoff.config.json` contains `"includeFrontend": "false"` or a non-boolean Code Apps plugin preference
- **THEN** Liftoff reports that the named field must be a boolean and does not generate a project

#### Scenario: Reject a non-string catalog value
- **WHEN** a configuration supplies a non-string project type, API stack, pattern, provider, region, or spec workflow
- **THEN** Liftoff exits 1 with the field name instead of exposing a JavaScript type error

#### Scenario: Reject an invalid environment list
- **WHEN** a configuration environment value is not an array of supported environment strings
- **THEN** Liftoff reports the invalid field and performs no write

#### Scenario: Reject Power Apps API fields
- **WHEN** a Power Apps configuration contains an API stack, GenAI pattern, cloud, region, frontend, or API environment field
- **THEN** Liftoff identifies the inapplicable field and performs no probe or write

#### Scenario: Flags override a valid configuration
- **WHEN** a valid command flag overrides a compatible value from a valid configuration file
- **THEN** the normal documented flag precedence remains unchanged

### Requirement: Interactive workflows use a consistent visual lifecycle
The system SHALL present interactive `init` and `migrate` workflows as ordered Liftoff-owned stages using the same responsive terminal presentation as help and status output. It SHALL preserve all common consent boundaries, cancellation behavior, and command execution semantics while allowing workload-specific questions and a TTY-native coding-agent multi-select.

#### Scenario: Init opens with the Liftoff identity
- **WHEN** a developer runs interactive `liftoff init`
- **THEN** Liftoff renders the responsive branded identity before the first project question
- **AND** it does not wait until plan confirmation or workstation probing to introduce the interface

#### Scenario: Migrate opens with the Liftoff identity
- **WHEN** a developer runs interactive `liftoff migrate <source>`
- **THEN** Liftoff renders the responsive branded identity before scan provenance or migration questions

#### Scenario: Prompt choices use shared presentation
- **WHEN** Liftoff asks for a project type, pattern, API stack, provider, region, spec framework, default agent, frontend, environments, or optional plugin
- **THEN** the prompt, available choices, default, disabled state, and validation feedback use shared prompt and choice-list primitives

#### Scenario: Coding agents use the TTY multi-select
- **WHEN** Liftoff asks for coding agents with interactive TTY input and output
- **THEN** the prompt states that Up and Down navigate, Space toggles, and Enter confirms
- **AND** it displays selected, configured, detected, and not-observable states without disabling a missing agent

#### Scenario: Plan confirmation is visually distinct
- **WHEN** interactive initialization or migration reaches plan confirmation
- **THEN** Liftoff renders the resolved plan in a named section with aligned labels before the confirmation prompt

#### Scenario: Consent displays exact affected actions
- **WHEN** Liftoff requests file-replacement, per-tool installation, or project-dependency consent
- **THEN** it renders the exact files, allowlisted command, purpose, working directory, or remedy in a named section before asking for confirmation
- **AND** the visual treatment does not combine or weaken independent consent boundaries

#### Scenario: External command output remains unmodified
- **WHEN** an authorized installer, framework CLI, or dependency command streams output
- **THEN** Liftoff renders a stage heading before the command
- **AND** it forwards the child process output without adding borders, wrapping, or rewriting its bytes

#### Scenario: Interactive cancellation uses a terminal status
- **WHEN** a developer declines plan confirmation or file replacement
- **THEN** Liftoff renders a concise cancellation status that states no unauthorized destination change was made
- **AND** it preserves the existing successful cancellation exit behavior

#### Scenario: Successful onboarding ends with completion and next action
- **WHEN** `init` or `migrate` completes
- **THEN** Liftoff renders success, configured integrations, deferred work, target path, and the next validation command through shared completion primitives

### Requirement: Packaged README documents the current CLI lifecycle
The system SHALL provide a public repository root `README.md` included with the npm package that gives a concise first-use path, supported workloads, spec and agent integrations, exact-Git-root behavior, safety summary, validation and diagnostics entry points, and links to packaged detailed documentation. Detailed command lifecycle, consent, machine-output, generated-structure, and contributor contracts SHALL remain available through those links instead of requiring every contract to appear inline.

#### Scenario: Review first-use workflow
- **WHEN** a developer reads the Liftoff CLI README after installing or inspecting `@msn-control/liftoff`
- **THEN** the README leads with installation and interactive `liftoff init`
- **AND** it introduces GenAI, API, and Power Apps workloads plus OpenSpec, Spec Kit, Copilot, and Claude Code

#### Scenario: Review command lifecycle
- **WHEN** a developer needs the roles of `plan`, `init`, `migrate`, `validate`, `doctor`, `update`, `dev`, and `infra`
- **THEN** the README links to packaged CLI lifecycle documentation that describes those commands
- **AND** the documentation states that `create` was removed in favor of `init`

#### Scenario: Understand initialization safety
- **WHEN** a developer needs complete initialization safety details
- **THEN** the README summarizes transactional staging and links to documentation covering exact-Git-root behavior, conflict disclosure, the manifest guard, and the separate meanings of `--yes`, `--force`, `--install-tools`, and `--install-dependencies`

#### Scenario: Understand update safety
- **WHEN** a developer needs update behavior
- **THEN** linked documentation states that `liftoff update` checks without writing, `--apply` writes safe changes, `--force` is required for conflicts, and orphans are not automatically deleted

#### Scenario: Understand machine-readable and exit-code behavior
- **WHEN** a developer reads the linked CLI contract documentation
- **THEN** it states that check-mode drift uses exit code 2 and JSON-capable commands emit a top-level numeric `schemaVersion`

#### Scenario: Review contributor workflow
- **WHEN** a contributor follows the README contribution link
- **THEN** `CONTRIBUTING.md` documents root-level build, test, check, package smoke, and release procedures
- **AND** none of those commands require a Mission Control workspace selector

## ADDED Requirements

### Requirement: Interactive agent selection supports keyboard multi-selection
The system SHALL use a checkbox-style selector when both input and output are real interactive TTYs. Configured integrations SHALL be preselected when present; otherwise observable installed agents SHALL be preselected, falling back to GitHub Copilot when none is observable. At least one agent SHALL be required, and the resolved result SHALL use canonical catalog order.

#### Scenario: Select both agents with Space
- **WHEN** a developer toggles GitHub Copilot and Claude Code with Space and presses Enter
- **THEN** the project plan contains both agents in canonical catalog order

#### Scenario: Empty selection is rejected
- **WHEN** a developer deselects every agent and presses Enter
- **THEN** the prompt remains active and states that at least one agent is required

#### Scenario: Redirected input uses the line fallback
- **WHEN** interactive answers come from redirected input or an injected non-TTY stream
- **THEN** Liftoff uses the deterministic comma-separated selector
- **AND** existing scripted input and snapshot behavior remain supported

#### Scenario: Agent flag bypasses the selector
- **WHEN** `--agents` or valid configured agents already provide the selection
- **THEN** Liftoff does not start either interactive agent selector

#### Scenario: Ctrl+C cancels before writes
- **WHEN** the developer presses Ctrl+C in the TTY multi-select
- **THEN** Liftoff restores terminal state, cancels initialization, and makes no destination change

### Requirement: Project-scoped helpers are workload-aware
The system SHALL derive validation and helper behavior from normalized workload identity. Existing GenAI and standard API projects SHALL retain their Docker Compose and OpenTofu helper contracts. Power Apps code apps SHALL receive root application development guidance and SHALL NOT receive Docker or OpenTofu commands for infrastructure they do not contain.

#### Scenario: Show Power Apps development command
- **WHEN** a developer runs `liftoff dev` inside a Power Apps project
- **THEN** Liftoff prints the documented root application development command and dependency prerequisite
- **AND** it does not print a Docker Compose command

#### Scenario: Power Apps infrastructure is not applicable
- **WHEN** a developer runs `liftoff infra` inside a Power Apps project
- **THEN** Liftoff reports that Liftoff-managed OpenTofu infrastructure is not applicable to the Power Platform-hosted workload
- **AND** it does not print or execute an OpenTofu command

#### Scenario: Validate a Power Apps project
- **WHEN** a developer runs `liftoff validate` inside a fresh Power Apps project
- **THEN** validation checks schema-v4 workload identity, named starter artifacts, package metadata, and selected framework markers
- **AND** it does not require API, Docker, or infrastructure files
