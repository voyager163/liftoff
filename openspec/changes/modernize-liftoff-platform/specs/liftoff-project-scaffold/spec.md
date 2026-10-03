## MODIFIED Requirements

### Requirement: Generated projects include a v7 Liftoff manifest
New supported projects SHALL include the current schema-v8 manifest, retaining the ownership separation introduced by v7 and readable historical v2-v7 contracts. It SHALL record exact writer, workload, selected workflow/agents/profile, real framework state or explicit Manual not-required state, current plugin/layout identity, managed-core hashes and honest project provenance. It SHALL not include random telemetry identity, claim live governance, or grant managed ownership to framework/desired-state/seed files.

#### Scenario: Manifest accompanies every initialized workload
- **WHEN** an API or GenAI project is initialized
- **THEN** a v8 manifest records exactly its applicable identities and ownership

#### Scenario: Manifest validates against generated files
- **WHEN** validation runs on a fresh project
- **THEN** managed hashes and applicable real integration markers validate without requiring project source to retain generation bytes forever

#### Scenario: Enabled governance records only handoff state
- **WHEN** either enabled profile is selected
- **THEN** the manifest records its current policy/activation identity and handoff state, not live enforcement

#### Scenario: Disabled governance omits handoff artifacts
- **WHEN** none is selected
- **THEN** governance policy/setup/assessment artifacts are omitted while independently selected local tools retain their exact contracts

#### Scenario: GenAI manifest records the selected pattern without fabricating specialization
- **WHEN** any supported pattern is selected
- **THEN** its real identity/limits remain distinct from unimplemented product behavior

#### Scenario: Power Apps manifest omits API identity
- **WHEN** a retired Power Apps request is encountered
- **THEN** no current supported scaffold/manifest is emitted and existing bytes remain unchanged

#### Scenario: Framework and seed ownership remains external
- **WHEN** an external initializer or seed produces files
- **THEN** those files remain outside managed-core hashes

### Requirement: Selected spec workflows are initialized through their official CLI
OpenSpec and Spec Kit SHALL continue using their exact tested official CLIs in staging, with the complete supported OpenSpec custom/both workflow inventory and validated selected-agent output. Failed official initialization SHALL not fall back to hand-written partial framework output. Manual SHALL instead explicitly skip external framework installation, initialization, global profile access and marker/seed generation while retaining applicable Liftoff validation and optional agent integrations.

#### Scenario: Initialize OpenSpec officially
- **WHEN** OpenSpec is selected
- **THEN** its pinned initializer receives the required profile and selected agents and complete native workflow output is validated

#### Scenario: Fresh OpenSpec output has no immediate profile drift
- **WHEN** the same pinned initializer is repeated with unchanged selections
- **THEN** the fresh generated framework is already aligned with the tested contract

#### Scenario: Initialize Spec Kit officially
- **WHEN** Spec Kit is selected
- **THEN** pinned official initialization establishes the default and secondary integrations without changing the selected default

#### Scenario: Official initializer failure prevents project commit
- **WHEN** an applicable initializer or marker validation fails
- **THEN** the destination remains unchanged and no partial substitute framework is created

#### Scenario: Initialize Manual without tools
- **WHEN** Manual is selected with no agents
- **THEN** no OpenSpec/Spec Kit process, files, profile read or agent integration is required
- **AND** all applicable application and Liftoff checks still run

### Requirement: Generated manifests identify the activation contract
Current governed projects SHALL record manifest v8 and the exact release-owned profile/workflow-aware activation vector with computed graph hash. Historical `0.12.0`/v7 and earlier identities SHALL remain explicit source contracts, not automatically current proof. CLI, policy, activation, report, repair and schema versions SHALL remain independent. Integration wording changes use managed hashes without independent skill SemVer.

#### Scenario: Generate a governed project
- **WHEN** current generation writes manifest and governance artifacts
- **THEN** all identities match the actual packaged profile, workflow, graph and constants
- **AND** no placeholder graph hash or historical target tuple is substituted

#### Scenario: Setup integration wording changes
- **WHEN** only integration wording changes
- **THEN** its managed hash changes without retagging historical activation proof

## ADDED Requirements

### Requirement: Manual output is complete without a replacement spec framework
Manual output SHALL include applicable project/runtime/infrastructure/docs and selected Liftoff integrations, but SHALL not generate mandatory proposal/design/tasks, a constitution, framework directories or a fictional archive. Documentation SHALL provide actual CLI-only actions when no agent is selected and equivalent optional native skills otherwise. Selecting Manual SHALL not disable the chosen governance profile.

#### Scenario: Manual team-governed application
- **WHEN** Manual and team GitFlow are selected without an agent
- **THEN** the project receives the selected application and governance handoff with actual CLI guidance
- **AND** peer-review and mutation-approval requirements are not removed

#### Scenario: Manual output is generated on Windows
- **WHEN** the same Manual plan renders on Windows, macOS and Linux
- **THEN** explicit artifact identities/path parts and bytes are deterministic and native destination guards apply

### Requirement: Template extraction does not force existing project relocation
New generation SHALL retain the selected canonical stack layout and exact artifact inventory after plugin extraction. Existing projects SHALL retain separately approved compatible active bindings; a codebase or template-directory refactor SHALL not itself create application migration debt or expand managed-core authority.

#### Scenario: Liftoff moves a template into a plugin asset area
- **WHEN** the template's user-facing contract is unchanged
- **THEN** fresh generated bytes remain equivalent and existing applications receive no automatic file move
