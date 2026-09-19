## Purpose

Define Liftoff's repository-governance profile: selection, the managed-core single-maintainer GitFlow policy and generated context, per-agent activation handoff, workload adaptation, deferred read-only Phase 0 discovery, explicit approval boundary, activation baseline for existing repositories, and the distinction between generated policy and live GitHub enforcement.

## Requirements

### Requirement: Repository governance is a selectable project profile
The system SHALL expose repository governance as an append-only catalog selection with `single-maintainer-gitflow` and `none` values. Interactive initialization SHALL offer the single-maintainer GitFlow profile and default it to enabled. Noninteractive planning and initialization SHALL accept an explicit governance profile and SHALL use `single-maintainer-gitflow` when the option and configuration field are absent.

#### Scenario: Accept the interactive default
- **WHEN** a developer runs interactive `liftoff init` and accepts the repository-governance default
- **THEN** the resolved project plan selects `single-maintainer-gitflow`
- **AND** the plan states that local handoff artifacts will be generated

#### Scenario: Opt out interactively
- **WHEN** a developer disables repository governance during initialization
- **THEN** the resolved plan records `none`
- **AND** no repository-governance policy, context, guide, or setup integration is rendered

#### Scenario: Select noninteractively
- **WHEN** a developer supplies `--governance single-maintainer-gitflow` or `--governance none`
- **THEN** Liftoff validates the value through the governance profile catalog without prompting

#### Scenario: Reject an unknown profile
- **WHEN** a flag or configuration file names an unsupported governance profile
- **THEN** Liftoff exits 1 before workstation probes or destination writes
- **AND** identifies the accepted profile values

### Requirement: The selected profile generates one canonical managed-core handoff
The system SHALL render one canonical versioned policy, schema-versioned workload context, activation guide, and thin selected-agent setup, assessment and repair integrations as explicitly named managed-core artifacts. Policy and context SHALL remain under their registered `.liftoff/governance` namespace. Existing Copilot, Claude and Codex integration identities and native paths SHALL remain compatible until an explicitly reviewed migration changes their transport. Integrations SHALL consume the canonical skill/policy contracts and public CLI rather than duplicate policy or execution logic. The logical setup operation SHALL remain one entry point per host, with separate assessment and repair operations.

#### Scenario: Generate for Copilot and Claude
- **WHEN** a project selects the single-maintainer profile, Copilot, and Claude
- **THEN** it contains the canonical handoff and required setup, assessment, and repair integrations for each selected agent
- **AND** each file has a stable logical name and manifest content hash

#### Scenario: Generate for one agent
- **WHEN** only GitHub Copilot is selected
- **THEN** Liftoff renders only its selected-agent handoff integrations
- **AND** Claude or Codex launchers are not required

#### Scenario: Render paths cross-platform
- **WHEN** the same governed plan is rendered on Windows, macOS, and Linux
- **THEN** every governance artifact has identical bytes, logical names, and OS-neutral path parts
- **AND** filesystem access uses native path resolution

#### Scenario: Framework owns neighboring files
- **WHEN** official framework output exists under `.github`, `.claude`, `.agents`, or applicable project-local `.codex` paths
- **THEN** Liftoff owns only its explicitly named governance integrations
- **AND** directory patterns do not select neighboring files for replacement or deletion

#### Scenario: Generate for Codex
- **WHEN** Codex is selected with the profile
- **THEN** it receives native setup, assessment, and repair integrations with distinct Codex identities
- **AND** they use the same policy, approval, scope, and repair contracts as other selected hosts, with managed hashes and negotiated capabilities rather than independent skill SemVer

### Requirement: Governance context is deterministic and workload-aware
The generated context SHALL identify the selected supported workload, artifact
form, approved runtime and dependency baseline, real generated build and test
commands, environments, generated deployment boundaries, known health and
readiness endpoints, selected spec framework, and selected coding agents. It
SHALL distinguish known generated facts from facts that require live discovery,
describe only capabilities that the generated starter actually provides, and
record missing specialization or production activation behavior as unavailable
rather than implied. It SHALL contain no credential, token, webhook, tenant
secret, or fabricated external capability, and it SHALL NOT reinterpret a
retired Power Apps boundary as a supported or generic workload context.

#### Scenario: Generate API context
- **WHEN** a supported API project selects the governance profile
- **THEN** context identifies its selected backend, optional frontend, container, OpenTofu, environment, health, and test boundaries that actually exist
- **AND** marks live GitHub, runner, monitoring, traffic, deployment, and alert-routing facts for Phase 0 discovery

#### Scenario: Generate GenAI context honestly
- **WHEN** a supported GenAI project selects the governance profile
- **THEN** context identifies only the generated retrieval, worker, messaging, streaming, and deployment boundaries that actually exist in that starter
- **AND** it labels absent specialization, production activation, or runtime features as unavailable rather than implemented

#### Scenario: Generate Power Apps context
- **WHEN** a former Power Apps plan requests governance context
- **THEN** it receives an unsupported-workload error rather than generated context or implied generic-workload compatibility

#### Scenario: Retired Power Apps boundary is encountered
- **WHEN** governance context generation encounters a retired `power-apps-code-app` boundary
- **THEN** Liftoff reports the workload as unsupported
- **AND** it does not render a governed context by treating the project as generic React, GenAI, or standard API

#### Scenario: Render without secrets
- **WHEN** a profile context is generated from any valid project plan
- **THEN** it contains no collected GitHub token, Slack webhook, cloud credential, tenant binding, or environment secret

### Requirement: Initialization and update remain local-only
`liftoff init`, `liftoff plan`, and `liftoff update` SHALL NOT create or modify Git branches, commits, tags, remotes, pull requests, releases, repository settings, rulesets, GitHub environments, Actions runners, security features, cloud resources, Slack routes, or deployment infrastructure as part of repository-governance profile handling. They SHALL NOT require `gh`, a GitHub remote, GitHub Advanced Security, a self-hosted runner, Slack, or deployment credentials to render the local handoff.

#### Scenario: Initialize before Git exists
- **WHEN** Liftoff creates a named child project with the default governance profile and no Git repository or remote
- **THEN** initialization can complete with the local handoff
- **AND** the guide explains that activation starts only after commit and push

