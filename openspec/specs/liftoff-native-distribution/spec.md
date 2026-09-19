## Purpose

Provide self-contained Liftoff installations with verifiable native release identity, one authoritative installation owner, and a safe handover from historical npm installations without changing existing projects.

## Requirements

### Requirement: Current Liftoff releases use only the qualified native channels
The system SHALL distribute the coordinated release through a Homebrew cask in an upstream-maintained tap on macOS, an exactly identified WinGet portable package on Windows, and versioned direct-install archives on Linux. The supported matrix SHALL include x64 and arm64 on each operating system and SHALL declare the tested minimum operating-system and Linux glibc requirements before publication. It SHALL NOT publish a new npm edition or final npm migration bridge, substitute a Node-dependent formula for the selected cask, assume acceptance into an official package-manager repository, or label an unqualified target supported.

#### Scenario: Install on macOS
- **WHEN** a developer selects the supported macOS installation path
- **THEN** the documented upstream tap/cask delivers the qualified standalone artifact for the selected architecture
- **AND** the installed Liftoff package is owned by the exact verified Homebrew cask identity recorded for that channel

#### Scenario: A formula and cask have similar names
- **WHEN** installation or inspection encounters a same-named formula and the selected Liftoff cask
- **THEN** the operation uses the full registered tap/cask identity and explicit cask selection
- **AND** it does not infer cask ownership from a bare token, a filesystem prefix or Homebrew ownership of Node

#### Scenario: Install on Windows
- **WHEN** a developer selects the supported Windows installation path
- **THEN** the exact WinGet package and architecture manifest deliver the qualified portable ZIP with its launcher, runtime, and resources
- **AND** a release download alone is not reported as WinGet catalog availability

#### Scenario: Install on Linux
- **WHEN** a developer selects a supported Linux architecture and host baseline
- **THEN** the versioned native archive can be installed with an explicit direct-install receipt and stable launcher
- **AND** an unsupported libc or architecture is rejected with the observed and supported target constraints

#### Scenario: Prepare the coordinated release
- **WHEN** maintainers prepare the new release
- **THEN** every required native target and delivery channel participates in release qualification
- **AND** no npm package or bridge is published to compensate for a missing native target

### Requirement: Native installations are self-contained without providing project toolchains
The native distribution SHALL include its qualified pinned runtime, complete application and runtime dependencies, a relocatable launcher, and all declared runtime resources. Installed Liftoff SHALL run its own commands without ambient Node/npm, a source checkout, user-side compilation, writable installation files, or downloading undeclared runtime assets. This private runtime SHALL NOT satisfy or replace selected project, framework, agent-host, or specification-tool prerequisites.

#### Scenario: Run on a host without Node or npm
- **WHEN** a qualified native bundle is installed on a supported host with no ambient `node` or `npm`
- **THEN** its version, help, non-executing planning, and installation-inspection surfaces run using the bundled runtime
- **AND** they do not bootstrap another runtime or package manager

#### Scenario: An ambient runtime differs
- **WHEN** PATH contains an incompatible or different Node installation
- **THEN** Liftoff still uses its verified private runtime
- **AND** project-tool readiness reports the independently selected project executable rather than the private runtime

#### Scenario: Project tooling is missing
- **WHEN** the native CLI starts successfully but a selected Node project or OpenSpec operation requires unavailable external Node/npm
- **THEN** that operation remains blocked by its actual prerequisites
- **AND** successful CLI startup does not establish project readiness

#### Scenario: Run from a read-only relocated installation
- **WHEN** the bundle is moved to a supported installation directory with spaces on Windows, macOS, or Linux and installation files are read-only
- **THEN** Liftoff resolves its runtime and resources independently of the caller's current directory
- **AND** it neither writes into the installation nor reaches back into the build checkout

