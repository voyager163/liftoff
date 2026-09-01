## MODIFIED Requirements

### Requirement: CLI exposes discovery and validation commands
The system SHALL expose commands for project initialization, planning, managed-core project update, explicit managed-core update checks, project migration, pattern discovery, provider discovery, region discovery, validation, local development helpers, infrastructure helpers, and environment diagnostics.

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
