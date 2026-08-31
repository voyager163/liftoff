## Purpose

Define Liftoff's repository-governance profile: selection, the durable single-maintainer GitFlow policy and generated context, per-agent activation handoff, workload adaptation, deferred read-only Phase 0 discovery, explicit approval boundary, activation baseline for existing repositories, and the distinction between generated policy and live GitHub enforcement.

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
- **AND** no repository-governance policy, context, guide, or agent launcher is rendered

#### Scenario: Select noninteractively
- **WHEN** a developer supplies `--governance single-maintainer-gitflow` or `--governance none`
- **THEN** Liftoff validates the value through the governance profile catalog without prompting

#### Scenario: Reject an unknown profile
- **WHEN** a flag or configuration file names an unsupported governance profile
- **THEN** Liftoff exits 1 before workstation probes or destination writes
- **AND** identifies the accepted profile values

### Requirement: The selected profile generates one canonical durable handoff
The system SHALL render a versioned canonical policy, schema-versioned workload context, activation guide, and thin launcher for each selected coding agent as explicitly named durable Liftoff artifacts. The policy and context SHALL live under `.liftoff/governance`; a Copilot launcher SHALL use the reserved explicit GitHub prompt path and a Claude launcher SHALL use the reserved explicit Claude command path. Launchers SHALL reference the canonical files instead of duplicating the policy.

#### Scenario: Generate for Copilot and Claude
- **WHEN** a project selects `single-maintainer-gitflow`, GitHub Copilot, and Claude Code
- **THEN** the project contains the canonical policy, context, guide, Copilot launcher, and Claude launcher
- **AND** each file has a stable logical name and manifest content hash

#### Scenario: Generate for one agent
- **WHEN** a project selects only GitHub Copilot
- **THEN** Liftoff renders the canonical handoff and Copilot launcher
- **AND** it does not render or require the Claude launcher

#### Scenario: Render paths cross-platform
- **WHEN** the same governed plan is rendered on Windows, macOS, and Linux
- **THEN** every governance artifact has identical bytes, logical names, and OS-neutral path parts
- **AND** filesystem access uses host-native path resolution

#### Scenario: Framework owns neighboring files
- **WHEN** the official spec-framework initializer creates other files under `.github` or `.claude`
- **THEN** Liftoff owns only its explicitly named governance launchers
- **AND** does not select neighboring files for validation, update, replacement, or deletion by directory pattern

### Requirement: Governance context is deterministic and workload-aware
The generated context SHALL identify the selected workload, artifact form, approved runtime and dependency baseline, real generated build and test commands, environments, generated deployment boundaries, known health and readiness endpoints, selected spec framework, and selected coding agents. It SHALL distinguish known generated facts from facts that require live discovery and SHALL contain no credential, token, webhook, tenant secret, or fabricated external capability.

#### Scenario: Generate API context
- **WHEN** a GenAI or standard API project selects the governance profile
- **THEN** context identifies its selected backend, optional frontend, container, OpenTofu, environment, health, and test boundaries that actually exist
- **AND** marks live GitHub, runner, monitoring, traffic, deployment, and alert-routing facts for Phase 0 discovery

#### Scenario: Generate Power Apps context
- **WHEN** a Power Apps code app selects the governance profile
- **THEN** context identifies the root React/Power Apps application, npm commands, immutable starter, framework, and agents
- **AND** states that Liftoff generated no backend, Docker, OpenTofu, API environments, or custom deployment platform

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
The generated launchers SHALL instruct the selected agent to require a committed and pushed repository, read the canonical policy and context, and perform a read-only classification before proposing changes. Phase 0 SHALL inspect artifact type, languages, package managers, working build and test commands, branches, default branch, workflows and exact job names, rulesets, tags, releases, environments, deployments, security scanning, runner access, monitoring and alert routing, component health depth, and platform capabilities. It SHALL report gaps, inapplicable controls, and an ordered plan, then stop for explicit user approval.

#### Scenario: Run before a remote exists
- **WHEN** an agent is asked to activate governance without a resolvable GitHub repository
- **THEN** it reports the missing prerequisite and performs no mutation

#### Scenario: Complete Phase 0
- **WHEN** the agent can inspect the local project and GitHub repository
- **THEN** it reports every required classification and named gap with evidence
- **AND** identifies controls that are unavailable or meaningless for the workload
- **AND** stops before writing files or changing GitHub

#### Scenario: User has not approved the plan
- **WHEN** Phase 0 has reported its findings but the user has not explicitly approved the proposed work
- **THEN** the agent does not create a spec change, branch, workflow, ruleset, environment, or cloud resource

### Requirement: The single-maintainer profile preserves its fixed governance invariants
The canonical profile SHALL require repository-scoped Vincent Driessen GitFlow for versioned-release repositories, zero human merge or deployment approvals, pull requests gated entirely by automated fail-closed checks, no `CODEOWNERS`, no org-level substitute, the built-in `GITHUB_TOKEN` and GitHub Actions bypass identity where automation must act, and immutable semantic releases on `main`. It SHALL require deviations for genuine continuous delivery or platform limitations to be reported and approved rather than silently misrepresented.

