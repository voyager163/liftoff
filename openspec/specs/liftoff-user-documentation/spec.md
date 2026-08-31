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

### Requirement: Public telemetry documentation is complete and precise
The system SHALL provide packaged, linked telemetry documentation that identifies every collected and excluded field, enabled-by-default behavior, first-run disclosure, CI disablement, `LIFTOFF_TELEMETRY=0` and `DO_NOT_TRACK=1` opt-outs, bounded failure behavior, Azure processing boundary, regional storage, and 180-day retention. The documentation SHALL state that no persistent installation or session identifier is created.

#### Scenario: User evaluates telemetry before running Liftoff
- **WHEN** a user follows the telemetry or privacy link from the root README or safety guidance
- **THEN** the linked document explains what leaves the machine, what never leaves it, how to opt out, and how long accepted events remain stored

#### Scenario: Documentation describes source IP handling
- **WHEN** the telemetry document describes network privacy
- **THEN** it states that Azure necessarily handles a source network address while routing HTTPS
- **AND** it states that Liftoff does not place that address in the event, derive geolocation from it, or persist it in the product telemetry table

#### Scenario: User inspects the npm package
- **WHEN** the published package is inspected
- **THEN** the telemetry documentation and its local README link are present and resolve correctly

### Requirement: Operator deployment guidance uses OpenTofu exclusively
The system SHALL document the telemetry service's review, plan, apply, verification, rollback, retention, and perimeter-access workflow using OpenTofu commands, SHALL identify `rg-liftoff-prod` as the fixed OpenTofu-managed production resource group, and SHALL distinguish operator deployment from normal CLI use.

#### Scenario: Maintainer prepares the Azure service
- **WHEN** a maintainer follows telemetry deployment guidance
- **THEN** all infrastructure lifecycle examples use `tofu`
- **AND** the guidance requires review of `rg-liftoff-prod` ownership and deletion protection, state-container deletion protection, the enforced state-storage perimeter, ignored operator CIDRs, ACR administrator and anonymous-access disablement, the pinned source revision and immutable image digest, the ACR task run, one-to-five Container App replica bounds, disabled persistent platform logs, managed-identity roles, approved table schema, region, retention, and remote state before apply

#### Scenario: Operator network changes
- **WHEN** the maintainer's public IP no longer matches an approved perimeter CIDR
- **THEN** the guidance explains how to update the ignored CIDR input through a bootstrap control-plane apply before accessing state or package storage

#### Scenario: Maintainer configures CI
- **WHEN** the repository uses standard GitHub-hosted runners
- **THEN** the guidance states that those runners perform static validation only
- **AND** production plan and apply require an explicitly allowed operator network

#### Scenario: Maintainer rolls back the Azure service
- **WHEN** a maintainer follows emergency disablement or rollback guidance
- **THEN** the documented OpenTofu procedure preserves `rg-liftoff-prod`

#### Scenario: Maintainer retires the legacy Function resources
- **WHEN** the Container App has passed live endpoint and data-boundary verification
- **THEN** the guidance requires a separate reviewed destructive plan and explicit approval before removing the Function App, FC1 plan, OneDeploy and package resources, product storage and association, approved-subscription rule, or regional OneDeploy rule
- **AND** the guidance requires preservation of `rg-liftoff-prod`, remote state, the state perimeter and operator rules, and accepted telemetry events

#### Scenario: Developer reads normal usage guidance
- **WHEN** a developer reviews the telemetry documentation
- **THEN** it is clear that Liftoff sends only bounded command events and never deploys or authenticates to Azure on the developer's behalf

### Requirement: Update guidance uses the imperative command matrix
The system SHALL document `liftoff update` as an imperative safe reconciliation command, `liftoff update --force` as explicit conflict overwrite, `liftoff update --check` as the read-only human check, and `liftoff update --check --json` as the read-only machine check. Public, packaged, generated-project, troubleshooting, safety, and existing-repository guidance SHALL NOT instruct users to run the removed `--apply` flag.

