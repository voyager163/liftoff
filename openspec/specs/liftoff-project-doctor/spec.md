## Purpose

Define the layered, read-only `liftoff doctor` diagnostics covering environment, project, runtime, and cloud readiness, configured by the project manifest.

## Requirements

### Requirement: Doctor runs layered diagnostics selected by context
The system SHALL run `liftoff doctor` as layered read-only diagnostics — environment, project, runtime, and cloud — where the project, runtime, and cloud-from-manifest layers run only when a generated project is located via project-root discovery. Outside a generated project, doctor SHALL preserve its prior behavior: environment checks plus cloud checks only when `--cloud` is passed.

#### Scenario: Full preflight inside a project
- **WHEN** a developer runs `liftoff doctor` inside a generated project
- **THEN** the output reports environment, project, runtime, and cloud layers grouped and labeled

#### Scenario: Unchanged behavior outside a project
- **WHEN** a developer runs `liftoff doctor` outside any generated project without flags
- **THEN** only the environment checks run

#### Scenario: Doctor never writes
- **WHEN** any doctor run completes
- **THEN** no file in the project or environment has been created or modified

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

### Requirement: Doctor reports version freshness and scaffold drift
The system SHALL compare the manifest's `liftoffVersion` against the running CLI and SHALL surface scaffold drift as a single warning line with a count and a pointer to `liftoff update`, using the update engine's check classification; a newer-CLI availability lookup against the npm registry SHALL use a short timeout and skip silently on any network failure.

#### Scenario: Drift warning line
- **WHEN** doctor runs in a project with four reconcilable differences
- **THEN** the output contains one warning stating four updates are available and naming `liftoff update`

#### Scenario: Offline doctor stays quiet about freshness
- **WHEN** doctor runs without network access
- **THEN** all local checks complete normally and no freshness warning or error appears

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
