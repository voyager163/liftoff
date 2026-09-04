## MODIFIED Requirements

### Requirement: Documentation explains repository-governance selection and activation
The system SHALL provide packaged and generated documentation for the governance profile choice, enabled default, opt-out, local artifact set, manifest state, post-push `/liftoff-setup` integration, read-only Phase 0, explicit approval boundary, selected-framework change creation, and live enforcement sequence. It SHALL state prominently that generated policy is not active GitHub governance.

#### Scenario: New user follows interactive onboarding
- **WHEN** a developer reads getting-started or workload guidance
- **THEN** the guide includes the repository-governance question after applicable architecture choices
- **AND** explains that accepting it generates a local handoff only

#### Scenario: User activates after push
- **WHEN** a developer reads the generated governance guide
- **THEN** it identifies the selected-agent command or prompt, Git repository and remote prerequisites, Phase 0 report, and required plan approval
- **AND** distinguishes conversational plan approval from prohibited human merge or deployment approvals

#### Scenario: User opts out
- **WHEN** documentation describes `--governance none` or the configuration equivalent
- **THEN** it explains that Liftoff omits the handoff and does not alter live repository settings

### Requirement: Documentation describes existing-project adoption
Update, configuration, manifest, safety, and troubleshooting guidance SHALL
explain that configurations without a governance field default to the enabled
profile, `liftoff update --check` previews the new managed-core artifacts, plain
update applies collision-free core artifacts, unrecorded conflicts remain
preserved and produce `handoff-partial` without Liftoff ownership, resolving all
such conflicts promotes the manifest to `handoff-generated`, opt-out creates
orphans rather than deletion, and no update mode activates remote governance.

#### Scenario: Existing user previews adoption
- **WHEN** a user reads upgrade guidance for a pre-v7 project
- **THEN** it directs the user to run `liftoff update --check`
- **AND** explains the expected schema-v7 ownership migration and governance core drift

#### Scenario: Existing governance file conflicts
- **WHEN** troubleshooting describes a collision at a generated policy or setup path
- **THEN** it tells the user to review the exact file before considering `--force`
- **AND** explains the partial local handoff state and that the preserved file has no Liftoff manifest entry
- **AND** does not recommend deleting, bypassing, or remotely applying anything to make update pass

### Requirement: Documentation provides one post-init kickstart
The root README, getting-started guide, generated project README, and governance
guide SHALL present `liftoff init` followed by `/liftoff-setup` as the primary
journey. They SHALL explain seed completion, local baseline checks, commit/push,
Phase 0, limited approval gates, autonomous resumption, normal development,
release flow, and the distinction between model explanation and CLI authority.
They SHALL NOT present retired generated setup aliases as usable commands.

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

#### Scenario: Developer reads setup command guidance
- **WHEN** documentation lists generated setup commands
- **THEN** `/liftoff-setup` is the only visible command
- **AND** retired generated setup aliases are mentioned only as force-update removal debt, not as invocation options

#### Scenario: Developer enters a credential
- **WHEN** PAT fallback is required
- **THEN** documentation gives the deterministic fields and requires a masked input channel
- **AND** warns never to paste or show the value in chat, command arguments, logs, evidence, or screenshots
