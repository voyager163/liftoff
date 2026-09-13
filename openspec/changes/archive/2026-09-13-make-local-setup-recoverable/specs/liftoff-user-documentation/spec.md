## MODIFIED Requirements

### Requirement: Documentation explains the complete OpenSpec template contract
The system SHALL document all 12 required OpenSpec 1.11 workflows and the global `custom`/`both` profile with separately authorized configuration. It SHALL explain that delivery is native-surface-aware: Copilot and Claude receive supported skills and commands, while Codex uses the complete project-local skill inventory without deprecated custom prompts. Guidance SHALL distinguish new initialization, framework-owned maintenance, and reviewed additive-agent repair.

#### Scenario: New user reviews OpenSpec setup
- **WHEN** a developer reads getting-started, CLI, prerequisite, or workflow guidance
- **THEN** documentation lists or links the complete workflow set and its native agent surfaces
- **AND** it explains independent authorization when the global profile differs

#### Scenario: User evaluates the Copilot cloud-agent option
- **WHEN** OpenSpec and agent guidance is read
- **THEN** it identifies the default-off hosted Copilot choice, `.github/workflows/copilot-setup-steps.yml`, and `.github/agents/openspec.agent.md`
- **AND** it distinguishes that capability from Copilot, Claude, or Codex in a local terminal

#### Scenario: Existing project needs expanded workflows
- **WHEN** a developer maintains existing selected-agent framework workflows
- **THEN** guidance distinguishes authorized profile configuration and official `openspec update` maintenance from ordinary managed-core update
- **AND** adding another supported agent is directed to a reviewed integration repair rather than application reinitialization

#### Scenario: User reviews independent consent
- **WHEN** safety or automation guidance is read
- **THEN** project approval, overwrite authority, tool/dependency installation, global-profile configuration, and cloud opt-in are described as distinct scopes

#### Scenario: Codex user invokes a workflow
- **WHEN** Codex instructions describe OpenSpec or Spec Kit workflows
- **THEN** they use native project-local skills and actual Codex invocation conventions
- **AND** they do not require unsupported slash-command files or global prompt setup

### Requirement: Documentation provides one post-init kickstart
Documentation SHALL present initialization followed by the native Liftoff setup operation as an approved end-to-end journey. It SHALL use the actual Copilot/Claude and Codex invocation forms, explain local-only operation and the local-ready milestone, and show how the same journey continues through migration when needed, approval, cloud/governance implementation, live verification, and tracked lifecycle work. It SHALL not advertise a complete activation path backed only by status scaffolding or placeholder producers.

#### Scenario: Developer finishes initialization
- **WHEN** supported-project completion output or README is read
- **THEN** it names the selected agent's actual setup entry point and applicable local checks

#### Scenario: Developer asks about model selection
- **WHEN** setup guidance discusses model selection
- **THEN** none is required and safety is attributed to deterministic phase/evidence contracts

#### Scenario: Developer inspects setup identity
- **WHEN** identities are documented
- **THEN** CLI, policy, activation contract, command schema, repair schema, and graph identities are distinguished without an independent setup-skill version
- **AND** the current successor identity remains distinct from historical v1/v2 proof and approvals

#### Scenario: Setup needs developer input
- **WHEN** authority questions are documented
- **THEN** exact project-repair approval and independent prerequisite permissions are distinguished from publication, credentials, billed infrastructure, enforcement, and destructive authority
- **AND** no manual approval-envelope or evidence fabrication is suggested

#### Scenario: Developer resumes setup
- **WHEN** a prior run stopped on a blocker
- **THEN** guidance explains supported repair, inspection, and the actual authorized local/activation/stateful/recovery operation
- **AND** unchanged failures are not retried indefinitely or disguised as success

#### Scenario: Developer reads setup command guidance
- **WHEN** generated setup aliases are discussed
- **THEN** native forms name the same sole logical setup operation and retired aliases appear only as reviewed removal debt

#### Scenario: Developer enters a credential
- **WHEN** separate activation requires credential enrollment
- **THEN** guidance identifies the implemented protected enrollment entry point, exact scope, and required usage/readback proof
- **AND** it never asks for credential values in chat, arguments, source, or public receipts

