## Purpose

Define the `liftoff update` command that reconciles Liftoff-managed core files and explicitly authorized component provisioning while keeping production project templates outside update authority.

## Requirements

### Requirement: Update reconciles a generated project against a fresh render
The system SHALL provide `liftoff update` with its compatibility-first, preview-gated workflow for supported generated and adopted projects. It SHALL read developer-owned desired state, derive managed-core expectations from actual recorded workload/profile/component and integration identity, and reconcile exact managed logical names. Configuration-authorized create-only provisioning and supported manifest/activation migration or revalidation SHALL remain separate lanes. Classifications SHALL remain unchanged, new, missing, upgrade, conflict, moved, orphan, retired, or retired-conflict. Existing project-owned application files SHALL remain outside template comparison. Every write-capable plan SHALL require a matching prior check and exact approval. Check SHALL be project-read-only, disclose its external receipt, and exit 0 for no actionable work or 2 for actionable drift, migration, or revalidation.

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

#### Scenario: An adopted project has a custom layout
- **WHEN** a schema-8 project records a supported adopted component outside fresh-starter paths
- **THEN** managed expectations use that actual approved identity and layout
- **AND** update does not synthesize a starter backend, move business files, or fabricate generation provenance

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
Update SHALL preflight the complete approved write set, treat only confirmed missing paths as absent, acquire the cooperating project lock, and recheck current preconditions before mutation. Storage, replacement, cleanup, manifest, lock, and recovery failures SHALL exit 1, name the failed operation, and report actual progress without claiming success. Recovery SHALL preserve supported modes, clean only exact registered temporaries, and restore only attributable unchanged transaction writes. Registered historical update/repair serializers and identities SHALL remain unchanged. Activation-migration recovery SHALL remain distinct from post-commit revalidation, whose incomplete outcome retains exit 2 and the actual linked successor as blocked/resumable rather than hard-coding an obsolete v2 execution target.

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
- **AND** it does not use prefix/glob cleanup

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
The system SHALL treat desired state as developer-owned and ordinary update SHALL not rewrite it after generation. A separate approved agent repair can change only its reviewed agent/default fields; an explicit activation preparation plan can change only its named target/environment fields. Other values SHALL remain unchanged. Existing compatible create-only frontend/environment provisioning SHALL retain its safety rules, while legacy/unknown layouts require supported repair. No desired-state edit SHALL grant ordinary update or force authority over existing project-owned files or live state/resources.

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
- **THEN** update provisions the frontend only when every destination satisfies the existing create/adopt safety rules
- **AND** all created frontend files become project-owned

#### Scenario: Power Apps plugin preference changes
- **WHEN** update encounters a former Power Apps workload or plugin-preference change
- **THEN** it reports the retired workload or option instead of reconciling the preference
- **AND** it does not rewrite the manifest or application files

#### Scenario: Power Apps rejects API configuration drift
- **WHEN** a retired Power Apps project contains added API configuration
- **THEN** update rejects the retired boundary before attempting workload-specific reconciliation

#### Scenario: Retired workload configuration is rejected
- **WHEN** desired state selects workload kind `power-apps-code-app`
- **THEN** update exits 1 before rendering or writing
- **AND** it does not reinterpret the configuration as a supported API or GenAI workload

#### Scenario: Approved agent repair changes desired state
- **WHEN** a separate supported repair adds an agent or explicitly changes a Spec Kit default
- **THEN** only the approved selection fields are updated with the corresponding framework and manifest state
- **AND** ordinary update still cannot perform that framework mutation

### Requirement: Update refuses unsafe reconciliations
Update SHALL reject configured workload kind or immutable workload/profile identity that differs from the normalized recorded identity without an explicitly supported reviewed transition. API-stack and GenAI-pattern conversion SHALL remain outside update; a fresh initialization remedy SHALL mean a separate target, never reinitializing an existing project. Retired `power-apps-code-app` identity SHALL fail before deeper artifact or activation access even with governance disabled. A newer recorded writer than the running CLI SHALL still block using SemVer-aware ordering, including prereleases. Schema-8 adopted profiles SHALL be validated as their actual form rather than forced into fabricated generated-workload fields.

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

