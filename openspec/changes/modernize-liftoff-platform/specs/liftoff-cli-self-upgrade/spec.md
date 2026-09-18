## MODIFIED Requirements

### Requirement: Liftoff exposes a distinct CLI self-upgrade command
The system SHALL provide `liftoff upgrade` to request an owner-aware upgrade of the installed native Liftoff CLI and `liftoff upgrade --check` to inspect availability without mutation. The commands SHALL run without a Liftoff project, SHALL NOT read or write project manifests or generated artifacts, and SHALL NOT invoke `liftoff update`, `liftoff init`, project adoption, or installation migration. A legacy npm installation SHALL require the separately selected native handover rather than an implicit change of owner.

#### Scenario: Upgrade outside a project
- **WHEN** a developer runs `liftoff upgrade` from a directory with no Liftoff manifest
- **THEN** CLI installation discovery and upgrade behavior proceed normally
- **AND** no project is created or required

#### Scenario: Upgrade inside a project
- **WHEN** a developer runs `liftoff upgrade` inside a generated or adopted project
- **THEN** the command operates only on the supported installed CLI package
- **AND** leaves every project file byte-for-byte unchanged

#### Scenario: Distinguish update from upgrade
- **WHEN** command help or completion describes `upgrade`
- **THEN** it states that upgrade replaces the installed CLI through its actual owner
- **AND** update separately reconciles a project's explicitly managed artifacts through review and approval

### Requirement: Check mode is completely read-only
`liftoff upgrade --check` SHALL perform installation-owner, native release identity, supported-target, configured delivery-source and version checks without requesting installation, persistent cache/catalog refresh, telemetry notice-state writes, source reconfiguration, project writes or installation changes. Liftoff SHALL disable automatic manager refresh where supported and report source staleness rather than refresh implicitly. Unavoidable read-only manager/OS diagnostic logging and confined disposable probe scratch SHALL be distinguished from persistent product/configuration mutation and SHALL NOT authorize a source refresh. Upstream availability and the current owner's ability to deliver the same exact target SHALL remain separate.

#### Scenario: Check finds an installable update
- **WHEN** a verified native installation is older than the authoritative stable target and its approved owner can deliver that exact qualified target
- **THEN** the command reports `update-available` and exits 2
- **AND** it runs no installation or source refresh

#### Scenario: Check finds no update
- **WHEN** the running version equals the verified native stable target
- **THEN** the command reports `current` and exits 0

#### Scenario: Check is blocked
- **WHEN** installation ownership, platform support, artifact verification, or configured-source readiness cannot satisfy the upgrade contract
- **THEN** the command exits 1 with an actionable stable reason
- **AND** performs no mutation

#### Scenario: Manager knowledge may be stale
- **WHEN** a read-only source observation cannot establish that the configured catalog is current
- **THEN** the result distinguishes source staleness or required manual refresh from no upstream update
- **AND** it does not run a refresh automatically

### Requirement: Apply installs one exact package version without elevation
Invoking the dedicated `liftoff upgrade` command SHALL constitute explicit authorization for one internally bound exact verified target through the current proven installation owner. Liftoff SHALL display the target and owner-specific operation without requiring a second Liftoff confirmation or an extra plan flag for ordinary owner-preserving upgrades. It SHALL delegate only the identified Liftoff package to Homebrew or WinGet, or use the verified direct-install staged replacement protocol for a direct owner. It SHALL execute bounded literal executable/argument commands, preserve approved delivery and authentication policy, stream progress, and SHALL NOT elevate, rewrite persistent source configuration, upgrade unrelated packages, invoke npm replacement, or silently switch owners. Installation migration SHALL retain its separate exact-plan approval.

#### Scenario: Apply an available update
- **WHEN** owner, target and source checks succeed for the explicit upgrade invocation and the target is newer
- **THEN** execution requests only the verified Liftoff package at that exact target through the identified owner
- **AND** an owner unable to select the approved target blocks rather than installs a floating or different version

#### Scenario: Global installation needs elevated permission
- **WHEN** the selected owner cannot modify its installation under the current authority
- **THEN** Liftoff reports the permission failure and owner-specific remedy
- **AND** it does not invoke `sudo`, request an administrator password, or retry with elevation

#### Scenario: npm times out or fails
- **WHEN** inspection of a legacy npm installation cannot start npm, times out, receives a signal, or observes a nonzero result
- **THEN** the native command exits 1 with the actual ownership-inspection failure
- **AND** it does not invoke npm installation, print an upgraded completion, or infer a different owner

