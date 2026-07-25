## ADDED Requirements

### Requirement: Published releases are verified from canonical npm
The system SHALL verify an authenticated npm publication against `https://registry.npmjs.org` after publishing by comparing the selected dist-tag with the version declared in root `package.json` and by installing that dist-tag into an isolated global prefix. The verification SHALL use an isolated npm cache and home directory, SHALL resolve installed paths portably on Windows, macOS, and Linux, and SHALL fail the release workflow when the observed dist-tag or installed version differs from the expected version.

#### Scenario: Stable publication satisfies the canonical registry postcondition
- **WHEN** release automation publishes a stable Liftoff version using the `latest` dist-tag
- **THEN** canonical npm reports that version for `@msn-control/liftoff@latest`
- **AND** a clean isolated canonical-registry installation of `@latest` contains that version

#### Scenario: Published package executes from the canonical installation
- **WHEN** post-publish verification installs the selected dist-tag from canonical npm
- **THEN** the installed CLI successfully reports its version and runs representative help and standard-project plan commands outside the repository

#### Scenario: Canonical registry publication mismatch fails release verification
- **WHEN** canonical npm reports or installs a version different from the version declared by the release commit after the bounded propagation window
- **THEN** the release workflow fails with the expected and observed versions
- **AND** it does not report the release as successfully verified

### Requirement: Unsupported releases are deprecated non-destructively
The system SHALL mark unsupported npm release lines as deprecated with an upgrade message while retaining their published tarballs, provenance, and explicit-version availability.

#### Scenario: Developer requests an unsupported pre-0.3 release
- **WHEN** a synchronized npm registry installs an explicitly requested pre-0.3 Liftoff version
- **THEN** npm displays a deprecation warning directing the developer to the current stable release

#### Scenario: Historical package remains reproducible
- **WHEN** a lockfile or diagnostic workflow explicitly resolves a deprecated historical Liftoff version
- **THEN** the package remains available
- **AND** the release process does not unpublish it

## MODIFIED Requirements

### Requirement: Stable releases use the latest npm dist-tag
The system SHALL make stable Liftoff releases installable through the `latest` dist-tag on the canonical public npm registry and SHALL verify that the tag resolves to the version being released.

#### Scenario: Stable release published
- **WHEN** a stable Liftoff version is published successfully
- **THEN** `npm install -g @msn-control/liftoff@latest --registry=https://registry.npmjs.org` installs that stable version

#### Scenario: Prerelease release published
- **WHEN** a prerelease Liftoff version is published
- **THEN** the release process does not move the canonical npm `latest` dist-tag to that prerelease version
- **AND** post-publish verification checks the prerelease dist-tag selected by the workflow

### Requirement: Documentation presents the global install path
The system SHALL document global npm installation as the primary user setup path for Liftoff, SHALL identify `https://registry.npmjs.org` as the authoritative release registry, and SHALL distinguish canonical installation from installation through a managed registry whose synchronization is externally controlled.

#### Scenario: Developer reads install instructions
- **WHEN** a developer opens the Mission Control or Liftoff README
- **THEN** the documentation shows `npm install -g @msn-control/liftoff@latest` as the user installation command
- **AND** it shows how to target canonical npm explicitly where policy permits
- **AND** it distinguishes global user installation from repository-local contributor commands

#### Scenario: Developer uses a managed registry
- **WHEN** a developer's npm configuration routes packages through a managed registry
- **THEN** the documentation requires confirming that the managed registry exposes the current stable Liftoff version before installation
- **AND** it directs stale-registry remediation to the mirror operator rather than changing npm configuration automatically

#### Scenario: Contributor reads source instructions
- **WHEN** a contributor follows source or development guidance
- **THEN** the documentation directs them to `voyager163/liftoff`
- **AND** contributor commands run from that repository root without npm workspace selectors

#### Scenario: Developer verifies the installed version
- **WHEN** a developer completes a global Liftoff installation
- **THEN** the documentation directs them to run `liftoff --version`
- **AND** the reported version can be compared with the current stable version exposed by the selected registry
