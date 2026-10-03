## MODIFIED Requirements

### Requirement: Automatic upgrade requires a supported global npm installation
Automatic upgrade SHALL require a verified supported installation owner: canonical global npm, Homebrew cask, WinGet, or the Liftoff-owned native installer. The npm lane SHALL continue accepting only the canonical package under its verified global root or separately verified standard macOS Homebrew npm prefix. Every lane SHALL refuse local/npx caches, linked development checkouts, ambiguous ownership, invalid metadata and unsafe escaping paths. Ordinary upgrade SHALL remain within the current owner; npm-to-Homebrew transfer SHALL use the separate approved migration utility.

#### Scenario: Running package is globally installed by npm
- **WHEN** the canonical running package resolves beneath its verified scoped npm global root
- **THEN** discovery selects the npm upgrade lane

#### Scenario: Command runs through npx
- **WHEN** the running package resolves inside an execution cache
- **THEN** upgrade exits 1 without installing another copy and provides explicit installation guidance

#### Scenario: Command runs from a linked checkout
- **WHEN** the apparent installed package resolves into a development checkout
- **THEN** automatic replacement is refused and both checkout and link remain unchanged

#### Scenario: Global root path is unsafe
- **WHEN** discovery finds traversal, collision, unreadable identity, symlink escape or ambiguous ownership
- **THEN** it blocks before installation or a registry-policy change

#### Scenario: Homebrew Node uses its Cellar prefix
- **WHEN** npm reports a Cellar root while the old npm Liftoff package and launcher verify at the corresponding standard Homebrew prefix
- **THEN** the npm lane retains its explicit verified prefix without creating a Cellar copy
- **AND** it does not classify that npm installation as a cask

#### Scenario: Homebrew fallback cannot prove the installation
- **WHEN** runtime, root, metadata or launcher cannot establish the same supported npm installation
- **THEN** the npm fallback remains blocked without inferring a prefix from a suffix

#### Scenario: Windows and Linux retain their existing global-root contracts
- **WHEN** an npm installation runs on Windows or Linux
- **THEN** it retains platform-native global-root checks without the macOS prefix fallback

#### Scenario: Native package manager owns the executable
- **WHEN** verified cask or WinGet metadata owns the running executable
- **THEN** upgrade delegates only to that manager and does not invoke npm replacement

### Requirement: Canonical npm defines the stable target
Canonical npm `latest` SHALL remain the target authority for the npm compatibility lane. Native lanes SHALL use verified stable release identity and independently verified selected-channel availability. All lanes SHALL validate canonical product identity and stable SemVer, distinguish timeout/transport/invalid metadata, and refuse prereleases, unapproved tags and downgrades. An upstream release unavailable through the selected channel SHALL not be reported as installable or as proof the upstream CLI is current.

#### Scenario: Newer stable release exists
- **WHEN** the lane's authoritative stable release is newer and its exact target is available through the selected delivery channel
- **THEN** that exact release becomes the upgrade target

#### Scenario: Current release is latest
- **WHEN** authoritative metadata equals the running version
- **THEN** upgrade reports current, exits 0 and installs nothing

#### Scenario: Canonical target is older
- **WHEN** the authoritative target is lower than the running version
- **THEN** upgrade refuses downgrade with exit 1 and a stable reason

#### Scenario: Canonical metadata body is malformed
- **WHEN** metadata names another product or contains missing, malformed or prerelease stable identity
- **THEN** upgrade reports invalid metadata without installation

#### Scenario: Canonical metadata is unavailable or invalid
- **WHEN** the target cannot be retrieved or validated
- **THEN** upgrade reports the actual unknown/blocked cause rather than current

#### Scenario: Canonical metadata request times out
- **WHEN** lookup or response reading exceeds its bound
- **THEN** upgrade reports timeout distinctly from invalid content and performs no installation

#### Scenario: Homebrew publication is delayed
- **WHEN** the verified upstream stable version is newer than the selected cask
- **THEN** the report names channel lag separately and does not switch installers

### Requirement: Configured registry policy is preserved
For the npm lane, before reporting an installable update or applying one, Liftoff SHALL verify the exact canonical target in the effective configured registry, honoring scoped registry precedence and using a neutral machine-level context. It SHALL isolate canonical identity lookup from delivery checks without modifying configuration, exposing credentials or bypassing a mirror. Native lanes SHALL preserve their verified package-source identity instead of consulting project npm configuration or silently choosing another source.

#### Scenario: Configured registry is canonical
- **WHEN** effective npm configuration uses canonical npm and exposes the target
- **THEN** npm check/apply can proceed

#### Scenario: Scoped registry overrides the default registry
- **WHEN** default and scoped npm registries differ
- **THEN** the scoped registry controls delivery of `@msn-control/liftoff`

#### Scenario: Managed mirror has reached parity
- **WHEN** the effective mirror exposes the exact canonical target
- **THEN** npm apply installs through that mirror without forcing canonical delivery