#### Scenario: The native owner fails
- **WHEN** a native manager or direct replacement cannot start, times out, receives a signal, or fails
- **THEN** upgrade exits 1 and reports the actual recorded effects and recovery state
- **AND** it does not print a successful replacement

#### Scenario: Installation facts change after selection
- **WHEN** ownership, target, source or destination facts change after the exact operation was selected
- **THEN** no replacement under the stale operation is executed
- **AND** the command reports the mismatch rather than silently substituting another owner or target

#### Scenario: Automation requests an ordinary upgrade
- **WHEN** the dedicated upgrade command is explicitly invoked without a TTY for a supported current owner
- **THEN** it can perform the exact validated owner-preserving operation without a new fingerprint flag
- **AND** the invocation does not authorize an installation migration, elevation or project mutation

### Requirement: Upgrade success requires replacement verification
After the selected owner reports success, the system SHALL re-observe that same installation owner and verify the canonical product, exact target version, trusted artifact/runtime/resource identity, confined launcher, and exact `Liftoff <target-version>` output from the replacement. It SHALL verify explicit-path invocation and normal command resolution before reporting `upgraded`. It SHALL NOT claim success merely because a manager exited zero or another installation reports the target version.

#### Scenario: Replacement verifies
- **WHEN** the same owner's installed identity, explicit replacement invocation, and effective command resolution all identify the exact target
- **THEN** the command reports `upgraded` and exits 0
- **AND** recommends `liftoff update --check` only as a separate optional project step

#### Scenario: npm success installs the wrong version
- **WHEN** a historical npm operation reports success but its installed package or version output differs from its selected historical target
- **THEN** historical recovery remains an explicit exact-version npm repair rather than evidence of native upgrade success
- **AND** the native command does not adopt that package as a verified native replacement

#### Scenario: Replacement binary escapes its package
- **WHEN** the replacement launcher resolves outside its verified owner-controlled payload boundary or to an unsafe target
- **THEN** verification fails before executing that target

#### Scenario: Recovery after failure
- **WHEN** installation or post-install verification fails
- **THEN** Liftoff reports previous and target identities, actual completed effects, and an exact owner-specific recovery path without credentials
- **AND** it does not claim an automatic cross-owner rollback or blindly restore earlier bytes over changed work

#### Scenario: Native manager success installs the wrong version
- **WHEN** Homebrew, WinGet, or direct replacement reports success but the owner record, resources, or version output differs from the approved target
- **THEN** upgrade reports verification failure and exits 1
- **AND** it does not verify a different PATH installation to manufacture success

### Requirement: Upgrade output is stable and non-sensitive
The command SHALL use the shared human presentation model and versioned byte-pure JSON for check and apply. The native result contract SHALL expose mode, stable status, current and applicable target versions, verified installation owner, upstream and owner availability, stable reason, and any required manual or handover action through bounded public fields. Historical npm result semantics SHALL remain distinguishable from this native contract. Output SHALL NOT expose credentials, raw source responses, private source/configuration URLs, arbitrary package/project paths, or secret-bearing command arguments; detailed local path investigation belongs to explicit installation inspection.

#### Scenario: Emit JSON update availability
- **WHEN** a developer runs `liftoff upgrade --check --json` and an installable native update exists
- **THEN** stdout contains one versioned native result with mode, status, current and target versions, owner, availability observations, and reason
- **AND** the command exits 2

#### Scenario: Stream apply output in JSON mode
- **WHEN** a developer runs `liftoff upgrade --json`
- **THEN** installation progress does not contaminate JSON stdout
- **AND** one final machine-readable result is emitted

#### Scenario: Render human output
- **WHEN** a developer runs upgrade without `--json`
- **THEN** stages, status, remedy, and the exact non-sensitive owner-specific package operation use the shared terminal presentation

#### Scenario: Disclose the verified Homebrew target
- **WHEN** upgrade selects a verified native Homebrew package
- **THEN** the result identifies the registered public package/tap target rather than arbitrary filesystem paths
- **AND** installation and recovery guidance retain that same owner identity

### Requirement: Upgrade behavior is cross-platform and location-independent
Owner discovery, package containment, neutral working directories, executable resolution, and replacement verification SHALL use platform-native path and shim behavior on Windows, macOS, and Linux. Different current directories, including paths with spaces, SHALL NOT change delivery policy, installation target, or project bytes. Runtime/package paths alone SHALL NOT substitute for manager records or a direct-install receipt.

