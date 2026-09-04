## MODIFIED Requirements

### Requirement: Update reconciles a generated project against a fresh render
The system SHALL provide a `liftoff update` command that loads `liftoff.config.json` as desired state, renders artifacts with the current CLI templates, selects only explicitly declared managed-core artifacts plus configuration-authorized new component provisioning, and joins managed-core render entries against the manifest on `logicalName`. It SHALL classify each managed-core artifact into exactly one of unchanged, new, missing, upgrade, conflict, moved, orphan, retired, or retired-conflict. Existing project-owned artifacts SHALL remain outside classification regardless of their bytes. Plain `liftoff update` SHALL apply safe managed-core changes, authorized provisioning, and clean retired-alias ownership removal immediately; it SHALL skip managed-core conflicts unless `--force` is supplied, protect modified exact retired aliases unless `--force` is supplied, and SHALL leave other managed-core orphans untouched. `liftoff update --check` SHALL be read-only, SHALL report each actionable managed-core, retired-alias, or provisioning entry with a one-line reason, and SHALL exit 0 when no such drift exists and 2 when it exists.

#### Scenario: Clean project reports no drift
- **WHEN** project-owned files differ from current templates but managed-core files match
- **THEN** update reports no drift, exits 0, and performs no unnecessary write

#### Scenario: Check classifies drift without applying
- **WHEN** a managed-core template evolved and one managed-core file was edited
- **THEN** the report lists untouched core changes as upgrades and the edited core file as a conflict
- **AND** it exits 2 without writing any file

#### Scenario: User modification is detected by hash
- **WHEN** a managed-core file's content hash differs from the `contentHash` recorded in the manifest
- **THEN** update treats the core file as locally modified and never classifies it as a safe upgrade

#### Scenario: Project modification is outside update
- **WHEN** application source, dependencies, schema, container, environment, documentation, or infrastructure bytes differ from the current render
- **THEN** update neither classifies nor reports those differences

#### Scenario: Moved artifact is detected by logical name
- **WHEN** the current templates emit a managed-core artifact whose `logicalName` exists in the manifest under different path parts
- **THEN** update classifies it as moved and reports the old and new locations

#### Scenario: Redirected update applies safe changes
- **WHEN** plain `liftoff update` runs with redirected input or output and actionable managed-core drift exists
- **THEN** it requests no input and applies the safe core changes through the normal transaction

#### Scenario: Redirected check stays read-only
- **WHEN** `liftoff update --check` runs with redirected input or output
- **THEN** it requests no input, writes nothing, and exits 2 only when managed-core or authorized-provisioning drift exists

#### Scenario: Check reports retired alias cleanup without mutation
- **WHEN** an older manifest records an exact retired generated setup alias
- **THEN** `liftoff update --check --json` reports the alias as retired or retired-conflict with its exact path and removal/protection reason
- **AND** the manifest and alias file bytes remain unchanged

### Requirement: Apply writes only safe managed-core states by default
The system SHALL, when plain `liftoff update` runs, write managed-core artifacts classified as new, missing, or upgrade only after verifying that the destination is absent or belongs to the same recorded managed-core artifact. It SHALL relocate a clean managed-core artifact only when the destination is absent or already matches the current render, SHALL classify any different pre-existing destination as a core conflict, SHALL skip core conflicts unless `--force` is supplied, and SHALL report core orphans without deleting them. Configuration-authorized component provisioning SHALL use a separate create-only lane that cannot replace existing bytes. The system SHALL never restore, upgrade, move, overwrite, or orphan-report an existing project-owned artifact.

#### Scenario: Update applies safe core changes
- **WHEN** a project has collision-free new and upgrade core artifacts plus a core conflict
- **THEN** the new and upgrade core artifacts are written, the conflict is left untouched and listed as skipped, and the command exits 0

#### Scenario: Restore a deleted managed-core file
- **WHEN** a developer deletes a recorded managed-core file and runs update
- **THEN** the file is restored at the current core template version

#### Scenario: Preserve a deleted project file
- **WHEN** a developer deletes or relocates a recorded project-owned file and runs update
- **THEN** update leaves the original path absent and performs no mutation for that artifact

#### Scenario: Existing file blocks a new core artifact
- **WHEN** a current managed-core render adds a logical artifact whose destination contains different bytes not owned by that artifact
- **THEN** update classifies the destination as a core conflict and plain update leaves it unchanged

#### Scenario: Existing file blocks a moved core artifact
- **WHEN** a clean recorded managed-core artifact moved but its new destination already contains different project-owned bytes
- **THEN** update classifies the move as a core conflict and leaves both old and new files unchanged without `--force`

