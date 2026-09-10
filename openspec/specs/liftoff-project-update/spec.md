## Purpose

Define the `liftoff update` command that reconciles Liftoff-managed core files and explicitly authorized component provisioning while keeping production project templates outside update authority.

## Requirements

### Requirement: Update reconciles a generated project against a fresh render
The system SHALL provide `liftoff update` with a compatibility-first, preview-gated workflow. It SHALL load `liftoff.config.json` as desired state, reconcile explicitly declared managed-core artifacts by `logicalName`, and separately identify configuration-authorized create-only provisioning and supported activation migration/revalidation. Core classifications SHALL remain unchanged, new, missing, upgrade, conflict, moved, orphan, retired, or retired-conflict. Existing production project artifacts SHALL remain outside template comparison. All write-capable plans SHALL require a matching prior check and explicit exact-plan approval. `liftoff update --check` SHALL present a human-readable preview without changing project bytes, disclose its external preview receipt, and exit 0 for no actionable work or 2 for actionable drift, migration, or revalidation.

#### Scenario: Clean project reports no drift
- **WHEN** project-owned files differ from current templates but managed core and activation migration/revalidation require no work
- **THEN** update exits 0 without approval or unnecessary project writes

#### Scenario: Check classifies drift without applying
- **WHEN** a managed-core template evolved and one managed-core file was edited
- **THEN** check lists untouched core changes as upgrades and the edited file as a conflict
- **AND** it exits 2 without changing project files while separately disclosing any external receipt

#### Scenario: User modification is detected by hash
- **WHEN** a core file differs from its recorded content hash
- **THEN** update treats it as locally modified rather than a safe upgrade

#### Scenario: Project modification is outside update
- **WHEN** source, dependency, schema, container, environment, documentation, or infrastructure bytes differ from the current render
- **THEN** update does not classify or report those differences as template updates
- **AND** reading a file as a migration-validation input does not grant replacement authority

#### Scenario: Moved artifact is detected by logical name
- **WHEN** a current core artifact has the same logical name and a different recorded location
- **THEN** preview identifies the move and both portable paths

#### Scenario: Redirected update applies safe changes
- **WHEN** redirected update has actionable work, a matching preview receipt, and `--approve-plan` containing the exact effective fingerprint
- **THEN** it applies the approved safe scope without prompting
- **AND** redirected apply without either prerequisite performs no new project write

#### Scenario: Redirected check stays read-only
- **WHEN** check runs with redirected input or output
- **THEN** it requests no input, leaves project bytes unchanged, and uses the same compatibility and exit rules
- **AND** it discloses external receipt persistence in the selected output format

#### Scenario: Check reports retired alias cleanup without mutation
- **WHEN** an older manifest records an exact retired setup alias
- **THEN** human and JSON previews identify its retired or protected retired-conflict state and exact path
- **AND** manifest and alias bytes remain unchanged

### Requirement: Apply writes only safe managed-core states by default
After matching preview validation and exact-plan approval, default update SHALL write only safe named core states whose destinations are absent, already identical, or owned by that same recorded core artifact. A clean move SHALL require an absent or matching destination. Core conflicts SHALL be skipped without an independently approved force variant; orphans SHALL not be deleted. Provisioning SHALL remain create-only, and supported activation migration SHALL have its own exact approved write set. Neither lane SHALL authorize production template replacement.

#### Scenario: Update applies safe core changes
- **WHEN** an approved normal plan has collision-free new/upgraded core artifacts and a skipped conflict
- **THEN** apply writes the safe core entries, lists the untouched conflict, and reports completion of that scope

#### Scenario: Restore a deleted managed-core file
- **WHEN** a recorded core file is absent and its restoration appears in the approved plan
- **THEN** update restores it at the current core version

#### Scenario: Preserve a deleted project file
- **WHEN** a project-owned file was deleted or relocated
- **THEN** update leaves the old path absent

#### Scenario: Existing file blocks a new core artifact
- **WHEN** a new core destination contains different bytes not owned by that artifact
- **THEN** it is an unowned conflict and remains unchanged

