## MODIFIED Requirements

### Requirement: CLI exposes deterministic governance setup commands
The CLI SHALL expose a `governance` command group with `status`, `plan`,
`apply-next`, `resume`, and `verify` subcommands. Commands SHALL use strict
argument validation, project-root discovery, versioned JSON output, responsive
human output, and existing independent consent boundaries.

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
