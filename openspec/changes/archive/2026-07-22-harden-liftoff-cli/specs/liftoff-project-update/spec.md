## MODIFIED Requirements

### Requirement: Apply writes only safe states by default
The system SHALL, when `liftoff update --apply` runs, write artifacts classified as new, missing, or upgrade only after verifying that the destination is absent or belongs to the same recorded artifact. It SHALL relocate a clean moved artifact only when the destination is absent or already matches the current render, SHALL classify any different pre-existing destination as a conflict, SHALL skip conflicts with a per-file notice, and SHALL report orphans without deleting them. The system SHALL remove an old path only for a verified managed relocation, only after the destination succeeds, and never outside the project root.

#### Scenario: Apply safe changes
- **WHEN** a developer runs `liftoff update --apply` in a project with collision-free new and upgrade artifacts plus a conflict
- **THEN** the new and upgrade artifacts are written, the conflict file is left untouched and listed as skipped, and the command exits 0

#### Scenario: Restore a deleted generated file
- **WHEN** a developer deleted a generated file and runs `liftoff update --apply`
- **THEN** the file is restored at the current template version

#### Scenario: Existing file blocks a new artifact
- **WHEN** the current render adds a logical artifact whose destination already contains different bytes not owned by that manifest artifact
- **THEN** update classifies the destination as a conflict and `--apply` leaves it unchanged

#### Scenario: Existing file blocks a moved artifact
- **WHEN** a clean recorded artifact moved in the template but its new destination already contains different user-owned bytes
- **THEN** update classifies the move as a conflict and leaves both old and new files unchanged without `--force`

#### Scenario: Existing matching destination is adopted
- **WHEN** a new or moved artifact destination already contains bytes identical to the current render
- **THEN** apply records the current destination without unnecessarily rewriting those bytes

#### Scenario: Clean relocation removes only its managed old path
- **WHEN** a clean moved artifact has an unoccupied destination inside the project and the destination write succeeds
- **THEN** apply writes the new path, removes only the recorded old managed path, and records the new path in the manifest

#### Scenario: Orphans are never auto-deleted
- **WHEN** an artifact exists in the manifest but is no longer produced by the render
- **THEN** apply leaves the file on disk and reports it as orphaned with guidance to delete manually if unwanted

## ADDED Requirements

### Requirement: Apply failures are observable and recoverable
The system SHALL preflight all artifact paths and destinations before mutation, SHALL treat only a confirmed missing path as absent, and SHALL stop with exit code 1 when a write, atomic replacement, move cleanup, or manifest write fails. A failed apply MUST name the affected artifact and operation, MUST NOT print a successful completion summary, and MUST NOT record a failed mutation as completed.

#### Scenario: Destination write fails
- **WHEN** apply cannot write an artifact because of permissions, path type, storage, or another filesystem error
- **THEN** it exits 1 with the artifact path and underlying operation, and the manifest does not claim that write succeeded

#### Scenario: Move cleanup fails
- **WHEN** apply writes a moved artifact destination but cannot remove the verified old managed path
- **THEN** it exits 1, reports the cleanup failure, and does not silently report a completed move

#### Scenario: Preflight rejects every unsafe mutation before writes
- **WHEN** any planned artifact path or destination fails project-boundary or collision validation
- **THEN** apply performs no artifact mutation and reports the preflight failure

#### Scenario: Retry after a partial filesystem failure
- **WHEN** a developer corrects the filesystem problem and reruns update after a failed apply
- **THEN** reconciliation detects the actual bytes on disk and can safely converge the project without manual manifest editing