### Requirement: Native release manifests bind immutable final artifacts
A native release manifest with schema 1 SHALL bind the canonical Liftoff product, semantic version, full source commit, operating system, architecture, minimum host and libc constraints, immutable artifact URL, final checksum, signature/provenance, private runtime identity, and packaged-resource identity. Final checksums SHALL be computed after signing. Installation SHALL verify this binding before admitting the payload; a stable release SHALL NOT resolve to a prerelease, an unrelated product, or mutable replacement bytes.

#### Scenario: Verify a staged artifact
- **WHEN** the downloaded artifact, trusted signature/provenance, and manifest identify the same source, target, version, runtime, and resources
- **THEN** verification admits those exact bytes as the selected installation candidate
- **AND** a later installation cannot silently substitute another artifact

#### Scenario: Signing changes the archive
- **WHEN** signing changes artifact bytes after an earlier checksum was calculated
- **THEN** the manifest must contain the checksum of the final signed bytes
- **AND** verification rejects the earlier checksum rather than disabling integrity checking

#### Scenario: Identity or authenticity cannot be established
- **WHEN** a manifest is malformed, names another product or target, has an unsupported schema, lacks required provenance, or fails checksum or signature verification
- **THEN** installation is blocked before package registration or launcher replacement
- **AND** the actual verification failure is reported

#### Scenario: Inspect source and redistribution identity
- **WHEN** a user inspects the native release metadata and bundled license inventory
- **THEN** the release identifies `voyager163/liftoff`, its exact public source commit, GPL-3.0-only Liftoff licensing, and applicable bundled-runtime and dependency notices

### Requirement: Packaged resource ownership uses exact registered inventories
Every shipped template, lock, governance policy, skill, documentation asset, license, and Windows process-controller resource SHALL have an explicit release-owned identity and inventory entry. Resource lookup SHALL be independent of cwd and use native filesystem semantics on Windows, macOS, and Linux. Generated-artifact modification, retirement, or deletion SHALL require exact registered-ID and destination-list lookup; a filename prefix, glob, directory name, or content hash alone SHALL NOT establish ownership.

#### Scenario: Resolve resources outside the source checkout
- **WHEN** an installed command consumes templates, locks, policies, skills, or documentation from an arbitrary working directory
- **THEN** it resolves the resources belonging to that installed release
- **AND** a missing or mismatched resource fails the dependent operation explicitly

#### Scenario: Windows resource names collide
- **WHEN** inventory destinations collide after Windows case normalization or an entry escapes the verified resource root
- **THEN** package qualification or resource admission fails before using the ambiguous resource
- **AND** no POSIX-only path assumption masks the collision

#### Scenario: Retire a generated integration
- **WHEN** an approved migration retires an old generated integration on Windows, macOS, or Linux
- **THEN** only its exact registered artifact IDs and destinations are eligible for modification or deletion
- **AND** similarly named user files and unrelated OpenSpec or Spec Kit integrations are preserved

#### Scenario: Windows host policy prevents controller execution
- **WHEN** the bundled controller cannot run under the declared Windows host, PowerShell/.NET, or enterprise execution-policy conditions
- **THEN** the dependent operation reports that causal host blocker
- **AND** bundling does not authorize an execution-policy bypass or an unapproved replacement download

### Requirement: Installation inspection proves the actual owner without mutation
`liftoff installation inspect` SHALL work without a project, including from a verified unlinked native bundle. It SHALL observe the actual executable, product/package identity, version, owner receipt or manager record, npm prefix when applicable, launcher resolution, relevant PATH order, and conflicts without installing, removing, relinking, refreshing sources, or modifying configuration. Local diagnostics SHALL distinguish verified ownership, conflicting owners, and unknown ownership; a path prefix alone SHALL NOT establish an owner.

#### Scenario: Homebrew installs Node but npm installs Liftoff
- **WHEN** Homebrew owns Node and npm records the running `@msn-control/liftoff` package under the verified prefix
- **THEN** inspection classifies Liftoff as npm-owned
- **AND** it does not classify that package as Homebrew-owned merely because its path is beneath a Homebrew prefix

