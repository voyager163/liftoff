## Purpose

Define the canonical public source, contribution, governance, and release ownership boundary for Liftoff.

## Requirements

### Requirement: Liftoff has a canonical public source repository
The system SHALL make `https://github.com/voyager163/liftoff` the publicly readable canonical source repository for the `@msn-control/liftoff` package.

#### Scenario: Developer follows package source metadata
- **WHEN** a developer follows the repository, homepage, or issue links published with `@msn-control/liftoff`
- **THEN** the links resolve to public resources under `voyager163/liftoff`
- **AND** reading the source does not require access to the private Mission Control repository

#### Scenario: Developer inspects the canonical implementation
- **WHEN** a developer opens the public Liftoff repository
- **THEN** the repository contains the source corresponding to the current supported npm release line
- **AND** Mission Control documentation identifies that repository as the Liftoff source authority

### Requirement: Public repository contains a standalone contributor project
The Liftoff repository SHALL contain the package source, tests, scripts, root package metadata, lockfile, TypeScript and test configuration, README, GPL license, OpenSpec governance, and CI needed to validate the CLI independently of Mission Control.

#### Scenario: Contributor validates a clean clone
- **WHEN** a contributor clones `voyager163/liftoff`, installs the root lockfile, and runs the documented check and package smoke commands
- **THEN** the CLI builds, its tests run, and the packed CLI installs outside the checkout without any Mission Control workspace files

#### Scenario: Contributor validates on supported operating systems
- **WHEN** CI validates the standalone repository on Windows, macOS, and Linux
- **THEN** filesystem-sensitive tests use platform-correct path handling
- **AND** the logical generated project and manifest contracts remain identical across those operating systems

### Requirement: Public repository begins from a reviewed clean snapshot
The initial public Liftoff repository SHALL contain a reviewed current-source snapshot without imported Mission Control Git history or unrelated private repository files.

#### Scenario: User inspects public Git history
- **WHEN** a user clones the public repository and inspects all reachable commits and Git objects
- **THEN** the history begins with the reviewed Liftoff extraction
- **AND** it contains no historical Mission Control applications, services, infrastructure, or mixed platform changes

#### Scenario: Maintainer reviews initial tracked files
- **WHEN** a maintainer compares the initial public tree with the extraction allowlist
- **THEN** every tracked file is a Liftoff source, test, build, documentation, governance, community, license, or automation artifact
- **AND** ignored build output, dependencies, local settings, environment files, and temporary archives are absent

### Requirement: Liftoff source and release ownership is independent
The public Liftoff repository SHALL be the only Git source and release authority for future Liftoff versions, and the Mission Control repository SHALL reference Liftoff through its public GitHub and npm interfaces without embedding or linking its source tree.

#### Scenario: Maintainer prepares a Liftoff change
- **WHEN** a maintainer changes CLI source, tests, package metadata, or release automation
- **THEN** the change is made and validated in `voyager163/liftoff`
- **AND** no synchronized source edit is required in `voyager163/mission-control`

#### Scenario: Developer inspects Mission Control
- **WHEN** a developer reviews the Mission Control workspace after the cutover
- **THEN** it contains no `tools/liftoff-cli` package, Liftoff npm publishing workflow, Git submodule, subtree, or vendored Liftoff source copy
- **AND** its Liftoff references use the public source URL or `@msn-control/liftoff` installation path

### Requirement: Public repository declares open-source participation terms
The Liftoff repository SHALL publish GPL-3.0-only licensing and contributor-facing conduct, contribution, and vulnerability-reporting guidance.

#### Scenario: User reviews reuse terms
- **WHEN** a user opens the repository or inspects the packed npm package
- **THEN** the GPL-3.0-only license text is available
- **AND** package metadata declares `GPL-3.0-only`

#### Scenario: Contributor prepares participation
- **WHEN** a contributor wants to report a bug, propose a change, or disclose a vulnerability
- **THEN** the repository provides public contribution and conduct guidance
- **AND** security guidance identifies a non-public reporting path for vulnerabilities

### Requirement: Liftoff OpenSpec governance follows the public source
The public repository SHALL own current Liftoff capability specs and reviewed Liftoff-only archived changes, while mixed Mission Control platform governance SHALL remain private.

#### Scenario: Contributor proposes a Liftoff behavior change
- **WHEN** a contributor inspects or creates an OpenSpec change for Liftoff
- **THEN** the public repository contains the applicable Liftoff capability specs and cross-platform CLI rules
- **AND** the change does not depend on Mission Control platform specs

#### Scenario: Maintainer migrates archived changes
- **WHEN** archived OpenSpec changes are included in the public repository
- **THEN** each included archive is selected from the reviewed Liftoff-only allowlist
- **AND** mixed monorepo, application, deployment, or platform history is not copied
