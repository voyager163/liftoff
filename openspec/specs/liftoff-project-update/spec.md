## Purpose

Define the `liftoff update` command that reconciles generated projects against the current CLI templates and configuration: state classification, safe apply semantics, guards, manifest rewrite, and project-root discovery for project-scoped commands.

## Requirements

### Requirement: Update reconciles a generated project against a fresh render
The system SHALL provide a `liftoff update` command that loads `liftoff.config.json` as desired state, renders all artifacts with the current CLI templates, joins the render against `liftoff.manifest.json` on `logicalName`, and classifies every artifact into exactly one of: unchanged, new, missing, upgrade, conflict, moved, or orphan. Check mode SHALL be the default, SHALL write nothing, SHALL print each non-unchanged artifact with its state and a one-line reason, and SHALL exit 0 when no drift exists and 2 when drift exists.

#### Scenario: Clean project reports no drift
- **WHEN** a developer runs `liftoff update` in a freshly generated project with the generating CLI version
- **THEN** the command reports no drift and exits 0 without writing any file

#### Scenario: Drift report classifies artifacts
- **WHEN** a developer runs `liftoff update` in a project where the templates have evolved and one generated file was edited by the developer
- **THEN** the report lists template-changed untouched files as upgrades, the edited file as a conflict, and exits 2 without writing any file

#### Scenario: User modification is detected by hash
- **WHEN** a generated file's content hash differs from the `contentHash` recorded in the manifest
- **THEN** update treats the file as user-modified and never classifies it as a safe upgrade

#### Scenario: Moved artifact is detected by logical name
- **WHEN** the current templates emit an artifact whose `logicalName` exists in the manifest under different path parts
- **THEN** update classifies it as moved and reports the old and new locations

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

### Requirement: Force extends apply to conflicted files
The system SHALL accept `--force` only together with `--apply`, SHALL overwrite conflicted files with the template version when forced, and SHALL print a commit-first hint when the project is a git repository with uncommitted changes. Check mode SHALL list exactly which files a forced apply would overwrite.

#### Scenario: Force overwrites conflicts
- **WHEN** a developer runs `liftoff update --apply --force` in a project with a conflicted file
- **THEN** the conflicted file is overwritten with the current template rendering

#### Scenario: Force without apply is rejected
- **WHEN** a developer runs `liftoff update --force` without `--apply`
- **THEN** the command fails with a message explaining that `--force` requires `--apply`

#### Scenario: Dirty worktree hint
- **WHEN** a developer applies updates in a git repository with uncommitted changes
- **THEN** the command prints a hint to commit before applying and proceeds

### Requirement: Configuration edits are a reconciled drift axis
The system SHALL treat `liftoff.config.json` as user-owned desired state that the CLI never rewrites after generation, and update SHALL reconcile configuration changes through the same engine: newly listed environments or an enabled frontend yield new artifacts, and removed selections yield orphans.

#### Scenario: Environment added to config
- **WHEN** a developer adds an environment to `liftoff.config.json` and runs `liftoff update --apply`
- **THEN** the environment's configuration artifacts are generated and recorded in the manifest

#### Scenario: Environment removed from config
- **WHEN** a developer removes an environment from `liftoff.config.json` and runs `liftoff update`
- **THEN** that environment's artifacts are reported as orphans and left on disk

### Requirement: Update refuses unsafe reconciliations
The system SHALL refuse to run when the configured project type, API stack, or GenAI pattern differs from the corresponding normalized identity recorded by the manifest, directing the developer to `liftoff migrate`. The system SHALL also refuse when the manifest's `liftoffVersion` is newer than the running CLI, using semver-aware comparison that orders prerelease versions correctly and directing the developer to upgrade the CLI.

#### Scenario: Project-type change is refused
- **WHEN** a developer changes a generated project's configured type between GenAI and standard and runs `liftoff update`
- **THEN** the command fails with a message that project-type changes require a migration

