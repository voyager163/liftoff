## Purpose

Provide a deterministic, resumable governance activation engine so every
supported agent follows the same phase dependencies, evidence gates, approvals,
and credential contract without relying on model interpretation.

## Requirements

### Requirement: Activation identity uses an explicit compatibility version vector
The engine SHALL distinguish CLI, activation package, policy, activation contract, graph, state, evidence, approval, compatibility, supersession, and credential-policy identities. The revised execution family SHALL use activation package `0.12.0`, manifest artifact 7, policy 6, activation contract 3, graph schema 2 with its computed hash, state/evidence/approval schemas 3, and compatibility metadata schema 4. Unchanged supersession and credential-policy formats SHALL remain schema 1. Existing v1/v2 source identities SHALL be read only through their declared historical contracts and advanced only through approved successor lanes. No setup-skill version or invented graph hash SHALL be introduced.

#### Scenario: A CLI patch changes no governance contract
- **WHEN** implementation leaves phase/proof semantics, representations, and graph bytes unchanged
- **THEN** only the applicable release metadata changes
- **AND** current proof is not retagged solely because CLI SemVer changed

#### Scenario: Normative governance behavior changes
- **WHEN** a fixed policy requirement changes
- **THEN** policy identity advances and affected work requires reconciliation

#### Scenario: Activation behavior changes
- **WHEN** ordering, approvals, permitted effects, proof, or recovery semantics change
- **THEN** the activation contract and compatibility declarations identify the new executable combination

#### Scenario: A serialized representation changes incompatibly
- **WHEN** graph/state/evidence/approval or compatibility representation changes
- **THEN** its schema advances and unsupported readers fail before mutation

#### Scenario: Managed graph bytes change without compatible identity
- **WHEN** graph bytes lack their required version/hash treatment
- **THEN** release validation fails instead of accepting an invented or stale hash

#### Scenario: Future activation identity is encountered
- **WHEN** an unsupported future identity is read
- **THEN** it is rejected for execution without rewriting its history

#### Scenario: Historical activation v1 is encountered
- **WHEN** a known v1 source is encountered
- **THEN** it remains diagnostic-only until a declared reviewed successor is created
- **AND** update preview, not manual version editing, identifies the supported path

#### Scenario: Historical activation v2 is encountered
- **WHEN** current-contract execution encounters a supported v2 source
- **THEN** original state, evidence, plans, and approvals are preserved under the successor migration contract
- **AND** old success or consent is not relabeled as v3 authority

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
The engine SHALL retain explicit pending, blocked, ready, approved, running, verified, failed, inapplicable, retained, and disposed phase outcomes, together with plannable/approval and external-operation progress. Current success SHALL require the revised graph's exact evidence, scope, approval, applicability, and current readback. Proof SHALL bind the execution identity, graph, inputs, reviewed operation, actual producer/run, body, and relevant resource/backend/artifact identities. Historical v1/v2 records SHALL remain immutable source history, not automatically current v3 proof. Partial external effects SHALL remain inspectable and recoverable.

#### Scenario: Setup is invoked repeatedly
- **WHEN** current verified work still satisfies the requested contract
- **THEN** inspection identifies it without repeating mutations
- **AND** new execution remains an explicit supported operation

#### Scenario: Evidence is missing or stale
- **WHEN** a completed task lacks current correctly bound proof
- **THEN** its dependent effect remains blocked until supported revalidation or recovery

#### Scenario: Evidence contradicts a task checkbox
- **WHEN** a checked task conflicts with authoritative proof
- **THEN** verification reports the mismatch without treating the checkbox as authority
- **AND** any correction follows an explicitly planned permitted operation

#### Scenario: Remote binding changes after local anchoring
- **WHEN** current verified repository/resource/backend binding differs from prior proof
- **THEN** the stable local history is preserved and stale remote proof is not reused

#### Scenario: Successor is not automatically verified
- **WHEN** an approved successor is created from v1/v2 history
- **THEN** required current proof is established through the declared revalidation/readback path
- **AND** historical success or approval is not translated into permission to mutate current resources

#### Scenario: A remote operation is partially complete
- **WHEN** the producer cannot finish after persisted effects
- **THEN** current state retains exact operation/checkpoint identity and required recovery
- **AND** failure does not erase the effects or authorize a blind retry

