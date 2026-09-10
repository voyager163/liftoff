## Purpose

Provide a deterministic, resumable governance activation engine so every
supported agent follows the same phase dependencies, evidence gates, approvals,
and credential contract without relying on model interpretation.

## Requirements

### Requirement: Activation identity uses an explicit compatibility version vector
The engine SHALL distinguish the activation package identity, CLI semantic version, policy, activation contract, graph schema/hash, state, evidence, approval, compatibility-metadata, supersession, and credential-policy versions. The current execution family SHALL retain activation package identity 0.11.0, manifest artifact 7 with supported API/GenAI readers 2 through 7, policy 6, activation contract 2, graph schema 1 with its actual packaged hash, state/evidence/approval schemas 2, and supersession/credential-policy schemas 1. Compatibility metadata SHALL advance independently to schema 3 to distinguish historical readability, current execution compatibility, and exact approved successor-migration lanes. The setup skill SHALL have no independent manually maintained version.

#### Scenario: A CLI patch changes no governance contract
- **WHEN** implementation changes leave phase/proof semantics, shapes, and graph bytes unchanged
- **THEN** only the applicable package/metadata contract changes
- **AND** compatible current activation proof is not retagged solely because CLI SemVer changed

#### Scenario: Normative governance behavior changes
- **WHEN** a fixed policy requirement or decision changes
- **THEN** the policy version advances and affected verified work requires reconciliation

#### Scenario: Activation behavior changes
- **WHEN** phase dependencies, approval meaning, mutations, evidence semantics, invalidation, or rollback behavior changes
- **THEN** the activation contract advances and compatibility metadata identifies the supported combinations

#### Scenario: A serialized representation changes incompatibly
- **WHEN** a graph, state, evidence, approval, credential, or compatibility representation changes incompatibly
- **THEN** its schema version advances and readers either use an explicitly supported conversion or block it

#### Scenario: Managed graph bytes change without compatible identity
- **WHEN** graph bytes change without the identity/contract treatment required by compatibility
- **THEN** release validation fails rather than inventing a graph hash

#### Scenario: Future activation identity is encountered
- **WHEN** the engine encounters a newer unsupported identity
- **THEN** it blocks without rewriting history and reports the found identity and remedy

#### Scenario: Historical activation v1 is encountered
- **WHEN** the engine reads known v1 state or evidence
- **THEN** that original remains diagnostic-only and cannot execute or authorize current scope
- **AND** a declared successor lane is advertised through `liftoff update --check`, not automatically applied

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
The engine SHALL retain typed pending, blocked, ready, approved, running, verified, failed, inapplicable, retained, and disposed states. Successful phases SHALL have the current graph's required evidence, approval, or applicability proof. Evidence SHALL bind local identity, independently verified remote identity where required, the activation vector, graph, baseline, current inputs, transition, and body. Explicitly approved local successor creation SHALL establish its local anchor without trusting historical remote identifiers. V1 terminal states and approvals SHALL not transfer as current proof. Post-commit migration revalidation failures SHALL remain blocked/resumable v2 rather than restore v1.

#### Scenario: Setup is invoked repeatedly
- **WHEN** fresh verified phases already exist
- **THEN** inspection reports them as complete and identifies the next ready phase
- **AND** execution remains a separate explicit operation

#### Scenario: Evidence is missing or stale
- **WHEN** a completed task lacks fresh correctly bound evidence
- **THEN** the phase and dependent mutation remain blocked

#### Scenario: Evidence contradicts a task checkbox
- **WHEN** a checked task conflicts with authoritative proof
- **THEN** verification reports the mismatch without changing the task
- **AND** any task correction needs an explicitly planned operation whose contract permits it

#### Scenario: Remote binding changes after local anchoring
- **WHEN** the current verified remote binding differs from the binding of old remote evidence
- **THEN** local history retains its stable anchor and that remote evidence is not reused

#### Scenario: Successor is not automatically verified
- **WHEN** migration creates v2 from a historical v1 snapshot
- **THEN** unproven phases and applicability remain pending, blocked, or unknown until current proof establishes them

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
The CLI SHALL retain project-aware governance status, plan, apply-next, resume, and verify with strict arguments and versioned output. The slash skill SHALL use these operations rather than infer completion. Status, plan, resume, verify, and `apply-next` without `--execute` SHALL remain read-only. An explicit ready `apply-next --execute` SHALL execute at most one phase whose current approval is satisfied. The reviewed update coordinator SHALL additionally be able to execute only its finite approved local migration-revalidation operations through the same current operation/evidence constraints; this SHALL not give inspection commands execution authority or permit automatic future provider/authority-gated work.