#### Scenario: Adopted profile selection changes frameworks
- **WHEN** a desired adopted profile implies an unregistered framework or component conversion
- **THEN** update reports the exact unsupported transition before metadata or file writes
- **AND** a profile name or matching hash does not authorize conversion

### Requirement: Apply rewrites the manifest as scoped recorded state
After an eligible approved transaction, current update SHALL write manifest 8 with the exact CLI writer, validated profile/component identity, hashes only for written or identically adopted core entries, eligible retired aliases removed, and preserved generated/adopted/repaired project provenance. Skipped conflicts SHALL retain old hashes. A source v2-v7 manifest SHALL require its declared reviewed schema transition. Activation identity SHALL change only with an explicitly approved linked successor and preserved source metadata; post-commit revalidation failure SHALL not roll back that manifest or bless custom bytes as generated state.

#### Scenario: Manifest catches up after core update
- **WHEN** an approved core transaction commits
- **THEN** manifest hashes match its actual written/adopted files and project provenance is preserved

#### Scenario: Skipped core conflict stays visible
- **WHEN** a later check inspects a skipped core conflict
- **THEN** the old recorded hash still exposes that conflict

#### Scenario: Project file changed after generation
- **WHEN** a project-owned file has changed or disappeared
- **THEN** its original generation or adoption provenance remains unchanged and confers no replacement authority

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
Update SHALL retain schema-3 JSON with `scope: "project-update"`, mode, stable status/reason codes, fingerprints, receipt/approval disposition, and separate managed-core, provisioning, manifest/activation migration, and revalidation outcomes. Exact retired aliases, conflicts, ownership changes, source/target identity, and preserved provenance SHALL remain observable. Structured continuations SHALL use the independent schema-1 public context contract without changing stored receipts or the meaning of existing schema-3 fields. JSON SHALL not authorize apply or prompt for consent; stdout SHALL contain one result and diagnostics/progress SHALL use stderr.

#### Scenario: JSON apply result
- **WHEN** a matching explicitly approved plan is applied with `--json`
- **THEN** stdout contains one schema-3 result with actual commit, written/removed/skipped entries, provisioning, and readiness outcomes

#### Scenario: JSON drift report
- **WHEN** check finds actionable work with `--json`
- **THEN** stdout contains the same semantic preview and fingerprints as human mode
- **AND** it exits 2 without project changes and discloses the external receipt outcome

#### Scenario: JSON does not imply consent
- **WHEN** `liftoff update --json` lacks a matching preview or usable exact-plan approval
- **THEN** it reports the specific blocked reason and exits 1 without prompting or writing

#### Scenario: Local migration committed but revalidation is blocked
- **WHEN** a schema-3 apply result follows committed migration with incomplete revalidation
- **THEN** it distinguishes commit from blocked readiness, identifies the next action, and exits 2

### Requirement: Update migrates supported manifests without production mutation
Update SHALL interpret supported v2-v7 manifests through their registered source contracts and perform ownership normalization in memory before reconciliation. Only an eligible reviewed transaction SHALL write schema 8. Check SHALL preserve the source manifest byte-for-byte. Successful migration SHALL retain exact managed hashes, release non-core legacy entries to project provenance, preserve recorded generation/adoption/repair history and framework uncertainty, and explicitly retain unknown original profile facts. Modified or absent files SHALL not lose provenance. Manifest migration SHALL not write, restore, move, or delete project-owned files.

#### Scenario: Check a legacy project
- **WHEN** a developer runs `liftoff update --check` against a supported legacy manifest
- **THEN** update reports the pending ownership migration and applicable managed-core drift
- **AND** leaves the manifest and every project file byte-for-byte unchanged

#### Scenario: Migrate intentionally deleted infrastructure
- **WHEN** a historical manifest records generated infrastructure that is now absent and migration is approved
- **THEN** update records preserved project provenance without recreating the path

#### Scenario: Migrate production source
- **WHEN** a legacy manifest records source now containing production behavior and migration is approved
- **THEN** update releases the entry from broad legacy authority without changing the file or inventing generation facts

#### Scenario: Preserve legacy framework uncertainty
- **WHEN** a legacy manifest lacks official framework metadata
- **THEN** schema 8 preserves legacy framework state without fabricating selected-agent integrations