#### Scenario: API-stack change is refused
- **WHEN** a developer changes a standard project's configured API stack and runs `liftoff update`
- **THEN** the command fails with a message that API-stack changes require a migration

#### Scenario: Pattern change is refused
- **WHEN** a developer changes a GenAI project's configured pattern and runs `liftoff update`
- **THEN** the command fails with a message that pattern changes require a migration

#### Scenario: Legacy identity is compared after normalization
- **WHEN** a legacy manifest omits project type and API stack but records a GenAI pattern matching the configuration
- **THEN** update treats the identity as GenAI with Python/FastAPI and continues normal reconciliation

#### Scenario: Newer-generated project is refused
- **WHEN** the manifest records a `liftoffVersion` greater than the running CLI version
- **THEN** the command fails with a message to upgrade the CLI first

### Requirement: Apply rewrites the manifest as the recorded state
The system SHALL, after a successful apply, rewrite `liftoff.manifest.json` at the latest supported schema with the current CLI version and fresh content hashes for every artifact it wrote, while skipped conflicts retain their previously recorded hash so drift remains visible on subsequent runs.

#### Scenario: Manifest catches up after apply
- **WHEN** `liftoff update --apply` completes
- **THEN** the manifest records the running CLI's version and hashes matching every file update wrote

#### Scenario: Skipped conflict stays visible
- **WHEN** a conflict was skipped during apply and the developer runs `liftoff update` again
- **THEN** the file is still reported as a conflict

### Requirement: Project-scoped commands resolve the project root by walking up
The system SHALL resolve the project root for project-scoped commands (`update`, `validate`, `doctor`) by using an explicit path argument when given, and otherwise walking parent directories from the current directory to the nearest `liftoff.manifest.json`, without assuming the project root equals the repository root.

#### Scenario: Update from a subdirectory
- **WHEN** a developer runs `liftoff update` from a subdirectory of a generated project
- **THEN** the command locates the project root by finding the nearest ancestor containing `liftoff.manifest.json`

#### Scenario: Explicit path wins
- **WHEN** a developer runs `liftoff validate ./some-project`
- **THEN** the command operates on the given path without walking up from the current directory

#### Scenario: Doctor discovers project context
- **WHEN** a developer runs `liftoff doctor` from a subdirectory of a generated project
- **THEN** doctor locates the project root and runs its project-aware layers against it

### Requirement: Seed content is excluded from reconciliation and recorded state
The system SHALL treat seed-category artifacts as one-time gifted content: they SHALL NOT be reconciled in either direction (never classified, restored, upgraded, or reported), and manifest readers SHALL drop legacy seed entries recorded by earlier CLI versions so that archiving or removing seed content is a non-event for `validate`, `update`, and `doctor`.

#### Scenario: Archived seed change causes no drift
- **WHEN** a developer archives the seeded bootstrap change and runs `liftoff update`
- **THEN** the command reports no drift for the seed files and `--apply` does not re-create them

#### Scenario: Validate stays green after archiving the seed
- **WHEN** a developer archives the seeded bootstrap change and runs `liftoff validate`
- **THEN** validation passes

#### Scenario: Legacy manifests heal on read
- **WHEN** a project generated by CLI 0.2.0 (whose manifest records seed entries) runs `liftoff update --apply`
- **THEN** seed entries are ignored during reconciliation and the rewritten manifest no longer contains them

#### Scenario: Emitted migration plan stays invisible
- **WHEN** a developer archives the `migrate-to-liftoff` change emitted by `liftoff migrate` and runs `liftoff update`
- **THEN** the command reports no drift related to the emitted plan

### Requirement: Update offers versioned machine-readable output
The system SHALL support `--json` on update, emitting a machine-readable report containing a top-level `schemaVersion`, the per-artifact states, and a summary, in both check and apply modes.

#### Scenario: JSON drift report
- **WHEN** a developer runs `liftoff update --json` in a drifted project
- **THEN** the output is a JSON object with `schemaVersion`, per-artifact state entries, and summary counts, and the exit code still reflects drift