#### Scenario: Managed mirror is stale
- **WHEN** the effective mirror lacks the target
- **THEN** upgrade blocks with exit 1 and mirror synchronization guidance

#### Scenario: Repository-local npm configuration is isolated
- **WHEN** invocation occurs beside a project `.npmrc`
- **THEN** self-upgrade neither uses it as machine-level authority nor modifies it

#### Scenario: Registry URL contains credentials
- **WHEN** registry configuration contains sensitive URL or authentication values
- **THEN** those values are excluded from reports, telemetry and errors

### Requirement: Check mode is completely read-only
Upgrade check SHALL inspect owner, target, channel availability, compatibility and version without installing, uninstalling, transferring ownership, elevating, changing project/global package state, refreshing a package-manager source persistently, or changing user cache/configuration. Temporary isolated observation material SHALL not become retained installation state.

#### Scenario: Check finds an installable update
- **WHEN** the verified owner can install the exact newer target
- **THEN** check reports update-available with exit 2 and invokes no installer

#### Scenario: Check finds no update
- **WHEN** authoritative metadata establishes the running version is current
- **THEN** check reports current with exit 0

#### Scenario: Check is blocked
- **WHEN** ownership, availability or registry/source policy cannot satisfy the contract
- **THEN** check reports an actionable blocked outcome with exit 1 and performs no mutation

### Requirement: Apply installs one exact package version without elevation
The dedicated upgrade invocation SHALL authorize only one validated same-owner target, not channel migration or unrelated package upgrades. It SHALL use literal commands without a shell, stream progress, preserve approved authentication/source policy, and avoid automatic elevation, configuration writes, package-manager bootstrap and lifecycle scripts. If the owner cannot safely apply the exact reviewed target, Liftoff SHALL provide an explicit manual handoff without claiming an upgrade.

#### Scenario: Apply an available update
- **WHEN** npm installation and registry checks succeed
- **THEN** npm receives the exact canonical package version and verified prefix through the approved registry

#### Scenario: Global installation needs elevated permission
- **WHEN** the owner cannot write its destination
- **THEN** upgrade reports the failure without invoking sudo or requesting an administrator password

#### Scenario: npm times out or fails
- **WHEN** npm cannot start, times out, receives a signal or exits nonzero
- **THEN** upgrade reports failure and no upgraded completion

#### Scenario: Windows executable remains locked
- **WHEN** the Windows owner cannot replace the running executable safely
- **THEN** upgrade reports the supported handoff/restart requirement and actual effects
- **AND** it does not bypass ownership or overwrite a locked executable directly

### Requirement: Upgrade success requires replacement verification
After the selected owner reports success, Liftoff SHALL re-resolve ownership and verify canonical product identity, exact target version, confined executable/assets, launcher resolution and exact `Liftoff <target-version>` output. Ordinary upgrade SHALL report upgraded only after verification and SHALL not claim automatic rollback. The separately approved installer-migration utility retains its own guarded recovery contract.

#### Scenario: Replacement verifies
- **WHEN** ownership, package identity and the executable match the exact target
- **THEN** upgrade reports upgraded with exit 0 and recommends project update only as a separate optional step

#### Scenario: npm success installs the wrong version
- **WHEN** npm exits zero but metadata or executable output differs
- **THEN** verification fails with an exact owner-specific repair remedy

#### Scenario: Replacement binary escapes its package
- **WHEN** installed metadata points outside the verified root or to an unsafe file
- **THEN** verification fails before running that target

#### Scenario: Recovery after failure
- **WHEN** ordinary upgrade fails installation or verification
- **THEN** it reports actual previous/target identity and owner-specific recovery without asserting automatic restoration

### Requirement: Upgrade output is stable and non-sensitive
Upgrade SHALL use shared human presentation and schema-2 JSON with mode, status, reason, current/target version, enumerated installation owner, upstream/channel availability and applicable non-sensitive registry/prefix hints. It SHALL exclude credentials, raw manager responses, private config paths, arbitrary installation/project paths and secret arguments. Historical schema-1 output remains documented as the npm-only contract.

#### Scenario: Emit JSON update availability
- **WHEN** a valid upgrade check finds an installable update
- **THEN** stdout contains one schema-2 result identifying its owner and target with exit 2

#### Scenario: Stream apply output in JSON mode
- **WHEN** upgrade applies with JSON output
- **THEN** child progress uses stderr and stdout contains one final result

#### Scenario: Render human output
- **WHEN** JSON is absent
- **THEN** shared stages, status, exact non-sensitive operation and remedy identify the actual owner

#### Scenario: Disclose the verified Homebrew target
- **WHEN** the npm compatibility lane uses a verified standard Homebrew Node prefix
- **THEN** its enumerated hint and exact local remedy retain that prefix without claiming cask ownership
