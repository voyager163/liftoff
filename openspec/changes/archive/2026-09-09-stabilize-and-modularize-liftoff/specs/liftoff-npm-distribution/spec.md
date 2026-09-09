## MODIFIED Requirements

### Requirement: Published package contains runtime assets
The system SHALL publish compiled runtime assets, packaged governance data, and licensing required to execute and redistribute Liftoff without repository source files or TypeScript compilation on the user's machine. The packed package SHALL exclude retired Power Apps assets, retired refresh or CI helper jobs, and contributor-only tools not required at runtime. Installed runtime asset lookup SHALL resolve from the installed package root rather than the caller's current working directory.

#### Scenario: Package contents are inspected before publish
- **WHEN** release automation prepares the Liftoff package for publishing
- **THEN** the packed package contains `package.json`, `README.md`, `LICENSE`, and compiled `dist` files including the CLI entrypoint
- **AND** the packed package excludes contributor-only source, tests, local caches, generated tarballs, retired Power Apps assets, and retired release helpers not required at runtime

#### Scenario: Installed CLI runs outside the repository
- **WHEN** the packed or published package is installed into an isolated environment outside the public Liftoff repository
- **THEN** running `liftoff help` exits successfully
- **AND** the command does not require access to the repository's `src`, `tests`, or development configuration files

#### Scenario: Installed asset lookup is cwd-independent
- **WHEN** the installed CLI resolves packaged governance or template assets from a working directory that is not the package directory, including paths with spaces on Windows, macOS, or Linux
- **THEN** asset resolution uses the installed package root
- **AND** it does not depend on the process current working directory or a repository-relative path

### Requirement: Release automation verifies package integrity before publishing
The system SHALL verify the standalone Liftoff package before publishing it to npm.

#### Scenario: Release checks pass before publish
- **WHEN** the release workflow is triggered for a stable Liftoff release
- **THEN** it installs the standalone lockfile, builds the Liftoff package, runs the package test suite, inspects the packed package contents, and smoke-tests the installed CLI before publishing

#### Scenario: Release verification is cross-platform safe
- **WHEN** package smoke tests resolve the installed `liftoff` executable on macOS, Linux, or Windows
- **THEN** they use Node.js or npm path handling for the isolated global executable path
- **AND** they do not rely on hardcoded POSIX path separators

#### Scenario: Packaged assets resolve after installation
- **WHEN** release automation smoke-tests an installed package from an arbitrary working directory
- **THEN** representative commands that need packaged assets resolve them from the installed package root
- **AND** the smoke test fails before publish if relocated assets are missing or resolved through repository-relative paths

#### Scenario: Failed verification blocks publish
- **WHEN** build, tests, package inspection, license verification, or install smoke testing fails during release
- **THEN** the system does not publish a new npm version

### Requirement: Package smoke testing verifies the init command surface
The system SHALL smoke-test the installed package's renamed initialization surface without changing the test workstation. The smoke test SHALL verify `init` help and planning behavior, SHALL verify that `create` is rejected with migration guidance, and SHALL preserve the supported public `liftoff` entrypoint after internal module relocation.

#### Scenario: Installed init command is available
- **WHEN** release automation installs the packed package in an isolated location
- **THEN** `liftoff init --help` exits 0 and documents the init-specific arguments and consent flags

#### Scenario: Installed create command is absent
- **WHEN** release automation runs `liftoff create` from the isolated installation
- **THEN** the command exits 1, recommends `liftoff init`, and creates no project files

#### Scenario: Installed plan remains side-effect free
- **WHEN** release automation runs a fully specified `liftoff plan`
- **THEN** it exits successfully without installing tools or creating a project directory

#### Scenario: Public entrypoint remains stable after refactoring
- **WHEN** release automation invokes the packed CLI through the published `liftoff` binary outside the repository
- **THEN** help, plan, and upgrade-help commands succeed through that entrypoint
- **AND** no source-import-only entrypoint is required

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
