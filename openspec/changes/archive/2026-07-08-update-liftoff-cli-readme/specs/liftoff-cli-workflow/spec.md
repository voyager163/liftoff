## ADDED Requirements

### Requirement: Packaged README documents the current CLI lifecycle
The system SHALL document the current Liftoff CLI lifecycle in the packaged root `README.md`, including first-use commands, project creation and migration flows, project validation and diagnostics, update reconciliation, and local development/infrastructure helper commands.

#### Scenario: Review first-use workflow
- **WHEN** a developer reads the Liftoff CLI README after installing or inspecting `@msn-control/liftoff`
- **THEN** the README shows a quick-start path that includes previewing or creating a project, validating it, running diagnostics, and starting local development

#### Scenario: Review command lifecycle
- **WHEN** a developer reads the command workflow documentation
- **THEN** the README explains the roles of `plan`, `create`, `migrate`, `validate`, `doctor`, `update`, `dev`, and `infra`

#### Scenario: Understand update safety
- **WHEN** a developer reads the update documentation
- **THEN** the README states that `liftoff update` checks for drift without writing by default, `liftoff update --apply` writes safe changes, conflicts require `--force` to overwrite, and orphaned files are not automatically deleted

#### Scenario: Understand machine-readable and exit-code behavior
- **WHEN** a developer reads the lifecycle or contract documentation
- **THEN** the README states that check-mode drift uses exit code 2 and that JSON-capable commands emit a top-level numeric `schemaVersion`