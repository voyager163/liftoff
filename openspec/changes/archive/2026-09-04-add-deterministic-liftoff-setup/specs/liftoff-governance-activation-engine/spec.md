## Purpose

Provide a deterministic, resumable governance activation engine so every
supported agent follows the same phase dependencies, evidence gates, approvals,
and credential contract without relying on model interpretation.

## ADDED Requirements

### Requirement: Activation identity uses an explicit compatibility version vector
The engine SHALL distinguish the creating Liftoff semantic version, normative
policy version, activation-contract version, phase-graph schema version and
exact content hash, activation-state schema version, and applicable evidence,
approval-envelope, and credential-policy schema versions. The generated setup
skill SHALL have no independent manually maintained version.

#### Scenario: A CLI patch changes no governance contract
- **WHEN** Liftoff fixes implementation behavior without changing policy semantics, phase behavior, JSON shapes, or managed graph bytes
- **THEN** only the Liftoff package semantic version changes
- **AND** compatible activation state resumes without reconciliation

#### Scenario: Normative governance behavior changes
- **WHEN** a fixed governance requirement or decision changes
- **THEN** the policy version advances
- **AND** active setup reconciles affected verified phase evidence

#### Scenario: Activation behavior changes
- **WHEN** phase dependencies, approvals, allowed mutations, evidence semantics, invalidation, or rollback behavior changes
- **THEN** the activation-contract version advances
- **AND** compatibility metadata identifies its supported policy versions

#### Scenario: A serialized representation changes incompatibly
- **WHEN** the graph, activation state, evidence header, approval envelope, or credential policy changes shape incompatibly
- **THEN** the affected schema version advances
- **AND** readers either migrate a supported historical representation transactionally or block it

#### Scenario: Managed graph bytes change without compatible identity
- **WHEN** the phase-graph hash changes without the contract or schema identity required by the compatibility rules
- **THEN** validation fails before release

#### Scenario: Future activation identity is encountered
- **WHEN** an older CLI reads a policy, activation contract, or schema version newer than it supports
- **THEN** setup blocks without rewriting state
- **AND** reports the unsupported identity and upgrade remedy

### Requirement: Governance activation uses one canonical phase graph
The system SHALL package a versioned, machine-readable governance phase graph
whose phase identifiers, dependencies, applicability rules, allowed mutations,
required evidence, approval gates, rollback boundaries, and terminal states are
the source of truth for activation order. Policy prose and generated tasks SHALL
not override the graph.

#### Scenario: Setup starts on a fresh project
- **WHEN** the developer invokes `/liftoff-setup`
- **THEN** the engine loads the phase graph matching the installed managed policy
- **AND** calculates the next ready phase from project state and verified evidence

#### Scenario: A task list reverses dependencies
- **WHEN** an OpenSpec task places remote import before the private execution path required by the phase graph
- **THEN** the engine rejects the transition even if the task checkbox is marked complete

#### Scenario: A phase is inapplicable
- **WHEN** deterministic discovery proves a conditional phase does not apply
- **THEN** the engine records it as `inapplicable` with evidence
- **AND** dependent phases evaluate the declared inapplicability edge rather than inventing placeholder work

### Requirement: Activation state is typed, evidence-backed, and resumable
The system SHALL maintain user-owned activation state using explicit
`pending`, `blocked`, `ready`, `approved`, `running`, `verified`, `failed`,
`inapplicable`, `retained`, and `disposed` states. Every non-pending transition
MUST reference current evidence whose repository identity, activation version
vector, phase-graph hash, activation baseline, and input digest match the
transition.

#### Scenario: Setup is invoked repeatedly
- **WHEN** `/liftoff-setup` or governance `resume` runs after verified phases exist
- **THEN** completed phases remain no-ops
- **AND** execution resumes at the next ready phase

#### Scenario: Evidence is missing or stale
- **WHEN** a completed task lacks evidence or its activation identity, baseline SHA, graph hash, or input digest differs
- **THEN** the phase becomes blocked for reconciliation
- **AND** no downstream mutation is authorized

#### Scenario: Evidence contradicts a task checkbox
- **WHEN** a task is checked but its authoritative evidence reports `pending`, `failed`, or a missing prerequisite
- **THEN** verification fails and the checkbox is corrected as a projection of phase state

### Requirement: Setup completes the generated baseline before governance
The engine SHALL require the generated `bootstrap-<project>` OpenSpec change to
be planning-complete, strict-valid, locally verified, spec-synced, and archived
before initial commit/push and governance Phase 0. It SHALL never create a
second governance change while an unresolved seed or governance change makes
ownership ambiguous.

#### Scenario: Generated seed is ready
- **WHEN** every baseline check passes
- **THEN** setup marks the deterministic seed tasks complete, syncs its delta spec, and archives the change
- **AND** records that no product behavior or live infrastructure was implemented

#### Scenario: Generated seed is incomplete
- **WHEN** its declared capability spec or required artifact is missing
- **THEN** setup reports the generation defect and performs no governance activation

