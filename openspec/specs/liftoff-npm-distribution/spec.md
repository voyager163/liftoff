## Purpose

Define retained historical npm distribution, immutable artifacts and provenance, and version-specific verification and recovery for Liftoff. npm is not a current delivery channel: new releases use qualified native distribution, with no new npm edition or migration bridge.

## Requirements

### Requirement: Published package contains runtime assets
Historical npm artifacts SHALL retain their originally published compiled runtime assets, packaged governance data, README/documentation, package metadata, and licensing needed to execute and redistribute the selected historical release without repository source or user-side TypeScript compilation. Verification SHALL use that release's explicit package inventory and command contract, including its applicable exclusions for retired Power Apps assets, contributor-only tools, caches, and retired release helpers. Installed historical resource lookup SHALL remain package-root-relative and cwd-independent; this requirement SHALL NOT create a duty to pack or publish a new npm edition.

#### Scenario: Package contents are inspected before publish
- **WHEN** the retained pre-publication evidence for a historical npm release is inspected or its exact tarball is verified
- **THEN** the evidence identifies its `package.json`, `README.md`, `LICENSE`, compiled `dist` entrypoint, and required runtime assets
- **AND** exclusions are evaluated against that release's inventory rather than retroactively modifying the tarball

#### Scenario: Installed CLI runs outside the repository
- **WHEN** an explicit historical package is installed into an isolated environment with its supported external Node runtime
- **THEN** the release's supported help command runs outside the public Liftoff repository
- **AND** it does not require the repository's `src`, tests, or development configuration

#### Scenario: Installed asset lookup is cwd-independent
- **WHEN** a historical CLI resolves its packaged assets from an arbitrary working directory, including paths with spaces on Windows, macOS, or Linux
- **THEN** asset resolution uses that installed package's verified root
- **AND** it does not use the current native bundle or a repository-relative replacement

### Requirement: Published releases are verified from canonical npm
Historical npm publications SHALL remain verifiable against `https://registry.npmjs.org` using their explicit published version, immutable tarball identity, and retained source/provenance. Historical dist-tag claims SHALL be checked against the corresponding retained publication evidence, not required to match the current native release or a tag's former value today. Verification SHALL use isolated prefix, cache, and home paths with native Windows, macOS, and Linux semantics and SHALL report expected/observed identity mismatches. It SHALL NOT publish, move a tag, or change persistent npm configuration.

#### Scenario: Stable publication satisfies the canonical registry postcondition
- **WHEN** the retained evidence of a historical stable npm publication is verified
- **THEN** it shows the expected version on the selected tag at publication time
- **AND** an isolated explicit-version canonical installation verifies the same historical package identity

#### Scenario: Published package executes from the canonical installation
- **WHEN** verification installs the selected explicit historical version from canonical npm
- **THEN** version, help, and standard-project planning are checked only where supported by that release's registered command surface
- **AND** all supported commands run outside the repository

#### Scenario: Canonical registry publication mismatch fails release verification
- **WHEN** canonical npm serves different bytes or package/version metadata from the selected immutable historical release
- **THEN** historical verification fails with the expected and observed identities
- **AND** it does not report the historical package verified or treat native availability as registry parity

### Requirement: Unsupported releases are deprecated non-destructively
Unsupported historical npm release lines SHALL retain non-destructive deprecation guidance, published tarballs, provenance, and explicit-version availability. Deprecation and migration guidance SHALL explain the native-only cutover and lack of an npm bridge without altering historical executable bytes or implying that npm can update to a native-only version.

#### Scenario: Developer requests an unsupported pre-0.3 release
- **WHEN** a synchronized npm registry installs an explicitly requested pre-0.3 Liftoff version
- **THEN** npm presents deprecation guidance
- **AND** current migration guidance directs the developer to the native installation journey rather than promising another npm release

#### Scenario: Historical package remains reproducible
- **WHEN** a lockfile or diagnostic workflow explicitly resolves a deprecated historical Liftoff version
- **THEN** the package remains available
- **AND** the release process does not unpublish or replace it