#### Scenario: Multiple launchers are present
- **WHEN** different Liftoff launchers appear in PATH on macOS, Windows, or Linux
- **THEN** inspection identifies the effective command and the conflicting candidates using native path and shim semantics
- **AND** it does not remove or reorder them

#### Scenario: Ownership is ambiguous
- **WHEN** receipts, package metadata, manager records, symlink targets, or resolved executable identity disagree
- **THEN** inspection reports the conflicting evidence and a supported manual investigation remedy
- **AND** automatic upgrade or migration cannot infer deletion authority from the location

#### Scenario: Inspect from an unlinked bundle
- **WHEN** the developer invokes the verified native executable by explicit path before final registration
- **THEN** inspection distinguishes that candidate from the currently resolved legacy installation
- **AND** no project, installation receipt, telemetry notice state, or persistent configuration is created

### Requirement: Legacy npm handover is a separately selected installation migration
The native CLI SHALL expose `liftoff installation migrate --to <owner>` for a one-time, plan-first handover to a supported native owner. It SHALL explain that historical npm CLI versions, including ones with `upgrade`, cannot discover native-only releases. The plan SHALL identify the exact legacy package/version/artifact, actual npm prefix and owner, current PATH and launcher conflicts, verified unlinked native candidate, final package identity and destination, ordered effects, and owner-specific recovery. Inspection, downloading a candidate, or invoking project migration SHALL NOT authorize the handover.

#### Scenario: Legacy upgrade reports npm current
- **WHEN** the last historical npm release reports that its npm target is current
- **THEN** migration guidance explains that this says nothing about native release availability
- **AND** it directs the user to a verified unlinked native bundle and explicit installation migration rather than another npm upgrade or bridge

#### Scenario: Review the handover
- **WHEN** the native migration journey has identified a supported owner and verified the unlinked candidate
- **THEN** it presents the exact legacy retirement, manager or direct-install operation, destination, and launcher effects before requesting approval
- **AND** it retains the legacy identity and recovery instructions without treating npm configuration as native release authority

#### Scenario: Required ownership or tooling is unavailable
- **WHEN** the exact legacy owner, target package identity, package-manager availability, or permitted source cannot be established
- **THEN** migration stops with the missing prerequisite or ambiguity
- **AND** it does not guess an uninstall prefix, bootstrap a package manager, or silently choose another owner

### Requirement: Installation migration approval binds ordered conflict resolution
Interactive installation migration SHALL require action-specific confirmation of the immutable plan with default No; noninteractive execution SHALL require the exact approved plan. The candidate SHALL be verified while unlinked before approval to retire the old launcher owner. After approval, Liftoff SHALL retire only the verified legacy Liftoff package when needed to release a conflicting launcher, then install or link through the selected owner in the approved order. It SHALL NOT force another owner's files, overwrite an unrelated launcher, or reuse approval after the observed identities, PATH conflicts, destination, or candidate bytes change.

#### Scenario: A legacy launcher blocks Homebrew registration
- **WHEN** the verified npm-owned launcher conflicts with the selected macOS Homebrew package
- **THEN** the plan orders verified unlinked-candidate checks before approved legacy-package removal and Homebrew installation
- **AND** it does not attempt forced linking over the npm-owned launcher

#### Scenario: Windows shim conflicts with WinGet
- **WHEN** an npm shim in a Windows path with spaces would conflict with the selected WinGet portable launcher
- **THEN** the plan names the exact package, prefix, native destination, and shim effects
- **AND** execution preserves that ordering without shell-expanded paths or a generic force flag

#### Scenario: A Linux direct launcher already belongs to another owner
- **WHEN** the requested direct-install destination contains an unapproved launcher
- **THEN** migration blocks until a new explicit conflict-resolution plan is reviewed
- **AND** it does not treat a matching filename as permission to replace it

#### Scenario: Approval is declined or stale
- **WHEN** the developer declines confirmation or installation facts differ from the approved plan
- **THEN** no new retirement, installation, or launcher mutation is performed
- **AND** changed facts require a fresh plan and approval

