## ADDED Requirements

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
- **WHEN** the developer runs `liftoff governance apply-next`
- **THEN** only allowlisted operations for evidence-ready and approved phases execute
- **AND** the result updates user-owned state transactionally

#### Scenario: Resume after a blocker
- **WHEN** the external blocker evidence has changed
- **THEN** `resume` reruns only the blocker preflight and downstream readiness calculation
- **AND** does not repeat verified operations

#### Scenario: Unsupported governance syntax is supplied
- **WHEN** a misspelled subcommand, unknown flag, or excess positional argument is used
- **THEN** parsing fails before project discovery or mutation
