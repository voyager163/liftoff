## MODIFIED Requirements

### Requirement: Doctor reports version freshness and scaffold drift
The system SHALL always report the running CLI version and SHALL compare it with the stable version published by the authoritative registry using a short timeout regardless of whether a generated project exists. Inside a project, the system SHALL also compare the manifest's `liftoffVersion` against the running CLI and SHALL surface scaffold drift as a single warning line with a count and a pointer to `liftoff update`, using the update engine's check classification. Any registry network failure SHALL leave local diagnostics intact and suppress only the freshness result. Doctor SHALL remain read-only and SHALL direct supported installations to the explicit self-upgrade command rather than invoking it.

#### Scenario: Freshness check runs outside a project
- **WHEN** a developer runs doctor outside a generated project with registry access
- **THEN** the CLI layer reports the running Liftoff version
- **AND** it reports whether a newer stable version is published

#### Scenario: Authoritative registry is newer than the running CLI
- **WHEN** the authoritative registry reports a stable Liftoff version newer than the running CLI
- **THEN** doctor emits a warning naming both exact versions
- **AND** the primary remedy tells the developer to run `liftoff upgrade --check` and then `liftoff upgrade`
- **AND** it retains an exact manual npm command for unsupported installation origins or explicit recovery

#### Scenario: Configured managed mirror is stale
- **WHEN** a developer's configured npm mirror exposes an older Liftoff version than the authoritative registry lookup
- **THEN** doctor does not claim the running CLI is current based on the configured mirror
- **AND** the remedy states that self-upgrade remains blocked until the approved mirror exposes the canonical target
- **AND** doctor does not modify npm configuration or perform an automatic update

#### Scenario: Drift warning line
- **WHEN** doctor runs in a project with four reconcilable differences
- **THEN** the output contains one warning stating four updates are available and naming `liftoff update`
- **AND** it does not describe project drift as a CLI self-upgrade

#### Scenario: Offline doctor preserves local version diagnostics
- **WHEN** doctor runs without network access
- **THEN** all local checks complete normally and the running CLI version remains visible
- **AND** no freshness warning or error appears
