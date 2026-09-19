## Purpose

Define the public Liftoff documentation experience, packaging contract, and progressive guidance for users and contributors.

## Requirements

### Requirement: The root README is a product-oriented landing page
The system SHALL provide a concise public README leading with Liftoff's identity, plain-language value, meaningful release/quality badges, an accessible terminal visual, and the shortest supported native installation path for each operating system. It SHALL introduce supported API/GenAI workloads, OpenSpec/Spec Kit, Copilot, Claude Code, and Codex without embedding the full operational reference, presenting Power Apps as supported, or presenting npm as the current distribution.

#### Scenario: New developer scans the repository
- **WHEN** a developer opens the root README
- **THEN** the first screen explains supported workloads and integrations and links platform-native installation followed by interactive `liftoff init`
- **AND** existing application owners can discover assessment/adoption without being directed to reinitialize their project

#### Scenario: Terminal visual has a text alternative
- **WHEN** the README includes a terminal image
- **THEN** meaningful alternative text and the surrounding quick start communicate the same essential flow

#### Scenario: Badges represent observable project facts
- **WHEN** badges appear
- **THEN** they link to actual native release, CI, coverage, license, or supported-runtime facts rather than unsupported readiness claims
- **AND** an npm badge, if retained for history, is not presented as current release readiness

### Requirement: The README demonstrates interactive onboarding
The system SHALL show interactive `liftoff init` as the primary new-project quick start after verified native installation. It SHALL illustrate workload, spec-workflow, multi-agent, readiness, and safe completion choices. Advanced noninteractive flags SHALL remain discoverable through linked CLI guidance rather than replace first use with one long command. Existing-repository instructions SHALL distinguish safe initialization at an eligible exact Git root from assessment and reviewed in-place adoption of an existing application.

#### Scenario: Review the quick start
- **WHEN** a developer follows the README quick start
- **THEN** the documented native channel installs the qualified CLI and launches interactive init
- **AND** the flow does not require copying a fully specified command before the developer understands its choices

#### Scenario: Discover existing-repository behavior
- **WHEN** a developer wants to initialize an eligible existing Git repository
- **THEN** the README states that running `liftoff init` at the exact Git root initializes in place
- **AND** it links the full target/safety guide and directs existing applications needing adoption to assess/adopt instead of starter replacement

### Requirement: Detailed user guidance uses progressive Markdown documentation
The system SHALL maintain linked Markdown guides for native installation/handover, getting started, supported workloads, workflows/agents, existing repositories, prerequisites, safety/consent, CLI reference, generated structure, configuration/manifests, whole-project and governance assessment, adoption, deployment, and troubleshooting. Moved material SHALL remain discoverable. Workload guidance SHALL cover API/GenAI and distinguish former Power Apps inputs as retired. Operational guidance SHALL describe actual supported commands and qualified outcomes rather than capability names or generated files as proof of completion.

#### Scenario: Developer needs a detailed contract
- **WHEN** a developer follows README links for safety, prerequisites, manifests, structure, Azure, installation migration, or adoption
- **THEN** the linked documents contain the corresponding detailed guidance

#### Scenario: Developer chooses a workload
- **WHEN** workload documentation is opened
- **THEN** it distinguishes API/GenAI questions, output, prerequisites, and deferred actions without offering Power Apps creation or maintenance

#### Scenario: Contributor needs release internals
- **WHEN** a contributor needs build, test, packaging, coverage, or release procedures
- **THEN** the README links to CONTRIBUTING.md rather than duplicating release implementation in onboarding

### Requirement: Public documentation is packaged and link-safe
Each native bundle SHALL include the root README, linked documentation, referenced static assets, licenses, and required local guidance through an explicit resource inventory. Local links and first-use commands SHALL be qualified from the installed artifact on Windows, macOS, and Linux without the checkout or a documentation build tool. Historical npm artifacts SHALL retain their originally packaged documentation without being rebuilt to carry the new guide.

#### Scenario: Inspect the packed npm artifact
- **WHEN** a historical npm artifact is inspected
- **THEN** its original README, linked packaged documentation, and assets remain available under its historical contract
- **AND** it is not presented as the current native documentation package

#### Scenario: Validate local documentation links
- **WHEN** documentation qualification evaluates README and required packaged-guide links
- **THEN** every referenced local document and asset resolves from the installed bundle using native path handling
- **AND** paths with spaces and case/normalization differences do not resolve an unintended target

#### Scenario: Documentation needs no build tool
- **WHEN** a contributor edits user documentation
- **THEN** Markdown and static assets remain readable on GitHub and from the native bundle without a separate documentation generator
- **AND** historical npm documentation remains independently readable

#### Scenario: Inspect the native artifact
- **WHEN** final native package verification lists its documentation resources
- **THEN** the README, linked guides, static visuals, and license inventory are present
- **AND** missing local resources fail qualification before stable publication

### Requirement: Public telemetry documentation is complete and precise
The system SHALL provide packaged, linked telemetry guidance naming every collected/excluded field, enabled-by-default eligibility, first-use disclosure, assessment/inspection exclusions, read-only disclosure behavior, CI disablement, `LIFTOFF_TELEMETRY=0`, `DO_NOT_TRACK=1`, bounded failure behavior, Azure processing boundary, region, and 180-day retention. It SHALL state that no persistent installation/session identifier is created and no model prompts, responses, IDs, paths, owner/channel details, or plan/receipt data are collected. Native packaging SHALL NOT be presented as changing the five-field aggregate privacy contract.

#### Scenario: User evaluates telemetry before running Liftoff
- **WHEN** a user follows the telemetry or privacy link from the root README or safety guidance
- **THEN** the linked document explains what leaves the machine, what never leaves it, how to opt out, and how long accepted events remain stored

#### Scenario: Documentation describes source IP handling
- **WHEN** the telemetry document describes network privacy
- **THEN** it states that Azure necessarily handles a source network address while routing HTTPS
- **AND** it states that Liftoff does not place that address in the event, derive geolocation from it, or persist it in the product telemetry table

