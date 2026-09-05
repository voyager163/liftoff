## ADDED Requirements

### Requirement: Governed projects include a distinct read-only assessment integration
When repository governance is enabled, Liftoff SHALL generate
`/liftoff-governance-assess` for every selected supported agent. This integration
SHALL be separate from the sole setup entry point `/liftoff-setup`, SHALL not
require a model or independent skill version, and SHALL delegate observations
and classifications to the assessment CLI. It SHALL not run automatically
during initialization or replace the primary post-init setup recommendation.

#### Scenario: Generate both supported agents
- **WHEN** GitHub Copilot and Claude Code are selected with governance enabled
- **THEN** the project contains `.github/prompts/liftoff-governance-assess.prompt.md` and `.claude/commands/liftoff-governance-assess.md`
- **AND** both reference the same CLI report contract and canonical governance context

#### Scenario: Generate one selected agent
- **WHEN** only one supported coding agent is selected
- **THEN** only that agent's assessment integration is generated and tracked
- **AND** neighboring framework-owned files remain outside Liftoff ownership

#### Scenario: Governance is disabled
- **WHEN** the plan selects profile `none`
- **THEN** no assessment integration is generated
- **AND** initialization performs no assessment or live collection

#### Scenario: Invoke assessment through an agent
- **WHEN** a developer invokes `/liftoff-governance-assess`
- **THEN** the integration calls `liftoff governance assess --json` and explains its output
- **AND** it does not invent findings or invoke update, upgrade, activation, mutation commands, or remediation scripts

#### Scenario: Developer explicitly requests live reads
- **WHEN** the developer requests live comparison through the assessment integration
- **THEN** it may invoke `liftoff governance assess --live --json`
- **AND** lack of that request leaves the assessment local-only

#### Scenario: Generate across frameworks and operating systems
- **WHEN** identical selected-agent plans use OpenSpec or Spec Kit on Windows, macOS, or Linux
- **THEN** the assessment integration contract remains equivalent
- **AND** logical names and content are deterministic with portable path parts
