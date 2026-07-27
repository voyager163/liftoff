## MODIFIED Requirements

### Requirement: CLI exposes discovery and validation commands
The system SHALL expose commands for project initialization, planning, imperative project update, explicit project update checks, project migration, pattern discovery, provider discovery, region discovery, validation, local development helpers, infrastructure helpers, and environment diagnostics.

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
- **WHEN** a developer or automation runs `liftoff update --check`
- **THEN** the system reports scaffold drift between the project and current CLI templates without requesting input or writing files

#### Scenario: Apply safe drift by default
- **WHEN** a developer or automation runs plain `liftoff update` and actionable safe drift exists
- **THEN** the system applies the safe managed changes without requesting input
- **AND** local conflicts remain untouched unless `--force` is supplied

#### Scenario: Migrate an existing project
- **WHEN** a developer runs `liftoff migrate ../legacy-app`
- **THEN** the system scans the source project, generates a fresh Liftoff scaffold beside it, and emits a migration plan without modifying the source project

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
- **THEN** linked documentation states that plain `liftoff update` applies safe managed changes without prompts, `--check` is read-only, `--force` explicitly overwrites conflicts, `--check --json` is the machine-readable check, `--apply` was removed, successful overwrites retain no Liftoff backup, dependencies are not installed, and orphans are not automatically deleted

#### Scenario: Understand machine-readable and exit-code behavior
- **WHEN** a developer reads the linked CLI contract documentation
- **THEN** it states that check-mode drift uses exit code 2, successful apply mode uses exit code 0, and JSON-capable commands emit a top-level numeric `schemaVersion`

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
