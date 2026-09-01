## MODIFIED Requirements

### Requirement: Selected spec workflows are initialized through their official CLI
The system SHALL create complete spec-driven framework infrastructure by running the exact tested official OpenSpec or Spec Kit CLI in the staged project. For OpenSpec, Liftoff SHALL require the `custom` profile with `both` delivery and the explicit workflow set `propose`, `explore`, `new`, `continue`, `apply`, `update`, `ff`, `sync`, `archive`, `bulk-archive`, `verify`, and `onboard`. Liftoff SHALL validate the selected profile, framework markers, and integration output before committing the staged tree and SHALL NOT substitute a partial hand-written framework layout when the official command fails.

#### Scenario: Initialize OpenSpec officially
- **WHEN** a developer initializes a project with the OpenSpec workflow
- **THEN** Liftoff verifies the required global profile and runs the pinned OpenSpec initializer with the `custom` profile and every selected agent identifier in the staging root
- **AND** the committed project contains official skills and commands for all 12 required workflows for every selected agent surface that supports them

#### Scenario: Fresh OpenSpec output has no immediate profile drift
- **WHEN** a developer reruns the pinned OpenSpec initializer on a fresh Liftoff project without changing the selected tools, global OpenSpec profile, delivery, or cloud-agent preference
- **THEN** OpenSpec does not require a legacy upgrade or replace workflow files merely to align the project with the required profile

#### Scenario: Initialize Spec Kit officially
- **WHEN** a developer initializes a project with the Spec Kit workflow
- **THEN** Liftoff runs the pinned Spec Kit initializer in the staging root using the selected default agent
- **AND** it installs and validates every additional selected integration through the official integration command

#### Scenario: Official initializer failure prevents project commit
- **WHEN** the selected framework CLI exits unsuccessfully or omits any required profile or integration marker
- **THEN** Liftoff exits unsuccessfully and leaves the destination unchanged
- **AND** it does not fall back to Liftoff's former partial templates

## ADDED Requirements

### Requirement: GitHub Copilot cloud-agent output is an explicit OpenSpec choice
The system SHALL treat the GitHub-hosted Copilot coding-agent integration as a default-off OpenSpec option. When applicable, Liftoff SHALL pass an explicit opt-in or opt-out to the official initializer and SHALL preserve the same `githubCopilot.cloudAgent` value in its write-once `openspec/config.yaml` overlay.

#### Scenario: Generate cloud-agent files after opt-in
- **WHEN** OpenSpec and GitHub Copilot are selected and the developer opts into the Copilot cloud coding agent
- **THEN** the staged output contains `.github/workflows/copilot-setup-steps.yml` and `.github/agents/openspec.agent.md`
- **AND** the final OpenSpec config records `githubCopilot.cloudAgent: true`

#### Scenario: Keep cloud-agent files absent after opt-out
- **WHEN** OpenSpec and GitHub Copilot are selected and the developer declines or explicitly disables the Copilot cloud coding agent
- **THEN** neither cloud-agent file is generated
- **AND** the final OpenSpec config records `githubCopilot.cloudAgent: false`

#### Scenario: Liftoff overlay preserves the official initializer decision
- **WHEN** Liftoff writes workload context and rules to `openspec/config.yaml` after official initialization
- **THEN** it retains the resolved cloud-agent preference instead of replacing it with a config that omits or changes the preference
