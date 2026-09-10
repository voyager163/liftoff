## Purpose

Define the public Liftoff documentation experience, packaging contract, and progressive guidance for users and contributors.

## Requirements

### Requirement: The root README is a product-oriented landing page
The system SHALL provide a concise public README leading with Liftoff's identity, plain-language value, meaningful release/quality badges, an accessible terminal visual, and the shortest supported interactive install path. It SHALL introduce GenAI and API workloads with OpenSpec, Spec Kit, GitHub Copilot, and Claude Code without embedding the complete operational reference or presenting Power Apps as supported.

#### Scenario: New developer scans the repository
- **WHEN** a developer opens the root README
- **THEN** the first screen explains Liftoff's supported workloads and integrations and gives installation followed by `liftoff init`

#### Scenario: Terminal visual has a text alternative
- **WHEN** the README includes a terminal image
- **THEN** meaningful alternative text and the surrounding quick start communicate the same essential flow

#### Scenario: Badges represent observable project facts
- **WHEN** badges appear
- **THEN** they link to observable npm, CI, license, or runtime facts rather than unsupported readiness claims

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
The system SHALL maintain linked Markdown guides for getting started, supported workloads, workflows/agents, existing repositories, prerequisites, safety/consent, CLI reference, generated structure, configuration/manifests, assessment, deployment, and troubleshooting. Material moved out of the README SHALL remain discoverable. Supported-workload guidance SHALL cover API/GenAI; retirement guidance SHALL explain former Power Apps inputs separately.

#### Scenario: Developer needs a detailed contract
- **WHEN** a developer follows README links for safety, prerequisites, manifests, structure, or Azure
- **THEN** the linked documents contain the corresponding detailed guidance

#### Scenario: Developer chooses a workload
- **WHEN** workload documentation is opened
- **THEN** it distinguishes API/GenAI questions, output, prerequisites, and deferred actions without offering Power Apps creation or maintenance

#### Scenario: Contributor needs release internals
- **WHEN** a contributor needs build, test, packaging, or release procedures
- **THEN** the README links to CONTRIBUTING.md rather than duplicating release implementation in onboarding

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
Public, packaged, generated-project, troubleshooting, safety, and existing-repository documentation SHALL present `liftoff update --check` as the primary human compatibility/migration preview, followed by `liftoff update` with explicit approval. It SHALL explain that project bytes remain unchanged during check while a disclosed user-local preview receipt is saved outside the repository. JSON SHALL be optional output formatting, and noninteractive apply SHALL require the exact plan fingerprint. Force SHALL remain limited, separately previewed, and unable to bypass receipt, approval, compatibility, or ownership guards. Removed `--apply` SHALL not be recommended.

#### Scenario: Developer wants to update a project
- **WHEN** update guidance is read
- **THEN** it starts with `liftoff update --check` and explains the matching-preview and explicit-approval requirement before apply

#### Scenario: Automation wants a drift gate
- **WHEN** automation needs a structured preview
- **THEN** guidance uses `liftoff update --check --json` and documents external receipt persistence, schema 3, and exit 0/1/2 meanings

#### Scenario: Developer reviews conflict overwrite
- **WHEN** an owned core conflict needs replacement
- **THEN** guidance requires reviewing the check's exact force variant and approving that fingerprint for `update --force`
- **AND** it states that project files and unowned/provisioning collisions remain protected

#### Scenario: Existing apply syntax is encountered
- **WHEN** old instructions use `liftoff update --apply`
- **THEN** migration guidance explains the removed flag and the current check-then-approved-update sequence

#### Scenario: A check is absent or stale
- **WHEN** a user encounters a missing/stale preview message
- **THEN** documentation directs them to rerun check rather than force, edit a receipt, or suppress compatibility

