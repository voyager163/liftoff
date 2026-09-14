# liftoff-project-repair Specification

## Purpose
Provide reviewed local and stateful infrastructure repairs and coding-agent integration changes, with explicit authority, protected state handling, verified cutover, and recoverable progress.

## Requirements

### Requirement: Repair previews identify concrete project-bound actions
Liftoff SHALL provide project-aware previews for registered local infrastructure, stateful migration, and additive agent-integration lanes. A preview SHALL identify source/target conditions, exact file/backend/resource-address scope, executable versus blocked work, prerequisites, permissions, preservation and recovery constraints, and supported next actions. Ordinary preview SHALL preserve project bytes and state, disclose external receipts/staging, and perform no provider or sensitive-state access without the corresponding explicit scope. Preview SHALL not install tools, mutate state/resources, or fabricate activation evidence.

#### Scenario: Preview a legacy local layout
- **WHEN** a supported project records legacy infrastructure and the developer requests a repair check
- **THEN** the report identifies the current layout and proposed independent-root changes rather than prescribing manual folder or manifest edits
- **AND** eligibility and any missing discovery are explicit before application is offered

#### Scenario: Explicit project path is authoritative
- **WHEN** repair is invoked for an explicit project from another directory
- **THEN** inspection, receipts, commands, and proposed writes all bind that exact resolved project
- **AND** the caller's directory is not reinitialized or selected as a fallback

#### Scenario: Preview requires official integration rendering
- **WHEN** a concrete agent-integration diff requires the pinned framework initializer
- **THEN** only the registered operation runs in isolated staging
- **AND** the project, real user configuration, and unrelated skills remain unchanged

### Requirement: Repair application requires the exact current plan
Repair execution SHALL require a current external preview and explicit approval of its fingerprint. The plan SHALL bind project identity and boundary, protected input digests, CLI and recipe identity, desired agent selection, eligibility observations, and the exact executable operation set. Formatting, force, a general confirmation, or an old approval SHALL not expand that scope. An apply invocation SHALL not change the preview's requested agents, default, or discovery scope.

#### Scenario: Apply the reviewed plan
- **WHEN** a current executable repair plan is explicitly approved
- **THEN** only its listed operations can execute after current preconditions are rechecked
- **AND** the result names the committed scope separately from remaining work

#### Scenario: Local development changes a protected file
- **WHEN** a source, manifest, configuration, or framework file changes after preview
- **THEN** application refuses the stale plan before project mutation and requests a new preview
- **AND** it does not overwrite the developer's newer work

#### Scenario: Approval targets another project
- **WHEN** an approval or receipt belongs to a different canonical project boundary
- **THEN** repair rejects it without creating a receipt, history, or project file in the selected project

### Requirement: Infrastructure execution requires lane-specific eligibility
Repair SHALL classify observed scope as `verified-undeployed`, `stateful`, or `unknown`, independently from execution eligibility. Local layout repair SHALL require verified undeployed scope. Stateful execution SHALL require a supported backend/recipe, complete mappings, approved sensitive inspection, verified backups, current concurrency/precondition checks, and explicit state-write approval. Unknown state, incomplete mappings, unsupported behavior, or a general approval alone SHALL not make a lane executable.

#### Scenario: Complete scoped absence is independently observed
- **WHEN** every relevant state location and resource binding has current authoritative negative observations and the transformation is supported
- **THEN** the candidate can be marked `verified-undeployed`
- **AND** execution still requires exact plan approval and an apply-time eligibility recheck

#### Scenario: No local state file exists
- **WHEN** the project has no visible local state file but remote state or resource existence is unobserved
- **THEN** the candidate remains `unknown` and its infrastructure operations remain plan-only

#### Scenario: Existing state or resources are found
- **WHEN** current observations establish active state or deployed resources in the repair scope
- **THEN** the candidate is `stateful` and includes a migration plan
- **AND** supported execution is offered only after all stateful safeguards and the separate authorization are satisfied

#### Scenario: State appears after preview
- **WHEN** the approved scope becomes stateful or cannot be completely re-observed immediately before mutation
- **THEN** its infrastructure writes are rejected
- **AND** prior approval is not treated as evidence that the scope is still undeployed

### Requirement: Repair discovery separates metadata from sensitive state inspection
Live metadata discovery SHALL require explicit live scope and existing permissions. Sensitive state access SHALL additionally require an exact approved state-read scope and a protected execution workspace. Public reports and repository receipts SHALL remain payload-free. Neither kind of preview SHALL authorize authentication changes, enrollment, provider registration, grants, backend initialization, state writes, or resource mutation. Incomplete scope, denied reads, unsafe paths, and unsupported bindings SHALL remain blocked.

#### Scenario: Live discovery is not requested
- **WHEN** ordinary repair check encounters an unresolved remote backend or resource binding
- **THEN** it identifies the exact missing discovery and performs no provider request