#### Scenario: User inspects the npm package
- **WHEN** a historical npm package is inspected
- **THEN** its originally shipped telemetry guidance and README link remain intact
- **AND** current guidance does not imply those historical bytes were rewritten during native cutover

#### Scenario: User inspects native privacy guidance
- **WHEN** a native bundle is inspected offline
- **THEN** current telemetry guidance and its local README links resolve without a source checkout
- **AND** model-host reasoning and private migration records are explicitly outside event collection

### Requirement: Operator deployment guidance uses OpenTofu exclusively
The system SHALL document telemetry-service review, plan, apply, verification, rollback, retention, and perimeter access using OpenTofu, with `rg-liftoff-prod` as the fixed managed production resource group. It SHALL distinguish operator deployment of telemetry from telemetry collection, native installation, and separately approved project Azure activation.

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
- **AND** production plan/apply require a separately authorized operator on an allowed network

#### Scenario: Maintainer rolls back the Azure service
- **WHEN** a maintainer follows emergency disablement or rollback guidance
- **THEN** the documented OpenTofu procedure preserves `rg-liftoff-prod`

#### Scenario: Maintainer retires the legacy Function resources
- **WHEN** the Container App has passed live endpoint and data-boundary verification
- **THEN** the guidance requires a separate reviewed destructive plan and explicit approval before removing the Function App, FC1 plan, OneDeploy and package resources, product storage and association, approved-subscription rule, or regional OneDeploy rule
- **AND** the guidance requires preservation of `rg-liftoff-prod`, remote state, the state perimeter and operator rules, and accepted telemetry events

#### Scenario: Developer reads normal usage guidance
- **WHEN** a developer reviews the telemetry documentation
- **THEN** it explains that collection sends only bounded command events and never authenticates or deploys telemetry infrastructure on the developer's behalf
- **AND** explicitly approved project activation is documented as a separate scope, not a telemetry side effect

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
Guidance SHALL consistently publish applicable runtime, package-manager, framework, frozen-dependency, immutable-source, profile, native-resource, and refresh contracts from the release-owned baseline. It SHALL distinguish private CLI runtime/host requirements from selected external project tools and distinguish new-generation baselines from separately reviewed changes to existing projects.

#### Scenario: Developer checks prerequisites
- **WHEN** prerequisites are read for a supported workload
- **THEN** only its applicable external Node.js, npm, Python, Go, uv, OpenTofu, OpenSpec, and Spec Kit constraints are identified
- **AND** they agree with the release-owned baseline while bundled CLI runtime and platform floors are documented separately rather than treated as project readiness

#### Scenario: Developer installs Python dependencies
- **WHEN** Python setup is documented
- **THEN** it uses the platform-appropriate frozen uv flow rather than regenerating locks or installing open-ended ranges

#### Scenario: Existing project reviews a major baseline
- **WHEN** release guidance describes changed generated-stack compatibility
- **THEN** runtime floors and application compatibility changes are identified as separate project migration work
- **AND** ordinary upgrade, update, or force is not offered to replace production dependencies, containers, or infrastructure

### Requirement: Contributor guidance documents reproducible baseline refresh
Contributor guidance SHALL identify canonical version sources, stable/LTS selection, temporary materialization, explicit remaining asset/audit inventories, immutable provenance where applicable, and complete promotion checks. The retired Power Apps starter refresh and compatibility inventory SHALL NOT remain an active maintenance procedure.

#### Scenario: Maintainer refreshes dependencies
- **WHEN** a maintainer follows the refresh process
- **THEN** neither user projects nor mutable upstream state become the source of truth
- **AND** the resulting reviewed change includes affected baseline records, manifests, locks, digests, checksums, cases, and documentation

### Requirement: Documentation distinguishes CLI upgrade from core update
Maintenance guidance SHALL describe native `upgrade` as replacement through the actual CLI owner, `installation migrate` as the separate one-time ownership handover, and `update` as reviewed managed-project maintenance with only registered compatibility transitions. It SHALL distinguish `assess`, in-place `adopt`, registered `repair`, new-project `init`, and existing fresh-target/source-preserving `migrate`. Neither executable installation nor managed-core update SHALL be presented as upgrading project-owned application templates.

#### Scenario: Developer wants the newest CLI
- **WHEN** installation or maintenance guidance is read
- **THEN** it explains read-only upgrade check, authorization through the dedicated owner-preserving upgrade invocation, and exact owner-specific manual/recovery paths
- **AND** legacy npm users are directed to installation migration rather than an npm bridge
- **AND** changing installation owner requires its own separately reviewed approval

#### Scenario: Developer wants core template updates
- **WHEN** a project needs newer Liftoff control-plane files
- **THEN** guidance uses update check followed by exact approval and apply
- **AND** it explains that CLI installation itself did not migrate the project

#### Scenario: Developer wants project template changes
- **WHEN** a user needs new starter source, dependencies, containers, database assets, or infrastructure
- **THEN** guidance requires the appropriate reviewed adoption/repair/migration authority and concrete mappings rather than ordinary update or force

### Requirement: Documentation explains template ownership
Documentation SHALL retain managed-core, project, desired-state, framework, and seed lifecycles and explain that names, categories, prefixes, globs, and hashes do not grant ownership. Modification or deletion of generated templates, skills, or compatibility artifacts SHALL require exact registered-ID/destination-list lookup and the applicable approval. Guidance SHALL describe the narrow approved history/successor write set without making history, existing production files, or entire governance directories managed core. Generated, adopted, and repaired provenance and intentional project deletions/modifications SHALL remain protected.

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
- **AND** current versions and hashes are not written over historical receipts

### Requirement: Documentation explains self-upgrade safety and registry policy
Guidance SHALL identify supported native owners, read-only check behavior, authorization through the dedicated owner-preserving upgrade invocation, separate exact-plan approval for installation-owner migration, 0/1/2 exits, versioned JSON, native stable authority, exact owner-source availability, stale-manager/enterprise-source blockers, unsupported origins, lack of elevation, and truthful recovery. It SHALL distinguish historical npm registry policy from current native delivery and SHALL NOT recommend channel switching to bypass a blocker.