#### Scenario: Existing file blocks a moved core artifact
- **WHEN** a move destination contains different project-owned bytes
- **THEN** both paths remain unchanged and force does not acquire destination ownership

#### Scenario: Existing file blocks component provisioning
- **WHEN** a new component has a differing occupied destination
- **THEN** the entire component is blocked before its first write without a force remedy

#### Scenario: Existing matching core destination is adopted
- **WHEN** a reviewed new or moved core destination already matches the render
- **THEN** update records it without an unnecessary rewrite

#### Scenario: Clean core relocation removes only its managed old path
- **WHEN** an approved clean move completes its destination write
- **THEN** update removes only the exact recorded old core path and records the new path

#### Scenario: Managed-core orphans are never auto-deleted
- **WHEN** a previously managed artifact no longer renders and is not an exact declared retirement
- **THEN** update leaves it on disk and reports manual-review guidance

#### Scenario: Clean retired setup alias is removed
- **WHEN** an approved plan retires an exact alias whose file is absent or matches its recorded hash
- **THEN** update removes its ownership entry and deletes only the exact present clean file
- **AND** it records complete handoff only when no protected conflicts remain

#### Scenario: Modified retired setup alias is protected
- **WHEN** the normal plan encounters a modified exact retired alias
- **THEN** its file and recorded hash remain protected and the handoff remains partial

### Requirement: Apply failures are observable and recoverable
The system SHALL preflight the entire approved write set, treat only confirmed missing paths as absent, acquire the cooperating project lock, and verify current preconditions before mutation. Storage, replacement, cleanup, manifest, lock, and recovery failures SHALL exit 1 and name the failed operation without claiming success. Recovery SHALL preserve supported modes, clean only exact temporary paths, and restore only attributable unchanged transaction writes. Durable activation-migration recovery SHALL remain distinct from post-commit revalidation, which retains blocked/resumable v2.

#### Scenario: Destination write fails
- **WHEN** a filesystem operation cannot write a planned artifact
- **THEN** output names its path and operation and the manifest does not claim success

#### Scenario: Move cleanup fails
- **WHEN** removal of a verified managed old path fails after destination creation
- **THEN** update reports failure and recovery rather than a completed move

#### Scenario: Preflight rejects every unsafe mutation before writes
- **WHEN** any destination fails boundary, collision, ownership, or effective-plan validation
- **THEN** no new update mutation starts

#### Scenario: Retry after a partial filesystem failure
- **WHEN** the filesystem issue is repaired
- **THEN** bounded recovery uses actual bytes and the approved transaction record
- **AND** new work requires a matching current preview rather than manual manifest editing

#### Scenario: Retired alias transaction rolls back
- **WHEN** alias deletion succeeds but the local transaction cannot commit its manifest
- **THEN** recovery restores attributable unchanged alias and manifest bytes and reports the outcome

#### Scenario: Cooperating writer lock blocks concurrent mutation
- **WHEN** another cooperating writer holds the project lock
- **THEN** update exits 1 before writing and identifies the concurrent operation

#### Scenario: Rollback preserves a concurrently changed destination
- **WHEN** a destination changes again before recovery can restore it
- **THEN** the newer bytes are preserved and the exact path is reported for review

#### Scenario: Partial temporary files are cleaned up
- **WHEN** temporary replacement files remain after failure
- **THEN** recovery removes only safely identified transaction temporaries and never records them as managed artifacts

### Requirement: Force extends apply only to conflicted managed-core files and exact retired aliases
The system SHALL accept `--force` only for a separately previewed and approved effective plan. Its extra authority SHALL remain limited to exact already-owned core conflicts and exact retired aliases, subject to all ownership, path, compatibility, transaction, and receipt guards. Check SHALL display any available force variant and its different fingerprint without authorizing writes. `--check --force` SHALL remain invalid. Dirty-worktree guidance SHALL precede approval, not substitute for it.

#### Scenario: Force overwrites a managed-core conflict
- **WHEN** a matching forced-plan receipt and explicit approval authorize an exact owned conflict
- **THEN** update may replace that file after all preconditions pass

#### Scenario: Force cannot overwrite production source
- **WHEN** production source differs from the current starter
- **THEN** it remains outside the forced mutation set

