## ADDED Requirements

### Requirement: Generated infrastructure dependencies are release-pinned
The system SHALL render OpenTofu CLI constraints, provider constraints, provider checksums, cloud runtime versions, database major versions, and bootstrap container identities from the supported-stack baseline. Generated infrastructure SHALL include an explicit multi-platform provider lock and SHALL NOT resolve a newer provider or mutable bootstrap image than the Liftoff release tested.

#### Scenario: Generate current Azure OpenTofu
- **WHEN** an API workload generates Azure infrastructure
- **THEN** its OpenTofu and AzureRM release lines match the named baseline entries
- **AND** its provider lock contains checksums for every supported execution platform

#### Scenario: Validate on a supported platform
- **WHEN** `tofu init -backend=false` runs on Windows, macOS, or Linux
- **THEN** it accepts the generated provider lock without rewriting it
- **AND** `tofu validate` succeeds without Azure credentials

#### Scenario: Bootstrap image is generated
- **WHEN** infrastructure contains a default application or frontend bootstrap image
- **THEN** the image is bound to an immutable digest recorded by the baseline
- **AND** it is not represented by `latest`

### Requirement: Provider major upgrades preserve generated infrastructure intent
A stable provider major upgrade SHALL include the source migrations needed for every representative generated infrastructure shape. It SHALL preserve environment selection, secret boundaries, resource naming, identities, roles, queues, health settings, and outputs unless a separate approved capability change explicitly alters them.

#### Scenario: Upgrade AzureRM
- **WHEN** the supported baseline moves generated projects from AzureRM 3.x to 5.x
- **THEN** backend-only, frontend, worker, and non-worker plans format, initialize, and validate unchanged
- **AND** compatibility edits are reviewed with the provider version change

#### Scenario: Provider migration is incomplete
- **WHEN** any representative configuration uses a removed argument, invalid default, or rewritten lock after the upgrade
- **THEN** baseline verification fails before release
