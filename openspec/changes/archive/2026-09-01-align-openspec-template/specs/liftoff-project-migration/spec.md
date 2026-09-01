## MODIFIED Requirements

### Requirement: Migration targets use the complete workstation and framework pipeline
The system SHALL apply the same plan-derived workstation readiness, global OpenSpec profile compatibility and consent, selected-agent configuration, cloud-agent choice, staged official framework initialization, and optional project dependency phase to a migration target as to a new initialized project. The migration source SHALL remain read-only throughout these phases.

#### Scenario: Missing migration target prerequisite
- **WHEN** a resolved migration plan requires a missing blocking runtime, framework CLI, or compatible OpenSpec global profile
- **THEN** Liftoff obtains the same separate authorization used by `init`
- **AND** it writes neither the source nor target before blocking requirements are ready

#### Scenario: Configure both agents in a migration target
- **WHEN** a migration plan selects OpenSpec with Copilot and Claude Code
- **THEN** the fresh target's official framework setup contains skills and commands for all 12 required workflows for both integrations
- **AND** the source project receives no framework files

#### Scenario: Configure the cloud agent only in the migration target
- **WHEN** an OpenSpec migration plan selects GitHub Copilot and enables the cloud coding agent
- **THEN** the two cloud-agent files and matching OpenSpec config value are written only under the fresh target
- **AND** the source project remains unchanged

#### Scenario: Dependency installation affects only the target
- **WHEN** `--install-dependencies` is authorized for a completed migration scaffold
- **THEN** Liftoff runs the selected stack's dependency commands with working directories under the new target
- **AND** it never runs a dependency command from the source path

#### Scenario: Machine installation does not weaken source safety
- **WHEN** migration installs a selected machine tool or configures the authorized global OpenSpec profile outside either project
- **THEN** the source project tree remains byte-for-byte unchanged
- **AND** the machine change is reported separately from source and target writes
