## MODIFIED Requirements

### Requirement: Update reconciles a generated project against a fresh render
The system SHALL provide a `liftoff update` command that loads `liftoff.config.json` as desired state, renders all artifacts with the current CLI templates, joins the render against `liftoff.manifest.json` on `logicalName`, and classifies every artifact into exactly one of: unchanged, new, missing, upgrade, conflict, moved, or orphan. Plain `liftoff update` SHALL apply safe managed changes immediately in interactive, redirected, and non-interactive environments; it SHALL skip conflicts unless `--force` is supplied and SHALL leave orphans untouched. `liftoff update --check` SHALL be the explicit read-only mode, SHALL print each non-unchanged artifact with its state and a one-line reason, and SHALL exit 0 when no drift exists and 2 when drift exists.

#### Scenario: Clean project reports no drift
- **WHEN** a developer runs `liftoff update` in a freshly generated project with the generating CLI version
- **THEN** the command reports no drift, exits 0, and performs no unnecessary write

#### Scenario: Check classifies drift without applying
- **WHEN** a developer runs `liftoff update --check` where templates evolved and one generated file was edited
- **THEN** the report lists untouched template changes as upgrades and the edited file as a conflict
- **AND** it exits 2 without writing any file

#### Scenario: User modification is detected by hash
- **WHEN** a generated file's content hash differs from the `contentHash` recorded in the manifest
- **THEN** update treats the file as user-modified and never classifies it as a safe upgrade

#### Scenario: Moved artifact is detected by logical name
- **WHEN** the current templates emit an artifact whose `logicalName` exists in the manifest under different path parts
- **THEN** update classifies it as moved and reports the old and new locations

#### Scenario: Redirected update applies safe changes
- **WHEN** plain `liftoff update` runs with redirected input or output and actionable safe drift exists
- **THEN** it requests no input and applies the safe changes through the normal transaction

#### Scenario: Redirected check stays read-only
- **WHEN** `liftoff update --check` runs with redirected input or output
- **THEN** it requests no input, writes nothing, and exits 2 when drift exists

### Requirement: Apply writes only safe states by default
The system SHALL, when plain `liftoff update` runs, write artifacts classified as new, missing, or upgrade only after verifying that the destination is absent or belongs to the same recorded artifact. It SHALL relocate a clean moved artifact only when the destination is absent or already matches the current render, SHALL classify any different pre-existing destination as a conflict, SHALL skip conflicts with a per-file notice unless `--force` is supplied, and SHALL report orphans without deleting them. The system SHALL remove an old path only for a verified managed relocation, only after the destination succeeds, and never outside the project root.

#### Scenario: Update applies safe changes
- **WHEN** a developer runs `liftoff update` in a project with collision-free new and upgrade artifacts plus a conflict
- **THEN** the new and upgrade artifacts are written, the conflict file is left untouched and listed as skipped, and the command exits 0

#### Scenario: Restore a deleted generated file
- **WHEN** a developer deleted a generated file and runs `liftoff update`
- **THEN** the file is restored at the current template version

#### Scenario: Existing file blocks a new artifact
- **WHEN** the current render adds a logical artifact whose destination already contains different bytes not owned by that manifest artifact
- **THEN** update classifies the destination as a conflict and plain update leaves it unchanged

#### Scenario: Existing file blocks a moved artifact
- **WHEN** a clean recorded artifact moved in the template but its new destination already contains different user-owned bytes
- **THEN** update classifies the move as a conflict and leaves both old and new files unchanged without `--force`

#### Scenario: Existing matching destination is adopted
- **WHEN** a new or moved artifact destination already contains bytes identical to the current render
- **THEN** update records the current destination without unnecessarily rewriting those bytes

#### Scenario: Clean relocation removes only its managed old path
- **WHEN** a clean moved artifact has an unoccupied destination inside the project and the destination write succeeds
- **THEN** update writes the new path, removes only the recorded old managed path, and records the new path in the manifest

#### Scenario: Orphans are never auto-deleted
- **WHEN** an artifact exists in the manifest but is no longer produced by the render
- **THEN** update leaves the file on disk and reports it as orphaned with guidance to delete manually if unwanted

