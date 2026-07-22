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