## Purpose

Define the user-facing Liftoff CLI workflow for creating, previewing, validating, and inspecting Mission Control GenAI application scaffolds.

## Requirements

### Requirement: Liftoff exposes a Node-based CLI
The system SHALL provide a Node.js command-line interface named `liftoff` that requires Node.js 20.19 or newer and is installable from the published `@msn-control/liftoff` npm package without requiring Python to start the generator. The project-initialization command SHALL be `liftoff init`, and `liftoff create` SHALL NOT remain an alias.

#### Scenario: Run init command
- **WHEN** a developer runs `liftoff init`
- **THEN** the system starts the project initialization flow without requiring Python merely to start Liftoff

#### Scenario: Run non-interactive init command
- **WHEN** a developer runs `liftoff init my-app --pattern rag --cloud azure --region eastus --spec openspec --agents copilot --no-frontend --yes`
- **THEN** the system resolves the provided options into a project plan without prompting for framework, API framework, infrastructure tool, database, cache, observability, or developer portal choices

#### Scenario: Obsolete create command is rejected
- **WHEN** a developer runs `liftoff create`
- **THEN** Liftoff exits 1 without project or machine side effects
- **AND** it states that the command was replaced by `liftoff init`

#### Scenario: Run CLI after global npm install
- **WHEN** a developer installs Liftoff with `npm install -g @msn-control/liftoff@latest`
- **THEN** the `liftoff` command is available from the developer's shell
- **AND** running `liftoff help` displays the Liftoff command help

### Requirement: CLI reports the running Liftoff version
The system SHALL expose the running package version through `liftoff --version` and general help without requiring a project, Python, registry access, or any other network operation.

#### Scenario: Developer requests the installed version
- **WHEN** a developer runs `liftoff --version`
- **THEN** the CLI exits successfully after printing the Liftoff version read from its installed package metadata

#### Scenario: General help identifies the running version
- **WHEN** a developer runs `liftoff help` or invokes the CLI without a command
- **THEN** the general help output identifies the running Liftoff version

#### Scenario: Version output works from the packed installation
- **WHEN** package smoke verification invokes `--version` through an isolated globally installed CLI entrypoint
- **THEN** the reported version exactly matches the packed package version

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

### Requirement: CLI handles planned cloud providers explicitly
The system SHALL fully support Azure in V1 and identify AWS and GCP as planned provider adapters.

#### Scenario: Interactive planned provider visibility
- **WHEN** a developer is prompted for a target cloud provider
- **THEN** the system shows Azure as available and AWS/GCP as planned options

#### Scenario: Non-interactive unsupported provider
- **WHEN** a developer runs `liftoff init my-app --cloud aws --yes`
- **THEN** the system stops before generation and explains that AWS is a planned provider adapter, not a V1-supported provider

### Requirement: CLI resolves human-friendly deployment regions
The system SHALL resolve exact cloud region slugs and human-friendly region aliases for supported providers.

#### Scenario: Ambiguous interactive region
- **WHEN** a developer enters `korea` as the Azure region during an interactive init flow
- **THEN** the system presents matching Azure regions such as `koreacentral` and `koreasouth` and requires the developer to choose one before continuing

#### Scenario: Ambiguous non-interactive region
- **WHEN** a developer runs `liftoff init my-app --cloud azure --region korea --yes`
- **THEN** the system stops before generation and lists the matching Azure region slugs the developer can provide

#### Scenario: Default Azure region
- **WHEN** a developer accepts the default Azure region
- **THEN** the system uses East US with the slug `eastus`

### Requirement: CLI deployment environments use canonical stage names
For GenAI and standard API workloads, the CLI SHALL default environment
selection to `dev`, `staging`, and `prod` in that order. Interactive prompts,
non-interactive help, configuration parsing, and infrastructure helpers MUST
accept only those identifiers. The retired `test` identifier MUST fail before
generation or helper output and identify the supported values.

#### Scenario: Accept interactive environment default
- **WHEN** a developer accepts the environment prompt default
- **THEN** the project plan contains `dev`, `staging`, and `prod` in that order

#### Scenario: Show non-interactive environment default
- **WHEN** a developer inspects `liftoff init --help`
- **THEN** `--environments` displays `dev,staging,prod` as its default

