## ADDED Requirements

### Requirement: CLI reports the running Liftoff version
The system SHALL expose the running package version through `liftoff --version` and general help without requiring a project, Python, registry access, or any other network operation.

#### Scenario: Developer requests the installed version
- **WHEN** a developer runs `liftoff --version`
- **THEN** the CLI exits successfully after printing the Liftoff version read from its installed package metadata

#### Scenario: General help identifies the running version
- **WHEN** a developer runs `liftoff help` or invokes the CLI without a command
- **THEN** the general help output identifies the running Liftoff version

#### Scenario: Version output works from the packed installation
- **WHEN** package smoke verification invokes `--version` through an isolated globally installed CLI entrypoint
- **THEN** the reported version exactly matches the packed package version
