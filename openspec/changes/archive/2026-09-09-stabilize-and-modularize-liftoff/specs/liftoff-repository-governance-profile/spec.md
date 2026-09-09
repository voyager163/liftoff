## MODIFIED Requirements

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

### Requirement: Updated policy content preserves the Liftoff activation envelope
The canonical policy SHALL retain valid versioned Liftoff frontmatter, carry
normative policy version 6, and preserve the activation protocol that
distinguishes a generated handoff from live enforcement. Updating the normative
baseline SHALL preserve the pushed-repository prerequisite, read-only Phase 0,
explicit conversational approval boundary, user-owned activation baseline,
post-approval spec workflow, and ruleset-last sequencing. Required controls
that remain unavailable or unsupported SHALL stay visible as gaps or blockers
rather than being silently removed or weakened to obtain a green outcome.

#### Scenario: Liftoff renders the revised policy
- **WHEN** a project selects the single-maintainer governance profile
- **THEN** the generated policy contains the revised normative baseline and policy version 6
- **AND** it remains a valid local handoff rather than a claim of live enforcement

#### Scenario: Updated prompt omits Liftoff metadata
- **WHEN** supplied normative policy text lacks Liftoff frontmatter or activation instructions
- **THEN** integration restores the versioned Liftoff envelope
- **AND** the packaged policy validator rejects an artifact that loses the approval or activation-baseline safeguards

#### Scenario: Unsupported control coverage remains explicit
- **WHEN** repository-scope implementation cannot yet observe or execute a required control family
- **THEN** the rendered policy keeps that control and its requirement visible as unavailable or blocked
- **AND** it does not rewrite the baseline to claim the control is optional

### Requirement: Required checks and rulesets are activated fail-closed
The post-approval implementation SHALL author workflows and repository
source-of-truth files before installing rulesets. Every required context SHALL
be observed reaching success on all applicable protected ref families and
deliberately reaching failure for a controlled violation. The managed policy
SHALL bind applicable required contexts explicitly for `develop`, `main`,
`release/*`, and `hotfix/*` rather than assuming one permanent-branch binding
covers every protected ref. Rulesets SHALL be installed last through idempotent
repository-scoped automation and read back from GitHub after application.

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

#### Scenario: Release and hotfix bindings differ
- **WHEN** a proposed required context applies differently to `release/*` and `hotfix/*` than to `main` or `develop`
- **THEN** the implementation records those ref-family bindings explicitly and validates each applicable family before ruleset installation
- **AND** unproven or missing bindings keep activation blocked

#### Scenario: Apply rulesets twice
- **WHEN** the approved idempotent apply operation runs a second time against matching live rulesets
- **THEN** it performs no destructive replacement
- **AND** live read-back still matches the committed exact rule payloads