#### Scenario: Reject retired environment
- **WHEN** a CLI option, configuration file, or infrastructure helper supplies `test`
- **THEN** Liftoff exits with an unsupported-environment error naming `dev`, `staging`, and `prod`
- **AND** performs no project write

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

### Requirement: CLI creates files safely across platforms
The system SHALL initialize at the current directory only when that directory is the exact real root of a Git worktree; otherwise it SHALL resolve the project to a named child directory. It SHALL stage and validate the complete Liftoff and official framework output before writing, SHALL preflight every staged path against the destination, and SHALL require one explicit authorization before replacing any conflicting regular file.

#### Scenario: Initialize at an exact Git root
- **WHEN** a developer runs `liftoff init` from the exact root of an existing Git worktree
- **THEN** Liftoff initializes that directory in place and infers the project name from the root folder
- **AND** it does not create a same-named child directory

#### Scenario: Supplied name at an exact Git root
- **WHEN** a developer runs `liftoff init service-name` from the exact root of a Git worktree
- **THEN** Liftoff uses `service-name` as project identity while keeping the current Git root as the target

#### Scenario: Nested Git directory does not adopt the repository root
- **WHEN** a developer runs `liftoff init my-app` from a directory below a Git worktree root
- **THEN** Liftoff targets the `my-app` child of the current directory
- **AND** it does not write to the ancestor Git root

#### Scenario: Existing named target can be merged
- **WHEN** a developer selects an existing non-Liftoff directory whose existing entries do not structurally block staged output
- **THEN** Liftoff preserves unrelated files and merges the staged project after any required conflict authorization

#### Scenario: Interactive conflicts are disclosed together
- **WHEN** destination preflight finds one or more different regular files at staged paths
- **THEN** Liftoff lists every portable relative conflict in stable order and requests one confirmation for the complete set
- **AND** declining leaves the destination unchanged

#### Scenario: Force authorizes listed regular-file replacement
- **WHEN** a developer supplies `--force` and preflight finds replaceable regular-file conflicts
- **THEN** Liftoff skips the overwrite prompt and replaces only the files in the validated merge plan

#### Scenario: Existing Liftoff project is never overwritten by init
- **WHEN** the target root contains `liftoff.manifest.json`
- **THEN** initialization exits before tool installation or destination writes and directs the developer to `liftoff update`
- **AND** `--force` does not override the guard

#### Scenario: Structural blocker is not forceable
- **WHEN** a staged file collides with a destination directory, symlink, unsafe ancestor, or path resolving outside the target
- **THEN** Liftoff exits before destination writes and identifies the blocked path
- **AND** `--force` does not override the blocker

#### Scenario: Framework initialization fails in staging
- **WHEN** the selected official framework initializer fails or staged validation fails
- **THEN** Liftoff removes the staging directory, leaves the destination unchanged, and reports the failed command

#### Scenario: Handled merge failure rolls back
- **WHEN** a destination write fails after the merge begins
- **THEN** Liftoff restores replaced files and removes files and empty directories created by that merge
- **AND** it exits with an explicit rollback result

#### Scenario: Windows path generation and conflict reporting
- **WHEN** the CLI initializes or merges a project on Windows
- **THEN** it uses platform-correct path resolution and atomic writes while displaying portable project-relative conflict paths
- **AND** manifest path semantics remain identical to macOS and Linux

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

### Requirement: Packaged README documents the current CLI lifecycle
The system SHALL provide a public repository root `README.md` included with the npm package that gives a concise first-use path, supported workloads, spec and agent integrations, exact-Git-root behavior, safety summary, validation and diagnostics entry points, and links to packaged detailed documentation. Detailed command lifecycle, ownership, consent, machine-output, generated-structure, and contributor contracts SHALL remain available through those links instead of requiring every contract to appear inline.

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
- **THEN** linked documentation states that plain `liftoff update` applies only safe managed-core changes, `--check` inspects only that authority, `--force` cannot reach project files, configuration expansion is create-only, and production template changes require separate migration
- **AND** it retains the documented JSON, exit-code, removed `--apply`, dependency-installation, conflict, orphan, and backup behavior

