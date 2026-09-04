## ADDED Requirements

### Requirement: Documentation provides one post-init kickstart
The root README, getting-started guide, generated project README, and governance
guide SHALL present `liftoff init` followed by `/liftoff-setup` as the primary
journey. They SHALL explain seed completion, local baseline checks, commit/push,
Phase 0, limited approval gates, autonomous resumption, normal development,
release flow, and the distinction between model explanation and CLI authority.

#### Scenario: Developer finishes initialization
- **WHEN** the developer reads completion output or the generated README
- **THEN** the next command is `/liftoff-setup`
- **AND** the guide lists the local baseline checks it will perform

#### Scenario: Developer asks about model selection
- **WHEN** documentation describes the setup skill
- **THEN** it states that no model selection is required
- **AND** safety depends on deterministic phase and evidence validation

#### Scenario: Developer inspects setup identity
- **WHEN** documentation or status output presents governance setup versions
- **THEN** it distinguishes Liftoff CLI, policy, activation-contract, schema, and phase-graph hash identities
- **AND** explains that the setup skill has no independent manually maintained version

#### Scenario: Setup needs developer input
- **WHEN** documentation describes interactive setup
- **THEN** it limits questions to repository/push, credentials, billed infrastructure or exceptions, final enforcement, destructive actions, and external blockers

#### Scenario: Developer resumes setup
- **WHEN** a prior run stopped on a blocker
- **THEN** documentation instructs the developer to rerun `/liftoff-setup`
- **AND** explains that verified phases are idempotent and not repeated

#### Scenario: Developer enters a credential
- **WHEN** PAT fallback is required
- **THEN** documentation gives the deterministic fields and requires a masked input channel
- **AND** warns never to paste or show the value in chat, command arguments, logs, evidence, or screenshots
