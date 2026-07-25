## MODIFIED Requirements

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