#### Scenario: A planned transition changes tracked source
- **WHEN** approved workflow publication or configuration cutover produces its expected reviewed outputs
- **THEN** current proof binds the authorized before/after transition and refreshes affected checks
- **AND** the engine does not reject its own expected write or invalidate unrelated proof through an unqualified global digest change

#### Scenario: A source change was not planned
- **WHEN** an input or output differs outside the approved transition
- **THEN** the affected plan and dependent proof remain blocked
- **AND** generated-file status does not exempt the change from integrity checks

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
The engine SHALL derive settled defaults and discovered facts without asking the developer to choose them again. It SHALL prompt only for exact local/stateful repair, protected state inspection, independent machine/dependency/profile permissions, scoped discovery/authentication, publication, credential enrollment, billed infrastructure or permitted policy exceptions, final enforcement, destructive/recovery effects, or an external platform prerequisite. Approval SHALL bind exact operations, destinations, permissions, bounded costs, expiry, and recovery scope. Local, stateful, and activation approval SHALL not substitute for one another.

#### Scenario: Retry remains inside an approval envelope
- **WHEN** revised activation work changes no approved resource type, destination, permission, cost ceiling, destructive effect, or policy exception
- **THEN** the plan can be regenerated and verified under the existing valid activation envelope without repeating its approval
- **AND** this does not authorize a changed project-repair fingerprint

#### Scenario: Retry expands authority
- **WHEN** a retry adds a resource, permission, cost, policy exemption, subscription, or destructive action outside its authorization
- **THEN** setup stops for new explicit approval

#### Scenario: A settled default is available
- **WHEN** policy defines runner size, state retention, credential name, provider behavior, or another applicable default
- **THEN** setup uses it without asking the developer to choose again

#### Scenario: Local repair is proposed
- **WHEN** local conformance requires an approved project-file transformation
- **THEN** setup presents the exact repair plan and its independent prerequisite permissions
- **AND** it does not require unrelated publication or infrastructure-cost approval for local file work

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
The CLI SHALL expose project-aware scoped governance planning, approval, execution, enrollment, inspection, recovery, and verification. Native setup SHALL use these operations for an end-to-end journey while preserving explicit local/activation/lifecycle boundaries. Inspection SHALL not mutate project or provider state; approval-oriented planning can save a disclosed external preview. Apply-next SHALL execute at most one currently authorized graph phase. Local revalidation, activation, and stateful repair SHALL each use their own exact operation/authority contracts, never permission inferred from another scope.

#### Scenario: Developer runs the slash skill
- **WHEN** setup is invoked from a project subdirectory through a supported agent's native integration
- **THEN** it resolves the project, begins with local readiness, and guides the requested approved journey through the declared stage boundaries

#### Scenario: Status is requested
- **WHEN** governance status runs
- **THEN** output identifies identity, graph, active change, phase states, blockers, approval/freshness, migration/repair progress when present, and supported next actions
- **AND** local completion and activation completion are separately reported

#### Scenario: Apply-next is requested
- **WHEN** multiple phases appear ready
- **THEN** the engine selects only phases in the requested scope satisfying current dependencies and approvals and reports their permitted mutation

#### Scenario: Approval is missing but a plan is possible
- **WHEN** current dependencies and required inputs establish a plannable phase
- **THEN** its preview is available before approval is granted
- **AND** execution readiness remains false until the exact required authority is persisted

#### Scenario: Apply-next is previewed
- **WHEN** apply-next runs without `--execute`
- **THEN** it reports the transition without writing state, evidence, approvals, preview receipts, or provider resources

#### Scenario: Apply-next is executed
- **WHEN** a ready phase is explicitly executed with its current approval satisfied
- **THEN** at most that phase executes and its outcome is validated before successful persistence
- **AND** a new inspection supplies post-operation readiness

#### Scenario: Resume is used after a local baseline failure
- **WHEN** resume inspects a blocked local phase
- **THEN** it reports the retryable blocker and explicit next action without rerunning work
- **AND** update-migration or project-repair revalidation is routed to its actual supported preview rather than a generic migration remedy

#### Scenario: Planned operation is not allowed by the phase graph
- **WHEN** an operation exceeds the phase contract or selected scope
- **THEN** preview and execution block without successful evidence
- **AND** update or repair approval does not override that contract

