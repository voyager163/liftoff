## ADDED Requirements

### Requirement: Initialization consent flags are explicit and independent
The system SHALL keep project-default acceptance, destination overwrite authorization, machine-tool installation authorization, and project dependency installation authorization as four independent decisions. No flag SHALL imply another, and installation or overwrite consent SHALL NOT be read from project configuration.

#### Scenario: Yes does not authorize overwrite
- **WHEN** a developer runs `liftoff init existing-project --yes` and destination preflight finds a conflicting generated file
- **THEN** Liftoff exits before writing unless the developer confirms interactively or supplies `--force`

#### Scenario: Force does not authorize machine changes
- **WHEN** a developer runs `liftoff init existing-project --force` and a blocking workstation tool is missing
- **THEN** Liftoff does not install the tool without interactive confirmation or `--install-tools`

#### Scenario: Machine-tool consent does not install project dependencies
- **WHEN** a developer supplies `--install-tools` without `--install-dependencies`
- **THEN** Liftoff does not run stack package installation in the generated project without the separate interactive confirmation

### Requirement: CLI help and status output use a responsive terminal renderer
The system SHALL render general help, command help, plans, readiness results, conflict summaries, and completion output through shared semantic terminal primitives. It SHALL provide branded color output on capable terminals and deterministic ANSI-free output for non-TTY, no-color, narrow, snapshot, and machine-readable contexts.

#### Scenario: General help on a capable terminal
- **WHEN** a developer runs `liftoff help` in a color-capable terminal with sufficient width
- **THEN** the output includes the static Liftoff wordmark, subtitle, usage, aligned commands, and grouped options with restrained semantic color

#### Scenario: Command help stays compact
- **WHEN** a developer runs `liftoff init --help`
- **THEN** the output describes the positional project name and every supported init flag from the same command definition used by the parser
- **AND** it does not repeat the full general-help banner

#### Scenario: Plain output contains no control sequences
- **WHEN** output is redirected, `NO_COLOR` is set, color is unsupported, or deterministic snapshot mode is active
- **THEN** Liftoff emits readable plain text with no ANSI escape sequences

#### Scenario: Narrow terminal does not wrap decorative borders
- **WHEN** the terminal width is below the full-layout threshold
- **THEN** Liftoff uses its compact unbordered layout instead of emitting clipped or wrapped panels

#### Scenario: Machine-readable output bypasses decoration
- **WHEN** a command emits `--json` output
- **THEN** the output contains only the documented JSON value and no banner, color, spinner, or status decoration

#### Scenario: Errors and version remain concise
- **WHEN** Liftoff prints a parser error or `--version`
- **THEN** the error uses focused usage guidance and the version uses one line without the branded banner

## MODIFIED Requirements

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

### Requirement: CLI captures required project decisions
The system SHALL capture the project name, project type, target cloud provider, deployment region, frontend selection, environment selection, spec-driven workflow, and one or more AI coding agents before generating files. For GenAI projects the system SHALL also capture the GenAI application pattern and use the approved Python/FastAPI/PydanticAI stack. For standard projects the system SHALL capture one approved API stack and SHALL NOT require a GenAI pattern. When Spec Kit has multiple selected agents, the system SHALL also capture exactly one default agent.

#### Scenario: Interactive GenAI project decisions
- **WHEN** a developer runs `liftoff init` without all required options and selects a GenAI project
- **THEN** the system prompts for missing common decisions, the GenAI pattern, and one or more coding agents
- **AND** the system defaults the spec-driven workflow to OpenSpec and the selected agent set to GitHub Copilot

#### Scenario: Interactive standard project decisions
- **WHEN** a developer runs `liftoff init` without all required options and selects a standard project
- **THEN** the system prompts for missing common decisions, the standard API stack, and one or more coding agents
- **AND** the system does not prompt for a GenAI pattern

#### Scenario: Approved GenAI stack is not prompted
- **WHEN** the CLI prompts for a GenAI project's decisions
- **THEN** the system does not ask the developer to choose the generated application framework because PydanticAI with FastAPI remains the approved GenAI default

#### Scenario: Approved standard framework is derived from API stack
- **WHEN** the CLI prompts for a standard project's decisions
- **THEN** each offered API stack identifies its approved language and framework
- **AND** the system does not ask a separate framework-selection question

#### Scenario: Both agents are selected for Spec Kit
- **WHEN** a developer selects GitHub Copilot and Claude Code with Spec Kit
- **THEN** the system asks which selected agent is the default integration before generation

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

### Requirement: CLI previews generation before writing files
The system SHALL provide a project plan preview before writing files in interactive init flows and through a standalone plan command. The preview SHALL include selected coding agents and the plan-derived workstation requirement summary without installing or writing anything.

#### Scenario: Interactive GenAI plan confirmation
- **WHEN** a developer completes the interactive prompts for a GenAI project
- **THEN** the system displays the project type, selected stack, pattern, provider, region, environments, frontend choice, local development stack, infrastructure output, spec workflow, coding agents, and required workstation tools before asking for confirmation

#### Scenario: Interactive standard plan confirmation
- **WHEN** a developer completes the interactive prompts for a standard project
- **THEN** the system displays the project type, API stack, provider, region, environments, frontend choice, local development stack, infrastructure output, spec workflow, coding agents, and required workstation tools without displaying a GenAI pattern