#### Scenario: Provider access is denied
- **WHEN** an explicitly requested metadata read is denied or incomplete
- **THEN** the report identifies the observation limitation
- **AND** it does not treat inaccessible state or resources as absent

#### Scenario: Discovery succeeds
- **WHEN** allowed metadata observations complete for the approved scope
- **THEN** the preview records their scope, provenance, input binding, and freshness without raw sensitive payloads
- **AND** those observations do not complete Phase 0 or any enforcement phase

#### Scenario: State contents are needed to establish address mappings
- **WHEN** metadata cannot establish the required source/destination mapping
- **THEN** the CLI presents the exact sensitive state-read scope for separate approval
- **AND** only approved contents are inspected privately, never streamed to chat, stdout, or repository artifacts

### Requirement: Infrastructure repair preserves supported project semantics
Executable infrastructure repair SHALL operate on an explicit reviewed file inventory and preserve resource, data, variable, provider, environment, and customization semantics within its supported transformation. It SHALL produce the complete registered independent-root layout with real shared-module references, applicable provider locks, outputs, and backend guidance. It SHALL not copy a fresh application tree over the project, infer ownership from directory patterns, perform unrelated dependency upgrades, or substitute template resources for customized source.

#### Scenario: Repair the recorded flat-root layout
- **WHEN** a supported flat-root source is verified undeployed and its repair is approved
- **THEN** the complete selected-environment and shared-module inventory is created or transformed
- **AND** unrelated application, database, container, and environment content is preserved

#### Scenario: Repair a recognizable partial migration
- **WHEN** the developer has already moved files or copied identical resource bodies into module and environment directories
- **THEN** the plan describes the actual remaining transformation and preserves verified customizations
- **AND** copied folders alone are not accepted as a completed module-based migration

#### Scenario: Preservation cannot be established
- **WHEN** source constructs, duplicate definitions, provider semantics, or missing inputs make the transformation ambiguous
- **THEN** the CLI produces a concrete plan-only result describing the unresolved issue
- **AND** it does not guess a replacement resource configuration or invoke force

### Requirement: Agent repair is additive and framework-owned
Repair SHALL support adding registered agents to an existing supported framework through its pinned official integration operations. It SHALL preserve existing integrations and the Spec Kit default unless an explicit approved default change selects an agent in the resulting set. It SHALL update only the reviewed agent/default desired-state fields and corresponding validated framework, manifest, and Liftoff integration artifacts. Agent removal, framework switching, and metadata-only claims of installation SHALL not be executed by this lane.

#### Scenario: Add Codex to an existing project
- **WHEN** a developer previews and approves adding Codex to an OpenSpec or Spec Kit project
- **THEN** official native Codex integration files and the corresponding Liftoff setup/assessment skills are installed
- **AND** existing Copilot or Claude integrations and unrelated project files are preserved

#### Scenario: Choose Codex as Spec Kit default
- **WHEN** an explicit approved default change selects installed or newly added Codex
- **THEN** the official framework changes its default without uninstalling the other selected integrations
- **AND** manifest and desired state agree with observed framework state

#### Scenario: Stateful infrastructure is unrelated to agent addition
- **WHEN** an agent addition is eligible but an infrastructure candidate is plan-only
- **THEN** the reviewed executable set can contain only the independent agent addition
- **AND** the result keeps the excluded infrastructure work and incomplete local readiness visible

#### Scenario: Agent-only repair completes while other local work remains
- **WHEN** an explicitly requested agent repair commits and its scoped integration verification succeeds
- **THEN** the repair can report its requested scope complete without claiming all local setup complete
- **AND** unrelated infrastructure repair is not silently added to that approval

#### Scenario: A requested agent is recorded but its integration is missing
- **WHEN** an additive request names an already selected agent whose known native integration files are absent
- **THEN** the preview includes the actual official integration repair instead of declaring no action solely because the agent list is unchanged
- **AND** unknown framework contracts and missing project-owned bootstrap seeds are not silently adopted or generated

### Requirement: Repair supersedes active provenance while preserving history
A committed repair SHALL preserve the original manifest and exact affected provenance in its registered history before publishing the repaired active inventory. New or transformed entries SHALL identify actual repaired bytes and their producer; unchanged entries SHALL retain their provenance. Repair history SHALL bind the approved plan and source/target inventories, remain outside managed-core template authority, and never substitute for fresh local or live evidence.

#### Scenario: Supersede retired flat-root entries
- **WHEN** an approved infrastructure repair commits
- **THEN** current inventory describes the actual independent roots while the original names, paths, and generation hashes remain in history
- **AND** historical entries no longer force the active layout to remain legacy

#### Scenario: Ordinary update follows repair
- **WHEN** managed-core update runs after a repair
- **THEN** it preserves repair history and project provenance
- **AND** it does not recreate retired flat-root files or acquire ownership of repaired project files

