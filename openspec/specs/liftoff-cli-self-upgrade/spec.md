## Purpose

Allow developers to discover and install the current stable Liftoff CLI release safely while keeping CLI installation separate from generated-project updates.

## Requirements

### Requirement: Liftoff exposes a distinct CLI self-upgrade command
The system SHALL provide `liftoff upgrade` to upgrade the installed Liftoff CLI and `liftoff upgrade --check` to inspect upgrade availability without mutation. The command SHALL run without a Liftoff project, SHALL NOT read or write project manifests or generated artifacts, and SHALL NOT invoke `liftoff update`.

#### Scenario: Upgrade outside a project
- **WHEN** a developer runs `liftoff upgrade` from a directory with no Liftoff manifest
- **THEN** CLI installation discovery and upgrade behavior proceed normally
- **AND** no project is created or required

#### Scenario: Upgrade inside a project
- **WHEN** a developer runs `liftoff upgrade` inside a generated project
- **THEN** the command operates only on the supported installed CLI package
- **AND** leaves every project file byte-for-byte unchanged

#### Scenario: Distinguish update from upgrade
- **WHEN** command help or completion describes `upgrade`
- **THEN** it states that `upgrade` replaces the installed CLI
- **AND** that `update` separately reconciles a generated project with the installed CLI's templates

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

### Requirement: Check mode is completely read-only
`liftoff upgrade --check` SHALL perform installation-origin, canonical-target, configured-registry, and version checks without running a package installation or changing the filesystem, npm cache, npm configuration, project state, or global package state beyond unavoidable read-only command behavior.

#### Scenario: Check finds an installable update
- **WHEN** a supported global installation is older than canonical `latest` and the configured registry exposes the exact target
- **THEN** the command reports `update-available` and exits 2
- **AND** does not invoke npm install

#### Scenario: Check finds no update
- **WHEN** the running version equals canonical `latest`
- **THEN** the command reports `current` and exits 0

#### Scenario: Check is blocked
- **WHEN** installation origin or registry parity cannot satisfy the upgrade contract
- **THEN** the command exits 1 with an actionable reason
- **AND** performs no mutation

### Requirement: Apply installs one exact package version without elevation
`liftoff upgrade` SHALL treat invocation of the dedicated command as explicit authorization to install the exact validated target through npm's global installation mechanism. It SHALL execute npm without a shell, SHALL preserve effective approved registry authentication, SHALL stream progress, and SHALL NOT invoke elevation, write npm configuration, install a floating tag, or run package lifecycle scripts.

#### Scenario: Apply an available update
- **WHEN** installation and registry checks succeed and the target is newer
- **THEN** npm receives the canonical scoped package name with the exact target version for global installation
- **AND** installation uses the effective configured registry policy

#### Scenario: Global installation needs elevated permission
- **WHEN** npm cannot write the global prefix and exits unsuccessfully
- **THEN** Liftoff reports failure and npm's actionable result
- **AND** does not invoke `sudo`, request an administrator password, or retry with elevation

#### Scenario: npm times out or fails
- **WHEN** npm cannot start, times out, receives a signal, or exits nonzero
- **THEN** the command exits 1 and does not print an upgraded completion

### Requirement: Upgrade success requires replacement verification
After npm reports success, the system SHALL re-resolve the effective global installation and verify the canonical package name, exact target version, confined declared binary, and exact `Liftoff <target-version>` output from that replacement binary. It SHALL report `upgraded` only after all checks succeed.

#### Scenario: Replacement verifies
- **WHEN** installed metadata and the replacement binary both identify the exact target
- **THEN** the command reports `upgraded` and exits 0
- **AND** recommends `liftoff update --check` as a separate optional project step

#### Scenario: npm success installs the wrong version
- **WHEN** npm exits zero but installed package metadata or version output differs from the target
- **THEN** the command reports verification failure and exits 1
- **AND** gives an exact manual reinstall remedy

#### Scenario: Replacement binary escapes its package
- **WHEN** installed bin metadata resolves outside the verified global package root or to a non-regular file
- **THEN** verification fails before executing that target

#### Scenario: Recovery after failure
- **WHEN** installation or post-install verification fails
- **THEN** Liftoff does not claim or attempt an automatic rollback
- **AND** reports the previous and target versions plus an explicit exact-version npm repair command without sensitive registry data

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

### Requirement: Upgrade behavior is cross-platform and location-independent
Global-root discovery, package containment, temporary working directories, executable resolution, and replacement verification SHALL use platform-native path behavior on Windows, macOS, and Linux. Running from different current directories, including paths with spaces, SHALL not change registry selection, package target, or project bytes.

#### Scenario: Upgrade on Windows
- **WHEN** a supported npm global installation is inspected or upgraded on Windows
- **THEN** npm and package paths use Windows semantics and the platform-correct executable adapter
- **AND** no POSIX global layout or path separator is assumed

#### Scenario: Upgrade from a repository with local npm configuration
- **WHEN** the current directory contains a project `.npmrc`
- **THEN** CLI upgrade resolves registry policy from the neutral machine-level context
- **AND** the project file is neither used as authority nor modified

#### Scenario: Test upgrade behavior
- **WHEN** automated tests exercise apply mode
- **THEN** they use an isolated temporary npm prefix, cache, home, and injected registry responses
- **AND** never mutate the host's real global Liftoff installation

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