#### Scenario: Force cannot overwrite a provisioning collision
- **WHEN** a requested component destination contains different existing bytes
- **THEN** it remains blocked under force

#### Scenario: Force deletes a modified retired setup alias
- **WHEN** the approved forced variant lists an exact modified retired alias
- **THEN** apply removes only that file and ownership entry, not unrelated orphans

#### Scenario: Force cannot bypass retired workload rejection
- **WHEN** the manifest or configuration identifies the retired Power Apps workload
- **THEN** force fails before reconciliation or deletion and preserves all historical state

#### Scenario: Force with check is rejected
- **WHEN** `liftoff update --check --force` is supplied
- **THEN** usage fails with separate preview/apply guidance before receipt or project writes

#### Scenario: Removed apply flag is rejected
- **WHEN** `liftoff update --apply` is supplied
- **THEN** it fails before project discovery and explains the current check-then-update flow

#### Scenario: Dirty worktree warning
- **WHEN** an approved update could write into a Git worktree with uncommitted changes
- **THEN** a commit-first warning is shown without committing automatically or relaxing any guard

#### Scenario: Normal approval is not forced approval
- **WHEN** `--force` is supplied with the normal plan's fingerprint
- **THEN** apply refuses the mismatched approval without writing

### Requirement: Configuration edits are a reconciled desired-state axis
The system SHALL treat `liftoff.config.json` as developer-owned desired state that the CLI never rewrites after generation. For supported workloads with a compatible recorded generation/layout contract, newly selected environments or a newly enabled frontend MAY authorize create-only provisioning of that component when the recorded project did not previously select it; removed selections SHALL leave their project-owned files untouched. Legacy shared-state or unknown infrastructure layouts SHALL block new-environment provisioning as migration-required rather than force a shared-module rewrite or create dangling roots. No configuration edit SHALL grant update or force authority over an existing project-owned file, and a retired workload discriminator SHALL be rejected rather than reconciled.

#### Scenario: API environment added to config
- **WHEN** a developer adds an environment not previously selected by a supported workload with a compatible independent-environment layout
- **THEN** update preflights and creates only that environment's absent project artifacts
- **AND** records them as project-owned

#### Scenario: API environment removed from config
- **WHEN** a developer removes an environment from a supported workload configuration
- **THEN** its files remain project-owned and untouched
- **AND** they are not reported as managed-core orphans

#### Scenario: Frontend is enabled
- **WHEN** a developer enables a frontend that the recorded workload did not include
- **THEN** update may provision the frontend only when every differing destination is absent
- **AND** all created frontend files become project-owned

#### Scenario: Power Apps plugin preference changes
- **WHEN** update encounters a former Power Apps plugin-preference change
- **THEN** it reports the retired workload or option instead of reconciling the preference
- **AND** it does not rewrite the manifest or application files

#### Scenario: Power Apps rejects API configuration drift
- **WHEN** a retired Power Apps project contains added API configuration
- **THEN** update rejects the retired boundary before attempting workload-specific reconciliation

#### Scenario: Retired workload configuration is rejected
- **WHEN** a desired-state configuration is edited to use workload kind `power-apps-code-app`
- **THEN** update exits 1 before rendering or writing
- **AND** it does not reinterpret the configuration as a supported API or GenAI workload

### Requirement: Update refuses unsafe reconciliations
The system SHALL refuse to run when configured workload kind or immutable workload identity differs from the corresponding normalized identity recorded by the manifest, directing the developer to a reviewed migration or fresh initialization. It SHALL continue refusing API-stack or GenAI-pattern changes, SHALL reject the retired `power-apps-code-app` discriminator before deeper artifact or activation access even when governance is disabled, and SHALL refuse when the manifest's `liftoffVersion` is newer than the running CLI, using semver-aware comparison that orders prerelease versions correctly and directing the developer to upgrade the CLI.

#### Scenario: Workload-kind change is refused
- **WHEN** a developer changes a generated project's configured type between GenAI and standard and runs `liftoff update`
- **THEN** the command fails with a message that workload changes require migration or fresh initialization