#### Scenario: Managed registry is stale
- **WHEN** a developer follows troubleshooting after a blocked upgrade
- **THEN** the guide directs synchronization or approval through the actual owner's configured source
- **AND** it does not instruct Liftoff to rewrite npm, Homebrew, or WinGet configuration or bypass enterprise delivery

#### Scenario: Installation needs elevated permission
- **WHEN** the effective installation owner lacks permission to replace its package
- **THEN** the guide explains that Liftoff does not invoke elevation
- **AND** it directs owner-specific remediation through the approved workstation process

#### Scenario: Post-install verification fails
- **WHEN** upgrade cannot verify the replacement
- **THEN** troubleshooting gives the exact owner-specific recovery procedure and actual partial state
- **AND** it does not claim automatic cross-owner rollback or blindly reinstall npm over a native launcher

### Requirement: Documentation covers the first self-upgrade-capable release
Guidance SHALL retain the historical explanation that releases before the npm self-upgrade command required a manual npm upgrade at that time. Current migration guidance SHALL explain that even self-upgrade-capable historical npm releases cannot discover native-only versions. All historical npm users SHALL receive a direct verified native handover journey without requiring another npm edition or a final bridge.

#### Scenario: User runs upgrade on an older release
- **WHEN** a user's installed Liftoff version predates the self-upgrade command
- **THEN** current guidance directs the user to verified native installation inspection/migration
- **AND** it neither implies the missing command can bootstrap itself nor requires a new npm release first

#### Scenario: A historical updater reports current
- **WHEN** npm upgrade reports its final historical release as current
- **THEN** the guide explains that native release availability is independent
- **AND** it provides the same one-time approved handover rather than repeating npm upgrade

### Requirement: Documentation explains the complete OpenSpec template contract
The system SHALL document all 12 required OpenSpec 1.11 workflows and the global `custom`/`both` profile with separately authorized configuration. It SHALL explain that delivery is native-surface-aware: Copilot and Claude receive supported skills and commands, while Codex uses the complete project-local skill inventory without deprecated custom prompts. Guidance SHALL distinguish new initialization, framework-owned maintenance, and reviewed additive-agent repair.

#### Scenario: New user reviews OpenSpec setup
- **WHEN** a developer reads getting-started, CLI, prerequisite, or workflow guidance
- **THEN** documentation lists or links the complete workflow set and its native agent surfaces
- **AND** it explains independent authorization when the global profile differs

#### Scenario: User evaluates the Copilot cloud-agent option
- **WHEN** OpenSpec and agent guidance is read
- **THEN** it identifies the default-off hosted Copilot choice, `.github/workflows/copilot-setup-steps.yml`, and `.github/agents/openspec.agent.md`
- **AND** it distinguishes that capability from Copilot, Claude, or Codex in a local terminal

#### Scenario: Existing project needs expanded workflows
- **WHEN** a developer maintains existing selected-agent framework workflows
- **THEN** guidance distinguishes authorized profile configuration and official `openspec update` maintenance from ordinary managed-core update
- **AND** adding another supported agent is directed to a reviewed integration repair rather than application reinitialization

#### Scenario: User reviews independent consent
- **WHEN** safety or automation guidance is read
- **THEN** project approval, overwrite authority, tool/dependency installation, global-profile configuration, and cloud opt-in are described as distinct scopes

#### Scenario: Codex user invokes a workflow
- **WHEN** Codex instructions describe OpenSpec or Spec Kit workflows
- **THEN** they use native project-local skills and actual Codex invocation conventions
- **AND** they do not require unsupported slash-command files or global prompt setup

### Requirement: Documentation explains repository-governance selection and activation
Guidance SHALL document governance selection, enabled default, opt-out, local artifacts, manifest state, post-init handoff, read-only discovery, approvals, selected-agent entry points, and actual execution/verification capabilities. It SHALL distinguish local, repository-only, activation, and lifecycle scope; generated policy SHALL NOT be called active governance. Required capabilities SHALL be claimed delivered only when qualified, while missing runtime permissions or inputs remain explicit blockers rather than evidence of completion.

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

#### Scenario: User selects repository-only enforcement
- **WHEN** a repository owner wants source checks and repository controls without Azure activation
- **THEN** the guide requires actual positive and controlled-negative source-check evidence, exact control approval, and readback
- **AND** it does not mark cloud or production phases complete or create a production release/tag

#### Scenario: Production qualification is deferred
- **WHEN** repository-only guidance describes an approved main-update hold
- **THEN** the hold is distinct from staging/production proof
- **AND** only later real qualification and a separately reviewed control plan can replace it

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
Guidance SHALL distinguish reviewed in-place `adopt` for existing supported FastAPI, Fastify, Go/Huma, Vue, and GenAI profiles from managed-core adoption in an already initialized project and from fresh-target `migrate`. It SHALL explain manifest-8 generated/adopted/repaired provenance, supported v2-v7 readers and exact migration eligibility, enabled defaults for absent governance configuration, exact unowned-collision protection, partial handoff, orphan-preserving opt-out, and the absence of automatic remote activation. Unsupported stacks and retired Power Apps SHALL NOT receive inferred executable conversion.

#### Scenario: Existing user previews adoption
- **WHEN** a supported pre-v8 Liftoff project reads maintenance guidance
- **THEN** it is directed to update check for its exact supported manifest/integration migration and managed-core differences
- **AND** historical generation versions and activation proof are not fabricated or implicitly migrated

#### Scenario: Existing governance file conflicts
- **WHEN** a generated policy or setup path collides with an unowned file
- **THEN** guidance requires review of that exact file, explains partial handoff and lack of ownership, and preserves the conflict
- **AND** does not recommend deletion, forced takeover, or remote action merely to make update pass

