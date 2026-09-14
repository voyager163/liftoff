## ADDED Requirements

### Requirement: Native repair integrations have exact additive managed ownership
The system SHALL declare `liftoff-repair-copilot`, `liftoff-repair-claude` and `liftoff-repair-codex` at their exact native paths as selected-agent managed-core artifacts. Generation and reviewed update SHALL use explicit identity lookup, not parent-directory or filename-pattern authority. Supported older complete manifests and compatibility inventories SHALL remain readable without retagging historical identities; absence of the new integrations SHALL become safe additive reviewed drift. Governance-disabled projects SHALL be allowed to own only their applicable repair integrations without gaining policy/setup/assessment authority.

#### Scenario: An older selected-agent project is updated
- **WHEN** its manifest predates repair integrations and the developer previews a managed update
- **THEN** only applicable exact repair artifacts are offered along with legitimate managed drift
- **AND** they install only through matching reviewed update approval

#### Scenario: A custom file occupies the native repair path
- **WHEN** an unowned file differs from the generated repair integration
- **THEN** update preserves it even under force and reports the collision
- **AND** neighboring skills and application/history files remain unchanged

#### Scenario: A managed integration is customized
- **WHEN** a tracked repair integration conflicts with the current managed content
- **THEN** existing exact managed-conflict preview/approval rules apply without extending authority to unowned files

#### Scenario: Integration changes fail on Windows
- **WHEN** a selected-agent update is interrupted or a destination is unsafe on Windows, macOS or Linux
- **THEN** the guarded transaction preserves original bytes or reports exact recoverable progress
- **AND** no prefix cleanup or blanket skill-directory replacement is permitted

### Requirement: Application patch authority never becomes generation provenance
Application-patch approval SHALL authorize only its exact explicitly mapped project files and registered repair bookkeeping. It SHALL NOT allow an agent or submitted application patch to forge or retag Liftoff manifest generation identity, desired state, framework installation, approval, activation evidence or historical conformance. This restriction SHALL NOT remove the deterministic Azure recipe's separately registered, reviewed manifest and history writes. Original provenance and history SHALL be preserved even when application files are moved or customized.

#### Scenario: An agent has staged a valid application move
- **WHEN** the exact patch is independently verified and approved
- **THEN** the file transaction changes only the reviewed project files and history/backup records
- **AND** original manifest and activation state/evidence remain byte-identical

### Requirement: Preparation owns only registered private disposable scope
Dependency preparation SHALL receive authority only over explicitly registered CLI-created private environment/cache/output roles and their bounded lifecycle records. It SHALL NOT acquire original-project, patch-staging, managed-core, desired-state, framework, global configuration, live dependency-tree, backup or historical ownership. Each cleanup SHALL validate the exact canonical created-workspace identity and external authority rather than select paths by a prefix, glob, caller input, expiry or bare PID.

#### Scenario: Frozen dependencies and build outputs are produced
- **WHEN** an approved preparation/check sequence creates private dependencies, caches or generated output
- **THEN** those bytes remain outside the application patch's committed mutation inventory
- **AND** cleanup cannot delete the original project, user patch staging or original-byte backups

#### Scenario: A private workspace path becomes a junction
- **WHEN** a registered disposable path changes identity or is replaced by a link/junction on a supported platform
- **THEN** cleanup is blocked and its recovery record remains intact without following the new target

#### Scenario: Windows Job controller asset is packaged only
- **WHEN** Liftoff is packaged and installed
- **THEN** `windows-job-controller.ps1` is a packaged source asset under `assets/repair/`, not a project artifact or managed-core template
- **AND** it does not become an owned or tracked file in developer repositories
