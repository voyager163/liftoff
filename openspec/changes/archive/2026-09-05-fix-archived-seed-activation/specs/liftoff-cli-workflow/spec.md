## MODIFIED Requirements

### Requirement: CLI exposes deterministic governance setup commands
The CLI SHALL expose a `governance` command group with `status`, `plan`,
`apply-next`, `resume`, and `verify` subcommands. Commands SHALL use strict
argument validation, project-root discovery, versioned JSON output, responsive
human output, and existing independent consent boundaries. Apply-next SHALL
identify the selected phase and, for execution, the successfully executed phase.
Its legacy `nextReadyPhase` field SHALL retain selection semantics; subsequent
status or verify output SHALL provide post-transition readiness. OpenSpec
failures SHALL include bounded, sanitized diagnostics when safe to display.
Ordinary progress on an intact active bootstrap seed before governance begins
SHALL be reported as incomplete, not inconsistent solely because archival is
pending.

#### Scenario: Run governance status outside a project
- **WHEN** no project manifest can be resolved
- **THEN** the command fails with a project-root remedy and performs no mutation

#### Scenario: Inspect governance identity
- **WHEN** the developer runs a governance command with JSON output
- **THEN** the versioned response identifies the creating Liftoff version, policy version, activation-contract version, applicable schema versions, and phase-graph hash
- **AND** does not report a separate setup-skill version

#### Scenario: Preview next transitions
- **WHEN** the developer runs `liftoff governance plan --json`
- **THEN** output lists ready and blocked phases, evidence, approval requirements, permitted mutations, and cost-envelope impact
- **AND** changes no file or remote resource

#### Scenario: Apply a ready transition
- **WHEN** the developer runs `liftoff governance apply-next --json --execute`
- **THEN** only allowlisted operations for evidence-ready and approved phases execute
- **AND** the result updates user-owned state transactionally

#### Scenario: Preview a ready transition
- **WHEN** the developer runs `liftoff governance apply-next --json` without `--execute`
- **THEN** the command reports the exact operations and required execution flag
- **AND** changes no file or remote resource

#### Scenario: Adapter returns a phase-forbidden terminal result
- **WHEN** a transition adapter returns a result not declared by the selected phase
- **THEN** apply-next records a blocker without writing invalid evidence
- **AND** no dependent transition is authorized

#### Scenario: Verification is consistent before setup starts
- **WHEN** `liftoff governance verify --json` finds no inconsistent state but no activation state exists
- **THEN** `ok` and `consistent` are true while `complete` is false
- **AND** `setupStatus` is `not-started` with the next ready phase

#### Scenario: A valid bootstrap seed is still active
- **WHEN** the generated seed is intact, no competing governance change exists, and no archive or later completion has been recorded
- **THEN** verification reports consistency independently of the pending baseline or archive phases
- **AND** `complete` remains false and publication remains approval-gated

#### Scenario: Active seed contradicts stored archive completion
- **WHEN** activation state already claims the seed was archived but it is still active
- **THEN** verification reports the contradiction as inconsistent
- **AND** it does not treat the seed as ordinary pending bootstrap work

#### Scenario: Verification cannot inspect state
- **WHEN** `liftoff governance verify --json` encounters a malformed governance artifact
- **THEN** `ok` and `consistent` are false while `complete` is false
- **AND** `setupStatus` is `indeterminate`

#### Scenario: Resume after a blocker
- **WHEN** the external blocker evidence has changed
- **THEN** `resume` reruns only the blocker preflight and downstream readiness calculation
- **AND** does not repeat verified operations

#### Scenario: Unsupported governance syntax is supplied
- **WHEN** a misspelled subcommand, unknown flag, or excess positional argument is used
- **THEN** parsing fails before project discovery or mutation

#### Scenario: Distinguish selection from post-transition readiness
- **WHEN** apply-next successfully executes `seed-valid`
- **THEN** `selectedPhase` and `executedPhase` both identify `seed-valid`
- **AND** the subsequent verify response identifies `seed-verified` as the next ready phase
- **AND** failed execution reports no successfully executed phase

#### Scenario: Explain an OpenSpec validation failure
- **WHEN** OpenSpec exits unsuccessfully with a safe diagnostic
- **THEN** the failure includes the command, exit condition, and bounded diagnostic without terminal control sequences

#### Scenario: Diagnostic includes credential-shaped content
- **WHEN** OpenSpec output includes a credential detected by the shared credential policy
- **THEN** the diagnostic is withheld before truncation and the response explains why
- **AND** raw credentials are not copied into JSON, human output, or activation state
