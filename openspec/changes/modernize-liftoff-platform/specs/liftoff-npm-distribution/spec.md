## MODIFIED Requirements

### Requirement: Documentation presents the global install path
Documentation SHALL present the qualified native channel as primary for each supported platform and global npm as a supported transition/compatibility path. It SHALL distinguish embedded CLI runtime requirements from external project toolchains and the npm package's supported Node.js baseline. Canonical npm SHALL remain authoritative for npm releases, with configured mirror delivery and no automatic policy bypass.

#### Scenario: Developer reads install instructions
- **WHEN** a supported user opens the README
- **THEN** it identifies the Homebrew cask, WinGet or verified Linux installation path and links npm transition guidance
- **AND** it does not present an unpublished package ID or unqualified platform as available

#### Scenario: Developer uses a managed registry
- **WHEN** an existing npm user is routed through a managed registry
- **THEN** guidance requires target parity and directs synchronization to the mirror operator
- **AND** migration does not silently change npm configuration

#### Scenario: Contributor reads source instructions
- **WHEN** a contributor builds from source
- **THEN** commands run from the repository root with the declared development toolchain and no workspace selector

#### Scenario: Developer verifies the installed version
- **WHEN** native or npm installation completes
- **THEN** guidance uses `liftoff --version` and owner-aware diagnosis

#### Scenario: Developer reads first-use instructions
- **WHEN** first-use guidance is read
- **THEN** help, plan and init remain current commands and create remains unsupported

#### Scenario: Developer reads runtime requirements
- **WHEN** runtime guidance is read
- **THEN** native bundles need no global Node merely to start, while npm and selected project toolchains retain their declared requirements

### Requirement: Self-upgrade preserves canonical and managed registry boundaries
For npm-owned installations, canonical npm SHALL remain stable-target authority and the effective configured registry SHALL remain delivery authority with exact-version parity. Native installations SHALL use their verified release/channel contracts instead of npm delivery checks. No lane SHALL rewrite registry configuration, bypass a managed source or silently transfer installation ownership.

#### Scenario: Approved mirror exposes canonical target
- **WHEN** a managed npm registry exposes the exact canonical stable version
- **THEN** a verified npm installation can upgrade through it

#### Scenario: Approved mirror is stale
- **WHEN** the mirror lacks that target
- **THEN** npm self-upgrade remains blocked without treating native availability as consent to change channel

## ADDED Requirements

### Requirement: npm users retain a non-destructive native transition path
The release SHALL publish and qualify an npm bridge exposing compatible upgrade behavior and verified native-migration guidance only after the native target is available. Historical npm tarballs/provenance SHALL remain retrievable. Ordinary startup or upgrade SHALL not uninstall npm Liftoff automatically. Retirement of ongoing npm publication SHALL require a separately approved support decision rather than occur implicitly in this modernization.

#### Scenario: Existing user upgrades through npm
- **WHEN** a compatible old user installs the bridge through its approved registry
- **THEN** the CLI remains usable and exposes the separate Apple Silicon migration path without changing projects

#### Scenario: Old release has no upgrade command
- **WHEN** a user predates self-upgrade
- **THEN** guidance provides a verified standalone migration or approved manual npm update path rather than invoking unavailable commands

#### Scenario: Release qualification expands to native artifacts
- **WHEN** native assets are added to release automation
- **THEN** existing qualified-ref, immutable-tag, exact-artifact, maintainer approval, provenance and non-publishing validation protections remain enforced
- **AND** npm-side account settings are not modified as a side effect
