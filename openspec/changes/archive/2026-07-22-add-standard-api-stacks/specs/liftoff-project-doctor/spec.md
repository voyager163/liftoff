## ADDED Requirements

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