#### Scenario: Understand machine-readable and exit-code behavior
- **WHEN** a developer reads the linked CLI contract documentation
- **THEN** it states that check-mode core drift uses exit code 2, successful apply mode uses exit code 0, and JSON-capable commands emit a top-level numeric `schemaVersion`

#### Scenario: Review contributor workflow
- **WHEN** a contributor follows the README contribution link
- **THEN** `CONTRIBUTING.md` documents root-level build, test, check, package smoke, and release procedures
- **AND** none of those commands require a Mission Control workspace selector

### Requirement: CLI syntax is command-specific and strict
The system SHALL validate commands, subcommands, positional arguments, and flags against an explicit command definition before executing command behavior. Unknown or removed flags, incompatible flag combinations, unsupported subcommands, missing values, invalid boolean forms, invalid agent lists, and unexpected positional arguments MUST exit 1, identify the invalid token or combination, and produce no project, workstation, or cloud side effects.

#### Scenario: Reject a misspelled init flag
- **WHEN** a developer supplies an unknown flag such as `--cluod` or `--frontned`
- **THEN** Liftoff exits 1, identifies the unknown flag, and does not generate a project using fallback defaults

#### Scenario: Reject the removed command
- **WHEN** a developer supplies `liftoff create`
- **THEN** Liftoff exits 1, recommends `liftoff init`, and does not run readiness probes that can mutate state

#### Scenario: Reject removed update apply flag
- **WHEN** a developer supplies `liftoff update --apply`
- **THEN** Liftoff exits 1, recommends plain `liftoff update`, and performs no project read or write

#### Scenario: Reject force in check mode
- **WHEN** a developer supplies `liftoff update --check --force`
- **THEN** Liftoff exits 1 with guidance to use either `--check` or `--force`, and performs no project write

#### Scenario: Reject an unsupported helper subcommand
- **WHEN** a developer runs a helper with an unsupported subcommand such as `liftoff dev destroy`
- **THEN** Liftoff exits 1 and lists the supported subcommands instead of printing a default command

#### Scenario: Reject an unsupported region subcommand
- **WHEN** a developer runs `liftoff regions typo`
- **THEN** Liftoff exits 1 rather than listing all regions

#### Scenario: Render a missing-value error without a stack trace
- **WHEN** a value-taking flag such as `--agents` has no value
- **THEN** Liftoff exits 1 with concise usage guidance and does not print a JavaScript stack trace

#### Scenario: Reject an invalid agent list
- **WHEN** `--agents` is empty or contains an unknown identifier
- **THEN** Liftoff exits 1 before workstation or project side effects and lists the supported identifiers

#### Scenario: Show command-specific help
- **WHEN** a developer runs a supported command with `--help`
- **THEN** Liftoff exits 0 and prints that command's supported arguments, flags, and subcommands without validating required project options or probing tools

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

### Requirement: Initialization consent flags are explicit and independent
The system SHALL keep project-default acceptance, destination overwrite authorization, machine-tool installation authorization, global OpenSpec profile authorization, and project dependency installation authorization as five independent decisions. No flag SHALL imply another, and installation, global-profile, or overwrite consent SHALL NOT be read from project configuration.

#### Scenario: Yes does not authorize overwrite
- **WHEN** a developer runs `liftoff init existing-project --yes` and destination preflight finds a conflicting generated file
- **THEN** Liftoff exits before writing unless the developer confirms interactively or supplies `--force`

#### Scenario: Force does not authorize machine changes
- **WHEN** a developer runs `liftoff init existing-project --force` and a blocking workstation tool is missing
- **THEN** Liftoff does not install the tool without interactive confirmation or `--install-tools`

#### Scenario: Machine-tool consent does not install project dependencies
- **WHEN** a developer supplies `--install-tools` without `--install-dependencies`
- **THEN** Liftoff does not run stack package installation in the generated project without the separate interactive confirmation

#### Scenario: Other consent does not authorize global OpenSpec configuration
- **WHEN** the OpenSpec global profile is incompatible and the developer supplies `--yes`, `--force`, `--install-tools`, or `--install-dependencies` without the dedicated profile authorization
- **THEN** Liftoff does not change the global OpenSpec configuration
- **AND** it exits before destination writes with the exact remediation