#### Scenario: API-stack change is refused
- **WHEN** a developer changes a standard project's configured API stack and runs `liftoff update`
- **THEN** the command fails with a message that API-stack changes require a migration

#### Scenario: Pattern change is refused
- **WHEN** a developer changes a GenAI project's configured pattern and runs `liftoff update`
- **THEN** the command fails with a message that pattern changes require a migration

#### Scenario: User-supplied starter source change is refused
- **WHEN** an existing Power Apps project's starter source is changed
- **THEN** the new CLI rejects the retired workload before source-identity interpretation or reconciliation

#### Scenario: Retired workload is refused before deeper access
- **WHEN** a manifest or desired-state configuration names workload kind `power-apps-code-app`
- **THEN** update fails before artifact ownership, activation-state, or managed-path interpretation
- **AND** governance disablement does not convert the project into an updateable supported workload

#### Scenario: Legacy identity is compared after normalization
- **WHEN** a legacy manifest omits project type and API stack but records a GenAI pattern matching the configuration
- **THEN** update treats the identity as GenAI with Python/FastAPI and continues normal reconciliation

#### Scenario: Newer-generated project is refused
- **WHEN** the manifest records a `liftoffVersion` greater than the running CLI version
- **THEN** the command fails with a message to upgrade the CLI first

### Requirement: Apply rewrites the manifest as scoped recorded state
After a successful approved local transaction, update SHALL write the supported manifest schema with the current CLI version, hashes only for written/adopted core artifacts, safely retired alias entries removed, and original generation provenance for project artifacts. Skipped conflicts SHALL retain their old hashes. An approved activation migration SHALL change the active identity only with its linked committed successor and preserved source metadata; post-commit revalidation failure SHALL not roll that manifest back or bless production bytes as template state.

#### Scenario: Manifest catches up after core update
- **WHEN** an approved core transaction commits
- **THEN** manifest hashes match its actual written/adopted files and project provenance is preserved

#### Scenario: Skipped core conflict stays visible
- **WHEN** a later check inspects a skipped core conflict
- **THEN** the old recorded hash still exposes that conflict

#### Scenario: Project file changed after generation
- **WHEN** a project-owned file has changed or disappeared
- **THEN** its generation provenance remains unchanged and confers no replacement authority

#### Scenario: Retired alias is not preserved in the next manifest
- **WHEN** an exact alias is successfully retired
- **THEN** its entry is removed and a clean migrated managed inventory has no alias drift

### Requirement: Project-scoped commands resolve the project root by walking up
The system SHALL resolve the project root for project-scoped commands (`update`, `validate`, `doctor`) by using a supported explicit path argument when given, and otherwise walking parent directories from the current directory to the nearest `liftoff.manifest.json`, without assuming the project root equals the repository root. Resolution SHALL preserve the same boundary semantics with native paths on Windows, macOS, and Linux. A discovered manifest that is malformed, unreadable, dangling, a symlink or junction, or names a retired workload SHALL be treated as an error boundary rather than skipped in favor of an outer project or ordinary Git fallback.

#### Scenario: Update from a subdirectory
- **WHEN** a developer runs `liftoff update` from a subdirectory of a generated project
- **THEN** the command locates the project root by finding the nearest ancestor containing `liftoff.manifest.json`

#### Scenario: Explicit path wins
- **WHEN** a developer runs `liftoff validate ./some-project`
- **THEN** the command operates on the given path without walking up from the current directory

#### Scenario: Doctor discovers project context
- **WHEN** a developer runs `liftoff doctor` from a subdirectory of a generated project
- **THEN** doctor locates the project root and runs its project-aware layers against it

#### Scenario: Broken inner manifest blocks outer-project fallback
- **WHEN** a nested directory contains a malformed, unreadable, dangling, or retired `liftoff.manifest.json` and an ancestor directory contains a different valid project
- **THEN** project-scoped commands stop at the nested manifest boundary with an error
- **AND** they do not walk outward to select the ancestor project

