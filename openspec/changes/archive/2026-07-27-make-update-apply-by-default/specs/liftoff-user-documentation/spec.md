## ADDED Requirements

### Requirement: Update guidance uses the imperative command matrix
The system SHALL document `liftoff update` as an imperative safe reconciliation command, `liftoff update --force` as explicit conflict overwrite, `liftoff update --check` as the read-only human check, and `liftoff update --check --json` as the read-only machine check. Public, packaged, generated-project, troubleshooting, safety, and existing-repository guidance SHALL NOT instruct users to run the removed `--apply` flag.

#### Scenario: Developer wants to update a project
- **WHEN** a developer reads update guidance
- **THEN** the primary command is plain `liftoff update`
- **AND** the guidance explains that safe managed changes apply immediately while conflicts and orphans remain untouched

#### Scenario: Automation wants a drift gate
- **WHEN** automation needs a read-only result
- **THEN** guidance uses `liftoff update --check --json`
- **AND** it documents exit code 0 for clean state and 2 for drift

#### Scenario: Developer reviews conflict overwrite
- **WHEN** a developer needs to replace locally modified managed files
- **THEN** guidance requires reviewing `liftoff update --check` output before running `liftoff update --force`

#### Scenario: Existing apply syntax is encountered
- **WHEN** a user follows old guidance or a script containing `liftoff update --apply`
- **THEN** current migration guidance states that `--apply` was removed and maps it to plain `liftoff update`
