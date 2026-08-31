## ADDED Requirements

### Requirement: CLI captures the repository-governance profile
The system SHALL include repository governance among common project decisions for every workload. Interactive initialization SHALL offer the single-maintainer GitFlow profile after workload-specific architecture choices and default it to enabled. Configuration and noninteractive commands SHALL accept the append-only governance profile identifier through `governanceProfile` and `--governance`.

#### Scenario: Configure governance interactively
- **WHEN** a developer initializes any workload with missing governance input
- **THEN** Liftoff asks whether to generate the single-maintainer GitFlow governance handoff
- **AND** the default answer enables it

#### Scenario: Use noninteractive default
- **WHEN** a fully specified noninteractive `plan` or `init --yes` omits governance input
- **THEN** the project plan selects `single-maintainer-gitflow`
- **AND** no remote action is implied

#### Scenario: Load governance from configuration
- **WHEN** a valid configuration contains `governanceProfile`
- **THEN** Liftoff resolves it through the governance profile catalog
- **AND** flags override configuration through the normal defined-value merge

### Requirement: Plan preview distinguishes handoff from enforcement
The project plan preview SHALL identify the selected governance profile, policy version, durable handoff artifacts, selected-agent launchers, and deferred post-push activation. `liftoff plan` SHALL remain side-effect free and SHALL not require a Git repository, remote, GitHub authentication, or governance platform capability.

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

### Requirement: Governance options preserve independent consent
Selecting a repository-governance profile or passing `--yes` SHALL authorize only deterministic local planning and generated files. It SHALL NOT authorize agent execution, Git mutation, remote mutation, destination conflict overwrite, machine-tool installation, or project dependency installation.

#### Scenario: Initialize with yes and governance
- **WHEN** a developer runs a fully specified `liftoff init --yes` with the profile enabled
- **THEN** Liftoff may write the authorized collision-free local artifacts
- **AND** every existing independent overwrite and installation consent boundary remains unchanged
- **AND** no remote governance operation runs
