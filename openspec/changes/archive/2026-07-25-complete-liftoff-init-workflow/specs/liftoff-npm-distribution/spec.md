## ADDED Requirements

### Requirement: Published Liftoff requires Node.js 20.19 or newer
The system SHALL declare Node.js `>=20.19` in published package engine metadata and SHALL fail startup with concise upgrade guidance when the running Node.js version is unsupported.

#### Scenario: Install with a supported Node.js runtime
- **WHEN** a developer installs and runs the published package with Node.js 20.19 or newer
- **THEN** the Liftoff command can start and render help

#### Scenario: Run with an unsupported Node.js runtime
- **WHEN** a developer starts Liftoff with a Node.js version below 20.19
- **THEN** Liftoff exits 1 before parsing project commands or performing side effects
- **AND** it reports the observed and minimum supported versions

### Requirement: Package smoke testing verifies the init command surface
The system SHALL smoke-test the installed package's renamed initialization surface without changing the test workstation. The smoke test SHALL verify `init` help and planning behavior and SHALL verify that `create` is rejected with migration guidance.

#### Scenario: Installed init command is available
- **WHEN** release automation installs the packed package in an isolated location
- **THEN** `liftoff init --help` exits 0 and documents the init-specific arguments and consent flags

#### Scenario: Installed create command is absent
- **WHEN** release automation runs `liftoff create` from the isolated installation
- **THEN** the command exits 1, recommends `liftoff init`, and creates no project files

#### Scenario: Installed plan remains side-effect free
- **WHEN** release automation runs a fully specified `liftoff plan`
- **THEN** it exits successfully without installing tools or creating a project directory

## MODIFIED Requirements

### Requirement: Documentation presents the global install path
The system SHALL document global npm installation as the primary user setup path for Liftoff and SHALL present `liftoff init` as the project initialization command.

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
- **THEN** the documentation shows `liftoff help`, `liftoff plan`, and `liftoff init`
- **AND** it does not present `liftoff create` as a supported command

#### Scenario: Developer reads runtime requirements
- **WHEN** a developer reviews the Liftoff installation documentation
- **THEN** it states that Liftoff requires Node.js 20.19 or newer before global installation

