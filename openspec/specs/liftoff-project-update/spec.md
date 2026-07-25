## Purpose

Define the `liftoff update` command that reconciles generated projects against the current CLI templates and configuration: state classification, safe apply semantics, guards, manifest rewrite, and project-root discovery for project-scoped commands.

## Requirements

### Requirement: Update reconciles a generated project against a fresh render
The system SHALL provide a `liftoff update` command that loads `liftoff.config.json` as desired state, renders all artifacts with the current CLI templates, joins the render against `liftoff.manifest.json` on `logicalName`, and classifies every artifact into exactly one of: unchanged, new, missing, upgrade, conflict, moved, or orphan. An invocation that is not applying and uses JSON output or lacks interactive input or output SHALL run as a read-only check, SHALL print each non-unchanged artifact with its state and a one-line reason, and SHALL exit 0 when no drift exists and 2 when drift exists. A human interactive invocation without `--apply` SHALL remain read-only until the developer grants the applicable interactive permissions and SHALL enter the existing apply path only after consent.

#### Scenario: Clean project reports no drift
- **WHEN** a developer runs `liftoff update` in a freshly generated project with the generating CLI version
- **THEN** the command reports no drift, requests no consent, and exits 0 without writing any file

#### Scenario: Drift report classifies artifacts
- **WHEN** update checks a project where the templates have evolved and one generated file was edited by the developer
- **THEN** the report lists template-changed untouched files as upgrades and the edited file as a conflict
- **AND** a non-interactive check or declined interactive update exits 2 without writing any file

#### Scenario: User modification is detected by hash
- **WHEN** a generated file's content hash differs from the `contentHash` recorded in the manifest
- **THEN** update treats the file as user-modified and never classifies it as a safe upgrade

#### Scenario: Moved artifact is detected by logical name
- **WHEN** the current templates emit an artifact whose `logicalName` exists in the manifest under different path parts
- **THEN** update classifies it as moved and reports the old and new locations

#### Scenario: Redirected update remains a check
- **WHEN** `liftoff update` has redirected input or output and no explicit apply flag
- **THEN** it never requests input, writes nothing, emits the existing apply command guidance for actionable drift, and exits 2

### Requirement: Interactive update discloses impact and obtains tiered consent
When an update invocation uses human output with interactive input and output, has no explicit apply flag, and detects actionable drift, the system SHALL show an impact summary before mutation and SHALL collect every required permission before preflight or filesystem writes. The impact summary SHALL identify the safe create, restore, replace, move, and recorded-state actions; the number of local or user-owned conflicts at risk; managed old paths removed by moves; orphans preserved; manifest refresh; affected dependency-definition artifacts; and that update neither installs dependencies nor retains a recovery copy after a successful overwrite. Safe reconciliation and conflict overwrite SHALL use separate default-No permissions, and displayed paths SHALL remain portable project-relative paths on Windows, macOS, and Linux.

#### Scenario: Safe template updates are explained and accepted
- **WHEN** an interactive developer runs `liftoff update` with two untouched generated dependency files whose templates changed
- **THEN** Liftoff reports two safe replacements, zero developer edits lost, the affected dependency-definition paths, manifest refresh, no dependency installation, and no orphan deletion
- **AND** it asks once, defaulting to No, whether to apply the safe updates in the same invocation
- **AND** answering Yes applies them through the normal transactional update path

#### Scenario: Safe update is declined
- **WHEN** an interactive developer declines the safe-update question or accepts its default No
- **THEN** Liftoff reports that no project files changed, performs no preflight or mutation, and exits 2 because drift remains

#### Scenario: Conflicts require separate overwrite consent
- **WHEN** actionable drift contains safe changes and one or more locally modified or user-owned conflicts
- **THEN** permission to apply safe changes does not authorize any conflict replacement
- **AND** Liftoff lists every at-risk conflict path in stable order, warns that successful replacement has no retained Liftoff backup, and separately asks whether to overwrite them with a default of No

#### Scenario: Conflict overwrite is declined after safe consent
- **WHEN** a developer accepts safe changes and declines conflict overwrite
- **THEN** Liftoff applies the safe subset in one transaction, preserves every conflict, and reports each conflict as skipped