#### Scenario: Initialize an existing Git root
- **WHEN** Liftoff initializes at an exact existing Git root
- **THEN** it uses Git only for existing target discovery and safety behavior
- **AND** performs no remote governance mutation

#### Scenario: Accept all local defaults
- **WHEN** a developer uses `--yes` with the governance profile
- **THEN** the flag accepts local planning defaults only
- **AND** does not authorize an agent run or any GitHub, deployment, or ruleset action

### Requirement: Agent activation begins with read-only Phase 0
Setup SHALL require verified local/publication prerequisites, read the canonical policy/context and perform the selected scope's read-only classification before proposing remote changes. Repository classification SHALL observe artifact type, languages, package managers, working build/test commands, repository identity, refs, controls, source workflows, exact check contexts and applicable GitHub capabilities without Azure credentials. Full activation SHALL additionally inspect actual applicable environment, artifact, deployment, provider, security-scanning, monitoring/alert routing, health, runner and state-path prerequisites with explicit public bindings and authorized access.

When private Staging DAST applies, its discovery SHALL cover the selected subscription, runner/network resources, permissions, network-configuration policy, address space, DNS/routing, egress, costs, state ownership and teardown authority. Findings SHALL distinguish gaps, inapplicable controls and unproven applicability, report an ordered plan, and stop before unapproved effects. Assessment remains independently available before publication and SHALL NOT satisfy execution discovery or approval merely by producing a report.

#### Scenario: Run before a remote exists
- **WHEN** an agent is asked to activate governance without a resolvable GitHub repository
- **THEN** it reports the missing prerequisite and performs no mutation

#### Scenario: Complete Phase 0
- **WHEN** required local and authorized remote observations for the selected discovery scope are available
- **THEN** it reports every required classification and named gap with evidence
- **AND** identifies controls that are unavailable or meaningless for the workload
- **AND** stops before writing files or changing GitHub or Azure

#### Scenario: User has not approved the plan
- **WHEN** Phase 0 has reported its findings but the user has not explicitly approved the proposed work
- **THEN** the agent does not create a spec change, branch, workflow, ruleset, environment, cloud resource, network configuration, runner group, or larger runner

#### Scenario: Assess before publication
- **WHEN** a developer requests only a governance assessment on an unpublished Liftoff project
- **THEN** assessment may report local differences and unobserved live controls
- **AND** it does not create a remote, push the repository, or advance Phase 0

#### Scenario: Repository-only adoption precedes Azure
- **WHEN** repository scope is explicitly selected with no Azure configuration
- **THEN** its required GitHub discovery can proceed
- **AND** Azure input, credential, runner or production qualification is not requested as a prerequisite

### Requirement: Azure resource providers are ready before dependent provisioning
The canonical profile SHALL derive the minimal Azure resource-provider
namespace set from the approved resource plan and inspect the configured
AzureRM registration mode. When automatic registration is disabled or cannot
cover the plan, every missing namespace MUST be registered explicitly and read
back as `Registered` before any dependent or billable resource is created.

#### Scenario: Automatic registration is available
- **WHEN** the approved AzureRM configuration enables automatic registration with sufficient subscription permission for every planned namespace
- **THEN** the plan records that mode and does not add duplicate explicit registration resources

#### Scenario: Automatic registration is disabled
- **WHEN** the approved AzureRM configuration disables automatic resource-provider registration
- **THEN** the plan declares explicit registration for every missing namespace required by its resource types
- **AND** it does not register unrelated providers speculatively

#### Scenario: Hosted-runner network is planned
- **WHEN** the approved plan includes Azure VNet-injected GitHub-hosted runner networking
- **THEN** the required namespace inventory includes at least `Microsoft.Network` and `GitHub.Network`
- **AND** it includes any additional namespace used by the approved state, identity, monitoring, or application resources

#### Scenario: Provider registration is already complete
- **WHEN** live subscription readback reports a required namespace as `Registered`
- **THEN** registration is a no-op and dependent resources may reference the verified capability

#### Scenario: Provider registration is not ready
- **WHEN** a required namespace is absent, unauthorized, registering, unregistering, or failed
- **THEN** dependent and billable resource creation remains blocked
- **AND** the state is reported without treating an empty resource group or partial apply as readiness

#### Scenario: Explicit registration completes
- **WHEN** an explicitly managed provider registration reaches terminal `Registered` state
- **THEN** every resource using that namespace is ordered after the registration evidence

#### Scenario: Repository infrastructure is removed
- **WHEN** the approved repository teardown deletes its network or application resources
- **THEN** successful provider registrations remain registered as subscription capabilities
- **AND** teardown does not unregister a namespace that may be shared by other resources

### Requirement: Azure subscription features and service tags match intended capabilities
The canonical profile SHALL treat subscription features and network service
tags as explicit platform contracts. A feature MUST be registered only when the
approved resource design intentionally uses it. Every service-tag rule MUST use
an action and direction supported by that tag.

#### Scenario: Unrelated feature registration is requested
- **WHEN** an ordinary resource returns `SubscriptionNotRegisteredForFeature` for a capability the approved design does not use
- **THEN** the plan remains blocked and corrects the resource properties, provider behavior, or API shape
- **AND** it does not register the unrelated feature as a retry shortcut

#### Scenario: Ordinary Standard public IP requires BYOIP
- **WHEN** a Firewall or NAT Standard public IP unexpectedly requests `Microsoft.Network/AllowBringYourOwnPublicIpAddress` without a custom IP prefix
- **THEN** the plan removes accidental BYOIP-triggering properties or uses a supported API shape that does not request BYOIP
- **AND** the feature remains unregistered

#### Scenario: Azure platform DNS is used
- **WHEN** an NSG plan references the `AzurePlatformDNS` service tag
- **THEN** it uses the tag only for an intentional Deny that disables default platform DNS
- **AND** it does not create an Allow rule for that tag

#### Scenario: Custom DNS is required
- **WHEN** the approved topology replaces Azure platform DNS with custom resolvers
- **THEN** NSG rules allow TCP and UDP port 53 to the exact resolver addresses
- **AND** DNS reachability is verified before dependent provisioning