### Requirement: Force extends apply to conflicted files
The system SHALL accept `--force` directly on plain `liftoff update` and SHALL overwrite conflicted files with the current template version only after the existing conflict, path, and transaction guards pass. It SHALL identify exactly which files can be overwritten, preserve every unlisted conflict, and print a commit-first warning when the project is a Git repository with uncommitted changes. The system SHALL reject `--force` together with `--check`.

#### Scenario: Force overwrites conflicts
- **WHEN** a developer runs `liftoff update --force` in a project with a conflicted file
- **THEN** the conflicted file is overwritten with the current template rendering without an interactive prompt

#### Scenario: Force with check is rejected
- **WHEN** a developer runs `liftoff update --check --force`
- **THEN** the command exits 1 before project mutation and explains that a read-only check cannot authorize overwrites

#### Scenario: Removed apply flag is rejected
- **WHEN** a developer runs `liftoff update --apply`
- **THEN** the command exits 1 before project discovery or writes and directs the developer to plain `liftoff update`

#### Scenario: Dirty worktree warning
- **WHEN** a developer runs an update that can write in a Git repository with uncommitted changes
- **THEN** the command prints a hint to commit before applying and proceeds according to `--force`

### Requirement: Configuration edits are a reconciled drift axis
The system SHALL treat `liftoff.config.json` as user-owned desired state that the CLI never rewrites after generation and SHALL reconcile only configuration fields applicable to the recorded workload. For API workloads, newly listed environments or an enabled frontend yield new artifacts and removed selections yield orphans. For Power Apps workloads, a changed optional Code Apps plugin preference updates workload guidance and diagnostics intent without creating API artifacts.

#### Scenario: API environment added to config
- **WHEN** a developer adds an environment to an API workload's `liftoff.config.json` and runs `liftoff update`
- **THEN** the environment's configuration artifacts are generated and recorded in the manifest

#### Scenario: API environment removed from config
- **WHEN** a developer removes an environment from an API workload's `liftoff.config.json` and runs `liftoff update`
- **THEN** that environment's artifacts are reported as orphans and left on disk

#### Scenario: Power Apps plugin preference changes
- **WHEN** a developer changes the valid Code Apps plugin preference in a Power Apps configuration and runs update
- **THEN** update reconciles named generated guidance and records the new preference
- **AND** it does not add backend, cloud, Docker, or infrastructure artifacts

#### Scenario: Power Apps rejects API configuration drift
- **WHEN** a Power Apps configuration adds an API stack, pattern, cloud, region, frontend, or API environment field
- **THEN** update exits 1 before rendering or writing and identifies the inapplicable field

### Requirement: Apply rewrites the manifest as the recorded state
The system SHALL, after a successful default update, rewrite `liftoff.manifest.json` at the latest supported schema with the current CLI version and fresh content hashes for every artifact it wrote, while skipped conflicts retain their previously recorded hash so drift remains visible on subsequent checks.

#### Scenario: Manifest catches up after update
- **WHEN** plain `liftoff update` completes
- **THEN** the manifest records the running CLI's version and hashes matching every file update wrote

#### Scenario: Skipped conflict stays visible
- **WHEN** a conflict was skipped during update and the developer runs `liftoff update --check`
- **THEN** the file is still reported as a conflict

### Requirement: Seed content is excluded from reconciliation and recorded state
The system SHALL treat seed-category artifacts as one-time gifted content: they SHALL NOT be reconciled in either direction (never classified, restored, upgraded, or reported), and manifest readers SHALL drop legacy seed entries recorded by earlier CLI versions so that archiving or removing seed content is a non-event for `validate`, `update`, and `doctor`.

#### Scenario: Archived seed change causes no drift
- **WHEN** a developer archives the seeded bootstrap change and runs `liftoff update`
- **THEN** the command reports no drift for the seed files and does not re-create them

#### Scenario: Validate stays green after archiving the seed
- **WHEN** a developer archives the seeded bootstrap change and runs `liftoff validate`
- **THEN** validation passes