#### Scenario: Conflict overwrite is accepted
- **WHEN** a developer explicitly accepts the separate conflict-overwrite question
- **THEN** Liftoff applies the safe and conflicted authorized actions in one transaction using the same guards as `--apply --force`

#### Scenario: Conflict-only drift is reviewed
- **WHEN** an interactive update has conflicts but no safe write or recorded-state action
- **THEN** Liftoff skips the safe-update question and presents the conflict impact and overwrite question directly
- **AND** declining performs no mutation and exits 2

#### Scenario: Orphan-only drift does not prompt
- **WHEN** the only drift consists of orphaned artifacts
- **THEN** Liftoff reports that the orphans remain untouched, does not request apply or overwrite consent, writes nothing, and exits 2

#### Scenario: Cancellation before authorization is mutation-free
- **WHEN** interactive input closes or is cancelled before all required update decisions are collected
- **THEN** Liftoff reports cancellation and leaves every project file byte-for-byte unchanged

#### Scenario: Reviewed state changes before execution
- **WHEN** a reviewed source, destination, configuration, or manifest path changes while update consent is pending
- **THEN** Liftoff aborts before overwriting or deleting any project path and requires the developer to review the current state again
- **AND** the guard applies to accepted actions that need no content write, including matching move destinations and recorded-state-only refreshes

#### Scenario: Dirty worktree warning precedes consent
- **WHEN** an interactive update can write and the project Git worktree has uncommitted changes
- **THEN** Liftoff advises committing local work before it displays the impact and requests permission

#### Scenario: Windows impact paths remain portable
- **WHEN** interactive update impact is displayed on Windows
- **THEN** every affected and at-risk file is identified by the same portable project-relative path semantics used on macOS and Linux
- **AND** filesystem preflight and mutation use platform-correct path resolution

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
The system SHALL accept the `--force` flag only together with `--apply` and SHALL overwrite conflicted files with the template version when explicitly forced. A separate interactive conflict-overwrite permission MAY authorize the same validated conflict replacements without requiring a second command. Both authorization forms SHALL identify exactly which files can be overwritten, SHALL preserve every unlisted or unapproved conflict, and SHALL print a commit-first hint when the project is a Git repository with uncommitted changes.

#### Scenario: Force overwrites conflicts
- **WHEN** a developer runs `liftoff update --apply --force` in a project with a conflicted file
- **THEN** the conflicted file is overwritten with the current template rendering without an interactive prompt

#### Scenario: Interactive consent overwrites conflicts
- **WHEN** a developer accepts the separate interactive overwrite question for the reported conflict set
- **THEN** those validated conflicted files are overwritten with the current template rendering

#### Scenario: Force without apply is rejected
- **WHEN** a developer runs `liftoff update --force` without `--apply`
- **THEN** the command fails with a message explaining that the flag requires `--apply`

#### Scenario: Dirty worktree hint
- **WHEN** a developer is asked to authorize or explicitly applies updates in a Git repository with uncommitted changes
- **THEN** the command prints a hint to commit before applying and proceeds only according to the selected consent

### Requirement: Configuration edits are a reconciled drift axis
The system SHALL treat `liftoff.config.json` as user-owned desired state that the CLI never rewrites after generation and SHALL reconcile only configuration fields applicable to the recorded workload. For API workloads, newly listed environments or an enabled frontend yield new artifacts and removed selections yield orphans. For Power Apps workloads, a changed optional Code Apps plugin preference updates workload guidance and diagnostics intent without creating API artifacts.

#### Scenario: API environment added to config
- **WHEN** a developer adds an environment to an API workload's `liftoff.config.json` and runs `liftoff update --apply`
- **THEN** the environment's configuration artifacts are generated and recorded in the manifest

#### Scenario: API environment removed from config
- **WHEN** a developer removes an environment from an API workload's `liftoff.config.json` and runs `liftoff update`
- **THEN** that environment's artifacts are reported as orphans and left on disk

#### Scenario: Power Apps plugin preference changes
- **WHEN** a developer changes the valid Code Apps plugin preference in a Power Apps configuration and runs update
- **THEN** update reconciles named generated guidance and records the new preference after a successful apply
- **AND** it does not add backend, cloud, Docker, or infrastructure artifacts