#### Scenario: Nested project path contains spaces on Windows
- **WHEN** a supported explicit target or nested working directory contains spaces on Windows, macOS, or Linux
- **THEN** the same nearest-boundary and invalid-manifest rules apply with platform-native path handling

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
The system SHALL emit schema-3 update JSON with `scope: "project-update"`, mode, stable status/reason codes, plan fingerprints, receipt/approval disposition, and separately named managed-core, provisioning, activation-migration, and revalidation results. It SHALL preserve exact retired-alias, skipped-conflict, ownership-migration, and source/target identity details. JSON SHALL not authorize apply. Stdout SHALL contain one JSON result, with progress and any interactive approval on stderr.

#### Scenario: JSON apply result
- **WHEN** a matching explicitly approved plan is applied with `--json`
- **THEN** stdout contains one schema-3 result with actual commit, written/removed/skipped entries, provisioning, and readiness outcomes

#### Scenario: JSON drift report
- **WHEN** check finds actionable work with `--json`
- **THEN** stdout contains the same semantic preview and fingerprints as human mode
- **AND** it exits 2 without project changes and discloses the external receipt outcome

#### Scenario: JSON does not imply consent
- **WHEN** `liftoff update --json` lacks a matching preview or usable exact-plan approval
- **THEN** it reports a blocked reason and exits 1 without project writes

#### Scenario: Local migration committed but revalidation is blocked
- **WHEN** a schema-3 apply result follows committed migration with incomplete revalidation
- **THEN** it distinguishes commit from blocked readiness, identifies the next action, and exits 2

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
When configuration omits `governanceProfile`, update SHALL continue automatically selecting `single-maintainer-gitflow` and its exact managed handoff artifacts as desired state. This automatic selection SHALL NOT authorize writes: adoption SHALL require the same preview receipt and exact-plan approval as other updates. The user-owned configuration SHALL not be rewritten to materialize its default.

#### Scenario: Adopt into an untouched v4 project
- **WHEN** a matching approved plan adopts governance into a valid legacy project with absent destinations
- **THEN** the named handoff artifacts and v7 manifest are written transactionally without running an agent or contacting GitHub

#### Scenario: Preview automatic adoption
- **WHEN** the user checks before adoption
- **THEN** the applicable governance entries appear as new named artifacts and check exits 2 without project writes

#### Scenario: Existing setup destination has different bytes
- **WHEN** an unrecorded destination differs from the render
- **THEN** the approved normal plan preserves it and records partial handoff without acquiring its ownership

#### Scenario: Resolve a partial handoff
- **WHEN** a new approved plan finds old unowned conflicts absent or byte-identical
- **THEN** it writes/adopts only eligible exact handoff files and records complete handoff

#### Scenario: Existing setup destination already matches
- **WHEN** an approved adoption finds byte-identical unrecorded content
- **THEN** it records the destination without rewriting it

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

### Requirement: Update never activates remote governance
Reviewed update SHALL remain local. Its explicitly authorized activation-migration lane can preserve history, create a linked local successor, and perform its finite local revalidation, but SHALL NOT invoke an agent, inspect a provider, create a branch, commit, push, apply a ruleset, enroll credentials, or alter deployment settings. An update approval SHALL not authorize a later provider or governance gate.

#### Scenario: Update with an authenticated GitHub CLI
- **WHEN** GitHub credentials and a writable remote are available
- **THEN** update performs only its approved local operations and makes no provider request

#### Scenario: A migrated phase requires remote proof
- **WHEN** the next incomplete phase needs provider observation or mutation
- **THEN** update stops at that boundary and identifies a separately reviewed action or missing capability

### Requirement: Update output identifies its authority boundary
Human and JSON output SHALL distinguish managed-core maintenance, create-only provisioning, manifest ownership changes, narrowly approved activation/history mutations, and post-commit local revalidation. It SHALL identify skipped conflicts, withheld provisioning, and production files outside the plan. It SHALL never imply that migration updates application templates or that local migration completion proves live governance.

#### Scenario: JSON check contains core drift
- **WHEN** a core conflict appears in JSON preview
- **THEN** its scope and exact portable path are identified separately from migration state

#### Scenario: Ownership-only migration
- **WHEN** only manifest ownership normalization is planned
- **THEN** check and apply state that no production file will be written