#### Scenario: Developer runs the slash skill
- **WHEN** setup is invoked from a project subdirectory
- **THEN** it resolves the nearest valid project boundary and calls the deterministic engine

#### Scenario: Status is requested
- **WHEN** governance status runs
- **THEN** output identifies identity, graph, active change, phase states, blockers, approval/freshness, migration progress when present, and the next supported action

#### Scenario: Apply-next is requested
- **WHEN** multiple phases appear ready
- **THEN** the engine selects only phases satisfying current dependencies and approvals and reports their permitted mutation

#### Scenario: Apply-next is previewed
- **WHEN** `apply-next` runs without `--execute`
- **THEN** it reports the transition without writing state, evidence, approvals, preview receipts, or provider resources

#### Scenario: Apply-next is executed
- **WHEN** a ready phase is explicitly executed with its current approval satisfied
- **THEN** at most that phase executes and its outcome is validated before successful persistence

#### Scenario: Resume is used after a local baseline failure
- **WHEN** resume inspects a blocked local phase
- **THEN** it reports the retryable blocker and explicit next action without rerunning work
- **AND** incomplete migration revalidation can instead be previewed through `liftoff update --check`

#### Scenario: Planned operation is not allowed by the phase graph
- **WHEN** an operation exceeds the phase contract
- **THEN** preview and execution block without successful evidence
- **AND** update-plan approval does not override that contract

#### Scenario: Verify is requested
- **WHEN** governance verify runs
- **THEN** it evaluates graph, state, evidence, task projection, policy, active-change identity, applicable live readback, and declared migration links without inventing completion
- **AND** it reports consistency separately from readiness

#### Scenario: Not-started state is consistent
- **WHEN** verify finds a valid not-started view
- **THEN** it may be consistent while setup remains not-started and incomplete

#### Scenario: Phase has a forbidden terminal result
- **WHEN** state/evidence declares a terminal result outside its phase contract
- **THEN** verification is inconsistent and dependent readiness remains blocked

#### Scenario: Governance state cannot be inspected
- **WHEN** active graph, state, evidence, policy, or declared migration metadata is malformed
- **THEN** verification reports an inconsistent, indeterminate, incomplete result
- **AND** it does not fall back to preserved history as current state

#### Scenario: An update revalidation plan reaches its boundary
- **WHEN** its next operation requires new inputs, independent approval, provider access, or an unavailable producer
- **THEN** the coordinator stops and reports the next separately reviewed action

### Requirement: Readiness uses authoritative proof and the selected applicable path
Readiness SHALL distinguish current authoritative evidence, informational history, and current contradictions. Validated retained v1 snapshots SHALL never become execution proof and SHALL not poison a valid current v2 selection merely by existing. Unknown applicability SHALL remain unresolved. Alternative dependencies SHALL require successful proof from the selected applicable path. Migration completion alone SHALL not make governance complete.

#### Scenario: Fresh evidence coexists with stale history
- **WHEN** valid current proof exists alongside retained historical records
- **THEN** it determines readiness consistently across status, doctor, verification, and assessment

#### Scenario: Current evidence is contradictory
- **WHEN** equally authoritative current records disagree
- **THEN** the phase and dependent execution remain blocked

#### Scenario: Private applicability has not been established
- **WHEN** current validated facts do not establish private-DAST or credential applicability
- **THEN** it remains unknown rather than skipping the required proof

#### Scenario: Unselected backend path is inapplicable
- **WHEN** the selected path is blocked and another path is inapplicable
- **THEN** the inapplicable path does not satisfy the selected dependency

#### Scenario: Outcome cannot satisfy its own evidence contract
- **WHEN** an executor reports success without the required body binding or independent proof
- **THEN** that result is blocked before successful state/evidence persistence

#### Scenario: Migration committed but work remains
- **WHEN** the linked successor exists but later phases lack current proof
- **THEN** local migration is reported as committed while governance remains incomplete

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