#### Scenario: Another governance change exists
- **WHEN** exactly one compatible active governance change exists
- **THEN** setup resumes and reconciles that change rather than creating another

#### Scenario: Active change ownership is ambiguous
- **WHEN** multiple active governance changes or an unresolved seed overlap the activation scope
- **THEN** setup blocks until an explicit supersession or archive record identifies one source of truth

### Requirement: Baseline verification is local and deterministic
Before archiving the seed, the engine SHALL run the project-applicable
`liftoff validate`, backend tests, frontend build, `docker compose config -q`,
`tofu fmt -check -recursive`, `tofu init -backend=false`, `tofu validate`, and
strict OpenSpec checks. It SHALL not require a live cloud plan, start containers,
deploy, or mutate GitHub.

#### Scenario: API project has a frontend and OpenTofu
- **WHEN** baseline setup runs
- **THEN** all applicable listed checks execute using generated commands
- **AND** success is recorded without cloud credentials or remote backend access

#### Scenario: Workload omits a component
- **WHEN** a generated workload has no frontend, Docker, or OpenTofu boundary
- **THEN** its check is recorded as inapplicable rather than simulated

#### Scenario: Baseline validation fails
- **WHEN** any applicable command fails
- **THEN** the seed remains active and the initial commit/push phase remains blocked

### Requirement: Developer questions are limited to authority gates
The engine SHALL derive settled defaults and discovered facts without asking the
developer. It SHALL prompt only for repository creation or push, credential
enrollment, billed infrastructure or policy-exception approval, final
enforcement, destructive operations, or an external platform blocker. An
approval envelope SHALL identify allowed resource types, destinations,
permissions, cost ceiling, destructive scope, and expiry.

#### Scenario: Retry remains inside an approval envelope
- **WHEN** a revised implementation changes no approved resource type, destination, permission, cost ceiling, destructive effect, or policy exception
- **THEN** setup may regenerate and verify the plan without repeating approval

#### Scenario: Retry expands authority
- **WHEN** a retry adds a resource, permission, cost, policy exemption, subscription, or destructive action outside the envelope
- **THEN** setup stops for a new explicit approval

#### Scenario: A settled default is available
- **WHEN** policy defines runner size, state retention, credential name, provider behavior, or another applicable default
- **THEN** setup uses it without asking the developer to choose again

### Requirement: Runner-preflight credential enrollment is deterministic
When `GITHUB_TOKEN` cannot read required organization runner metadata, the
engine SHALL first consume an existing approved GitHub App installation token
when available, otherwise guide one fine-grained PAT enrollment using the
display name `<repo>-runner-preflight-read`, secret
`RUNNER_CONFIGURATION_READ_TOKEN`, 30-day lifetime, current repository only,
organization hosted-runner and network-configuration read permission,
repository metadata read permission, and no write permission. The value MUST be
entered through a masked channel and MUST NOT appear in chat, command arguments,
logs, evidence, screenshots, or generated files.

#### Scenario: Approved GitHub App is available
- **WHEN** setup verifies a selected-repository installation with the required read permissions
- **THEN** workflows generate short-lived installation tokens
- **AND** no PAT enrollment is requested

#### Scenario: PAT fallback is required
- **WHEN** no approved App is available
- **THEN** setup supplies every fixed field without asking the developer to name or scope the token
- **AND** asks only for secure credential creation and masked enrollment

#### Scenario: Credential policy is recorded
- **WHEN** enrollment succeeds
- **THEN** a payload-free policy records the auth kind, display-name template, secret name, owner, repository, expiry, rotation lead, permissions, allowed workflows and jobs, and non-forwarding rule

#### Scenario: Credential appears in unsafe output
- **WHEN** a credential-shaped value is detected in chat-derived content, logs, evidence, screenshots submitted for processing, or generated files
- **THEN** setup marks the credential compromised, blocks its use, and instructs revocation and rotation

### Requirement: Setup exposes strict project-aware commands
The CLI SHALL expose project-aware governance `status`, `plan`, `apply-next`,
`resume`, and `verify` operations with versioned JSON output and strict
command-specific arguments. The slash skill SHALL call these operations rather
than infer phase completion itself.

#### Scenario: Developer runs the slash skill
- **WHEN** `/liftoff-setup` is invoked from a project subdirectory
- **THEN** it resolves the nearest project root and invokes the deterministic setup engine

#### Scenario: Status is requested
- **WHEN** governance `status --json` runs
- **THEN** output identifies the complete activation version vector and graph hash, active change, current phase states, next ready phase, blockers, approvals, and evidence freshness

#### Scenario: Apply-next is requested
- **WHEN** more than one phase is ready
- **THEN** the engine selects only phases whose declared dependencies and approvals are satisfied
- **AND** reports every permitted mutation before execution

#### Scenario: Verify is requested
- **WHEN** governance `verify` runs
- **THEN** it validates the phase graph, state, evidence, task projection, policy version, active-change identity, and live readback requirements without inventing completion