### Requirement: Existing projects adopt managed-core governance artifacts automatically
For supported initialized projects whose configuration omits `governanceProfile`, update SHALL continue selecting `single-maintainer-gitflow` and its exact applicable handoff artifacts as desired-state defaults. Automatic selection SHALL not authorize writes or perform the new in-place `adopt` operation. Applying the handoff and any required schema-8 transition SHALL use the existing matching preview and exact approval. Developer-owned configuration SHALL not be rewritten to materialize its default.

#### Scenario: Adopt into an untouched v4 project
- **WHEN** a matching approved plan adopts governance into a valid legacy project with absent destinations
- **THEN** the named handoff and v8 manifest commit transactionally without invoking an agent or contacting GitHub

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
When an eligible configuration transition explicitly selects `none`, update SHALL stop rendering that profile's handoff artifacts. Recorded governance files SHALL retain the orphan contract and SHALL not be deleted automatically; active/archived changes and agent-authored governance implementation SHALL remain outside reconciliation. Existing activation state SHALL still require the separate supported deactivation/reconciliation boundary. A successful eligible schema-8 write SHALL not imply live enforcement was removed.

#### Scenario: Disable the generated profile
- **WHEN** `governanceProfile` changes to `none` in a project eligible for local opt-out and reviewed update succeeds
- **THEN** recorded handoff artifacts are reported as orphans and left on disk
- **AND** the v8 manifest records the local profile as disabled without claiming remote deactivation

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
Update SHALL use the exact release-owned compatibility matrix, not version ordering. Current execution SHALL bind manifest 8, policy 8, activation contract/state/evidence-header/approval-envelope 4, graph schema 3 with its computed hash and phase digests, credential-policy schema 2, and unchanged supersession schema 1. Compatibility metadata 5 SHALL separately declare historical readers, current execution, and exact approved migration/revalidation lanes, including the exact pre-amendment policy-7/credential-policy-schema-1 candidate. Historical metadata schemas 2, 3, and 4 SHALL remain readable only where explicitly registered with their original tuple and digest semantics, not as new authorization. Repair contract 1 and unchanged schema-2 records SHALL remain independently registered.

#### Scenario: Historical activation state is supported
- **WHEN** a complete historical source matches the declared migration lane
- **THEN** check reports the entire plan and apply creates the successor only after receipt, approval, and all preflights pass

#### Scenario: Historical v1 activation history is diagnostic-only
- **WHEN** the current lane permits a v1 successor
- **THEN** the original state/evidence remain diagnostic-only in preserved history
- **AND** fresh target-contract proof, rather than rewritten old proof, is required for execution

#### Scenario: Activation identity is from the future
- **WHEN** a contract, schema, or graph is unsupported
- **THEN** update/setup block with the exact incompatibility and preserve bytes without downgrade

#### Scenario: Policy and activation contract are incompatible
- **WHEN** their complete combination is absent from the matrix
- **THEN** no phase advances and force cannot authorize the pair

#### Scenario: Managed update encounters the prior credential policy
- **WHEN** the project retains the pre-amendment policy-7 identity or schema-1 credential policy
- **THEN** check distinguishes ordinary managed drift from the exact separately reviewed identity/policy transition
- **AND** update consent does not authorize broader credential use, retag prior approval or replace an unowned policy

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
Before new writes, update SHALL rebuild the plan from authoritative current inputs, match a valid external preview for its exact mode, obtain explicit approval, and recheck relevant preconditions under the project lock. Genuine interactive approval SHALL display the immutable plan and default to No without manual fingerprint entry. JSON/noninteractive approval SHALL require the full fingerprint through `--approve-plan` and all applicable independent permissions. Force, generic Yes, cached operations, a project-local approval claim, or an unrelated check SHALL not bypass these gates.

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

### Requirement: Human update follow-ups use the invocation's project context

Whenever update emits a human follow-up command, it SHALL omit `--project` if ordinary project discovery from the invocation directory resolves to the same canonical project as the selected update target. Otherwise, it SHALL retain an explicit, shell-safe absolute target. This policy SHALL apply consistently to preview follow-ups, normal and forced apply suggestions, approval reminders, and update retry or recovery instructions. Human guidance using an implicit target SHALL identify the resolved project separately. Shortening a suggested command MUST NOT change discovery rules, the selected target, plan eligibility, or update authority.

