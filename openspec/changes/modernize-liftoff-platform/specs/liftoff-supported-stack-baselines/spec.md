## MODIFIED Requirements

### Requirement: Every Liftoff release owns one supported-stack baseline
The system SHALL package one schema-versioned supported-stack baseline that identifies the exact tested runtime releases, package-manager releases, spec-framework CLIs, direct dependency sets, OpenTofu providers, container image digests, and release-owned packaged generator assets used by that Liftoff release. It SHALL distinguish the private native CLI runtime from each supported project toolchain and bind the selected profile, template/resource catalog, governance, and skill identities. Every runtime consumer, generated template, workstation probe, dependency command, workflow, and user-facing version statement SHALL derive from or be validated against this baseline. Retired workload artifacts SHALL NOT remain active supported baseline entries, source-commit compatibility lanes, or installable generated surfaces.

#### Scenario: Render the same Liftoff release twice
- **WHEN** identical project plans are rendered on supported hosts with different network availability or newer upstream releases
- **THEN** both renders use the same committed baseline identities and produce byte-identical Liftoff-owned artifacts
- **AND** neither render resolves a mutable latest version

#### Scenario: Inspect a baseline entry
- **WHEN** a maintainer or automated check reads a named baseline entry
- **THEN** it can identify the ecosystem, exact version or immutable digest, supported release line, and canonical source
- **AND** generated paths referencing the entry are selected through explicit named mappings

#### Scenario: Retired workload baseline entries are absent
- **WHEN** a maintainer inspects the retained 0.11.0 baseline or the current baseline for active generated surfaces
- **THEN** no Power Apps starter snapshot, source-commit mapping, or workload-specific asset entry appears as an active installable baseline surface
- **AND** historical Power Apps fixtures do not become active generation metadata

#### Scenario: Native resources and profiles disagree
- **WHEN** a packaged profile, template component, lock, policy, or skill references a baseline identity absent from the installed release inventory
- **THEN** qualification and the dependent operation fail with the exact mismatched identity
- **AND** no mutable network resource or similarly named file is substituted

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

## ADDED Requirements

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