#### Scenario: Project template changed
- **WHEN** only production template bytes changed between releases
- **THEN** update does not report them as actionable or recommend force

### Requirement: Update reconciles managed phase definitions without owning execution state
Managed-core reconciliation SHALL not itself advance, reset, delete, or rewrite user-owned activation state or evidence. A separately declared, previewed, explicitly approved activation-migration lane SHALL be the only update exception, preserving original historical bytes before creating linked current state. Graph changes affecting active work SHALL remain reconciliation-required until current proof supports them.

#### Scenario: Phase graph has managed drift
- **WHEN** check detects a managed graph change
- **THEN** it reports the managed changes and activation impact without project mutation

#### Scenario: Updated graph affects active work
- **WHEN** an approved plan installs a changed graph
- **THEN** governance inspection identifies affected phases and required reconciliation without remote mutation

#### Scenario: Historical phase state remains compatible
- **WHEN** existing current-format evidence genuinely satisfies the compatible graph
- **THEN** it remains reusable under the current proof contract rather than being retagged

#### Scenario: Historical diagnostic-only state is preserved
- **WHEN** v1 history is encountered before an eligible migration is approved
- **THEN** it remains unchanged and non-executable
- **AND** eligibility alone does not authorize a successor

### Requirement: Update applies the activation compatibility matrix
The system SHALL use an exact release-owned compatibility matrix. The execution family SHALL remain manifest 7, policy 6, activation contract/state/evidence/approval versions 2, graph schema 1, and supersession/credential-policy schemas 1. Compatibility metadata schema 3 SHALL separately describe historically readable identities, currently executable identities, and explicit approved history-preserving migration lanes; schema-2 metadata SHALL remain readable as supported historical input, not as new migration authorization. No source tuple SHALL be inferred from version ordering.

#### Scenario: Historical activation state is supported
- **WHEN** a complete historical source matches the declared migration lane
- **THEN** check reports the entire plan and apply creates the successor only after receipt, approval, and all preflights pass

#### Scenario: Historical v1 activation history is diagnostic-only
- **WHEN** the current lane permits a v1 successor
- **THEN** the original state/evidence remain diagnostic-only in preserved history
- **AND** fresh v2 proof is required for execution

#### Scenario: Activation identity is from the future
- **WHEN** a contract, schema, or graph is unsupported
- **THEN** update/setup block with the exact incompatibility and preserve bytes without downgrade

#### Scenario: Policy and activation contract are incompatible
- **WHEN** their complete combination is absent from the matrix
- **THEN** no phase advances and force cannot authorize the pair

### Requirement: Preview receipts are project-bound external metadata
Only public update check SHALL issue schema-versioned preview receipts in user-local storage outside the project and repository. Each receipt SHALL bind the canonical project boundary, installed target, effective plan variants, relevant source/destination/input fingerprints, and planned validation operations. It SHALL contain no source bodies or credentials and SHALL never itself be approval. Platform-native absolute storage resolution, restrictive creation permissions where supported, and explicit storage failures SHALL apply on Windows, macOS, and Linux.

#### Scenario: First eligible check
- **WHEN** check successfully presents an actionable eligible plan
- **THEN** it persists and discloses an external receipt while leaving every project byte unchanged

#### Scenario: Receipt location is unsafe or unwritable
- **WHEN** the user-state path resolves inside the project/repository, uses an unsafe path type, or cannot be written
- **THEN** check reports failure without issuing a usable receipt or falling back to project storage

#### Scenario: Unsupported preview
- **WHEN** current compatibility or structural guards block the plan
- **THEN** no apply-eligible receipt is issued and a previously cached receipt cannot bypass the blocker

#### Scenario: Project path changes
- **WHEN** a project is copied, moved, or opened through a different worktree identity
- **THEN** the previous local receipt cannot authorize the new boundary
- **AND** native Windows paths and spaces do not weaken this binding

#### Scenario: Doctor reuses update planning
- **WHEN** doctor or another read-only inspector evaluates the same plan
- **THEN** it does not create, refresh, approve, or consume a preview receipt

