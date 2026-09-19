## Purpose

Define the release-owned supported-stack baseline, stable version-selection policy, immutable dependency metadata, reviewed refresh process, and compatibility evidence required for every Liftoff release.

## Requirements

### Requirement: Every Liftoff release owns one supported-stack baseline
The system SHALL package one schema-versioned supported-stack baseline that identifies the exact tested runtime releases, package-manager releases, spec-framework CLIs, direct dependency sets, OpenTofu providers, container image digests, and any release-owned packaged generator assets used by that Liftoff release. Every runtime consumer, generated template, workstation probe, dependency command, workflow, and user-facing version statement SHALL derive from or be validated against this baseline. Retired workload artifacts SHALL NOT remain active supported baseline entries, source-commit compatibility lanes, or installable generated surfaces.

The baseline SHALL distinguish the private native CLI runtime from each supported project toolchain and bind the selected profile, template/resource catalog, governance, and skill identities.

#### Scenario: Render the same Liftoff release twice
- **WHEN** identical project plans are rendered on supported hosts with different network availability or newer upstream releases
- **THEN** both renders use the same committed baseline identities and produce byte-identical Liftoff-owned artifacts
- **AND** neither render resolves a mutable latest version

#### Scenario: Inspect a baseline entry
- **WHEN** a maintainer or automated check reads a named baseline entry
- **THEN** it can identify the ecosystem, exact version or immutable digest, supported release line, and canonical source
- **AND** generated paths referencing the entry are selected through explicit named mappings

#### Scenario: Retired workload baseline entries are absent
- **WHEN** a maintainer inspects the retained 0.11.0 baseline or the current supported-stack baseline for active generated surfaces
- **THEN** no Power Apps starter snapshot, source-commit mapping, or workload-specific asset entry appears as an active installable baseline surface
- **AND** the baseline does not claim historical Power Apps compatibility through active generation metadata

#### Scenario: Native resources and profiles disagree
- **WHEN** a packaged profile, template component, lock, policy, or skill references a baseline identity absent from the installed release inventory
- **THEN** qualification and the dependent operation fail with the exact mismatched identity
- **AND** no mutable network resource or similarly named file is substituted

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
The system SHALL provide a maintainer-controlled refresh process that queries canonical sources, materializes all candidate manifests and locks in temporary locations, validates provenance, and presents a complete reviewable change. User-facing generation, assessment, adoption, update, repair, validation, doctor, skill delivery, and installation operations SHALL NOT rewrite the supported-stack baseline or resolve replacement dependency versions for generated artifacts. Native release discovery SHALL remain distinct from baseline refresh.

#### Scenario: User initializes offline
- **WHEN** the native Liftoff bundle and selected external framework are installed but dependency registries are unavailable
- **THEN** project generation uses the packaged baseline and completes without resolving template versions
- **AND** separately requested dependency installation still reports its actual network prerequisites

#### Scenario: Freshness check finds a newer release
- **WHEN** scheduled maintenance detects a newer supported stable version
- **THEN** it reports the named stale baseline entry and candidate identity
- **AND** it does not commit, publish, or silently promote the candidate

#### Scenario: Canonical source is unavailable
- **WHEN** a refresh or scheduled freshness check cannot retrieve or validate a required source
- **THEN** the check fails as an infrastructure failure
- **AND** it does not report the existing baseline as current

#### Scenario: A native upgrade introduces a newer baseline
- **WHEN** an approved CLI upgrade installs a release with a different packaged baseline
- **THEN** the new baseline applies to explicitly selected new-generation or reviewed maintenance targets
- **AND** existing project manifests, dependencies, locks, and activation identities remain unchanged by installation

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
A candidate baseline SHALL be accepted only after applicable install, build, lint, test, generated-project, container, OpenTofu, security, provenance, native-resource, and cross-platform checks pass. Each check SHALL consume the candidate's committed metadata without rewriting it, and absence of an expected dependency set or test input SHALL fail rather than produce a vacuous pass. Promotion SHALL bind the explicit supported profile and resource inventories to the release's qualified native runtime and platform matrix; final publication remains subject to the coordinated release-qualification gate.

#### Scenario: Verify a complete candidate
- **WHEN** a candidate changes more than one dependency ecosystem
- **THEN** CI validates every affected explicit inventory entry and representative workload
- **AND** promotion remains blocked until all applicable checks complete successfully

