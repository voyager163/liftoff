## ADDED Requirements

### Requirement: Public local infrastructure repair has an executable bounded recipe
The CLI SHALL expose a local infrastructure repair lane for supported recorded Azure flat-root projects, distinct from protected stateful execution. It SHALL inspect real configuration, produce the selected independent environment roots and shared application module, and preserve supported source semantics without replacing application code. Writes and retirements SHALL use explicit registered artifact identities. Unsupported constructs or conflicting partial migrations SHALL produce specific plan-only blockers.

#### Scenario: Approved undeployed legacy project
- **WHEN** supported legacy source has complete authoritative undeployed observations and its exact repair is approved
- **THEN** the CLI reorganizes the source into the shared module and selected environment roots, validates the candidate, and records actual current provenance
- **AND** unrelated files and historical activation evidence remain unchanged

#### Scenario: Supported customization and partial move
- **WHEN** source bodies have supported custom values or an equivalent file was already moved into the target layout
- **THEN** repair preserves those semantics and describes only the remaining exact transformation
- **AND** different competing bodies are not overwritten or silently deduplicated

#### Scenario: Additional active configuration
- **WHEN** an uninventoried active OpenTofu file, external module, unresolved provider scope or path-dependent construct exists
- **THEN** the CLI identifies the unsupported scope and does not execute a partial destructive reorganization

### Requirement: Public undeployed checks require bounded explicit metadata authority
An ordinary local repair preview SHALL make no cloud requests or state reads. Live absence checks SHALL require an explicitly selected subscription and existing authentication, use bounded commands, and establish all supported resource/backend bindings. Apply SHALL repeat observations before mutations. State absence on disk, user assertion, access failure, or a newer manifest alone SHALL NOT establish undeployed eligibility.

#### Scenario: Preview without live authority
- **WHEN** a legacy project has no visible state and repair check has no live scope
- **THEN** it remains unknown and reports the exact supported live check as the next action

#### Scenario: Existing group or state
- **WHEN** metadata discovers a relevant resource group or local state
- **THEN** local transformation is blocked and the report distinguishes required protected stateful migration from local file repair
- **AND** no sensitive state is read and no unimplemented execution command is offered

#### Scenario: Denied or timed out observation
- **WHEN** a metadata probe fails, exceeds its deadline, or returns an invalid result
- **THEN** observation is incomplete, the failure is reported, and no project writes occur

### Requirement: Local repair approval and recovery bind exact project effects
Repair SHALL use a distinct expiring external preview, explicit fingerprint approval, a bounded recoverable transaction, and immutable original provenance. Changed source/destination files, subscription scope, tool/recipe identity or plan effects SHALL invalidate approval. Update and repair SHALL reject overlapping unfinished transactions. Post-commit results SHALL distinguish repaired infrastructure from incomplete local governance.

#### Scenario: Preview then edit
- **WHEN** any inventoried source or target changes between check and application
- **THEN** application rejects the stale preview without overwriting the edit

#### Scenario: Interrupted write recovery
- **WHEN** an approved repair transaction is interrupted
- **THEN** repair exposes explicit recovery of its recorded operations and refuses new writes until recovery is resolved
- **AND** concurrent edits are preserved and incomplete rollback is reported

#### Scenario: Windows paths and unsafe destinations
- **WHEN** a project path contains spaces on Windows
- **THEN** commands use separate arguments and the exact canonical project boundary
- **AND** symlinks, junctions and case-colliding destinations cannot gain write authority

#### Scenario: Repaired project is checked again
- **WHEN** repaired current inventory and its required validation are complete
- **THEN** repair does not repeat the transformation or rewrite original provenance
- **AND** it does not claim cloud activation complete