#### Scenario: An ordinary repository adopts Liftoff
- **WHEN** an existing application has no Liftoff manifest
- **THEN** guidance starts with whole-project assessment and then reviewed, explicitly mapped in-place adoption where its profile is supported
- **AND** it preserves business behavior, custom source, dependencies, and Git history rather than copying a starter over them

#### Scenario: The framework is unsupported
- **WHEN** assessment finds an unregistered framework or conversion
- **THEN** documentation promises read-only findings and explicit blockers
- **AND** it does not invent a framework conversion or use `migrate` as an in-place overwrite alias

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
Documentation SHALL present initialization followed by the native Liftoff setup operation as an approved end-to-end journey. It SHALL use the actual Copilot/Claude and Codex invocation forms, explain local-only operation and the local-ready milestone, and show how the same journey continues through migration when needed, approval, cloud/governance implementation, live verification, and tracked lifecycle work. It SHALL not advertise a complete activation path backed only by status scaffolding or placeholder producers.

#### Scenario: Developer finishes initialization
- **WHEN** supported-project completion output or README is read
- **THEN** it names the selected agent's actual setup entry point and applicable local checks

#### Scenario: Developer asks about model selection
- **WHEN** setup guidance discusses model selection
- **THEN** none is required and safety is attributed to deterministic phase/evidence contracts

#### Scenario: Developer inspects setup identity
- **WHEN** identities are documented
- **THEN** CLI, policy, activation contract, command schema, repair schema, and graph identities are distinguished without an independent setup-skill version
- **AND** the current successor identity remains distinct from historical v1/v2 proof and approvals

#### Scenario: Setup needs developer input
- **WHEN** authority questions are documented
- **THEN** exact project-repair approval and independent prerequisite permissions are distinguished from publication, credentials, billed infrastructure, enforcement, and destructive authority
- **AND** no manual approval-envelope or evidence fabrication is suggested

#### Scenario: Developer resumes setup
- **WHEN** a prior run stopped on a blocker
- **THEN** guidance explains supported repair, inspection, and the actual authorized local/activation/stateful/recovery operation
- **AND** unchanged failures are not retried indefinitely or disguised as success

#### Scenario: Developer reads setup command guidance
- **WHEN** generated setup aliases are discussed
- **THEN** native forms name the same sole logical setup operation and retired aliases appear only as reviewed removal debt

#### Scenario: Developer enters a credential
- **WHEN** separate activation requires credential enrollment
- **THEN** guidance identifies the implemented protected enrollment entry point, exact scope, and required usage/readback proof
- **AND** it never asks for credential values in chat, arguments, source, or public receipts

#### Scenario: Spec Kit user completes the local baseline
- **WHEN** Spec Kit setup is documented
- **THEN** its project-owned bootstrap bundle and finalization receipt remain distinct from official framework markers
- **AND** no OpenSpec archive or nonexistent Spec Kit archival command is suggested
- **AND** a missing historical bootstrap bundle is not silently manufactured by update or force

#### Scenario: Local setup is complete but activation is pending
- **WHEN** documentation shows successful local completion
- **THEN** it states that cloud resources and enforcement are not implied
- **AND** it shows the next approval/activation stage of the full journey rather than silently treating that stage as deferred implementation

#### Scenario: Developer completes the full journey
- **WHEN** documentation describes successful end-to-end setup
- **THEN** it requires actual deployment, qualification, and live enforcement readback
- **AND** future disposal or other lifecycle obligations remain explicitly visible

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
Guidance SHALL describe exact source compatibility, preview, approval, preserved history, successor, revalidation, and resume, distinguishing in-project history from external preview receipts. It SHALL preserve historical v1/v2/v3 identity meanings while explaining current activation-4 transitions and phase-scoped inputs. Pre-commit recovery SHALL remain distinct from committed-but-incomplete revalidation. Manual version/digest editing, historical approval reuse, automatic predecessor restoration, and resource recreation SHALL NOT be recommended. Missing execution versus missing operational prerequisites SHALL remain explicit.

#### Scenario: A user migrates known v1
- **WHEN** the migration walkthrough is followed
- **THEN** it explains readable preview, exact approval, preserved source bytes, the registered linked successor, and fresh proof
- **AND** it does not require a separate activation-migration command

#### Scenario: A check fails after local commit
- **WHEN** troubleshooting describes committed migration with failed revalidation
- **THEN** it identifies that actual successor version, the named blocker, fresh preview/approval, and supported remaining work
- **AND** it explains the migration's partial-outcome exit and retained progress without reset or retagging a historical v2 journal as v4

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

#### Scenario: Adding Azure inputs invalidates historical publication
- **WHEN** the affected schema-3 publication sequence is documented
- **THEN** recovery preserves original plans, approvals, and receipts and appends independently observed commit/remote revalidation through the supported reviewed transition
- **AND** it does not drop inputs, rewrite receipt hashes, or recommit/push solely to clear the mismatch

#### Scenario: Later source changes have not been published
- **WHEN** migration bookkeeping or workflow files change after the recorded publication
- **THEN** guidance distinguishes revalidated historical publication from publication of those new bytes
- **AND** any needed new Git publication requires its own reviewed operation

#### Scenario: Continuation retains Azure bindings
- **WHEN** a governance continuation uses a configuration file
- **THEN** the guide retains its exact normalized reference, digest, selected scope, working directory, and non-placeholder subscription/tenant binding where Azure is selected
- **AND** moving cwd or supplying later unrelated inputs cannot silently rebind the operation

### Requirement: Generated infrastructure guidance is environment-correct and authority-aware
Generated guidance SHALL use selected environments and their recorded infrastructure layout, describe independent new environment roots/state, and preserve the separate migration boundary for existing shared-state layouts. Governed examples SHALL distinguish reference commands from separately approved execution and actual verified effects. Required production executors SHALL be documented as delivered only when qualified, not deferred implementation hidden behind generated plan/apply examples.

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
- **WHEN** contributor guidance describes the coordinated modernization
- **THEN** it distinguishes completed qualified capabilities from actual missing access, selected inapplicability, and unrelated unsupported specializations
- **AND** it does not defer required production execution or equate module moves and rendered artifacts with completion

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
Contributor guidance SHALL identify the six capability engines, their public responsibilities and dependency direction, the shared execution kernel, versioned protocol, and retained domain/adapters boundaries. It SHALL explain extension without duplicated policy, approval, evidence, or recovery authority and SHALL NOT retain the old eight-group map as the current architecture or describe the kernel as a seventh engine.