#### Scenario: Inputs changed by repair invalidate old proof
- **WHEN** a repair changes inputs bound by local phase evidence
- **THEN** fresh local verification is required
- **AND** the old evidence is not retagged, edited, or presented as proof of the new layout

### Requirement: Repair commits and recovery are observable
Local project repair SHALL use a bounded recoverable filesystem transaction. Stateful repair SHALL coordinate local files with backend checkpoints and SHALL not claim atomic rollback across backends. A failure after external effects SHALL retain the actual checkpoint and protected recovery material, re-observe current state, and offer verified compensation or forward recovery. Verification failure SHALL not cause blind restoration of old state or provenance.

#### Scenario: A write fails before commit
- **WHEN** a repair transaction cannot complete its reviewed write set
- **THEN** original planned files and provenance are restored where safely possible
- **AND** any incomplete rollback is reported with exact remaining recovery work

#### Scenario: Verification fails after commit
- **WHEN** files and provenance commit but an applicable local check fails
- **THEN** the command reports committed repair with incomplete verification
- **AND** a new preview can resume remaining local work without reapplying the completed transformation

#### Scenario: An interrupted journal exists
- **WHEN** a new repair encounters an unfinished transaction
- **THEN** it reports bounded recovery before new writes
- **AND** it does not reset the project or silently discard the journal

### Requirement: Repair retains independent machine and activation permissions
Approval of local project-file repair SHALL not authorize machine-tool installation, dependencies, global profiles, Git publication, credential enrollment, or state/resource mutation. Stateful migration SHALL have its own exact backend/configuration authority, and a state-only approval SHALL not authorize resource creation, replacement, or destruction. Prerequisite and activation permissions SHALL remain separate, and their outcomes SHALL not be hidden behind a local rollback claim.

#### Scenario: A required tool is missing
- **WHEN** an approved project repair needs an unavailable tool and installation was not separately authorized
- **THEN** the tool-dependent operation remains blocked with a causal remedy
- **AND** the repair approval is not reused as machine-install consent

#### Scenario: Governance is disabled
- **WHEN** repair is performed on a supported project whose governance profile is `none`
- **THEN** the repair does not enable governance or create activation evidence
- **AND** project/framework validation remains distinct from activation

### Requirement: Repair records and paths are confined and portable
Repair SHALL register every generated record role, affected artifact, backend binding, and dynamic record path explicitly. Local paths SHALL use portable parts and native Windows/macOS/Linux resolution. Unapproved traversal, external paths, symlinks/junctions, case aliases, or unlisted files SHALL not acquire authority. Sensitive state/backups/plans SHALL use private protected storage outside repository history and ordinary workflow artifacts; public output SHALL contain only allowlisted metadata and opaque references.

#### Scenario: Repair on Windows from a path containing spaces
- **WHEN** the project and tool paths contain spaces on Windows
- **THEN** commands receive separate arguments and explicit working directories
- **AND** the same approved logical inventory and confinement rules apply as on macOS and Linux

#### Scenario: A destination is a junction or case alias
- **WHEN** a proposed destination escapes its boundary or collides under supported platform path semantics
- **THEN** repair rejects it before writes regardless of approval

#### Scenario: A custom neighboring skill exists
- **WHEN** a user-authored skill shares a parent directory with a generated integration
- **THEN** the skill remains outside the approved file inventory and unchanged

### Requirement: Repair results distinguish clean changed and incomplete scope
Repair JSON SHALL use numeric `schemaVersion: 2` and distinguish operation kind, requested scope, authority, local/backend checkpoints, verification, recovery, repair/recipe identities, capabilities and actual structured next actions. `repairScopeComplete` SHALL remain distinct from setup, application-wide or activation completion. Exit 0 SHALL mean clean or verified complete requested scope; exit 1 SHALL identify rejected/error execution before progress; exit 2 SHALL identify differences, blocked plans, or persisted effects with incomplete verification/recovery. Actual partial effects SHALL remain visible regardless of failure.

#### Scenario: Only stateful migration planning is available
- **WHEN** a stateful candidate lacks a required mapping, supported primitive, or safeguard
- **THEN** it returns exit 2 and explicitly labels the lane plan-only
- **AND** approval cannot override the missing prerequisite

#### Scenario: Repair is already current
- **WHEN** requested repair scope has no differences and valid current local verification
- **THEN** it reports no action needed without rewriting files or creating fake progress

#### Scenario: Post-commit inspection cannot complete
- **WHEN** project repair committed but current readiness cannot be read reliably
- **THEN** it returns an explicit partial result with indeterminate readiness
- **AND** it retains the successful commit information instead of guessing the next phase

