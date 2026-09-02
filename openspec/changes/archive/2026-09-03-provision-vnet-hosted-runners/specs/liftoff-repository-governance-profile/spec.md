## MODIFIED Requirements

### Requirement: Agent activation begins with read-only Phase 0
The generated launchers SHALL instruct the selected agent to require a committed
and pushed repository, read the canonical policy and context, and perform a
read-only classification before proposing changes. Phase 0 SHALL inspect
artifact type, languages, package managers, working build and test commands,
branches, default branch, workflows and exact job names, rulesets, tags,
releases, environments, deployments, security scanning, runner access,
monitoring and alert routing, component health depth, and platform capabilities.
When private Staging DAST applies, Phase 0 SHALL also inspect the repository's
Staging subscription, existing runner and network resources, Azure and GitHub
permissions, enterprise network-configuration policy, address space, private
DNS and routing, egress requirements, cost, state ownership, and teardown
authority. It SHALL report gaps, inapplicable controls, and an ordered plan,
then stop for explicit user approval.

#### Scenario: Run before a remote exists
- **WHEN** an agent is asked to activate governance without a resolvable GitHub repository
- **THEN** it reports the missing prerequisite and performs no mutation

#### Scenario: Complete Phase 0
- **WHEN** the agent can inspect the local project and GitHub repository
- **THEN** it reports every required classification and named gap with evidence
- **AND** identifies controls that are unavailable or meaningless for the workload
- **AND** stops before writing files or changing GitHub or Azure

#### Scenario: User has not approved the plan
- **WHEN** Phase 0 has reported its findings but the user has not explicitly approved the proposed work
- **THEN** the agent does not create a spec change, branch, workflow, ruleset, environment, cloud resource, network configuration, runner group, or larger runner

### Requirement: The single-maintainer profile preserves its fixed governance invariants
The canonical profile SHALL require repository-scoped Vincent Driessen GitFlow
for versioned-release repositories, zero human merge or deployment approvals,
pull requests gated entirely by automated fail-closed checks, no `CODEOWNERS`,
no org-level substitute, the built-in `GITHUB_TOKEN` and GitHub Actions bypass
identity where automation must act, and immutable semantic releases on `main`.
Conditional provisioning of the VNet-injected GitHub-hosted larger runner
required for private Staging DAST SHALL be the only permitted org- or
enterprise-level provisioning exception. The profile SHALL require deviations
for genuine continuous delivery or platform limitations to be reported and
approved rather than silently misrepresented.

#### Scenario: Configure pull-request governance
- **WHEN** an approved governance change defines protected-branch pull-request rules
- **THEN** it sets approving review count to zero and disables code-owner and last-push approval requirements
- **AND** does not create a human approval gate

#### Scenario: Repository scope cannot enforce a control
- **WHEN** a required control other than the approved VNet-injected runner provisioning exception is unavailable at repository scope
- **THEN** the agent reports and omits that control
- **AND** it does not propose an org-level ruleset, required workflow, GitHub App installation, or other org-level substitute

#### Scenario: Repository ships continuously
- **WHEN** Phase 0 proves the repository genuinely uses continuous delivery rather than versioned releases
- **THEN** the agent explains where original GitFlow does not fit
- **AND** it obtains approval for the explicit branch and release adaptation before implementation

#### Scenario: VNet runner prerequisite is unavailable
- **WHEN** private Staging qualification requires DAST and no suitable VNet-injected larger runner is assigned
- **THEN** the agent keeps release qualification blocked and reports whether the narrowly scoped runner stack can be provisioned
- **AND** it does not create a self-hosted runner or generalize the exception to any other org-level control

### Requirement: Security and release policy adapts without duplicate or theatrical controls
The canonical profile SHALL map applicable security stages to the events where
they can run and SHALL use the designated tools: GitHub Secret Protection,
Dependabot and Dependency Review, CodeQL and Copilot Autofix, Checkov, Trivy,
non-gating Grype, OWASP ZAP, GitHub artifact attestations and SLSA provenance,
and OSSF Scorecard. It SHALL omit inapplicable stages, fail when a required
input or runner is absent, prohibit duplicate excluded scanners, and never make
Grype a second blocking gate. Release-candidate SLSA L3 generation SHALL remain
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

## ADDED Requirements

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
