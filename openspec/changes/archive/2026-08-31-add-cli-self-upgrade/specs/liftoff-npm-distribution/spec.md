## ADDED Requirements

### Requirement: A global npm installation can replace itself with a verified stable release
The published Liftoff package SHALL contain all runtime code needed for a supported global npm installation to discover canonical stable release metadata, verify configured-registry parity, invoke an exact global npm replacement, and verify the replacement outside the source repository.

#### Scenario: Upgrade a canonical global installation
- **WHEN** a published global npm installation invokes `liftoff upgrade` and a newer stable version is available through its effective registry
- **THEN** the effective global package is replaced with that exact published version
- **AND** the replacement command reports the same version

#### Scenario: Inspect a packed package
- **WHEN** release verification inspects and installs the packed Liftoff artifact in an isolated global prefix
- **THEN** `liftoff upgrade --help` works outside the repository
- **AND** self-upgrade runtime modules are included in the published package

### Requirement: Self-upgrade preserves canonical and managed registry boundaries
Canonical npm SHALL remain the authority for the stable target, while the user's effective npm registry SHALL remain the delivery path. Self-upgrade SHALL require exact-version parity before installation and SHALL not rewrite npm configuration, bypass a stale managed mirror, or install a mirror-specific version not selected by canonical `latest`.

#### Scenario: Approved mirror exposes canonical target
- **WHEN** a managed registry exposes the exact canonical stable version
- **THEN** a supported global installation may upgrade through that mirror

#### Scenario: Approved mirror is stale
- **WHEN** a managed registry does not expose the canonical target
- **THEN** self-upgrade remains blocked until the mirror synchronizes
- **AND** canonical availability alone does not authorize bypassing it

### Requirement: Release verification covers the self-upgrade surface safely
Release automation SHALL verify command help, stable metadata parsing, installation-origin detection, and replacement verification through committed fixtures and isolated temporary global prefixes. It SHALL never invoke self-upgrade apply mode against the release runner's actual global prefix.

#### Scenario: Smoke-test the published command
- **WHEN** the packed package is installed under an isolated global prefix
- **THEN** its upgrade help and injected check behavior execute with platform-correct paths
- **AND** the host installation remains unchanged

#### Scenario: Missing self-upgrade runtime asset
- **WHEN** the packed package omits a module required by upgrade
- **THEN** package smoke verification fails before publication
