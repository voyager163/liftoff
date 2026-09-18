## MODIFIED Requirements

### Requirement: Update reconciles a generated project against a fresh render
The system SHALL provide `liftoff update` with its compatibility-first, preview-gated workflow for supported generated and adopted projects. It SHALL read developer-owned desired state, derive managed-core expectations from actual recorded workload/profile/component and integration identity, and reconcile exact managed logical names. Configuration-authorized create-only provisioning and supported manifest/activation migration or revalidation SHALL remain separate lanes. Classifications SHALL remain unchanged, new, missing, upgrade, conflict, moved, orphan, retired, or retired-conflict. Existing project-owned application files SHALL remain outside template comparison. Every write-capable plan SHALL require a matching prior check and exact approval. Check SHALL be project-read-only, disclose its external receipt, and exit 0 for no actionable work or 2 for actionable drift, migration, or revalidation.

#### Scenario: Clean project reports no drift
- **WHEN** project-owned files differ from current templates but core and manifest/activation migration or revalidation require no work
- **THEN** update exits 0 without approval or unnecessary project writes

#### Scenario: Check classifies drift without applying
- **WHEN** a managed-core template evolved and one managed-core file was edited
- **THEN** check lists untouched core changes as upgrades and the edited file as a conflict
- **AND** it exits 2 without project changes while disclosing any external receipt

#### Scenario: User modification is detected by hash
- **WHEN** a core file differs from its recorded content hash
- **THEN** update treats it as locally modified rather than a safe upgrade

#### Scenario: Project modification is outside update
- **WHEN** source, dependencies, schemas, containers, environments, documentation, or infrastructure differ from the current render
- **THEN** update does not classify those differences as template updates
- **AND** reading a file for migration validation does not grant replacement authority

#### Scenario: Moved artifact is detected by logical name
- **WHEN** a current core artifact has the same logical name and a different registered location
- **THEN** preview identifies the reviewed move and both portable paths

#### Scenario: Redirected update applies safe changes
- **WHEN** redirected update has actionable work, a matching receipt, and `--approve-plan` with the exact effective fingerprint
- **THEN** it applies only the approved safe scope without prompting after preconditions pass
- **AND** missing either prerequisite prevents new project writes

#### Scenario: Redirected check stays read-only
- **WHEN** check runs with redirected input or output
- **THEN** it requests no input, preserves project bytes, and uses the same compatibility and exit rules
- **AND** it discloses receipt persistence in the selected output format

#### Scenario: Check reports retired alias cleanup without mutation
- **WHEN** an older manifest records an exact retired setup alias
- **THEN** human and JSON previews identify its retired or protected retired-conflict state and exact path
- **AND** manifest and alias bytes remain unchanged

#### Scenario: An adopted project has a custom layout
- **WHEN** a schema-8 project records a supported adopted component outside fresh-starter paths
- **THEN** managed expectations use that actual approved identity and layout
- **AND** update does not synthesize a starter backend, move business files, or fabricate generation provenance

### Requirement: Apply failures are observable and recoverable
Update SHALL preflight the complete approved write set, treat only confirmed missing paths as absent, acquire the cooperating project lock, and recheck current preconditions before mutation. Storage, replacement, cleanup, manifest, lock, and recovery failures SHALL exit 1, name the failed operation, and report actual progress without claiming success. Recovery SHALL preserve supported modes, clean only exact registered temporaries, and restore only attributable unchanged transaction writes. Registered historical update/repair serializers and identities SHALL remain unchanged. Activation-migration recovery SHALL remain distinct from post-commit revalidation, whose incomplete outcome retains exit 2 and the actual linked successor as blocked/resumable rather than hard-coding an obsolete v2 execution target.

#### Scenario: Destination write fails
- **WHEN** a filesystem operation cannot write a planned artifact
- **THEN** output names its path and operation, exits 1 for the failed transaction, and does not claim manifest success

#### Scenario: Move cleanup fails
- **WHEN** verified old-path cleanup fails after destination creation
- **THEN** update reports failure and recovery rather than a completed move

#### Scenario: Preflight rejects every unsafe mutation before writes
- **WHEN** any destination fails boundary, collision, ownership, or effective-plan validation
- **THEN** no new update mutation starts

#### Scenario: Retry after a partial filesystem failure
- **WHEN** the filesystem issue is repaired
- **THEN** bounded recovery uses actual bytes and the original approved transaction record
- **AND** new work requires a current matching preview rather than manual manifest editing

