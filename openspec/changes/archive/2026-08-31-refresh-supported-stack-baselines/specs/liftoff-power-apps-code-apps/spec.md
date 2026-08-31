## MODIFIED Requirements

### Requirement: Power Apps projects use a pinned official starter
The system SHALL generate Power Apps application files from the newest reviewed and compatible snapshot of Microsoft's `PowerAppsCodeApps/templates/starter` at a tested immutable commit packaged with the Liftoff release. The package SHALL record the upstream repository, template path, commit, archive hash, explicit file list, content hashes, license attribution, baseline package-manager version, and tested deterministic lockfile. Runtime generation SHALL NOT fetch mutable upstream content, and Liftoff SHALL NOT independently rewrite Microsoft-owned starter source to force a dependency upgrade.

#### Scenario: Generate from the packaged snapshot
- **WHEN** a developer initializes a Power Apps code app without network access after Liftoff and its selected framework are installed
- **THEN** Liftoff renders the packaged official starter snapshot with its recorded provenance
- **AND** it does not clone, download, or resolve the upstream default branch

#### Scenario: Track every copied starter file
- **WHEN** the Power Apps starter is rendered
- **THEN** every copied or transformed file has an explicit stable logical name, portable path parts, and manifest content hash

#### Scenario: Preserve Microsoft attribution
- **WHEN** a generated Power Apps project contains a substantial copy of the official starter
- **THEN** the project includes the recorded Microsoft copyright and MIT license attribution

#### Scenario: Generate on every supported operating system
- **WHEN** the same Power Apps plan is rendered on Windows, macOS, and Linux
- **THEN** it produces the same logical file set and bytes using platform-correct filesystem operations

#### Scenario: Refresh the upstream snapshot
- **WHEN** a maintainer selects a newer upstream commit
- **THEN** the controlled refresh verifies its archive, license, explicit source diff, package graph, generated lockfile, lint, build, and cross-platform behavior
- **AND** no exception or dependency override from the previous commit is carried forward implicitly

## ADDED Requirements

### Requirement: Power Apps baseline upgrades preserve upstream ownership
The Power Apps dependency baseline SHALL be upgraded by selecting and packaging a verified immutable upstream snapshot and regenerating only Liftoff-owned metadata. Any direct dependency change not present in that upstream snapshot SHALL require a separate explicit design and SHALL NOT be hidden inside the baseline refresh.

#### Scenario: Upstream package major changes
- **WHEN** the selected upstream snapshot changes a React, Vite, TypeScript, Power Apps, Tailwind, or component dependency major
- **THEN** Liftoff validates the snapshot's own source and package graph as one provenance boundary
- **AND** the generated project retains the official starter architecture

#### Scenario: Latest upstream commit fails verification
- **WHEN** the newest upstream starter commit does not pass Liftoff's supported install, lint, build, provenance, or platform checks
- **THEN** the baseline retains the newest verified compatible snapshot
- **AND** records why the newer commit was not selected
