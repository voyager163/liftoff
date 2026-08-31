## Purpose

Define the `liftoff update` command that reconciles generated projects against the current CLI templates and configuration: state classification, safe apply semantics, guards, manifest rewrite, and project-root discovery for project-scoped commands.

## Requirements

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
The system SHALL, after a successful default update, rewrite `liftoff.manifest.json` at the latest supported schema with the current CLI version and fresh content hashes for every artifact it wrote, while skipped conflicts retain their previously recorded hash so drift remains visible on subsequent checks.

#### Scenario: Manifest catches up after update
- **WHEN** plain `liftoff update` completes
- **THEN** the manifest records the running CLI's version and hashes matching every file update wrote

#### Scenario: Skipped conflict stays visible
- **WHEN** a conflict was skipped during update and the developer runs `liftoff update --check`
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
The system SHALL re-render Power Apps projects from the immutable starter snapshot packaged with the running Liftoff version and join those files to manifest entries by explicit logical name. A newer Liftoff release MAY transition from a manifest's recorded starter identity to the newer immutable snapshot in its own verified release catalog, and SHALL reconcile the source and generated metadata as ordinary new, upgrade, moved, conflict, or orphan states under the existing content-hash, default safe-apply, explicit check, and force rules. Update SHALL NOT fetch upstream source at runtime or accept an arbitrary user-supplied starter transition.

#### Scenario: Current starter is clean
- **WHEN** a Power Apps project matches the running Liftoff release's packaged starter and generated guidance
- **THEN** `liftoff update` reports no drift and exits 0

#### Scenario: Untouched starter file has an available upgrade
- **WHEN** the running Liftoff release contains a newer cataloged immutable starter and the project's recorded file remains unmodified
- **THEN** update classifies and applies the named artifact as an upgrade
- **AND** the rewritten manifest records the new release-catalog starter identity only after all safe mutations succeed

#### Scenario: Developer-edited starter file conflicts
- **WHEN** both the packaged starter artifact and the developer's recorded file changed
- **THEN** plain update classifies the artifact as a conflict and leaves it untouched unless `--force` is supplied

#### Scenario: Update is offline from upstream
- **WHEN** a developer checks or applies Power Apps updates without access to GitHub
- **THEN** reconciliation uses only the old manifest identity and the running Liftoff release's packaged source catalog
- **AND** it completes without contacting the upstream repository

#### Scenario: User fabricates a starter transition
- **WHEN** configuration or manifest fields name a starter repository, path, or commit not represented by the recorded project or running release catalog
- **THEN** update exits 1 before artifact access and identifies the invalid source identity

### Requirement: Update normalizes old manifests before writing schema v5
The system SHALL normalize supported v2, v3, and v4 manifests into the
internal workload and framework model before reconciliation. `liftoff update
--check` SHALL leave the source manifest byte-for-byte unchanged. A successful
plain update SHALL write schema v5 with fresh hashes for written or
byte-identical adopted artifacts, preserve hashes for previously recorded
skipped conflicts and legacy framework uncertainty, omit unrecorded conflicts
from Liftoff ownership, and record only the selected governance profile's local
handoff state.

#### Scenario: Check a v4 project without rewriting
- **WHEN** a developer runs `liftoff update --check` in a valid v4 project
- **THEN** update performs normalized reconciliation, reports applicable governance adoption as drift, and leaves the v4 manifest byte-for-byte unchanged

#### Scenario: Update upgrades a v4 project manifest
- **WHEN** a developer runs plain `liftoff update` in a valid v4 project and reconciliation completes successfully
- **THEN** update writes schema v5 with equivalent workload, framework, and agent identity plus the normalized governance profile

#### Scenario: Legacy framework state remains uncertain
- **WHEN** a v2 manifest without official framework metadata is rewritten to v5
- **THEN** the new manifest records legacy framework state without fabricating selected-agent integrations
- **AND** may record the local governance handoff without claiming that an agent or GitHub enforcement is active

