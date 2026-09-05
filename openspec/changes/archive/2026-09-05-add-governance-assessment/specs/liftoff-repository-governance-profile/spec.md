## MODIFIED Requirements

### Requirement: The selected profile generates one canonical managed-core handoff
The system SHALL render a versioned canonical policy, schema-versioned workload
context, activation guide, and thin setup and read-only assessment launchers for
each selected coding agent as explicitly named managed-core Liftoff artifacts.
The policy and context SHALL live under `.liftoff/governance`; Copilot launchers
SHALL use their reserved explicit GitHub prompt paths and Claude launchers SHALL
use their reserved explicit Claude command paths. Launchers SHALL reference the
canonical files and CLI instead of duplicating policy or evaluation logic.
`/liftoff-setup` SHALL remain the sole setup entry point; the assessment
integration SHALL not be a setup alias.

#### Scenario: Generate for Copilot and Claude
- **WHEN** a project selects `single-maintainer-gitflow`, GitHub Copilot, and Claude Code
- **THEN** the project contains the canonical policy, context, guide, and both setup and assessment launchers for each selected agent
- **AND** each file has a stable logical name and manifest content hash

#### Scenario: Generate for one agent
- **WHEN** a project selects only GitHub Copilot
- **THEN** Liftoff renders the canonical handoff and Copilot setup and assessment launchers
- **AND** it does not render or require Claude launchers

#### Scenario: Render paths cross-platform
- **WHEN** the same governed plan is rendered on Windows, macOS, and Linux
- **THEN** every governance artifact has identical bytes, logical names, and OS-neutral path parts
- **AND** filesystem access uses host-native path resolution

#### Scenario: Framework owns neighboring files
- **WHEN** the official spec-framework initializer creates other files under `.github` or `.claude`
- **THEN** Liftoff owns only its explicitly named governance launchers
- **AND** does not select neighboring files for validation, update, replacement, or deletion by directory pattern

### Requirement: Agent activation begins with read-only Phase 0
The generated setup launchers SHALL instruct the selected agent to require a
committed and pushed repository before governance Phase 0, read the canonical
policy and context, and perform a read-only classification before proposing
changes. Phase 0 SHALL inspect artifact type, languages, package managers,
working build and test commands, branches, default branch, workflows and exact
job names, rulesets, tags, releases, environments, deployments, security
scanning, runner access, monitoring and alert routing, component health depth,
and platform capabilities. When private Staging DAST applies, Phase 0 SHALL also
inspect the repository's Staging subscription, existing runner and network
resources, Azure and GitHub permissions, enterprise network-configuration
policy, address space, private DNS and routing, egress requirements, cost, state
ownership, and teardown authority. It SHALL report gaps, inapplicable controls,
and an ordered plan, then stop for explicit user approval. The separate
read-only assessment SHALL not require commit, push, or activation and SHALL
not satisfy Phase 0 or its approval gate merely by producing a report.

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

#### Scenario: Assess before publication
- **WHEN** a developer requests only a governance assessment on an unpublished Liftoff project
- **THEN** assessment may report local differences and unobserved live controls
- **AND** it does not create a remote, push the repository, or advance Phase 0
