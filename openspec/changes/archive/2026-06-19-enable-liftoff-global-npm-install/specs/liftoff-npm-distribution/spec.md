## ADDED Requirements

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
The system SHALL publish compiled runtime assets required to execute Liftoff without repository source files or TypeScript compilation on the user's machine.

#### Scenario: Package contents are inspected before publish
- **WHEN** release automation prepares the Liftoff package for publishing
- **THEN** the packed package contains `package.json`, `README.md`, and compiled `dist` files including the CLI entrypoint
- **AND** the packed package excludes workspace-only source, tests, local caches, and generated tarballs not required at runtime

#### Scenario: Installed CLI runs outside the repository
- **WHEN** the packed or published package is installed into an isolated environment outside the Liftoff repository
- **THEN** running `liftoff help` exits successfully
- **AND** the command does not require access to the repository's `src`, `tests`, or workspace configuration files

### Requirement: Release automation verifies package integrity before publishing
The system SHALL verify the Liftoff package before publishing it to npm.

#### Scenario: Release checks pass before publish
- **WHEN** the release workflow is triggered for a stable Liftoff release
- **THEN** it installs workspace dependencies, builds the Liftoff package, runs the package test suite, inspects the packed package contents, and smoke-tests the installed CLI before publishing

#### Scenario: Release verification is cross-platform safe
- **WHEN** package smoke tests resolve the installed `liftoff` executable on macOS, Linux, or Windows
- **THEN** they use Node.js or npm path handling for the isolated global executable path
- **AND** they do not rely on hardcoded POSIX path separators

#### Scenario: Failed verification blocks publish
- **WHEN** build, tests, package inspection, or install smoke testing fails during release
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
The system SHALL publish the scoped Liftoff package through an authenticated release path that targets the standalone Liftoff package and makes public package access explicit.

#### Scenario: Publish public scoped package
- **WHEN** release automation publishes `@msn-control/liftoff`
- **THEN** it publishes from the standalone Liftoff package at the repository root
- **AND** it uses public access configuration appropriate for a scoped npm package

#### Scenario: Publish with trusted credentials
- **WHEN** release automation authenticates to npm
- **THEN** it uses npm trusted publishing with provenance when available, or a repository secret scoped for npm publishing when trusted publishing is not available

### Requirement: Documentation presents the global install path
The system SHALL document global npm installation as the primary user setup path for Liftoff.

#### Scenario: Developer reads install instructions
- **WHEN** a developer opens the Mission Control or Liftoff README
- **THEN** the documentation shows `npm install -g @msn-control/liftoff@latest` as the user installation command
- **AND** the documentation distinguishes global user installation from repository-local contributor commands

#### Scenario: Developer reads first-use instructions
- **WHEN** a developer reviews the Liftoff installation documentation
- **THEN** the documentation shows a first-use command such as `liftoff help` or `liftoff create`