## ADDED Requirements

### Requirement: Governed projects include one deterministic setup entry point
When repository governance is enabled, the system SHALL generate
`/liftoff-setup` integrations for every selected agent and a managed
machine-readable phase definition. The integrations SHALL contain no model
selection and SHALL delegate state transitions to the Liftoff CLI.

#### Scenario: Generate Copilot setup
- **WHEN** GitHub Copilot is selected
- **THEN** the project includes a `/liftoff-setup` skill or prompt that invokes the deterministic governance commands

#### Scenario: Generate Claude setup
- **WHEN** Claude Code is selected
- **THEN** the project includes an equivalent `/liftoff-setup` skill or command with the same behavioral contract

#### Scenario: Generate both agents
- **WHEN** both agents are selected
- **THEN** their setup integrations reference the same managed phase graph and user-owned activation state
- **AND** neither integration declares or asks for a model

#### Scenario: Existing governance launcher is invoked
- **WHEN** a developer uses `/liftoff-repository-governance`
- **THEN** it acts as a compatibility alias for the governance portion of `/liftoff-setup`
- **AND** does not create a separate activation path

### Requirement: Generated manifests identify the activation contract
Governed projects SHALL use `liftoff.manifest.json` artifact version 7. The
manifest SHALL record the creating Liftoff semantic version, policy version,
activation-contract version, phase-graph schema version and content hash,
activation-state schema version, and applicable evidence, approval-envelope,
and credential-policy schema versions. Managed setup integrations SHALL retain
normal content hashes instead of introducing an independent skill version.

#### Scenario: Generate a governed project
- **WHEN** initialization writes the version 7 manifest and governance artifacts
- **THEN** every activation identity matches the generated policy, phase graph, schemas, and supported engine constants

#### Scenario: Setup integration wording changes
- **WHEN** only the thin skill or compatibility launcher bytes change
- **THEN** its managed content hash changes
- **AND** no setup-skill version changes or is introduced
