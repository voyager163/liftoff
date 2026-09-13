## MODIFIED Requirements

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

## ADDED Requirements

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
