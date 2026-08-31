## Purpose

Define Liftoff's first-class Power Apps code app workload, including its pinned starter, project-local tooling, environment binding, governance, and optional Code Apps plugin integration.

## Requirements

### Requirement: Power Apps code apps are a first-class Liftoff workload
The system SHALL allow a developer to select `power-apps-code-app` as a project type through interactive initialization, configuration, and noninteractive `plan` or `init`. The workload SHALL use the common project name, spec workflow, coding-agent, target-resolution, plan-confirmation, and consent contracts without requiring an API stack, GenAI pattern, cloud provider, deployment region, optional frontend, API environments, Docker Compose, or OpenTofu selection.

#### Scenario: Select Power Apps interactively
- **WHEN** a developer selects Power Apps code app during interactive `liftoff init`
- **THEN** Liftoff asks the common spec-workflow and coding-agent questions
- **AND** it does not ask for an API stack, GenAI pattern, cloud, region, frontend, or API environment

#### Scenario: Plan Power Apps noninteractively
- **WHEN** a developer runs `liftoff plan --type power-apps-code-app --spec openspec --agents copilot`
- **THEN** Liftoff resolves a Power Apps plan without writing files, installing tools, or requiring API-oriented flags

#### Scenario: Reject API options for Power Apps
- **WHEN** a Power Apps command also supplies a GenAI pattern, API stack, cloud, region, frontend, or API environment option
- **THEN** Liftoff exits 1 before probes or writes and identifies every inapplicable option

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

### Requirement: Generated Power Apps projects expose the tested Code Apps stack
The system SHALL generate a root React, Vite, and TypeScript application using the pinned starter's Power Apps SDK, Power Apps Vite plugin, Tailwind and component setup, routing, state, query, and table libraries. It SHALL include root package metadata, a matching lockfile, source files, static assets, build configuration, Liftoff configuration and manifest, generated project guidance, framework output, and no Liftoff API backend or Azure infrastructure.

#### Scenario: Inspect a fresh Power Apps project
- **WHEN** a developer initializes a Power Apps code app
- **THEN** the root contains the tested starter application, package metadata, lockfile, Liftoff metadata, and selected framework integration
- **AND** it does not contain Liftoff-generated `backend`, `database`, `functions`, `infrastructure`, API `environments`, or Docker Compose output

#### Scenario: Existing Git root stays the target
- **WHEN** a developer runs Power Apps initialization at the exact root of an existing Git worktree
- **THEN** Liftoff stages and merges the Power Apps project into that root under the normal conflict and rollback contract
- **AND** it does not create a same-named child directory

### Requirement: Power Apps dependency setup is project-local and separately authorized
The system SHALL derive one lockfile-preserving root npm dependency command for a Power Apps project and SHALL run it only after a successful project commit with interactive dependency consent or `--install-dependencies`. It SHALL protect root package metadata from installer mutation and SHALL provide an exact resume command when installation is declined or fails.

#### Scenario: Install Power Apps dependencies
- **WHEN** a developer authorizes dependency setup for a freshly generated Power Apps project
- **THEN** Liftoff runs the platform-correct `npm ci` command at the project root
- **AND** it verifies that `package.json` and `package-lock.json` were not rewritten

#### Scenario: Decline dependency setup
- **WHEN** a developer declines Power Apps dependency installation
- **THEN** initialization completes with the committed scaffold intact
- **AND** completion and generated guidance show the exact root npm install command

### Requirement: Power Platform environment binding remains developer-controlled
The system SHALL NOT fabricate or collect a Power Platform tenant, environment identifier, connection, solution, credential, token, or `power.config.json` during ordinary Liftoff initialization. Generated guidance SHALL identify environment enablement as an external prerequisite and SHALL direct a developer with installed project dependencies to the packaged Power Apps CLI by using `npx --no-install`.

#### Scenario: Fresh scaffold is not silently bound
- **WHEN** Liftoff finishes generating a Power Apps project
- **THEN** no environment-specific `power.config.json` or credential is invented by Liftoff
- **AND** completion explains the separate environment initialization step