### Requirement: CLI exposes an explicit Copilot cloud-agent choice
The system SHALL expose a default-off Copilot cloud-agent decision for OpenSpec projects that select GitHub Copilot. Interactive `init` and `migrate` flows SHALL prompt when the choice is unresolved, and noninteractive flows SHALL accept `--copilot-cloud` or `--no-copilot-cloud`.

#### Scenario: Prompt for the cloud coding agent
- **WHEN** an interactive OpenSpec plan selects GitHub Copilot and does not already specify a cloud-agent preference
- **THEN** Liftoff explains that the option writes a GitHub Actions workflow and an agent definition
- **AND** the confirmation defaults to No

#### Scenario: Preview the cloud-agent decision
- **WHEN** Liftoff presents an OpenSpec project plan
- **THEN** the plan identifies the complete 12-workflow, skills-and-commands contract
- **AND** it states whether the GitHub-hosted Copilot coding agent will be configured

#### Scenario: Enable the cloud coding agent noninteractively
- **WHEN** a fully specified OpenSpec command selects GitHub Copilot and supplies `--copilot-cloud`
- **THEN** Liftoff resolves the cloud-agent preference to enabled without an additional project-decision prompt

#### Scenario: Yes accepts the safe cloud-agent default
- **WHEN** a fully specified OpenSpec command selects GitHub Copilot, supplies `--yes`, and omits both cloud-agent flags
- **THEN** Liftoff resolves the cloud-agent preference to disabled
- **AND** `--yes` does not opt into the GitHub Actions integration

#### Scenario: Reject an inapplicable cloud-agent flag
- **WHEN** a developer supplies either cloud-agent flag with Spec Kit or without GitHub Copilot selected
- **THEN** Liftoff exits before probes or writes and explains the required OpenSpec and GitHub Copilot combination

### Requirement: Global OpenSpec profile authorization has a dedicated CLI surface
The system SHALL expose a dedicated noninteractive authorization flag for changing the global OpenSpec profile and SHALL show profile configuration as a separate interactive consent phase. The authorization SHALL apply only when OpenSpec is selected and the observed global profile does not already satisfy the Liftoff contract.

#### Scenario: Matching global profile needs no authorization
- **WHEN** the global OpenSpec configuration already selects `custom`, `both`, and all 12 required workflows
- **THEN** `liftoff init` and `liftoff migrate` proceed without a profile-change prompt or authorization flag

#### Scenario: Authorize a noninteractive profile change
- **WHEN** a fully specified OpenSpec command observes an incompatible global profile and supplies `--configure-openspec-profile`
- **THEN** Liftoff may apply and verify the required global profile before staging project files

#### Scenario: Standalone plan never changes global configuration
- **WHEN** a developer runs `liftoff plan` with any profile-authorization or cloud-agent selection
- **THEN** Liftoff previews the resolved project contract without running OpenSpec config commands or writing machine or project files

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

### Requirement: Completion command guidance is explicitly labeled
The system SHALL present any command supplied by a successful completion flow under a named `Next recommended command` heading before rendering the existing copyable shell command. The label SHALL make clear that the command is guidance rather than output Liftoff already executed. Liftoff MUST NOT execute, confirm, rewrite, wrap, or otherwise act on the recommendation, and completion without a recommended command SHALL NOT render an empty recommendation section.

#### Scenario: Initialization recommends validation clearly
- **WHEN** project initialization completes with its validation recommendation
- **THEN** Liftoff renders `Next recommended command` before the exact `$`-prefixed validation command
- **AND** it returns control to the developer without running that command

#### Scenario: Migration recommends the validation gate clearly
- **WHEN** migration completes with `liftoff validate && liftoff doctor` as its recommendation
- **THEN** the command appears in the named recommendation section rather than as an unlabeled completion line

#### Scenario: Update recommends follow-up validation clearly
- **WHEN** an update completes with `liftoff validate && liftoff doctor` as its recommendation
- **THEN** the completion output identifies it as the next recommended command and does not imply it already ran

#### Scenario: Recommendation preserves exact command syntax
- **WHEN** a recommended command contains quoted paths, repeated whitespace, a Windows path, arguments, or shell operators such as `&&`
- **THEN** the displayed command content remains one line and is byte-for-byte identical to the supplied recommendation
- **AND** the `$` marker remains presentation rather than part of the command

