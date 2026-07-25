## Purpose

Define the public Liftoff documentation experience, packaging contract, and progressive guidance for users and contributors.

## Requirements

### Requirement: The root README is a product-oriented landing page
The system SHALL provide a concise public root `README.md` that leads with Liftoff's identity, a plain-language value proposition, meaningful release and quality badges, an accessible terminal visual, and the shortest supported interactive installation path. It SHALL introduce GenAI applications, API applications, and Power Apps code apps together with OpenSpec, Spec Kit, GitHub Copilot, and Claude Code without presenting the complete operational reference inline.

#### Scenario: New developer scans the repository
- **WHEN** a developer opens the root README
- **THEN** the first screen explains what Liftoff initializes, shows the supported workloads and integrations, and provides the install command followed by `liftoff init`

#### Scenario: Terminal visual has a text alternative
- **WHEN** the README includes a terminal image
- **THEN** the image has meaningful alternative text
- **AND** the surrounding quick start communicates the same essential flow without relying on the image

#### Scenario: Badges represent observable project facts
- **WHEN** badges appear in the README
- **THEN** they link to the npm version, CI status, license, or supported runtime rather than unverified claims

### Requirement: The README demonstrates interactive onboarding
The system SHALL show the default interactive `liftoff init` experience as the primary quick start and SHALL illustrate workload selection, spec-workflow selection, multi-agent selection, readiness, and safe completion. Advanced noninteractive flags SHALL remain discoverable through linked CLI documentation instead of replacing the first-use path with one long command.

#### Scenario: Review the quick start
- **WHEN** a developer follows the README quick start
- **THEN** the documented commands install the published package and launch `liftoff init`
- **AND** the flow does not require copying a fully specified command before the developer understands its choices

#### Scenario: Discover existing-repository behavior
- **WHEN** a developer wants to initialize an existing Git repository
- **THEN** the README states that running `liftoff init` at the exact Git root initializes in place
- **AND** it links to the complete target and overwrite guide

### Requirement: Detailed user guidance uses progressive Markdown documentation
The system SHALL maintain linked Markdown documentation for getting started, supported workloads, spec workflows and agents, existing repositories, prerequisites, safety and consent, CLI reference, generated project structure, configuration and manifests, Azure deployment, and troubleshooting. Detailed lifecycle and contract material moved from the README SHALL remain discoverable in those documents.

#### Scenario: Developer needs a detailed contract
- **WHEN** a developer follows a README documentation link for safety, prerequisites, manifests, generated structure, or Azure
- **THEN** the linked document contains the corresponding detailed guidance formerly embedded in the root README

#### Scenario: Developer chooses a workload
- **WHEN** a developer opens the workload documentation
- **THEN** it distinguishes GenAI, API, and Power Apps question flows, generated output, prerequisites, and deferred external actions

#### Scenario: Contributor needs release internals
- **WHEN** a contributor needs build, test, packaging, or release procedures
- **THEN** the README links to `CONTRIBUTING.md`
- **AND** release implementation detail is not duplicated as end-user onboarding

### Requirement: Public documentation is packaged and link-safe
The npm package SHALL include the root README, linked `/docs` Markdown files, and referenced README assets. Automated tests SHALL verify required local targets and first-use commands so npm and repository readers do not receive broken relative links.

#### Scenario: Inspect the packed npm artifact
- **WHEN** package smoke verification lists the packed Liftoff files
- **THEN** the README, linked documentation, and referenced local visual assets are present

#### Scenario: Validate local documentation links
- **WHEN** documentation tests evaluate root README relative links
- **THEN** every referenced local document and asset resolves with platform-correct filesystem handling

#### Scenario: Documentation needs no build tool
- **WHEN** a contributor edits user documentation
- **THEN** the plain Markdown and static assets remain readable on GitHub and npm without a separate documentation generator