#### Scenario: Upgrade on Windows
- **WHEN** a supported WinGet installation is inspected or upgraded on Windows
- **THEN** package and launcher paths use Windows semantics and the qualified executable adapter
- **AND** no POSIX global layout or path separator is assumed

#### Scenario: Upgrade from a repository with local npm configuration
- **WHEN** the current directory contains a project `.npmrc`
- **THEN** native upgrade resolves owner and delivery policy independently of that project configuration
- **AND** the project file is neither used as authority nor modified

#### Scenario: Test upgrade behavior
- **WHEN** automated tests exercise apply mode
- **THEN** they use isolated native installation roots, owner/source fixtures, and isolated historical npm prefixes where migration evidence is needed
- **AND** never mutate the host's real Liftoff installation, caches, or persistent package-manager configuration

#### Scenario: Native paths collide
- **WHEN** a Windows case collision, unsafe symlink, traversal, or ambiguous launcher prevents unique containment
- **THEN** discovery or verification fails before executing a replacement
- **AND** equivalent confinement checks apply on macOS and Linux

### Requirement: Homebrew upgrades retain one verified target throughout execution
Native Homebrew upgrades SHALL bind source observations, command-specific authorization, installation, and replacement verification to the same verified Liftoff tap/cask and owner record. Commands and owner discovery SHALL explicitly distinguish the selected cask from formulae and same-named packages. They SHALL retain approved source/authentication policy, use bounded literal commands from a neutral context, and never rewrite persistent configuration. Check mode SHALL NOT install or refresh sources. A changed owner, escaped payload, mismatched launcher, or different package source SHALL block rather than permit success for another installation. Homebrew-owned Node with npm-owned Liftoff SHALL NOT enter this native upgrade lane.

#### Scenario: Check a supported Homebrew installation
- **WHEN** check mode verifies an older native Homebrew Liftoff installation and exact source availability
- **THEN** it reports update availability without installation
- **AND** existing packages, source configuration, catalogs, and caches remain unchanged

#### Scenario: Install and verify at the existing prefix
- **WHEN** apply mode verifies the native Homebrew owner and exact release
- **THEN** all target-dependent operations remain bound to that owner's package record and approved destination
- **AND** success requires the replacement package and launcher at that target to identify the exact release

#### Scenario: Registry parity is missing
- **WHEN** the configured Homebrew source does not expose the authoritative native target
- **THEN** the upgrade reports upstream availability and blocked owner delivery separately
- **AND** it does not switch sources or install directly

#### Scenario: Prefix-specific configuration changes the selected registry
- **WHEN** the verified Homebrew installation context selects a different package source or delivery policy from the one observed for approval
- **THEN** upgrade reports a source/owner mismatch before installation
- **AND** it neither exposes private source credentials nor silently chooses another delivery policy

#### Scenario: Target changes after discovery
- **WHEN** the selected package, owner record, destination, or launcher changes before installation or during replacement
- **THEN** the affected operation fails validation
- **AND** it cannot report a successful upgrade of another installation

#### Scenario: Upgrade explicitly selects the cask
- **WHEN** routine upgrade operates on the verified native macOS installation
- **THEN** its displayed and executed Homebrew operation explicitly selects the registered Liftoff cask and exact admitted target
- **AND** it does not select a formula, another tap's token or an npm-owned launcher as a substitute

## ADDED Requirements

### Requirement: Automatic upgrade follows proven native installation ownership
Automatic upgrade SHALL support only a verified native Homebrew owner, native WinGet owner, or registered direct-install receipt for the running Liftoff installation. It SHALL reject local dependencies, npm execution-cache copies, linked development checkouts, unlinked candidates, ambiguous ownership, unsafe paths, and unsupported owners with an explicit remedy. Legacy npm installations SHALL be identified as requiring separately approved installation migration, including when their Node runtime is Homebrew-owned.

#### Scenario: Running package has a supported native owner
- **WHEN** the manager record or direct-install receipt matches the running canonical product and launcher
- **THEN** upgrade uses that owner and no other replacement channel

#### Scenario: A native candidate is not yet registered
- **WHEN** the developer invokes upgrade from an unlinked bundle
- **THEN** automatic replacement remains blocked
- **AND** guidance identifies installation inspection or explicitly selected installation migration

