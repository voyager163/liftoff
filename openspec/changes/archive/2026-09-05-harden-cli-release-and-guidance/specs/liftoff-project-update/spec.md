## ADDED Requirements

### Requirement: Managed update does not claim unsupported project identity migrations
Managed update SHALL reject requested project-name, cloud, or region changes
when they differ from recorded workload identity and no supported reviewed
migration path exists. Rejection SHALL precede rendering-driven writes to the
manifest, managed context, or project files and SHALL preserve every project
byte. Force SHALL not bypass this boundary.

#### Scenario: Region or cloud changes in configuration
- **WHEN** desired configuration names a different cloud or region from the recorded project
- **THEN** update reports a migration-only change and performs no write

#### Scenario: Project identity changes
- **WHEN** desired configuration renames an existing project
- **THEN** update does not rewrite metadata while leaving application and infrastructure identities unchanged
- **AND** reports that a separately reviewed migration is required

### Requirement: Governance cannot be disabled through ordinary update while activation state exists
An enabled-to-disabled governance profile change SHALL be rejected by ordinary
update when activation state exists and no supported deactivation proof is
available. Update SHALL neither perform deactivation nor infer the absence of
live enforcement. It SHALL preserve managed ownership, activation state,
evidence, and configuration bytes.

#### Scenario: Disable after setup has started
- **WHEN** a developer changes the desired profile to `none` after activation state has been created
- **THEN** update stops before rewriting the manifest or dropping managed ownership
- **AND** gives an explicit separate-deactivation or reconciliation remedy

#### Scenario: Force is supplied
- **WHEN** force-update is requested for the same profile transition
- **THEN** it still refuses to claim governance is disabled
- **AND** does not fabricate a deactivation or supersession record