#### Scenario: Existing file blocks component provisioning
- **WHEN** a newly configured component would create a project file at a destination containing different bytes
- **THEN** update blocks the complete component provisioning before any component write
- **AND** does not offer force as a remedy

#### Scenario: Existing matching core destination is adopted
- **WHEN** a new or moved managed-core artifact destination already contains bytes identical to the current render
- **THEN** update records the current destination without unnecessarily rewriting those bytes

#### Scenario: Clean core relocation removes only its managed old path
- **WHEN** a clean managed-core artifact has an unoccupied destination and the destination write succeeds
- **THEN** update writes the new path, removes only the recorded managed-core old path, and records the new path

#### Scenario: Managed-core orphans are never auto-deleted
- **WHEN** a managed-core artifact exists in the manifest but is no longer produced by the core render
- **THEN** update leaves the file on disk and reports it as orphaned with guidance to delete manually if unwanted

#### Scenario: Clean retired setup alias is removed
- **WHEN** an older manifest records an exact retired generated setup alias whose file is absent or still matches its recorded hash
- **THEN** plain update removes that manifest ownership entry
- **AND** deletes the alias file only when it is still present
- **AND** records current governance as `handoff-generated` when no protected conflicts remain

#### Scenario: Modified retired setup alias is protected
- **WHEN** an older manifest records an exact retired generated setup alias whose file no longer matches its recorded hash
- **THEN** plain update leaves the file and manifest entry in place
- **AND** records governance as `handoff-partial`
- **AND** reports a protected retired conflict rather than an ordinary orphan

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

#### Scenario: Retired alias transaction rolls back
- **WHEN** update deletes a retired alias file but fails before the manifest rewrite is committed
- **THEN** the alias file and manifest are restored to their pre-update bytes
- **AND** the command reports rollback rather than claiming alias removal

### Requirement: Force extends apply only to conflicted managed-core files and exact retired aliases
The system SHALL accept `--force` directly on plain `liftoff update` and SHALL overwrite only conflicted managed-core files or delete exact retired generated setup aliases after the existing conflict, path, and transaction guards pass. It SHALL identify exactly which core files can be overwritten or retired aliases can be removed, SHALL exclude all project-owned and unknown legacy artifacts from force authority, and SHALL print a commit-first warning when the project is a Git repository with uncommitted changes. The system SHALL reject `--force` together with `--check`.

#### Scenario: Force overwrites a managed-core conflict
- **WHEN** a developer runs `liftoff update --force` with a conflicted managed-core file
- **THEN** that core file is overwritten with the current rendering without an interactive prompt

#### Scenario: Force cannot overwrite production source
- **WHEN** application source differs from the current starter and the developer runs `liftoff update --force`
- **THEN** the source file is not part of the force mutation set
- **AND** its bytes remain unchanged

#### Scenario: Force cannot overwrite a provisioning collision
- **WHEN** a newly selected component has a destination collision and the developer runs `liftoff update --force`
- **THEN** provisioning remains blocked and the existing destination is preserved

#### Scenario: Force deletes a modified retired setup alias
- **WHEN** an exact retired generated setup alias was modified after generation
- **THEN** `liftoff update --force` deletes that exact alias file and removes its manifest entry
- **AND** unrelated or unknown orphan files remain untouched

#### Scenario: Force with check is rejected
- **WHEN** a developer runs `liftoff update --check --force`
- **THEN** the command exits 1 before project mutation and explains that a read-only check cannot authorize overwrites

#### Scenario: Removed apply flag is rejected
- **WHEN** a developer runs `liftoff update --apply`
- **THEN** the command exits 1 before project discovery or writes and directs the developer to plain `liftoff update`

#### Scenario: Dirty worktree warning
- **WHEN** a developer runs an update that can write in a Git repository with uncommitted changes
- **THEN** the command prints a hint to commit before applying and proceeds within the managed-core boundary

### Requirement: Apply rewrites the manifest as scoped recorded state
The system SHALL, after a successful default update, rewrite `liftoff.manifest.json` at the latest supported schema with the current CLI version, fresh content hashes for managed-core artifacts it wrote or adopted, removed exact retired alias entries that were safely retired, and immutable generation provenance for project-owned artifacts. Skipped core conflicts and protected retired conflicts SHALL retain their previously recorded core hash. Project-owned disk bytes SHALL never be blessed as current template bytes or converted into update authority.

