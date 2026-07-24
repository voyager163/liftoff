## ADDED Requirements

### Requirement: Doctor evaluates the shared workstation requirement registry in probe-only mode
The system SHALL derive doctor checks from the same requirement registry used by initialization, based on the discovered manifest when present. Doctor SHALL execute only read-only probes and SHALL never invoke installers, alter PATH or shell configuration, initialize a framework, install project dependencies, or persist observed tool versions.

#### Scenario: Doctor checks only selected tools
- **WHEN** doctor runs inside a Go project configured for OpenSpec, Copilot, and Claude Code
- **THEN** it checks supported Node.js, Go, the pinned OpenSpec contract, both agents, and applicable advisory infrastructure tools
- **AND** it does not require the Python backend runtime or Spec Kit

#### Scenario: Doctor remains read-only with missing tools
- **WHEN** a required runtime or framework CLI is missing
- **THEN** doctor reports the missing requirement and exact platform remedy
- **AND** no installation command is executed

#### Scenario: Doctor JSON uses the same stable requirement identifiers
- **WHEN** a developer runs `liftoff doctor --json`
- **THEN** each workstation result includes the stable registry identifier, severity, observed state, and remedy

### Requirement: Doctor reports selected AI coding-agent readiness honestly
The system SHALL check every agent recorded by manifest v3. Copilot SHALL be present when its CLI probe succeeds or an observable VS Code extension list contains the supported Copilot identifiers. Claude Code SHALL be present when its CLI probe succeeds, and its doctor result SHALL be reported without Liftoff automating authentication.

#### Scenario: Copilot CLI is detected
- **WHEN** the manifest selects Copilot and `copilot --version` succeeds
- **THEN** doctor reports the Copilot installation as ready

#### Scenario: VS Code Copilot extension is detected
- **WHEN** the Copilot CLI is absent, `code --list-extensions` succeeds, and the list contains `GitHub.copilot` or `GitHub.copilot-chat` case-insensitively
- **THEN** doctor reports Copilot as installed through VS Code

#### Scenario: VS Code extension state is not observable
- **WHEN** the Copilot CLI and the `code` command are both unavailable
- **THEN** doctor reports Copilot as not observable rather than claiming the extension is absent
- **AND** it offers the supported Copilot CLI installation remedy

#### Scenario: Claude authentication remains external
- **WHEN** `claude --version` succeeds but `claude doctor` reports an authentication problem
- **THEN** doctor reports Claude Code as installed with an authentication warning and agent-owned remedy
- **AND** it does not request credentials

### Requirement: Doctor distinguishes blocking and advisory workstation readiness
The system SHALL preserve each selected requirement's blocking or advisory classification in human and JSON output. Missing blocking requirements SHALL contribute a failure, while missing advisory infrastructure tools SHALL contribute warnings and SHALL never be reported as successful.

#### Scenario: Missing selected runtime fails doctor
- **WHEN** the selected backend runtime is missing
- **THEN** doctor records a failure and exits 1

#### Scenario: Missing deferred infrastructure tool warns
- **WHEN** Docker, OpenTofu, or Azure CLI is applicable but missing
- **THEN** doctor records a warning with the exact remedy
- **AND** the warning alone does not make doctor exit 1

## MODIFIED Requirements

### Requirement: The manifest configures project-aware checks
The system SHALL read the project manifest to configure diagnostics: the cloud layer targets `project.cloud` with `--cloud` acting as an override; the environment and runtime layers target the selected API stack, spec workflow, configured coding agents, and declared framework contract; worker-enabled Azure projects check for Azure Functions Core Tools at warn severity; and the project layer verifies the manifest loads, every listed Liftoff artifact exists, and every declared framework integration marker is present.

#### Scenario: Cloud checks come from the manifest
- **WHEN** doctor runs inside a project whose manifest records Azure
- **THEN** Azure authentication checks run without any `--cloud` flag

#### Scenario: Structure failures surface
- **WHEN** a manifest artifact is missing from disk
- **THEN** the project layer reports a failure naming the missing artifact

#### Scenario: Worker tooling check
- **WHEN** doctor runs inside a worker-enabled Azure project without Azure Functions Core Tools installed
- **THEN** the output includes a warning with an installation remedy

#### Scenario: Framework checks come from the manifest
- **WHEN** doctor runs inside a v3 project configured for Spec Kit, Copilot, and Claude Code
- **THEN** it checks the pinned Spec Kit contract and both recorded integrations without requiring a workflow flag

#### Scenario: Missing framework marker fails project readiness
- **WHEN** a v3 manifest declares an initialized agent integration whose required marker is missing
- **THEN** the project layer reports a failure naming that integration and its framework-owned repair command

#### Scenario: Legacy v2 framework state is not fabricated
- **WHEN** doctor reads a supported v2 project with no agent or official initializer metadata
- **THEN** it reports a legacy framework-state warning
- **AND** it does not claim that Copilot, Claude Code, OpenSpec, or Spec Kit integration was officially initialized