#### Scenario: Guidance prevents an unplanned npx download
- **WHEN** generated documentation shows the Power Apps initialization command
- **THEN** it uses `npx --no-install power-apps init`
- **AND** it states that authentication and environment selection remain under Microsoft's CLI

### Requirement: Power Apps projects retain spec-driven multi-agent integration
The system SHALL initialize either OpenSpec or Spec Kit at the Power Apps project root for GitHub Copilot, Claude Code, or both, using the same official framework adapters and marker validation as other workloads. Generated governance SHALL describe the Power Apps stack, connector-first data access, generated connector services, and workload-specific folder boundaries.

#### Scenario: Initialize Power Apps with OpenSpec and both agents
- **WHEN** a developer selects OpenSpec, GitHub Copilot, and Claude Code for a Power Apps project
- **THEN** the official OpenSpec initializer configures both integrations in the staged Power Apps root
- **AND** Liftoff validates both agent markers before committing

#### Scenario: Initialize Power Apps with Spec Kit and both agents
- **WHEN** a developer selects Spec Kit with one default and one secondary agent
- **THEN** the official Spec Kit initializer configures the default and installs the secondary integration
- **AND** its generated governance describes the Power Apps workload rather than an API backend

### Requirement: The Microsoft Code Apps agent plugin is an optional preview enhancement
The system SHALL present Microsoft's `code-apps-preview` plugin as an optional Power Apps-only preference after agent selection, default it to disabled, and label it Preview. When enabled, Liftoff SHALL use only allowlisted read-only detection, SHALL treat missing or unobservable state as advisory, and SHALL provide targeted agent-native marketplace guidance. Liftoff SHALL NOT run Microsoft's broad installer, enable automatic updates, copy the plugin's skills, or invoke `/create-code-app`.

#### Scenario: Developer declines the preview plugin
- **WHEN** a developer leaves the Code Apps plugin disabled
- **THEN** the Power Apps project still receives its selected OpenSpec or Spec Kit integrations
- **AND** plugin readiness does not block initialization or doctor

#### Scenario: Requested plugin is missing
- **WHEN** the project preference enables the plugin and a selected agent does not report it installed
- **THEN** Liftoff reports an advisory with the pinned marketplace and canonical preview plugin identity
- **AND** it does not execute an undocumented or broad installation command

#### Scenario: Plugin guidance avoids duplicate scaffolding
- **WHEN** Liftoff explains how to use the installed Code Apps plugin
- **THEN** it warns that `/create-code-app` must not be run inside the Liftoff-generated project
- **AND** it points developers to post-creation domain skills such as connector and deployment assistance

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

### Requirement: Power Apps projects receive only applicable repository governance
The system SHALL offer the common repository-governance profile to Power Apps code apps and SHALL generate policy context that reflects the root React, Vite, TypeScript, Tailwind, Power Apps SDK, immutable starter, npm, spec-framework, and selected-agent boundaries. It SHALL explicitly identify Liftoff API, database, Docker, OpenTofu, API environment, custom container promotion, and backend health controls as absent or inapplicable unless Phase 0 discovers separately owned infrastructure.

#### Scenario: Enable governance for Power Apps
- **WHEN** a developer accepts the default repository-governance profile for a Power Apps project
- **THEN** Liftoff generates the canonical handoff and selected-agent launchers
- **AND** context identifies the actual root application install, lint, and build commands

#### Scenario: Classify container controls
- **WHEN** the post-push agent runs Phase 0 against an unchanged Liftoff Power Apps scaffold
- **THEN** it does not propose a Liftoff container scan, image SBOM, OpenTofu deployment, blue-green container rollout, or API DAST lane
- **AND** it reports any repository, source, dependency, release, and Power Platform controls that genuinely apply

#### Scenario: External Power Platform deployment exists
- **WHEN** Phase 0 discovers a real Power Platform deployment and environment lifecycle outside Liftoff-owned files
- **THEN** the agent captures those facts in the approved governance change
- **AND** does not fabricate credentials, connections, or platform capabilities from the local scaffold
