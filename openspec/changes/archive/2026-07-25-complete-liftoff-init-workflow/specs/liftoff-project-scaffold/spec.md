## ADDED Requirements

### Requirement: Selected spec workflows are initialized through their official CLI
The system SHALL create complete spec-driven framework infrastructure by running the exact tested official OpenSpec or Spec Kit CLI in the staged project. Liftoff SHALL validate the selected profile, framework markers, and integration output before committing the staged tree and SHALL NOT substitute a partial hand-written framework layout when the official command fails.

#### Scenario: Initialize OpenSpec officially
- **WHEN** a developer initializes a project with the OpenSpec workflow
- **THEN** Liftoff runs the pinned OpenSpec initializer with the core profile and every selected agent identifier in the staging root
- **AND** the committed project contains the official OpenSpec workflow and integration markers

#### Scenario: Initialize Spec Kit officially
- **WHEN** a developer initializes a project with the Spec Kit workflow
- **THEN** Liftoff runs the pinned Spec Kit initializer in the staging root using the selected default agent
- **AND** it installs and validates every additional selected integration through the official integration command

#### Scenario: Official initializer failure prevents project commit
- **WHEN** the selected framework CLI exits unsuccessfully or omits a required integration marker
- **THEN** Liftoff exits unsuccessfully and leaves the destination unchanged
- **AND** it does not fall back to Liftoff's former partial templates

### Requirement: Projects support GitHub Copilot and Claude Code together
The system SHALL configure the selected spec workflow for GitHub Copilot, Claude Code, or both. It SHALL map Liftoff's normalized agent identifiers to framework-owned integration identifiers and SHALL preserve the selected Spec Kit default while adding secondary integrations.

#### Scenario: Configure both agents for OpenSpec
- **WHEN** OpenSpec is selected with Copilot and Claude Code
- **THEN** the official initializer receives both tool identifiers in stable order
- **AND** the project contains valid integration output for both

#### Scenario: Configure both agents for Spec Kit
- **WHEN** Spec Kit is selected with Copilot as default and Claude Code as secondary
- **THEN** the official initializer creates Copilot's supported skills-based integration
- **AND** the official integration command installs Claude Code without changing the Copilot default

#### Scenario: Configure Copilot as a secondary Spec Kit integration
- **WHEN** Spec Kit is selected with Claude Code as default and Copilot as secondary
- **THEN** the Copilot integration is installed using the tested skills option rather than deprecated agent-file output

### Requirement: Framework output has an explicit ownership boundary
The system SHALL distinguish Liftoff durable artifacts, framework-owned output, and write-once seed or overlay content. Liftoff SHALL hash and reconcile only its named durable artifacts, SHALL validate declared framework markers without adopting all framework files, and SHALL never delete or overwrite framework-owned files through pattern-based reconciliation.

#### Scenario: Update excludes framework-owned core files
- **WHEN** a framework CLI created scripts, commands, skills, or core templates that are not named Liftoff durable artifacts
- **THEN** `liftoff update --apply` does not overwrite or delete those files

#### Scenario: Validation checks framework integration markers
- **WHEN** `liftoff validate` runs on a new project
- **THEN** it verifies every Liftoff durable artifact and the declared framework and selected-agent markers
- **AND** it does not require a Liftoff content hash for framework-owned files

#### Scenario: Liftoff seed content is not reconciled
- **WHEN** Liftoff writes an initial OpenSpec change, constitution, or supported framework configuration overlay
- **THEN** the content is available in the new project but is not treated as a normal update-managed template artifact

### Requirement: Generated documentation explains workstation and framework readiness
The system SHALL generate project documentation that identifies the selected spec workflow, all configured coding agents, the default agent when applicable, the framework-owned directories, deferred advisory tools, and exact stack-specific dependency and verification commands.

#### Scenario: Read configured workflow documentation
- **WHEN** a developer opens the generated project README
- **THEN** it names every configured agent and explains how to start the selected official spec workflow

#### Scenario: Read deferred-tool guidance
- **WHEN** initialization completed after an advisory Docker, OpenTofu, or Azure CLI requirement was declined
- **THEN** the completion output and generated setup guidance provide the exact readiness remedy without claiming the tool was installed

#### Scenario: Read project dependency commands
- **WHEN** a developer declines project dependency installation
- **THEN** the generated README contains the same stack-specific install command printed by Liftoff

## RENAMED Requirements

- FROM: `### Requirement: Generated projects include a v2 Liftoff manifest`
- TO: `### Requirement: Generated projects include a v3 Liftoff manifest`

## MODIFIED Requirements

### Requirement: Generated projects include a v3 Liftoff manifest
The system SHALL include a `liftoff.manifest.json` at the root of every generated project using manifest schema v3, recording the generating CLI version, project decisions, selected spec workflow, selected coding agents, applicable default agent, tested framework contract, and every durable Liftoff-generated artifact with its logical name, category, OS-neutral path parts, and `sha256:`-prefixed content hash. Framework-owned output and seed content SHALL be written and validated through their declared markers but SHALL NOT be recorded as durable hashed Liftoff artifacts.

#### Scenario: Manifest accompanies every initialized project
- **WHEN** a developer initializes a project with `liftoff init`
- **THEN** the project root contains a `liftoff.manifest.json` with `artifactVersion` 3, `liftoffVersion`, project decisions, framework and agent identity, and one entry per durable Liftoff artifact including its content hash

#### Scenario: Manifest validates against generated files
- **WHEN** `liftoff validate` runs against a freshly initialized project
- **THEN** validation passes, confirming every manifest artifact and declared framework integration marker exists on disk

#### Scenario: Seed content is written but not recorded
- **WHEN** a developer initializes a project with the OpenSpec workflow
- **THEN** the seeded bootstrap change exists under `openspec/changes/` and no durable manifest artifact entry references it

#### Scenario: Framework core output is not adopted as a durable artifact
- **WHEN** the official framework initializer writes its managed commands, skills, scripts, or templates
- **THEN** those paths are absent from the durable Liftoff artifact hash list
- **AND** the manifest records the deterministic framework contract and configured integrations instead