### Requirement: Supported stateful recipes preserve every resource binding
Liftoff SHALL implement supported same-backend module/address refactoring, backend relocation, and shared-state partitioning into explicitly mapped independent environment states for its declared local/Azure Blob backend combinations. Every managed instance SHALL have one verified destination or explicit preserved source disposition. A recipe SHALL preserve live resource identity and reject unapproved resource create/update/delete/replace effects.

#### Scenario: Refactor a resource into a shared module
- **WHEN** the approved supported recipe changes only its state/configuration address
- **THEN** the same live resource identity is retained and the new address is independently verified
- **AND** replacement is not accepted as a successful migration

#### Scenario: Partition state across environment roots
- **WHEN** a complete approved mapping assigns source instances to independent destination states
- **THEN** each instance has exactly one accounted-for final ownership location
- **AND** ambiguous, missing, or duplicate mappings block execution

#### Scenario: A plan introduces a resource replacement
- **WHEN** protected planning reveals a replacement or other resource mutation outside the approved state-only scope
- **THEN** migration refuses that plan and identifies the separately required resource-change authorization

### Requirement: Stateful migration protects snapshots and concurrent writers
Before mutation, stateful migration SHALL verify source/destination identities, current lineage/serial/version or equivalent guards, required locks, known-writer coordination, and recoverable protected backups. It SHALL use supported native/backend concurrency and state transformation primitives rather than hand-editing state JSON or forcing past failed checks. Destination state SHALL be verified before source retirement.

#### Scenario: State changes after approval
- **WHEN** a backend version, lineage, serial, digest, or lock no longer matches the reviewed precondition
- **THEN** the migration stops before the affected write and requires a reconciled plan
- **AND** a force flag cannot authorize overwriting the new state

#### Scenario: A backup or lock cannot be verified
- **WHEN** required recovery material, backend locking, or execution-path access is unavailable
- **THEN** no stateful mutation begins

#### Scenario: Sensitive state is inspected
- **WHEN** approved state data or saved plans contain credentials or sensitive values
- **THEN** raw data stays in the protected workspace and approved secret/state stores
- **AND** logs, chat, repository history, ordinary Actions artifacts, and repository secrets do not become state-transfer channels

### Requirement: Stateful cutover and recovery are checkpointed
Migration SHALL record durable checkpoints for external writes, verification, source disposition, configuration cutover, and recovery. Completion SHALL require verified destination ownership, source accounting, correct backend access/locking, coordinated configuration, and the expected post-migration no-change result. A partially completed migration SHALL remain recoverable rather than be mislabeled atomic or complete.

#### Scenario: One destination write succeeds before failure
- **WHEN** execution stops after a subset of backend changes
- **THEN** the result identifies the completed and pending effects and preserves protected recovery references
- **AND** resume observes those effects before choosing a compensating or forward action

#### Scenario: Recovery encounters a newer backend state
- **WHEN** an old backup no longer matches the current recovery preconditions
- **THEN** recovery refuses blind restoration and presents the reconciliation needed

#### Scenario: Cutover is verified
- **WHEN** state, configuration, resource identities, writer destinations, and no-change verification all agree
- **THEN** current provenance is published at the verified cutover boundary and relevant setup work can resume
- **AND** retained recovery material remains separately tracked

#### Scenario: A Windows execution host resumes migration
- **WHEN** a migration uses a supported Windows host with paths containing spaces
- **THEN** native path/shim handling, private storage access, and exact recorded identities preserve the same safety contract
- **AND** an incompatible host or inaccessible protected snapshot cannot be bypassed with path rewriting

### Requirement: Public local infrastructure repair has an executable bounded recipe
The CLI SHALL expose a local infrastructure repair lane for supported recorded Azure flat-root projects, distinct from protected stateful execution. It SHALL inspect real configuration, produce the selected independent environment roots and shared application module, and preserve supported source semantics without replacing application code. Writes and retirements SHALL use explicit registered artifact identities. Unsupported constructs or conflicting partial migrations SHALL produce specific plan-only blockers.

#### Scenario: Approved undeployed legacy project
- **WHEN** supported legacy source has complete authoritative undeployed observations and its exact repair is approved
- **THEN** the CLI reorganizes the source into the shared module and selected environment roots, validates the candidate, and records actual current provenance
- **AND** unrelated files and historical activation evidence remain unchanged

#### Scenario: Supported customization and partial move
- **WHEN** source bodies have supported custom values or an equivalent file was already moved into the target layout
- **THEN** repair preserves those semantics and describes only the remaining exact transformation
- **AND** different competing bodies are not overwritten or silently deduplicated

#### Scenario: Additional active configuration
- **WHEN** an uninventoried active OpenTofu file, external module, unresolved provider scope or path-dependent construct exists
- **THEN** the CLI identifies the unsupported scope and does not execute a partial destructive reorganization