### Requirement: Liftoff distribution metadata identifies the public source repository
Historical post-extraction npm metadata and provenance SHALL retain `voyager163/liftoff` as source, homepage, and issue-reporting authority, without a nested repository directory. The native cutover SHALL preserve those historical public-source and short-lived trusted-publication attestations rather than rewriting npm provenance to represent the new distribution.

#### Scenario: Developer inspects published metadata
- **WHEN** a developer queries a historical post-extraction `@msn-control/liftoff` release
- **THEN** the repository URL points to `https://github.com/voyager163/liftoff`
- **AND** homepage and issue links resolve to public Liftoff resources without a `tools/liftoff-cli` repository directory

#### Scenario: Developer inspects source provenance
- **WHEN** a developer inspects provenance for a Liftoff npm version published after the split
- **THEN** the attestation identifies the public repository, historical release workflow, and original source commit
- **AND** native distribution does not delete or relabel that attestation

### Requirement: Release version identity is coherent before publication
Historical npm verification SHALL retain the original coherence requirement among root package metadata, root lockfile metadata, the historical Git tag where applicable, packed metadata, and installed version output. It SHALL compare against the selected historical source revision, not today's native release metadata, and SHALL NOT use this historical verification path to publish a new package.

#### Scenario: Prepare the first version-reporting release
- **WHEN** the retained pre-publication evidence for Liftoff `0.3.4`, the first version-reporting npm release, is verified
- **THEN** its recorded root package and lockfile metadata identify `0.3.4`
- **AND** its isolated historical installation prints `Liftoff 0.3.4`

#### Scenario: Tag-triggered release matches package metadata
- **WHEN** historical verification selects Git tag `v0.3.4`
- **THEN** the package, lockfile, and packed metadata from that tag all identify `0.3.4`

#### Scenario: Release identity mismatch blocks publication
- **WHEN** a historical tag, root package version, lockfile version, packed version, or required installed version result disagrees
- **THEN** historical verification fails with the expected and observed identities
- **AND** neither that failure nor its remedy authorizes a new npm publication

### Requirement: Registry onboarding preserves release version identity
Historical npm onboarding and recovery SHALL identify the explicit intended npm version and verify that the approved registry delivers it unchanged. Historical stable-tag onboarding claims SHALL remain bound to their original publication evidence; current npm `latest` SHALL NOT be required to equal an earlier historical release or the native stable release. Canonical historical availability and managed-registry readiness SHALL remain independently observable, with no automatic configuration change or registry bypass.

#### Scenario: Canonical npm exposes Liftoff 0.3.4
- **WHEN** canonical availability of historical Liftoff `0.3.4` is verified
- **THEN** explicit `@msn-control/liftoff@0.3.4` metadata and isolated installation identify `0.3.4`
- **AND** its original `latest` publication claim is evaluated against retained evidence rather than moving today's tag

#### Scenario: Approved managed registry reaches parity
- **WHEN** an organization approves its managed registry for explicit historical `0.3.4` recovery
- **THEN** that registry exposes the expected explicit package/version identity
- **AND** a clean installation through that registry prints `Liftoff 0.3.4`

#### Scenario: Managed registry remains stale
- **WHEN** the approved registry rejects the intended historical version or serves different metadata, bytes, or executable identity
- **THEN** recovery through that registry remains blocked with the actual mismatch
- **AND** Liftoff does not modify npm configuration or silently use another registry

### Requirement: Package smoke testing verifies the init command surface
Historical package smoke verification SHALL use the selected release's registered command surface in an isolated installation without changing the workstation. For historical releases supporting the renamed initialization and self-upgrade surfaces, it SHALL retain init help, side-effect-free planning, create rejection, and public-entrypoint checks. Native installed-command qualification SHALL be performed under the native release contract, not by requiring a new npm tarball.

#### Scenario: Installed init command is available
- **WHEN** an explicit historical release supporting `init` is installed for verification
- **THEN** `liftoff init --help` exits 0 and documents that release's init arguments and consent flags

