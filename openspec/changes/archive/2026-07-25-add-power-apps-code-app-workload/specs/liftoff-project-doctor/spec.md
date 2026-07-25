## MODIFIED Requirements

### Requirement: The manifest configures project-aware checks
The system SHALL read the normalized manifest to configure diagnostics. Cloud checks SHALL target a declared API workload cloud with `--cloud` acting as an override; a workload without declared cloud infrastructure SHALL not inherit a default cloud. Environment and runtime checks SHALL target the selected workload, API stack when applicable, spec workflow, configured coding agents, optional requested integrations, and declared framework contract. The project layer SHALL verify that the manifest loads, every listed Liftoff artifact exists, and every declared framework integration marker is present.

#### Scenario: Cloud checks come from an API manifest
- **WHEN** doctor runs inside an API project whose manifest records Azure
- **THEN** Azure authentication checks run without any `--cloud` flag

#### Scenario: Power Apps does not inherit Azure checks
- **WHEN** doctor runs inside a Power Apps project without a `--cloud` override
- **THEN** no Azure, OpenTofu, Docker, backend, database, or API environment check is selected

#### Scenario: Structure failures surface
- **WHEN** a manifest artifact is missing from disk
- **THEN** the project layer reports a failure naming the missing artifact

#### Scenario: Worker tooling check
- **WHEN** doctor runs inside a worker-enabled Azure project without Azure Functions Core Tools installed
- **THEN** the output includes a warning with an installation remedy

#### Scenario: Framework checks come from the manifest
- **WHEN** doctor runs inside a supported project configured for Spec Kit, Copilot, and Claude Code
- **THEN** it checks the pinned Spec Kit contract and both recorded integrations without requiring a workflow flag

#### Scenario: Missing framework marker fails project readiness
- **WHEN** a manifest declares an initialized agent integration whose required marker is missing
- **THEN** the project layer reports a failure naming that integration and its framework-owned repair command

#### Scenario: Legacy v2 framework state is not fabricated
- **WHEN** doctor reads a supported v2 project with no agent or official initializer metadata
- **THEN** it reports a legacy framework-state warning
- **AND** it does not claim that Copilot, Claude Code, OpenSpec, or Spec Kit integration was officially initialized

### Requirement: Doctor evaluates the shared workstation requirement registry in probe-only mode
The system SHALL derive doctor checks from the same workload-aware requirement registry used by initialization, based on the discovered manifest when present. Doctor SHALL execute only allowlisted read-only probes and SHALL never invoke installers, allow npx downloads, alter PATH or shell configuration, initialize a framework, install project dependencies, authenticate, or persist observed tool versions.

#### Scenario: Doctor checks only selected API tools
- **WHEN** doctor runs inside a Go project configured for OpenSpec, Copilot, and Claude Code
- **THEN** it checks supported Node.js, Go, the pinned OpenSpec contract, both agents, and applicable advisory infrastructure tools
- **AND** it does not require the Python backend runtime or Spec Kit

#### Scenario: Doctor checks only selected Power Apps tools
- **WHEN** doctor runs inside a Power Apps project configured for OpenSpec and Claude Code
- **THEN** it checks the Power Apps Node.js baseline, the pinned OpenSpec contract, Claude Code, starter artifacts, and applicable project-local tooling
- **AND** it does not check Python, Go, Docker, OpenTofu, Azure CLI, or an unselected agent

#### Scenario: Doctor remains read-only with missing tools
- **WHEN** a required runtime or framework CLI is missing
- **THEN** doctor reports the missing requirement and exact platform remedy
- **AND** no installation command is executed

#### Scenario: Doctor JSON uses the same stable requirement identifiers
- **WHEN** a developer runs `liftoff doctor --json`
- **THEN** each workstation result includes the stable registry identifier, severity, observed state, and remedy

## ADDED Requirements

### Requirement: Doctor validates Power Apps project readiness
The system SHALL validate schema-v4 Power Apps projects through read-only checks for the pinned starter identity, required package and lockfile pair, Power Apps SDK and Vite plugin declarations, selected framework markers, selected coding agents, and tested Node.js LTS baseline. When dependencies are installed it MAY probe the project-local Code Apps CLI with `npx --no-install power-apps --version`; when they are absent it SHALL report the probe as skipped with the root `npm ci` remedy.

#### Scenario: Fresh Power Apps project is structurally ready
- **WHEN** doctor runs after Power Apps initialization with all manifest artifacts and framework markers present
- **THEN** the project layer reports the pinned starter and selected integrations as valid

#### Scenario: Package and lockfile identity differ
- **WHEN** the Power Apps root package name does not match the lockfile root package identity
- **THEN** doctor reports a project failure with a restore or update remedy

#### Scenario: Dependencies are not installed
- **WHEN** the Power Apps project has no installed project-local Code Apps CLI
- **THEN** doctor reports the CLI probe as skipped rather than successful
- **AND** it shows the exact root `npm ci` command

#### Scenario: Project-local CLI probe cannot download
- **WHEN** doctor probes an installed Power Apps project CLI
- **THEN** it uses `npx --no-install`
- **AND** a missing package is reported without any network installation attempt

### Requirement: Doctor reports requested Code Apps plugin readiness as advisory
The system SHALL check the preview Code Apps plugin only when the Power Apps manifest records the preference enabled. It SHALL report each selected agent host independently as ready, missing, or not observable, use warn severity for every non-ready plugin result, and provide pinned manual marketplace guidance without changing agent configuration.

#### Scenario: Requested plugin is installed for both agents
- **WHEN** both selected agent hosts report the canonical plugin installed
- **THEN** doctor reports both plugin checks as ready

#### Scenario: Requested plugin cannot be observed
- **WHEN** an agent exposes no allowlisted plugin-list probe
- **THEN** doctor reports that host as not observable with manual verification guidance
- **AND** the warning alone does not make doctor exit 1

#### Scenario: Plugin preference is disabled
- **WHEN** the Power Apps manifest records the plugin preference disabled
- **THEN** doctor omits Code Apps plugin checks
