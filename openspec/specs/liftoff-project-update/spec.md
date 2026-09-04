## Purpose

Define the `liftoff update` command that reconciles Liftoff-managed core files and explicitly authorized component provisioning while keeping production project templates outside update authority.

## Requirements

### Requirement: Update reconciles a generated project against a fresh render
The system SHALL provide a `liftoff update` command that loads `liftoff.config.json` as desired state, renders artifacts with the current CLI templates, selects only explicitly declared managed-core artifacts plus configuration-authorized new component provisioning, and joins managed-core render entries against the manifest on `logicalName`. It SHALL classify each managed-core artifact into exactly one of unchanged, new, missing, upgrade, conflict, moved, or orphan. Existing project-owned artifacts SHALL remain outside classification regardless of their bytes. Plain `liftoff update` SHALL apply safe managed-core changes and authorized provisioning immediately; it SHALL skip managed-core conflicts unless `--force` is supplied and SHALL leave managed-core orphans untouched. `liftoff update --check` SHALL be read-only, SHALL report each actionable managed-core or provisioning entry with a one-line reason, and SHALL exit 0 when no such drift exists and 2 when it exists.

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

### Requirement: Force extends apply only to conflicted managed-core files
The system SHALL accept `--force` directly on plain `liftoff update` and SHALL overwrite only conflicted managed-core files after the existing conflict, path, and transaction guards pass. It SHALL identify exactly which core files can be overwritten, SHALL exclude all project-owned and unknown legacy artifacts from force authority, and SHALL print a commit-first warning when the project is a Git repository with uncommitted changes. The system SHALL reject `--force` together with `--check`.

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

#### Scenario: Force with check is rejected
- **WHEN** a developer runs `liftoff update --check --force`
- **THEN** the command exits 1 before project mutation and explains that a read-only check cannot authorize overwrites

#### Scenario: Removed apply flag is rejected
- **WHEN** a developer runs `liftoff update --apply`
- **THEN** the command exits 1 before project discovery or writes and directs the developer to plain `liftoff update`

#### Scenario: Dirty worktree warning
- **WHEN** a developer runs an update that can write in a Git repository with uncommitted changes
- **THEN** the command prints a hint to commit before applying and proceeds within the managed-core boundary

### Requirement: Configuration edits are a reconciled desired-state axis
The system SHALL treat `liftoff.config.json` as developer-owned desired state that the CLI never rewrites after generation. For API workloads, newly selected environments or a newly enabled frontend MAY authorize create-only provisioning of that component when the recorded project did not previously select it; removed selections SHALL leave their project-owned files untouched. For Power Apps workloads, a changed optional Code Apps plugin preference SHALL update only applicable managed-core guidance and manifest intent. No configuration edit SHALL grant update or force authority over an existing project-owned file.

#### Scenario: API environment added to config
- **WHEN** a developer adds an environment not previously selected by an API workload
- **THEN** update preflights and creates only that environment's absent project artifacts
- **AND** records them as project-owned

#### Scenario: API environment removed from config
- **WHEN** a developer removes an environment from an API workload configuration
- **THEN** its files remain project-owned and untouched
- **AND** they are not reported as managed-core orphans

#### Scenario: Frontend is enabled
- **WHEN** a developer enables a frontend that the recorded workload did not include
- **THEN** update may provision the frontend only when every differing destination is absent
- **AND** all created frontend files become project-owned

#### Scenario: Power Apps plugin preference changes
- **WHEN** a developer changes the valid Code Apps plugin preference in a Power Apps configuration
- **THEN** update reconciles applicable managed-core guidance and records the new preference
- **AND** it does not rewrite project-owned starter guidance or application files

#### Scenario: Power Apps rejects API configuration drift
- **WHEN** a Power Apps configuration adds an API stack, pattern, cloud, region, frontend, or API environment field
- **THEN** update exits 1 before rendering or writing and identifies the inapplicable field

### Requirement: Update refuses unsafe reconciliations
The system SHALL refuse to run when configured workload kind or immutable workload identity differs from the corresponding normalized identity recorded by the manifest, directing the developer to a reviewed migration or fresh initialization. For API workloads it SHALL continue refusing API-stack or GenAI-pattern changes. For Power Apps it SHALL refuse starter repository, template path, or commit changes because starter transitions are project migrations rather than updates. The system SHALL also refuse when the manifest's `liftoffVersion` is newer than the running CLI, using semver-aware comparison that orders prerelease versions correctly and directing the developer to upgrade the CLI.

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