### Requirement: Public undeployed checks require bounded explicit metadata authority
An ordinary local repair preview SHALL make no cloud requests or state reads. Live absence checks SHALL require an explicitly selected subscription and existing authentication, use bounded commands, and establish all supported resource/backend bindings. Apply SHALL repeat observations before mutations. State absence on disk, user assertion, access failure, or a newer manifest alone SHALL NOT establish undeployed eligibility.

#### Scenario: Preview without live authority
- **WHEN** a legacy project has no visible state and repair check has no live scope
- **THEN** it remains unknown and reports the exact supported live check as the next action

#### Scenario: Existing group or state
- **WHEN** metadata discovers a relevant resource group or local state
- **THEN** local transformation is blocked and the report distinguishes required protected stateful migration from local file repair
- **AND** no sensitive state is read and no unimplemented execution command is offered

#### Scenario: Denied or timed out observation
- **WHEN** a metadata probe fails, exceeds its deadline, or returns an invalid result
- **THEN** observation is incomplete, the failure is reported, and no project writes occur

### Requirement: Local repair approval and recovery bind exact project effects
Repair SHALL use a distinct expiring external preview, explicit fingerprint approval, a bounded recoverable transaction, and immutable original provenance. Changed source/destination files, subscription scope, tool/recipe identity or plan effects SHALL invalidate approval. Update and repair SHALL reject overlapping unfinished transactions. Post-commit results SHALL distinguish repaired infrastructure from incomplete local governance.

#### Scenario: Preview then edit
- **WHEN** any inventoried source or target changes between check and application
- **THEN** application rejects the stale preview without overwriting the edit

#### Scenario: Interrupted write recovery
- **WHEN** an approved repair transaction is interrupted
- **THEN** repair exposes explicit recovery of its recorded operations and refuses new writes until recovery is resolved
- **AND** concurrent edits are preserved and incomplete rollback is reported

#### Scenario: Windows paths and unsafe destinations
- **WHEN** a project path contains spaces on Windows
- **THEN** commands use separate arguments and the exact canonical project boundary
- **AND** symlinks, junctions and case-colliding destinations cannot gain write authority

#### Scenario: Repaired project is checked again
- **WHEN** repaired current inventory and its required validation are complete
- **THEN** repair does not repeat the transformation or rewrite original provenance
- **AND** it does not claim cloud activation complete

### Requirement: Repair identity is independent and approval-bound
Liftoff SHALL publish a `repairContractVersion`, distinct repair/preparation recipe IDs and versions, supported source/target layout identities, and per-document schema versions. New approval previews SHALL bind those identities, the running CLI, exact protected source/destination and staged bytes/modes, directory inventory, scope, verification/preparation policy, package sources, resolved installed tool/interpreter identities and requirements, and expiry. Unknown identities and changes to any approved binding SHALL reject execution rather than infer numeric compatibility. Repair identities SHALL NOT silently modify policy, manifest or activation version vectors.

#### Scenario: Recipe or contract changes after review
- **WHEN** an application attempts to use a preview from another repair contract, recipe version, target inventory or CLI implementation
- **THEN** it rejects the approval before writes and offers a new same-project preview
- **AND** it leaves historical records unchanged

#### Scenario: An old preview remains in external storage
- **WHEN** a schema-1 preview is presented to the current schema-2 execution interface
- **THEN** it cannot authorize a new repair
- **AND** the error distinguishes expired or unsupported approval from missing project conformance

### Requirement: Interactive consent preserves exact-plan authority
Repair SHALL accept a genuine interactive default-No approval of the displayed immutable plan without manual fingerprint entry. The internal fingerprint and external receipt SHALL remain authoritative, with the same freshness, scope, recipe, input and lock checks as optional exact automation flags. Each action-specific consent SHALL precede its own effects; all required preparation, code/lifecycle and declared network consents SHALL precede preparation/check execution, and file-transaction consent SHALL follow the visible current verification result. A generic repair request, unrelated approval, autopilot mode, agent-generated Yes or piped input SHALL NOT substitute for the required consent.

#### Scenario: An interactive plan is approved
- **WHEN** the developer sees and explicitly approves the exact current effects
- **THEN** only that immutable internally bound plan can proceed after revalidation
- **AND** no fingerprint must be copied or typed

#### Scenario: Preparation or verification runs but file approval is later declined
- **WHEN** separately authorized preparation or verification has run and the developer declines or cancels file-transaction approval
- **THEN** no further unapproved CLI mutation or planned file transaction runs
- **AND** the report retains the earlier preparation/verifier effects and does not claim that the project or host was untouched

#### Scenario: Network consent is declined before verification
- **WHEN** the reviewed verification requires declared network effects and that separate consent is declined
- **THEN** no verification command begins
- **AND** an earlier script-scope Yes cannot expand into network authority

### Requirement: Historical repair identities remain truthful through recovery
New repair history and journals SHALL record their original CLI, contract, recipe/layout and schema identities. Historical schema-1 receipts SHALL remain unchanged and SHALL NOT become current approval or proof. Recovery SHALL accept only explicitly supported journal/contract/recipe combinations with the original external approval seal and current confinement/concurrency checks. Compatibility for recovering old effects SHALL NOT authorize a new plan.