### Requirement: Every effective update plan needs current exact approval
Before new update writes, the system SHALL rebuild the plan from current authoritative inputs, match a valid receipt for its exact effective mode, obtain explicit approval, and recheck all relevant preconditions under the project lock. Interactive approval SHALL default to no. Noninteractive approval SHALL require the full fingerprint through `--approve-plan`. Neither `--force`, `--json`, a generic yes, cached operations, nor a prior unrelated check SHALL bypass these gates.

#### Scenario: The user did not run check
- **WHEN** apply has actionable work but no matching receipt
- **THEN** it exits 1 without new project writes and instructs the user to run `liftoff update --check`

#### Scenario: The preview is stale
- **WHEN** a source, target, mode, protected input, destination, or validation operation differs from the reviewed plan
- **THEN** apply refuses the stale receipt/approval and requires a fresh check

#### Scenario: The user declines
- **WHEN** the interactive approval is declined or cancelled
- **THEN** apply exits without project mutation and does not report success

#### Scenario: Automation approves the precise plan
- **WHEN** a valid receipt and full matching `--approve-plan` fingerprint are supplied
- **THEN** the selected plan can apply without prompting after current preconditions pass

#### Scenario: Inputs change while approval is displayed
- **WHEN** project inputs change before the approved invocation acquires its write lock
- **THEN** the locked recheck prevents mutation under the previous approval

#### Scenario: A root-level project script changes
- **WHEN** a reviewed validation command uses a project script outside the activation-input allowlist and that script changes after preview or during approval
- **THEN** the retained-source binding invalidates the prior fingerprint before that changed script can execute
- **AND** a directory name such as build or dist does not exempt existing script inputs from review

#### Scenario: An approved command writes generated outputs
- **WHEN** an executed approved command changes files only within its explicitly declared generated-output scope
- **THEN** the execution guard accepts those resulting outputs after that command and protects them before subsequent commands
- **AND** unrelated source edits are preserved and block continuation

#### Scenario: A completed plan is replayed
- **WHEN** an old receipt or approval is reused after its source transaction committed
- **THEN** changed source preconditions prevent replaying that migration or write set

#### Scenario: An approved interrupted transaction needs recovery
- **WHEN** a durable journal identifies an incomplete already-approved transaction
- **THEN** the system can recover only that exact attributable transaction under its recorded authorization
- **AND** it stops before new update work, which requires a current preview and approval

#### Scenario: A project-local journal falsely claims approval
- **WHEN** a recovery journal lacks a matching separately persisted user-local approval for its exact finalized mutation digest
- **THEN** recovery refuses to mutate the project
- **AND** neither a preview receipt nor a project-local approval claim substitutes for explicit consent

### Requirement: Managed update does not claim unsupported project identity migrations
Managed update SHALL reject requested project-name, cloud, or region changes
when they differ from recorded workload identity and no supported reviewed
migration path exists. Rejection SHALL precede rendering-driven writes to the
manifest, managed context, or project files and SHALL preserve every project
byte. Force SHALL not bypass this boundary.

#### Scenario: Region or cloud changes in configuration
- **WHEN** desired configuration names a different cloud or region from the recorded project
- **THEN** update reports a migration-only change and performs no write

#### Scenario: Project identity changes
- **WHEN** desired configuration renames an existing project
- **THEN** update does not rewrite metadata while leaving application and infrastructure identities unchanged
- **AND** reports that a separately reviewed migration is required

### Requirement: Governance cannot be disabled through ordinary update while activation state exists
An enabled-to-disabled governance profile change SHALL be rejected by ordinary
update when activation state exists and no supported deactivation proof is
available. Update SHALL neither perform deactivation nor infer the absence of
live enforcement. It SHALL preserve managed ownership, activation state,
evidence, and configuration bytes.

#### Scenario: Disable after setup has started
- **WHEN** a developer changes the desired profile to `none` after activation state has been created
- **THEN** update stops before rewriting the manifest or dropping managed ownership
- **AND** gives an explicit separate-deactivation or reconciliation remedy

#### Scenario: Force is supplied
- **WHEN** force-update is requested for the same profile transition
- **THEN** it still refuses to claim governance is disabled
- **AND** does not fabricate a deactivation or supersession record