#### Scenario: Installed create command is absent
- **WHEN** verification invokes `liftoff create` on a historical release in which it was retired
- **THEN** it exits 1, recommends `liftoff init`, and creates no project files

#### Scenario: Installed plan remains side-effect free
- **WHEN** verification runs a fully specified supported `liftoff plan`
- **THEN** it exits successfully without installing tools or creating a project directory

#### Scenario: Public entrypoint remains stable after refactoring
- **WHEN** a selected historical release is invoked through its published `liftoff` binary outside the repository
- **THEN** its supported help, plan, and upgrade-help commands run through that entrypoint
- **AND** no source-import-only entrypoint is required

### Requirement: Published Liftoff requires the supported Node.js LTS baseline
Historical npm packages SHALL retain the external Node.js engine and startup requirements of their own published release. For v0.12.3, verification SHALL enforce the recorded Node.js 24 LTS floor and its concise unsupported-runtime guidance. Historical runtime constraints SHALL NOT impose global Node/npm as a prerequisite for the self-contained native CLI or retroactively change older package metadata.

#### Scenario: Install with a supported Node.js runtime
- **WHEN** a developer installs and runs historical npm v0.12.3 with a runtime satisfying its recorded Node.js 24 LTS floor
- **THEN** the command can start and render help

#### Scenario: Run with an unsupported Node.js runtime
- **WHEN** historical npm v0.12.3 starts below its recorded floor
- **THEN** it exits 1 before project commands or side effects
- **AND** it reports the observed and minimum supported versions

#### Scenario: Release package and runtime catalog disagree
- **WHEN** historical verification finds that selected package engine metadata, startup behavior, retained workflow setup, or release-specific documentation disagrees with that release's baseline
- **THEN** historical verification fails with the discrepancy
- **AND** the current native runtime is not used to hide it

### Requirement: A global npm installation can replace itself with a verified stable release
Historical npm versions with self-upgrade support SHALL retain their published ability to discover a newer historical npm stable target, verify configured-registry parity, replace the exact global npm package, and verify its replacement outside the source repository. That historical mechanism SHALL NOT be described as discovering or installing native-only releases. Current native migration guidance SHALL remain necessary even for npm installations whose `upgrade` command reports current.

#### Scenario: Upgrade a canonical global installation
- **WHEN** a historical global npm CLI supports upgrade and a newer published npm stable target exists through its effective registry
- **THEN** its historical contract replaces the exact global package and verifies the same npm version
- **AND** that result makes no claim about native release availability or native ownership

#### Scenario: Inspect a packed package
- **WHEN** historical verification installs a self-upgrade-capable npm artifact into an isolated global prefix
- **THEN** `liftoff upgrade --help` works outside the repository
- **AND** the artifact retains the self-upgrade runtime modules it originally published

#### Scenario: Last npm release reports current
- **WHEN** the historical updater reaches the last npm stable target
- **THEN** native migration guidance explicitly states that a newer native release may still exist
- **AND** no additional npm bridge is required or promised

### Requirement: Self-upgrade preserves canonical and managed registry boundaries
For historical npm self-upgrade and recovery only, canonical npm SHALL remain the authority for the selected historical npm stable target while the user's effective approved npm registry remains its delivery path. Historical inspection SHALL preserve scoped-registry precedence over the default registry, neutral machine-level configuration, exact-version parity, and credential protection, including a verified npm-owned Liftoff package beneath Homebrew Node. It SHALL NOT infer native owner authority from an npm prefix, rewrite configuration, bypass a managed mirror, or select a different mirror-specific version.

#### Scenario: Approved mirror exposes canonical target
- **WHEN** the effective managed registry exposes the exact selected historical npm target
- **THEN** a supported historical global npm installation can use its historical upgrade behavior through that mirror

#### Scenario: Approved mirror is stale
- **WHEN** the managed registry lacks the selected historical npm target
- **THEN** historical self-upgrade remains blocked until approved delivery reaches parity
- **AND** canonical availability alone does not authorize bypassing it

