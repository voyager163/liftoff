# liftoff-project-scaffold (delta)

## MODIFIED Requirements

### Requirement: Generated projects include a v2 Liftoff manifest
The system SHALL include a `liftoff.manifest.json` at the root of every generated project using manifest schema v2, recording the generating CLI version, the project decisions, and every durable generated artifact with its logical name, category, OS-neutral path parts, and `sha256:`-prefixed content hash. Seed content — starter material such as the seeded OpenSpec change, which is written once at generation and then follows its own lifecycle — SHALL be written to disk but SHALL NOT be recorded in the manifest.

#### Scenario: Manifest accompanies every generated project
- **WHEN** a developer creates a project with `liftoff create`
- **THEN** the project root contains a `liftoff.manifest.json` with `artifactVersion` 2, `liftoffVersion`, the project decisions, and one entry per durable generated artifact including its content hash

#### Scenario: Manifest validates against generated files
- **WHEN** `liftoff validate` runs against a freshly generated project
- **THEN** validation passes, confirming every manifest artifact exists on disk

#### Scenario: Seed content is written but not recorded
- **WHEN** a developer creates a project with the OpenSpec workflow
- **THEN** the seeded bootstrap change exists under `openspec/changes/` and no manifest entry references it