#### Scenario: Recover an old sealed interrupted repair
- **WHEN** the registered schema-1 repair journal has valid external authority and unchanged recoverable destinations
- **THEN** recovery handles only its recorded operations under the explicit legacy mapping
- **AND** it does not retag old history or execute a new recipe

#### Scenario: A future repair journal is present
- **WHEN** the journal declares an unknown schema, repair contract or recipe
- **THEN** inspection and recovery report the unsupported identity and supported remedy without writes
- **AND** no force or new preview bypasses the pending journal

### Requirement: Application layout inspection reports actual bounded evidence
Repair SHALL offer a read-only application inventory for supported existing projects. It SHALL identify exact current generated target artifact paths and layout identity, observed source paths/digests/modes, recorded provenance, custom files, reference locations, exclusions, limitations and unresolved mappings. It SHALL NOT infer historical layout identity or mutation authority from a generation hash or folder resemblance. Inspection SHALL be bounded, project-confined and portable on Windows, macOS and Linux, with no scripts, network, state contents or secret values read or emitted.

#### Scenario: A customized backend lives in a legacy folder
- **WHEN** inspection sees application files outside the current generated backend paths
- **THEN** it reports those actual files and current target identities with concrete reference-review inputs
- **AND** it leaves source mappings unresolved unless explicitly established rather than copying a starter or automatically moving folders

#### Scenario: Layout inspection is incomplete
- **WHEN** unsafe links, case aliases, unknown identities or inspection limits prevent a complete supported inventory
- **THEN** the report exposes the limitation and blocks any patch that depends on the unobserved scope
- **AND** it never treats missing files as proof of undeployed infrastructure

### Requirement: Agent-authored application patches use deterministic reviewed application
The application-patch recipe SHALL accept an exact staged patch for individually identified project files, not a generic folder move. It SHALL distinguish inventory, proposed patch, staged verification, committed patch and declared-check conformance. Each mapping SHALL bind observed source and destination paths, bytes and modes, staging bytes, the selected target layout and reviewed references. Unresolved mappings, protected ownership, unexpected files or occupied move destinations SHALL block application. The patch SHALL be authored outside the real project, and only the confined exact-plan transaction SHALL apply it after separate explicit file approval.

#### Scenario: Relocate customized code and its references
- **WHEN** a complete staged patch maps customized source and affected import/build/container/CI/documentation references to supported targets
- **THEN** preview shows exact before/after effects without changing the real project
- **AND** after matching verification and separate exact interactive or automation approval only those effects commit, preserving custom behavior rather than replacing the application with a starter

#### Scenario: Source or stage changes during review
- **WHEN** a protected source, destination, mode, directory entry, patch document or staged replacement changes after preview or verification
- **THEN** application refuses the stale approval before writes and requires fresh review

#### Scenario: The patch attempts to forge provenance
- **WHEN** a patch includes manifest, desired-state, managed/framework, history, activation proof, state, credentials or other excluded scope
- **THEN** the recipe rejects it regardless of the fingerprint or agent's assertion of ownership

#### Scenario: The Windows destination aliases another path
- **WHEN** an explicitly mapped destination contains traversal, a symlink/junction or a case/normalization alias
- **THEN** preview and application reject it on every supported platform

### Requirement: Application verification has independent explicit authority
Application-patch preview and file approval SHALL NOT authorize dependency preparation, project scripts or network operations. The CLI SHALL expose exact preparation/check commands, lifecycle policy and effects and execute them only after their separate action-specific interactive consents or equivalent exact automation permissions bound to the same fingerprint. Declared network effects SHALL require additional explicit permission before any preparation/check command. Staging SHALL NOT be described as an OS or network sandbox; trusted dependency/project commands can have host effects, and unsupported mandatory isolation SHALL block. Passed checks SHALL bind the unchanged candidate, locks, prepared scope and tool identities and SHALL NOT claim full application, setup, activation or live conformance. Failure SHALL prevent the planned file transaction and truthfully report earlier preparation/verifier effects; committed work SHALL retain private rollback material and immutable history without automatic restoration.

#### Scenario: File approval is supplied without staged verification
- **WHEN** the application patch has no fresh matching successful verification
- **THEN** application remains blocked with the actual independent verification action
- **AND** file approval itself executes no project code

#### Scenario: A declared verification downloads dependencies
- **WHEN** its exact staged command requires network and only verification scope was requested
- **THEN** it remains blocked until the additional network permission is explicit
- **AND** no tool installation, cloud-state access or Git publication is implied

#### Scenario: Verified code commits but later behavior needs correction
- **WHEN** declared checks passed and the exact patch committed
- **THEN** the report records only that verified scope and retained rollback/history references
- **AND** later correction requires a new reviewed patch or user-controlled history recovery, not a blind rollback