#### Scenario: Contributor extends a supported workload
- **WHEN** a contributor follows the module map
- **THEN** Standards and Assessment, Project Generation, Project Evolution, Repository Governance, Azure Activation, and Distribution and CLI Upgrade ownership are discoverable
- **AND** existing update/repair behavior is reused rather than treating facades or skill scripts as parallel implementations

#### Scenario: Contributor changes an activation contract
- **WHEN** phase, evidence, approval, or serialization semantics change
- **THEN** the guide identifies the required independent version/hash updates and historical-compatibility consequences

#### Scenario: Contributor works on Windows
- **WHEN** paths and acceptance recipes are documented for contributors
- **THEN** they use platform-correct path construction and explicit shell conventions for Windows, macOS, and Linux
- **AND** distinguish portable logical artifact paths from native filesystem paths

### Requirement: Repair documentation describes actionable and bounded recovery
Guidance SHALL explain local and supported stateful repair, metadata versus sensitive-state inspection, exact read/write approvals, source/backend/resource-address scope, protected backups, locking, cutover verification, and checkpointed recovery. It SHALL distinguish unknown or unsupported cases from supported executable migrations and separate all of these from CLI upgrade, local core/identity migration, and ordinary framework maintenance.

#### Scenario: Developer encounters legacy infrastructure
- **WHEN** troubleshooting describes the legacy-layout blocker
- **THEN** it gives the actual repair preview and eligibility/discovery sequence
- **AND** it does not prescribe manual manifest/context edits or copying a fresh template tree over the project

#### Scenario: Developer follows a target-specific command
- **WHEN** repair commands are shown for a project outside the caller's directory
- **THEN** the project path and working directory remain explicit and correctly quoted for the supported platform
- **AND** a positional init project name is not advertised as an output-directory override

#### Scenario: Developer reviews stateful limitations
- **WHEN** a stateful migration is considered
- **THEN** guidance names the supported recipe and its actual safeguards or the specific unsupported prerequisite
- **AND** neither a blanket plan-only claim nor a promise to migrate arbitrary state is made

#### Scenario: A migration stops after an external write
- **WHEN** recovery is required
- **THEN** guidance explains the recorded checkpoint, current-state re-observation, and approved recovery path
- **AND** it does not claim local rollback restored every backend or recommend forced state overwrite

### Requirement: Tool guidance describes compatibility and actual repair outcomes
Documentation SHALL distinguish a compatible tool with an available update from a missing or incompatible required tool. Compatible official preview agents SHALL be documented as usable with notices, while tested runtime/framework constraints remain enforced. Installation guidance SHALL distinguish no-op installers, actual failures, channel/version issues, and observed PATH problems without promising unobserved writes or upgrades.

#### Scenario: Copilot updater leaves the observed version unchanged
- **WHEN** the executable still reports the same version after an update attempt
- **THEN** guidance uses the actual resulting compatibility observation
- **AND** it does not treat the attempted command as proof of a stable-channel switch

#### Scenario: Installer reports already installed
- **WHEN** the same unresolved requirement remains after a successful package-manager exit
- **THEN** troubleshooting explains no progress and a supported alternative or limitation
- **AND** it does not repeat a generic PATH/restart remedy without discovery evidence

#### Scenario: Codex is added to an existing project
- **WHEN** agent guidance describes adopting Codex
- **THEN** it covers additive selection, optional Spec Kit default, native skills, independent tool consent, and preservation of existing integrations
- **AND** it does not recommend application reinitialization

### Requirement: Activation guidance distinguishes implementation scope from runtime consent
Guidance SHALL state that the coordinated release implements the agreed qualified activation, repository-only, and supported stateful capabilities without making a setup request, planning-artifact approval, local repair approval, agent autopilot, or `--yes` blanket live authority. It SHALL explain default-No action review, exact automation approvals, cost/permission/credential boundaries, real external prerequisites, local/repository/full-activation completion, and future lifecycle obligations.

#### Scenario: A developer only wants local readiness
- **WHEN** local-only operation is selected or later approval is declined
- **THEN** guidance states that no new live activation is authorized
- **AND** local success is not presented as deployment or permission to erase earlier separately approved effects

#### Scenario: Existing activation metadata needs the successor
- **WHEN** a historical v1/v2/v3 project needs the current execution contract
- **THEN** guidance uses the exact reviewed identity-migration path and fresh verification
- **AND** it distinguishes that local transaction from OpenTofu-state migration or cloud provisioning

#### Scenario: Governance verification is consistent but incomplete
- **WHEN** `governance verify` reports a consistent yet incomplete selected scope
- **THEN** documentation explains exit 2, `consistent` versus `complete`, and `ok` as selected-scope success in governance output schema 3
- **AND** it distinguishes exit 0 for complete consistent scope from exit 1 for inconsistency or inspection failure

### Requirement: Native installation guidance documents the complete one-time handover
Installation and release guidance SHALL name the approved Homebrew tap/cask, explicit cask installation/upgrade form, exact WinGet identity, and Linux direct artifacts with their qualified architectures and host floors. It SHALL explain private runtime closure, no current npm edition/bridge, historical package retention, and owner-aware check/apply behavior. The handover SHALL document inspection of owner/prefix/PATH, verified unlinked payload, exact target identity and conflicts, default-No or exact-plan approval, ordered legacy-package retirement/native registration, explicit-path plus PATH verification, and truthful partial recovery. It SHALL never recommend removing Node/npm/project dependencies or running init over an existing project.

