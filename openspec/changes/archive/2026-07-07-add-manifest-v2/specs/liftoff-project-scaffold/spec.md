# liftoff-project-scaffold (delta)

## ADDED Requirements

### Requirement: Generated projects include a v2 Liftoff manifest
The system SHALL include a `liftoff.manifest.json` at the root of every generated project using manifest schema v2, recording the generating CLI version, the project decisions, and every generated artifact with its logical name, category, OS-neutral path parts, and `sha256:`-prefixed content hash.

#### Scenario: Manifest accompanies every generated project
- **WHEN** a developer creates a project with `liftoff create`
- **THEN** the project root contains a `liftoff.manifest.json` with `artifactVersion` 2, `liftoffVersion`, the project decisions, and one entry per generated artifact including its content hash

#### Scenario: Manifest validates against generated files
- **WHEN** `liftoff validate` runs against a freshly generated project
- **THEN** validation passes, confirming every manifest artifact exists on disk
