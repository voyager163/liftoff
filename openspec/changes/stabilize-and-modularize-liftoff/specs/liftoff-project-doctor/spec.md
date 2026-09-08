## MODIFIED Requirements

### Requirement: Doctor runs layered diagnostics selected by context
The system SHALL run `liftoff doctor` as layered read-only diagnostics with CLI and environment layers in every context; project, runtime, and cloud-from-manifest layers SHALL run only when a supported generated project is located via project-root discovery, and cloud checks SHALL also run outside a project when `--cloud` is passed. A malformed, unreadable, dangling, symlinked, or retired manifest boundary SHALL stop project discovery with an error rather than falling back to an outer project or ordinary environment-only execution for that same path.

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

#### Scenario: Broken inner manifest blocks outer-project fallback
- **WHEN** a nested directory contains a malformed, unreadable, dangling, or retired `liftoff.manifest.json` and an ancestor contains a different valid project
- **THEN** doctor stops at the nested boundary with an error
- **AND** it does not walk outward to diagnose the ancestor project instead

### Requirement: The manifest configures project-aware checks
The system SHALL read the normalized manifest to configure diagnostics. Cloud checks SHALL target a declared API workload cloud with `--cloud` acting as an override; a workload without declared cloud infrastructure SHALL not inherit a default cloud. Environment and runtime checks SHALL target the selected supported workload, API stack when applicable, spec workflow, configured coding agents, optional requested integrations, and declared framework contract. The project layer SHALL verify that the manifest loads, required managed-core artifacts exist, and declared framework integration markers are present; project provenance SHALL NOT become an additional managed-file existence or restoration contract. A retired workload discriminator SHALL be rejected before deeper workload-specific diagnostic selection.

#### Scenario: Cloud checks come from an API manifest
- **WHEN** doctor runs inside an API project whose manifest records Azure
- **THEN** Azure authentication checks run without any `--cloud` flag

#### Scenario: Structure failures surface
- **WHEN** a required managed-core manifest artifact is missing from disk
- **THEN** the project layer reports a failure naming the missing artifact

#### Scenario: Power Apps does not inherit Azure checks
- **WHEN** doctor encounters a retired Power Apps manifest
- **THEN** it reports unsupported workload before Azure or former Power Apps diagnostic selection

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

#### Scenario: Retired workload manifest is rejected before deeper checks
- **WHEN** doctor reads a manifest whose workload discriminator is `power-apps-code-app`
- **THEN** it exits with an unsupported retired-workload error before selecting workload-specific runtime, dependency, or cloud checks

### Requirement: Doctor evaluates the shared workstation requirement registry in probe-only mode
The system SHALL derive doctor checks from the same workload-aware requirement registry used by initialization, based on the discovered manifest when present. Doctor SHALL execute only allowlisted read-only probes and SHALL never invoke installers, allow npx downloads, alter PATH or shell configuration, initialize a framework, install project dependencies, authenticate, or persist observed tool versions. It SHALL check required package managers separately when the selected supported workload depends on them.

#### Scenario: Doctor checks only selected API tools
- **WHEN** doctor runs inside a Go project configured for OpenSpec, Copilot, and Claude Code
- **THEN** it checks supported Node.js, Go, the pinned OpenSpec contract, both agents, and applicable advisory infrastructure tools
- **AND** it does not require the Python backend runtime or Spec Kit

#### Scenario: Doctor checks required npm availability
- **WHEN** doctor runs inside a supported Node.js project or another supported project whose recorded dependency commands require npm
- **THEN** it reports npm readiness as its own workstation result
- **AND** it does not treat a detected `node` executable as sufficient evidence that npm is ready

#### Scenario: Doctor checks only selected Power Apps tools
- **WHEN** doctor encounters a retired Power Apps workload
- **THEN** it rejects the workload rather than probing a former Power Apps-specific tool set

#### Scenario: Doctor remains read-only with missing tools
- **WHEN** a required runtime or framework CLI is missing
- **THEN** doctor reports the missing requirement and exact platform remedy
- **AND** no installation command is executed

#### Scenario: Doctor JSON uses the same stable requirement identifiers
- **WHEN** a developer runs `liftoff doctor --json`
- **THEN** each workstation result includes the stable registry identifier, severity, observed state, and remedy

### Requirement: Doctor validates locked dependency readiness
The system SHALL use the supported-stack baseline and explicit supported workload identity to check that every expected dependency manifest and lock pair exists, agrees on project identity, and can be consumed without mutation. Doctor SHALL remain read-only and SHALL report missing, stale, malformed, or mismatched metadata with the exact frozen install or repair command.

#### Scenario: Check a locked Python project
- **WHEN** doctor runs inside a Python project with `pyproject.toml` and `uv.lock`
- **THEN** it verifies the expected lock is present and reports `uv sync --frozen` as the dependency command
- **AND** it does not run `uv lock` or change either file

#### Scenario: Check npm and Go metadata
- **WHEN** doctor runs inside a Node.js, frontend-enabled API, or Go project
- **THEN** it validates the explicit package-lock or module-checksum pair applicable to that workload
- **AND** it omits unrelated ecosystem checks

#### Scenario: Lock metadata is missing
- **WHEN** an expected lockfile or checksum file is absent
- **THEN** doctor reports a failure naming the missing path and baseline-owned dependency set
- **AND** it does not report dependency readiness as successful

#### Scenario: Check paths on Windows
- **WHEN** doctor resolves dependency files in a project on Windows
- **THEN** it uses the same explicit path-part definitions as generation
- **AND** produces the same logical check identifiers as macOS and Linux

### Requirement: Doctor reports selected AI coding-agent readiness honestly
The system SHALL check every agent recorded by the current supported manifest. Copilot SHALL be present when its CLI probe succeeds or an observable VS Code extension list contains the supported Copilot identifiers. Claude Code SHALL be present when its CLI probe succeeds, and its doctor result SHALL be reported without Liftoff automating authentication.

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

## REMOVED Requirements

### Requirement: Doctor validates Power Apps project readiness
**Reason**: Full Power Apps retirement removes the only supported workload that depended on starter-specific Code Apps and package-identity diagnostics.

**Migration**: Doctor now rejects retired `power-apps-code-app` manifests before workload-specific checks. Supported API and GenAI projects continue to use their explicit runtime, dependency, framework, and managed-core diagnostics.

### Requirement: Doctor reports requested Code Apps plugin readiness as advisory
**Reason**: The preview Code Apps plugin was only relevant to the retired Power Apps workload.

**Migration**: Doctor no longer derives or reports plugin readiness from project manifests. Supported workloads continue to report only their remaining selected agents and workstation prerequisites.
