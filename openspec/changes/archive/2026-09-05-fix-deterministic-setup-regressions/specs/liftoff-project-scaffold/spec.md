## MODIFIED Requirements

### Requirement: Governed projects include one deterministic setup entry point
When repository governance is enabled, the system SHALL generate
`/liftoff-setup` integrations for every selected agent and a managed
machine-readable phase definition. The integrations SHALL contain no model
selection, SHALL delegate state transitions to the Liftoff CLI, and SHALL NOT
generate any alternate visible setup command or alias. They SHALL authorize the
read-only `apply-next --json` preview and the explicit
`apply-next --json --execute` transition form, and SHALL use the executable form
only when readiness is reported and approval status is `not-required` or
`reused`.

#### Scenario: Generate Copilot setup
- **WHEN** GitHub Copilot is selected
- **THEN** the project includes a `/liftoff-setup` skill or prompt that invokes the deterministic governance commands

#### Scenario: Generate Claude setup
- **WHEN** Claude Code is selected
- **THEN** the project includes an equivalent `/liftoff-setup` skill or command with the same behavioral contract

#### Scenario: Generate both agents
- **WHEN** both agents are selected
- **THEN** their setup integrations reference the same managed phase graph and user-owned activation state
- **AND** neither integration declares or asks for a model

#### Scenario: Execute a ready approval-free phase
- **WHEN** the generated setup integration observes a ready phase whose approval is not required
- **THEN** it invokes `liftoff governance apply-next --json --execute`
- **AND** the transition writes authoritative evidence and activation state before verification runs
