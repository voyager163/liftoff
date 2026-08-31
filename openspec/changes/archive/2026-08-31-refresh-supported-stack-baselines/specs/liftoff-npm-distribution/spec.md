## MODIFIED Requirements

### Requirement: Documentation presents the global install path
The system SHALL document global npm installation as the primary user setup path for Liftoff, SHALL identify `https://registry.npmjs.org` as the authoritative release registry, SHALL identify the supported Node.js 24 LTS baseline required by the current release, and SHALL distinguish canonical installation from installation through a managed registry whose synchronization is externally controlled.

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

#### Scenario: Developer reads first-use instructions
- **WHEN** a developer reviews the Liftoff installation documentation
- **THEN** the documentation shows `liftoff help`, `liftoff plan`, and `liftoff init`
- **AND** it does not present `liftoff create` as a supported command

#### Scenario: Developer reads runtime requirements
- **WHEN** a developer reviews the Liftoff installation documentation
- **THEN** it states the exact Node.js 24 LTS minimum recorded by the current Liftoff baseline before global installation

## REMOVED Requirements

### Requirement: Published Liftoff requires Node.js 20.19 or newer
**Reason**: The published CLI is moving to the tested Node.js 24 LTS baseline and no longer supports the Node.js 20 runtime line.

**Migration**: Install a supported Node.js 24 LTS release before installing or running the new Liftoff major release.

## ADDED Requirements

### Requirement: Published Liftoff requires the supported Node.js LTS baseline
The system SHALL declare the Node.js 24 LTS floor recorded by the supported-stack baseline in published package engine metadata and SHALL fail startup with concise upgrade guidance when the running Node.js version is unsupported.

#### Scenario: Install with a supported Node.js runtime
- **WHEN** a developer installs and runs the published package with a Node.js version satisfying the recorded Node.js 24 LTS floor
- **THEN** the Liftoff command can start and render help

#### Scenario: Run with an unsupported Node.js runtime
- **WHEN** a developer starts Liftoff with a Node.js version below the recorded Node.js 24 LTS floor
- **THEN** Liftoff exits 1 before parsing project commands or performing side effects
- **AND** it reports the observed and minimum supported versions

#### Scenario: Release package and runtime catalog disagree
- **WHEN** package engine metadata, startup validation, workflow setup, or documentation does not match the named Node.js baseline entry
- **THEN** release verification fails before publication
