## MODIFIED Requirements

### Requirement: Activation identity uses an explicit compatibility version vector
The engine SHALL distinguish the creating Liftoff semantic version, normative
policy version, activation-contract version, phase-graph schema version and
exact content hash, activation-state schema version, and applicable evidence,
approval-envelope, compatibility-metadata, supersession, and credential-policy
schema versions. For this release line, the managed activation identity SHALL
advance to Liftoff 0.11.0 with manifest artifact 7, supported API and GenAI
readers 2 through 7, policy 6, activation contract 2, phase-graph schema 1
plus a computed content hash, activation-state schema 2, evidence-header
schema 2, approval-envelope schema 2, compatibility-metadata schema 2, and
supersession and credential-policy schemas 1. The generated setup skill SHALL
have no independent manually maintained version, and the graph hash SHALL be
computed from the implemented canonical bytes rather than fabricated in
planning artifacts.

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

#### Scenario: Historical activation v1 is encountered
- **WHEN** the engine reads a preserved activation v1 state or evidence record
- **THEN** it may report the historical identity for diagnosis
- **AND** it does not auto-migrate, delete, or accept that history as current executable proof

### Requirement: Activation state is typed, evidence-backed, and resumable
The system SHALL maintain user-owned activation state using explicit
`pending`, `blocked`, `ready`, `approved`, `running`, `verified`, `failed`,
`inapplicable`, `retained`, and `disposed` states. Every successful completed
phase MUST have the evidence, approval, or validated applicability proof
required by its graph contract. Execution evidence SHALL bind repository identity, stable
local anchor, verified remote binding when required, activation version vector,
phase-graph hash, activation baseline, input digest, and body digest to the
transition. Pending, ready, running, blocked, or failed states SHALL NOT be
interpreted as successful proof. Establishing a stable local anchor SHALL require an explicitly
executed local transition; inspection of an uninitialized project SHALL remain
unbound. Only matching verified remote bindings permit remote evidence reuse.

#### Scenario: Setup is invoked repeatedly
- **WHEN** `/liftoff-setup` or governance `resume` runs after verified phases exist
- **THEN** completed phases remain no-ops
- **AND** the next ready phase is reported, with execution occurring only through a separate explicit executable transition

#### Scenario: Evidence is missing or stale
- **WHEN** a completed task lacks evidence or its activation identity, baseline SHA, graph hash, or input digest differs
- **THEN** the phase becomes blocked for reconciliation
- **AND** no downstream mutation is authorized

#### Scenario: Evidence contradicts a task checkbox
- **WHEN** a task is checked but its authoritative evidence reports `pending`, `failed`, or a missing prerequisite
- **THEN** verification reports the mismatch and expected projection without modifying the task file
- **AND** correction is allowed only within an explicitly planned local execution whose graph contract permits that write

#### Scenario: Remote binding changes after local anchoring
- **WHEN** a later run finds that the repository's verified remote binding differs from the binding used by reusable remote evidence
- **THEN** the local anchor remains intact for local history
- **AND** remote evidence tied to the previous binding is not reused as current proof

### Requirement: Setup completes the generated baseline before governance
The engine SHALL require the generated local baseline handoff to be complete
before initial commit, push, and governance Phase 0. For OpenSpec, the
generated `bootstrap-<project>` change MUST be planning-complete, strict-valid,
locally verified, spec-synced, and archived. For Spec Kit, the explicit
project-owned bootstrap spec, plan, and tasks and the official framework
initialization markers MUST be validated; local task finalization and a
baseline receipt MUST follow successful applicable checks without inventing
an OpenSpec directory or archive operation. It SHALL
never create a second governance change while an unresolved seed or governance
change makes ownership ambiguous.

#### Scenario: Generated seed is ready
- **WHEN** every applicable baseline check passes for an OpenSpec project
- **THEN** setup marks the deterministic seed tasks complete, syncs its delta spec, and archives the change
- **AND** validates the complete synchronized OpenSpec set with `openspec validate --all --strict`
- **AND** records that no product behavior or live infrastructure was implemented

#### Scenario: Spec Kit baseline is ready
- **WHEN** every applicable local baseline check passes for a Spec Kit project
- **THEN** setup finalizes only the explicit project-owned bootstrap task projection and records the local baseline receipt
- **AND** it does not call OpenSpec archive or fabricate archived-change evidence

#### Scenario: Spec Kit has templates but no bootstrap bundle
- **WHEN** official Spec Kit initialization markers exist but the explicit bootstrap spec, plan, or tasks are absent
- **THEN** setup reports a specific seed-adoption blocker without counting templates as completed project work
- **AND** it does not create missing seed files through read-only inspection, ordinary update, or force

