## MODIFIED Requirements

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
