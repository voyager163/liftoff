## REMOVED Requirements

### Requirement: Generated projects include a v4 Liftoff manifest
**Reason**: Governance profile identity and the explicit handoff-only state require manifest schema v5.

**Migration**: Readers continue accepting v2, v3, and v4; a successful current update writes schema v5 after safe governance-artifact reconciliation.

## ADDED Requirements

### Requirement: Generated projects include a v5 Liftoff manifest
The system SHALL include `liftoff.manifest.json` at the root of every generated project using manifest schema v5. It SHALL record generating CLI version, discriminated workload identity, selected spec workflow, selected coding agents, applicable default agent, tested framework contract, repository-governance profile and handoff state, optional workload preferences, and every durable Liftoff-generated artifact with logical name, category, OS-neutral path parts, and `sha256:` content hash. Framework-owned output and one-time seed content SHALL remain outside durable hash ownership.

#### Scenario: Manifest accompanies every initialized workload
- **WHEN** a developer initializes a GenAI, standard API, or Power Apps project
- **THEN** the project root contains a schema-v5 manifest with exactly the workload and governance fields applicable to that project

#### Scenario: Manifest validates against generated files
- **WHEN** `liftoff validate` runs against a freshly initialized project
- **THEN** validation confirms every manifest artifact and declared framework integration marker exists on disk

#### Scenario: Enabled governance records only handoff state
- **WHEN** a project enables `single-maintainer-gitflow`
- **THEN** its v5 manifest records the profile, policy version, and `handoff-generated` state
- **AND** it does not claim live GitHub enforcement

#### Scenario: Disabled governance omits handoff artifacts
- **WHEN** a project selects `none`
- **THEN** its v5 manifest records governance as disabled
- **AND** contains no governance policy, context, guide, or launcher artifact entry

#### Scenario: Power Apps manifest omits API identity
- **WHEN** a Power Apps code app is initialized
- **THEN** its v5 workload identity records the pinned starter source and plugin preference
- **AND** it does not invent an API stack, GenAI pattern, cloud, region, API frontend flag, or API environments

#### Scenario: Framework and seed ownership remains external
- **WHEN** an official framework initializer or Liftoff seed writes content
- **THEN** those files are validated by their declared contracts without being added to the durable Liftoff artifact hash list
- **AND** the separate repository-governance handoff remains durably hash-managed by exact logical name

### Requirement: Governance handoff participates in transactional staging
Enabled governance artifacts SHALL be rendered into the same temporary staging area, assigned explicit ownership, validated, preflighted, and merged under the same collision, symlink, authorization, lock, and rollback contract as other durable Liftoff files.

#### Scenario: Governance launcher collides with a file
- **WHEN** an existing target contains different bytes at an enabled governance launcher path
- **THEN** initialization reports that exact regular-file replacement
- **AND** does not overwrite it without the existing interactive authorization or `--force`

#### Scenario: Governance path is structurally unsafe
- **WHEN** a destination ancestor is a symlink, non-directory, or resolves outside the target
- **THEN** initialization stops before any destination mutation

#### Scenario: Merge fails after writing governance files
- **WHEN** a later staged artifact cannot be merged
- **THEN** rollback removes or restores Liftoff-owned governance writes under the existing transaction contract
