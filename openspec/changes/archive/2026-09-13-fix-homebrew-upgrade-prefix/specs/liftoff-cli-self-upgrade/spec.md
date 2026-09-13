## MODIFIED Requirements

### Requirement: Automatic upgrade requires a supported global npm installation
The system SHALL automatically mutate only a running canonical `@msn-control/liftoff` package that is verifiably installed beneath the effective npm global package root or a separately verified standard macOS Homebrew npm prefix. It SHALL refuse local dependencies, npm execution-cache or `npx` copies, linked development checkouts, ambiguous or escaping paths, unsupported package-manager stores, invalid package metadata, and missing or incompatible npm.

#### Scenario: Running package is globally installed by npm
- **WHEN** the canonical running package resolves to the expected scoped path beneath npm's canonical global root
- **THEN** installation discovery classifies it as eligible for automatic upgrade

#### Scenario: Command runs through npx
- **WHEN** the running package resolves inside an npm execution cache rather than a verified global package root
- **THEN** the command exits 1 without installing another copy
- **AND** provides the exact manual global npm installation remedy

#### Scenario: Command runs from a linked checkout
- **WHEN** the apparent global package resolves through a symlink to a development checkout
- **THEN** the command refuses automatic replacement
- **AND** leaves both the checkout and global link unchanged

#### Scenario: Global root path is unsafe
- **WHEN** installation discovery encounters an unreadable root, structural collision, traversal, symlink escape, or ambiguous package identity
- **THEN** it fails before any registry or installation mutation

#### Scenario: Homebrew Node uses its Cellar prefix
- **WHEN** macOS npm reports a Node Cellar global root but the running Liftoff package and its launcher verify at the corresponding standard Homebrew prefix
- **THEN** upgrade targets that verified existing installation using an explicit command-local npm prefix
- **AND** it does not create a second Liftoff installation in the Cellar

#### Scenario: Homebrew fallback cannot prove the installation
- **WHEN** the runtime, npm root, package metadata, package path, or launcher does not confirm the same standard Homebrew installation
- **THEN** upgrade remains blocked before registry lookup or installation
- **AND** no arbitrary installation prefix is inferred from a directory suffix

#### Scenario: Windows and Linux retain their existing global-root contracts
- **WHEN** the command runs on Windows or Linux
- **THEN** it uses the existing platform-native global-root checks
- **AND** it does not apply the macOS Homebrew fallback

### Requirement: Upgrade output is stable and non-sensitive
The command SHALL use the shared human presentation model and SHALL support byte-pure versioned JSON for both check and apply modes. Output SHALL expose only the mode, stable status, current version, applicable target version, registry kind, stable reason code, and an optional enumerated standard-Homebrew installation-target hint; it SHALL NOT expose credentials, raw registry responses, npm configuration paths, global package paths, project paths, or command arguments containing secrets.

#### Scenario: Emit JSON update availability
- **WHEN** a developer runs `liftoff upgrade --check --json` and an installable update exists
- **THEN** stdout contains one JSON object with `schemaVersion`, `mode`, `status`, `currentVersion`, `targetVersion`, `registryKind`, and `reasonCode`
- **AND** the command exits 2

#### Scenario: Stream apply output in JSON mode
- **WHEN** a developer runs `liftoff upgrade --json`
- **THEN** installation progress does not contaminate JSON stdout
- **AND** one final machine-readable result is emitted

#### Scenario: Render human output
- **WHEN** a developer runs upgrade without `--json`
- **THEN** stages, status, remedy, and the exact non-sensitive package operation use the shared terminal presentation

#### Scenario: Disclose the verified Homebrew target
- **WHEN** upgrade selects a verified standard Homebrew prefix
- **THEN** its result identifies only the enumerated target rather than arbitrary filesystem paths
- **AND** human install and exact-version failure guidance retain the verified prefix

## ADDED Requirements

### Requirement: Homebrew upgrades retain one verified target throughout execution
Homebrew prefix recovery SHALL bind registry probes, installation, and replacement verification to the same verified prefix. It SHALL retain the configured registry and authentication policy, execute bounded literal commands from a neutral directory, and never change persistent npm configuration. Check mode SHALL NOT install. Replacement verification SHALL reject a changed global root, escaped package, or mismatched launcher rather than report success for a different installation.

#### Scenario: Check a supported Homebrew installation
- **WHEN** check mode verifies an older Homebrew installation and registry parity
- **THEN** it reports update availability without installation
- **AND** existing packages, user npm configuration, and user cache remain unchanged

#### Scenario: Install and verify at the existing prefix
- **WHEN** apply mode verifies the Homebrew target and exact release
- **THEN** all target-dependent npm operations use the same explicit prefix
- **AND** success requires the replacement package and launcher at that target to identify the exact release

#### Scenario: Registry parity is missing
- **WHEN** the configured scoped or default registry does not expose the canonical release
- **THEN** the Homebrew upgrade blocks without switching registries or installing

#### Scenario: Prefix-specific configuration changes the selected registry
- **WHEN** the active npm and the verified Homebrew prefix select different scoped or default registries
- **THEN** upgrade reports a registry-prefix mismatch before delivery lookup or installation
- **AND** does not expose registry credentials or silently choose a different delivery policy

#### Scenario: Target changes after discovery
- **WHEN** the selected package, prefix, or launcher changes before installation or during replacement
- **THEN** the affected operation fails validation and cannot report a successful upgrade of another installation
