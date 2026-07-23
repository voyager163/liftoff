## ADDED Requirements

### Requirement: Release version identity is coherent before publication
The system SHALL require root package metadata, root lockfile metadata, a tag-triggered release's Git tag, packed package metadata, and the installed CLI version output to identify the same semantic version before publishing a new Liftoff package. A mismatch in any required identity SHALL fail the release workflow before `npm publish`.

#### Scenario: Prepare the first version-reporting release
- **WHEN** release automation prepares Liftoff `0.3.4`, the first published release containing `liftoff --version`
- **THEN** root `package.json` and root `package-lock.json` metadata identify version `0.3.4`
- **AND** an isolated installation of the packed package prints `Liftoff 0.3.4` for `liftoff --version`

#### Scenario: Tag-triggered release matches package metadata
- **WHEN** the release workflow is triggered by Git tag `v0.3.4`
- **THEN** the workflow confirms that root package and lockfile metadata identify `0.3.4` before publication
- **AND** packed package metadata identifies `0.3.4`

#### Scenario: Release identity mismatch blocks publication
- **WHEN** the Git release tag, root package version, root lockfile version, packed version, or installed `liftoff --version` output does not match another required identity
- **THEN** release verification fails with the expected and observed identities
- **AND** no new npm package is published by that workflow run

### Requirement: Registry onboarding preserves release version identity
The system SHALL treat a registry path as ready for version-command-based onboarding only when its stable dist-tag and explicit package version resolve to the intended release and a clean installation through that registry reports the same version through `liftoff --version`. Canonical publication success and managed-registry readiness SHALL remain independently observable states.

#### Scenario: Canonical npm exposes Liftoff 0.3.4
- **WHEN** canonical publication and post-publish verification of Liftoff `0.3.4` succeed
- **THEN** canonical npm resolves both `@msn-control/liftoff@latest` and `@msn-control/liftoff@0.3.4` to version `0.3.4`
- **AND** a clean canonical installation prints `Liftoff 0.3.4` for `liftoff --version`

#### Scenario: Approved managed registry reaches parity
- **WHEN** an organization presents its approved managed registry as ready for Liftoff `0.3.4` onboarding
- **THEN** that registry resolves both `@latest` and explicit `@0.3.4` metadata to version `0.3.4`
- **AND** a clean installation through that registry prints `Liftoff 0.3.4` for `liftoff --version`

#### Scenario: Managed registry remains stale
- **WHEN** an approved managed registry resolves `@latest` to an older release, rejects explicit `@0.3.4`, or installs a CLI that does not report `Liftoff 0.3.4`
- **THEN** version-command-based onboarding through that registry remains blocked
- **AND** Liftoff does not modify npm configuration or silently install from another registry