#### Scenario: Manifest catches up after core update
- **WHEN** plain `liftoff update` completes
- **THEN** the manifest records the running CLI version and hashes matching every managed-core file update wrote
- **AND** preserves project artifact provenance without hashing current production bytes as managed state

#### Scenario: Skipped core conflict stays visible
- **WHEN** a managed-core conflict was skipped and the developer runs `liftoff update --check`
- **THEN** the core file is still reported as a conflict

#### Scenario: Project file changed after generation
- **WHEN** a project-owned file differs from its recorded generation hash
- **THEN** a manifest rewrite preserves its original provenance
- **AND** does not record the production bytes as a future overwrite baseline

#### Scenario: Retired alias is not preserved in the next manifest
- **WHEN** update successfully retires an exact generated setup alias
- **THEN** the rewritten manifest contains only current managed-core setup logical names and paths
- **AND** validation reports no drift for a clean migrated project

### Requirement: Update offers versioned machine-readable output
The system SHALL support `--json` on update, emitting schema version 2 with `scope: "managed-core"`, ownership-migration state, managed-core entries and summary counts, retired-alias removal/protection details, and separate component-provisioning results. Plain `liftoff update --json` SHALL apply safe core changes and emit apply results; `liftoff update --check --json` SHALL emit scoped drift without mutation.

#### Scenario: JSON apply result
- **WHEN** a developer runs `liftoff update --json` in a drifted project
- **THEN** safe core changes are applied and stdout contains a byte-pure JSON object with `schemaVersion`, `mode: "apply"`, managed-core scope, written entries, removed retired aliases, skipped core or protected retired conflicts, provisioning results, and summary counts

#### Scenario: JSON drift report
- **WHEN** a developer runs `liftoff update --check --json` in a drifted project
- **THEN** stdout contains a byte-pure JSON object with `schemaVersion`, `mode: "check"`, managed-core and retired-alias states, provisioning results, and summary counts
- **AND** no project file changes and the command exits 2

### Requirement: Existing projects adopt managed-core governance artifacts automatically
When an existing configuration omits `governanceProfile`, the current CLI SHALL normalize it to `single-maintainer-gitflow` and render the profile's managed-core policy, context, guide, phase graph, compatibility metadata, credential-policy schema, and selected-agent `/liftoff-setup` integrations during normal update reconciliation. The CLI SHALL apply only safe named artifact states and SHALL NOT rewrite the user-owned configuration merely to materialize its default.

#### Scenario: Adopt into an untouched v4 project
- **WHEN** a developer runs plain `liftoff update` in a valid existing project whose configuration has no governance field and whose new paths are absent
- **THEN** update writes the explicitly named governance handoff artifacts and schema-v7 manifest transactionally
- **AND** does not run an agent or contact GitHub

#### Scenario: Preview automatic adoption
- **WHEN** a developer runs `liftoff update --check` before adoption
- **THEN** each applicable governance artifact appears as a new named artifact
- **AND** the command exits 2 without writing any file

#### Scenario: Existing setup destination has different bytes
- **WHEN** an unrecorded governance destination already contains different content
- **THEN** update classifies that exact destination as a conflict
- **AND** plain update preserves it while applying other collision-free artifacts
- **AND** the v7 manifest records `handoff-partial` without recording a managed artifact entry or hash for the preserved destination

#### Scenario: Resolve a partial handoff
- **WHEN** a later update finds that every previously unrecorded governance conflict is absent or byte-identical to the current artifact
- **THEN** it writes or adopts those artifacts through normal safe reconciliation
- **AND** the v7 manifest records `handoff-generated` with every applicable exact handoff artifact

#### Scenario: Existing setup destination already matches
- **WHEN** an unrecorded destination contains bytes identical to the current setup integration
- **THEN** update adopts it without rewriting the file

### Requirement: Governance opt-out preserves user-owned files
When configuration explicitly selects `none`, update SHALL stop rendering the profile's managed-core artifacts. Previously recorded governance artifacts SHALL follow the existing orphan contract and SHALL never be deleted automatically; active or archived spec changes and agent-created governance implementation files SHALL remain outside reconciliation.

#### Scenario: Disable the generated profile
- **WHEN** a developer changes `governanceProfile` from `single-maintainer-gitflow` to `none` and runs update
- **THEN** recorded handoff artifacts are reported as orphans and left on disk
- **AND** the v7 manifest records governance as disabled after successful reconciliation

#### Scenario: Archive the agent-created change
- **WHEN** a developer archives or removes the post-Phase-0 governance change
- **THEN** update reports no drift for that change
- **AND** does not recreate it from the managed-core policy