### Requirement: Locked preparation is explicit private and provider-bounded
Repair SHALL support registered locked preparation for selected candidate components through `npm-ci`, `uv-locked-sync` and `go-mod-download` version-1 providers with their exact declared input/tool/source restrictions. Preparation SHALL consume the exact post-patch manifest/lock bytes and existing compatible tools in a fresh private disposable environment/cache. It SHALL NOT copy live dependency trees, inherit registry credentials/global or project package-manager configuration, regenerate or upgrade locks, install global tools, or include dependencies/build outputs in the final file transaction. Unregistered or escaping workspace/local/VCS/authenticated sources SHALL remain blocked.

#### Scenario: Prepare and check the generated Node backend and frontend
- **WHEN** exact candidate backend/frontend package manifests and locks are valid and compatible Node/npm are installed
- **THEN** separately approved frozen npm preparation restores private dependencies with lifecycle hooks suppressed
- **AND** actual backend build/existing tests and frontend build can run as separately approved declared checks before exact file commit
- **AND** frontend tests are executed or claimed only if the selected project actually declares them

#### Scenario: Prepare a Python component
- **WHEN** its exact pyproject and uv lock match a supported candidate and compatible Python/uv are installed
- **THEN** approved locked preparation uses a private environment without interpreter downloads, source builds or project-install/build hooks
- **AND** missing tools, unavailable wheels or required unsupported hooks produce causal blockers rather than silent installation or invented qualification

#### Scenario: Prepare a Go module
- **WHEN** exact go.mod/go.sum inputs and compatible existing Go satisfy the registered provider
- **THEN** approved preparation uses private module/build caches with no toolchain download or module/checksum update
- **AND** any needed module network reads require the separately declared and approved network scope

#### Scenario: Preparation is absent or declined
- **WHEN** no preparation is declared or its separate permission is not granted
- **THEN** the CLI does not run an installer, use live node_modules or a live virtual environment, or infer preparation consent from network/file/script approval
- **AND** unavailable verification dependencies remain explicit blockers

#### Scenario: Lifecycle execution is required but unsupported
- **WHEN** a candidate needs lifecycle/build hooks that the registered provider cannot safely execute under the declared policy
- **THEN** the operation blocks without secretly enabling hooks or relaxing lock constraints

### Requirement: Tool probes and preparation results preserve exact candidate identity
An explicitly requested preparation preview SHALL use bounded metadata probes of trusted resolved installed executables/interpreters in a sanitized environment and non-project/non-staging working directory. Probe identity SHALL include canonical resolved tool identity and compatible version/requirements, not arbitrary project PATH shims or version text alone. Pure repair capabilities and application inventory SHALL perform no such probes. Before effects and after each preparation/check, repair SHALL revalidate the approved tool/source/lock/mode/directory bindings and protect the candidate source while permitting only declared private output roles. Any mismatch, failed command, unsupported scope or incomplete cleanup SHALL prevent a successful verification receipt.

#### Scenario: A tool changes while approval is open
- **WHEN** the resolved executable/interpreter identity or version changes after preview
- **THEN** the old approval is rejected before preparation/check effects and a fresh review is required
- **AND** the CLI does not accept a project/staging shim printing the expected version

#### Scenario: A preparation command changes a protected lock or source
- **WHEN** preparation or checking modifies protected candidate bytes, modes or directory scope
- **THEN** no success receipt or real-project file transaction is authorized
- **AND** the original project and prior history are preserved and actual earlier private/host effects are reported

#### Scenario: Offline preparation lacks a private cache
- **WHEN** frozen preparation cannot obtain a required package without unapproved network access
- **THEN** it reports the actual cache/network limitation without falling back to an ambient cache, credential or network request

### Requirement: Private verification cleanup has registered recovery authority
Repair SHALL register and externally authenticate the canonical path, creation identity, owner/progress and declared disposable roles of each CLI-created private preparation/verification workspace before effects. Successful completion SHALL clean it; failed/interrupted cleanup SHALL preserve exact recovery metadata. Explicit repair recovery SHALL delete only that verified project-bound disposable workspace, never user patch staging, live projects, global caches, original-byte backups or history. Links/junctions, changed creation identity, active or uncertain owners and unsupported records SHALL block cleanup. A bare PID or expiry SHALL NOT be sufficient evidence. Cleanup SHALL NOT rerun verification, restore source or expand existing project-journal recovery authority.

#### Scenario: Recorded private cleanup is safe
- **WHEN** recovery finds a matching externally authenticated CLI-created workspace with a safely established stopped owner and unchanged creation identity
- **THEN** only its declared disposable scope is cleaned and successful cleanup is recorded
- **AND** application patch staging, source backups and project bytes remain unchanged