#### Scenario: Preview from the project root suggests a plain update
- **WHEN** a developer runs `liftoff update --check` at the root of a supported project and an apply follow-up is available
- **THEN** the human follow-up is `liftoff update`, without a redundant `--project` argument
- **AND** the report identifies the resolved project separately from the command

#### Scenario: Preview from a project subdirectory retains implicit discovery
- **WHEN** a developer runs update check from a subdirectory whose nearest valid project boundary is the selected target
- **THEN** an emitted apply follow-up omits `--project`
- **AND** running that follow-up from the unchanged directory resolves to the same project

#### Scenario: A redundant explicit input does not force redundant human guidance
- **WHEN** a developer explicitly selects the same project that ordinary discovery from the invocation directory would select
- **THEN** emitted human update follow-ups omit the redundant target argument
- **AND** the explicitly selected project remains the operation's authoritative target

#### Scenario: A different target remains explicit
- **WHEN** update selects a project outside the invocation directory's discovered project, through either a positional path or `--project`
- **THEN** all emitted human update follow-ups retain the selected project's absolute target
- **AND** copying a suggested command does not redirect the operation to the caller's project

#### Scenario: An inner project cannot stand in for an explicitly selected outer project
- **WHEN** the invocation directory is inside a nested project and update explicitly selects its containing outer project
- **THEN** follow-up commands retain the outer project's explicit path
- **AND** sharing a directory ancestor does not authorize omission of that path

#### Scenario: Unknown invocation context keeps guidance explicit
- **WHEN** an explicit update target is valid but equivalent implicit targeting cannot be established from the invocation directory
- **THEN** follow-up guidance remains explicitly targeted
- **AND** optional command shortening does not change the primary operation's outcome or hide an actual selected-project discovery error

#### Scenario: Force and approval reminders follow the same targeting rule
- **WHEN** an eligible forced plan or an approval reminder is shown from a directory that resolves to the selected project
- **THEN** the corresponding human update command omits `--project` while retaining any required mode or approval arguments
- **AND** the existing force eligibility and exact-plan approval requirements remain unchanged

#### Scenario: Native path identities and quoting remain safe
- **WHEN** invocation and target paths use supported native path forms on Windows, macOS, or Linux, including Windows drive or UNC paths and names containing spaces or shell metacharacters
- **THEN** command shortening depends on the resolved project boundary rather than textual prefix similarity
- **AND** equivalent path spellings are treated as equal only when the filesystem's canonical identity establishes equality
- **AND** any retained target is formatted as a literal argument for the platform's supported shell
- **AND** an unsafe manifest or path alias is not made acceptable by the guidance policy

### Requirement: Post-update validation guidance preserves its execution directory

After a successful update, the system SHALL omit the directory-change wrapper from human validation guidance when the invocation directory is already the canonical project root. From any other directory, including a project subdirectory, it SHALL retain the shell-safe change to that root before validation. Both forms SHALL preserve the existing order and success-dependent execution of `liftoff validate` followed by `liftoff doctor`. Generating these instructions SHALL NOT execute them or change the caller's directory.

#### Scenario: Completion at the project root avoids a redundant directory change
- **WHEN** a successful update emits completion guidance while invoked at the selected project root
- **THEN** the validation sequence contains no `cd` or `Set-Location` wrapper
- **AND** it runs doctor only after validate succeeds

#### Scenario: Completion outside the project root keeps the directory change
- **WHEN** completion guidance is emitted from another directory, including a subdirectory of the selected project
- **THEN** the sequence first changes to the selected project root
- **AND** a failed directory change prevents both validation commands from running

#### Scenario: Completion uses native shell semantics
- **WHEN** validation guidance targets a path containing spaces, apostrophes, or other shell metacharacters on Windows, macOS, or Linux
- **THEN** retained directory arguments preserve the literal path
- **AND** POSIX shells and PowerShell retain their respective conditional-execution behavior with or without a directory-change wrapper

### Requirement: Preview recovery guidance identifies the actual failure

The system SHALL distinguish a missing saved preview from stale, invalid, unsupported, busy, and storage-failure conditions. A missing-preview diagnostic SHALL identify the selected project, explain that no usable saved preview was found and no new project update was performed, and direct the developer to run update check before approving apply. It MUST NOT imply that a project path argument or storage repair is required solely because the preview is missing. Recovery commands in human output SHALL follow the invocation-context targeting policy. Diagnostics SHALL preserve the actual failure details and MUST NOT delete receipts, bypass approval, or perform recovery actions merely to simplify the message.

