## MODIFIED Requirements

### Requirement: The root README is a product-oriented landing page
The system SHALL provide a concise public README leading with Liftoff's identity, plain-language value, meaningful release/quality badges, original rocket-ascent artwork, an accessible terminal visual, and the shortest supported interactive install path. It SHALL introduce GenAI and API workloads with OpenSpec, Spec Kit, GitHub Copilot, Claude Code, and Codex without embedding the complete operational reference or presenting Power Apps as supported. It SHALL make contribution, support, conduct, governance, security, and GPL-3.0-only terms discoverable and distinguish released capabilities from planned rewrite work.

#### Scenario: New developer scans the repository
- **WHEN** a developer opens the root README
- **THEN** the opening explains Liftoff's supported workloads and integrations and gives installation followed by `liftoff init`
- **AND** a short navigation path leads to quick start, documentation, contribution, and security guidance
- **AND** installation is not buried beneath an operational manual or promotional badge wall

#### Scenario: Terminal visual has a text alternative
- **WHEN** the README includes a terminal image
- **THEN** meaningful alternative text and the surrounding quick start communicate the same essential flow

#### Scenario: Badges represent observable project facts
- **WHEN** badges appear
- **THEN** they link to observable npm, CI, license, or runtime facts rather than unsupported readiness claims
- **AND** the compact badge set does not fabricate popularity, rankings, benchmarks, security scores, or services

#### Scenario: Reader sees the Liftoff visual identity
- **WHEN** the README renders its hero image
- **THEN** the image shows original rocket-ascent artwork with dark space, an illuminated launch trail, and a prominent Liftoff wordmark
- **AND** the real-text tagline communicates "Launch governed GenAI applications and APIs."
- **AND** the README does not reuse Graft's artwork, branding, prose, or performance claims

#### Scenario: Reader evaluates current maturity
- **WHEN** the README describes project status
- **THEN** current released behavior and the planned rewrite remain distinguishable
- **AND** intended work is not presented as shipped or verified
- **AND** a planned rewrite alone is not represented as withdrawal of support for the currently documented stable release

#### Scenario: Reader wants to contribute or request help
- **WHEN** the reader reaches the community section
- **THEN** links identify the actual contribution, public support, governance, conduct, and private security channels
- **AND** the README preserves the existing GPL-3.0-only license identity

### Requirement: The README demonstrates interactive onboarding
The system SHALL show the default interactive `liftoff init` experience as the primary quick start and SHALL illustrate workload selection, spec-workflow selection, multi-agent selection, readiness, and safe completion. Advanced noninteractive flags SHALL remain discoverable through linked CLI documentation instead of replacing the first-use path with one long command. The quick start SHALL retain the distinction between shell commands and the selected coding agent's native post-init setup invocation.

#### Scenario: Review the quick start
- **WHEN** a developer follows the README quick start
- **THEN** the documented commands install the published package and launch `liftoff init`
- **AND** the flow does not require copying a fully specified command before the developer understands its choices
- **AND** current runtime prerequisites are accessible before installation

#### Scenario: Discover existing-repository behavior
- **WHEN** a developer wants to initialize an existing Git repository
- **THEN** the README states that running `liftoff init` at the exact Git root initializes in place
- **AND** it links to the complete target and overwrite guide

#### Scenario: Developer continues in the selected agent
- **WHEN** the quick start presents the post-initialization setup operation
- **THEN** Copilot/Claude and Codex invocation forms are identified accurately
- **AND** an agent invocation is not presented as a nonexistent `liftoff setup` shell command
- **AND** local preparation is not described as automatic cloud deployment or repository enforcement

### Requirement: Detailed user guidance uses progressive Markdown documentation
The system SHALL maintain linked Markdown guides for getting started, supported workloads, workflows/agents, existing repositories, prerequisites, safety/consent, CLI reference, generated structure, configuration/manifests, assessment, deployment, and troubleshooting. Material moved out of the README SHALL remain discoverable. Supported-workload guidance SHALL cover API/GenAI; retirement guidance SHALL explain former Power Apps inputs separately. The README SHALL remain below 135 physical lines without hiding a complete manual inside dense HTML or paragraphs.