### Requirement: The single-maintainer profile preserves its fixed governance invariants
The canonical policy SHALL retain repository-scoped Vincent Driessen GitFlow for versioned-release repositories, `main` and `develop` as permanent branches, temporary feature/release/hotfix/automation branches, zero required human merge/deployment reviewers, PR-only protected-branch changes, automated fail-closed checks, no CODEOWNERS and no branch bypasses. Supported automation SHALL use the approved built-in token or scoped identity without bypassing protected-branch checks. Version tags SHALL have restricted creation and immutable update/deletion rules. Independent Liftoff scope/cost/enforcement approval SHALL NOT become a GitHub required human reviewer.

Conditional provisioning of the repository-dedicated VNet-injected GitHub-hosted larger runner for private Staging DAST SHALL remain the only declared org/enterprise provisioning exception. Genuine continuous-delivery or platform deviations SHALL require explicit approved adaptation, not silent misrepresentation.

#### Scenario: Configure pull-request governance
- **WHEN** an approved governance change defines protected-branch pull-request rules
- **THEN** it sets approving review count to zero and disables code-owner and last-push approval requirements
- **AND** does not create a human approval gate
- **AND** branch changes still require PRs and successful applicable checks without bypass actors

#### Scenario: Repository scope cannot enforce a control
- **WHEN** a required control other than the approved VNet-injected runner provisioning exception is unavailable at repository scope
- **THEN** the limitation is reported and required unsupported enforcement remains a blocker for its applicable scope
- **AND** it does not propose an org-level ruleset, required workflow, GitHub App installation, or other org-level substitute

#### Scenario: Repository ships continuously
- **WHEN** Phase 0 proves the repository genuinely uses continuous delivery rather than versioned releases
- **THEN** the agent explains where original GitFlow does not fit
- **AND** it obtains approval for the explicit branch and release adaptation before implementation

#### Scenario: VNet runner prerequisite is unavailable
- **WHEN** private Staging qualification requires DAST and no suitable VNet-injected larger runner is assigned
- **THEN** the agent keeps release qualification blocked and reports whether the narrowly scoped runner stack can be provisioned
- **AND** it does not create a self-hosted runner or generalize the exception to any other org-level control

#### Scenario: Automation needs to update a protected branch
- **WHEN** an approved automated operation prepares a merge or back-merge
- **THEN** it uses the permitted PR/check path
- **AND** it does not add a branch bypass to make the operation succeed

### Requirement: Security and release policy adapts without duplicate or theatrical controls
The canonical profile SHALL map applicable security stages to the events where
they can run and SHALL use the designated tools: GitHub Secret Protection,
Dependabot and Dependency Review, CodeQL and Copilot Autofix, Checkov, Trivy,
non-gating Grype, OWASP ZAP, GitHub artifact attestations and SLSA provenance,
and OSSF Scorecard. It SHALL omit inapplicable stages, fail when a required input
or runner is absent, prohibit duplicate excluded scanners, and never make Grype
a second blocking gate. Release-candidate SLSA L3 generation SHALL remain
enabled despite mutable internal references in the official generator; the
outer reference SHALL be pinned as tightly as supported and the single named
exception SHALL be narrow, expiring, and accepted only by the action-pinning
check.

#### Scenario: Container workload has private staging access
- **WHEN** an approved API governance design has a deployable container and an assigned GitHub-hosted larger runner group with Azure VNet injection into Staging
- **THEN** its release or hotfix qualification can include digest-bound Trivy, SBOM, provenance, staging deployment, ZAP, and non-gating Grype evidence

#### Scenario: Private staging runner is absent
- **WHEN** DAST requires private staging access but the assigned VNet-injected larger runner and exact labels cannot be verified
- **THEN** Phase 0 reports release qualification as blocked and may propose the dedicated runner provisioning exception when all prerequisites can be satisfied
- **AND** no required check hangs, skips, substitutes a self-hosted runner, or reports synthetic success

#### Scenario: Workload has no container
- **WHEN** the workload does not build or deploy a container image
- **THEN** container scanning, image SBOM, and digest promotion are explicitly marked inapplicable
- **AND** no empty-loop or placeholder check is generated

#### Scenario: Licensed capability is unavailable
- **WHEN** GitHub Secret Protection, CodeQL, or Copilot Autofix is not licensed or enabled for the repository
- **THEN** Phase 0 reports the missing capability
- **AND** the profile does not silently replace it with a duplicate excluded scanner

#### Scenario: SLSA generator contains mutable internal references
- **WHEN** the action-pinning gate evaluates the approved official SLSA L3 reusable workflow
- **THEN** it accepts only the explicitly named, unexpired generator exception
- **AND** every other unpinned action reference continues to fail

### Requirement: Private Staging runner provisioning is conditional and repository-dedicated
When private Staging DAST applies and no suitable runner assignment exists, the
canonical profile SHALL permit an approved governance change to provision the
required Azure and GitHub hosted-compute resources. Azure networking, explicit
egress, state, cost, and teardown ownership MUST remain within the target
repository's Staging subscription. The design MUST NOT depend on a firewall,
hub, route, billing boundary, or lifecycle owned by another repository or
subscription.

#### Scenario: Private Staging DAST does not apply
- **WHEN** repository classification proves that private Staging DAST is inapplicable
- **THEN** no runner networking, hosted-compute configuration, runner group, or larger runner is proposed or provisioned

#### Scenario: Suitable assignment already exists
- **WHEN** Phase 0 verifies an assigned larger runner with the required VNet reachability and labels
- **THEN** the activation consumes that assignment and does not create a duplicate stack

#### Scenario: Provisioning prerequisites are unavailable
- **WHEN** required Azure roles, GitHub organization permissions, enterprise policy, subscription ownership, region support, state ownership, address space, or billing authority cannot be verified
- **THEN** provisioning and release qualification remain blocked without partial mutation

#### Scenario: Repository-dedicated ownership is approved
- **WHEN** the user approves runner provisioning after reviewing topology, cost, limits, names, state, and teardown responsibility
- **THEN** every Azure runner-network resource is created in that repository's Staging subscription
- **AND** every GitHub organization resource is restricted to the target repository and required workflows

### Requirement: Runner networking uses one explicit outbound mode
The runner subnet SHALL disable implicit default outbound access and use exactly
one approved outbound mode. Azure Firewall Basic SHALL be used only when Phase 0
records a requirement for strict domain-restricted egress. Otherwise Azure NAT
Gateway SHALL provide explicit outbound connectivity with controlled HTTPS
egress. A NAT Gateway MUST NOT be attached to a runner subnet whose default
route uses Azure Firewall.