#### Scenario: Plain update has no saved preview
- **WHEN** apply has actionable work but no saved preview is available for the selected project
- **THEN** the diagnostic explains the missing saved preview and identifies the selected project
- **AND** it instructs the developer to run `liftoff update --check`, review the result, then run update and approve the matching plan
- **AND** it reports no new project update and does not claim a storage fault or missing project argument
- **AND** the command exits 1 with the existing `preview-missing` reason code

#### Scenario: A prior check does not imply a receipt is still available
- **WHEN** a previous check's receipt has been consumed or is absent from the current user-local store and a new actionable apply is attempted
- **THEN** the diagnostic reports the absence of a saved preview without asserting that the developer never ran check
- **AND** it requests a fresh preview rather than suggesting that repeating the project path will repair the problem

#### Scenario: A stale preview keeps its distinct explanation
- **WHEN** a saved preview does not match the current effective plan
- **THEN** the diagnostic retains the mismatch explanation and `preview-mismatch` reason code
- **AND** it directs the developer to a fresh check and approval of the current plan without treating the mismatch as a storage fault

#### Scenario: A storage failure retains the real operation and repair details
- **WHEN** preview storage fails because of permissions, an unsafe location, or a failed filesystem operation
- **THEN** the diagnostic retains the actual failure and affected path information
- **AND** it gives storage-specific repair guidance before retrying check
- **AND** it does not replace the failure with a generic missing-preview explanation

#### Scenario: Invalid, unsupported, and busy previews remain distinguishable
- **WHEN** a preview is invalid, uses an unsupported schema, or is blocked by concurrent access
- **THEN** the diagnostic retains its existing specific reason code and relevant fault details
- **AND** its remedy addresses that condition rather than describing every preview failure as missing or damaged storage

#### Scenario: Check and apply are shown as separate steps
- **WHEN** guidance explains the preview-then-apply workflow
- **THEN** it presents separate commands rather than joining check and apply with a success-only shell chain
- **AND** exit code 2 from an actionable check remains a reviewable update result rather than a failed preview

### Requirement: Guidance changes preserve durable update identities and machine contracts

Context-sensitive display SHALL remain presentation-only: equivalent canonical targets and effective inputs SHALL keep the same receipt keys, fingerprints, and approval requirements. Update SHALL retain JSON schema 3, canonical `projectRoot`, established fields, status/reason codes, and exit semantics; shared structured continuations SHALL preserve these meanings and SHALL NOT cause historical receipt rewriting. JSON remedies and callers without trusted invocation context SHALL retain explicit target, working directory, scope, and configuration binding. Diagnostic wording SHALL explain actual failures without changing machine-readable identity.

#### Scenario: Implicit and explicit invocations share the same reviewed plan
- **WHEN** check and apply target the same unchanged project but one invocation omits the path and the other supplies it
- **THEN** the same matching preview and exact effective-plan approval apply
- **AND** differences in displayed commands do not invalidate or authorize the plan

#### Scenario: A JSON missing-preview failure stays actionable outside the original shell
- **WHEN** update emits a JSON result for a missing preview
- **THEN** it retains schema version 3, canonical `projectRoot`, and `preview-missing`
- **AND** its remedy explicitly targets the project with the correct working directory and configuration reference without inventing a storage failure

#### Scenario: Safety gates are not relaxed by shorter commands
- **WHEN** a follow-up command omits a redundant path
- **THEN** missing or mismatched previews, absent or mismatched approval, ownership boundaries, and transaction-recovery requirements continue to block or constrain updates exactly as before
- **AND** neither printing nor running an unapproved follow-up silently approves an update

### Requirement: Update routes repairable identity changes to the supported repair flow
Ordinary update SHALL retain its managed-core and already-declared migration boundaries. When a supported additive agent/default change or incompatible infrastructure layout requires project repair, it SHALL identify the actual repair preview and project context rather than only requesting restored configuration, manual metadata edits, or reinitialization. Unsupported workflow switches, removals, retired workloads, and unrelated migrations SHALL remain explicit limitations.