#### Scenario: Spec Kit user completes the local baseline
- **WHEN** Spec Kit setup is documented
- **THEN** its project-owned bootstrap bundle and finalization receipt remain distinct from official framework markers
- **AND** no OpenSpec archive or nonexistent Spec Kit archival command is suggested
- **AND** a missing historical bootstrap bundle is not silently manufactured by update or force

#### Scenario: Local setup is complete but activation is pending
- **WHEN** documentation shows successful local completion
- **THEN** it states that cloud resources and enforcement are not implied
- **AND** it shows the next approval/activation stage of the full journey rather than silently treating that stage as deferred implementation

#### Scenario: Developer completes the full journey
- **WHEN** documentation describes successful end-to-end setup
- **THEN** it requires actual deployment, qualification, and live enforcement readback
- **AND** future disposal or other lifecycle obligations remain explicitly visible

## ADDED Requirements

### Requirement: Repair documentation describes actionable and bounded recovery
Guidance SHALL explain local and supported stateful repair, metadata versus sensitive-state inspection, exact read/write approvals, source/backend/resource-address scope, protected backups, locking, cutover verification, and checkpointed recovery. It SHALL distinguish unknown or unsupported cases from supported executable migrations and separate all of these from CLI upgrade, local core/identity migration, and ordinary framework maintenance.

#### Scenario: Developer encounters legacy infrastructure
- **WHEN** troubleshooting describes the legacy-layout blocker
- **THEN** it gives the actual repair preview and eligibility/discovery sequence
- **AND** it does not prescribe manual manifest/context edits or copying a fresh template tree over the project

#### Scenario: Developer follows a target-specific command
- **WHEN** repair commands are shown for a project outside the caller's directory
- **THEN** the project path and working directory remain explicit and correctly quoted for the supported platform
- **AND** a positional init project name is not advertised as an output-directory override

#### Scenario: Developer reviews stateful limitations
- **WHEN** a stateful migration is considered
- **THEN** guidance names the supported recipe and its actual safeguards or the specific unsupported prerequisite
- **AND** neither a blanket plan-only claim nor a promise to migrate arbitrary state is made

#### Scenario: A migration stops after an external write
- **WHEN** recovery is required
- **THEN** guidance explains the recorded checkpoint, current-state re-observation, and approved recovery path
- **AND** it does not claim local rollback restored every backend or recommend forced state overwrite

### Requirement: Tool guidance describes compatibility and actual repair outcomes
Documentation SHALL distinguish a compatible tool with an available update from a missing or incompatible required tool. Compatible official preview agents SHALL be documented as usable with notices, while tested runtime/framework constraints remain enforced. Installation guidance SHALL distinguish no-op installers, actual failures, channel/version issues, and observed PATH problems without promising unobserved writes or upgrades.

#### Scenario: Copilot updater leaves the observed version unchanged
- **WHEN** the executable still reports the same version after an update attempt
- **THEN** guidance uses the actual resulting compatibility observation
- **AND** it does not treat the attempted command as proof of a stable-channel switch

#### Scenario: Installer reports already installed
- **WHEN** the same unresolved requirement remains after a successful package-manager exit
- **THEN** troubleshooting explains no progress and a supported alternative or limitation
- **AND** it does not repeat a generic PATH/restart remedy without discovery evidence

#### Scenario: Codex is added to an existing project
- **WHEN** agent guidance describes adopting Codex
- **THEN** it covers additive selection, optional Spec Kit default, native skills, independent tool consent, and preservation of existing integrations
- **AND** it does not recommend application reinitialization

### Requirement: Activation guidance distinguishes implementation scope from runtime consent
Documentation SHALL state that this change implements supported activation and stateful migration but does not make a setup request, planning-artifact approval, local repair approval, or `--yes` blanket permission for live changes. It SHALL explain approval-ready plans, cost/permission/credential boundaries, real external prerequisites, and the difference between local success, current live verification, and future lifecycle work.

#### Scenario: A developer only wants local readiness
- **WHEN** local-only operation is selected or later approval is declined
- **THEN** documentation explains that no live activation is performed
- **AND** the local milestone is not presented as full deployment

#### Scenario: Existing activation metadata needs the successor
- **WHEN** a historical v1/v2 project is upgraded for the new execution contract
- **THEN** guidance uses the exact reviewed identity-migration path and fresh verification
- **AND** it distinguishes that local transaction from OpenTofu-state migration or cloud provisioning