#### Scenario: Homebrew Node still has npm-owned Liftoff
- **WHEN** a user follows the macOS handover guide
- **THEN** it determines Liftoff ownership from the actual package and launcher records
- **AND** it does not equate a Homebrew prefix with ownership of the Liftoff package

#### Scenario: A launcher must be released before native registration
- **WHEN** the verified legacy npm launcher conflicts with the selected native owner
- **THEN** the guide verifies the unlinked candidate before approval and orders approved removal of only the identified legacy Liftoff package before conflicting native registration
- **AND** it does not use a force-link or overwrite flag against another owner's files

#### Scenario: Windows installation or PATH needs attention
- **WHEN** a WinGet portable installation has a shim conflict, spaced path, locked executable, or required terminal handover
- **THEN** guidance uses actual Windows executable/path conventions and explicit close or owner-specific recovery
- **AND** it does not kill unrelated processes, remove an active version, or silently install a direct copy

#### Scenario: An enterprise manager lags
- **WHEN** upstream native availability precedes the configured owner's approved source
- **THEN** guidance distinguishes manager lag, stale source knowledge, and required manual action
- **AND** it does not promise that a release download overrides enterprise policy

#### Scenario: Linux direct replacement fails
- **WHEN** a staged direct-install target cannot be verified
- **THEN** guidance preserves the current usable version and exact receipt-bound recovery
- **AND** cleanup is limited to verified owned inactive entries, not filename globs

### Requirement: Whole-project and host-assisted journeys remain unambiguous
Guidance SHALL explain read-only whole-project `assess`, reviewed in-place `adopt`, fresh-target `migrate`, managed `update`, recipe-bound `repair`, and new-project `init` as distinct operations. It SHALL identify the existing supported profile matrix and unsupported-stack assessment-only behavior. Model reasoning SHALL be described as proposals from the selected external agent host, not a bundled model, approval source, or proof that business behavior is preserved.

#### Scenario: Assess before initialization
- **WHEN** an ordinary repository is evaluated before any Liftoff manifest exists
- **THEN** guidance starts with bounded read-only inventory and explicit standards/profile targets
- **AND** it does not create metadata, run project code, or initialize the application just to obtain findings

#### Scenario: Adopt customized supported source
- **WHEN** a supported existing application needs Liftoff metadata or layout changes
- **THEN** guidance requires exact per-file mappings, byte/absence preconditions, declared additions, separate project-code/dependency/network authority, and staged verification
- **AND** business behavior and user-owned files are preserved rather than replaced by a starter

#### Scenario: A model proposes unsupported conversion
- **WHEN** an agent suggests an unregistered framework conversion or cannot prove an application mapping
- **THEN** guidance retains explicit findings and blockers for review
- **AND** model confidence, autopilot, piped answers, or a generic request is not execution approval

### Requirement: Canonical skill guidance preserves host and framework ownership
Documentation SHALL describe one Liftoff workflow library for supported Copilot, Claude Code, and Codex transports, capability negotiation, user-level delivery before initialization, and reviewed project-level migration. It SHALL distinguish Liftoff skills from OpenSpec/Spec Kit workflows, preserve the complete selected framework contract, and keep model selection external. Shared discovery roots and legacy `.github/prompts`, `.claude/commands`, and `.agents/skills` artifacts SHALL use exact registered identities and collision-aware migration rather than three indiscriminate copies or pattern deletion.

#### Scenario: Install skills without a project
- **WHEN** a user installs a supported personal host projection before initializing a repository
- **THEN** guidance names the actual host invocation and supported discovery location
- **AND** it does not require a Liftoff project or a bundled model client

#### Scenario: Copilot and Codex share discovery
- **WHEN** selected hosts share the qualified personal `.agents/skills` projection
- **THEN** guidance explains the single canonical projection and collision handling
- **AND** it does not instruct the user to duplicate conflicting workflows

#### Scenario: Existing integrations need migration
- **WHEN** a project contains legacy Liftoff prompts/commands/skills and user-authored framework integrations
- **THEN** guidance uses reviewed update, skill, or registered repair authority for exact owned IDs
- **AND** it preserves unrelated OpenSpec, Spec Kit, and user skills and names unsupported host transports as blockers

#### Scenario: A user requests an end-to-end setup workflow
- **WHEN** native setup, assessment, init, adoption, update, repair, migrate, governance assessment/execution, Azure, or upgrade assistance is documented
- **THEN** the host instructions route to the same deterministic capability/approval contracts
- **AND** neither the skills nor the CLI claim to sandbox unrelated tools the host can execute

### Requirement: Current and historical contract identities remain explicit
Current guidance SHALL distinguish manifest writer 8, governance policy 8, credential-policy schema 2, activation/state/evidence/approval 4, phase graph schema 3, activation compatibility metadata 5, governance output schema 3, and independent schema-1 public/native/adoption/installation records. It SHALL retain repair contract 1 and registered existing repair/recovery formats where unchanged, without inventing a setup-skill version or retagging history. Schema-1 credential policies and the pre-amendment policy-7 candidate SHALL be documented as original identities requiring exact reviewed transition and fresh credential approval, not as aliases for current permission authority. Actual release SemVer and graph hash SHALL be read from qualified release identity rather than fabricated in examples.

#### Scenario: Inspect the current contract table
- **WHEN** a user or contributor reads identity guidance
- **THEN** each named axis, current writer, historical reader, migration lane, and required fresh proof is distinct
- **AND** a newer CLI version alone is not described as changing project contracts

#### Scenario: A historical journal uses older semantics
- **WHEN** an example diagnoses an old activation or repair record
- **THEN** it retains that record's actual serializer, hash meaning, and approval identity
- **AND** numeric ordering or blanket compatibility with every lower version is not promised

#### Scenario: A user reviews runner credential permissions
- **WHEN** documentation explains the current provider grant
- **THEN** it names `organization_administration:read` and its broader organization, billing and Actions-settings read reach without claiming hosted-runners-only access
- **AND** it distinguishes that grant from the exact approved Liftoff operations and states that PAT identity/lifetime, protected enrollment, secret ownership and live qualification remain independent gates

