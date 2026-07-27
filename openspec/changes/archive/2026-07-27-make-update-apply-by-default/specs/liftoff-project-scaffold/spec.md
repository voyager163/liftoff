## MODIFIED Requirements

### Requirement: Framework output has an explicit ownership boundary
The system SHALL distinguish Liftoff durable artifacts, framework-owned output, and write-once seed or overlay content. Liftoff SHALL hash and reconcile only its named durable artifacts, SHALL validate declared framework markers without adopting all framework files, and SHALL never delete or overwrite framework-owned files through pattern-based reconciliation.

#### Scenario: Update excludes framework-owned core files
- **WHEN** a framework CLI created scripts, commands, skills, or core templates that are not named Liftoff durable artifacts
- **THEN** plain `liftoff update` does not overwrite or delete those files

#### Scenario: Validation checks framework integration markers
- **WHEN** `liftoff validate` runs on a new project
- **THEN** it verifies every Liftoff durable artifact and the declared framework and selected-agent markers
- **AND** it does not require a Liftoff content hash for framework-owned files

#### Scenario: Liftoff seed content is not reconciled
- **WHEN** Liftoff writes an initial OpenSpec change, constitution, or supported framework configuration overlay
- **THEN** the content is available in the new project but is not treated as a normal update-managed template artifact
