## ADDED Requirements

### Requirement: Documentation explains the complete OpenSpec template contract
The system SHALL document that Liftoff OpenSpec projects require all 12 OpenSpec 1.11 workflows with both skills and commands, that this selection is stored in global OpenSpec configuration, and that Liftoff changes that configuration only after separate consent. The guidance SHALL distinguish new-project setup from framework-owned maintenance in an existing project.

#### Scenario: New user reviews OpenSpec setup
- **WHEN** a developer reads getting-started, CLI, prerequisite, or spec-workflow guidance before initialization
- **THEN** the documentation lists or links to the complete workflow set
- **AND** it explains the interactive and noninteractive authorization needed when the global profile differs

#### Scenario: User evaluates the Copilot cloud-agent option
- **WHEN** a developer reads the OpenSpec and agent guidance
- **THEN** it identifies the default-off choice, `.github/workflows/copilot-setup-steps.yml`, and `.github/agents/openspec.agent.md`
- **AND** it explains that the option targets GitHub's hosted coding agent rather than Copilot in an editor or terminal

#### Scenario: Existing project needs expanded workflows
- **WHEN** a developer wants to align an existing Liftoff project rather than create a fresh scaffold
- **THEN** the documentation directs them to configure the global OpenSpec profile and run `openspec update`
- **AND** it does not claim that plain `liftoff update` owns or regenerates OpenSpec skills and commands

#### Scenario: User reviews independent consent
- **WHEN** a developer reads safety or automation guidance
- **THEN** it states that `--yes`, `--force`, tool installation, dependency installation, global-profile configuration, and cloud-agent opt-in have distinct scopes
