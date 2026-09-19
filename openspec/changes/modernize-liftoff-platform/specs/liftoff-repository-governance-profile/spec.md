## MODIFIED Requirements

### Requirement: The selected profile generates one canonical managed-core handoff
The system SHALL render one canonical versioned policy, schema-versioned workload context, activation guide, and thin selected-agent setup, assessment and repair integrations as explicitly named managed-core artifacts. Policy and context SHALL remain under their registered governance namespace. Existing Copilot, Claude and Codex integration identities SHALL remain compatible until an explicitly reviewed migration changes their transport. Integrations SHALL consume the canonical skill/policy contracts and public CLI rather than duplicate policy or execution logic. The logical setup operation SHALL remain one entry point per host, with separate assessment and repair operations.

#### Scenario: Generate for Copilot and Claude
- **WHEN** a governed project selects Copilot and Claude
- **THEN** it receives the canonical handoff and required selected-agent integrations
- **AND** each has a stable registered logical name and managed content hash

#### Scenario: Generate for one agent
- **WHEN** only one supported host is selected
- **THEN** only its required integrations are provisioned
- **AND** another host's launcher is not a prerequisite

#### Scenario: Render paths cross-platform
- **WHEN** the same plan is rendered on Windows, macOS and Linux
- **THEN** logical identities and portable path parts agree and filesystem access resolves natively
- **AND** host-specific transport differences are declared rather than hidden in different business rules

#### Scenario: Framework owns neighboring files
- **WHEN** framework or user output exists in an agent configuration directory
- **THEN** Liftoff modifies or retires only exact registered artifacts authorized by its reviewed ownership inventory
- **AND** directory patterns do not claim neighboring files

#### Scenario: Generate for Codex
- **WHEN** Codex is selected
- **THEN** its native integrations follow the same policy, approval, scope and repair contracts as other selected hosts
- **AND** managed hashes and negotiated capabilities, not independent skill SemVer, identify compatibility

### Requirement: Agent activation begins with read-only Phase 0
Setup SHALL require verified local/publication prerequisites, read the canonical policy/context and perform the selected scope's read-only classification before proposing remote changes. Repository classification SHALL observe repository identity, refs, controls, source workflows, exact check contexts and applicable GitHub capabilities without Azure credentials. Full activation SHALL additionally inspect actual applicable environment, artifact, deployment, provider, monitoring, runner and state-path prerequisites with explicit public bindings and authorized access.

When private Staging DAST applies, its discovery SHALL cover the selected subscription, runner/network resources, permissions, network-configuration policy, address space, DNS/routing, egress, costs, state ownership and teardown authority. Findings SHALL distinguish gaps and unproven applicability and stop before unapproved effects. Assessment remains independently available before publication and SHALL NOT satisfy execution discovery or approval merely by producing a report.

#### Scenario: Run before a remote exists
- **WHEN** remote governance is requested without a resolvable repository
- **THEN** setup reports the prerequisite without mutation

#### Scenario: Complete Phase 0
- **WHEN** required local and authorized remote observations for the selected discovery scope are available
- **THEN** the engine reports required classification and named gaps with evidence
- **AND** unavailable or meaningless controls are explicit before any write

#### Scenario: User has not approved the plan
- **WHEN** discovery has reported findings but the proposed effects are not approved
- **THEN** no spec change, branch, workflow, ruleset, environment, cloud resource, network configuration or runner is created by that discovery

#### Scenario: Assess before publication
- **WHEN** only assessment is requested for an unpublished project
- **THEN** it can report local differences and unobserved controls
- **AND** it neither creates a remote nor advances execution discovery

#### Scenario: Repository-only adoption precedes Azure
- **WHEN** repository scope is explicitly selected with no Azure configuration
- **THEN** its required GitHub discovery can proceed
- **AND** Azure input, credential, runner or production qualification is not requested as a prerequisite

### Requirement: The single-maintainer profile preserves its fixed governance invariants
The canonical policy SHALL retain repository-scoped GitFlow for versioned-release repositories, `main` and `develop` as permanent branches, temporary feature/release/hotfix/automation branches, zero required human merge/deployment reviewers, PR-only protected-branch changes, automated fail-closed checks, no CODEOWNERS and no branch bypasses. Supported automation SHALL use the approved built-in token or scoped identity without bypassing protected-branch checks. Version tags SHALL have restricted creation and immutable update/deletion rules. Independent Liftoff scope/cost/enforcement approval SHALL NOT become a GitHub required human reviewer.

Conditional provisioning of the repository-dedicated VNet-injected GitHub-hosted larger runner for private Staging DAST SHALL remain the only declared org/enterprise provisioning exception. Genuine continuous-delivery or platform deviations SHALL require explicit approved adaptation, not silent misrepresentation.

#### Scenario: Configure pull-request governance
- **WHEN** an approved plan defines protected-branch PR rules
- **THEN** approving review count is zero and code-owner/last-push approval requirements remain disabled
- **AND** branch changes still require PRs and successful applicable checks without bypass actors

