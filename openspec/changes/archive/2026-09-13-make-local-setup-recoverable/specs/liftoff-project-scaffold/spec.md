## MODIFIED Requirements

### Requirement: Projects support GitHub Copilot and Claude Code together
The system SHALL configure either selected spec workflow for GitHub Copilot, Claude Code, Codex, or any nonempty combination of those agents. It SHALL map normalized IDs to official framework integration IDs, preserve canonical order, and preserve the selected Spec Kit default while adding secondary integrations. Codex SHALL use its native skills-based surface rather than Claude or Copilot command paths.

#### Scenario: Configure both agents for OpenSpec
- **WHEN** OpenSpec is selected with Copilot and Claude Code
- **THEN** the official initializer receives both tool identifiers in stable order
- **AND** the project contains valid integration output for both

#### Scenario: Configure both agents for Spec Kit
- **WHEN** Spec Kit is selected with Copilot as default and Claude Code as secondary
- **THEN** the official initializer creates Copilot's supported skills-based integration
- **AND** the official integration command installs Claude Code without changing the Copilot default

#### Scenario: Configure Copilot as a secondary Spec Kit integration
- **WHEN** Spec Kit is selected with Claude Code as default and Copilot as secondary
- **THEN** Copilot is installed using the tested skills option rather than deprecated agent-file output

#### Scenario: Configure Codex alone
- **WHEN** either workflow is selected with Codex alone
- **THEN** its official Codex integration is installed and validated
- **AND** no Copilot or Claude integration is required

#### Scenario: Configure all three agents
- **WHEN** Copilot, Claude, and Codex are selected
- **THEN** the complete official integration set is present without path or logical-name collisions
- **AND** each selected agent can be the Spec Kit default when explicitly chosen

### Requirement: Governed projects include one deterministic setup entry point
When governance is enabled, Liftoff SHALL generate one native `liftoff-setup` journey for each selected agent. Copilot/Claude SHALL retain `/liftoff-setup`; Codex SHALL use its native `$liftoff-setup` skill. The integration SHALL drive local readiness and the requested approved migration/activation journey through explicit CLI scopes, without model selection or invented aliases. It SHALL obtain required authority before effects, support local-only operation, and verify actual deployment/enforcement rather than stop unconditionally after local preparation.

#### Scenario: Generate Copilot setup
- **WHEN** GitHub Copilot is selected
- **THEN** the project includes its native `/liftoff-setup` integration beginning with local scope and continuing through the requested approved activation journey

#### Scenario: Generate Claude setup
- **WHEN** Claude Code is selected
- **THEN** the project includes the equivalent native command with the same end-to-end scope and approval contract

#### Scenario: Generate both agents
- **WHEN** Copilot and Claude are selected
- **THEN** their setup integrations reference the same graph and user-owned state
- **AND** neither declares or asks for a model

#### Scenario: Execute a ready approval-free phase
- **WHEN** setup observes a ready local phase with no required approval
- **THEN** it uses explicit local-scoped apply-next execution and verifies the actual outcome
- **AND** incomplete but consistent local verification does not cause a false failure or automatic activation

#### Scenario: Generate Codex setup
- **WHEN** Codex is selected
- **THEN** `.agents/skills/liftoff-setup/SKILL.md` has valid native skill metadata and the same approved repair/activation/resume contract
- **AND** guidance does not invent a Codex slash-command file or global custom prompt

#### Scenario: Local setup finishes
- **WHEN** the selected-scope CLI reports local completion
- **THEN** the integration reports the local milestone and presents the next activation plan for the requested full journey
- **AND** it performs no publication or provider effect without the required explicit authority

#### Scenario: Full activation finishes
- **WHEN** required current deployment, qualification, and enforcement readback are verified
- **THEN** the native setup integration reports the requested immediate journey complete
- **AND** future lifecycle work is shown separately

