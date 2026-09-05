## MODIFIED Requirements

### Requirement: Setup completes the generated baseline before governance
The engine SHALL require the generated `bootstrap-<project>` OpenSpec change to
be planning-complete, strict-valid, locally verified, spec-synced, and archived
before initial commit/push and governance Phase 0. It SHALL never create a
second governance change while an unresolved seed or governance change makes
ownership ambiguous.

#### Scenario: Generated seed is ready
- **WHEN** every baseline check passes
- **THEN** setup marks the deterministic seed tasks complete, syncs its delta spec, and archives the change
- **AND** validates the complete synchronized OpenSpec set with `openspec validate --all --strict`
- **AND** records that no product behavior or live infrastructure was implemented

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

### Requirement: Setup exposes strict project-aware commands
The CLI SHALL expose project-aware governance `status`, `plan`, `apply-next`,
`resume`, and `verify` operations with versioned JSON output and strict
command-specific arguments. The slash skill SHALL call these operations rather
than infer phase completion itself. It SHALL use `apply-next --json` as a
read-only preview and SHALL use `apply-next --json --execute` only after the
reported transition is ready and approval status is `not-required` or `reused`.

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