#### Scenario: Homebrew Node does not own Liftoff
- **WHEN** npm installed `@msn-control/liftoff` beneath a prefix associated with Homebrew Node
- **THEN** the installation remains npm-owned and migration-required
- **AND** native upgrade does not issue a Homebrew replacement based on that path

#### Scenario: A linked checkout is discovered
- **WHEN** a launcher resolves to a development checkout or package execution cache
- **THEN** automatic replacement is refused
- **AND** the checkout, link, cache, and any existing native installation are preserved

### Requirement: Native release authority is separate from configured delivery
Upgrade SHALL discover stable targets through bounded validation of the authoritative schema-1 native release manifest, not npm `latest`. The selected target SHALL match the canonical product and supported platform, identify immutable signed artifacts, and be a stable semantic version not lower than the running version. Timeout, transport failure, malformed identity, unsupported platform, and owner-source readiness SHALL remain distinguishable outcomes.

#### Scenario: Newer stable release exists
- **WHEN** the verified native manifest identifies a newer stable release for the supported host
- **THEN** that exact release becomes the only candidate target
- **AND** configured-owner delivery is checked separately

#### Scenario: Native authority is older
- **WHEN** the authoritative target is lower than the running version
- **THEN** upgrade refuses a downgrade and exits 1 with a stable reason

#### Scenario: Metadata is malformed or unavailable
- **WHEN** lookup times out, fails transport, names a different product, returns an invalid version, or selects a prerelease as stable
- **THEN** upgrade exits 1 without installation
- **AND** the actual timeout, transport, or invalid-metadata cause remains distinguishable, including timeout while reading the body

#### Scenario: npm still serves its historical latest
- **WHEN** npm `latest` names the final historical npm version while a native release is newer
- **THEN** the native command does not classify the historical npm tag as current release authority

### Requirement: Source policy and handover blockers never authorize channel replacement
Upgrade SHALL preserve the actual owner's approved tap, WinGet source, enterprise mirror, and authentication policy. Upstream availability, manager lag, unobservable or stale catalogs, unsupported targets, enterprise restrictions, permission failures, and Windows locks SHALL be explicit states with causal remedies. A blocked state SHALL NOT authorize automatic source reconfiguration, direct download over manager-owned files, package-manager bootstrapping, or npm-to-native migration.

#### Scenario: WinGet catalog lags upstream
- **WHEN** the signed upstream native target exists but the configured WinGet source does not offer the exact version
- **THEN** upgrade reports the target and blocked manager availability
- **AND** it does not replace the WinGet installation with a direct archive

#### Scenario: Enterprise delivery is approved
- **WHEN** the configured enterprise source can deliver the verified exact target under the installation owner's policy
- **THEN** upgrade uses that source without forcing a public-source override

#### Scenario: Windows replacement is locked
- **WHEN** the owner cannot complete replacement because a relevant executable is in use
- **THEN** upgrade reports an explicit close or handover action and preserves the usable current installation
- **AND** it does not terminate unrelated processes or clean an active version directory

#### Scenario: Direct replacement verification fails
- **WHEN** a receipt-owned direct candidate fails verification before launcher activation
- **THEN** the old usable version remains selected and the failed stage is reported
- **AND** any cleanup uses the exact owned-version inventory rather than filename patterns

## REMOVED Requirements

### Requirement: Automatic upgrade requires a supported global npm installation
**Reason**: The coordinated release has native-only delivery. A global npm installation is a historical owner, not eligibility for native replacement.
**Migration**: Use verified native owner discovery for upgrade. Historical npm users follow `installation inspect` and separately approved `installation migrate --to <owner>` from a verified unlinked bundle, preserving Node/npm and project dependencies.

### Requirement: Canonical npm defines the stable target
**Reason**: No new npm release or bridge is published, so npm `latest` cannot identify current native releases.
**Migration**: Resolve the signed immutable native release manifest and separately verify delivery through the actual installation owner. Retain canonical npm only for historical package verification and owner-specific historical recovery.

### Requirement: Configured registry policy is preserved
**Reason**: Current self-upgrade no longer installs through npm registry selection or the historical npm-prefix fallback.
**Migration**: Preserve the configured native owner's source and enterprise policy without cross-channel fallback. Historical npm verification and recovery retain scoped-registry precedence, neutral-context inspection, exact-version parity, and credential protection under the historical npm distribution contract.