### Requirement: Documentation identifies the tested supported-stack baseline
The system SHALL publish applicable runtime, package-manager, framework, frozen-dependency, immutable-source, and refresh contracts consistently across packaged and contributor guidance. Statements SHALL agree with the release-owned baseline and distinguish new-generation baselines from separately reviewed adoption into existing projects.

#### Scenario: Developer checks prerequisites
- **WHEN** prerequisites are read for a supported workload
- **THEN** only its applicable Node.js, npm, Python, Go, uv, OpenTofu, OpenSpec, and Spec Kit constraints are identified
- **AND** they agree with the release-owned baseline, including the CLI Node.js minimum

#### Scenario: Developer installs Python dependencies
- **WHEN** Python setup is documented
- **THEN** it uses the platform-appropriate frozen uv flow rather than regenerating locks or installing open-ended ranges

#### Scenario: Existing project reviews a major baseline
- **WHEN** release guidance describes changed generated-stack compatibility
- **THEN** runtime floors and application compatibility changes are identified as separate project migration work
- **AND** ordinary update or force is not offered to replace production dependencies, containers, or infrastructure

### Requirement: Contributor guidance documents reproducible baseline refresh
Contributor guidance SHALL identify canonical version sources, stable/LTS selection, temporary materialization, explicit remaining asset/audit inventories, immutable provenance where applicable, and complete promotion checks. The retired Power Apps starter refresh and compatibility inventory SHALL NOT remain an active maintenance procedure.

#### Scenario: Maintainer refreshes dependencies
- **WHEN** a maintainer follows the refresh process
- **THEN** neither user projects nor mutable upstream state become the source of truth
- **AND** the resulting reviewed change includes affected baseline records, manifests, locks, digests, checksums, cases, and documentation

### Requirement: Documentation distinguishes CLI upgrade from core update
Maintenance guidance SHALL describe `liftoff upgrade` as replacement of the supported global CLI installation and `liftoff update` as reviewed maintenance for one generated project, including only explicitly supported activation migrations. Neither command SHALL be presented as upgrading production application templates. The existing `liftoff migrate` command SHALL retain its distinct source-preserving non-Liftoff adoption role.

#### Scenario: Developer wants the newest CLI
- **WHEN** installation or maintenance guidance is read
- **THEN** it retains upgrade check/apply and exact manual installation fallbacks

#### Scenario: Developer wants core template updates
- **WHEN** a project needs newer Liftoff control-plane files
- **THEN** guidance uses update check followed by exact approval and apply
- **AND** it explains that CLI installation itself did not migrate the project

#### Scenario: Developer wants project template changes
- **WHEN** a user needs new starter source, dependencies, containers, database assets, or infrastructure
- **THEN** guidance requires separately reviewed project migration rather than ordinary update or force

### Requirement: Documentation explains template ownership
Documentation SHALL retain the managed-core, project, desired-state, framework, and seed lifecycles and explain that filenames/categories do not grant ownership. It SHALL describe the narrow separately approved activation-history/successor write set without making history, existing production files, or an entire governance directory managed core. Project generation provenance and intentionally modified/deleted production files SHALL remain protected.

#### Scenario: Existing project upgrades to the ownership-aware manifest
- **WHEN** legacy ownership migration is documented
- **THEN** non-core assets are released to project ownership without restoring or replacing them

#### Scenario: Developer sees a file named config
- **WHEN** configuration examples are read
- **THEN** desired state, runtime files, and maintained core are distinguished by explicit contract

#### Scenario: Developer considers force
- **WHEN** force is documented
- **THEN** its exact eligible core boundary is explained and production/history replacement is excluded

#### Scenario: Developer preserves activation history
- **WHEN** v1 migration is documented
- **THEN** the exact history inventory and successor/journal authority are distinguished from normal template reconciliation

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

### Requirement: Documentation explains the complete OpenSpec template contract
The system SHALL document that Liftoff OpenSpec projects require all 12 OpenSpec 1.11 workflows with both skills and commands, that this selection is stored in global OpenSpec configuration, and that Liftoff changes that configuration only after separate consent. The guidance SHALL distinguish new-project setup from framework-owned maintenance in an existing project.