#### Scenario: Retired alias transaction rolls back
- **WHEN** alias deletion succeeds but the transaction cannot commit its manifest
- **THEN** recovery restores attributable unchanged alias and manifest bytes and reports the outcome

#### Scenario: Cooperating writer lock blocks concurrent mutation
- **WHEN** another cooperating writer holds the project lock
- **THEN** update exits 1 before writing and identifies the concurrent operation

#### Scenario: Rollback preserves a concurrently changed destination
- **WHEN** a destination changes again before recovery can restore it
- **THEN** newer bytes are preserved and the exact path is reported for review

#### Scenario: Partial temporary files are cleaned up
- **WHEN** replacement temporaries remain after failure
- **THEN** recovery removes only safely identified registered transaction temporaries
- **AND** it never records them as managed artifacts or uses a prefix/glob cleanup

### Requirement: Update refuses unsafe reconciliations
Update SHALL reject configured workload kind or immutable workload/profile identity that differs from the normalized recorded identity without an explicitly supported reviewed transition. API-stack and GenAI-pattern conversion SHALL remain outside update; a fresh initialization remedy SHALL mean a separate target, never reinitializing an existing project. Retired `power-apps-code-app` identity SHALL fail before deeper artifact or activation access even with governance disabled. A newer recorded writer than the running CLI SHALL still block using SemVer-aware ordering, including prereleases. Schema-8 adopted profiles SHALL be validated as their actual form rather than forced into fabricated generated-workload fields.

#### Scenario: Workload-kind change is refused
- **WHEN** a generated project's desired type changes between GenAI and standard and update runs
- **THEN** update reports that the change requires separate reviewed migration or fresh-target initialization

#### Scenario: API-stack change is refused
- **WHEN** a standard project's configured API stack changes
- **THEN** update fails with the separate migration boundary rather than converting application code

#### Scenario: Pattern change is refused
- **WHEN** a GenAI project's configured pattern changes
- **THEN** update reports the required separate migration

#### Scenario: User-supplied starter source change is refused
- **WHEN** an existing Power Apps project's starter source is changed
- **THEN** the retired workload is rejected before source-identity interpretation or reconciliation

#### Scenario: Retired workload is refused before deeper access
- **WHEN** manifest or desired state names `power-apps-code-app`
- **THEN** update fails before artifact ownership, activation-state, or managed-path interpretation
- **AND** disabling governance does not make it updateable

#### Scenario: Legacy identity is compared after normalization
- **WHEN** a legacy manifest omits type and API stack but records the matching GenAI pattern
- **THEN** update uses GenAI with Python/FastAPI and continues normal compatibility-gated reconciliation

#### Scenario: Newer-generated project is refused
- **WHEN** recorded `liftoffVersion` is greater than the running CLI
- **THEN** update reports that the CLI must be upgraded first without changing the project

#### Scenario: Adopted profile selection changes frameworks
- **WHEN** a desired adopted profile implies an unregistered framework or component conversion
- **THEN** update reports the exact unsupported transition before metadata or file writes
- **AND** a profile name or matching hash does not authorize conversion

### Requirement: Apply rewrites the manifest as scoped recorded state
After an eligible approved transaction, current update SHALL write manifest 8 with the exact CLI writer, validated profile/component identity, hashes only for written or identically adopted core entries, eligible retired aliases removed, and preserved generated/adopted/repaired project provenance. Skipped conflicts SHALL retain old hashes. A source v2-v7 manifest SHALL require its declared reviewed schema transition. Activation identity SHALL change only with an explicitly approved linked successor and preserved source metadata; post-commit revalidation failure SHALL not roll back that manifest or bless custom bytes as generated state.

#### Scenario: Manifest catches up after core update
- **WHEN** an approved core transaction commits
- **THEN** manifest hashes match actual written or adopted core files
- **AND** original project provenance and truthful profile facts are preserved

#### Scenario: Skipped core conflict stays visible
- **WHEN** a later check inspects a skipped core conflict
- **THEN** the old recorded hash still exposes it

#### Scenario: Project file changed after generation
- **WHEN** a project-owned file changes or disappears
- **THEN** its original generation or adoption provenance remains unchanged and confers no replacement authority

#### Scenario: Retired alias is not preserved in the next manifest
- **WHEN** an exact eligible alias is successfully retired
- **THEN** its entry is removed and the clean migrated inventory has no corresponding alias drift