#### Scenario: Strict domain-restricted egress is required
- **WHEN** an applicable organization or repository network policy requires outbound destination filtering by domain
- **THEN** the approved plan provisions Azure Firewall Basic and permits the current required GitHub Actions domains without TLS interception or a static GitHub IP allowlist

#### Scenario: Strict domain-restricted egress is not required
- **WHEN** Phase 0 finds no applicable requirement for domain-restricted egress
- **THEN** the approved plan provisions Azure NAT Gateway and an outbound policy that permits the required HTTPS traffic
- **AND** it does not claim that an NSG or NAT Gateway restricts traffic to GitHub domains

#### Scenario: Conflicting outbound modes are proposed
- **WHEN** a plan attaches NAT Gateway while routing the same runner subnet through Azure Firewall
- **THEN** validation fails before provisioning because NAT Gateway would bypass the firewall path

### Requirement: Runner networking proves isolation and private Staging reachability
The runner subnet SHALL deny unsolicited inbound connectivity, use
non-overlapping address space, and resolve and route to the real private Staging
target within the repository's subscription. The runner prerequisite SHALL
remain unsatisfied until Azure configuration, GitHub assignment, required
labels, outbound connectivity, private DNS, and live Staging reachability are
read back and verified.

#### Scenario: Runner subnet is created
- **WHEN** the approved Azure plan creates the delegated runner subnet
- **THEN** the subnet denies inbound connections and contains no pre-existing network interfaces
- **AND** its address space does not overlap the Staging network

#### Scenario: Private Staging path is incomplete
- **WHEN** peering or routing, private DNS, security rules, or target reachability is missing
- **THEN** the runner prerequisite remains failed and DAST is not scheduled

#### Scenario: Complete runner stack is verified
- **WHEN** Azure and GitHub readback proves the network setting, network configuration, selected-access group, bounded runner, labels, egress, private DNS, and Staging connectivity
- **THEN** a standard hosted preflight may authorize scheduling DAST on the larger runner

#### Scenario: Runner stack is removed
- **WHEN** the approved rollback executes
- **THEN** it first stops scheduling and repository access, removes GitHub runner dependencies, removes the Azure network setting and service association, and only then deletes repository-owned network resources

### Requirement: Promotion, monitoring, health, and evidence are derived from real platform capabilities
For applicable deployed workloads, the profile SHALL require build-once digest
promotion, zero-traffic qualification, blue-green replacement, automated
canary-versus-fresh-baseline analysis when traffic is statistically meaningful,
immediate ungated rollback, infrastructure-as-code alerts routed by severity,
component-level shallow and deep health, DORA event derivation, and a durable
independently verifiable release evidence bundle. A staging qualification SHALL
bind the release version, release or hotfix candidate commit, artifact digest,
and evidence-bundle digest. Production SHALL verify that the true `main` merge
commit incorporates that exact candidate before deploying the qualified digest,
and the immutable tag and Release SHALL target the production merge commit. If
the artifact format requires embedded version metadata, that value SHALL equal
the authoritative release or hotfix branch version rather than act as a second
version source. If the target platform or traffic cannot support a mechanism,
the agent SHALL document the truthful alternative before implementation.

#### Scenario: Canary has insufficient traffic
- **WHEN** Phase 0 finds that the experiment slice cannot produce a meaningful sample within a justified bake window
- **THEN** the design uses one atomic switch with instant rollback
- **AND** does not ship a statistically empty canary gate

#### Scenario: Platform cannot run parallel versions
- **WHEN** the target deployment platform cannot support blue-green versions
- **THEN** the design states the limitation and approved alternative
- **AND** does not describe an in-place update as blue-green

#### Scenario: Release evidence is produced
- **WHEN** an applicable production deployment succeeds
- **THEN** the GitHub Release carries the candidate commit, production merge commit, artifact, source, qualification, evidence-bundle, SBOM, scan, signer, attestation, and trusted-root records required by the policy
- **AND** a failed deployment creates no tag or Release

#### Scenario: Qualified candidate reaches main
- **WHEN** a release or hotfix pull request creates a true merge commit on `main`
- **THEN** production verifies that the merge commit incorporates the candidate commit named by the qualification record
- **AND** it refuses deployment if the version, candidate commit, artifact digest, or evidence digest differs

#### Scenario: Version-bearing package is released
- **WHEN** a package ecosystem requires a semantic version in artifact metadata
- **THEN** the release lane derives or validates that metadata against the release or hotfix branch name
- **AND** conflicting package metadata blocks qualification

#### Scenario: Alerting input is absent
- **WHEN** an environment lacks a required routing target or expected alert rule
- **THEN** deployment fails rather than creating an environment with no alert coverage

### Requirement: The profile carries settled platform and infrastructure defaults
The canonical profile SHALL treat the approved storage redundancy, IaC state
redundancy, database availability, per-repository and per-environment
user-assigned managed identity with OIDC federation, small-workload scale,
cost-optimized production safeguards, environment-level Slack secrets, and
Active-LTS dependency policy as defaults that do not require rediscovery. It
SHALL provision no unused managed service, require cost and known service-limit
disclosure before adopting one, and require an approval-ready reconciliation
plan that refactors and imports live resources when IaC differs from deployed
infrastructure.

#### Scenario: Generated workload uses an applicable platform default
- **WHEN** an approved governance change configures infrastructure without a documented repository-specific reason to differ
- **THEN** it uses the settled environment default
- **AND** it does not ask the user to decide that default again

#### Scenario: Proposed managed service has no consumer
- **WHEN** no application code path consumes a proposed managed service
- **THEN** the service is omitted from infrastructure
- **AND** the plan does not provision it speculatively

#### Scenario: Proposed service has material limits or cost
- **WHEN** a managed service is required by an application code path
- **THEN** the plan states its expected cost and known service limits, including subscription-level rate caps where applicable
- **AND** adoption waits for those facts rather than discovering them after deployment

#### Scenario: Live infrastructure differs from IaC
- **WHEN** Phase 0 finds a live resource that conflicts with the declared infrastructure
- **THEN** the plan refactors the IaC to match and imports the existing resource
- **AND** it does not create a parallel stack, force replacement, or classify the resource as permanently external

