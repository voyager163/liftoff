## ADDED Requirements

### Requirement: Baselines distinguish distribution runtime from project toolchains
The release-owned baseline SHALL identify the embedded CLI runtime and qualified native OS/architecture/libc floors independently from external workload/framework toolchains. It SHALL include each bundled plugin identity, immutable asset inventory and installable dependency set. Manual SHALL have no external framework version. Observed host versions, network latest or plugin registration order SHALL not change generated target identities.

#### Scenario: Native CLI starts on a host without Node
- **WHEN** the native host meets its qualified runtime floor
- **THEN** CLI startup succeeds without treating a Node project's missing external toolchain as ready

#### Scenario: A bundled template lock changes
- **WHEN** a plugin dependency set changes
- **THEN** its baseline identity and explicit audit/qualification inventory change together before release
- **AND** existing project locks are not upgraded by ordinary update

#### Scenario: Platform minimum has not been qualified
- **WHEN** an OS/architecture/libc combination lacks actual evidence
- **THEN** the baseline does not advertise it as supported
- **AND** Windows/macOS/Linux artifact and provider paths retain native resolution and explicit portable identities
