## MODIFIED Requirements

### Requirement: Update reconciles packaged Power Apps starter artifacts
The system SHALL re-render Power Apps projects from the immutable starter snapshot packaged with the running Liftoff version and join those files to manifest entries by explicit logical name. A newer Liftoff release MAY transition from a manifest's recorded starter identity to the newer immutable snapshot in its own verified release catalog, and SHALL reconcile the source and generated metadata as ordinary new, upgrade, moved, conflict, or orphan states under the existing content-hash, default safe-apply, explicit check, and force rules. Update SHALL NOT fetch upstream source at runtime or accept an arbitrary user-supplied starter transition.

#### Scenario: Current starter is clean
- **WHEN** a Power Apps project matches the running Liftoff release's packaged starter and generated guidance
- **THEN** `liftoff update` reports no drift and exits 0

#### Scenario: Untouched starter file has an available upgrade
- **WHEN** the running Liftoff release contains a newer cataloged immutable starter and the project's recorded file remains unmodified
- **THEN** update classifies and applies the named artifact as an upgrade
- **AND** the rewritten manifest records the new release-catalog starter identity only after all safe mutations succeed

#### Scenario: Developer-edited starter file conflicts
- **WHEN** both the packaged starter artifact and the developer's recorded file changed
- **THEN** plain update classifies the artifact as a conflict and leaves it untouched unless `--force` is supplied

#### Scenario: Update is offline from upstream
- **WHEN** a developer checks or applies Power Apps updates without access to GitHub
- **THEN** reconciliation uses only the old manifest identity and the running Liftoff release's packaged source catalog
- **AND** it completes without contacting the upstream repository

#### Scenario: User fabricates a starter transition
- **WHEN** configuration or manifest fields name a starter repository, path, or commit not represented by the recorded project or running release catalog
- **THEN** update exits 1 before artifact access and identifies the invalid source identity

## ADDED Requirements

### Requirement: Update presents supported baseline adoption as managed drift
The system SHALL reconcile release-driven runtime, dependency, lock, provider, and image changes through explicit durable artifact logical names. `liftoff update --check` SHALL report the resulting upgrades and conflicts without mutation, and plain update SHALL apply only the normal safe states.

#### Scenario: Inspect a breaking baseline refresh
- **WHEN** an existing project uses artifacts from an older supported-stack baseline
- **THEN** `liftoff update --check` lists each changed named artifact and exits 2
- **AND** it does not install dependencies, rewrite locks, or mutate project files

#### Scenario: Apply untouched baseline artifacts
- **WHEN** the developer runs plain update and every changed baseline-owned artifact is still at its recorded hash
- **THEN** update writes the packaged versions and records their new hashes transactionally

#### Scenario: Preserve a locally modified dependency file
- **WHEN** both the current template and a dependency manifest, lock, Dockerfile, or provider lock changed
- **THEN** plain update reports a conflict and preserves the local bytes