### Requirement: Update offers versioned machine-readable output
Update SHALL retain schema-3 JSON with `scope: "project-update"`, mode, stable status/reason codes, fingerprints, receipt/approval disposition, and separate managed-core, provisioning, manifest/activation migration, and revalidation outcomes. Exact retired aliases, conflicts, ownership changes, source/target identity, and preserved provenance SHALL remain observable. Structured continuations SHALL use the independent schema-1 public context contract without changing stored receipts or the meaning of existing schema-3 fields. JSON SHALL not authorize apply or prompt for consent; stdout SHALL contain one result and diagnostics/progress SHALL use stderr.

#### Scenario: JSON apply result
- **WHEN** a matching explicitly approved plan applies with `--json`
- **THEN** stdout contains one schema-3 result with actual commit, written/removed/skipped entries, provisioning, and readiness outcomes

#### Scenario: JSON drift report
- **WHEN** check finds actionable work with JSON
- **THEN** it emits the same semantic preview and fingerprints as human mode
- **AND** it exits 2 without project changes and discloses the external receipt outcome

#### Scenario: JSON does not imply consent
- **WHEN** `liftoff update --json` lacks a matching preview or exact-plan approval
- **THEN** it reports the specific blocked reason and exits 1 without prompting or writing

#### Scenario: Local migration committed but revalidation is blocked
- **WHEN** apply commits migration but revalidation remains incomplete
- **THEN** the schema-3 result distinguishes commit from readiness, identifies a context-bound next action, and exits 2

### Requirement: Update migrates supported manifests without production mutation
Update SHALL interpret supported v2-v7 manifests through their registered source contracts and perform ownership normalization in memory before reconciliation. Only an eligible reviewed transaction SHALL write schema 8. Check SHALL preserve the source manifest byte-for-byte. Successful migration SHALL retain exact managed hashes, release non-core legacy entries to project provenance, preserve recorded generation/adoption/repair history and framework uncertainty, and explicitly retain unknown original profile facts. Modified or absent files SHALL not lose provenance. Manifest migration SHALL not write, restore, move, or delete project-owned files.

#### Scenario: Check a legacy project
- **WHEN** `liftoff update --check` reads a supported historical manifest
- **THEN** it reports pending schema/ownership migration and applicable managed-core drift
- **AND** every manifest and project file remains unchanged

#### Scenario: Migrate intentionally deleted infrastructure
- **WHEN** a historical manifest records generated infrastructure that is now absent and migration is approved
- **THEN** update records preserved project provenance without recreating the path

#### Scenario: Migrate production source
- **WHEN** a legacy manifest records source now containing production behavior and migration is approved
- **THEN** update releases the entry from broad legacy authority without changing the file or inventing generation facts

#### Scenario: Preserve legacy framework uncertainty
- **WHEN** a historical manifest lacks official framework metadata
- **THEN** schema 8 preserves legacy framework state without fabricating selected-agent integrations

### Requirement: Existing projects adopt managed-core governance artifacts automatically
For supported initialized projects whose configuration omits `governanceProfile`, update SHALL continue selecting `single-maintainer-gitflow` and its exact applicable handoff artifacts as desired-state defaults. Automatic selection SHALL not authorize writes or perform the new in-place `adopt` operation. Applying the handoff and any required schema-8 transition SHALL use the existing matching preview and exact approval. Developer-owned configuration SHALL not be rewritten to materialize its default.

#### Scenario: Adopt into an untouched v4 project
- **WHEN** a matching approved eligible plan adds governance to a valid v4 project with absent destinations
- **THEN** the named handoff and v8 manifest commit transactionally without invoking an agent or contacting GitHub

#### Scenario: Preview automatic adoption
- **WHEN** the user checks before managed handoff adoption
- **THEN** applicable governance entries appear as new named artifacts and check exits 2 without project writes

#### Scenario: Existing setup destination has different bytes
- **WHEN** an unrecorded destination differs from the render
- **THEN** the approved normal plan preserves it and records partial handoff without ownership

#### Scenario: Resolve a partial handoff
- **WHEN** a new approved plan finds previous unowned conflicts absent or byte-identical
- **THEN** it writes or adopts only eligible exact handoff files and records complete handoff

#### Scenario: Existing setup destination already matches
- **WHEN** an approved managed handoff adoption finds byte-identical unrecorded content
- **THEN** it records only the exact approved destination without rewriting it

### Requirement: Governance opt-out preserves user-owned files
When an eligible configuration transition explicitly selects `none`, update SHALL stop rendering that profile's handoff artifacts. Recorded governance files SHALL retain the orphan contract and SHALL not be deleted automatically; active/archived changes and agent-authored governance implementation SHALL remain outside reconciliation. Existing activation state SHALL still require the separate supported deactivation/reconciliation boundary. A successful eligible schema-8 write SHALL not imply live enforcement was removed.