### Requirement: Apply rewrites the manifest as scoped recorded state
The system SHALL, after a successful default update, rewrite `liftoff.manifest.json` at the latest supported schema with the current CLI version, fresh content hashes for managed-core artifacts it wrote or adopted, and immutable generation provenance for project-owned artifacts. Skipped core conflicts SHALL retain their previously recorded core hash. Project-owned disk bytes SHALL never be blessed as current template bytes or converted into update authority.

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
The system SHALL support `--json` on update, emitting schema version 2 with `scope: "managed-core"`, ownership-migration state, managed-core entries and summary counts, and separate component-provisioning results. Plain `liftoff update --json` SHALL apply safe core changes and emit apply results; `liftoff update --check --json` SHALL emit scoped drift without mutation.

#### Scenario: JSON apply result
- **WHEN** a developer runs `liftoff update --json` in a drifted project
- **THEN** safe core changes are applied and stdout contains a byte-pure JSON object with `schemaVersion`, `mode: "apply"`, managed-core scope, written entries, skipped core conflicts, provisioning results, and summary counts

#### Scenario: JSON drift report
- **WHEN** a developer runs `liftoff update --check --json` in a drifted project
- **THEN** stdout contains a byte-pure JSON object with `schemaVersion`, `mode: "check"`, managed-core states, provisioning results, and summary counts
- **AND** no project file changes and the command exits 2

### Requirement: Update migrates supported manifests without production mutation
The system SHALL normalize supported legacy manifests into the latest ownership-aware schema before reconciliation. Check mode SHALL leave the source manifest byte-for-byte unchanged. A successful plain update SHALL retain managed-core hashes, convert non-core durable entries into project provenance, preserve legacy framework uncertainty, and omit no project provenance merely because the corresponding file is modified or absent. Manifest migration MUST NOT write, restore, move, or delete project-owned files.

#### Scenario: Check a legacy project
- **WHEN** a developer runs `liftoff update --check` against a supported legacy manifest
- **THEN** update reports the pending ownership migration and applicable managed-core drift
- **AND** leaves the manifest and every project file byte-for-byte unchanged

#### Scenario: Migrate intentionally deleted infrastructure
- **WHEN** a legacy manifest records a generated infrastructure file that is now absent
- **THEN** plain update records released project provenance without recreating the path

#### Scenario: Migrate production source
- **WHEN** a legacy manifest records application source that now contains production behavior
- **THEN** plain update converts the entry to project provenance without changing the file

#### Scenario: Preserve legacy framework uncertainty
- **WHEN** a legacy manifest lacks official framework metadata
- **THEN** the latest manifest preserves legacy framework state without fabricating selected-agent integrations

### Requirement: Existing projects adopt managed-core governance artifacts automatically
When an existing configuration omits `governanceProfile`, the current CLI SHALL normalize it to `single-maintainer-gitflow` and render the profile's managed-core policy, context, guide, and selected-agent launchers during normal update reconciliation. The CLI SHALL apply only safe named artifact states and SHALL NOT rewrite the user-owned configuration merely to materialize its default.

#### Scenario: Adopt into an untouched v4 project
- **WHEN** a developer runs plain `liftoff update` in a valid existing project whose configuration has no governance field and whose new paths are absent
- **THEN** update writes the explicitly named governance handoff artifacts and schema-v6 manifest transactionally
- **AND** does not run an agent or contact GitHub

#### Scenario: Preview automatic adoption
- **WHEN** a developer runs `liftoff update --check` before adoption
- **THEN** each applicable governance artifact appears as a new named artifact
- **AND** the command exits 2 without writing any file

#### Scenario: Existing launcher has different bytes
- **WHEN** an unrecorded governance destination already contains different content
- **THEN** update classifies that exact destination as a conflict
- **AND** plain update preserves it while applying other collision-free artifacts
- **AND** the v6 manifest records `handoff-partial` without recording a managed artifact entry or hash for the preserved destination

#### Scenario: Resolve a partial handoff
- **WHEN** a later update finds that every previously unrecorded governance conflict is absent or byte-identical to the current artifact
- **THEN** it writes or adopts those artifacts through normal safe reconciliation
- **AND** the v6 manifest records `handoff-generated` with every applicable exact handoff artifact