### Requirement: Automated GitFlow completion respects protected branches and token recursion
The canonical profile SHALL require release and hotfix completion, including the
required back-merge, to use pull requests and successful required checks without
human approval. Automation using `GITHUB_TOKEN` SHALL explicitly invoke any
follow-on validation or deployment that token-generated events cannot trigger,
and SHALL never rely on a tag-push event, direct protected-branch push, or
success-shaped substitute.

#### Scenario: Automation opens a protected-branch back-merge
- **WHEN** a successful release or hotfix requires changes to return to `develop` or an open release branch
- **THEN** automation creates a pull request and explicitly starts validation for its exact head commit
- **AND** it merges only after every required context succeeds

#### Scenario: Token-generated merge does not emit a follow-on workflow
- **WHEN** a merge performed with `GITHUB_TOKEN` would suppress the normal push-triggered workflow
- **THEN** the coordinating automation explicitly invokes the required follow-on work for the resulting commit
- **AND** absence or failure of that invocation makes the operation fail closed

#### Scenario: Production deployment creates a release tag
- **WHEN** production deployment succeeds for a qualified `main` merge commit
- **THEN** the same release operation creates the annotated tag, GitHub Release, and durable assets
- **AND** no follow-on behavior depends on the tag push triggering another workflow

### Requirement: Updated policy content preserves the Liftoff activation envelope
The canonical policy SHALL retain valid versioned Liftoff frontmatter, carry
normative policy version 8 with the coordinated activation contract and credential-policy schema 2, and preserve the activation protocol that
distinguishes a generated handoff from live enforcement. Updating the normative
baseline SHALL preserve the pushed-repository prerequisite, read-only Phase 0,
explicit conversational approval boundary, user-owned activation baseline,
post-approval spec workflow, and ruleset-last sequencing. Required controls
that remain unavailable or unsupported SHALL stay visible as gaps or blockers
rather than being silently removed or weakened to obtain a green outcome.

Discovery and ruleset-last sequencing SHALL apply within the requested scope. Repository-only enforcement SHALL remain distinct from full cloud/production activation.

#### Scenario: Liftoff renders the revised policy
- **WHEN** a project selects the single-maintainer governance profile
- **THEN** the generated policy contains the revised normative baseline, policy version 8, credential-policy schema 2, and coherent declared activation identity
- **AND** it remains a valid local handoff rather than a claim of live enforcement

#### Scenario: Updated prompt omits Liftoff metadata
- **WHEN** supplied normative policy text lacks Liftoff frontmatter or activation instructions
- **THEN** integration restores the versioned Liftoff envelope
- **AND** the packaged policy validator rejects an artifact that loses the approval or activation-baseline safeguards

#### Scenario: Unsupported control coverage remains explicit
- **WHEN** repository-scope implementation cannot yet observe or execute a required control family
- **THEN** the rendered policy keeps that control and its requirement visible as unavailable or blocked
- **AND** it does not rewrite the baseline to claim the control is optional

### Requirement: Governance implementation starts only in the selected spec workflow
After the user approves Phase 0, the agent SHALL create a new OpenSpec or Spec Kit change through the framework selected by the project. The change SHALL capture discovered requirements, adaptations, design, and tasks before implementation. Liftoff's generated handoff SHALL NOT pre-create, name, restore, or own that active change.

#### Scenario: Approve an OpenSpec project
- **WHEN** the user approves Phase 0 for a project configured with OpenSpec
- **THEN** the agent creates an OpenSpec governance change using the discovered facts
- **AND** the generated Liftoff handoff remains a referenced input rather than the active change

#### Scenario: Archive the governance change
- **WHEN** the user later archives or deletes the completed governance change
- **THEN** `liftoff validate`, `liftoff doctor`, and `liftoff update` do not recreate or report that change

### Requirement: Required checks and rulesets are activated fail-closed
The post-approval implementation SHALL author workflows and repository
source-of-truth files before installing rulesets. Every required context SHALL
be observed reaching success on all applicable protected ref families and
deliberately reaching failure for a controlled violation. The managed policy
SHALL bind applicable required contexts explicitly for `develop`, `main`,
`release/*`, and `hotfix/*` rather than assuming one permanent-branch binding
covers every protected ref. Rulesets SHALL be installed last through idempotent
repository-scoped automation and read back from GitHub after application.

Repository-only scope SHALL qualify source-validation contexts without depending on staging or production deployment; full activation SHALL independently require its cloud/artifact/deployment qualification. Registered owned controls SHALL be reconciled idempotently and every mutation read back before success.

#### Scenario: Required context has not run
- **WHEN** a proposed required status context has never been observed green
- **THEN** the ruleset application remains blocked

#### Scenario: Required check is skipped or cancelled
- **WHEN** an aggregator evaluates a required dependency that is skipped, cancelled, neutral, or missing
- **THEN** it treats the dependency as not successful
- **AND** does not report a passing gate

#### Scenario: Prove a gate can fail
- **WHEN** a workflow context is proposed as required
- **THEN** evidence includes a controlled unmerged fixture that made that exact real validation context fail
- **AND** ruleset installation waits for both positive and negative evidence
- **AND** arbitrary infrastructure failure or a posted status without the required run is insufficient

#### Scenario: Release and hotfix bindings differ
- **WHEN** a proposed required context applies differently to `release/*` and `hotfix/*` than to `main` or `develop`
- **THEN** the implementation records those ref-family bindings explicitly and validates each applicable family before ruleset installation
- **AND** unproven or missing bindings keep activation blocked

#### Scenario: Apply rulesets twice
- **WHEN** the approved idempotent apply operation runs a second time against matching live rulesets
- **THEN** it performs zero writes
- **AND** live read-back still matches the committed exact rule payloads

#### Scenario: Existing foreign controls are present
- **WHEN** a repository contains protections outside the exact owned-control inventory
- **THEN** reconciliation preserves them and reports conflicts or required separate review
- **AND** it does not delete or replace them by name prefix

### Requirement: Existing main history is grandfathered explicitly
For an existing repository, Phase 0 SHALL identify the current `main` tip proposed as the governance activation baseline. After approval, implementation SHALL record that exact SHA in a user-owned activation record and enforce release/tag anomaly rules only for governed production commits after it. It SHALL NOT invent a synthetic release, move a tag, or rewrite existing history.