#### Scenario: Recommendation is responsive and color-safe
- **WHEN** completion renders in rich, compact, plain, color, or no-color presentation
- **THEN** the recommendation heading and decoration remain within the selected terminal width and retain the same visible text
- **AND** a command longer than the terminal width remains an exact unwrapped line rather than being rewritten

#### Scenario: Completion has no recommendation
- **WHEN** a completion caller supplies no recommended command
- **THEN** Liftoff renders no empty `Next recommended command` section

#### Scenario: Machine output remains unaffected
- **WHEN** a machine-readable command path bypasses human completion presentation
- **THEN** no recommendation label or decorative command text contaminates its output

### Requirement: CLI help and status output use a responsive terminal renderer
The system SHALL render every human-readable CLI surface through one shared semantic terminal presentation system, including general help, command help, onboarding, plans, prompts, readiness, consent, conflicts, completion, validation, update, doctor, discovery, helper, warning, and error output. On a capable wide terminal it SHALL use the approved static Liftoff wordmark, Unicode box-drawing sections, aligned content, deliberate spacing, and restrained semantic color. It SHALL provide compact and plain fallbacks without changing command behavior, stream ownership, machine-readable values, or exit codes.

#### Scenario: General help on a capable terminal
- **WHEN** a developer runs `liftoff help` in a color-capable terminal with sufficient width
- **THEN** the output includes the static large Liftoff wordmark, subtitle, usage, grouped global options, grouped commands, Unicode section borders, aligned descriptions, and restrained semantic color

#### Scenario: Command help uses the same visual language
- **WHEN** a developer runs `liftoff init --help` in a capable wide terminal
- **THEN** the output uses a branded command identity and bordered sections for usage and grouped options
- **AND** it describes the positional project name and every supported init flag from the same command definition used by the parser
- **AND** it does not include unrelated command groups

#### Scenario: Plan output uses semantic sections
- **WHEN** a developer runs `liftoff plan`
- **THEN** the project decisions, generated artifacts, and workstation requirements are rendered as named aligned sections rather than command-local bullet formatting

#### Scenario: Maintenance commands share statuses and remedies
- **WHEN** a developer runs `liftoff validate`, `liftoff update`, or `liftoff doctor` without JSON output
- **THEN** success, drift, skipped work, warnings, failures, and remedies use the same status, table, panel, and command primitives

#### Scenario: Reference and helper commands share lists and commands
- **WHEN** a developer runs `liftoff patterns`, `liftoff providers`, `liftoff regions`, `liftoff dev`, or `liftoff infra`
- **THEN** Liftoff uses shared list, table, heading, and command primitives instead of surface-specific prefixes and spacing

#### Scenario: Rich layout is visually stable
- **WHEN** a TTY is at least the full-layout threshold
- **THEN** every border fits within the detected terminal width
- **AND** ANSI color does not change visible alignment
- **AND** multiline content wraps inside its section instead of crossing a border

#### Scenario: Narrow terminal does not wrap decorative borders
- **WHEN** the terminal width is below the full-layout threshold
- **THEN** Liftoff uses its compact or plain layout instead of emitting clipped or wrapped rich panels
- **AND** it preserves the same labels, values, commands, and remedies

#### Scenario: Redirected output is deterministic plain text
- **WHEN** stdout or stderr is not a TTY
- **THEN** Liftoff emits readable deterministic plain text with no ANSI escape sequences or decorative box borders
- **AND** semantic information remains in the same order as interactive output

#### Scenario: No-color mode preserves hierarchy without ANSI
- **WHEN** `NO_COLOR` is set or color is unsupported
- **THEN** Liftoff emits no ANSI escape sequences
- **AND** headings, labels, statuses, and section hierarchy remain understandable

#### Scenario: Machine-readable output bypasses decoration
- **WHEN** a command emits `--json` output
- **THEN** the output contains only the documented JSON value and no wordmark, border, color, spinner, prompt, or status decoration

#### Scenario: Version remains a one-line machine-friendly value
- **WHEN** a developer runs `liftoff --version`
- **THEN** Liftoff emits exactly `Liftoff <version>` followed by one newline without the branded interface

