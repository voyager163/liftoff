## ADDED Requirements

### Requirement: Project repair has separate exact-plan authority
A supported local or stateful repair SHALL authorize only the exact project/configuration/backend effects in its own current plan. Stateful authority SHALL name the state bindings and safeguards explicitly. Neither repair nor activation SHALL change artifact lifecycle, make generation hashes overwrite consent, or expand ordinary update/force ownership. Unlisted files, state instances, resources, and customizations SHALL remain outside the operation.

#### Scenario: Approve an infrastructure repair
- **WHEN** a verified undeployed supported layout repair is approved
- **THEN** only its exact named project-file and bookkeeping operations can execute
- **AND** repaired infrastructure remains project-owned afterward

#### Scenario: Ordinary update runs after repair
- **WHEN** the current release has newer templates than a repaired project
- **THEN** ordinary update still reconciles only its declared managed-core scope
- **AND** it does not use the prior repair as continuing authority over project files

#### Scenario: Generation hash matches an old file
- **WHEN** a historical file still matches its recorded generation hash
- **THEN** that match alone does not authorize moving or replacing it
- **AND** execution still requires the independently eligible reviewed repair

#### Scenario: Add Codex beside custom skills
- **WHEN** an approved additive integration repair writes explicit Codex skills
- **THEN** other skills and configuration under shared parent directories remain unowned by that operation
- **AND** the directory name does not become a replacement or deletion pattern

### Requirement: Repair history preserves superseded provenance without granting authority
Repair SHALL retain original provenance and committed repair receipts as explicit historical records outside managed-core template reconciliation. Only the exact progress/journal operations declared by the repair protocol SHALL be mutable. Source snapshots SHALL not be restored, deleted, or rewritten by ordinary update, force, preview cleanup, or a failed post-commit local check.

Sensitive state backups and working plans SHALL remain in approved protected storage rather than repository history. An explicit stateful recovery plan can use a verified backup only when current concurrency/ownership preconditions hold; ordinary history retention is not restoration authority.

#### Scenario: Local verification fails after repair commit
- **WHEN** the current repaired project has incomplete local proof
- **THEN** the repair history and current files remain preserved for a scoped retry
- **AND** the system does not reset the project to its former layout

#### Scenario: An unrelated file shares the history directory
- **WHEN** a file is absent from the exact registered repair inventory
- **THEN** repair and cleanup leave it untouched on Windows, macOS, and Linux

### Requirement: Desired-state edits through repair are narrowly authorized
An approved additive agent repair SHALL be allowed to change only the reviewed agent list and applicable default-agent fields in developer-owned desired state. Other desired-state keys and project behavior SHALL be preserved. Repair SHALL not turn the configuration file into a managed-core template.

#### Scenario: Add an agent through the supported repair flow
- **WHEN** Codex is added through an approved plan
- **THEN** desired state and manifest selection are reconciled with actual framework output
- **AND** unrelated configuration values retain their meaning

#### Scenario: A configuration field changes concurrently
- **WHEN** desired state differs from the approved snapshot before commit
- **THEN** repair refuses the stale write rather than replacing the developer's edit

### Requirement: Activation authority names project and provider effects explicitly
Approved activation SHALL authorize only its exact source/workflow/configuration, publication, identity, resource, artifact, and enforcement operations. Required environment/target preparation SHALL be presented explicitly instead of silently adding deployment scope. Unknown resources, workflows, or files SHALL not become owned because their names or directories resemble generated artifacts.

#### Scenario: Policy qualification needs another environment
- **WHEN** the requested profile requires an environment absent from desired state
- **THEN** the CLI presents the concrete preparation and cost/permission scope for approval
- **AND** it neither silently provisions the environment nor marks mandatory proof inapplicable

#### Scenario: A cloud resource already exists
- **WHEN** only a matching resource name is known
- **THEN** activation requires verified ownership/adoption scope before mutation

#### Scenario: Approved compensation is needed
- **WHEN** an operation fails after producing owned effects
- **THEN** recovery is confined to the approved compensation inventory and current preconditions
- **AND** it does not unregister shared providers, erase unrelated state, or revert unrelated development
