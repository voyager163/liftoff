## MODIFIED Requirements

### Requirement: Update refuses unsafe reconciliations
The system SHALL refuse to run when the configured project type, API stack, or GenAI pattern differs from the corresponding normalized identity recorded by the manifest, directing the developer to `liftoff migrate`. The system SHALL also refuse when the manifest's `liftoffVersion` is newer than the running CLI, using semver-aware comparison that orders prerelease versions correctly and directing the developer to upgrade the CLI.

#### Scenario: Project-type change is refused
- **WHEN** a developer changes a generated project's configured type between GenAI and standard and runs `liftoff update`
- **THEN** the command fails with a message that project-type changes require a migration

#### Scenario: API-stack change is refused
- **WHEN** a developer changes a standard project's configured API stack and runs `liftoff update`
- **THEN** the command fails with a message that API-stack changes require a migration

#### Scenario: Pattern change is refused
- **WHEN** a developer changes a GenAI project's configured pattern and runs `liftoff update`
- **THEN** the command fails with a message that pattern changes require a migration

#### Scenario: Legacy identity is compared after normalization
- **WHEN** a legacy manifest omits project type and API stack but records a GenAI pattern matching the configuration
- **THEN** update treats the identity as GenAI with Python/FastAPI and continues normal reconciliation

#### Scenario: Newer-generated project is refused
- **WHEN** the manifest records a `liftoffVersion` greater than the running CLI version
- **THEN** the command fails with a message to upgrade the CLI first