#### Scenario: Post-archive strict validation fails
- **WHEN** archive succeeds but the synchronized main specs fail strict validation
- **THEN** the current transition returns blocked with the exact validation failure
- **AND** it does not persist a terminal blocker that would prevent retry
- **AND** rerunning setup revalidates the archived seed after the main spec is repaired

#### Scenario: Existing archived evidence references an invalid main capability
- **WHEN** a prior release recorded seed archive evidence but the expected synchronized main capability is missing or has a fallback Purpose
- **THEN** readiness blocks `seed-archived` and every dependent transition
- **AND** verification identifies the archived capability integrity failure

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
The engine SHALL run the project-applicable `liftoff validate`, backend tests,
frontend build, `docker compose config -q`, `tofu fmt -check -recursive`,
`tofu init -backend=false`, `tofu validate`, and strict workflow checks before
baseline verification is recorded. For OpenSpec it SHALL validate an active
change by name and an archived seed through the synchronized spec set with
expected-capability integrity checks. For Spec Kit it SHALL validate the
explicit project-owned bootstrap bundle and official initialization markers,
run its applicable local checks, and
record a local baseline receipt only after success. Existing receipts SHALL
be validated on reuse, not required before the first baseline run. It SHALL
not ask OpenSpec to validate or archive a Spec Kit change. It SHALL not
require a live cloud plan, start containers, deploy, or mutate GitHub. Project
paths SHALL resolve consistently on Windows, macOS, and Linux.

#### Scenario: API project has a frontend and OpenTofu
- **WHEN** baseline setup runs
- **THEN** all applicable listed checks execute using generated commands
- **AND** success is recorded without cloud credentials or remote backend access

#### Scenario: Workload omits a component
- **WHEN** a generated workload has no frontend, Docker, or OpenTofu boundary
- **THEN** its check is recorded as inapplicable rather than simulated

#### Scenario: Baseline validation fails
- **WHEN** any applicable command fails
- **THEN** the current seed lifecycle is preserved and initial commit and push remain blocked
- **AND** no verified baseline evidence is created

#### Scenario: Seed was archived before activation began
- **WHEN** the generated bootstrap seed is already archived and no activation state exists
- **THEN** setup executes seed validation, all applicable baseline checks, and archived-spec validation through the normal phase sequence
- **AND** it does not ask OpenSpec to validate an inactive change name
- **AND** it stops at the initial publication approval gate without rewriting the archive or mutating remotes

#### Scenario: Spec Kit baseline is finalized locally
- **WHEN** baseline setup runs for a Spec Kit project with no live governance state
- **THEN** it evaluates the applicable local checks, project-owned bootstrap bundle, and official initialization markers
- **AND** it does not create a fake OpenSpec change, archive, or inactive-change validation request

#### Scenario: Retry an archived baseline after repair
- **WHEN** an archived seed has a persisted blocked baseline phase and its expected main capability is intact
- **THEN** read-only status, plan, and resume may expose that phase as retryable while preserving the stored blocker
- **AND** only an explicit executable transition reruns all applicable checks and records new evidence after success
- **AND** invalid identity, stale or failed predecessor evidence, and unrelated blockers remain enforced

#### Scenario: Archived capability is missing or invalid
- **WHEN** the expected main capability is missing or has a fallback Purpose
- **THEN** baseline verification fails without declaring completion or creating duplicate seed artifacts

#### Scenario: Archived setup runs from a path with spaces on Windows
- **WHEN** setup is invoked from a project directory containing spaces on Windows, macOS, or Linux
- **THEN** baseline commands receive the correct project or component working directory as a separate path value
- **AND** archived validation uses the synchronized spec set without platform-dependent path assumptions

### Requirement: Setup exposes strict project-aware commands
The CLI SHALL expose project-aware governance `status`, `plan`, `apply-next`,
`resume`, and `verify` operations with versioned JSON output and strict
command-specific arguments. The slash skill SHALL call these operations rather
than infer phase completion itself. It SHALL use `apply-next --json` as a
read-only preview and SHALL use `apply-next --json --execute` only after the
reported transition is ready and approval status is `not-required` or `reused`.
`status`, `plan`, and `resume` SHALL remain read-only. Planning SHALL validate
each proposed operation against the selected phase graph and mutation contract,
and execution SHALL validate the completed outcome and required live proof
before persisting success. Only `apply-next --json --execute` MAY rerun a
blocked local seed, baseline, or archive transition.

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

#### Scenario: Apply-next is previewed
- **WHEN** governance `apply-next --json` runs without `--execute`
- **THEN** the engine reports the selected transition and exact permitted mutations
- **AND** writes no activation state, evidence, approval, or remote resource