#### Scenario: New user reviews OpenSpec setup
- **WHEN** a developer reads getting-started, CLI, prerequisite, or spec-workflow guidance before initialization
- **THEN** the documentation lists or links to the complete workflow set
- **AND** it explains the interactive and noninteractive authorization needed when the global profile differs

#### Scenario: User evaluates the Copilot cloud-agent option
- **WHEN** a developer reads the OpenSpec and agent guidance
- **THEN** it identifies the default-off choice, `.github/workflows/copilot-setup-steps.yml`, and `.github/agents/openspec.agent.md`
- **AND** it explains that the option targets GitHub's hosted coding agent rather than Copilot in an editor or terminal

#### Scenario: Existing project needs expanded workflows
- **WHEN** a developer wants to align an existing Liftoff project rather than create a fresh scaffold
- **THEN** the documentation directs them to configure the global OpenSpec profile and run `openspec update`
- **AND** it does not claim that plain `liftoff update` owns or regenerates OpenSpec skills and commands

#### Scenario: User reviews independent consent
- **WHEN** a developer reads safety or automation guidance
- **THEN** it states that `--yes`, `--force`, tool installation, dependency installation, global-profile configuration, and cloud-agent opt-in have distinct scopes

### Requirement: Documentation explains repository-governance selection and activation
The system SHALL document governance selection, enabled default, opt-out, local artifacts, manifest state, post-init setup, read-only Phase 0, approval boundaries, selected-workflow handoff, and the target enforcement sequence. It SHALL distinguish those target capabilities from currently executable behavior and state that generated policy is not active governance.

#### Scenario: New user follows interactive onboarding
- **WHEN** getting-started or workload guidance is read
- **THEN** governance selection follows applicable architecture choices and accepting it is described as a local handoff only

#### Scenario: User activates after push
- **WHEN** the generated guide describes post-push governance
- **THEN** it identifies the selected-agent entry point, repository/remote prerequisites, Phase 0 facts, and required scope approval
- **AND** distinguishes activation authority from prohibited human merge/deployment reviewers
- **AND** states when the installed release lacks a necessary execution or approval-entry capability

#### Scenario: User opts out
- **WHEN** governance none is documented
- **THEN** the guide explains that local handoff generation is omitted without changing live repository settings

### Requirement: Documentation explains Azure provider readiness
The governance documentation SHALL explain how Phase 0 derives the minimal
resource-provider namespace set, distinguishes AzureRM automatic registration
from explicit registration, proves terminal readiness, orders dependent
resources, validates intentional subscription features and service-tag
semantics, and retains successful provider registrations during teardown.

#### Scenario: Developer disables AzureRM auto-registration
- **WHEN** documentation shows or discusses `resource_provider_registrations = "none"`
- **THEN** it requires explicit registration and `Registered` readback for every namespace used by the approved plan
- **AND** identifies `Microsoft.Network` and `GitHub.Network` as required by the hosted-runner network

#### Scenario: Registration is incomplete
- **WHEN** documentation describes an absent, unauthorized, pending, or failed provider registration
- **THEN** it keeps dependent provisioning blocked and requires a revised no-apply plan before retry

#### Scenario: Infrastructure is torn down
- **WHEN** documentation describes repository resource removal
- **THEN** it preserves successful provider registrations as subscription capabilities
- **AND** does not recommend unregistering them automatically

#### Scenario: Azure reports an unrelated feature gate
- **WHEN** documentation discusses `SubscriptionNotRegisteredForFeature`
- **THEN** it requires proof that the approved resource intentionally uses the feature before registration
- **AND** directs unintended feature requests to resource, provider, or API correction

#### Scenario: Documentation configures Azure platform DNS
- **WHEN** documentation discusses the `AzurePlatformDNS` service tag
- **THEN** it identifies the tag as deny-only for disabling default platform DNS
- **AND** directs custom DNS allows to exact resolver addresses instead