#### Scenario: Developer needs a detailed contract
- **WHEN** a developer follows README links for safety, prerequisites, manifests, structure, or Azure
- **THEN** the linked documents contain the corresponding detailed guidance

#### Scenario: Developer chooses a workload
- **WHEN** workload documentation is opened
- **THEN** it distinguishes API/GenAI questions, output, prerequisites, and deferred actions without offering Power Apps creation or maintenance

#### Scenario: Contributor needs release internals
- **WHEN** a contributor needs build, test, packaging, or release procedures
- **THEN** the README links to CONTRIBUTING.md rather than duplicating release implementation in onboarding

#### Scenario: Operational detail moves out of the landing page
- **WHEN** the README is shortened for the open-source presentation
- **THEN** upgrade/update distinctions, reviewed repair, consent, registry restrictions, telemetry, and current supported-workload limitations remain available through the linked guide structure
- **AND** the move does not silently change the documented behavior or remove its explanation

### Requirement: Public documentation is packaged and link-safe
The npm package SHALL include the root README, linked `/docs` Markdown files, referenced README assets, and directly linked root community documents. These community documents SHALL include CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, GOVERNANCE.md, and SUPPORT.md through an explicit package inventory. Automated tests SHALL verify required local targets and first-use commands so npm and repository readers do not receive broken relative links. Filesystem checks SHALL be portable across Windows, macOS, and Linux without treating URLs as local filesystem paths.

#### Scenario: Inspect the packed npm artifact
- **WHEN** package smoke verification lists the packed Liftoff files
- **THEN** the README, linked documentation, community documents, and referenced local visual assets are present
- **AND** adding community documents does not include `.github/`, application source, tests, credentials, or local setup evidence in the package

#### Scenario: Validate local documentation links
- **WHEN** documentation tests evaluate root README relative links
- **THEN** every referenced local document and asset resolves with platform-correct filesystem handling
- **AND** references to checkout-only material use canonical repository URLs instead of relative paths into excluded package directories

#### Scenario: Documentation needs no build tool
- **WHEN** a contributor edits user documentation
- **THEN** the plain Markdown and static assets remain readable on GitHub and npm without a separate documentation generator

#### Scenario: Reader follows packaged links on Windows
- **WHEN** documentation/package checks run from a Windows path containing spaces
- **THEN** local community documents and image paths resolve without hardcoded POSIX path assumptions
- **AND** their exact filenames also resolve on case-sensitive Linux and on macOS

#### Scenario: A named visual asset is replaced
- **WHEN** the approved README asset inventory changes
- **THEN** replacement or deletion uses an explicit inventory lookup for that asset
- **AND** unrelated files in the asset directory are not modified through broad filename matching

## ADDED Requirements

### Requirement: README artwork is accessible and bounded
The README SHALL use repository-hosted original static artwork whose meaning is supported by real text. The hero asset SHALL be no larger than 300 KiB, and the combined local image assets directly rendered by the README SHALL be no larger than 500 KiB. Images SHALL not require scripts, external fonts, remote textures, or animation to understand the product. Layout SHALL remain readable in GitHub light and dark themes, narrow mobile rendering, and npm's supported README renderer.

#### Scenario: README is rendered with images unavailable
- **WHEN** a reader cannot load the banner or terminal preview
- **THEN** useful alt text, the project name, tagline, commands, and navigation still communicate the product and first-use flow

#### Scenario: README is viewed on a narrow display or different theme
- **WHEN** the README is viewed at a 375-pixel-wide mobile viewport or desktop in light and dark themes
- **THEN** artwork scales without clipping essential content, badges and navigation can wrap, and text remains readable
- **AND** fixed-width decorative layout does not force horizontal page scrolling

#### Scenario: Contributor checks image size and dependencies
- **WHEN** the README asset checks run
- **THEN** the hero and combined local image byte budgets are enforced
- **AND** the artwork does not fetch third-party visual resources or execute code

#### Scenario: npm does not preserve decorative alignment
- **WHEN** npm renders the README with only its supported Markdown and HTML features
- **THEN** the reading order, meaningful text, links, and quick start remain usable without custom CSS