#### Scenario: Activate on an existing repository
- **WHEN** governance is approved for a repository with pre-existing untagged `main` commits
- **THEN** the activation record identifies the approved current `main` SHA
- **AND** those historical commits are not reported as post-activation release anomalies

#### Scenario: Main advances before activation
- **WHEN** the observed `main` tip changes after Phase 0 and before governance activation
- **THEN** activation stops and requires the baseline to be rediscovered and approved

#### Scenario: Governed main commit lacks a release
- **WHEN** a post-activation production commit lands on `main` without its required successful deployment, immutable tag, and GitHub Release
- **THEN** the governance checks report an anomaly

### Requirement: Local state never claims live enforcement
The generated context, guide, plan presentation, manifest, and diagnostics
SHALL describe the local state as a governance handoff, not active enforcement.
Diagnostics SHALL distinguish a complete `handoff-generated` artifact set from
an update-only `handoff-partial` state caused by preserved unrecorded
conflicts, without claiming ownership of those conflicting files. Live
activation status SHALL be established only by the user-owned activation
evidence and read-back of repository settings; Liftoff SHALL NOT infer it from
the presence of policy, workflow, or ruleset source files.

Generated context, guides, plans, manifests and diagnostics SHALL distinguish handoff-generated, truthful partial handoff, verified repository enforcement and full activation. Scope completion SHALL require current user-owned evidence and actual readback.

#### Scenario: Fresh governed scaffold
- **WHEN** initialization completes with the profile enabled
- **THEN** completion reports that the governance handoff was generated and activation is deferred
- **AND** it does not say branches, checks, rulesets, security, deployment, or monitoring are enforced

#### Scenario: Workflows exist locally
- **WHEN** a later project contains governance workflow and ruleset files but GitHub cannot be inspected
- **THEN** Liftoff does not report live governance as active

#### Scenario: Governance adoption is partial
- **WHEN** a legacy update preserves one or more unrecorded conflicting handoff destinations
- **THEN** validation accepts only truthful managed ownership under the supported manifest contract
- **AND** doctor warns that the local handoff is incomplete and directs the developer to inspect conflicts before considering `--force`

#### Scenario: Repository scope finishes first
- **WHEN** repository controls are verified while cloud work remains incomplete
- **THEN** the report states repository enforcement success separately
- **AND** full activation is not marked complete

### Requirement: Repository-only enforcement is an explicitly selected supported boundary
The profile SHALL offer repository scope that discovers refs and controls, publishes source-validation workflows, qualifies exact checks, obtains owner-reviewed plan approval, reconciles owned settings/rulesets and performs independent readback without Azure configuration or production rollout. It SHALL preserve the fixed GitFlow/security invariants and current history. Required real GitHub execution SHALL not remain injected-only for the coordinated release.

#### Scenario: Enforce before provisioning cloud resources
- **WHEN** a published supported repository selects repository-only scope and supplies its actual GitHub prerequisites and approvals
- **THEN** repository enforcement can complete without staging-qualified or production-rehearsed proof
- **AND** no Azure resource, production release or version tag is created

#### Scenario: Approval or evidence becomes stale
- **WHEN** refs, actors, workflow source, controls or other reviewed inputs change
- **THEN** reconciliation rejects the old plan before unapproved writes
- **AND** a new exact review is required

#### Scenario: Control reconciliation partly fails
- **WHEN** some approved writes succeed but another write or readback fails
- **THEN** their exact outcomes and recovery boundary are retained
- **AND** the engine does not automatically remove protection to simplify recovery

#### Scenario: GitHub capability is genuinely unavailable
- **WHEN** the account lacks a required observable permission or product capability
- **THEN** the report identifies that specific prerequisite
- **AND** missing implementation is separately classified rather than disguised as a request for cloud credentials

### Requirement: Deferred production uses an explicit reviewed main hold
When production qualification is deferred, repository-only enforcement SHALL support a separately approved main-update hold bound to exact owned controls and the current main baseline. The hold SHALL prevent unqualified main updates without synthetic staging success, branch bypass, history rewrite, production release or version-tag creation. Removing or replacing it SHALL require real applicable qualification and a fresh separately approved control plan.

#### Scenario: Establish repository controls while deferring production
- **WHEN** the owner approves repository enforcement and its displayed main hold
- **THEN** the repository records and verifies the hold independently from cloud activation
- **AND** existing main history is preserved without a fabricated release

#### Scenario: Production proof is still absent
- **WHEN** a later operation asks to lift the hold without required genuine qualification
- **THEN** it remains blocked
- **AND** repository completion or the earlier approval does not authorize release

#### Scenario: Production is qualified later
- **WHEN** actual required qualification is current and the owner separately approves the exact reconciliation
- **THEN** only the verified owned hold/control changes are applied and read back
- **AND** foreign protections and immutable historical records remain intact

#### Scenario: Main changed since review
- **WHEN** the current main tip or owned hold differs from the reviewed observation
- **THEN** the old hold-transition plan is rejected without forcing the branch or restoring stale controls

### Requirement: Repository reconciliation preserves current GitHub review-rule semantics
Discovery, planning, policy comparison, approved reconciliation and readback SHALL use the same supported interpretation of current pull-request rule parameters, including dismissal restrictions, the extra-approval flag and required reviewers. Neutral supported defaults SHALL NOT create an unsupported-response failure or unnecessary control mutation. Meaningful constraints and genuinely unknown or malformed enforcement data SHALL remain visible and SHALL NOT be discarded to satisfy the zero-review profile or obtain a passing readback.

#### Scenario: GitHub adds neutral default fields to readback
- **WHEN** an otherwise matching zero-review ruleset returns the supported disabled/empty defaults and neutral extra-approval flag
- **THEN** current normalization and effective-policy comparison accept that observation
- **AND** matching reconciliation remains zero-write without removing the provider fields

#### Scenario: A meaningful reviewer restriction differs
- **WHEN** live reviewer or dismissal constraints differ meaningfully from the reviewed target
- **THEN** the exact difference is retained for policy evaluation and any required separately approved reconciliation
- **AND** a top-level zero count does not hide it

#### Scenario: Readback contains unknown enforcement
- **WHEN** the provider returns an unsupported or malformed enforcement field
- **THEN** complete enforcement verification remains blocked
- **AND** source files, model assertions or stripping the field do not supply replacement proof

