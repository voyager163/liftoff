## Purpose

Define the layered, read-only `liftoff doctor` diagnostics covering environment, project, runtime, and cloud readiness, configured by the project manifest.

## Requirements

### Requirement: Doctor runs layered diagnostics selected by context
The system SHALL run `liftoff doctor` as layered read-only diagnostics with CLI and environment layers in every context; project, runtime, and cloud-from-manifest layers SHALL run only when a generated project is located via project-root discovery, and cloud checks SHALL also run outside a project when `--cloud` is passed.

#### Scenario: Full preflight inside a project
- **WHEN** a developer runs `liftoff doctor` inside a generated project
- **THEN** the output reports CLI, environment, project, runtime, and cloud layers grouped and labeled

#### Scenario: Diagnostics outside a project
- **WHEN** a developer runs `liftoff doctor` outside any generated project without flags
- **THEN** only the CLI and environment layers run

#### Scenario: Doctor never writes
- **WHEN** any doctor run completes
- **THEN** no file in the project or environment has been created or modified
- **AND** npm registry configuration remains unchanged

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

### Requirement: Doctor reports version freshness and scaffold drift
The system SHALL always report the running CLI version and SHALL compare it with the stable version published by the authoritative registry using a short timeout regardless of whether a generated project exists. Inside a project, the system SHALL also compare the manifest's `liftoffVersion` against the running CLI and SHALL surface scaffold drift as a single warning line with a count and a pointer to `liftoff update`, using the update engine's check classification. Any registry network failure SHALL leave local diagnostics intact and suppress only the freshness result.

#### Scenario: Freshness check runs outside a project
- **WHEN** a developer runs doctor outside a generated project with registry access
- **THEN** the CLI layer reports the running Liftoff version
- **AND** it reports whether a newer stable version is published

#### Scenario: Authoritative registry is newer than the running CLI
- **WHEN** the authoritative registry reports a stable Liftoff version newer than the running CLI
- **THEN** doctor emits a warning naming both exact versions
- **AND** the remedy tells the developer to install the exact newer version through an approved registry that exposes it
- **AND** the remedy identifies the canonical npm registry command for environments where direct public access is permitted

#### Scenario: Configured managed mirror is stale
- **WHEN** a developer's configured npm mirror exposes an older Liftoff version than the authoritative registry lookup
- **THEN** doctor does not claim the running CLI is current based on the configured mirror
- **AND** doctor does not modify npm configuration or perform an automatic update

#### Scenario: Drift warning line
- **WHEN** doctor runs in a project with four reconcilable differences
- **THEN** the output contains one warning stating four updates are available and naming `liftoff update`

#### Scenario: Offline doctor preserves local version diagnostics
- **WHEN** doctor runs without network access
- **THEN** all local checks complete normally and the running CLI version remains visible
- **AND** no freshness warning or error appears

### Requirement: Runtime readiness checks degrade honestly
The system SHALL check that `.env` exists when `.env.example` is present and that the Docker Compose configuration parses when a compose file exists and docker is available; when a runtime check's prerequisites are missing, the system SHALL report the check as skipped with the reason rather than passing or failing it.

#### Scenario: Missing env file
- **WHEN** the project contains `.env.example` but no `.env`
- **THEN** doctor reports a failure with the copy remedy

#### Scenario: Compose check skipped without docker
- **WHEN** docker is not installed and a compose file exists
- **THEN** doctor reports the compose check as skipped because docker is missing

### Requirement: Doctor uses the shared severity, remedy, and output model
The system SHALL classify every check as ok, warn, or fail; SHALL print a one-line remedy for every non-ok result; SHALL exit 0 when at most warnings occurred and 1 when any check failed; and SHALL support `--json` output carrying `schemaVersion`, per-layer results, and a summary.

#### Scenario: Warnings do not fail the run
- **WHEN** doctor completes with warnings and no failures
- **THEN** the exit code is 0

#### Scenario: Any failure fails the run
- **WHEN** at least one check fails
- **THEN** the exit code is 1 and each failure line includes its remedy

#### Scenario: Machine-readable output
- **WHEN** a developer runs `liftoff doctor --json`
- **THEN** the output is a JSON object with `schemaVersion`, layer results with severities and remedies, and summary counts

### Requirement: Doctor checks the selected API runtime
The system SHALL use the normalized manifest project identity to run API-stack-specific runtime diagnostics in addition to shared CLI, Docker, project, and cloud checks.

#### Scenario: Check Python project runtime
- **WHEN** doctor runs inside a `python-fastapi` project
- **THEN** it reports whether the supported Python runtime is available and provides an installation remedy when it is missing

#### Scenario: Check Node.js project runtime
- **WHEN** doctor runs inside a `node-fastify` project
- **THEN** it reports whether the supported Node.js runtime is available for the generated backend

#### Scenario: Check Go project runtime
- **WHEN** doctor runs inside a `go-huma` project
- **THEN** it reports whether the supported Go toolchain is available and provides an installation remedy when it is missing

#### Scenario: Do not require unrelated runtimes
- **WHEN** doctor runs inside a standard project
- **THEN** runtimes used only by other API stacks are reported as not applicable or are omitted rather than failing the project

### Requirement: Doctor validates stack-specific generated configuration honestly
The system SHALL run read-only validation commands only when the selected stack's generated configuration and required local tool are present, and SHALL report a skipped result with the reason when validation cannot run.

#### Scenario: Validate available stack tooling
- **WHEN** doctor runs inside a generated project and the selected stack's local toolchain is available
- **THEN** it performs the stack-appropriate read-only project or configuration check and reports the result

#### Scenario: Skip unavailable stack validation
- **WHEN** the selected stack's optional validation command cannot run because its toolchain is unavailable
- **THEN** doctor reports the validation as skipped or failed according to whether the runtime is required
- **AND** it does not report a successful check

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
