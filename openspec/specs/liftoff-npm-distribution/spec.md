## Purpose

Define Liftoff npm package distribution behavior, including public package publication, global installation, release verification, and documentation expectations.

## Requirements

### Requirement: Liftoff is published as an npm CLI package
The system SHALL publish the Liftoff CLI as the public npm package `@msn-control/liftoff` with a `liftoff` binary entrypoint.

#### Scenario: Latest package is available
- **WHEN** a developer queries npm for `@msn-control/liftoff@latest`
- **THEN** npm resolves a published stable version of the Liftoff CLI package

#### Scenario: Public scoped package installation
- **WHEN** a developer runs `npm install -g @msn-control/liftoff@latest`
- **THEN** npm installs the package without requiring private registry credentials
- **AND** npm links a `liftoff` command into the developer's global npm binary location

### Requirement: Published package contains runtime assets
The system SHALL publish compiled runtime assets and licensing required to execute and redistribute Liftoff without repository source files or TypeScript compilation on the user's machine.

#### Scenario: Package contents are inspected before publish
- **WHEN** release automation prepares the Liftoff package for publishing
- **THEN** the packed package contains `package.json`, `README.md`, `LICENSE`, and compiled `dist` files including the CLI entrypoint
- **AND** the packed package excludes contributor-only source, tests, local caches, and generated tarballs not required at runtime

#### Scenario: Installed CLI runs outside the repository
- **WHEN** the packed or published package is installed into an isolated environment outside the public Liftoff repository
- **THEN** running `liftoff help` exits successfully
- **AND** the command does not require access to the repository's `src`, `tests`, or development configuration files

### Requirement: Release automation verifies package integrity before publishing
The system SHALL verify the standalone Liftoff package before publishing it to npm.

#### Scenario: Release checks pass before publish
- **WHEN** the release workflow is triggered for a stable Liftoff release
- **THEN** it installs the standalone lockfile, builds the Liftoff package, runs the package test suite, inspects the packed package contents, and smoke-tests the installed CLI before publishing

#### Scenario: Release verification is cross-platform safe
- **WHEN** package smoke tests resolve the installed `liftoff` executable on macOS, Linux, or Windows
- **THEN** they use Node.js or npm path handling for the isolated global executable path
- **AND** they do not rely on hardcoded POSIX path separators

#### Scenario: Failed verification blocks publish
- **WHEN** build, tests, package inspection, license verification, or install smoke testing fails during release
- **THEN** the system does not publish a new npm version

### Requirement: Stable releases use the latest npm dist-tag
The system SHALL make stable Liftoff releases installable through the npm `latest` dist-tag.

#### Scenario: Stable release published
- **WHEN** a stable Liftoff version is published successfully
- **THEN** `npm install -g @msn-control/liftoff@latest` installs that stable version

#### Scenario: Prerelease release published
- **WHEN** a prerelease Liftoff version is published
- **THEN** the release process does not move the npm `latest` dist-tag to that prerelease version

### Requirement: npm publishing is explicit and authenticated
The system SHALL publish the scoped Liftoff package from the public Liftoff repository root through npm trusted publishing with public package access and provenance.

#### Scenario: Publish public scoped package
- **WHEN** release automation publishes `@msn-control/liftoff`
- **THEN** it publishes the standalone package at the public repository root
- **AND** it uses public access configuration appropriate for a scoped npm package

#### Scenario: Publish with trusted credentials
- **WHEN** release automation authenticates to npm
- **THEN** npm trusted publishing authorizes the identified public repository workflow through short-lived identity credentials
- **AND** the publish emits provenance for the public source commit

#### Scenario: Release metadata reads from repository root
- **WHEN** release automation reads the Liftoff package version or package metadata
- **THEN** it reads `package.json` from the public repository root

### Requirement: Liftoff distribution metadata identifies the public source repository
The system SHALL publish npm metadata that identifies `voyager163/liftoff` as the package source, homepage, and issue-reporting location without a nested repository directory.