### Requirement: Every tracked and active generated README is inventoried and refreshed
Documentation release work SHALL inventory every tracked project-owned README and every active README-producing surface, including root, telemetry, bootstrap infrastructure, state migration, generated application/infrastructure/functions/prompts, and governance guidance. Each generated entry SHALL identify its exact canonical source, supported profile variants, registered output identity, and local-link dependencies. The coordinated release SHALL refresh the complete inventory and directly inconsistent linked guides, not only the root README. Modification or retirement SHALL use exact tracked paths and registered output-ID lists rather than prefix/glob ownership.

#### Scenario: Inventory reveals a nested operator README
- **WHEN** a tracked telemetry, bootstrap, or state-migration README is found outside the root guide
- **THEN** it is included in the release documentation inventory with its actual role and linked dependencies
- **AND** it is not skipped merely because it is not part of onboarding

#### Scenario: A renderer still emits old installation guidance
- **WHEN** an active generated application, infrastructure, function, prompt, or governance README source emits current npm installation or outdated activation guidance
- **THEN** its canonical source and applicable output cases must be updated before release
- **AND** editing one generated sample without correcting the source does not satisfy the requirement

#### Scenario: Historical instructions are retained
- **WHEN** a guide keeps old npm publication or old-contract recovery examples for historical support
- **THEN** they are clearly scoped to the exact historical release/operation
- **AND** they cannot be mistaken for current native onboarding or current execution authority

#### Scenario: A similarly named file is not owned
- **WHEN** an inventory migration encounters an unregistered user README or prompt with a familiar prefix
- **THEN** it preserves that file
- **AND** generated-document retirement requires exact registered lookup and the applicable ownership approval

#### Scenario: Qualify generated and packaged documentation
- **WHEN** documentation qualification renders the explicit active inventory and inspects native bundles on Windows, macOS, and Linux
- **THEN** required README variants, linked local assets, command examples, literal paths, and qualified capability statements agree
- **AND** missing inventory coverage or a broken local target blocks the coordinated release

### Requirement: Release and branch guidance states the real qualification boundary
Contributor and release guidance SHALL describe one coordinated native release with same-commit/final-artifact/platform evidence, separate CLI and telemetry lines/branches/functions/statements strictly above 80 percent, actual covered/total decisions, and separately disclosed native-helper coverage/qualification. It SHALL identify manager publication lag, signing/access blockers, required real production qualification, and Windows execution evidence without claiming that configured CI or Linux-only success is enough. Branch guidance SHALL identify only main/develop as permanent while preserving active temporary PR branches and work.

#### Scenario: A coverage report displays eighty percent
- **WHEN** coverage guidance explains the threshold
- **THEN** it shows that exact equality fails for either package and that actual numerator/denominator values decide
- **AND** it prohibits combining packages or excluding unimported production code to inflate the result

#### Scenario: Native helper or live evidence has not run
- **WHEN** release notes describe qualification from portable tests alone
- **THEN** missing native/helper/live evidence remains explicit and blocks required completion
- **AND** the notes do not describe mocks, static payloads, or configured runners as actual execution

#### Scenario: Maintain two permanent branches
- **WHEN** contributor guidance explains branch cleanup
- **THEN** it preserves active feature, repair, release, and Dependabot PR branches
- **AND** deletion requires an explicit fresh inventory, owner release, preservation of dirty/checked-out/unmerged work, and approval rather than a literal two-ref target

### Requirement: Existing-project defect guidance separates configuration from live compliance
Guidance for the Azure baseline and API-documentation corrections SHALL distinguish new generation from reviewed remediation of existing project-owned files. It SHALL document the registered `azure-baseline-settings` recipe for exact supported HCL edits and staged validation, and explicit supported application mappings for routing corrections. It SHALL NOT route infrastructure through `application-layout-patch`, promise arbitrary framework edits, or treat a changed file as deployed compliance.

#### Scenario: An existing Azure project needs baseline settings
- **WHEN** remediation guidance covers Redis/Service Bus or storage settings
- **THEN** it identifies `minimum_tls_version = "1.2"`, storage `min_tls_version = "TLS1_2"`, and account-wide `allow_nested_items_to_be_public = false` where applicable
- **AND** customized or ambiguous expressions need explicit mapping/review, while live plan/apply/readback require separate Azure authority

#### Scenario: An existing API has a prefix-routing defect
- **WHEN** guidance covers Scalar and OpenAPI schema routing for Go, Node, Python, or supported GenAI variants
- **THEN** it uses explicit supported application repair and checks actual schema paths/components, content type, relative redirects, query preservation, and direct/prefix-stripping proxy behavior
- **AND** it does not prescribe a frontend-root schema workaround or imply ordinary update rewrites the handler

### Requirement: Executable examples preserve target scope and approval
Command examples and continuations SHALL retain the actual executable/argument form, exact project or installation target, working directory, selected scope, normalized configuration reference, required approval, and compatibility identity. Windows, macOS, and Linux examples SHALL use native paths and shell-literal quoting, not JSON escaping presented as shell safety. Credentials SHALL remain opaque references rather than values in commands, reports, or chat.

#### Scenario: Run a continuation from another directory
- **WHEN** a documented continuation was produced for a relative configuration path and the user changes cwd
- **THEN** the example still binds the original normalized configuration and target
- **AND** a changed configuration requires renewed planning rather than silently selecting different inputs

#### Scenario: A Windows target contains spaces
- **WHEN** an executable, project, or installation path contains spaces on Windows
- **THEN** the documented invocation and display preserve native argument and shim boundaries
- **AND** equivalent macOS/Linux examples retain literal path handling without assuming a POSIX layout on Windows

#### Scenario: A later action needs broader authority
- **WHEN** a workflow continues from local repair to Git publication, credentials, repository controls, billed infrastructure, or state operations
- **THEN** the guide identifies the new action-specific approval and independently verified result
- **AND** earlier setup or model-host permission is not reused as blanket authority

