## MODIFIED Requirements

### Requirement: Workstation requirements are derived from the resolved project plan
The system SHALL build a deterministic requirement set from the selected workload and its applicable API stack, cloud provider, infrastructure output, spec workflow, frontend choice, coding agents, and optional integrations. It SHALL include only tools relevant to that plan and SHALL identify every requirement as blocking or advisory.

#### Scenario: Python OpenSpec project requirements
- **WHEN** a developer selects a Python/FastAPI project with OpenSpec and GitHub Copilot
- **THEN** the requirement set includes supported Node.js, Python, the pinned OpenSpec CLI, and a detectable Copilot installation
- **AND** it does not require Go or Spec Kit

#### Scenario: Go Spec Kit project requirements
- **WHEN** a developer selects a Go/Huma project with Spec Kit and Claude Code
- **THEN** the requirement set includes supported Node.js, Python, Go, `uv`, the pinned Spec Kit CLI, and Claude Code
- **AND** it does not require a Python backend dependency installation

#### Scenario: Power Apps OpenSpec project requirements
- **WHEN** a developer selects a Power Apps code app with OpenSpec, Copilot, and Claude Code
- **THEN** the requirement set includes the tested Node.js LTS baseline, pinned OpenSpec CLI, Copilot, and Claude Code
- **AND** it omits Python, Go, Docker, OpenTofu, Azure CLI, and backend runtime requirements

#### Scenario: Infrastructure tools are advisory
- **WHEN** an API workload includes Azure OpenTofu infrastructure and Docker-based local development
- **THEN** Docker, OpenTofu, and Azure CLI readiness appear as advisory requirements
- **AND** declining them does not falsely report them as ready

### Requirement: Blocking workstation gaps stop initialization before project writes
The system SHALL require supported Node.js, every selected workload runtime, the selected spec-framework CLI and its installer prerequisites, and each selected AI-agent installation before committing the project. Authentication health MAY remain an explicit warning because Liftoff does not control credentials. Missing advisory infrastructure or optional agent-plugin tools SHALL be deferrable with remedies.

#### Scenario: Missing backend runtime blocks
- **WHEN** a selected API backend runtime is missing and the developer does not authorize or complete its installation
- **THEN** initialization exits unsuccessfully before writing the destination
- **AND** the output identifies the exact runtime remedy

#### Scenario: Missing Power Apps Node baseline blocks
- **WHEN** a Power Apps plan observes Node.js below the workload's tested LTS minimum and no successful upgrade is authorized
- **THEN** initialization exits unsuccessfully before writing the destination
- **AND** it identifies both the observed and required versions

#### Scenario: Missing selected agent blocks installation readiness
- **WHEN** Claude Code is selected and no `claude` executable is available
- **THEN** initialization requires Claude Code installation before project commit

#### Scenario: Agent authentication remains user-controlled
- **WHEN** a selected agent is installed but its health probe indicates that authentication is required
- **THEN** Liftoff reports a warning with the agent-owned login remedy
- **AND** Liftoff does not request, store, or modify credentials

#### Scenario: Advisory tool is deferred honestly
- **WHEN** an applicable advisory tool or optional Code Apps plugin is missing and the developer declines or cannot perform its setup
- **THEN** initialization may continue
- **AND** completion states what remains unavailable and shows the remedy

### Requirement: Project dependency installation is a separate final phase
The system SHALL offer workload-specific project dependency installation only after the staged scaffold has been committed successfully. Interactive execution SHALL require a separate confirmation, non-interactive execution SHALL require `--install-dependencies`, and `--install-tools` SHALL NOT imply project dependency installation.

#### Scenario: Install Python project dependencies
- **WHEN** a Python API project was initialized and dependency installation is authorized
- **THEN** Liftoff creates the documented project-local virtual environment and installs through its interpreter

#### Scenario: Install Node.js backend dependencies
- **WHEN** a Node.js API backend was initialized and dependency installation is authorized
- **THEN** Liftoff runs the registered lockfile-preserving `npm ci` command in the backend directory

#### Scenario: Install an optional API frontend
- **WHEN** an API workload includes a generated frontend and dependency installation is authorized
- **THEN** Liftoff runs the registered lockfile-preserving `npm ci` command in the frontend directory

#### Scenario: Install Power Apps project dependencies
- **WHEN** a Power Apps code app was initialized and dependency installation is authorized
- **THEN** Liftoff runs the platform-correct lockfile-preserving `npm ci` command once at the project root

#### Scenario: Prepare Go project dependencies
- **WHEN** a Go project was initialized and dependency installation is authorized
- **THEN** Liftoff downloads modules using the generated `go.mod` and `go.sum` without requiring an unrecorded metadata rewrite

#### Scenario: Dependency installation is declined
- **WHEN** a developer declines the final dependency-install prompt
- **THEN** initialization completes with the valid scaffold intact and prints the exact workload-specific project-local install command

#### Scenario: Dependency installation fails
- **WHEN** an authorized project dependency command fails
- **THEN** Liftoff exits unsuccessfully without deleting the committed scaffold
- **AND** it identifies the failed command and exact resume command

## ADDED Requirements

### Requirement: Power Apps project tooling is verified without global installation
The system SHALL treat the Power Apps SDK, Vite plugin, and npm-based Code Apps CLI as project dependencies pinned by the generated package and lockfile rather than global workstation tools. Before dependencies exist, Liftoff SHALL verify their declared package metadata; after installation, doctor MAY run the packaged binary only with `npx --no-install`.

#### Scenario: Plan does not require a global Power Apps CLI
- **WHEN** Liftoff evaluates a new Power Apps plan before project dependency installation
- **THEN** it does not fail because `power-apps` or `pac` is absent from the global PATH
- **AND** it identifies root `npm ci` as the project-local setup action

#### Scenario: Installed project CLI is probed safely
- **WHEN** doctor runs in a Power Apps project whose dependencies are installed
- **THEN** it may invoke `npx --no-install power-apps --version` as a read-only probe
- **AND** it does not permit npx to download a missing package

### Requirement: Code Apps plugin readiness is optional and host-specific
The system SHALL derive a Code Apps plugin advisory only when the Power Apps plan enables that preference. It SHALL evaluate each selected coding-agent host independently through an allowlisted read-only probe when available, distinguish ready, missing, and not observable states, and SHALL NOT classify the plugin as a blocking framework or agent requirement.

#### Scenario: Plugin preference is disabled
- **WHEN** a Power Apps plan does not request the preview plugin
- **THEN** initialization and doctor omit plugin readiness results

#### Scenario: Plugin is observable for one selected agent
- **WHEN** Copilot reports the canonical plugin installed but Claude Code plugin state cannot be observed
- **THEN** Liftoff reports Copilot ready and Claude Code not observable
- **AND** the unobservable advisory does not block initialization

#### Scenario: No safe targeted installer exists
- **WHEN** the requested plugin is missing and the requirement registry has no target-specific noninteractive recipe
- **THEN** Liftoff prints pinned manual marketplace guidance
- **AND** `--install-tools` does not run Microsoft's broad installer or an agent-session slash command