#### Scenario: Developer inspects published metadata
- **WHEN** a developer queries the metadata for the current `@msn-control/liftoff` release
- **THEN** the repository URL points to `https://github.com/voyager163/liftoff`
- **AND** the homepage and issue links resolve to public Liftoff repository resources
- **AND** no `tools/liftoff-cli` repository directory is declared

#### Scenario: Developer inspects source provenance
- **WHEN** a developer inspects provenance for a Liftoff version published after the split
- **THEN** the attestation identifies the public Liftoff repository and its release workflow

### Requirement: Documentation presents the global install path
The system SHALL document global npm installation as the primary user setup path for Liftoff.

#### Scenario: Developer reads install instructions
- **WHEN** a developer opens the Mission Control or Liftoff README
- **THEN** the documentation shows `npm install -g @msn-control/liftoff@latest` as the user installation command
- **AND** the documentation distinguishes global user installation from repository-local contributor commands

#### Scenario: Contributor reads source instructions
- **WHEN** a contributor follows source or development guidance
- **THEN** the documentation directs them to `voyager163/liftoff`
- **AND** contributor commands run from that repository root without npm workspace selectors

#### Scenario: Developer reads first-use instructions
- **WHEN** a developer reviews the Liftoff installation documentation
- **THEN** the documentation shows a first-use command such as `liftoff help` or `liftoff create`

### Requirement: Release version identity is coherent before publication
The system SHALL require root package metadata, root lockfile metadata, a tag-triggered release's Git tag, packed package metadata, and the installed CLI version output to identify the same semantic version before publishing a new Liftoff package. A mismatch in any required identity SHALL fail the release workflow before `npm publish`.

#### Scenario: Prepare the first version-reporting release
- **WHEN** release automation prepares Liftoff `0.3.4`, the first published release containing `liftoff --version`
- **THEN** root `package.json` and root `package-lock.json` metadata identify version `0.3.4`
- **AND** an isolated installation of the packed package prints `Liftoff 0.3.4` for `liftoff --version`

#### Scenario: Tag-triggered release matches package metadata
- **WHEN** the release workflow is triggered by Git tag `v0.3.4`
- **THEN** the workflow confirms that root package and lockfile metadata identify `0.3.4` before publication
- **AND** packed package metadata identifies `0.3.4`

#### Scenario: Release identity mismatch blocks publication
- **WHEN** the Git release tag, root package version, root lockfile version, packed version, or installed `liftoff --version` output does not match another required identity
- **THEN** release verification fails with the expected and observed identities
- **AND** no new npm package is published by that workflow run

### Requirement: Registry onboarding preserves release version identity
The system SHALL treat a registry path as ready for version-command-based onboarding only when its stable dist-tag and explicit package version resolve to the intended release and a clean installation through that registry reports the same version through `liftoff --version`. Canonical publication success and managed-registry readiness SHALL remain independently observable states.

#### Scenario: Canonical npm exposes Liftoff 0.3.4
- **WHEN** canonical publication and post-publish verification of Liftoff `0.3.4` succeed
- **THEN** canonical npm resolves both `@msn-control/liftoff@latest` and `@msn-control/liftoff@0.3.4` to version `0.3.4`
- **AND** a clean canonical installation prints `Liftoff 0.3.4` for `liftoff --version`

#### Scenario: Approved managed registry reaches parity
- **WHEN** an organization presents its approved managed registry as ready for Liftoff `0.3.4` onboarding
- **THEN** that registry resolves both `@latest` and explicit `@0.3.4` metadata to version `0.3.4`
- **AND** a clean installation through that registry prints `Liftoff 0.3.4` for `liftoff --version`

#### Scenario: Managed registry remains stale
- **WHEN** an approved managed registry resolves `@latest` to an older release, rejects explicit `@0.3.4`, or installs a CLI that does not report `Liftoff 0.3.4`
- **THEN** version-command-based onboarding through that registry remains blocked
- **AND** Liftoff does not modify npm configuration or silently install from another registry