#### Scenario: Disable the generated profile
- **WHEN** `governanceProfile` changes to `none` in a project eligible for local opt-out and reviewed update succeeds
- **THEN** prior handoff artifacts are reported as orphans and left on disk
- **AND** the v8 manifest records the local profile as disabled without claiming remote deactivation

#### Scenario: Archive the agent-created change
- **WHEN** a developer archives or removes the post-Phase-0 governance change
- **THEN** update reports no drift for it and does not recreate it from managed policy

### Requirement: Update applies the activation compatibility matrix
Update SHALL use the exact release-owned compatibility matrix, not version ordering. Current execution SHALL bind manifest 8, policy 8, activation contract/state/evidence-header/approval-envelope 4, graph schema 3 with its computed hash and phase digests, credential-policy schema 2, and unchanged supersession schema 1. Compatibility metadata 5 SHALL separately declare historical readers, current execution, and exact approved migration/revalidation lanes, including the exact pre-amendment policy-7/credential-policy-schema-1 candidate. Historical metadata schemas 2, 3, and 4 SHALL remain readable only where explicitly registered with their original tuple and digest semantics, not as new authorization. Repair contract 1 and unchanged schema-2 records SHALL remain independently registered.

#### Scenario: Historical activation state is supported
- **WHEN** a complete historical source matches a declared migration lane
- **THEN** check reports the entire source/target plan
- **AND** apply creates its successor only after matching receipt, approval, and complete preflight

#### Scenario: Historical v1 activation history is diagnostic-only
- **WHEN** an exact declared lane permits transition from v1 to current activation
- **THEN** original state and evidence remain diagnostic-only in preserved history
- **AND** fresh target-contract proof, rather than rewritten old proof, is required for execution

#### Scenario: Activation identity is from the future
- **WHEN** a contract, schema, or graph identity is unsupported
- **THEN** update and setup report the exact incompatibility and preserve bytes without downgrade

#### Scenario: Policy and activation contract are incompatible
- **WHEN** their complete tuple is absent from the matrix
- **THEN** no phase advances and force cannot authorize the combination

#### Scenario: Managed update encounters the prior credential policy
- **WHEN** the project retains the pre-amendment policy-7 identity or schema-1 credential policy
- **THEN** check distinguishes ordinary managed drift from the exact separately reviewed identity/policy transition
- **AND** update consent does not authorize broader credential use, retag prior approval or replace an unowned policy

### Requirement: Every effective update plan needs current exact approval
Before new writes, update SHALL rebuild the plan from authoritative current inputs, match a valid external preview for its exact mode, obtain explicit approval, and recheck relevant preconditions under the project lock. Genuine interactive approval SHALL display the immutable plan and default to No without manual fingerprint entry. JSON/noninteractive approval SHALL require the full fingerprint through `--approve-plan` and all applicable independent permissions. Force, generic Yes, cached operations, a project-local approval claim, or an unrelated check SHALL not bypass these gates.

#### Scenario: The user did not run check
- **WHEN** actionable apply has no matching receipt
- **THEN** it exits 1 without new writes and directs the user to `liftoff update --check`

#### Scenario: The preview is stale
- **WHEN** source, target, mode, protected input, destination, configuration binding, or validation operation differs
- **THEN** apply rejects the stale receipt/approval and requires a fresh check

#### Scenario: The user declines
- **WHEN** interactive approval is declined or cancelled
- **THEN** apply performs no project mutation and does not report success

#### Scenario: Automation approves the precise plan
- **WHEN** a valid receipt and full matching `--approve-plan` fingerprint are supplied
- **THEN** the selected plan can apply without prompting after its current preconditions pass

#### Scenario: Inputs change while approval is displayed
- **WHEN** project inputs change before the approved invocation acquires its write lock
- **THEN** locked revalidation prevents mutation under the earlier approval

#### Scenario: A root-level project script changes
- **WHEN** a reviewed validation script outside the activation-input allowlist changes after preview or during approval
- **THEN** the retained-source binding invalidates the fingerprint before the changed script can execute
- **AND** names such as build or dist do not exempt existing script inputs

#### Scenario: An approved command writes generated outputs
- **WHEN** an approved command changes files only within explicitly declared generated-output scope
- **THEN** the guard accepts those outputs after that command and protects them before subsequent commands
- **AND** unrelated source edits are preserved and block continuation

#### Scenario: A completed plan is replayed
- **WHEN** an old receipt or approval is reused after its transaction committed
- **THEN** changed source preconditions prevent replay of that migration or write set