#### Scenario: Existing launcher already matches
- **WHEN** an unrecorded destination contains bytes identical to the current launcher
- **THEN** update adopts it without rewriting the file

### Requirement: Governance opt-out preserves user-owned files
When configuration explicitly selects `none`, update SHALL stop rendering the profile's managed-core artifacts. Previously recorded governance artifacts SHALL follow the existing orphan contract and SHALL never be deleted automatically; active or archived spec changes and agent-created governance implementation files SHALL remain outside reconciliation.

#### Scenario: Disable the generated profile
- **WHEN** a developer changes `governanceProfile` from `single-maintainer-gitflow` to `none` and runs update
- **THEN** recorded handoff artifacts are reported as orphans and left on disk
- **AND** the v6 manifest records governance as disabled after successful reconciliation

#### Scenario: Archive the agent-created change
- **WHEN** a developer archives or removes the post-Phase-0 governance change
- **THEN** update reports no drift for that change
- **AND** does not recreate it from the managed-core policy

### Requirement: Update never activates remote governance
Repository-governance reconciliation SHALL be limited to local managed-core artifacts and manifest state. Update SHALL NOT invoke a selected agent, inspect a remote, write an activation baseline, apply a ruleset, create a branch, or alter any GitHub or deployment setting.

#### Scenario: Update with an authenticated GitHub CLI
- **WHEN** `gh` and a writable remote are available during governance adoption
- **THEN** update performs the same local filesystem operations as it would offline
- **AND** sends no GitHub mutation

### Requirement: Update output identifies its authority boundary
Human and JSON update output SHALL distinguish managed-core reconciliation, configuration-authorized component provisioning, skipped core conflicts, and manifest-only ownership migration. It SHALL NOT list project template differences as forceable conflicts or imply that production files match the running CLI templates.

#### Scenario: JSON check contains core drift
- **WHEN** `liftoff update --check --json` finds a core conflict
- **THEN** the versioned entry identifies the managed-core scope and exact portable project path

#### Scenario: Ownership-only migration
- **WHEN** a legacy project requires only manifest ownership migration
- **THEN** check and apply output identify that no production file will be written

#### Scenario: Project template changed
- **WHEN** only project-owned template bytes changed between Liftoff releases
- **THEN** update reports no actionable update drift
- **AND** does not recommend `--force`

### Requirement: Update reconciles managed phase definitions without owning execution state
Normal managed-core update SHALL reconcile the canonical phase graph and setup
integrations. It SHALL preserve user-owned activation state and evidence, mark
policy-incompatible active work as reconciliation-required, and never silently
advance, reset, or delete a phase.

#### Scenario: Phase graph has managed drift
- **WHEN** `liftoff update --check` detects a newer managed graph
- **THEN** it reports the graph and setup integration changes without modifying user-owned state

#### Scenario: Updated graph affects active work
- **WHEN** plain update installs the reviewed graph
- **THEN** the next governance status reports the affected phases and required reconciliation
- **AND** performs no remote mutation

#### Scenario: Historical phase state remains compatible
- **WHEN** existing evidence satisfies the new graph
- **THEN** update preserves it and governance verification records compatibility

### Requirement: Update applies the activation compatibility matrix
The system SHALL maintain an explicit compatibility matrix among supported
manifest, policy, activation-contract, phase-graph, activation-state, evidence,
approval-envelope, and credential-policy versions. It SHALL migrate supported
historical representations transactionally and SHALL leave future or
incompatible identities untouched and blocked.

#### Scenario: Historical activation state is supported
- **WHEN** update reads a supported older manifest, contract, or schema
- **THEN** check mode reports the complete migration without writing
- **AND** apply writes the new representation only after every managed-artifact and user-state migration preflight succeeds

#### Scenario: Activation identity is from the future
- **WHEN** a project records a newer unsupported contract or schema version
- **THEN** update and setup block without downgrading or rewriting it
- **AND** report the exact unsupported field and required Liftoff upgrade

#### Scenario: Policy and activation contract are incompatible
- **WHEN** their versions are individually known but their combination is absent from the compatibility matrix
- **THEN** verification reports the incompatible pair
- **AND** no phase advances
