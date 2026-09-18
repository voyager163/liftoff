## MODIFIED Requirements

### Requirement: Liftoff has a canonical public source repository
The system SHALL make `https://github.com/voyager163/liftoff` the publicly readable canonical source for current native Liftoff releases and retained historical `@msn-control/liftoff` npm releases. Release manifests, package-manager metadata, homepage links, and issue-reporting links SHALL identify that public authority and the applicable immutable source version.

#### Scenario: Developer follows package source metadata
- **WHEN** a developer follows repository, homepage, or issue links published with a native release or historical `@msn-control/liftoff` package
- **THEN** the links resolve to public resources under `voyager163/liftoff`
- **AND** reading the source does not require access to the private Mission Control repository

#### Scenario: Developer inspects the canonical implementation
- **WHEN** a developer opens the public Liftoff repository
- **THEN** it contains the source corresponding to the supported native release and preserves the history for historical npm releases
- **AND** Mission Control references identify that repository as Liftoff's source authority

### Requirement: Public repository contains a standalone contributor project
The Liftoff repository SHALL contain the source, tests, scripts, root package metadata and lockfile, TypeScript and test configuration, README and linked documentation, GPL license, OpenSpec governance, release-resource inventories, and CI needed to validate the CLI independently of Mission Control. Contributor Node/npm requirements SHALL remain separate from native end-user runtime requirements. Contributor qualification SHALL cover the installed native bundle rather than rely only on executing source or packing npm.

#### Scenario: Contributor validates a clean clone
- **WHEN** a contributor clones `voyager163/liftoff`, installs the root lockfile using the documented development toolchain, and runs the documented checks and native package smoke commands
- **THEN** the CLI builds, its tests run, and the self-contained CLI executes outside the checkout
- **AND** no Mission Control workspace files are required

#### Scenario: Contributor validates on supported operating systems
- **WHEN** CI validates the standalone repository on Windows, macOS, and Linux
- **THEN** filesystem-sensitive tests and native installation checks use platform-correct paths
- **AND** logical generated-project and manifest contracts remain identical across those operating systems

### Requirement: Liftoff source and release ownership is independent
The public Liftoff repository SHALL remain the only Git source and release authority for future Liftoff versions. Current release artifacts, signing/provenance, native channel definitions, and qualification SHALL bind to that authority. Mission Control SHALL reference current Liftoff through public GitHub/native installation interfaces, and npm only for explicitly historical instructions, without embedding or linking the source tree.

#### Scenario: Maintainer prepares a Liftoff change
- **WHEN** a maintainer changes CLI source, tests, package metadata, native resource inventories, or release automation
- **THEN** the change is made and validated in `voyager163/liftoff`
- **AND** no synchronized source edit is required in `voyager163/mission-control`

#### Scenario: Developer inspects Mission Control
- **WHEN** a developer reviews Mission Control after the native cutover
- **THEN** it contains no `tools/liftoff-cli` package, Liftoff npm publishing workflow, Git submodule, subtree, or vendored Liftoff source copy
- **AND** current Liftoff references use the public source and native installation paths while npm references are labeled historical

### Requirement: Public repository declares open-source participation terms
The Liftoff repository SHALL publish GPL-3.0-only licensing and contributor-facing conduct, contribution, and private vulnerability-reporting guidance. Native bundles SHALL retain the Liftoff license and required runtime/dependency licenses and notices; native packaging SHALL NOT erase the licensing or provenance of historical npm packages.

#### Scenario: User reviews reuse terms
- **WHEN** a user opens the repository or inspects a native bundle or historical npm package
- **THEN** the applicable GPL-3.0-only Liftoff license text and metadata are available
- **AND** native bundled-runtime and dependency notices are also included as required

#### Scenario: Contributor prepares participation
- **WHEN** a contributor wants to report a bug, propose a change, or disclose a vulnerability
- **THEN** the repository provides public contribution and conduct guidance
- **AND** security guidance identifies a non-public reporting path for vulnerabilities

## ADDED Requirements