#### Scenario: Errors remain concise and actionable
- **WHEN** Liftoff reports a parser, validation, readiness, conflict, or command failure in a human-readable context
- **THEN** it uses the shared compact error and remedy presentation on stderr
- **AND** it does not repeat the large wordmark or emit a stack trace for expected user errors

#### Scenario: Windows Terminal receives the rich layout
- **WHEN** Liftoff runs in a capable wide Windows Terminal
- **THEN** it renders the same static wordmark, Unicode sections, alignment, and semantic statuses as macOS and Linux
- **AND** Windows paths and command names remain intact without separator or width corruption

#### Scenario: Deterministic snapshots can select every layout
- **WHEN** terminal tests request rich, compact, plain, no-color, or JSON snapshot mode
- **THEN** rendering depends only on the supplied stream capabilities and options rather than the host terminal

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

### Requirement: CLI exposes self-upgrade as a maintenance command
The system SHALL expose `liftoff upgrade` as an explicit top-level maintenance command that is distinct from project-scoped `liftoff update`. Its command definition SHALL accept only `--check`, `--json`, and command help, require no positional project argument, and reject unsupported flags or arguments before registry lookup or installation.

#### Scenario: Show upgrade help
- **WHEN** a developer runs `liftoff upgrade --help`
- **THEN** Liftoff exits 0 and describes CLI replacement, read-only check mode, JSON output, supported global npm installations, and the distinction from project update
- **AND** performs no installation or registry lookup

#### Scenario: Reject a project argument
- **WHEN** a developer runs `liftoff upgrade ./project`
- **THEN** argument parsing exits 1 before filesystem or network side effects

#### Scenario: Reject unrelated consent flags
- **WHEN** a developer supplies `--force`, `--yes`, `--install-tools`, or `--install-dependencies` to upgrade
- **THEN** Liftoff rejects the unsupported flag
- **AND** no flag from another command can authorize self-upgrade

### Requirement: Upgrade follows shared output and exit conventions
Human upgrade output SHALL use the shared responsive terminal renderer. JSON output SHALL contain a top-level numeric `schemaVersion` and no decorative text. Exit code 0 SHALL mean current or upgraded, exit code 2 SHALL mean read-only check found an installable update, and exit code 1 SHALL mean invalid, blocked, or failed.

#### Scenario: Run in a redirected terminal
- **WHEN** upgrade output is redirected without `--json`
- **THEN** Liftoff uses deterministic plain presentation without prompting
- **AND** apply semantics remain imperative

#### Scenario: Run JSON mode
- **WHEN** upgrade uses `--json`
- **THEN** stdout contains only the documented JSON result
- **AND** diagnostics or child progress use stderr

### Requirement: Upgrade completion keeps project migration separate
After a successful CLI replacement, human completion SHALL identify the installed target and MAY recommend `liftoff update --check` as the next separately reviewed command. It SHALL NOT execute, confirm, or imply that any generated project was upgraded.

#### Scenario: Upgrade completes inside a project
- **WHEN** the CLI is upgraded successfully while the current directory is a generated project
- **THEN** completion labels `liftoff update --check` as a recommendation only
- **AND** no project discovery or reconciliation occurred

### Requirement: CLI captures the repository-governance profile
The system SHALL include repository governance among common project decisions for every workload. Interactive initialization SHALL offer the single-maintainer GitFlow profile after workload-specific architecture choices and default it to enabled. Configuration and noninteractive commands SHALL accept the append-only governance profile identifier through `governanceProfile` and `--governance`.

#### Scenario: Configure governance interactively
- **WHEN** a developer initializes any workload with missing governance input
- **THEN** Liftoff asks whether to generate the single-maintainer GitFlow governance handoff
- **AND** the default answer enables it

#### Scenario: Use noninteractive default
- **WHEN** a fully specified noninteractive `plan` or `init --yes` omits governance input
- **THEN** the project plan selects `single-maintainer-gitflow`
- **AND** no remote action is implied

#### Scenario: Load governance from configuration
- **WHEN** a valid configuration contains `governanceProfile`
- **THEN** Liftoff resolves it through the governance profile catalog
- **AND** flags override configuration through the normal defined-value merge

