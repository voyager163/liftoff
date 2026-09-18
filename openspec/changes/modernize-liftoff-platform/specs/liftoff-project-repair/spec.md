## ADDED Requirements

### Requirement: Azure baseline settings have a distinct bounded repair recipe
Repair SHALL register `azure-baseline-settings` version 1 separately from Azure layout reorganization and application-file patches. It SHALL inspect exact supported Redis, storage and Service Bus configuration, plan only the selected explicit TLS/private-blob corrections, and preserve unrelated customizations. It SHALL use the existing current approval, verification, history, confinement and recovery guarantees without broadening the application-patch recipe's infrastructure exclusion.

#### Scenario: Plan the four explicit Azure settings
- **WHEN** a supported existing configuration lacks the required Redis/Service Bus minimum TLS or storage minimum TLS/private-blob setting
- **THEN** repair presents exact affected resources, files, attributes and validation effects under the new recipe identity
- **AND** no application, state, credential, networking or unrelated resource change is included

#### Scenario: The infrastructure layout is already current
- **WHEN** a supported independent-root project needs only baseline-setting correction
- **THEN** the recipe remains available without pretending that a structural migration is required

#### Scenario: A dynamic expression cannot be safely interpreted
- **WHEN** the current setting's meaning or resource binding cannot be established within the supported inspection contract
- **THEN** execution remains blocked with the unresolved mapping
- **AND** the model cannot resolve it by asserting compliance or overwriting customized expressions with a starter

#### Scenario: An already compliant value is present
- **WHEN** current explicit configuration satisfies the supported policy, including a supported stronger setting
- **THEN** the plan preserves it and a matching repeated repair has no configuration writes

#### Scenario: An application patch names infrastructure
- **WHEN** application-layout-patch is supplied an infrastructure correction
- **THEN** it remains rejected under its existing exclusions
- **AND** guidance names the separate baseline-setting recipe rather than expanding the approved application scope

### Requirement: Baseline setting application separates local correction from Azure effects
Baseline-setting repair SHALL require an immutable project-bound preview, current source/destination observations, separate consent for any validation execution, and exact file-write approval. It SHALL preserve original configuration and immutable history, use explicit registered write identities, and revalidate under the project lock. It SHALL NOT run cloud apply, inspect sensitive state, claim deployed compliance or infer another command's permission.

#### Scenario: Approve local configuration only
- **WHEN** the user approves the displayed validation and exact baseline-setting file effects
- **THEN** the recipe applies only those effects after fresh successful validation and readback
- **AND** existing deployed resources and state are not mutated

#### Scenario: Source changes while approval is open
- **WHEN** a bound file, mode, directory, target setting or validation policy changes before commit
- **THEN** the old approval is rejected and the user's changes remain preserved

#### Scenario: Local writes are interrupted
- **WHEN** an approved baseline-setting transaction stops before its complete outcome
- **THEN** recovery identifies only its recorded exact effects and original recipe identity
- **AND** it does not rerun cloud work, start a new recipe or overwrite concurrent changes

#### Scenario: A destination aliases another file
- **WHEN** a Windows, macOS or Linux path resolves through an unsafe link, junction, traversal or case/normalization collision
- **THEN** planning and application reject the ambiguous target

### Requirement: Engine extraction preserves released repair authority
Moving repair into the Project Evolution engine and shared execution kernel SHALL preserve the 0.12.3 distinction among inventory, proposed patch, verified candidate, committed effects and recovery. Existing contract-1 recipe guarantees and registered record/recovery formats SHALL remain available where unchanged. New adoption or governance identities SHALL NOT silently reinterpret older repair receipts.

#### Scenario: Recover a pre-cutover repair after native installation
- **WHEN** the native CLI encounters an explicitly supported sealed historical repair journal
- **THEN** it offers recovery of those exact effects using the original compatibility contract
- **AND** installing the native CLI has not rewritten the journal, project or private backup

#### Scenario: New governance identity is selected
- **WHEN** a project adopts the new manifest/activation family
- **THEN** repair still validates its own exact recipe and approval identity
- **AND** governance approval does not authorize application scripts, dependency preparation or file writes

#### Scenario: A skill asks to bypass missing repair support
- **WHEN** the installed capability matrix does not support a requested repair operation
- **THEN** the skill reports the gap without direct real-project edits or fabricated records

### Requirement: Process settlement qualification preserves fail-closed cleanup
Every advertised repair verification/preparation host SHALL establish process-tree settlement through its qualified platform implementation before issuing success or cleaning owned disposable workspaces. Windows support SHALL include real controller startup, tool identity, environment alias, descendant accounting, interruption and cleanup cases. Timeout, host-policy rejection or uncertain settlement SHALL remain explicit failures rather than be bypassed to pass qualification.

#### Scenario: Windows controller qualification fails
- **WHEN** the actual supported Windows lane reports controller, tool-identity, timeout or settlement failure
- **THEN** that lane does not qualify the coordinated release
- **AND** a passing mocked protocol or another operating system's result does not substitute for it

#### Scenario: A native process may still be active
- **WHEN** verification cannot prove all owned descendants are settled
- **THEN** no successful verification receipt is issued and the exact private workspace is retained for supported recovery
- **AND** the system does not delete guessed paths or kill unrelated processes

#### Scenario: Host policy disallows the required controller
- **WHEN** a Windows host cannot admit the packaged controller under supported execution-policy conditions
- **THEN** repair reports the actual prerequisite before protected effects
- **AND** it does not change policy, add bypass flags or claim an unavailable sandbox