### Requirement: Only main and develop are permanent source branches
The source repository SHALL retain `main` and `develop` as its only permanent branches. Temporary feature, repair, release, automation, and Dependabot PR branches SHALL remain allowed while their work or pull requests are active. The permanent-branch policy SHALL NOT be interpreted as a requirement to maintain only two total refs, disable dependency automation, rewrite history, or remove active work.

#### Scenario: An active pull request uses a temporary branch
- **WHEN** a feature, repair, release, or Dependabot pull request remains active
- **THEN** its temporary branch can remain alongside `main` and `develop`
- **AND** the repository still satisfies the two-permanent-branch policy

#### Scenario: A long-lived extra branch is found
- **WHEN** inventory identifies another branch being used as permanent infrastructure
- **THEN** maintainers receive an explicit consolidation plan preserving its unmerged work
- **AND** policy diagnosis alone does not delete the branch or change the current checkout

### Requirement: Branch cleanup requires fresh ownership and preservation evidence
Branch cleanup SHALL use a live inventory of local/remote refs, exact commit identities, pull-request state, and all relevant checkout/worktree ownership, resolving checkout paths with native Windows, macOS, and Linux semantics. Destructive actions SHALL require an explicit reviewed branch list and approval, fresh pre-action checks, and release by the owning user or session. Checked-out branches, dirty worktrees, uncommitted edits, unmerged commits, and active PR work SHALL be preserved. Verified stale tracking refs SHALL be distinguished from branch deletion; broad name-pattern deletion SHALL NOT establish eligibility.

#### Scenario: An apparently stale branch is checked out
- **WHEN** a branch in a cleanup proposal is checked out by a user or another session
- **THEN** cleanup skips that branch and reports its active ownership
- **AND** it does not remove the worktree, change HEAD, or force its deletion

#### Scenario: A closed pull request still has unmerged work
- **WHEN** a closed-PR branch contains commits not preserved by the intended permanent history
- **THEN** cleanup remains blocked for that branch until preservation and ownership release are explicitly resolved
- **AND** closed PR status alone is not deletion authority

#### Scenario: Dirty work or refs change after review
- **WHEN** a target worktree becomes dirty or a reviewed ref changes before cleanup
- **THEN** that action stops with the changed observation
- **AND** it does not stash, reset, rebase, overwrite, or discard the new work

#### Scenario: Prune a verified stale tracking ref
- **WHEN** a tracking ref is confirmed stale by the reviewed live inventory and its removal cannot discard active local work
- **THEN** cleanup can act only on that explicitly approved ref
- **AND** it does not infer deletion of similarly named local or remote branches

#### Scenario: A worktree path needs native interpretation
- **WHEN** a checkout path contains spaces or has platform-specific case or separator behavior on Windows, macOS, or Linux
- **THEN** the inventory binds the actual checkout and its owner through native path resolution
- **AND** ambiguous or unreadable paths block deletion instead of being treated as an inactive worktree

### Requirement: Native release ownership preserves one public source identity
Native channel metadata and release provenance SHALL name the exact reviewed public source commit and qualified final artifacts. Homebrew cask definitions in the upstream-maintained tap and WinGet submissions SHALL be traceable to that release authority without implying official catalog acceptance. The macOS metadata SHALL identify a cask and its exact tap/token rather than leave cask/formula selection ambiguous. Native publication SHALL satisfy the coordinated platform and capability gate and SHALL NOT be substituted with an npm release or another repository's independently built artifact.

#### Scenario: Inspect a native channel definition
- **WHEN** a maintainer reviews the Homebrew, WinGet, or direct-install release metadata
- **THEN** it identifies the exact canonical release, package identity, architecture, and immutable final artifact
- **AND** manager availability is independently verified rather than inferred from a GitHub tag

#### Scenario: A channel points to an unqualified build
- **WHEN** channel metadata names bytes or a source revision different from its qualification evidence
- **THEN** publication fails for the coordinated release
- **AND** an otherwise valid npm package or passing Linux build cannot satisfy that native channel