#### Scenario: Standalone GenAI plan command
- **WHEN** a developer runs `liftoff plan --pattern rag --cloud azure --frontend --agents copilot,claude`
- **THEN** the system displays the files, major components, selected agents, and workstation requirements without creating the project directory or installing tools

#### Scenario: Standalone standard plan command
- **WHEN** a developer runs `liftoff plan --no-genai --api node --cloud azure`
- **THEN** the system displays the standard Node.js/Fastify files, major components, default Copilot integration, and workstation requirements without creating files

### Requirement: CLI supports compatible non-interactive project-type inputs
The system SHALL support explicit standard-project and API-stack flags, SHALL infer GenAI project type when an existing GenAI pattern flag is provided without a project type, SHALL accept a comma-separated selected-agent list, and SHALL reject contradictory project-type, pattern, API-stack, workflow, selected-agent, and default-agent combinations before generation.

#### Scenario: Existing GenAI options remain valid under init
- **WHEN** a developer runs `liftoff init my-app --pattern rag --cloud azure --region eastus --spec openspec --no-frontend --yes`
- **THEN** the system infers a GenAI project using the Python/FastAPI API stack and the default Copilot integration
- **AND** generation proceeds without requiring a new project-type flag

#### Scenario: Initialize a standard Node.js project non-interactively
- **WHEN** a developer runs `liftoff init my-api --no-genai --api node --cloud azure --region eastus --spec openspec --agents copilot,claude --no-frontend --yes`
- **THEN** the system resolves `node` to the approved Node.js/Fastify API stack and selects both coding agents without project-decision prompts

#### Scenario: Select a Spec Kit default agent non-interactively
- **WHEN** a developer selects Spec Kit with `--agents copilot,claude --default-agent claude`
- **THEN** the plan records both integrations and Claude Code as the default

#### Scenario: Missing Spec Kit default agent is rejected
- **WHEN** a non-interactive command selects Spec Kit with multiple agents and omits `--default-agent`
- **THEN** Liftoff exits 1 before tool installation or generation and identifies the missing flag

#### Scenario: Reject conflicting project decisions
- **WHEN** a developer supplies `--no-genai` together with a GenAI pattern
- **THEN** the system stops before generation and explains that standard projects cannot select a GenAI pattern

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
The system SHALL expose commands for project initialization, planning, project update, project migration, pattern discovery, provider discovery, region discovery, validation, local development helpers, infrastructure helpers, and environment diagnostics.

#### Scenario: List supported patterns
- **WHEN** a developer runs `liftoff patterns`
- **THEN** the system lists all eight GenAI patterns and their V1 scaffold status

#### Scenario: Search regions
- **WHEN** a developer runs `liftoff regions search korea --cloud azure`
- **THEN** the system lists matching Azure regions with display names and slugs

#### Scenario: Run diagnostics
- **WHEN** a developer runs `liftoff doctor`
- **THEN** the system reports local readiness for the context-selected runtimes, spec framework, coding agents, Docker, and OpenTofu without modifying the project or workstation

#### Scenario: Check a project for drift
- **WHEN** a developer runs `liftoff update` inside a generated project
- **THEN** the system reports scaffold drift between the project and the current CLI templates without writing files

#### Scenario: Migrate an existing project
- **WHEN** a developer runs `liftoff migrate ../legacy-app`
- **THEN** the system scans the source project, generates a fresh Liftoff scaffold beside it, and emits a migration plan without modifying the source project

### Requirement: Packaged README documents the current CLI lifecycle
The system SHALL document the current Liftoff CLI lifecycle in the public repository root `README.md` included with the npm package, including first-use commands, project initialization and migration flows, target and overwrite safety, workstation readiness and consent flags, coding-agent selection, project validation and diagnostics, update reconciliation, local development/infrastructure helper commands, and standalone contributor commands.

#### Scenario: Review first-use workflow
- **WHEN** a developer reads the Liftoff CLI README after installing or inspecting `@msn-control/liftoff`
- **THEN** the README shows a quick-start path that includes previewing or initializing a project, selecting coding agents, validating it, running diagnostics, and starting local development

#### Scenario: Review command lifecycle
- **WHEN** a developer reads the command workflow documentation
- **THEN** the README explains the roles of `plan`, `init`, `migrate`, `validate`, `doctor`, `update`, `dev`, and `infra`
- **AND** it states that `create` was removed in favor of `init`

#### Scenario: Understand initialization safety
- **WHEN** a developer reads the initialization documentation
- **THEN** the README explains exact-Git-root in-place behavior, existing-directory conflict disclosure, the non-overridable manifest guard, and the separate meanings of `--yes`, `--force`, `--install-tools`, and `--install-dependencies`

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
The system SHALL validate commands, subcommands, positional arguments, and flags against an explicit command definition before executing command behavior. Unknown flags, unsupported subcommands, missing values, invalid boolean forms, invalid agent lists, and unexpected positional arguments MUST exit 1, identify the invalid token, and produce no project, workstation, or cloud side effects.

#### Scenario: Reject a misspelled init flag
- **WHEN** a developer supplies an unknown flag such as `--cluod` or `--frontned`
- **THEN** Liftoff exits 1, identifies the unknown flag, and does not generate a project using fallback defaults

#### Scenario: Reject the removed command
- **WHEN** a developer supplies `liftoff create`
- **THEN** Liftoff exits 1, recommends `liftoff init`, and does not run readiness probes that can mutate state

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