#### Scenario: Power Apps rejects API configuration drift
- **WHEN** a Power Apps configuration adds an API stack, pattern, cloud, region, frontend, or API environment field
- **THEN** update exits 1 before rendering or writing and identifies the inapplicable field

### Requirement: Update refuses unsafe reconciliations
The system SHALL refuse to run when configured workload kind or immutable workload identity differs from the corresponding normalized identity recorded by the manifest, directing the developer to a supported migration or fresh initialization. For API workloads it SHALL continue refusing API-stack or GenAI-pattern changes. For Power Apps it SHALL refuse starter repository, template path, or commit changes outside a Liftoff release-driven template upgrade. The system SHALL also refuse when the manifest's `liftoffVersion` is newer than the running CLI, using semver-aware comparison that orders prerelease versions correctly and directing the developer to upgrade the CLI.

#### Scenario: Workload-kind change is refused
- **WHEN** a developer changes a generated project's configured type among GenAI, standard, and Power Apps and runs `liftoff update`
- **THEN** the command fails with a message that workload changes require migration or fresh initialization

#### Scenario: API-stack change is refused
- **WHEN** a developer changes a standard project's configured API stack and runs `liftoff update`
- **THEN** the command fails with a message that API-stack changes require a migration

#### Scenario: Pattern change is refused
- **WHEN** a developer changes a GenAI project's configured pattern and runs `liftoff update`
- **THEN** the command fails with a message that pattern changes require a migration

#### Scenario: User-supplied starter source change is refused
- **WHEN** a Power Apps configuration or manifest is manually changed to a different repository, path, or commit
- **THEN** update fails before artifact access with guidance to restore the manifest or use a matching Liftoff version

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

### Requirement: Update reconciles packaged Power Apps starter artifacts
The system SHALL re-render Power Apps projects from the immutable starter snapshot packaged with the running Liftoff version and join those files to manifest entries by explicit logical name. Newer Liftoff releases MAY offer an upstream starter refresh as ordinary new, upgrade, moved, conflict, or orphan states, and SHALL apply the existing content-hash, explicit apply, interactive consent, and force rules without fetching upstream source at update time.

#### Scenario: Current starter is clean
- **WHEN** a Power Apps project matches the running Liftoff release's packaged starter and generated guidance
- **THEN** `liftoff update` reports no drift and exits 0

#### Scenario: Untouched starter file has an available upgrade
- **WHEN** the running Liftoff release contains a changed pinned starter file and the project's recorded file remains unmodified
- **THEN** update classifies the named artifact as an upgrade

#### Scenario: Developer-edited starter file conflicts
- **WHEN** both the packaged starter artifact and the developer's recorded file changed
- **THEN** update classifies the artifact as a conflict and leaves it untouched without `--apply --force` or separate interactive conflict-overwrite consent

#### Scenario: Update is offline from upstream
- **WHEN** a developer checks or applies Power Apps updates without access to GitHub
- **THEN** reconciliation uses only the packaged source catalog and completes without contacting the upstream repository

### Requirement: Update normalizes old manifests before writing schema v4
The system SHALL normalize supported v2 and v3 manifests into the internal GenAI or standard workload union before reconciliation. A successful apply SHALL write schema v4 with fresh hashes for written artifacts while preserving skipped-conflict hashes and legacy framework uncertainty.

#### Scenario: Check a v3 project without rewriting
- **WHEN** a developer runs `liftoff update` without `--apply` in a valid v3 project
- **THEN** update performs normalized reconciliation and leaves the v3 manifest byte-for-byte unchanged

#### Scenario: Apply upgrades a v3 project manifest
- **WHEN** a developer runs `liftoff update --apply` in a valid v3 project and apply completes successfully
- **THEN** update writes schema v4 with equivalent normalized workload, framework, and agent identity

#### Scenario: Legacy framework state remains uncertain
- **WHEN** a v2 manifest without official framework metadata is rewritten to v4
- **THEN** the new manifest records legacy framework state without fabricating selected-agent integrations