### Requirement: Installation migration records and verifies the actual cutover
Installation migration SHALL use an independent schema-1 record binding the approved source and target installation identities and durable pre-effect checkpoints. It SHALL verify the installed native executable by explicit path and then by normal command resolution before reporting success. Failures SHALL identify completed and remaining effects, preserve recovery evidence, and offer owner-specific, separately approved recovery when the recovery changes scope. It SHALL NOT claim an automatic cross-owner rollback.

#### Scenario: Complete the handover
- **WHEN** the selected owner records the expected installation and both explicit-path and PATH invocations identify the verified target version
- **THEN** migration reports success and records those observations
- **AND** the receipt distinguishes the former npm package from the native owner

#### Scenario: PATH still selects the old executable
- **WHEN** the new binary verifies by explicit path but ordinary resolution selects another version or shim
- **THEN** migration reports incomplete launcher resolution rather than success
- **AND** it identifies the actual conflict and separately reviewable remedy

#### Scenario: Installation fails after approved legacy removal
- **WHEN** the legacy Liftoff package has been removed but the native owner cannot complete installation
- **THEN** the result records both the completed removal and failed installation
- **AND** it preserves the verified candidate and exact legacy recovery identity without claiming the old command is still installed

#### Scenario: Resume after interruption
- **WHEN** a schema-1 migration record identifies partial effects
- **THEN** recovery re-observes both owners and launcher state before proposing the remaining actions
- **AND** it rejects unknown record formats or changed facts rather than repeating a completed removal blindly

### Requirement: Direct installation and Windows handover preserve usable versions
Direct native installation and replacement SHALL stage verified versioned payloads under an explicit receipt, validate the target, and perform a supported launcher handover without writing over a running payload. Windows locked files SHALL produce an explicit close or deferred-handover state. The system SHALL preserve the current usable version until replacement can be verified, SHALL NOT terminate unrelated processes, and SHALL NOT remove an active version directory merely because a launcher has changed.

#### Scenario: Verify a direct replacement before activation
- **WHEN** a Linux direct installation has a newer approved native target
- **THEN** the replacement is staged and verified separately from the active version
- **AND** checksum, startup, or resource failure leaves the existing usable installation selected

#### Scenario: Windows executable is locked
- **WHEN** a supported Windows replacement or handover encounters a running locked executable
- **THEN** the result identifies the required close or handover action and remains incomplete until verification succeeds
- **AND** it does not force replacement, kill unrelated processes, or switch channels

#### Scenario: An old version still has an active process
- **WHEN** a launcher has moved but an earlier version directory remains in use
- **THEN** cleanup retains that directory and records the deferred cleanup condition
- **AND** cleanup eligibility requires the exact owned-version inventory and a fresh inactivity check

### Requirement: Installation changes never become project or runtime removal authority
Native installation, upgrade, and npm handover SHALL leave project source, manifests, generated artifacts, dependency trees, lockfiles, framework selections, Git history, activation history, cloud resources, and state unchanged. Legacy retirement SHALL remove only the identified Liftoff package, never Node, npm, other global packages, or project dependencies. After cutover, existing projects SHALL be inspected read-only and any managed update, adoption, repair, or activation migration SHALL be separately planned and approved.

#### Scenario: Existing Node project survives migration
- **WHEN** npm-owned Liftoff is migrated while the workstation contains Node projects
- **THEN** Node, npm, `node_modules`, project manifests, and locks remain unchanged
- **AND** no project is reinitialized

#### Scenario: An existing project needs new contracts
- **WHEN** the native CLI reads a supported historical project after installation
- **THEN** it reports compatibility and the separate supported maintenance journey
- **AND** executable replacement alone does not write manifest 8, activation 4, or new skill artifacts

#### Scenario: Run the handover inside a project directory
- **WHEN** migration runs from a project path with spaces on Windows, macOS, or Linux
- **THEN** installation targeting remains independent of cwd and local package configuration
- **AND** every project byte remains unchanged
