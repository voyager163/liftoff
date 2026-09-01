## MODIFIED Requirements

### Requirement: Initialization consent flags are explicit and independent
The system SHALL keep project-default acceptance, destination overwrite authorization, machine-tool installation authorization, global OpenSpec profile authorization, and project dependency installation authorization as five independent decisions. No flag SHALL imply another, and installation, global-profile, or overwrite consent SHALL NOT be read from project configuration.

#### Scenario: Yes does not authorize overwrite
- **WHEN** a developer runs `liftoff init existing-project --yes` and destination preflight finds a conflicting generated file
- **THEN** Liftoff exits before writing unless the developer confirms interactively or supplies `--force`

#### Scenario: Force does not authorize machine changes
- **WHEN** a developer runs `liftoff init existing-project --force` and a blocking workstation tool is missing
- **THEN** Liftoff does not install the tool without interactive confirmation or `--install-tools`

#### Scenario: Machine-tool consent does not install project dependencies
- **WHEN** a developer supplies `--install-tools` without `--install-dependencies`
- **THEN** Liftoff does not run stack package installation in the generated project without the separate interactive confirmation

#### Scenario: Other consent does not authorize global OpenSpec configuration
- **WHEN** the OpenSpec global profile is incompatible and the developer supplies `--yes`, `--force`, `--install-tools`, or `--install-dependencies` without the dedicated profile authorization
- **THEN** Liftoff does not change the global OpenSpec configuration
- **AND** it exits before destination writes with the exact remediation

## ADDED Requirements

### Requirement: CLI exposes an explicit Copilot cloud-agent choice
The system SHALL expose a default-off Copilot cloud-agent decision for OpenSpec projects that select GitHub Copilot. Interactive `init` and `migrate` flows SHALL prompt when the choice is unresolved, and noninteractive flows SHALL accept `--copilot-cloud` or `--no-copilot-cloud`.

#### Scenario: Prompt for the cloud coding agent
- **WHEN** an interactive OpenSpec plan selects GitHub Copilot and does not already specify a cloud-agent preference
- **THEN** Liftoff explains that the option writes a GitHub Actions workflow and an agent definition
- **AND** the confirmation defaults to No

#### Scenario: Preview the cloud-agent decision
- **WHEN** Liftoff presents an OpenSpec project plan
- **THEN** the plan identifies the complete 12-workflow, skills-and-commands contract
- **AND** it states whether the GitHub-hosted Copilot coding agent will be configured

#### Scenario: Enable the cloud coding agent noninteractively
- **WHEN** a fully specified OpenSpec command selects GitHub Copilot and supplies `--copilot-cloud`
- **THEN** Liftoff resolves the cloud-agent preference to enabled without an additional project-decision prompt

#### Scenario: Yes accepts the safe cloud-agent default
- **WHEN** a fully specified OpenSpec command selects GitHub Copilot, supplies `--yes`, and omits both cloud-agent flags
- **THEN** Liftoff resolves the cloud-agent preference to disabled
- **AND** `--yes` does not opt into the GitHub Actions integration

#### Scenario: Reject an inapplicable cloud-agent flag
- **WHEN** a developer supplies either cloud-agent flag with Spec Kit or without GitHub Copilot selected
- **THEN** Liftoff exits before probes or writes and explains the required OpenSpec and GitHub Copilot combination

### Requirement: Global OpenSpec profile authorization has a dedicated CLI surface
The system SHALL expose a dedicated noninteractive authorization flag for changing the global OpenSpec profile and SHALL show profile configuration as a separate interactive consent phase. The authorization SHALL apply only when OpenSpec is selected and the observed global profile does not already satisfy the Liftoff contract.

#### Scenario: Matching global profile needs no authorization
- **WHEN** the global OpenSpec configuration already selects `custom`, `both`, and all 12 required workflows
- **THEN** `liftoff init` and `liftoff migrate` proceed without a profile-change prompt or authorization flag

#### Scenario: Authorize a noninteractive profile change
- **WHEN** a fully specified OpenSpec command observes an incompatible global profile and supplies `--configure-openspec-profile`
- **THEN** Liftoff may apply and verify the required global profile before staging project files

#### Scenario: Standalone plan never changes global configuration
- **WHEN** a developer runs `liftoff plan` with any profile-authorization or cloud-agent selection
- **THEN** Liftoff previews the resolved project contract without running OpenSpec config commands or writing machine or project files
