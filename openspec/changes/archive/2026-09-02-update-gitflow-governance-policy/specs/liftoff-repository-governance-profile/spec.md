## MODIFIED Requirements

### Requirement: The single-maintainer profile preserves its fixed governance invariants
The canonical profile SHALL require repository-scoped Vincent Driessen GitFlow
for versioned-release repositories, zero human merge or deployment approvals,
pull requests gated entirely by automated fail-closed checks, no `CODEOWNERS`, no
org-level substitute, the built-in `GITHUB_TOKEN` and GitHub Actions bypass
identity where automation must act, and immutable semantic releases on `main`.
The externally provisioned GitHub-hosted larger runner group with Azure VNet
injection SHALL be the only permitted org- or enterprise-level prerequisite.
The profile SHALL require deviations for genuine continuous delivery or platform
limitations to be reported and approved rather than silently misrepresented.

#### Scenario: Configure pull-request governance
- **WHEN** an approved governance change defines protected-branch pull-request rules
- **THEN** it sets approving review count to zero and disables code-owner and last-push approval requirements
- **AND** it does not create a human approval gate

#### Scenario: Repository scope cannot enforce a control
- **WHEN** a required control other than the approved VNet-injected runner prerequisite is unavailable at repository scope
- **THEN** the agent reports and omits that control
- **AND** it does not propose an org-level ruleset, required workflow, GitHub App installation, or other org-level substitute

#### Scenario: Repository ships continuously
- **WHEN** Phase 0 proves the repository genuinely uses continuous delivery rather than versioned releases
- **THEN** the agent explains where original GitFlow does not fit
- **AND** it obtains approval for the explicit branch and release adaptation before implementation

#### Scenario: VNet runner prerequisite is unavailable
- **WHEN** private Staging qualification requires DAST and the approved GitHub-hosted larger runner group is unavailable
- **THEN** the agent identifies the exact external prerequisite as a blocker
- **AND** it does not create a self-hosted runner or generalize the exception to any other org-level control

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
- **THEN** Phase 0 reports release qualification as blocked
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
- **AND** it does not ship a statistically empty canary gate

#### Scenario: Platform cannot run parallel versions
- **WHEN** the target deployment platform cannot support blue-green versions
- **THEN** the design states the limitation and approved alternative
- **AND** it does not describe an in-place update as blue-green

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

## ADDED Requirements

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
The canonical policy SHALL retain valid versioned Liftoff frontmatter and the
activation protocol that distinguishes a generated handoff from live
enforcement. Updating the normative baseline SHALL preserve the pushed-repository
prerequisite, read-only Phase 0, explicit conversational approval boundary,
user-owned activation baseline, post-approval spec workflow, and ruleset-last
sequencing.

#### Scenario: Liftoff renders the revised policy
- **WHEN** a project selects the single-maintainer governance profile
- **THEN** the generated policy contains the revised normative baseline and a newer policy version
- **AND** it remains a valid local handoff rather than a claim of live enforcement

#### Scenario: Updated prompt omits Liftoff metadata
- **WHEN** supplied normative policy text lacks Liftoff frontmatter or activation instructions
- **THEN** integration restores the versioned Liftoff envelope
- **AND** the packaged policy validator rejects an artifact that loses the approval or activation-baseline safeguards