### Requirement: Documentation describes existing-project adoption
Guidance for supported API/GenAI projects SHALL explain enabled defaults for absent governance configuration, safe core adoption, unowned collision protection and partial handoff, orphan-preserving opt-out, and the absence of remote activation. It SHALL distinguish v2-v7 project manifest compatibility from executable activation-history compatibility. Retired Power Apps projects SHALL NOT be included in the supported adoption path.

#### Scenario: Existing user previews adoption
- **WHEN** a supported pre-v7 project reads upgrade guidance
- **THEN** it is directed to `liftoff update --check` and receives an explanation of manifest-v7 ownership migration and governance core drift
- **AND** existing activation history is not described as implicitly migrated or newly verified

#### Scenario: Existing governance file conflicts
- **WHEN** a generated policy or setup path collides with an unowned file
- **THEN** guidance requires review of that exact file, explains partial handoff and lack of ownership, and preserves the conflict
- **AND** does not recommend deletion, forced takeover, or remote action merely to make update pass

### Requirement: The complete single-maintainer policy remains discoverable
The packaged governance documentation SHALL expose the complete policy covering
GitFlow, zero-approval repository rules, conditional repository-dedicated
provisioning of the VNet-injected larger runner, per-subscription ownership,
explicit outbound-mode selection, transient local-state bootstrap, verified
remote adoption, 30-day read-only retention and secure deletion, settled
platform defaults, cost and service-limit disclosure, import-first
infrastructure reconciliation, security stages and designated tools, the narrow
SLSA L3 pinning exception, fail-closed checks, candidate-to-production merge
identity, automated token-safe back-merges, immutable release evidence,
build-once promotion, deployment and rollback, monitoring and health, DORA
metrics, ruleset sequencing, negative tests, documentation, and workload
adaptation. It SHALL identify fixed assumptions and every capability that Phase
0 must verify while preserving the Liftoff activation protocol.

#### Scenario: Developer audits generated policy
- **WHEN** a developer opens the canonical generated policy
- **THEN** the full revised standard is readable without requiring network access or an agent
- **AND** links or launchers do not replace its normative content

#### Scenario: Policy capability is unavailable
- **WHEN** documentation describes missing runner-provisioning authority, licenses, monitoring routes, or platform mechanisms
- **THEN** it requires an explicit Phase 0 gap or inapplicability report
- **AND** it prohibits a silent substitute, partial provisioning, or success-shaped placeholder

#### Scenario: Developer reviews runner provisioning
- **WHEN** documentation explains private Staging runner activation
- **THEN** it distinguishes repository-owned Azure resources from organization-level GitHub hosted-compute resources
- **AND** explains applicability, approval, Firewall Basic versus NAT Gateway selection, cost, private connectivity, readback, and teardown ordering

#### Scenario: Developer reviews private-state bootstrap
- **WHEN** documentation explains how to resolve a private-backend bootstrap cycle
- **THEN** it explains local custody, prohibited transfer paths, verified remote import, the fixed 30-day read-only retention period, secure deletion, and required evidence
- **AND** it never presents retained local state as an active backend

#### Scenario: Developer traces a production release
- **WHEN** documentation explains release qualification and promotion
- **THEN** it distinguishes the qualified candidate commit from the true production merge commit
- **AND** explains how both commits remain bound to the identical artifact and durable evidence

#### Scenario: Existing project receives the policy update
- **WHEN** documentation describes managed-core drift for an older generated governance handoff
- **THEN** it explains that local policy review is required before replacement
- **AND** it does not imply that updating the handoff provisions resources or changes live repository governance

