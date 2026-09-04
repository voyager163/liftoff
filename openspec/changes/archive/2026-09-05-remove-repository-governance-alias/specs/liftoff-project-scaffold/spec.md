## MODIFIED Requirements

### Requirement: Generated projects include a v7 Liftoff manifest
The system SHALL include `liftoff.manifest.json` at the root of every generated project using manifest schema v7. It SHALL record the manifest-writing CLI version, discriminated workload identity, selected spec workflow, selected coding agents, applicable default agent, tested framework contract, repository-governance profile and handoff state, activation identity, optional workload preferences, managed-core artifacts with reconciliation hashes, and project artifacts with generation provenance. Framework-owned, desired-state, and one-time seed content SHALL remain outside managed-core hash authority.

#### Scenario: Manifest accompanies every initialized workload
- **WHEN** a developer initializes a GenAI, standard API, or Power Apps project
- **THEN** the project root contains a schema-v7 manifest with exactly the workload, governance, managed-core, and project-provenance fields applicable to that project

#### Scenario: Manifest validates against generated files
- **WHEN** `liftoff validate` runs against a freshly initialized project
- **THEN** validation confirms every managed-core artifact and declared framework integration marker while structurally validating project provenance without requiring production bytes to remain unchanged

#### Scenario: Enabled governance records only handoff state
- **WHEN** a project enables `single-maintainer-gitflow`
- **THEN** its v7 manifest records the profile, policy version, activation identity, and `handoff-generated` state
- **AND** it does not claim live GitHub enforcement

#### Scenario: Disabled governance omits handoff artifacts
- **WHEN** a project selects `none`
- **THEN** its v7 manifest records governance as disabled
- **AND** contains no managed governance policy, context, guide, or setup integration entry

#### Scenario: Power Apps manifest omits API identity
- **WHEN** a Power Apps code app is initialized
- **THEN** its v7 workload identity records the pinned starter source and plugin preference
- **AND** it does not invent an API stack, GenAI pattern, cloud, region, API frontend flag, or API environments

#### Scenario: Framework and seed ownership remains external
- **WHEN** an official framework initializer or Liftoff seed writes content
- **THEN** those files are validated by their declared contracts without being added to managed-core hash authority
- **AND** the separate repository-governance handoff remains managed by exact logical name

### Requirement: Governance handoff participates in transactional staging
Enabled governance artifacts SHALL be rendered into the same temporary staging area, assigned explicit managed-core ownership, validated, preflighted, and merged under the same collision, symlink, authorization, lock, and rollback contract as other Liftoff-generated files.

#### Scenario: Governance setup integration collides with a file
- **WHEN** an existing target contains different bytes at an enabled governance setup-integration path
- **THEN** initialization reports that exact regular-file replacement
- **AND** does not overwrite it without the existing interactive authorization or `--force`

#### Scenario: Governance path is structurally unsafe
- **WHEN** a destination ancestor is a symlink, non-directory, or resolves outside the target
- **THEN** initialization stops before any destination mutation

#### Scenario: Merge fails after writing governance files
- **WHEN** a later staged artifact cannot be merged
- **THEN** rollback removes or restores Liftoff-owned governance writes under the existing transaction contract

### Requirement: Governed projects include one deterministic setup entry point
When repository governance is enabled, the system SHALL generate
`/liftoff-setup` integrations for every selected agent and a managed
machine-readable phase definition. The integrations SHALL contain no model
selection, SHALL delegate state transitions to the Liftoff CLI, and SHALL NOT
generate any alternate visible setup command or alias.

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
- **WHEN** only the thin setup integration bytes change
- **THEN** its managed content hash changes
- **AND** no setup-skill version changes or is introduced