#### Scenario: Developer wants to update a project
- **WHEN** a developer reads update guidance
- **THEN** the primary command is plain `liftoff update`
- **AND** the guidance explains that safe managed changes apply immediately while conflicts and orphans remain untouched

#### Scenario: Automation wants a drift gate
- **WHEN** automation needs a read-only result
- **THEN** guidance uses `liftoff update --check --json`
- **AND** it documents exit code 0 for clean state and 2 for drift

#### Scenario: Developer reviews conflict overwrite
- **WHEN** a developer needs to replace locally modified managed files
- **THEN** guidance requires reviewing `liftoff update --check` output before running `liftoff update --force`

#### Scenario: Existing apply syntax is encountered
- **WHEN** a user follows old guidance or a script containing `liftoff update --apply`
- **THEN** current migration guidance states that `--apply` was removed and maps it to plain `liftoff update`

### Requirement: Documentation identifies the tested supported-stack baseline
The system SHALL publish the current runtime and framework release lines, frozen dependency commands, immutable-source rules, and baseline refresh policy in packaged user and contributor documentation. Version statements in getting-started, prerequisites, workloads, CLI, generated-project, maintenance, and contributor guidance SHALL agree with the release-owned baseline.

#### Scenario: Developer checks prerequisites
- **WHEN** a developer reads the prerequisites for a selected workload
- **THEN** the guide identifies only the applicable Node.js, Python, Go, `uv`, OpenTofu, OpenSpec, or Spec Kit constraints
- **AND** the values match the current baseline

#### Scenario: Developer installs Python dependencies
- **WHEN** generated or packaged documentation describes Python setup
- **THEN** it uses the platform-appropriate frozen `uv` synchronization flow
- **AND** it does not instruct the developer to regenerate a lock or install from open-ended ranges

#### Scenario: Existing project reviews a major baseline
- **WHEN** release notes or update guidance describe the new major Liftoff release
- **THEN** they identify raised runtime floors and major generated-stack migrations as breaking
- **AND** direct the developer to inspect `liftoff update --check` before applying

### Requirement: Contributor guidance documents reproducible baseline refresh
Contributor documentation SHALL identify the canonical version sources, stable and LTS selection policy, temporary materialization process, explicit inventory updates, immutable Power Apps refresh boundary, and complete verification commands required before promoting a baseline.

#### Scenario: Maintainer refreshes dependencies
- **WHEN** a maintainer follows the documented refresh process
- **THEN** no user project or mutable upstream state is used as the source of truth
- **AND** the resulting diff includes the baseline, manifests, locks, digests, checksums, tests, and documentation that changed

### Requirement: Documentation distinguishes CLI upgrade from project update
Packaged README, getting-started, CLI-reference, maintenance, troubleshooting, and generated-project guidance SHALL describe `liftoff upgrade` as replacement of the supported global CLI installation and `liftoff update` as reconciliation of one generated project. No guide SHALL imply that either command performs the other's work.

#### Scenario: Developer wants the newest CLI
- **WHEN** a developer reads installation or maintenance guidance
- **THEN** it presents `liftoff upgrade --check` followed by `liftoff upgrade`
- **AND** retains the exact manual global npm command for first installation and unsupported origins

#### Scenario: Developer wants new templates
- **WHEN** a developer wants an existing project to adopt templates from the newly installed CLI
- **THEN** documentation directs them to inspect `liftoff update --check` and then run `liftoff update`
- **AND** states that CLI self-upgrade did not modify the project

### Requirement: Documentation explains self-upgrade safety and registry policy
The documentation SHALL identify supported global npm installations, imperative apply behavior, read-only check behavior, exit codes, JSON mode, canonical stable target selection, configured-registry parity, stale-mirror blocking, unsupported local or `npx` origins, lack of automatic elevation, and exact post-failure recovery.

#### Scenario: Managed registry is stale
- **WHEN** a developer follows troubleshooting after a blocked upgrade
- **THEN** the guide directs them to synchronize or approve the canonical target in the managed registry
- **AND** does not instruct Liftoff to rewrite npm configuration or bypass the mirror