#### Scenario: Verify is requested
- **WHEN** governance verify runs
- **THEN** it evaluates shared identity/integrity and the selected scope's current evidence, task projection, policy, source-of-truth, and applicable readback requirements
- **AND** reports scope-specific consistency separately from completion

#### Scenario: Not-started state is consistent
- **WHEN** verify finds a valid not-started view
- **THEN** it reports consistent but incomplete selected scope without manufacturing evidence

#### Scenario: Phase has a forbidden terminal result
- **WHEN** state/evidence declares a terminal result outside its phase contract
- **THEN** verification reports the inconsistency and dependent execution remains blocked

#### Scenario: Governance state cannot be inspected
- **WHEN** required shared graph, state, identity, policy, or referenced history is malformed
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

### Requirement: Local setup has a finishable independent completion boundary
Local setup SHALL consist of valid current project and selected-framework integrations, compatible selected agents and required local tools, and fresh successful `seed-valid`, `seed-verified`, and `seed-archived` proof. Spec Kit SHALL retain its local finalization semantics. Commit, push, Phase 0, credentials, cloud infrastructure, enforcement, and retained-state disposal SHALL remain activation work and SHALL not be prerequisites for local completion.

#### Scenario: Finish a fresh local project
- **WHEN** all applicable local requirements and local phase proofs are current and successful
- **THEN** setup reports local completion even with no Git remote, publication approval, cloud credentials, or live enforcement
- **AND** activation is separately not started or blocked rather than falsely complete

#### Scenario: External activation prerequisites are unavailable
- **WHEN** real permissions, quota, account capabilities, or execution-path requirements block activation
- **THEN** local completion remains visible and the next external prerequisite is explicit
- **AND** an unimplemented required producer is not substituted for a supported activation capability

#### Scenario: Local infrastructure still needs repair
- **WHEN** an applicable local baseline lacks a supported infrastructure recipe or other required local input
- **THEN** local setup remains incomplete and identifies the supported repair or discovery path
- **AND** separation from activation does not silently skip required local checks

#### Scenario: Shared state is malformed
- **WHEN** a shared activation identity or state cannot be validated
- **THEN** local scope reports the integrity failure rather than declaring completion by ignoring the malformed input

### Requirement: Local scope cannot authorize publication or cloud work
The engine SHALL enforce the explicit local phase/operation boundary during planning and immediately before execution. Existing approvals, injected adapters, repaired provenance, and a completed local baseline SHALL not expand local execution into activation. Explicit activation scope SHALL retain the canonical graph and existing authority requirements.

#### Scenario: Publication approval already exists
- **WHEN** local setup completes in a project with a valid commit or push approval
- **THEN** local apply-next selects no publication phase and performs no Git mutation

#### Scenario: A producer returns an out-of-scope operation
- **WHEN** a local operation attempts a provider, credential, publication, or enforcement mutation
- **THEN** execution rejects it before the out-of-scope effect
- **AND** no successful local proof is recorded for that operation

### Requirement: Setup repairs through supported operations and resumes on actual progress
Generated setup integrations SHALL use structured supported actions to preview repairs, obtain independent approval, apply only eligible scope, and re-inspect before continuing local verification. They SHALL not prescribe manual machine-metadata edits, invent commands, or repeatedly retry unchanged failures. Consistent incomplete verification is progress information, not a fatal execution error or approval.

#### Scenario: Repairable layout blocks setup
- **WHEN** the CLI identifies a supported local repair candidate
- **THEN** the integration explains the project-bound repair preview and its approval/eligibility requirements
- **AND** it does not ask the developer to copy a fresh infrastructure tree or manufacture provenance

#### Scenario: Repair changes earlier local inputs
- **WHEN** a committed repair makes prior local evidence stale
- **THEN** setup reruns only the normal local phases that need fresh proof
- **AND** any subsequent activation or stateful migration requires its own approved scope

#### Scenario: A repair or installer makes no progress
- **WHEN** the same observed inputs and blocker remain after an attempted remedy
- **THEN** the integration reports the unresolved cause or newly supported alternative
- **AND** it does not repeat the same operation without changed inputs or new authorization

