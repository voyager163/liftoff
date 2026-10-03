## Purpose

Provide verified runtime-inclusive Liftoff installations and safe package-manager ownership, including a bounded migration from existing Apple Silicon npm installations to Homebrew.

## ADDED Requirements

### Requirement: Native installations carry their required runtime and assets
Liftoff SHALL provide a Homebrew cask for native Apple Silicon macOS, a WinGet installation for qualified Windows x64 hosts, and verified user-local archives for qualified Linux x64/arm64 hosts. Each distribution SHALL contain the runtime, dependency closure, built-in plugins, templates, native helpers, identity metadata, documentation and licenses needed to run without a contributor checkout or globally installed Node/npm. External project toolchains SHALL remain separately required when selected by a workload. Unsupported OS, architecture or libc combinations SHALL fail before changes with a precise remedy.

#### Scenario: Run without a global Node installation
- **WHEN** a supported user installs the native package on a host without global Node/npm
- **THEN** help, version, capabilities and side-effect-free planning run using the packaged runtime and assets
- **AND** project-specific Node/npm requirements are not falsely marked satisfied

#### Scenario: Resolve installed assets on Windows
- **WHEN** a Windows package is installed under a path containing spaces and invoked from another drive or directory
- **THEN** runtime assets resolve from the verified installed package boundary using native paths
- **AND** source-checkout paths and POSIX path assumptions are unnecessary

#### Scenario: Unsupported macOS host is selected
- **WHEN** an Intel Mac, unqualified OS release or unsupported execution architecture requests native installation or migration
- **THEN** preflight refuses before removing any existing installation
- **AND** the package does not claim support based solely on a translated or emulated run

### Requirement: Native release identity and channel availability are independently verified
Every native artifact SHALL bind one qualified source revision and CLI version to immutable checksums, signatures or platform signing, provenance and dependency/license inventory. macOS distribution SHALL satisfy signing and notarization; Windows SHALL use a signed qualified installer. Release assets SHALL be assembled before immutable publication. Package-channel availability SHALL be verified separately from upstream publication, and a package namespace or signing prerequisite that cannot be verified SHALL block publication rather than trigger an unsigned or alternate-owner fallback.

#### Scenario: Package channel has not caught up
- **WHEN** an upstream release exists but the configured cask or WinGet source does not offer it
- **THEN** the CLI distinguishes released-upstream from installable-in-channel
- **AND** it does not claim installation succeeded or overwrite manager-owned files

#### Scenario: Download identity differs
- **WHEN** downloaded bytes, signature, source revision or platform identity differ from the approved artifact
- **THEN** installation fails before executing or replacing the target

#### Scenario: Correct an immutable release
- **WHEN** a published artifact needs correction
- **THEN** a new qualified version is required
- **AND** existing assets and tags are not replaced or moved

### Requirement: macOS migration prepares recovery before uninstalling npm
A standalone Apple Silicon migration utility SHALL default to a non-mutating preview and require explicit approval before transferring ownership. It SHALL verify the old canonical npm package/version, owning executable/prefix, launcher, target cask, supported host, collision state and permissions, and retain verified offline recovery material before uninstalling. It SHALL run independently of the installation being removed. Missing Homebrew, target availability, recovery material or unambiguous ownership SHALL block removal.

#### Scenario: Homebrew is unavailable
- **WHEN** the migration preview cannot locate an approved Homebrew installation
- **THEN** it identifies the prerequisite without bootstrapping Homebrew or uninstalling Liftoff

#### Scenario: A version manager owns the old package
- **WHEN** npm under nvm, Volta or a custom prefix verifiably owns the selected Liftoff installation
- **THEN** the plan binds that exact owning manager and package rather than assuming a Homebrew npm prefix
- **AND** other Node versions and global packages remain outside cleanup

#### Scenario: Multiple old copies are present
- **WHEN** discovery finds multiple or ambiguous Liftoff installations
- **THEN** apply requires an explicit verified selection and collision resolution
- **AND** the utility does not sweep all version-manager directories or all PATH entries

#### Scenario: Unsupported platform invokes migration
- **WHEN** Windows, Linux or Intel macOS invokes the legacy installer-migration utility
- **THEN** it reports the Apple Silicon-only migration boundary without cleanup or package-manager mutation

### Requirement: Installer handover changes only attributable ownership
Migration SHALL uninstall only the selected npm Liftoff package through its verified owner and remove only exact residual launcher entries whose current identity still proves old ownership. It SHALL install the reviewed cask without forced collision overwrite and verify Homebrew ownership, exact version, direct executable, packaged assets and command resolution before completion. Configuration, telemetry preferences, projects, Git history, Node/npm and unrelated packages SHALL remain unchanged.

#### Scenario: npm and Homebrew share the launcher location
- **WHEN** the old package occupies the new cask's launcher path
- **THEN** the reviewed handover releases only that verified old ownership before cask installation
- **AND** later npm cleanup cannot delete the verified Homebrew launcher

#### Scenario: Another file occupies the destination
- **WHEN** a launcher path contains unrelated or concurrently changed bytes
- **THEN** migration blocks instead of deleting it or using a forced Homebrew overwrite

#### Scenario: Installation succeeds but command resolution is stale
- **WHEN** the cask's direct executable verifies but a shell still resolves another executable or cached command
- **THEN** output reports installation and unresolved command selection separately with exact guidance
- **AND** it does not claim full handover or rewrite shell configuration

### Requirement: Installer migration recovery is bounded and resumable
Migration SHALL journal exact old/new installation identities, attributable effects and recovery material outside projects. Failure or interruption SHALL preserve that record and report actual progress. Recovery SHALL restore the old exact package only when destination ownership and concurrency checks permit; it SHALL never overwrite new user changes or a successful Homebrew-owned installation. Dry-run and replay SHALL not silently remove working installations or claim cross-manager atomicity.

#### Scenario: Cask installation fails after uninstall
- **WHEN** the old package was removed but cask installation fails
- **THEN** verified old material can be restored within its exact recorded scope if current preconditions still hold
- **AND** failure to restore is reported as incomplete recovery with the remaining record retained

#### Scenario: Recovery encounters a newer owner
- **WHEN** the destination now belongs to Homebrew or another independently changed installation
- **THEN** recovery stops rather than restoring over it

#### Scenario: Migration is run again after success
- **WHEN** the verified cask already owns the intended installation
- **THEN** the utility reports the completed/current state without repeating npm removal