### Requirement: Transient local bootstrap state has a fixed retirement lifecycle
When a private remote backend cannot be reached until repository-owned
networking exists, the canonical profile SHALL permit an explicitly approved,
minimum local-state bootstrap. The local state MUST remain encrypted,
gitignored, single-writer, and unavailable through ordinary GitHub artifacts or
secrets. After remote import is verified, it SHALL become read-only for exactly
30 days and then be securely deleted with dated evidence.

#### Scenario: Existing private management path is available
- **WHEN** an approved execution environment can already reach the private remote backend
- **THEN** the implementation uses that path and does not create a local-state bootstrap

#### Scenario: Private backend creates a bootstrap cycle
- **WHEN** remote state is private and unreachable until repository-owned networking and its execution runner exist
- **THEN** the approved plan may use local state only for the minimum resources needed to establish private backend access
- **AND** it does not identify the bootstrap as remote-ready or authorize unrelated provisioning

#### Scenario: Local bootstrap state is held
- **WHEN** the minimum bootstrap uses local state
- **THEN** the state remains encrypted on the approved workstation, excluded from version control, and limited to one operator
- **AND** it is not uploaded through workflow artifacts, repository secrets, or another ordinary transfer channel

#### Scenario: Remote import is verified
- **WHEN** the exact private execution runner can access the backend, every live resource is represented in remote state with matching identity, locking and versioning are active, and a clean checkout produces a no-change plan
- **THEN** the implementation records the verification timestamp and makes the local bootstrap state read-only
- **AND** the 30-day retention period begins

#### Scenario: Remote import is incomplete
- **WHEN** private access, resource parity, locking, versioning, or the no-change plan cannot be verified
- **THEN** the retention period does not begin, the local state is not deleted, and normal infrastructure provisioning remains blocked

#### Scenario: Retention period expires
- **WHEN** 30 days have elapsed since the recorded remote-import verification timestamp
- **THEN** the encrypted local bootstrap state and approved temporary copies are securely deleted
- **AND** a dated deletion record identifies the disposed state, verification evidence, operator, and outcome without containing state data

#### Scenario: Local state is used during retention
- **WHEN** any operation attempts to plan or apply from retained local bootstrap state after remote verification
- **THEN** the operation fails because the retained copy is evidence-only and read-only

### Requirement: Governance policy phases are capabilities, not inferred task order
The canonical policy SHALL identify its numbered security, delivery, GitFlow,
governance, and documentation sections as capability chapters. The managed
phase graph SHALL define execution order, including provider readiness before
local bootstrap and private runner readiness before private backend proof and
remote import.

#### Scenario: Policy prose and graph disagree
- **WHEN** policy text, generated tasks, or an agent response orders a transition differently from the phase graph
- **THEN** activation follows the phase graph and reports the inconsistent source

#### Scenario: Private backend requires a runner
- **WHEN** a bounded local bootstrap is required
- **THEN** the graph orders provider readiness, access-establishing network, restricted runner, backend proof, declarative remote import, no-change verification, and remote-ready state

### Requirement: Active governance work reconciles activation-identity changes
When managed policy, activation-contract semantics, schemas, or phase-graph
bytes change, the engine SHALL compare the active governance change and verified
phase state with the new compatibility version vector. It SHALL invalidate only
affected downstream phases, produce an approval-ready reconciliation report,
and block execution until the active change acknowledges the current compatible
identity and exact graph hash.

#### Scenario: Policy update changes an unstarted phase
- **WHEN** an affected phase has not begun
- **THEN** its generated task and requirements are updated without invalidating unrelated verified predecessors

#### Scenario: Policy update changes a completed phase
- **WHEN** completed evidence no longer satisfies the current contract
- **THEN** the phase is blocked for renewed evidence or an explicit approved exception

#### Scenario: Policy update changes no relevant contract
- **WHEN** managed bytes change but the active phase requirements and evidence remain equivalent
- **THEN** reconciliation records the new compatible activation identity without repeating completed work

#### Scenario: Activation identity is unsupported
- **WHEN** the policy and activation-contract versions or serialized schemas are not a supported combination
- **THEN** reconciliation blocks without changing evidence, phase state, or the active change

### Requirement: Credential policy is consistent across repositories
The governance profile SHALL use credential-policy schema 2 for current PAT and existing GitHub App authentication. Repository-specific names and allowed workflows SHALL be values in that schema rather than model-generated prose. Actual provider grants and the broader organization, billing and Actions-settings read disclosure SHALL be explicit and consistent across both authentication kinds; repository selection and Liftoff execution endpoints SHALL retain their narrower independently approved boundaries. Schema-1 records SHALL remain readable only through their exact original contracts, not be normalized into current permission authority.

#### Scenario: Two repositories require PAT fallback
- **WHEN** setup enrolls runner-preflight credentials through a supported independently verified path
- **THEN** both use the `<repo>-runner-preflight-read` display-name template and `RUNNER_CONFIGURATION_READ_TOKEN` secret
- **AND** each policy binds its own repository, explicit allowed jobs, actual provider grant and fresh approval without claiming the organization grant is repository-only

#### Scenario: A workflow expands credential exposure
- **WHEN** a new job or workflow references the credential outside the recorded allowlist
- **THEN** verification fails before the workflow can satisfy qualification evidence

#### Scenario: A schema-1 policy already exists
- **WHEN** current execution requires the broader provider grant at a project with an existing schema-1 policy
- **THEN** the policy and its original ownership/approval history remain unchanged until an exact registered transition is separately approved
- **AND** the new approval and independently verified grants cannot be inferred from the prior policy or unrelated project-update consent

### Requirement: Local handoff completion is separate from policy activation
The profile's single setup integration SHALL distinguish local completion from implemented cloud/governance activation while guiding the requested full journey through both. It SHALL preserve local-only operation and require separate authority before publication, credentials, infrastructure/state changes, and enforcement. The existing fixed policy controls SHALL remain mandatory where applicable; local repair observations SHALL not satisfy live proof requirements.

#### Scenario: Complete local setup before publication
- **WHEN** local requirements and proof are complete without a remote repository
- **THEN** the handoff reports local success and separate activation prerequisites
- **AND** it does not request publication approval merely to call local setup complete

