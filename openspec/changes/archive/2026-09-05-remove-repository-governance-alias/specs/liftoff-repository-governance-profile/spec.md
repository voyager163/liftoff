## MODIFIED Requirements

### Requirement: Repository governance is a selectable project profile
The system SHALL expose repository governance as an append-only catalog selection with `single-maintainer-gitflow` and `none` values. Interactive initialization SHALL offer the single-maintainer GitFlow profile and default it to enabled. Noninteractive planning and initialization SHALL accept an explicit governance profile and SHALL use `single-maintainer-gitflow` when the option and configuration field are absent.

#### Scenario: Accept the interactive default
- **WHEN** a developer runs interactive `liftoff init` and accepts the repository-governance default
- **THEN** the resolved project plan selects `single-maintainer-gitflow`
- **AND** the plan states that local handoff artifacts will be generated

#### Scenario: Opt out interactively
- **WHEN** a developer disables repository governance during initialization
- **THEN** the resolved plan records `none`
- **AND** no repository-governance policy, context, guide, or setup integration is rendered

#### Scenario: Select noninteractively
- **WHEN** a developer supplies `--governance single-maintainer-gitflow` or `--governance none`
- **THEN** Liftoff validates the value through the governance profile catalog without prompting

#### Scenario: Reject an unknown profile
- **WHEN** a flag or configuration file names an unsupported governance profile
- **THEN** Liftoff exits 1 before workstation probes or destination writes
- **AND** identifies the accepted profile values

### Requirement: Local state never claims live enforcement
The generated context, guide, plan presentation, manifest, and diagnostics
SHALL describe the local state as a governance handoff, not active enforcement.
Diagnostics SHALL distinguish a complete `handoff-generated` artifact set from
an update-only `handoff-partial` state caused by preserved unrecorded
conflicts, without claiming ownership of those conflicting files. Live
activation status SHALL be established only by the user-owned activation
evidence and read-back of repository settings; Liftoff SHALL NOT infer it from
the presence of policy, workflow, or ruleset source files.

#### Scenario: Fresh governed scaffold
- **WHEN** initialization completes with the profile enabled
- **THEN** completion reports that the governance handoff was generated and activation is deferred
- **AND** it does not say branches, checks, rulesets, security, deployment, or monitoring are enforced

#### Scenario: Workflows exist locally
- **WHEN** a later project contains governance workflow and ruleset files but GitHub cannot be inspected
- **THEN** Liftoff does not report live governance as active

#### Scenario: Governance adoption is partial
- **WHEN** a legacy update preserves one or more unrecorded conflicting handoff destinations
- **THEN** validation accepts the truthful schema-v7 managed-core ownership record
- **AND** doctor warns that the local handoff is incomplete and directs the developer to inspect conflicts before considering `--force`
