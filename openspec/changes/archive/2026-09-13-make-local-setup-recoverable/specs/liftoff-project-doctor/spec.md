## MODIFIED Requirements

### Requirement: Doctor reports selected AI coding-agent readiness honestly
The system SHALL check every agent recorded by the supported manifest using the shared compatibility and cause model. Copilot SHALL be present when its compatible CLI probe succeeds or supported VS Code extension identifiers are observed. Claude and Codex SHALL be present when their compatible CLI probes succeed. Compatible official preview agents SHALL be ready with a notice, not an outdated-tool failure. Authentication SHALL remain external and SHALL not be automated or collected by doctor.

#### Scenario: Copilot CLI is detected
- **WHEN** the manifest selects Copilot and its compatible version probe succeeds
- **THEN** doctor reports the installation as ready with its actual observed version

#### Scenario: VS Code Copilot extension is detected
- **WHEN** the Copilot CLI is absent and a successful extension listing contains `GitHub.copilot` or `GitHub.copilot-chat` case-insensitively
- **THEN** doctor reports Copilot as installed through VS Code

#### Scenario: VS Code extension state is not observable
- **WHEN** both the Copilot CLI and the VS Code command are unavailable
- **THEN** doctor reports not-observable installation rather than claiming the extension is absent
- **AND** it offers the supported CLI installation remedy

#### Scenario: Claude authentication remains external
- **WHEN** Claude's version probe succeeds but its doctor command reports an authentication problem
- **THEN** Liftoff reports an installed agent with an authentication warning and agent-owned remedy
- **AND** it does not request credentials

#### Scenario: Codex is selected
- **WHEN** the manifest selects Codex with OpenSpec or Spec Kit
- **THEN** doctor probes the registered Codex executable and native framework markers
- **AND** it does not require unselected Copilot or Claude integrations

#### Scenario: A selected preview agent is compatible
- **WHEN** a selected agent reports a compatible official preview build
- **THEN** doctor agrees with setup that the requirement is ready with a preview notice
- **AND** it does not recommend reinstalling merely to remove the preview suffix

## ADDED Requirements

### Requirement: Doctor separates local completion activation and repair progress
Doctor SHALL distinguish local readiness, activation planning/approval/execution, stateful migration checkpoints, recovery, and lifecycle obligations. It SHALL share active-layout, compatibility, and proof interpretation with the other commands while remaining probe-only. Real external prerequisites SHALL be distinguished from a missing implementation, and no incomplete global stage SHALL erase valid local completion.

#### Scenario: Local setup is complete while activation is pending
- **WHEN** local proof is current but no publication or cloud activation has occurred
- **THEN** doctor identifies completed local setup and pending activation separately

#### Scenario: Infrastructure repair needs discovery
- **WHEN** legacy conformance is unresolved and deployment eligibility is unknown
- **THEN** doctor names the supported project-bound repair preview and missing discovery
- **AND** it does not create a receipt, perform the repair, or assume undeployed state

#### Scenario: Repair committed but verification is incomplete
- **WHEN** a repair progress record identifies committed files and failed local checks
- **THEN** doctor reports both facts and the supported scoped retry
- **AND** it does not recommend reverting to legacy provenance

#### Scenario: Stateful migration is interrupted
- **WHEN** a journal records partial backend effects
- **THEN** doctor identifies the verified checkpoint and supported recovery inspection
- **AND** it neither writes state nor recommends blindly restoring an old snapshot

#### Scenario: Activation is verified and disposal is not due
- **WHEN** live activation proof is current while retained-state disposal is scheduled for later
- **THEN** doctor reports active governance and pending lifecycle separately
- **AND** it does not declare lifecycle complete or delete retained material

### Requirement: Doctor identifies successor and sensitive-operation boundaries
Doctor SHALL identify historical v1/v2 identities, declared successor eligibility, current execution identity, and corrupted or incomplete migration links without rewriting them. It SHALL not pull sensitive state, run deployment plans, grant authority, enroll credentials, release locks, or execute recovery merely to produce a diagnosis.

#### Scenario: Historical contract needs upgrade
- **WHEN** current execution requires a supported reviewed successor
- **THEN** doctor names the actual update preview and required fresh-proof work
- **AND** it does not tell the developer to edit version fields or reuse historical approvals

#### Scenario: A sensitive state read is needed
- **WHEN** metadata-only diagnostics cannot establish a migration mapping
- **THEN** doctor identifies the separate state-inspection approval path
- **AND** it does not include raw state or secrets in its output

### Requirement: Doctor reports executable identity and causal remedies
Doctor SHALL expose running CLI identity and selected tool executable observations separately from manifest-writing versions, release-channel notices, and required constraints. It SHALL distinguish unavailable executables, no-op repairs, incompatible versions/channels, and actual PATH problems. Diagnostics SHALL remain read-only and SHALL not infer successful installation from a path's existence.

#### Scenario: A compatibility-rejected executable is found
- **WHEN** a tool version command resolves and succeeds but a real constraint is not satisfied
- **THEN** doctor reports the constraint mismatch and actual executable
- **AND** it does not diagnose PATH solely from the unresolved requirement

#### Scenario: Command availability differs between sessions
- **WHEN** installation identity is needed to investigate an unknown-command report
- **THEN** doctor identifies the running CLI version and resolved executable/package boundary without claiming that another session used the same binary

#### Scenario: Windows uses an executable shim
- **WHEN** a selected tool resolves through a Windows executable shim
- **THEN** observations and remedies distinguish that resolved path from a missing-command condition using native path handling
