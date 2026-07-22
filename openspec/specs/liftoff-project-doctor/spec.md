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
The system SHALL read the project manifest to configure diagnostics: the cloud layer targets `project.cloud` (with `--cloud` acting as an override), worker-enabled Azure projects check for Azure Functions Core Tools at warn severity, and the project layer verifies the manifest loads and every listed artifact exists.

#### Scenario: Cloud checks come from the manifest
- **WHEN** doctor runs inside a project whose manifest records Azure
- **THEN** Azure authentication checks run without any `--cloud` flag

#### Scenario: Structure failures surface
- **WHEN** a manifest artifact is missing from disk
- **THEN** the project layer reports a failure naming the missing artifact

#### Scenario: Worker tooling check
- **WHEN** doctor runs inside a worker-enabled Azure project without Azure Functions Core Tools installed
- **THEN** the output includes a warning with an installation remedy

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
