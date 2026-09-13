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
Repair JSON SHALL use numeric `schemaVersion: 1` and distinguish operation kind, requested scope, authority, local/backend checkpoints, verification, recovery, and actual next actions. `repairScopeComplete` SHALL remain distinct from setup or activation completion. Exit 0 SHALL mean clean or verified complete requested scope; exit 1 SHALL identify rejected/error execution before progress; exit 2 SHALL identify differences, blocked plans, or persisted effects with incomplete verification/recovery. Actual partial effects SHALL remain visible regardless of failure.

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