#### Scenario: Candidate metadata changes during verification
- **WHEN** an install, tidy, lock, build, or validation command rewrites a candidate manifest or lockfile
- **THEN** verification fails and identifies the changed path
- **AND** the candidate is not treated as reproducible

#### Scenario: Verify on supported operating systems
- **WHEN** a baseline changes generated paths, locks, commands, framework requirements, or native resources
- **THEN** the affected contracts are verified on Windows, macOS, and Linux using platform-correct path handling
- **AND** logical artifact identities remain identical across hosts

#### Scenario: A supported profile lacks qualification
- **WHEN** the candidate lists a supported FastAPI, Fastify, Go/Huma, Vue, or GenAI profile without its applicable locked-install and behavior evidence
- **THEN** promotion remains blocked
- **AND** another profile's passing result or the existence of a template cannot stand in for that evidence

### Requirement: Retired workload fixtures are non-generative
The system SHALL classify any retained Power Apps artifact kept only for unsupported-workload detection or historical diagnostics as a negative non-generative fixture. Such fixtures MUST be explicit inventory entries and SHALL NOT participate in version selection, scaffold generation, freshness checks, dependency promotion, or compatibility claims.

#### Scenario: Retired manifest fixture stays out of generation
- **WHEN** baseline verification retains a Power Apps manifest fixture for unsupported-workload rejection
- **THEN** the fixture is identified as retired and non-generative
- **AND** it is not treated as a supported starter, dependency graph, or source-commit compatibility lane

#### Scenario: Retired fixture inventory resolves across operating systems
- **WHEN** the retired fixture inventory is resolved on Windows, macOS, or Linux
- **THEN** each retained fixture uses explicit logical naming and portable path parts
- **AND** no fixture path depends on a hardcoded operating-system separator

### Requirement: Native runtime baselines declare their tested host matrix
The release-owned native baseline SHALL identify the exact private Node runtime, its supported macOS/Windows/Linux x64 and arm64 targets, required Windows host/controller conditions, and explicit minimum operating-system and Linux glibc constraints. These values SHALL be fixed from the selected runtime's supported matrix and qualified before publication. Additional architectures, libc variants, or runtime backends SHALL require reviewed compatibility evidence rather than an inferred support claim.

#### Scenario: Inspect an installable native target
- **WHEN** a release manifest names a supported native target
- **THEN** the baseline resolves its exact runtime, architecture, host floor, and matching resource identity
- **AND** missing host-floor values block qualification

#### Scenario: A host uses an unqualified libc
- **WHEN** a Linux host does not satisfy the declared glibc contract
- **THEN** installation or startup reports that incompatibility
- **AND** the bundle is not described as supporting every Linux variant

#### Scenario: A packaging backend is changed
- **WHEN** a candidate replaces the private Node/ESM packaging with another runtime or executable format
- **THEN** promotion requires a reviewed design change and equivalent runtime, asset, subprocess, and recovery qualification
- **AND** matching TypeScript source alone is insufficient

### Requirement: Baseline roles do not grant ownership or project migration authority
Native runtime, project runtime, standards/profile, and packaged-resource entries SHALL retain distinct roles even when their version numbers match. Baseline and catalog identities SHALL select exact registered artifacts, not grant permission to overwrite an existing project. Artifact modification or retirement SHALL use the exact registered-ID and destination inventory with the applicable lifecycle and approval checks.

#### Scenario: A bundled Node version matches a project minimum
- **WHEN** the CLI's private runtime numerically satisfies a selected project's Node constraint
- **THEN** workstation readiness still requires the separately selected project runtime and npm where applicable
- **AND** the private runtime is not exported or relabeled as project tooling

#### Scenario: An existing project uses older compatible dependencies
- **WHEN** the installed native release contains newer generated dependency locks
- **THEN** assessment reports the selected target separately from the project's recorded baseline
- **AND** ordinary upgrade or managed-core update cannot overwrite project dependencies merely because the target is newer

#### Scenario: Resolve a resource inventory across platforms
- **WHEN** a named artifact is materialized or retired on Windows, macOS, or Linux
- **THEN** portable logical identity resolves to the explicit native destination
- **AND** a prefix match, filename glob, case collision, or matching content hash does not admit another file
