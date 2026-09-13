## MODIFIED Requirements

### Requirement: The selected profile generates one canonical managed-core handoff
The system SHALL render a versioned canonical policy, schema-versioned workload context, activation guide, and thin setup and read-only assessment integrations for each selected coding agent as explicitly named managed-core artifacts. Policy and context SHALL live under `.liftoff/governance`; Copilot and Claude SHALL retain their exact existing native paths, and Codex SHALL use its exact project-local `.agents/skills` paths. Integrations SHALL reference the canonical files and CLI instead of duplicating policy or evaluation logic. The logical `liftoff-setup` operation SHALL remain the sole setup entry point in each agent's native invocation form; assessment SHALL not become a setup alias.

#### Scenario: Generate for Copilot and Claude
- **WHEN** a project selects the single-maintainer profile, Copilot, and Claude
- **THEN** it contains the canonical handoff and both integration kinds for each selected agent
- **AND** each file has a stable logical name and manifest content hash

#### Scenario: Generate for one agent
- **WHEN** only GitHub Copilot is selected
- **THEN** Liftoff renders only its selected-agent handoff integrations
- **AND** Claude or Codex launchers are not required

#### Scenario: Render paths cross-platform
- **WHEN** the same governed plan is rendered on Windows, macOS, and Linux
- **THEN** every governance artifact has identical bytes, logical names, and OS-neutral path parts
- **AND** filesystem access uses native path resolution

#### Scenario: Framework owns neighboring files
- **WHEN** official framework output exists under `.github`, `.claude`, `.agents`, or applicable project-local `.codex` paths
- **THEN** Liftoff owns only its explicitly named governance integrations
- **AND** directory patterns do not select neighboring files for replacement or deletion

#### Scenario: Generate for Codex
- **WHEN** Codex is selected with the profile
- **THEN** it receives native setup and assessment skills with distinct Codex identities
- **AND** both use the same policy, local/activation boundary, and assessment contract as the other agents

## ADDED Requirements

### Requirement: Local handoff completion is separate from policy activation
The profile's single setup integration SHALL distinguish local completion from implemented cloud/governance activation while guiding the requested full journey through both. It SHALL preserve local-only operation and require separate authority before publication, credentials, infrastructure/state changes, and enforcement. The existing fixed policy controls SHALL remain mandatory where applicable; local repair observations SHALL not satisfy live proof requirements.

#### Scenario: Complete local setup before publication
- **WHEN** local requirements and proof are complete without a remote repository
- **THEN** the handoff reports local success and separate activation prerequisites
- **AND** it does not request publication approval merely to call local setup complete

#### Scenario: Explicit activation is requested
- **WHEN** the developer requests the full setup journey or separately requests activation and approves its required scopes
- **THEN** publication, discovery, approval, credential, and execution-capability prerequisites remain enforced
- **AND** supported production operations execute through verified live governance rather than an unimplemented handoff

#### Scenario: An external capability blocks activation
- **WHEN** actual account permissions, licensing, quota, or private access do not satisfy the policy
- **THEN** the CLI reports the precise prerequisite and preserves completed work
- **AND** it does not bypass the control or confuse the condition with a missing supported producer

### Requirement: Setup guidance offers supported repair rather than manual metadata fabrication
Profile handoffs SHALL explain structured local and supported stateful repairs with exact read/write, preservation, approval, and recovery scope. They SHALL distinguish observed statefulness from eligibility and separate unknown-state discovery from authorized execution. They SHALL not tell developers to edit state/machine metadata, discard history, or overwrite a project with a new starter to satisfy a gate.

#### Scenario: A legacy layout blocks the local baseline
- **WHEN** a supported infrastructure repair candidate is reported
- **THEN** the selected agent presents its actual preview and next approval/discovery action
- **AND** it does not invent a reinitialization command or declare all automation impossible

#### Scenario: The source cannot be repaired automatically
- **WHEN** current state or unsupported customizations make execution ineligible
- **THEN** the handoff explains the specific plan-only boundary and unresolved work
- **AND** it does not present a nonexistent executable recipe

### Requirement: The supported profile is implemented and independently verified
The production setup path SHALL implement applicable policy controls through actual workload-aware infrastructure, identities, workflows, qualification, and enforcement. Required status contexts SHALL be proven on their applicable protected ref families, including a controlled failure. Rulesets SHALL be applied last after exact final approval and compared with committed source through live readback. Existing policy restrictions on human merge/deployment reviewers and duplicate security tooling SHALL not be replaced with convenience gates.

#### Scenario: A workflow file exists but has not run
- **WHEN** a required control has only source configuration and no valid execution proof
- **THEN** activation remains incomplete and enforcement does not proceed

#### Scenario: A required check is skipped or synthetic
- **WHEN** proof is skipped, cancelled, neutral, stale, or merely an emitted success status without the required real run
- **THEN** it does not satisfy qualification or enforcement

#### Scenario: Idempotent enforcement is requested
- **WHEN** current approved rulesets already match live state
- **THEN** the operation preserves the matching controls and records actual readback without destructive replacement

### Requirement: Credential enrollment and lifecycle follow the policy's real security boundary
Supported enrollment SHALL prefer the approved scoped GitHub App path and otherwise implement the defined fine-grained credential policy through private input and verified use. Credential values SHALL never appear in chat, argv, public receipts, or generated source. Retained bootstrap state SHALL remain encrypted and unusable for ordinary work after remote verification, with exact due disposal tracked separately from activation completion.

#### Scenario: Credential metadata exists without usage proof
- **WHEN** only a credential policy file or secret name is observable
- **THEN** readiness remains unverified until the required scoped use and configured workflow path are proven

#### Scenario: Retention has not expired
- **WHEN** application/enforcement activation is complete but retained state is not yet disposable
- **THEN** activation is reported separately from pending lifecycle work
- **AND** neither early deletion nor ordinary use of retained state is allowed