### Requirement: Documentation explains the generic GenAI starting point
Public and generated guidance SHALL present `I'm not sure yet - Generic GenAI starter` as the safe choice when a user cannot yet select a specialization. It SHALL describe the neutral runtime and invocation boundary, enumerate the specialized capabilities that are intentionally absent, document `--pattern generic`, and state that later specialization is reviewed project migration work rather than managed-core update.

#### Scenario: New user does not know the architecture
- **WHEN** a user reads workload or initialization guidance before choosing RAG, chatbot, agents, streaming, fine-tuning, or workflows
- **THEN** the guidance recommends the generic option as an honest neutral starting point
- **AND** does not imply that RAG is the default

#### Scenario: Automation creates a generic project
- **WHEN** documentation shows deterministic noninteractive initialization
- **THEN** it includes `--pattern generic` as the explicit uncertainty-safe value

#### Scenario: Generic project later needs specialization
- **WHEN** documentation explains how a generic project can become specialized
- **THEN** it states that generated application files are project-owned and require a separately reviewed migration
- **AND** it does not direct the user to `liftoff update` or `--force`

### Requirement: Documentation provides one post-init kickstart
The root README, getting-started guide, generated README, and governance guide SHALL retain initialization followed by `/liftoff-setup` as the primary supported-project journey. They SHALL explain the selected workflow's local baseline/finalization, later publication and Phase 0 boundaries, authority gates, explicit retry, and the distinction between model explanation and CLI authority. Unimplemented production or public enrollment/approval capabilities SHALL be identified as blockers, not presented as completed automation.

#### Scenario: Developer finishes initialization
- **WHEN** supported-project completion output or README is read
- **THEN** the next setup entry point is `/liftoff-setup` and its applicable local baseline checks are listed

#### Scenario: Developer asks about model selection
- **WHEN** setup guidance discusses model selection
- **THEN** it states that none is required and safety depends on deterministic phase/evidence contracts

#### Scenario: Developer inspects setup identity
- **WHEN** setup identities are documented
- **THEN** CLI, policy, activation contract, schema versions, and graph hash are distinguished without an independent setup-skill version
- **AND** the current activation-v2 family is distinguished from diagnostic-only v1 history

#### Scenario: Setup needs developer input
- **WHEN** authority questions are documented
- **THEN** they are limited to repository publication, credentials, billed infrastructure/exceptions, enforcement, destructive actions, and external blockers
- **AND** documentation does not suggest manually creating an approval envelope when no supported entry point exists

#### Scenario: Developer resumes setup
- **WHEN** a prior run stopped on a blocker
- **THEN** guidance explains read-only resume and explicit retry after repair through the selected setup flow
- **AND** unchanged verified work is not repeated and remote/destructive failures are not automatically retried

#### Scenario: Developer reads setup command guidance
- **WHEN** generated setup aliases are discussed
- **THEN** `/liftoff-setup` is the primary setup command and retired aliases appear only as reviewed removal debt

#### Scenario: Developer enters a credential
- **WHEN** the target policy requires PAT fallback
- **THEN** guidance describes deterministic scope and masked-entry requirements without exposing credentials in chat, arguments, logs, evidence, or screenshots
- **AND** a release without a supported enrollment entry point is described as blocked rather than inviting another input channel

#### Scenario: Spec Kit user completes the local baseline
- **WHEN** Spec Kit setup is documented
- **THEN** the guide distinguishes the project-owned bootstrap spec/plan/tasks bundle from official framework initialization markers and explains its finalized local receipt
- **AND** does not instruct the user to create an OpenSpec directory or run a nonexistent Spec Kit archival command
- **AND** explains that an older project without the bundle needs separately reviewed seed adoption rather than automatic creation by update or force

### Requirement: Documentation distinguishes assessment from update and activation
Guidance SHALL retain local-only and explicitly scoped live assessment for supported and ordinary Git repositories, installed targets, comparison layers, coverage/classifications, provenance, and exit codes. Assessment SHALL remain distinct from migration, activation, and remediation authority. Supported historical migration SHALL be described accurately through update check; unsupported lanes SHALL remain named limitations rather than invented commands or receipt edits.