#### Scenario: Ownership or cleanup is uncertain
- **WHEN** the workspace owner is active/uncertain, identity changed, a path is linked, or cleanup cannot complete
- **THEN** recovery refuses unsafe deletion, retains the record and reports the exact remaining issue
- **AND** it does not infer authority from a directory prefix, PID or age on Windows, macOS or Linux

### Requirement: Managed process-tree settlement on Windows uses stock Job Objects
Process-tree settlement on Windows SHALL use stock Windows PowerShell 5.1 / .NET hosting a single hash-bound packaged controller source asset with genuine Win32 Job Objects. The controller SHALL enforce normal system ExecutionPolicy without `-ExecutionPolicy Bypass`, `-EncodedCommand`, or inline script evasion. When known preflight host execution policy (such as client-default `Restricted`, inherited process-scope `PSExecutionPolicyPreference`, or `AllSigned`), `ConstrainedLanguage`, AppLocker/WDAC, or outer job constraints deny controller execution, repair SHALL report an explicit causal admission blocker before requested target process or verification-workspace creation; permitted policies and nested job configurations SHALL function normally. Demonstrated policy rejection SHALL be distinguished from generic controller, compilation, launch, or admission failure and SHALL NOT be inferred from an arbitrary exit code. The effective host and process-scope policy SHALL be retained without project-environment overrides. Trusted controller bootstrap or probe activity SHALL remain distinct from requested preparation or check effects.

The controller SHALL bind the root process atomically during `CreateProcessW` using `STARTUPINFOEX` + `PROC_THREAD_ATTRIBUTE_JOB_LIST` with `CREATE_SUSPENDED`, verify membership against the exact private Job handle before `ResumeThread` (not whether a process is in any arbitrary job), and restrict `HANDLE_LIST` to intended stdio handles only. No start-then-assign fallback SHALL be permitted. When creation fails definitively, repair SHALL record no-target-started evidence; when admission fails after process allocation but before `ResumeThread`, the controller SHALL terminate and unwind only owned handles and resources, reporting actual allocations and proven absence of requested code execution. After thread resume, or if admission is uncertain, repair SHALL preserve possible prior effects and unknown state, never claiming that nothing started.

Settlement SHALL require `QueryInformationJobObject` `ActiveProcesses == 0` while holding the exact private job handle, including inherited child processes. An empty probe job or unadmitted response SHALL NOT constitute settlement. Abort or timeout SHALL terminate the Job Object and wait for active processes to reach zero. Controller loss, crash, control-pipe closure, or accounting uncertainty SHALL mark workspace state unknown and retain recovery unless a supported authenticated proof subsequently resolves that uncertainty; the sole non-inherited job handle's `KILL_ON_JOB_CLOSE` SHALL serve as a safety backstop, not assumed settlement proof. Control messages SHALL travel over an authenticated private pipe with cryptographic 64-character hex nonces and sequence numbers; untrusted target stdout/stderr, root process exit, or pipe closure SHALL NOT prove settlement.

#### Scenario: Windows client runs with default Restricted policy
- **WHEN** verification or preparation is attempted on a Windows client where default Restricted policy denies script execution
- **THEN** repair reports the causal execution policy blocker before any requested target process or verification workspace is created
- **AND** it does not attempt policy bypass, encoded commands, or inline script execution

#### Scenario: Inherited process-scope policy is restrictive
- **WHEN** the host environment has an inherited `PSExecutionPolicyPreference` that denies script execution
- **THEN** the controller respects the restrictive policy rather than dropping it or allowing target environment variables to override it
- **AND** execution fails closed before target process or verification workspace creation starts

#### Scenario: Suspended process admission fails before resume
- **WHEN** a root process is allocated suspended but job assignment or exact private membership verification fails
- **THEN** the controller terminates the suspended process and unwinds allocated handles before any target code runs
- **AND** the result reports the admission failure, actual allocations, and proven absence of requested code execution without claiming a clean success

#### Scenario: Descendant processes remain active after root process exit on Windows
- **WHEN** an admitted Windows target root process exits but descendant processes in its Job Object remain running
- **THEN** kernel accounting `ActiveProcesses > 0` denies settlement
- **AND** workspace cleanup and success receipts remain blocked until all processes in the job reach zero

#### Scenario: Command abort or timeout terminates the Job Object
- **WHEN** an admitted Windows command times out or is aborted
- **THEN** the controller terminates the Job Object and waits for active processes to reach zero
- **AND** uncertainty or failure retains the workspace and recovery records

#### Scenario: Controller crash or channel loss leaves accounting uncertain
- **WHEN** the controller crashes, the control pipe breaks, or kernel accounting cannot be read while a target was running
- **THEN** repair records uncertain ownership, retains the workspace and recovery records, and denies settlement
- **AND** `KILL_ON_JOB_CLOSE` termination is not treated as proof that all processes exited cleanly or that nothing changed