#### Scenario: An approved interrupted transaction needs recovery
- **WHEN** a durable journal identifies an incomplete already-approved transaction
- **THEN** recovery handles only its exact attributable effects under recorded authority
- **AND** it stops before new work, which requires a current preview and approval

#### Scenario: A project-local journal falsely claims approval
- **WHEN** a recovery journal lacks a matching separately persisted user-local approval for its finalized mutation digest
- **THEN** recovery refuses project mutation
- **AND** a preview receipt or project-local approval claim does not substitute for consent

### Requirement: Guidance changes preserve durable update identities and machine contracts
Context-sensitive display SHALL remain presentation-only: equivalent canonical targets and effective inputs SHALL keep the same receipt keys, fingerprints, and approval requirements. Update SHALL retain JSON schema 3, canonical `projectRoot`, established fields, status/reason codes, and exit semantics; shared structured continuations SHALL preserve these meanings and SHALL NOT cause historical receipt rewriting. JSON remedies and callers without trusted invocation context SHALL retain explicit target, working directory, scope, and configuration binding. Diagnostic wording SHALL explain actual failures without changing machine-readable identity.

#### Scenario: Implicit and explicit invocations share the same reviewed plan
- **WHEN** check and apply select the same unchanged project and inputs through implicit and explicit paths
- **THEN** the same matching preview and exact effective-plan approval apply
- **AND** display differences do not invalidate or authorize the plan

#### Scenario: A JSON missing-preview failure stays actionable outside the original shell
- **WHEN** JSON reports a missing preview
- **THEN** it retains schema 3, canonical `projectRoot`, and `preview-missing`
- **AND** its remedy explicitly targets the project with the correct working directory and configuration reference without inventing a storage failure

#### Scenario: Safety gates are not relaxed by shorter commands
- **WHEN** a human follow-up omits a redundant target
- **THEN** receipt, approval, ownership, compatibility, and recovery guards remain unchanged
- **AND** neither displaying nor running an unapproved follow-up silently grants approval

### Requirement: Managed-context expectations use active recorded layout
Update, repair preview, doctor, and assessment SHALL use the same installed-release expectation for the active manifest, explicit profile/component identity, and recorded or approved adopted layout. Context SHALL not assume a fresh independent infrastructure or application layout for legacy, unknown, or adopted projects. Historical repair/adoption snapshots SHALL not replace the active target, and uncertainty SHALL remain visible rather than fabricating component generation or conformance.

#### Scenario: Legacy context matches the installed contract
- **WHEN** context correctly describes the active legacy layout under the compatible installed expectation
- **THEN** all managed comparisons agree it matches
- **AND** the infrastructure migration requirement remains a separate finding

#### Scenario: Repaired context matches independent roots
- **WHEN** an approved repair commits independent active inventory and corresponding context
- **THEN** update compares against current inventory while preserving retained legacy history

#### Scenario: Context bytes are actually modified
- **WHEN** context differs from the shared expected render
- **THEN** managed-core conflict/hash rules remain enforced rather than normalizing away genuine changes

#### Scenario: An adopted component does not have starter paths
- **WHEN** current adopted provenance identifies supported custom component roots
- **THEN** all consumers use the same truthful active mapping
- **AND** a fresh template's paths do not become assumed current ownership or repair completion

### Requirement: Activation-contract upgrade is separate from infrastructure execution
Reviewed update SHALL identify the exact historical source and current activation successor and preserve original records before changing active identity. Its approval SHALL authorize only inventoried local migration and finite declared revalidation, not live state movement, Git publication, credential enrollment, repository controls, or deployment. Current activation and stateful execution SHALL require separate current plans and authority. A historical publication affected by the old input projection SHALL retain its original digest semantics and require independently authorized linked readback/revalidation without redundant publication solely to repair metadata.

#### Scenario: A v2 project needs the revised execution contract
- **WHEN** the exact source is supported by a declared successor lane
- **THEN** preview identifies the target contract, preserved history, and fresh-proof work
- **AND** no version field is manually retagged to bypass compatibility

#### Scenario: A successor has been created
- **WHEN** local identity migration commits
- **THEN** the successor can be inspected and planned under its declared current contract
- **AND** that result does not execute cloud or stateful stages

#### Scenario: Schema-3 publication needs current proof
- **WHEN** reviewed migration encounters the supported historical Azure-input publication mismatch
- **THEN** it preserves old plans, approvals, receipts, source commit/ref identity, and history and identifies the separate bound revalidation action
- **AND** it does not push, recommit, reinterpret old hashes, or claim that later local edits are already remote

## ADDED Requirements

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