#### Scenario: Desired state adds Codex
- **WHEN** an initialized project adds Codex and ordinary update encounters that agent change
- **THEN** update performs no framework mutation and directs the developer to a project-bound repair preview
- **AND** it does not claim that restoring the old agent list is the only supported route

#### Scenario: Core is current but infrastructure is legacy
- **WHEN** managed-core bytes match while local baseline is blocked by legacy infrastructure
- **THEN** update accurately reports its clean core scope and distinguishes the separate repair requirement
- **AND** it does not claim that core currency establishes local setup completion

#### Scenario: Repair would require stateful migration
- **WHEN** an infrastructure candidate is stateful or unverified
- **THEN** follow-up guidance distinguishes supported stateful planning/execution prerequisites from unresolved or unsupported scope
- **AND** ordinary update approval or force cannot authorize backend or resource mutation

### Requirement: Managed-context expectations use active recorded layout
Update, repair preview, doctor, and assessment SHALL use the same installed-release expectation for the active manifest, explicit profile/component identity, and recorded or approved adopted layout. Context SHALL not assume a fresh independent infrastructure or application layout for legacy, unknown, or adopted projects. Historical repair/adoption snapshots SHALL not replace the active target, and uncertainty SHALL remain visible rather than fabricating component generation or conformance.

#### Scenario: Legacy context matches the installed contract
- **WHEN** a context correctly describes the active legacy layout for the installed CLI
- **THEN** all managed-core comparisons agree that the file matches that expectation
- **AND** the infrastructure migration requirement remains a separate finding

#### Scenario: Repaired context matches independent roots
- **WHEN** an approved repair commits an independent active inventory and corresponding context
- **THEN** update compares against that current inventory and preserves retained legacy history

#### Scenario: Context bytes are actually modified
- **WHEN** context differs from the common expected render
- **THEN** the existing managed-core conflict/hash rules remain enforced rather than normalizing away genuine changes

#### Scenario: An adopted component does not have starter paths
- **WHEN** current adopted provenance identifies supported custom component roots
- **THEN** all consumers use the same truthful active mapping
- **AND** a fresh template's paths do not become assumed current ownership or repair completion

### Requirement: Activation-contract upgrade is separate from infrastructure execution
Reviewed update SHALL identify the exact historical source and current activation successor and preserve original records before changing active identity. Its approval SHALL authorize only inventoried local migration and finite declared revalidation, not live state movement, Git publication, credential enrollment, repository controls, or deployment. Current activation and stateful execution SHALL require separate current plans and authority. A historical publication affected by the old input projection SHALL retain its original digest semantics and require independently authorized linked readback/revalidation without redundant publication solely to repair metadata.

#### Scenario: A v2 project needs the revised execution contract
- **WHEN** the exact source is supported by a declared successor lane
- **THEN** update preview identifies the target contract, preserved history, and fresh-proof work
- **AND** no version field is manually retagged to bypass compatibility

#### Scenario: A successor has been created
- **WHEN** the local identity migration commits
- **THEN** the new activation can be inspected and planned under its declared contract
- **AND** the migration result alone does not execute its cloud or stateful stages

#### Scenario: Schema-3 publication needs current proof
- **WHEN** reviewed migration encounters the supported historical Azure-input publication mismatch
- **THEN** it preserves old plans, approvals, receipts, source commit/ref identity, and history and identifies the separate bound revalidation action
- **AND** it does not push, recommit, reinterpret old hashes, or claim that later local edits are already remote

### Requirement: Managed profile and skill transitions have exact local scope
Supported managed profile or integration transitions SHALL be declared by the release compatibility catalog and exposed in update preview with exact old/new logical identities, paths, content hashes, component/profile requirements, consumers, and retirement rules. They SHALL remain local and limited to already authorized managed-core or explicit migration effects. Selected-agent additions and framework/default changes SHALL continue through the supported separate repair flow where required. Unsupported profile, workflow, host, or transport changes SHALL remain blockers. Existing setup, assessment, and repair invocation identities SHALL not move or disappear merely because canonical skills are packaged.

#### Scenario: Update a selected host's canonical instructions
- **WHEN** the current selected integration has safe managed drift and a compatible registered target
- **THEN** a matching approved update changes only those exact managed entries
- **AND** it does not install unselected hosts, rewrite global host settings, or grant application authority