#### Scenario: Developer wants to see differences
- **WHEN** assessment guidance is read
- **THEN** target, baseline, declarations, and observed enforcement remain separately explained

#### Scenario: Developer does not want network access
- **WHEN** the default assessment example is followed
- **THEN** it is local-only, credential-free, and telemetry/disclosure-excluded, including help

#### Scenario: Developer requests live assessment
- **WHEN** live mode is described
- **THEN** bounded existing-permission reads and the no-mutation boundary remain explicit
- **AND** unavailable reads are not called absence or alignment

#### Scenario: Assessment is partial or excepted
- **WHEN** coverage is incomplete or an exception is accepted
- **THEN** exit 2 is explained without claiming full alignment or permission to repair

#### Scenario: Upgrade is blocked by compatibility
- **WHEN** historical activation appears in an assessment
- **THEN** guidance distinguishes a supported migration preview from an actually unavailable lane
- **AND** neither force nor edited receipts are offered as compatibility bypasses

#### Scenario: Developer installs a newer assessment integration
- **WHEN** a supported project needs an assessment integration
- **THEN** guidance uses the reviewed core update flow without implying that installation activates governance
- **AND** ordinary Git repositories can continue using the CLI directly

#### Scenario: Maintainer extends policy assessment coverage
- **WHEN** contributor guidance describes new evaluators
- **THEN** stable IDs, explicit proof/support limits, deterministic no-write cases, and cross-platform safety remain required without a new assessment-skill version

#### Scenario: Developer assesses Liftoff's source repository
- **WHEN** a repository has no Liftoff manifest
- **THEN** guidance uses ordinary read-only assessment with the installed policy target and honest missing-proof findings

#### Scenario: Manifest is retired or damaged
- **WHEN** a manifest is retired, malformed, or unsafe
- **THEN** guidance preserves the error boundary rather than hiding it to force fallback

### Requirement: Migration guidance explains preservation and resumable partial outcomes
Documentation SHALL describe the compatibility/preview/approval/history/successor/revalidation/resume sequence, exact source support, in-project historical storage, and the separate external preview receipt. It SHALL distinguish pre-commit transaction recovery from post-commit revalidation failure, explain that committed v2 remains blocked/resumable after failure, and prohibit manual version retagging, historical approval reuse, automatic v1 restoration, or live-resource recreation. It SHALL identify unavailable producers and separate provider authority honestly.

#### Scenario: A user migrates known v1
- **WHEN** the migration walkthrough is followed
- **THEN** it explains the readable preview, explicit approval, preserved bytes, linked v2, and fresh-proof requirements
- **AND** it does not require a separate activation-migration command

#### Scenario: A check fails after local commit
- **WHEN** troubleshooting describes committed migration with failed revalidation
- **THEN** it directs the user to repair the named blocker, obtain a fresh preview, and approve remaining work
- **AND** it explains exit 2 and retained v2 progress without suggesting a reset

#### Scenario: CI applies an update
- **WHEN** automation guidance is read
- **THEN** it shows a matching preview and `--approve-plan <fingerprint>` in the same materialized checkout/user-local storage context
- **AND** it states that a changed workspace or plan requires a fresh check and approval, not a portable blanket authorization

#### Scenario: A project moves to another machine
- **WHEN** history/receipt portability is explained
- **THEN** history travels inside the project but local preview receipts do not
- **AND** Windows, macOS, and Linux storage and path behavior are documented without assuming a shared home-directory layout

#### Scenario: Local validation runs project-controlled commands
- **WHEN** validation safety is described
- **THEN** the exact approved commands and known effects are disclosed
- **AND** documentation does not claim a sandbox or authorize rollback of unexpected user-owned edits