#### Scenario: Legacy manifests heal on update
- **WHEN** a project generated by CLI 0.2.0 whose manifest records seed entries runs `liftoff update`
- **THEN** seed entries are ignored during reconciliation and the rewritten manifest no longer contains them

#### Scenario: Emitted migration plan stays invisible
- **WHEN** a developer archives the `migrate-to-liftoff` change emitted by `liftoff migrate` and runs `liftoff update`
- **THEN** the command reports no drift related to the emitted plan

### Requirement: Update offers versioned machine-readable output
The system SHALL support `--json` on update, emitting a machine-readable object with a top-level numeric `schemaVersion`. Plain `liftoff update --json` SHALL apply safe changes and emit apply results; `liftoff update --check --json` SHALL emit per-artifact drift states and summary counts without mutation.

#### Scenario: JSON apply result
- **WHEN** a developer runs `liftoff update --json` in a drifted project
- **THEN** safe changes are applied and stdout contains a byte-pure JSON object with `schemaVersion`, `mode: "apply"`, written entries, skipped conflicts, and summary counts

#### Scenario: JSON drift report
- **WHEN** a developer runs `liftoff update --check --json` in a drifted project
- **THEN** stdout contains a byte-pure JSON object with `schemaVersion`, `mode: "check"`, per-artifact states, and summary counts
- **AND** no project file changes and the command exits 2

### Requirement: Update reconciles packaged Power Apps starter artifacts
The system SHALL re-render Power Apps projects from the immutable starter snapshot packaged with the running Liftoff version and join those files to manifest entries by explicit logical name. Newer Liftoff releases MAY offer an upstream starter refresh as ordinary new, upgrade, moved, conflict, or orphan states, and SHALL apply the existing content-hash, default safe-apply, explicit check, and force rules without fetching upstream source at update time.

#### Scenario: Current starter is clean
- **WHEN** a Power Apps project matches the running Liftoff release's packaged starter and generated guidance
- **THEN** `liftoff update` reports no drift and exits 0

#### Scenario: Untouched starter file has an available upgrade
- **WHEN** the running Liftoff release contains a changed pinned starter file and the project's recorded file remains unmodified
- **THEN** update classifies and applies the named artifact as an upgrade

#### Scenario: Developer-edited starter file conflicts
- **WHEN** both the packaged starter artifact and the developer's recorded file changed
- **THEN** plain update classifies the artifact as a conflict and leaves it untouched unless `--force` is supplied

#### Scenario: Update is offline from upstream
- **WHEN** a developer checks or applies Power Apps updates without access to GitHub
- **THEN** reconciliation uses only the packaged source catalog and completes without contacting the upstream repository

### Requirement: Update normalizes old manifests before writing schema v4
The system SHALL normalize supported v2 and v3 manifests into the internal GenAI or standard workload union before reconciliation. `liftoff update --check` SHALL leave the source manifest byte-for-byte unchanged. A successful plain update SHALL write schema v4 with fresh hashes for written artifacts while preserving skipped-conflict hashes and legacy framework uncertainty.

#### Scenario: Check a v3 project without rewriting
- **WHEN** a developer runs `liftoff update --check` in a valid v3 project
- **THEN** update performs normalized reconciliation and leaves the v3 manifest byte-for-byte unchanged

#### Scenario: Update upgrades a v3 project manifest
- **WHEN** a developer runs plain `liftoff update` in a valid v3 project and reconciliation completes successfully
- **THEN** update writes schema v4 with equivalent normalized workload, framework, and agent identity

#### Scenario: Legacy framework state remains uncertain
- **WHEN** a v2 manifest without official framework metadata is rewritten to v4
- **THEN** the new manifest records legacy framework state without fabricating selected-agent integrations

## REMOVED Requirements

### Requirement: Interactive update discloses impact and obtains tiered consent
**Reason**: Update becomes an imperative command. Safe changes apply immediately, conflicts require explicit `--force`, and read-only review moves to `--check`.

**Migration**: Replace interactive preview with `liftoff update --check`; run `liftoff update` for safe reconciliation or `liftoff update --force` after reviewing conflicts.