#### Scenario: Migrate an existing registered transport
- **WHEN** a supported reviewed plan relocates or retires explicit managed skill identities
- **THEN** old and new destinations, remaining consumers, conflicts, and exact eligible cleanup are visible before approval
- **AND** unlisted `.github`, `.claude`, `.agents`, OpenSpec, Spec Kit, and user files remain untouched

#### Scenario: A new skill destination is occupied
- **WHEN** an unowned or framework-owned destination contains different bytes
- **THEN** the transition reports the collision and preserves it even under force
- **AND** file resemblance or a canonical catalog entry does not acquire ownership

#### Scenario: A profile transition needs application changes
- **WHEN** a target profile requires changes to existing source, dependencies, containers, configuration, or infrastructure
- **THEN** those effects remain outside managed update and require the appropriate separate reviewed operation
- **AND** updating metadata alone does not claim that the profile's behavior is implemented

#### Scenario: Discovery roots overlap on Windows
- **WHEN** project and personal integrations overlap, alias, or collide by native case/normalization rules on Windows, macOS, or Linux
- **THEN** the plan resolves exact ownership and discovery or blocks before writes
- **AND** no symlink assumption, path-prefix test, or glob grants migration authority

### Requirement: Installation changes never trigger project evolution
Installing, replacing, or migrating the Liftoff executable SHALL not run update, alter manifest/profile/activation identity, adopt an application, repair infrastructure, replace skill projections, or initialize an existing project. Existing projects SHALL first remain readable under supported historical contracts and receive a separate project-bound review when change is needed. Project Node/npm dependencies, lockfiles, source, history, and state SHALL remain outside installation ownership.

#### Scenario: Native installation replaces legacy npm Liftoff
- **WHEN** an explicitly approved installation handover completes
- **THEN** existing project files and metadata remain unchanged
- **AND** a later update check is only a separately requested recommendation, not an automatic continuation

#### Scenario: The new executable needs a v8 project transition
- **WHEN** inspection finds supported older metadata requiring an eligible current write
- **THEN** output identifies the reviewed project update/migration boundary
- **AND** it neither reruns init nor fabricates a current activation tuple

### Requirement: Update continuations retain configuration and approval boundaries
Every update continuation SHALL preserve executable, separate arguments, working directory, canonical project, selected scope, configuration reference/digest, compatibility identity, and required authority. Existing context-sensitive human target shortening and success-dependent validate/doctor sequencing SHALL remain intact when they preserve that context; JSON SHALL remain explicitly targeted. Separate assessment or declared validation findings can recommend actual repair/adoption previews, but SHALL not turn project-owned template differences into ordinary update drift.

#### Scenario: A project is selected outside the current directory
- **WHEN** update emits repair, revalidation, approval, or resume actions for another project
- **THEN** each action retains the same project and original resolved inputs despite a different working directory
- **AND** Windows and POSIX displays preserve literal paths with spaces and metacharacters

#### Scenario: A known project-owned defect needs repair
- **WHEN** separate assessment or authorized validation identifies supported Scalar routing or Azure baseline remediation
- **THEN** guidance identifies the real exact per-file application or registered infrastructure repair preview
- **AND** update approval and force do not authorize those effects

#### Scenario: A consumed input changes before continuation
- **WHEN** the selected configuration reference or relevant contents differ from the reviewed binding
- **THEN** continuation requires a fresh applicable preview and approval
- **AND** omitting `--inputs` or changing directories is not a supported freshness workaround

### Requirement: Infrastructure revalidation blockers offer the real repair handoff
Update SHALL explain that `seed-verified` means local baseline verification, not an unfinished feature change. When recorded infrastructure requires reorganization, human and machine-readable output SHALL identify the repair command targeted to the same project, explain the ownership/approval boundary, and provide the subsequent update check. Ordinary update approval SHALL NOT authorize infrastructure repair.

#### Scenario: Legacy infrastructure blocks migrated activation
- **WHEN** activation history migration commits but local verification encounters a legacy layout
- **THEN** output states that migration committed while local baseline verification remains blocked
- **AND** it presents `liftoff repair` check for the selected project instead of manual manifest edits or an internal phase-mismatch message

#### Scenario: Explicit project outside current directory
- **WHEN** update targets another project
- **THEN** all repair and resume commands preserve that project selection with platform-correct quoting