### Requirement: Generated infrastructure guidance is environment-correct and authority-aware
Generated guidance SHALL use selected environments and their recorded infrastructure layout. New output SHALL describe independent environment roots/state; existing shared-state output SHALL have an explicit migration boundary. Governed projects SHALL distinguish reference commands from separately approved execution and identify unavailable production capabilities instead of bypassing them.

#### Scenario: Governed project documentation is read
- **WHEN** generated guidance describes plan/apply
- **THEN** it requires the relevant separately approved phase and does not bypass an unavailable executor

#### Scenario: Ungoverned project documentation is read
- **WHEN** governance is explicitly disabled
- **THEN** reference recipes use declared environments without fabricated activation

#### Scenario: A production-only project is generated
- **WHEN** prod is the first or only selected environment
- **THEN** examples use its independent root and production inputs without nonexistent development files

#### Scenario: Maintainer reads audit follow-up guidance
- **WHEN** contributor guidance describes this stabilization work
- **THEN** completed corrections and structural extraction are distinguished from deferred production activation and GenAI specializations
- **AND** it does not equate rendered artifacts or module moves with finished capabilities

#### Scenario: Existing infrastructure uses shared state
- **WHEN** an existing project reviews the new environment layout
- **THEN** guidance requires a separate reviewed infrastructure/state migration and preserves existing files/state under update and force
- **AND** it explains that new-environment provisioning is blocked until the recorded layout is compatible rather than creating unusable roots or rewriting shared project files

### Requirement: Retirement guidance preserves existing Power Apps projects
Public and packaged guidance SHALL identify complete Power Apps retirement as a breaking change, covering creation and existing-project support. It SHALL explain explicit unsupported-workload errors without offering conversion, application deletion, force bypass, or continued support in the new CLI.

#### Scenario: User opens an existing retired project
- **WHEN** a user encounters a Power Apps retirement error
- **THEN** guidance states that their application files are unchanged and that this release does not provide a Power Apps maintenance or migration lane

#### Scenario: Maintainer removes starter assets
- **WHEN** contributor guidance describes retirement
- **THEN** it requires coordinated explicit inventory removal and preservation of shared regression scenarios on supported workloads
- **AND** never directs users to uninstall unrelated machine-wide tools or plugins

### Requirement: Starter capability descriptions match delivered behavior
Public and generated guidance SHALL expose an accurate capability/maturity description for each retained GenAI pattern and distinguish invocation/runtime wiring from missing specialized behavior. It SHALL NOT call buffered completion incremental streaming or imply that retrieval, history, tools, coordination, workflow execution, or fine-tuning is present when absent.

#### Scenario: User compares named patterns
- **WHEN** a user reads the pattern/workload matrix
- **THEN** implemented operations and deferred boundaries are explicit rather than inferred from a full-scaffold label

#### Scenario: User follows configuration instructions
- **WHEN** supported native or Compose startup is documented
- **THEN** configuration sources, precedence, dependency preparation, and container-specific addressing agree with generated runtime behavior
- **AND** locally installed dependency trees are excluded from generated container build contexts

### Requirement: Contributor guidance makes module responsibilities discoverable
The contributor guide SHALL document the eight functional responsibility groups, their actual implementation locations, public interfaces, dependency direction, ownership rules, and the process for extending workloads or phases without duplicating policy/evidence authority.

#### Scenario: Contributor extends a supported workload
- **WHEN** a contributor follows the module map
- **THEN** the responsible planning, generation, configuration, prerequisite, and acceptance boundaries are identifiable without treating callback facades as independent implementations

#### Scenario: Contributor changes an activation contract
- **WHEN** phase, evidence, approval, or serialization semantics change
- **THEN** the guide identifies the required independent version/hash updates and historical-compatibility consequences

#### Scenario: Contributor works on Windows
- **WHEN** paths and acceptance recipes are documented for contributors
- **THEN** they use platform-correct path construction and explicit shell conventions for Windows, macOS, and Linux
- **AND** distinguish portable logical artifact paths from native filesystem paths
