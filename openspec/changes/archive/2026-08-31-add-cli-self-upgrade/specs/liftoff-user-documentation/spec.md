## ADDED Requirements

### Requirement: Documentation distinguishes CLI upgrade from project update
Packaged README, getting-started, CLI-reference, maintenance, troubleshooting, and generated-project guidance SHALL describe `liftoff upgrade` as replacement of the supported global CLI installation and `liftoff update` as reconciliation of one generated project. No guide SHALL imply that either command performs the other's work.

#### Scenario: Developer wants the newest CLI
- **WHEN** a developer reads installation or maintenance guidance
- **THEN** it presents `liftoff upgrade --check` followed by `liftoff upgrade`
- **AND** retains the exact manual global npm command for first installation and unsupported origins

#### Scenario: Developer wants new templates
- **WHEN** a developer wants an existing project to adopt templates from the newly installed CLI
- **THEN** documentation directs them to inspect `liftoff update --check` and then run `liftoff update`
- **AND** states that CLI self-upgrade did not modify the project

### Requirement: Documentation explains self-upgrade safety and registry policy
The documentation SHALL identify supported global npm installations, imperative apply behavior, read-only check behavior, exit codes, JSON mode, canonical stable target selection, configured-registry parity, stale-mirror blocking, unsupported local or `npx` origins, lack of automatic elevation, and exact post-failure recovery.

#### Scenario: Managed registry is stale
- **WHEN** a developer follows troubleshooting after a blocked upgrade
- **THEN** the guide directs them to synchronize or approve the canonical target in the managed registry
- **AND** does not instruct Liftoff to rewrite npm configuration or bypass the mirror

#### Scenario: Installation needs elevated permission
- **WHEN** npm reports that the effective global prefix is not writable
- **THEN** the guide explains that Liftoff does not invoke elevation
- **AND** directs the developer to resolve their Node/npm installation ownership through their approved workstation process

#### Scenario: Post-install verification fails
- **WHEN** upgrade cannot verify the replacement
- **THEN** troubleshooting provides an exact-version npm reinstall procedure
- **AND** states that Liftoff does not claim automatic rollback

### Requirement: Documentation covers the first self-upgrade-capable release
Release and migration guidance SHALL explain that older Liftoff versions without the command require one manual global npm upgrade. After the first capable version is installed globally through npm, later stable releases can use `liftoff upgrade`.

#### Scenario: User runs upgrade on an older release
- **WHEN** a user's installed Liftoff version predates the self-upgrade command
- **THEN** documentation gives the canonical manual installation command
- **AND** does not imply that an unavailable command can bootstrap itself
