## MODIFIED Requirements

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
- **THEN** the command exits 1 before project mutation and explains that a read-only check cannot authorize core overwrites

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

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Update reconciles packaged Power Apps starter artifacts
**Reason**: Power Apps starter files become production project assets after generation, so ordinary update and force must not retain authority to transition or replace them.

**Migration**: Existing starter identity and per-file generation hashes move to project provenance. Adopting a newer packaged starter requires a separately reviewed project migration.

### Requirement: Update normalizes old manifests before writing schema v5
**Reason**: The latest manifest schema must encode the managed-core and project-provenance split rather than continuing broad v5 durable ownership.

**Migration**: Supported v2 through v5 manifests are normalized and written to the ownership-aware schema without mutating project files.

### Requirement: Update presents supported baseline adoption as managed drift
**Reason**: Dependency manifests, locks, containers, providers, and application compatibility changes are production project files and cannot be safely adopted as ordinary managed drift.

**Migration**: Existing baseline identity remains generation provenance. Release notes and documentation direct developers to a separately reviewed migration for project baseline adoption.
