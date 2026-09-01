## RENAMED Requirements

- FROM: `### Requirement: Framework output has an explicit ownership boundary`
- TO: `### Requirement: Generated output has an explicit ownership boundary`

## MODIFIED Requirements

### Requirement: Generated output has an explicit ownership boundary
The system SHALL distinguish Liftoff managed-core artifacts, project-owned scaffold artifacts, developer-owned desired state, framework-owned output, and write-once seed or overlay content. Initial generation SHALL write the complete resolved scaffold transactionally, but only exact managed-core logical artifacts SHALL retain post-generation hash authority. Project artifacts SHALL retain generation provenance without becoming update-managed. Liftoff SHALL validate declared framework markers without adopting all framework files and SHALL never infer ownership from directory patterns.

#### Scenario: Initialization writes the complete scaffold
- **WHEN** a developer initializes any supported workload
- **THEN** Liftoff writes the resolved application, dependency, container, environment, documentation, infrastructure, framework, seed, desired-state, core, and manifest output
- **AND** the completed manifest records each applicable ownership class

#### Scenario: Update excludes project-owned files
- **WHEN** generated application source, dependencies, schemas, containers, environment files, documentation, or infrastructure become production assets
- **THEN** plain update and force cannot overwrite, restore, move, or delete them

#### Scenario: Update excludes framework-owned core files
- **WHEN** a framework CLI created scripts, commands, skills, or core templates that are not named Liftoff managed-core artifacts
- **THEN** plain `liftoff update` does not overwrite or delete those files

#### Scenario: Validation checks framework integration markers
- **WHEN** `liftoff validate` runs on a generated project
- **THEN** it verifies every managed-core artifact and declared framework and selected-agent marker
- **AND** it validates project provenance structurally without requiring project files to retain generation bytes or locations

#### Scenario: Liftoff seed content is not reconciled
- **WHEN** Liftoff writes an initial OpenSpec change, constitution, or supported framework configuration overlay
- **THEN** the content is available in the new project but is not treated as an update-managed core artifact

#### Scenario: Windows ownership paths remain confined
- **WHEN** initialization or validation resolves artifact paths on Windows
- **THEN** every ownership class uses OS-neutral path parts and platform-correct path resolution
- **AND** traversal, embedded separators, absolute paths, and project-boundary escapes are rejected before access