#### Scenario: Repository scope cannot enforce a control
- **WHEN** a required control other than the declared runner exception is unavailable at repository scope
- **THEN** the limitation is reported without an org-level substitute or fabricated enforcement
- **AND** required unsupported enforcement remains a blocker for its applicable scope

#### Scenario: Repository ships continuously
- **WHEN** discovery proves original versioned-release GitFlow does not fit
- **THEN** the adaptation is explained and separately approved before implementation

#### Scenario: VNet runner prerequisite is unavailable
- **WHEN** required private qualification lacks a suitable assigned runner
- **THEN** full release qualification remains blocked with the narrowly supported provisioning option
- **AND** the exception does not expand to self-hosted runners or unrelated org controls

#### Scenario: Automation needs to update a protected branch
- **WHEN** an approved automated operation prepares a merge or back-merge
- **THEN** it uses the permitted PR/check path
- **AND** it does not add a branch bypass to make the operation succeed

### Requirement: Updated policy content preserves the Liftoff activation envelope
The canonical policy SHALL retain valid versioned frontmatter and carry normative policy version 8 with the coordinated activation contract and credential-policy schema 2. It SHALL preserve the version-7 repository-only enforcement and hold semantics, published-repository prerequisite for remote execution, read-only scope-specific discovery, explicit approval, user-owned baselines, selected spec workflow and ruleset-last sequencing within the requested scope. Repository-only enforcement SHALL remain distinct from full cloud/production activation. Required unavailable controls SHALL remain visible rather than weakened to obtain a green result.

#### Scenario: Liftoff renders the revised policy
- **WHEN** the selected profile is rendered
- **THEN** policy version 8, credential-policy schema 2 and their declared activation identity are coherent
- **AND** generated files are a local handoff, not proof of live enforcement

#### Scenario: Updated prompt omits Liftoff metadata
- **WHEN** supplied policy content lacks required frontmatter or authority instructions
- **THEN** integration preserves the versioned envelope
- **AND** validation rejects loss of approval or baseline safeguards

#### Scenario: Unsupported control coverage remains explicit
- **WHEN** an applicable control cannot be observed or executed
- **THEN** its requirement remains visible as unavailable or blocked
- **AND** the baseline is not rewritten to make it optional

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

### Requirement: Required checks and rulesets are activated fail-closed
Approved implementation SHALL establish the selected scope's source workflows and exact control plan before enforcing rulesets. Every required context SHALL have fresh positive and controlled-negative provider evidence for its actual applicable protected ref families. Repository-only scope SHALL qualify source-validation contexts without depending on staging or production deployment; full activation SHALL independently require its cloud/artifact/deployment qualification. Registered controls SHALL be reconciled idempotently within repository scope and every mutation read back before success.

#### Scenario: Required context has not run
- **WHEN** a proposed required context lacks actual successful qualification
- **THEN** its enforcement remains blocked

#### Scenario: Required check is skipped or cancelled
- **WHEN** a required dependency is skipped, cancelled, neutral or missing
- **THEN** it does not satisfy the gate or produce synthetic success

#### Scenario: Prove a gate can fail
- **WHEN** a context is proposed as required
- **THEN** evidence includes a controlled unmerged fixture that makes that exact real validation context fail
- **AND** arbitrary infrastructure failure or a posted status without the required run is insufficient

#### Scenario: Release and hotfix bindings differ
- **WHEN** contexts have different applicable ref families
- **THEN** those bindings are explicit and each required family is qualified
- **AND** missing proof remains a blocker for the selected scope

#### Scenario: Apply rulesets twice
- **WHEN** current approved owned controls already match live state
- **THEN** repeated reconciliation performs zero writes
- **AND** actual readback still establishes the result

#### Scenario: Existing foreign controls are present
- **WHEN** a repository contains protections outside the exact owned-control inventory
- **THEN** reconciliation preserves them and reports conflicts or required separate review
- **AND** it does not delete or replace them by name prefix

### Requirement: Local state never claims live enforcement
Generated context, guides, plans, manifests and diagnostics SHALL distinguish handoff-generated, truthful partial handoff, verified repository enforcement and full activation. Local policy/workflow/ruleset files SHALL NOT prove live enforcement. Scope completion SHALL require current user-owned evidence and actual readback; unrecorded conflicting files SHALL NOT acquire ownership through diagnostics.

#### Scenario: Fresh governed scaffold
- **WHEN** initialization completes with governance enabled
- **THEN** completion reports the generated handoff and deferred external execution
- **AND** it does not claim branches, checks, rulesets, deployment or monitoring are enforced

#### Scenario: Workflows exist locally
- **WHEN** workflow/ruleset files exist but required GitHub observation is unavailable
- **THEN** live governance is not reported active

#### Scenario: Governance adoption is partial
- **WHEN** reviewed maintenance preserves unrecorded conflicting handoff destinations
- **THEN** the supported manifest records only truthful managed ownership
- **AND** diagnostics identify incomplete handoff and the actual conflict-review path

#### Scenario: Repository scope finishes first
- **WHEN** repository controls are verified while cloud work remains incomplete
- **THEN** the report states repository enforcement success separately
- **AND** full activation is not marked complete

## ADDED Requirements

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