### Requirement: Generated manifests identify the activation contract
Governed projects SHALL retain manifest artifact 7 and distinguish the writing CLI version from target activation package `0.12.0`. The executable vector SHALL identify policy 6, activation contract 3, graph schema 2 with its computed hash, state/evidence/approval schemas 3, compatibility metadata 4, and unchanged supersession/credential-policy schemas 1. Command output schema 2 and repair schema 1 SHALL remain separate identities. Existing v1/v2 proof SHALL require the declared successor/revalidation path, not retagging. Integrations SHALL use content hashes without independent skill versions or invented graph digests.

#### Scenario: Generate a governed project
- **WHEN** initialization writes the v7 manifest and governance artifacts
- **THEN** every activation identity matches the actual packaged policy, graph, schemas, and engine constants
- **AND** CLI and command-output versions remain separate identities

#### Scenario: Setup integration wording changes
- **WHEN** thin setup integration bytes change
- **THEN** their managed content hashes change without retagging existing activation proof or introducing a setup-skill version

### Requirement: Governed projects include a distinct read-only assessment integration
When governance is enabled, Liftoff SHALL generate the distinct logical `liftoff-governance-assess` integration for every selected supported agent. Copilot and Claude SHALL retain their native slash entry points; Codex SHALL use a native skill invoked through `$liftoff-governance-assess` or its skill picker. Assessment SHALL remain separate from setup, require no model or independent skill version, and delegate classifications to the CLI. It SHALL not run automatically during initialization or replace the primary local setup recommendation.

#### Scenario: Generate both supported agents
- **WHEN** GitHub Copilot and Claude Code are selected with governance enabled
- **THEN** the project contains `.github/prompts/liftoff-governance-assess.prompt.md` and `.claude/commands/liftoff-governance-assess.md`
- **AND** both reference the same assessment contract and governance context

#### Scenario: Generate one selected agent
- **WHEN** only one supported coding agent is selected
- **THEN** only that agent's assessment integration is generated and tracked
- **AND** neighboring framework-owned files remain outside Liftoff ownership

#### Scenario: Governance is disabled
- **WHEN** the plan selects profile `none`
- **THEN** no assessment integration is generated
- **AND** initialization performs no assessment or live collection

#### Scenario: Invoke assessment through an agent
- **WHEN** a developer invokes the selected agent's native assessment integration
- **THEN** it calls `liftoff governance assess --json` and explains the report
- **AND** it does not invent findings or execute update, upgrade, repair, activation, or project scripts

#### Scenario: Developer explicitly requests live reads
- **WHEN** the developer requests live comparison through the assessment integration
- **THEN** it can use the supported explicit live assessment command
- **AND** otherwise assessment remains local-only

#### Scenario: Generate across frameworks and operating systems
- **WHEN** selected-agent plans use OpenSpec or Spec Kit on Windows, macOS, or Linux
- **THEN** the behavioral contract remains equivalent with deterministic content and portable path parts

#### Scenario: Generate Codex assessment
- **WHEN** Codex is selected with governance enabled
- **THEN** `.agents/skills/liftoff-governance-assess/SKILL.md` has valid skill metadata and its own managed identity
- **AND** it is not generated under a Claude logical name

## ADDED Requirements

### Requirement: Codex uses official project-local skill inventories
Codex SHALL use the pinned frameworks' native project-local skills: the complete declared OpenSpec workflow inventory under `.agents/skills` and the official Spec Kit skill inventory under the same native root. Required files SHALL be selected by explicit framework/agent inventories, not directory ownership patterns. OpenSpec's `both` delivery SHALL not require Codex command files that its official surface does not support.

#### Scenario: OpenSpec generates all Codex workflows
- **WHEN** Codex is selected under the required complete OpenSpec profile
- **THEN** all 12 declared OpenSpec skills are present
- **AND** missing deprecated custom prompt files are not reported as failed initialization

#### Scenario: Codex staging encounters user-global prompts
- **WHEN** an official initializer could inspect or clean legacy user-global Codex prompts
- **THEN** Liftoff isolates its staging environment and preserves the real user's global files
- **AND** selecting Codex is not treated as global cleanup consent

#### Scenario: Shared skills exist on Windows
- **WHEN** framework output is staged on Windows beside existing custom `.agents` content
- **THEN** portable inventories and native path validation preserve unlisted files and reject unsafe collisions
- **AND** only validated, explicitly reviewed output is committed