### Requirement: Supported activation phases have production producers
The release SHALL implement real producers for publication, complete Phase 0, approval persistence, secure credentials, provider readiness, state/runner bootstrap, application prerequisites/artifacts/deployment, qualification, enforcement, recovery, and due lifecycle work for its advertised supported Azure/GitHub profile. Each producer SHALL use bounded operations, independent current readback, exact owned scope, and an honest persisted outcome. Placeholder success, test-injected-only adapters, and missing executors SHALL not qualify the supported end-to-end path.

#### Scenario: Activate a supported fresh project
- **WHEN** the project and account satisfy the supported profile and all required approvals are granted
- **THEN** the engine performs actual required production operations through verified live enforcement
- **AND** the result is not inferred from generated files or successful command submission

#### Scenario: A provider request is still running
- **WHEN** an external operation exceeds a bounded polling interval without a terminal result
- **THEN** the engine records its actual operation/run identity and reports pending resumable work
- **AND** it does not hang indefinitely, dispatch a duplicate operation, or claim success

#### Scenario: An operation partly changes resources
- **WHEN** a producer fails after a known external effect
- **THEN** the effect and recovery boundary remain recorded
- **AND** a local file rollback is not presented as undoing that external effect

### Requirement: The graph represents publication artifact and deployment prerequisites
The revised graph SHALL declare real workflow publication/dispatch, registry/artifact publication, provider/state, and recovery effects explicitly. Required bootstrap verification workflows SHALL precede their credential-use proof; application prerequisites and immutable artifacts SHALL precede dependent deployment. Provider readiness SHALL apply to all planned resource namespaces, not be skipped solely because private DAST is inapplicable. Conditional private networking SHALL require actual applicability and reachability proof.

#### Scenario: Deploy a generated application
- **WHEN** application deployment is planned
- **THEN** the graph requires a verified real artifact digest and its registry/identity prerequisites
- **AND** a placeholder bootstrap image does not satisfy application deployment proof

#### Scenario: Verify an enrolled runner credential
- **WHEN** actual workflow consumption is required to establish readiness
- **THEN** the graph can publish and run the required minimal verification workflow before later infrastructure depends on that credential
- **AND** a secret name or policy file alone is insufficient

#### Scenario: DAST is inapplicable
- **WHEN** current facts show private DAST is not required but Azure resources are planned
- **THEN** unnecessary private runner resources are omitted
- **AND** provider and backend readiness required by the actual cloud plan are still enforced

### Requirement: Activation requires genuine qualification and live enforcement proof
Activation completion SHALL require the approved source/artifact deployment, applicable workload health and qualification, actual required-context green and controlled-red proof, final enforcement approval, and matching live readback. Source, workflow/run, artifact, environment/ref, principal, and current resource bindings SHALL be verified. A required skipped/cancelled/neutral check, synthetic success, or stale/partial readback SHALL not satisfy the gate.

#### Scenario: Required checks have only passed locally
- **WHEN** no current live run proves a required context on its applicable protected ref families
- **THEN** enforcement remains blocked

#### Scenario: Live rulesets match the approved source
- **WHEN** current qualification and exact final approval are valid and live readback matches source
- **THEN** activation can be reported complete
- **AND** pending future retention work is reported separately

### Requirement: Lifecycle and recovery do not corrupt activation history
Delayed disposal SHALL have a due time, exact owned scope, executable path, and independent progress. Read-only inspection SHALL not delete retained data. Recovery SHALL inspect actual checkpoints and remain within a preauthorized compensation boundary or obtain new authority for expansion. It SHALL never rewrite successful historical facts, force past newer state, or require failed release checks to pass before an already authorized emergency rollback.

#### Scenario: Retention is still active
- **WHEN** live activation is verified but the retention deadline is in the future
- **THEN** activation remains verified and lifecycle work is pending
- **AND** retained state cannot be used for normal plan/apply

#### Scenario: Cleanup is due but its host is unavailable
- **WHEN** the exact authorized cleanup operation cannot run
- **THEN** lifecycle is reported due or overdue with a supported next action
- **AND** disposal is not marked complete or performed from a different unapproved location

#### Scenario: Recovery would overwrite a concurrent change
- **WHEN** backend or project recovery preconditions no longer match
- **THEN** recovery pauses for reconciliation rather than blindly restoring a backup