#### Scenario: Configure pull-request governance
- **WHEN** an approved governance change defines protected-branch pull-request rules
- **THEN** it sets approving review count to zero and disables code-owner and last-push approval requirements
- **AND** does not create a human approval gate

#### Scenario: Repository scope cannot enforce a control
- **WHEN** a required control is unavailable at repository scope
- **THEN** the agent reports and omits that control
- **AND** does not propose an org-level ruleset, required workflow, or GitHub App installation

#### Scenario: Repository ships continuously
- **WHEN** Phase 0 proves the repository genuinely uses continuous delivery rather than versioned releases
- **THEN** the agent explains where original GitFlow does not fit
- **AND** obtains approval for the explicit branch and release adaptation before implementation

### Requirement: Security and release policy adapts without duplicate or theatrical controls
The canonical profile SHALL map applicable security stages to the events where they can run and SHALL use the designated tools: GitHub Secret Protection, Dependabot and Dependency Review, CodeQL and Copilot Autofix, Checkov, Trivy, non-gating Grype, OWASP ZAP, GitHub artifact attestations and SLSA provenance, and OSSF Scorecard. It SHALL omit inapplicable stages, fail when a required input or runner is absent, prohibit duplicate excluded scanners, and never make Grype a second blocking gate.

#### Scenario: Container workload has private staging access
- **WHEN** an approved API governance design has a deployable container and a self-hosted runner with staging access
- **THEN** its release or hotfix qualification can include digest-bound Trivy, SBOM, provenance, staging deployment, ZAP, and non-gating Grype evidence

#### Scenario: Private staging runner is absent
- **WHEN** DAST requires private staging access but no suitable runner exists
- **THEN** Phase 0 reports release qualification as blocked
- **AND** no required check hangs, skips, or reports synthetic success

#### Scenario: Workload has no container
- **WHEN** the workload does not build or deploy a container image
- **THEN** container scanning, image SBOM, and digest promotion are explicitly marked inapplicable
- **AND** no empty-loop or placeholder check is generated

#### Scenario: Licensed capability is unavailable
- **WHEN** GitHub Secret Protection, CodeQL, or Copilot Autofix is not licensed or enabled for the repository
- **THEN** Phase 0 reports the missing capability
- **AND** the profile does not silently replace it with a duplicate excluded scanner

### Requirement: Promotion, monitoring, health, and evidence are derived from real platform capabilities
For applicable deployed workloads, the profile SHALL require build-once digest promotion, zero-traffic qualification, blue-green replacement, automated canary-versus-fresh-baseline analysis when traffic is statistically meaningful, immediate ungated rollback, infrastructure-as-code alerts routed by severity, component-level shallow and deep health, DORA event derivation, and a durable independently verifiable release evidence bundle. If the target platform or traffic cannot support a mechanism, the agent SHALL document the truthful alternative before implementation.

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
- **THEN** the GitHub Release carries the artifact, source, qualification, evidence-bundle, SBOM, scan, signer, attestation, and trusted-root records required by the policy
- **AND** a failed deployment creates no tag or Release

#### Scenario: Alerting input is absent
- **WHEN** an environment lacks a required routing target or expected alert rule
- **THEN** deployment fails rather than creating an environment with no alert coverage

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
The post-approval implementation SHALL author workflows and repository source-of-truth files before installing rulesets. Every required context SHALL be observed reaching success on all applicable paths and deliberately reaching failure for a controlled violation. Rulesets SHALL be installed last through idempotent repository-scoped automation and read back from GitHub after application.

#### Scenario: Required context has not run
- **WHEN** a proposed required status context has never been observed green
- **THEN** the ruleset application remains blocked

#### Scenario: Required check is skipped or cancelled
- **WHEN** an aggregator evaluates a required dependency that is skipped or cancelled
- **THEN** it treats the dependency as not successful
- **AND** does not report a passing gate

#### Scenario: Prove a gate can fail
- **WHEN** a workflow context is proposed as required
- **THEN** evidence includes one controlled violation that made that exact context red
- **AND** ruleset installation waits for both positive and negative evidence

#### Scenario: Apply rulesets twice
- **WHEN** the approved idempotent apply operation runs a second time against matching live rulesets
- **THEN** it performs no destructive replacement
- **AND** live read-back still matches the committed exact rule payloads

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

#### Scenario: Fresh governed scaffold
- **WHEN** initialization completes with the profile enabled
- **THEN** completion reports that the governance handoff was generated and activation is deferred
- **AND** it does not say branches, checks, rulesets, security, deployment, or monitoring are enforced

#### Scenario: Workflows exist locally
- **WHEN** a later project contains governance workflow and ruleset files but GitHub cannot be inspected
- **THEN** Liftoff does not report live governance as active

#### Scenario: Governance adoption is partial
- **WHEN** a legacy update preserves one or more unrecorded conflicting handoff destinations
- **THEN** validation accepts the truthful schema-v5 ownership record
- **AND** doctor warns that the local handoff is incomplete and directs the developer to inspect conflicts before considering `--force`
