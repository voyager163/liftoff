## MODIFIED Requirements

### Requirement: Plan preview distinguishes handoff from enforcement
The project plan preview SHALL identify the selected governance profile, policy version, managed-core handoff artifacts, selected-agent `/liftoff-setup` integrations, and deferred post-push activation. `liftoff plan` SHALL remain side-effect free and SHALL not require a Git repository, remote, GitHub authentication, or governance platform capability.

#### Scenario: Preview enabled governance
- **WHEN** a developer runs `liftoff plan` with the profile enabled
- **THEN** the preview says the local handoff will be generated
- **AND** says live Phase 0 and enforcement are deferred until after commit and push

#### Scenario: Preview disabled governance
- **WHEN** the project selects `none`
- **THEN** the preview reports repository governance as disabled
- **AND** does not list governance launchers or remote prerequisites

#### Scenario: Plan without GitHub access
- **WHEN** `liftoff plan` runs with no GitHub remote or credentials
- **THEN** it completes without attempting a GitHub API call