### Requirement: Telemetry monitoring guidance identifies the Grafana access and meaning
Operator guidance SHALL explain how to locate the owned dashboard through Azure Monitor dashboards with Grafana, select the configured telemetry workspace/table and use its time/command/version filters. It SHALL document current-user Azure access, separate data permissions, existing retention and query costs, manual-refresh defaults, data-quality limits and exact approved deployment/rollback scope. Examples SHALL use configured resource outputs rather than public hard-coded operational GUIDs or credentials.

#### Scenario: A maintainer wants to monitor usage
- **WHEN** the operator follows the telemetry monitoring guide
- **THEN** it identifies the actual dashboard/resource output and `LiftoffCommandEvents_CL` data source
- **AND** it explains recorded command events, version distribution, nonzero exits and event recency without unique-user or crash-rate claims

#### Scenario: The dashboard opens without data access
- **WHEN** a viewer can see the dashboard but cannot query Log Analytics
- **THEN** guidance identifies the independent required data permission and owner-controlled access path
- **AND** it does not prescribe a shared secret, anonymous access or blanket subscription role

#### Scenario: There are no recent events
- **WHEN** a selected period has no matching records
- **THEN** guidance explains filter/time range, opt-outs, excluded/CI/offline runs and best-effort delivery
- **AND** it does not infer that no people use Liftoff or that the service is down

#### Scenario: An operator wants alerts or a dedicated Grafana site
- **WHEN** requested monitoring exceeds the selected built-in host
- **THEN** guidance identifies the unsupported feature and need for a separately revised scope
- **AND** it does not silently provision a billed Managed Grafana workspace or substitute Workbooks

### Requirement: Ruleset compatibility guidance preserves meaningful review requirements
Guidance for #82 SHALL explain supported pull-request defaults and meaningful reviewer/dismissal restrictions, including that the extra-approval flag has no effect when zero approvals are required. It SHALL distinguish response compatibility from a real policy violation and retain fail-closed treatment of malformed/unknown enforcement.

#### Scenario: A supported default caused an old unsupported-response error
- **WHEN** a user encounters the known three-field compatibility issue
- **THEN** guidance identifies the supported normalization/assessment correction
- **AND** it does not ask the user to delete returned fields, disable strict validation or change review controls just to make the decoder succeed

#### Scenario: A meaningful restriction differs from policy
- **WHEN** a supported nonempty reviewer or actor constraint changes effective enforcement
- **THEN** guidance reports the actual difference and separately reviewed reconciliation path
- **AND** a zero top-level count is not offered as proof that all review requirements are absent

### Requirement: Repair documentation separates capability authority and identity
Packaged user and developer documentation SHALL explain native repair-skill access on every supported selected-agent surface, installation/update ownership, the intentionally changed interactive bare repair preview/default-No approval journey, non-executing check and bare JSON/non-TTY modes, explicit bounded preparation-preview tool probes, live metadata, independent preparation/code/lifecycle/network/file authority, registered cleanup/recovery and local resume. Ordinary instructions SHALL NOT require manual fingerprint entry; exact fingerprint flags and `--allow-dependency-preparation` with `--verify-plan` SHALL remain documented as optional equivalent automation interfaces. Cancellation guidance SHALL distinguish no effects yet from earlier separately authorized preparation/verifier/host effects. It SHALL distinguish the real Azure recipe from reviewed application patches and unsupported arbitrary/stateful migrations. It SHALL document independent repair contract, repair/preparation recipe and layout identity, document schema, CLI and managed-hash version/bump rules without inventing activation or skill versions.

#### Scenario: A terminal developer needs broader application repair
- **WHEN** the developer follows repair help/reference
- **THEN** they can discover capabilities, inventory the actual project, open the applicable native skill, stage an exact patch, review/verify/approve it through clear action-specific prompts without hash copying and resume local work
- **AND** documentation gives implemented commands and explicitly excludes blind template replacement or retrospective approval

#### Scenario: A developer reviews an application folder mapping
- **WHEN** the example relocates customized source to a supported current target
- **THEN** it includes source/destination bindings, imports, tests/build, Docker/Compose, scripts, CI/docs, rollback/history and unresolved-reference handling
- **AND** it does not claim arbitrary folders or runtime behavior are automatically proven

#### Scenario: A contributor changes repair behavior
- **WHEN** eligibility, approval, validation, completion or recovery guarantees change
- **THEN** the guide requires a repair-contract review/bump and explicit compatibility
- **AND** changed transformations require recipe version review, incompatible documents require their own schema bump, and wording-only skills use managed hashes

#### Scenario: Native qualification has not run
- **WHEN** verification is reported from a non-Windows development environment
- **THEN** evidence distinguishes portable tests and configured Windows CI from a native Windows run
- **AND** unrun live/cloud/native checks are not claimed as successful

#### Scenario: A developer reviews preparation support
- **WHEN** the guide describes a supported npm, uv or Go provider
- **THEN** it identifies exact manifest/lock inputs, installed tool requirements, package-source and lifecycle restrictions, private effects, permissions, cleanup and failure remedies
- **AND** it does not promise generic installation, inherited credentials, original/global writes, lock upgrades or tests the project never declared

#### Scenario: Framework qualification is reported
- **WHEN** Node/backend, optional frontend, Python or Go results are described
- **THEN** the guide distinguishes actual preparation/build/declared-test evidence from dependency-free checks, injected tests and unavailable toolchains
- **AND** a frontend build is not represented as nonexistent frontend or UI/runtime test coverage

#### Scenario: Developer reviews Windows host prerequisites
- **WHEN** documentation explains Windows preparation or verification
- **THEN** it documents stock Windows PowerShell 5.1 / .NET hosting, client-default Restricted execution policy and AppLocker/WDAC constraints as explicit causal admission blockers
- **AND** it explains standard policy remedies without suggesting ExecutionPolicy bypasses or unapproved native binary downloads