### Requirement: Existing projects adopt durable governance artifacts automatically
When an existing configuration omits `governanceProfile`, the current CLI SHALL normalize it to `single-maintainer-gitflow` and render the profile's durable policy, context, guide, and selected-agent launchers during normal update reconciliation. The CLI SHALL apply only safe named artifact states and SHALL NOT rewrite the user-owned configuration merely to materialize its default.

#### Scenario: Adopt into an untouched v4 project
- **WHEN** a developer runs plain `liftoff update` in a valid existing project whose configuration has no governance field and whose new paths are absent
- **THEN** update writes the explicitly named governance handoff artifacts and schema-v5 manifest transactionally
- **AND** does not run an agent or contact GitHub

#### Scenario: Preview automatic adoption
- **WHEN** a developer runs `liftoff update --check` before adoption
- **THEN** each applicable governance artifact appears as a new named artifact
- **AND** the command exits 2 without writing any file

#### Scenario: Existing launcher has different bytes
- **WHEN** an unrecorded governance destination already contains different content
- **THEN** update classifies that exact destination as a conflict
- **AND** plain update preserves it while applying other collision-free artifacts
- **AND** the v5 manifest records `handoff-partial` without recording an artifact entry or hash for the preserved destination

#### Scenario: Resolve a partial handoff
- **WHEN** a later update finds that every previously unrecorded governance conflict is absent or byte-identical to the current artifact
- **THEN** it writes or adopts those artifacts through normal safe reconciliation
- **AND** the v5 manifest records `handoff-generated` with every applicable exact handoff artifact

#### Scenario: Existing launcher already matches
- **WHEN** an unrecorded destination contains bytes identical to the current launcher
- **THEN** update adopts it without rewriting the file

### Requirement: Governance opt-out preserves user-owned files
When configuration explicitly selects `none`, update SHALL stop rendering the profile's durable artifacts. Previously recorded governance artifacts SHALL follow the existing orphan contract and SHALL never be deleted automatically; active or archived spec changes and agent-created governance implementation files SHALL remain outside reconciliation.

#### Scenario: Disable the generated profile
- **WHEN** a developer changes `governanceProfile` from `single-maintainer-gitflow` to `none` and runs update
- **THEN** recorded handoff artifacts are reported as orphans and left on disk
- **AND** the v5 manifest records governance as disabled after successful reconciliation

#### Scenario: Archive the agent-created change
- **WHEN** a developer archives or removes the post-Phase-0 governance change
- **THEN** update reports no drift for that change
- **AND** does not recreate it from the durable policy

### Requirement: Update never activates remote governance
Repository-governance reconciliation SHALL be limited to local durable artifacts and manifest state. Update SHALL NOT invoke a selected agent, inspect a remote, write an activation baseline, apply a ruleset, create a branch, or alter any GitHub or deployment setting.

#### Scenario: Update with an authenticated GitHub CLI
- **WHEN** `gh` and a writable remote are available during governance adoption
- **THEN** update performs the same local filesystem operations as it would offline
- **AND** sends no GitHub mutation

### Requirement: Update presents supported baseline adoption as managed drift
The system SHALL reconcile release-driven runtime, dependency, lock, provider, and image changes through explicit durable artifact logical names. `liftoff update --check` SHALL report the resulting upgrades and conflicts without mutation, and plain update SHALL apply only the normal safe states.

#### Scenario: Inspect a breaking baseline refresh
- **WHEN** an existing project uses artifacts from an older supported-stack baseline
- **THEN** `liftoff update --check` lists each changed named artifact and exits 2
- **AND** it does not install dependencies, rewrite locks, or mutate project files

#### Scenario: Apply untouched baseline artifacts
- **WHEN** the developer runs plain update and every changed baseline-owned artifact is still at its recorded hash
- **THEN** update writes the packaged versions and records their new hashes transactionally

#### Scenario: Preserve a locally modified dependency file
- **WHEN** both the current template and a dependency manifest, lock, Dockerfile, or provider lock changed
- **THEN** plain update reports a conflict and preserves the local bytes
