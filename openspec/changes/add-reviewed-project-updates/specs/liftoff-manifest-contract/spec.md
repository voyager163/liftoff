## MODIFIED Requirements

### Requirement: Machine-state namespaces in generated projects are reserved
Machine-readable project paths SHALL remain OS-neutral path-part arrays. `.liftoff/` SHALL remain reserved for ordinary CLI-managed state, and no new CLI-managed root-level file SHALL be introduced beyond `liftoff.config.json` and `liftoff.manifest.json`. Explicitly approved activation history and its migration journal SHALL use registered paths under the existing user-owned `governance` namespace rather than become general managed-core state. Preview receipts SHALL remain outside the project and repository.

#### Scenario: Manifest paths are portable
- **WHEN** a manifest or migration index is produced on any supported platform
- **THEN** project-relative locations are stored as validated path segments without embedded native separators

#### Scenario: Root namespace stays fixed
- **WHEN** new update metadata is persisted
- **THEN** no new file is added at the project root and each destination follows its explicit CLI-state, historical-record, or external-receipt contract

#### Scenario: Migration paths resolve on Windows
- **WHEN** a preserved index or journal is read on Windows, macOS, or Linux
- **THEN** native resolution keeps each location within its declared boundary
- **AND** traversal, drive/UNC escapes, unsafe links, and case-colliding locations are rejected

### Requirement: CLI outputs follow shared exit-code and JSON conventions
The system SHALL use exit 0 for successful completed scope or clean checks, 1 for errors and rejected authorization, and 2 for detected differences or an explicitly documented partial outcome. Update SHALL use exit 2 when local activation migration committed but its revalidation remains blocked. Every machine-readable output SHALL include a numeric top-level schema version; changed update semantics SHALL use schema 3 rather than silently changing schema 2.

#### Scenario: JSON output is versioned
- **WHEN** a command emits JSON
- **THEN** it includes the appropriate numeric top-level `schemaVersion`

#### Scenario: Exit codes are consistent across commands
- **WHEN** a command completes
- **THEN** its exit code follows the documented success, error, or difference/partial classification without labeling partial readiness as full success

#### Scenario: A committed update still needs revalidation
- **WHEN** migration commits but local revalidation remains incomplete
- **THEN** update exits 2 and separately reports committed metadata and incomplete readiness

## ADDED Requirements

### Requirement: Activation identity changes are committed with their migration history
A supported activation migration SHALL retain manifest artifact version 7 and original project generation provenance. It SHALL preserve the source manifest bytes in the historical snapshot and change active governance identity only in the same guarded transaction as the linked strict successor and migration journal. Migration/history records SHALL not become managed-core content hashes, replacement authority, or evidence of live enforcement. The journal SHALL link source identity, target identity, approved plan, snapshot digest, and successor identity without adding a new required v7 field or retagging source records.

#### Scenario: A historical project is migrated
- **WHEN** an approved supported local migration commits
- **THEN** the active manifest records the installed CLI and target activation identity while the historical snapshot retains the original manifest bytes
- **AND** all project artifact generation hashes and original generating versions remain unchanged

#### Scenario: Revalidation fails after commit
- **WHEN** successor state and manifest are committed but revalidation fails
- **THEN** the target manifest remains active and the migration journal reports blocked readiness
- **AND** it does not claim completed governance

#### Scenario: Existing current v2 metadata is maintained
- **WHEN** a current v2 project receives a reviewed managed-core-only update
- **THEN** no historical successor or new activation identity is fabricated solely from the CLI version change

#### Scenario: Historical source metadata is not an execution target
- **WHEN** an inspector reads a source manifest from the exact validated history index
- **THEN** it treats that manifest as historical data rather than selecting it as the active project boundary