#### Scenario: Scoped registry and prefix policy disagree
- **WHEN** the verified npm prefix selects a different scoped/default registry policy from the observed approved machine-level context
- **THEN** historical recovery or migration planning reports the mismatch before mutation
- **AND** it neither exposes private URLs or credentials nor guesses a different prefix

### Requirement: Release verification covers the self-upgrade surface safely
Historical self-upgrade verification SHALL retain help, stable metadata parsing, installation-origin detection, and replacement checks through registered fixtures and isolated temporary global prefixes. It SHALL never apply an upgrade to the runner's actual global installation. Native release qualification SHALL independently cover the new owner-aware command and handover without publishing npm.

#### Scenario: Smoke-test the published command
- **WHEN** a supported historical package is installed under an isolated prefix
- **THEN** its upgrade help and injected check behavior execute with platform-correct Windows, macOS, and Linux paths
- **AND** the host installation remains unchanged

#### Scenario: Missing self-upgrade runtime asset
- **WHEN** a selected historical self-upgrade-capable artifact omits a required runtime module
- **THEN** historical smoke verification fails
- **AND** native qualification or a fabricated npm rebuild does not replace the missing historical evidence

### Requirement: Release identity is canonical before publication
Historical npm identity verification SHALL require the canonical name `@msn-control/liftoff` and valid npm semantic version as well as agreement among the selected historical package, lockfile, installed metadata, and tag. A consistently renamed package SHALL fail verification. Native release identity SHALL be verified separately against the native release manifest and coordinated publication contract.

#### Scenario: All metadata uses the wrong package name
- **WHEN** the selected historical package and lock metadata agree on a noncanonical name
- **THEN** verification fails rather than accepting internal consistency

#### Scenario: Version is not valid SemVer
- **WHEN** selected historical metadata contains an invalid or noncanonical semantic version
- **THEN** historical verification fails
- **AND** no npm publication is attempted

### Requirement: Historical version-command compatibility cannot exempt modern releases
The published-package verifier SHALL allow its legacy version-command exception only for the historical immutable `0.3.3` release. Other release targets SHALL not bypass installed `--version` verification through that option, and the `0.3.3` verifier SHALL expect only the commands that release actually supported.

#### Scenario: Modern target requests a legacy exception
- **WHEN** a release other than `0.3.3` requests legacy version-command compatibility
- **THEN** verification rejects the request before installing the target

#### Scenario: Historical target needs compatibility
- **WHEN** explicit verification targets the supported historical `0.3.3` release
- **THEN** only the documented version-command exception is permitted
- **AND** package identity and the other verification requirements remain enforced

#### Scenario: Historical verifier does not expect newer commands
- **WHEN** release verification targets `0.3.3`
- **THEN** it does not require `liftoff upgrade`, `liftoff init`, or `liftoff --version` behavior that release did not support
- **AND** it verifies only the historically supported command surface declared by the compatibility exception

### Requirement: npm is a retained historical distribution rather than a current channel
The system SHALL retain public explicit-version availability of historical `@msn-control/liftoff` packages, their `liftoff` binary entrypoint, immutable tarballs, licensing, source provenance, and applicable historical verification exceptions. The coordinated release and later native-only release process SHALL NOT publish another npm package or final bridge, advance npm tags to claim native availability, or unpublish historical releases. A frozen npm tag SHALL identify only a historical npm package.

#### Scenario: Public historical installation
- **WHEN** a developer explicitly installs an available historical `@msn-control/liftoff` version from public npm under its supported external runtime
- **THEN** public installation requires no private-registry credentials and links the historical `liftoff` entrypoint
- **AND** that path is labeled historical rather than the current setup recommendation

#### Scenario: Native release is prepared
- **WHEN** the coordinated native version passes its release gates
- **THEN** only the approved native artifacts and channel metadata are published
- **AND** there is no npm publish step, compatibility edition, or bridge release

#### Scenario: Historical recovery would collide with a native launcher
- **WHEN** exact-version npm recovery is considered after a native owner has acquired the launcher
- **THEN** recovery requires a new owner-aware conflict plan and approval
- **AND** the historical npm recipe is not executed blindly over native-owned files