#### Scenario: Installation needs elevated permission
- **WHEN** npm reports that the effective global prefix is not writable
- **THEN** the guide explains that Liftoff does not invoke elevation
- **AND** directs the developer to resolve their Node/npm installation ownership through their approved workstation process

#### Scenario: Post-install verification fails
- **WHEN** upgrade cannot verify the replacement
- **THEN** troubleshooting provides an exact-version npm reinstall procedure
- **AND** states that Liftoff does not claim automatic rollback

### Requirement: Documentation covers the first self-upgrade-capable release
Release and migration guidance SHALL explain that older Liftoff versions without the command require one manual global npm upgrade. After the first capable version is installed globally through npm, later stable releases can use `liftoff upgrade`.

#### Scenario: User runs upgrade on an older release
- **WHEN** a user's installed Liftoff version predates the self-upgrade command
- **THEN** documentation gives the canonical manual installation command
- **AND** does not imply that an unavailable command can bootstrap itself

### Requirement: Documentation explains repository-governance selection and activation
The system SHALL provide packaged and generated documentation for the governance profile choice, enabled default, opt-out, local artifact set, manifest state, post-push agent launcher, read-only Phase 0, explicit approval boundary, selected-framework change creation, and live enforcement sequence. It SHALL state prominently that generated policy is not active GitHub governance.

#### Scenario: New user follows interactive onboarding
- **WHEN** a developer reads getting-started or workload guidance
- **THEN** the guide includes the repository-governance question after applicable architecture choices
- **AND** explains that accepting it generates a local handoff only

#### Scenario: User activates after push
- **WHEN** a developer reads the generated governance guide
- **THEN** it identifies the selected-agent command or prompt, Git repository and remote prerequisites, Phase 0 report, and required plan approval
- **AND** distinguishes conversational plan approval from prohibited human merge or deployment approvals

#### Scenario: User opts out
- **WHEN** documentation describes `--governance none` or the configuration equivalent
- **THEN** it explains that Liftoff omits the handoff and does not alter live repository settings

### Requirement: Documentation describes existing-project adoption
Update, configuration, manifest, safety, and troubleshooting guidance SHALL
explain that configurations without a governance field default to the enabled
profile, `liftoff update --check` previews the new durable artifacts, plain
update applies collision-free artifacts, unrecorded conflicts remain preserved
and produce `handoff-partial` without Liftoff ownership, resolving all such
conflicts promotes the manifest to `handoff-generated`, opt-out creates orphans
rather than deletion, and no update mode activates remote governance.

#### Scenario: Existing user previews adoption
- **WHEN** a user reads upgrade guidance for a pre-v5 project
- **THEN** it directs the user to run `liftoff update --check`
- **AND** explains the expected schema-v5 and governance artifact drift

#### Scenario: Existing governance file conflicts
- **WHEN** troubleshooting describes a collision at a generated policy or launcher path
- **THEN** it tells the user to review the exact file before considering `--force`
- **AND** explains the partial local handoff state and that the preserved file has no Liftoff manifest entry
- **AND** does not recommend deleting, bypassing, or remotely applying anything to make update pass

### Requirement: The complete single-maintainer policy remains discoverable
The packaged governance documentation SHALL expose the complete policy covering GitFlow, zero-approval repository rules, security stages and designated tools, fail-closed checks, immutable release evidence, build-once promotion, deployment and rollback, monitoring and health, DORA metrics, ruleset sequencing, negative tests, documentation, and workload adaptation. It SHALL identify fixed assumptions and every capability that Phase 0 must verify.

#### Scenario: Developer audits generated policy
- **WHEN** a developer opens the canonical generated policy
- **THEN** the full standard is readable without requiring network access or an agent
- **AND** links or launchers do not replace its normative content

#### Scenario: Policy capability is unavailable
- **WHEN** documentation describes a missing license, runner, monitoring route, or platform mechanism
- **THEN** it requires an explicit Phase 0 gap or inapplicability report
- **AND** prohibits a silent substitute or success-shaped placeholder
