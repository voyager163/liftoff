## Purpose

Define the release-owned supported-stack baseline, stable version-selection policy, immutable dependency metadata, reviewed refresh process, and compatibility evidence required for every Liftoff release.

## Requirements

### Requirement: Every Liftoff release owns one supported-stack baseline
The system SHALL package one schema-versioned supported-stack baseline that identifies the exact tested runtime releases, package-manager releases, spec-framework CLIs, direct dependency sets, OpenTofu providers, container image digests, and immutable upstream starter sources used by that Liftoff release. Every runtime consumer, generated template, workstation probe, dependency command, workflow, and user-facing version statement SHALL derive from or be validated against this baseline.

#### Scenario: Render the same Liftoff release twice
- **WHEN** identical project plans are rendered on supported hosts with different network availability or newer upstream releases
- **THEN** both renders use the same committed baseline identities and produce byte-identical Liftoff-owned artifacts
- **AND** neither render resolves a mutable latest version

#### Scenario: Inspect a baseline entry
- **WHEN** a maintainer or automated check reads a named baseline entry
- **THEN** it can identify the ecosystem, exact version or immutable digest, supported release line, and canonical source
- **AND** generated paths referencing the entry are selected through explicit named mappings

### Requirement: Baseline selection uses stable supported releases
The system SHALL select the newest stable release that is supported by the applicable workload and platform compatibility matrix. It SHALL exclude prereleases and abandoned or end-of-life release lines. Where an ecosystem distinguishes a production LTS line from a newer Current line, the baseline SHALL select the newest supported LTS unless an explicit reviewed compatibility record states otherwise.

#### Scenario: Node.js has a newer Current release
- **WHEN** the canonical Node.js feed offers Node.js 26 Current while Node.js 24 is the newest active LTS
- **THEN** the production baseline selects the tested Node.js 24 LTS release
- **AND** it does not raise the generated runtime floor to Current merely because its major number is newer

#### Scenario: Registry latest is a prerelease
- **WHEN** an ecosystem's latest tag or highest published version is an alpha, beta, release candidate, or preview
- **THEN** baseline refresh excludes that version
- **AND** it evaluates the newest stable compatible release instead

#### Scenario: Newest stable is incompatible
- **WHEN** the numerically newest stable package cannot pass the supported runtime or workload verification matrix
- **THEN** the baseline records the newest compatible stable version with an explicit reviewed reason
- **AND** the refresh does not publish an unverified version merely to satisfy freshness

### Requirement: Version resolution occurs only during reviewed maintenance
The system SHALL provide a maintainer-controlled refresh process that queries canonical sources, materializes all candidate manifests and locks in temporary locations, validates provenance, and presents a complete reviewable change. `liftoff init`, `liftoff update`, `liftoff validate`, and `liftoff doctor` SHALL NOT rewrite the supported-stack baseline or resolve dependency versions for generated artifacts.

#### Scenario: User initializes offline
- **WHEN** the Liftoff package and selected framework are installed but dependency registries are unavailable
- **THEN** project generation uses the packaged baseline and completes without resolving template versions

#### Scenario: Freshness check finds a newer release
- **WHEN** scheduled maintenance detects a newer supported stable version
- **THEN** it reports the named stale baseline entry and candidate identity
- **AND** it does not commit, publish, or silently promote the candidate

#### Scenario: Canonical source is unavailable
- **WHEN** a refresh or scheduled freshness check cannot retrieve or validate a required source
- **THEN** the check fails as an infrastructure failure
- **AND** it does not report the existing baseline as current

### Requirement: Every installable dependency set is immutable
The system SHALL emit complete ecosystem-native dependency metadata for every independently installable generated project. npm projects SHALL include coherent package and lock files, Python projects SHALL include `uv.lock` and use frozen synchronization, Go projects SHALL include complete module checksums, OpenTofu projects SHALL include provider locks for supported platforms, and container references SHALL include immutable manifest digests.

#### Scenario: Install a generated Python project
- **WHEN** a developer runs the documented Python dependency command
- **THEN** `uv` synchronizes from the generated lock in frozen mode
- **AND** no dependency manifest or lockfile is created or changed

#### Scenario: Initialize generated OpenTofu
- **WHEN** a developer initializes generated OpenTofu on Windows, macOS, or Linux
- **THEN** provider selection uses the committed multi-platform lock metadata
- **AND** initialization does not choose a newer provider than the tested baseline

#### Scenario: Pull a generated container image
- **WHEN** Docker resolves a generated service image reference
- **THEN** the reference binds the readable release tag to the baseline's immutable multi-architecture digest
- **AND** mutable tags such as `latest` cannot change the selected bytes

### Requirement: Baseline promotion requires complete compatibility evidence
A candidate baseline SHALL be accepted only after applicable install, build, lint, test, generated-project, container, OpenTofu, security, provenance, and cross-platform checks pass. Each check SHALL consume the candidate's committed metadata without rewriting it, and absence of an expected dependency set or test input SHALL fail rather than produce a vacuous pass.

#### Scenario: Verify a complete candidate
- **WHEN** a candidate changes more than one dependency ecosystem
- **THEN** CI validates every affected explicit inventory entry and representative workload
- **AND** promotion remains blocked until all applicable checks complete successfully

#### Scenario: Candidate metadata changes during verification
- **WHEN** an install, tidy, lock, build, or validation command rewrites a candidate manifest or lockfile
- **THEN** verification fails and identifies the changed path
- **AND** the candidate is not treated as reproducible

#### Scenario: Verify on supported operating systems
- **WHEN** a baseline changes generated paths, locks, commands, or framework requirements
- **THEN** the affected contracts are verified on Windows, macOS, and Linux using platform-correct path handling
- **AND** logical artifact identities remain identical across hosts