#### Scenario: Explicit activation is requested
- **WHEN** the developer requests the full setup journey or separately requests activation and approves its required scopes
- **THEN** publication, discovery, approval, credential, and execution-capability prerequisites remain enforced
- **AND** supported production operations execute through verified live governance rather than an unimplemented handoff

#### Scenario: An external capability blocks activation
- **WHEN** actual account permissions, licensing, quota, or private access do not satisfy the policy
- **THEN** the CLI reports the precise prerequisite and preserves completed work
- **AND** it does not bypass the control or confuse the condition with a missing supported producer

### Requirement: Setup guidance offers supported repair rather than manual metadata fabrication
Profile handoffs SHALL explain structured local and supported stateful repairs with exact read/write, preservation, approval, and recovery scope. They SHALL distinguish observed statefulness from eligibility and separate unknown-state discovery from authorized execution. They SHALL link the distinct native repair operation for actual application inventory and reviewed staged patch assistance while preserving deterministic CLI authority. They SHALL not tell developers to edit state/machine metadata, discard history, directly patch the real application before review, or overwrite a project with a new starter to satisfy a gate.

#### Scenario: A legacy layout blocks the local baseline
- **WHEN** a supported infrastructure repair candidate is reported
- **THEN** the selected agent presents its actual preview and next approval/discovery action
- **AND** it does not invent a reinitialization command or declare all automation impossible

#### Scenario: The source cannot be repaired automatically
- **WHEN** current state or unsupported customizations make execution ineligible
- **THEN** the handoff explains the specific plan-only boundary and unresolved work
- **AND** it does not present a nonexistent executable recipe

#### Scenario: Read-only assessment identifies a layout concern
- **WHEN** assessment explains relevant repair guidance
- **THEN** it identifies the separate native repair path without invoking it, running project scripts, applying recommendations or changing assessment authority

### Requirement: The supported profile is implemented and independently verified
The production setup path SHALL implement applicable policy controls through actual workload-aware infrastructure, identities, workflows, qualification, and enforcement. Required status contexts SHALL be proven on their applicable protected ref families, including a controlled failure. Rulesets SHALL be applied last after exact final approval and compared with committed source through live readback. Existing policy restrictions on human merge/deployment reviewers and duplicate security tooling SHALL not be replaced with convenience gates.

#### Scenario: A workflow file exists but has not run
- **WHEN** a required control has only source configuration and no valid execution proof
- **THEN** activation remains incomplete and enforcement does not proceed

#### Scenario: A required check is skipped or synthetic
- **WHEN** proof is skipped, cancelled, neutral, stale, or merely an emitted success status without the required real run
- **THEN** it does not satisfy qualification or enforcement

#### Scenario: Idempotent enforcement is requested
- **WHEN** current approved rulesets already match live state
- **THEN** the operation preserves the matching controls and records actual readback without destructive replacement

### Requirement: Credential enrollment and lifecycle follow the policy's real security boundary
Supported enrollment SHALL prefer the approved scoped GitHub App path and otherwise implement the defined fine-grained credential policy through private input and verified use. Credential values SHALL never appear in chat, argv, public receipts, or generated source. Retained bootstrap state SHALL remain encrypted and unusable for ordinary work after remote verification, with exact due disposal tracked separately from activation completion.

#### Scenario: Credential metadata exists without usage proof
- **WHEN** only a credential policy file or secret name is observable
- **THEN** readiness remains unverified until the required scoped use and configured workflow path are proven

#### Scenario: Retention has not expired
- **WHEN** application/enforcement activation is complete but retained state is not yet disposable
- **THEN** activation is reported separately from pending lifecycle work
- **AND** neither early deletion nor ordinary use of retained state is allowed

### Requirement: Native repair is a distinct equivalent selected-agent operation
Every selected supported coding agent SHALL receive the same logical repair workflow through its registered native surface: `/liftoff-repair` for Copilot/Claude and `$liftoff-repair` for Codex. The integration SHALL validate the installed CLI's supported repair contracts, preparation matrix and capabilities, delegate deterministic inspection/approval/preparation/application/recovery to `liftoff repair`, and keep application patch authoring in external staging until explicit approval. It SHALL teach the ordinary prompt-driven terminal journey without manual fingerprint entry and show exact package sources, lock/tool requirements, suppressed lifecycle policy and possible host/network effects before distinct permissions. An agent SHALL use exact automation flags only internally for the same immutable plan and effect scopes the developer separately approved; generic repair requests, prior unrelated approval, autopilot mode, agent-generated Yes or piped input SHALL NOT supply those permissions. The integration SHALL have a managed content hash, not independent skill SemVer. Repair SHALL be available with governance disabled without enabling governance or becoming a setup/assessment alias.

#### Scenario: A developer chooses any supported agent
- **WHEN** its selected-agent integration is generated
- **THEN** the native repair invocation has equivalent contract checks, inventory/staging/review/verification/approval and recovery instructions
- **AND** it does not advertise `liftoff -repair` or a shell `liftoff setup` command

#### Scenario: The installed CLI is older than the skill
- **WHEN** capabilities lack a required repair contract or mode
- **THEN** the skill stops that operation and identifies the compatibility remedy
- **AND** it does not emulate the missing command through direct project writes

#### Scenario: An agent guides a normal repair
- **WHEN** the developer chooses the native repair operation
- **THEN** the agent explains and obtains distinct preparation, code/lifecycle, declared-network and file approvals as applicable without requiring hash copying
- **AND** any internally supplied exact flags retain the displayed plan and all CLI revalidation gates

#### Scenario: Repair is requested without governance
- **WHEN** the project selected governance `none`
- **THEN** its repair integration remains usable for supported local project work
- **AND** no policy, setup, assessment, state or evidence is created to make repair available

#### Scenario: A real framework needs locked dependencies
- **WHEN** the selected component has a supported lock/tool/provider combination
- **THEN** the integration guides separately reviewed private preparation and the actual declared build/tests
- **AND** unavailable uv/tools, unsupported hooks/sources or missing locks remain explicit blockers rather than automatic global installs or invented framework qualification

#### Scenario: Agent respects Windows controller prerequisites
- **WHEN** repair is guided on a Windows environment
- **THEN** the native integration explains stock PowerShell 5.1 / .NET prerequisites and causal execution policy blockers without attempting policy changes, bypass flags, or script evasion
- **AND** it delegates execution strictly through CLI repair interfaces
