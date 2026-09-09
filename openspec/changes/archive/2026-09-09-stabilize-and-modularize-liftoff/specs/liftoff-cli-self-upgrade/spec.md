## MODIFIED Requirements

### Requirement: Canonical npm defines the stable target
The system SHALL resolve the target from the canonical npm `latest` metadata using a bounded request and SHALL validate the canonical package name and stable semantic version. It SHALL NOT select a prerelease, arbitrary dist-tag, malformed version, or version lower than the running CLI. Timeout, transport, and malformed-metadata failures SHALL remain distinguishable outcomes.

#### Scenario: Newer stable release exists
- **WHEN** canonical npm reports a valid stable `latest` version greater than the running version
- **THEN** that exact version becomes the sole upgrade target

#### Scenario: Current release is latest
- **WHEN** canonical `latest` equals the running version
- **THEN** the command reports `current`, exits 0, and runs no installation

#### Scenario: Canonical target is older
- **WHEN** canonical `latest` compares lower than the running version
- **THEN** the command refuses to downgrade and exits 1 with a stable reason

#### Scenario: Canonical metadata body is malformed
- **WHEN** canonical npm responds successfully but names another package, omits a version, returns an invalid semantic version, or returns a prerelease as `latest`
- **THEN** the command exits 1 without invoking npm installation
- **AND** reports malformed or invalid metadata rather than a timeout

#### Scenario: Canonical metadata is unavailable or invalid
- **WHEN** canonical metadata cannot be retrieved or does not identify a valid stable release of the canonical package
- **THEN** upgrade exits 1 without installation
- **AND** identifies unavailable transport, timeout, or invalid metadata according to the actual failure

#### Scenario: Canonical metadata request times out
- **WHEN** canonical lookup exceeds its bounded request time, including an abort while reading the response body
- **THEN** the command exits 1 without invoking npm installation
- **AND** reports the failure as a timeout rather than as malformed metadata

### Requirement: Configured registry policy is preserved
Before reporting an installable update or applying one, the system SHALL verify that the effective configured npm registry exposes the exact canonical target. Effective registry discovery SHALL honor `@msn-control:registry` before the default npm registry, SHALL run from a neutral directory so repository-local npm configuration cannot control the machine-level upgrade, and SHALL isolate canonical verification from configured-registry delivery checks without modifying persistent npm configuration. It SHALL NOT expose credentials, silently switch registries, or bypass a configured managed mirror.

#### Scenario: Configured registry is canonical
- **WHEN** effective npm configuration uses canonical npm and exposes the exact target
- **THEN** check or apply may proceed

#### Scenario: Scoped registry overrides the default registry
- **WHEN** npm configuration sets `registry=https://mirror-a.example` and `@msn-control:registry=https://mirror-b.example`
- **THEN** Liftoff evaluates `https://mirror-b.example` as the effective delivery registry for `@msn-control/liftoff`
- **AND** it does not treat the default registry as authoritative for the scoped package

#### Scenario: Managed mirror has reached parity
- **WHEN** the effective managed registry exposes the exact version selected from canonical npm
- **THEN** apply installs that version through the configured mirror
- **AND** does not force a canonical registry override

#### Scenario: Managed mirror is stale
- **WHEN** canonical npm has a newer stable target that the configured mirror does not expose
- **THEN** the command reports `blocked`, exits 1, and identifies mirror synchronization as the remedy
- **AND** does not install the mirror's older `latest` version

#### Scenario: Repository-local npm configuration is isolated
- **WHEN** the current directory contains a project `.npmrc` that differs from the user's machine-level npm configuration
- **THEN** upgrade registry discovery uses the neutral machine-level context for self-upgrade
- **AND** the project file is neither used as authority nor modified

#### Scenario: Registry URL contains credentials
- **WHEN** effective registry configuration contains user information, a token, query data, or a private configuration path
- **THEN** human, JSON, telemetry, and error output omit those sensitive values