#### Scenario: Apply-next is executed
- **WHEN** governance `apply-next --json --execute` runs for a ready approval-free or approved phase
- **THEN** the engine executes at most that one phase
- **AND** writes authoritative evidence and activation state for the result

#### Scenario: Resume is used after a local baseline failure
- **WHEN** governance `resume --json` is run for a blocked local seed, baseline, or archive phase
- **THEN** it reports the retryable blocker and the exact next executable transition
- **AND** it does not rerun checks or write new evidence until `apply-next --json --execute` is invoked

#### Scenario: Planned operation is not allowed by the phase graph
- **WHEN** a requested transition would mutate resources outside the ready phase's declared contract
- **THEN** preview and execution both block the transition
- **AND** no success state or evidence is persisted

#### Scenario: Verify is requested
- **WHEN** governance `verify` runs
- **THEN** it validates the phase graph, state, evidence, task projection, policy version, active-change identity, and live readback requirements without inventing completion
- **AND** reports consistency separately from setup status and completion

#### Scenario: Not-started state is consistent
- **WHEN** governance `verify --json` finds a valid deterministic not-started view
- **THEN** verification status is `consistent` while setup status is `not-started`
- **AND** `complete` is false even though `ok` remains true

#### Scenario: Phase has a forbidden terminal result
- **WHEN** authoritative state or evidence gives a phase a terminal result not declared by that phase
- **THEN** verification reports the state as inconsistent
- **AND** readiness blocks the phase so no dependent transition can execute
- **AND** setup completion remains false

#### Scenario: Governance state cannot be inspected
- **WHEN** governance `verify --json` encounters a malformed graph, state, evidence, or policy artifact
- **THEN** it reports `verificationStatus` as `inconsistent` and `setupStatus` as `indeterminate`
- **AND** `complete` is false

## ADDED Requirements

### Requirement: Readiness uses authoritative proof and the selected applicable path
Readiness SHALL distinguish current authoritative evidence from informational historical records and contradictions. Unknown applicability SHALL remain unresolved rather than becoming false or inapplicable. An alternative dependency SHALL require successful proof from the selected applicable path; skipping the unselected path SHALL NOT satisfy that prerequisite.

#### Scenario: Fresh evidence coexists with stale history
- **WHEN** one valid current evidence selection exists alongside older stale records
- **THEN** the current selection determines readiness and old records remain informational
- **AND** status, readiness, doctor, and verification do not disagree solely because old records were preserved

#### Scenario: Current evidence is contradictory
- **WHEN** equally authoritative current records contradict one another under the same selection precedence
- **THEN** the phase and dependent execution remain blocked with the conflict identified

#### Scenario: Private applicability has not been established
- **WHEN** private-DAST or credential applicability lacks current validated facts
- **THEN** it remains unknown and cannot skip required proof as if explicitly inapplicable

#### Scenario: Unselected backend path is inapplicable
- **WHEN** the selected existing-private path is blocked and the unselected import path is inapplicable
- **THEN** remote readiness remains blocked until the selected path supplies successful required proof

#### Scenario: Outcome cannot satisfy its own evidence contract
- **WHEN** an executor returns success without required body binding or independent live readback
- **THEN** the outcome is blocked before successful state/evidence persistence rather than failing only on a later inspection

### Requirement: Authority-gated execution binds exact approval timing and Git destinations
Any approval reused for publication, remote mutation, or another
authority-gated transition SHALL match the current reviewed identity and
baseline and contain the planned operation within its destinations,
permissions, resource types, destructive scope, cost ceiling, and valid time
window without expansion. Narrower operations within that envelope SHALL
remain reusable. Git publication
planning MUST bind the actual push destinations, reject differing or multiple
unresolved push URLs, honor ignored paths during initial staging, and re-read
the reviewed destination before mutation.

#### Scenario: Future-dated approval cannot be reused
- **WHEN** an approval's `approvedAt` is in the future, its expiry is missing or invalid, or `now` is outside the approved interval
- **THEN** the transition requires new explicit approval
- **AND** setup does not treat the prior envelope as reusable authorization

#### Scenario: Push destination changes after review
- **WHEN** the reviewed Git push destination differs from the current destination or multiple unresolved push URLs exist when publication is about to run
- **THEN** publication blocks and reports the exact destination mismatch
- **AND** it does not push to an unreviewed remote or rewrite the stored approval

#### Scenario: Ignored paths affect initial staging
- **WHEN** initial publication excludes ignored paths from the reviewed change set
- **THEN** the plan binds only the actual staged payload and reviewed destination
- **AND** a later destination or payload change requires a fresh plan and approval