### Requirement: Plan preview distinguishes handoff from enforcement
The project plan preview SHALL identify the selected governance profile, policy version, managed-core handoff artifacts, selected-agent `/liftoff-setup` integrations, and deferred post-push activation. `liftoff plan` SHALL remain side-effect free and SHALL not require a Git repository, remote, GitHub authentication, or governance platform capability.

#### Scenario: Preview enabled governance
- **WHEN** a developer runs `liftoff plan` with the profile enabled
- **THEN** the preview says the local handoff will be generated
- **AND** says live Phase 0 and enforcement are deferred until after commit and push

#### Scenario: Preview disabled governance
- **WHEN** the project selects `none`
- **THEN** the preview reports repository governance as disabled
- **AND** does not list governance launchers or remote prerequisites

#### Scenario: Plan without GitHub access
- **WHEN** `liftoff plan` runs with no GitHub remote or credentials
- **THEN** it completes without attempting a GitHub API call

### Requirement: Governance options preserve independent consent
Selecting a repository-governance profile or passing `--yes` SHALL authorize only deterministic local planning and generated files. It SHALL NOT authorize agent execution, Git mutation, remote mutation, destination conflict overwrite, machine-tool installation, or project dependency installation.

#### Scenario: Initialize with yes and governance
- **WHEN** a developer runs a fully specified `liftoff init --yes` with the profile enabled
- **THEN** Liftoff may write the authorized collision-free local artifacts
- **AND** every existing independent overwrite and installation consent boundary remains unchanged
- **AND** no remote governance operation runs

### Requirement: CLI exposes deterministic governance setup commands
The CLI SHALL expose a `governance` command group with `status`, `plan`,
`apply-next`, `resume`, and `verify` subcommands. Commands SHALL use strict
argument validation, project-root discovery, versioned JSON output, responsive
human output, and existing independent consent boundaries.

#### Scenario: Run governance status outside a project
- **WHEN** no project manifest can be resolved
- **THEN** the command fails with a project-root remedy and performs no mutation

#### Scenario: Inspect governance identity
- **WHEN** the developer runs a governance command with JSON output
- **THEN** the versioned response identifies the creating Liftoff version, policy version, activation-contract version, applicable schema versions, and phase-graph hash
- **AND** does not report a separate setup-skill version

#### Scenario: Preview next transitions
- **WHEN** the developer runs `liftoff governance plan --json`
- **THEN** output lists ready and blocked phases, evidence, approval requirements, permitted mutations, and cost-envelope impact
- **AND** changes no file or remote resource

#### Scenario: Apply a ready transition
- **WHEN** the developer runs `liftoff governance apply-next --json --execute`
- **THEN** only allowlisted operations for evidence-ready and approved phases execute
- **AND** the result updates user-owned state transactionally

#### Scenario: Preview a ready transition
- **WHEN** the developer runs `liftoff governance apply-next --json` without `--execute`
- **THEN** the command reports the exact operations and required execution flag
- **AND** changes no file or remote resource

#### Scenario: Adapter returns a phase-forbidden terminal result
- **WHEN** a transition adapter returns a result not declared by the selected phase
- **THEN** apply-next records a blocker without writing invalid evidence
- **AND** no dependent transition is authorized

#### Scenario: Verification is consistent before setup starts
- **WHEN** `liftoff governance verify --json` finds no inconsistent state but no activation state exists
- **THEN** `ok` and `consistent` are true while `complete` is false
- **AND** `setupStatus` is `not-started` with the next ready phase

#### Scenario: Verification cannot inspect state
- **WHEN** `liftoff governance verify --json` encounters a malformed governance artifact
- **THEN** `ok` and `consistent` are false while `complete` is false
- **AND** `setupStatus` is `indeterminate`

#### Scenario: Resume after a blocker
- **WHEN** the external blocker evidence has changed
- **THEN** `resume` reruns only the blocker preflight and downstream readiness calculation
- **AND** does not repeat verified operations

#### Scenario: Unsupported governance syntax is supplied
- **WHEN** a misspelled subcommand, unknown flag, or excess positional argument is used
- **THEN** parsing fails before project discovery or mutation
