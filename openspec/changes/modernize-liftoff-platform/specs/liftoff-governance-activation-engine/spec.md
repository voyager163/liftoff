## MODIFIED Requirements

### Requirement: Activation identity uses an explicit compatibility version vector
The engine SHALL distinguish CLI, activation package, profile/policy, activation contract, graph, state, evidence, approval, compatibility, supersession and credential-policy identities. The modernization target SHALL use manifest v8 and advance every contract/schema whose semantics or representation changes, including profile/workflow-aware proof. Actual packaged constants and computed graph hashes SHALL define the target; released `0.12.0`/manifest-v7 and earlier families remain declared historical sources. No skill version, invented graph hash or numeric-order compatibility inference is allowed.

#### Scenario: A CLI patch changes no governance contract
- **WHEN** phase/proof/graph semantics are unchanged
- **THEN** release metadata alone does not retag proof

#### Scenario: Normative governance behavior changes
- **WHEN** a profile's fixed requirement changes
- **THEN** its policy identity advances and affected work requires reconciliation

#### Scenario: Activation behavior changes
- **WHEN** order, authority, effects or recovery meaning changes
- **THEN** the activation contract and exact compatibility inventory identify the new combination

#### Scenario: A serialized representation changes incompatibly
- **WHEN** a proof/graph/approval representation changes
- **THEN** its own schema advances and unsupported readers fail before mutation

#### Scenario: Managed graph bytes change without compatible identity
- **WHEN** a graph digest/identity does not match its actual bytes
- **THEN** release validation fails

#### Scenario: Future activation identity is encountered
- **WHEN** a tuple is unsupported
- **THEN** it cannot execute or rewrite its history

#### Scenario: Historical activation v1 is encountered
- **WHEN** a known v1 source exists
- **THEN** only its declared reviewed successor lane can advance it

#### Scenario: Historical activation v2 is encountered
- **WHEN** a known v2 or v3 source needs the modernization target
- **THEN** original records are preserved and old consent does not become new authority

### Requirement: Setup completes the generated baseline before governance
Initial publication/activation SHALL require current local baseline completion. OpenSpec retains planning-complete strict-valid seed, local checks, synchronization and archive verification. Spec Kit retains explicit bootstrap bundle, official markers, local finalization and receipt without OpenSpec archive. Manual SHALL use explicit native local validation/finalization proof without requiring or fabricating a seed specification or archive. Ambiguous overlapping active work SHALL block until reconciled.

#### Scenario: Generated seed is ready
- **WHEN** an OpenSpec baseline passes all applicable checks
- **THEN** its seed is finalized/synced/archived and the complete spec set is strict-valid without a deployment claim

#### Scenario: Spec Kit baseline is ready
- **WHEN** its actual bootstrap and checks succeed
- **THEN** native finalization records local proof without an OpenSpec archive

#### Scenario: Spec Kit has templates but no bootstrap bundle
- **WHEN** required bootstrap content is absent
- **THEN** a specific adoption blocker remains and ordinary update does not invent missing work

#### Scenario: Post-archive strict validation fails
- **WHEN** archive happened but the synchronized set is invalid
- **THEN** setup reports a retryable exact failure without successful final proof

#### Scenario: Existing archived evidence references an invalid main capability
- **WHEN** its expected capability is missing or invalid
- **THEN** local completion and dependent work remain blocked

#### Scenario: Generated seed is incomplete
- **WHEN** an external workflow's required generated artifacts are missing
- **THEN** setup reports the actual defect and performs no activation

#### Scenario: Another governance change exists
- **WHEN** one compatible active change is already authoritative
- **THEN** setup resumes it instead of creating another

#### Scenario: Active change ownership is ambiguous
- **WHEN** overlapping active work prevents a unique source of truth
- **THEN** explicit reconciliation is required

#### Scenario: Manual baseline is ready
- **WHEN** applicable native local checks succeed for Manual
- **THEN** native proof establishes local completion without any framework process, fake archive or mandatory spec document

### Requirement: Baseline verification is local and deterministic
The engine SHALL execute applicable actual project validation, backend tests, frontend build, Compose configuration and backend-disabled OpenTofu checks before local proof. External workflow checks SHALL follow OpenSpec or Spec Kit's existing contract; Manual SHALL mark those framework-specific steps inapplicable and require native completion proof. Existing receipts are validated on reuse, not prerequisites for the first run. No local baseline requires cloud planning, container startup or remote mutation. All paths/check commands SHALL be native and literal across supported hosts.

#### Scenario: API project has a frontend and OpenTofu
- **WHEN** local baseline runs
- **THEN** each applicable check executes without cloud credentials/backend access

#### Scenario: Workload omits a component
- **WHEN** validated facts establish absence
- **THEN** its check is inapplicable rather than synthetic success

#### Scenario: Baseline validation fails
- **WHEN** an applicable check fails
- **THEN** no verified proof or automatic publication is produced

#### Scenario: Generated Python needs its component parent as a package search namespace
- **WHEN** the genuine pytest configuration declares the exact literal `pythonpath = [".."]`
- **THEN** the already captured immediate component parent may act as a search namespace for selected copied source without adding input roots, reading siblings or copying excluded controls
- **AND** the interpretation is revision-bound in the approved recipe, parent membership remains freshness-bound, recursive escaping test inputs remain blocked and an import requiring uncopied source fails without completion proof

#### Scenario: Explicit public modern local verification
- **WHEN** a v8 caller selects `governance plan`, `approve`, and `apply-next` with `--scope local --local-operation verify`, a closed mode-specific request, separate exact consent and explicit execution
- **THEN** each operation routes to its one admitted modern engine without reading historical authority or discovering a publication or successor operation
- **AND** project-code host capabilities, dependency preparation/network, and initialized OpenSpec scope attestation remain independent consent boundaries
- **AND** absent `--execute` only observes saved progress, actual failed or uncertain execution remains unsuccessful, and captured verification or initialization obligations do not establish published local, activation or lifecycle completion

#### Scenario: Seed was archived before activation began
- **WHEN** OpenSpec seed is archived and activation has not begun
- **THEN** current local checks and synchronized capability validation run without recreating the archive

#### Scenario: Explicit public Manual or Spec Kit completion
- **WHEN** an admitted v8 caller explicitly selects local finalization of a completed verification and separately reviews and approves exact publication bytes
- **THEN** workflow-specific consent, publication consent and execution remain independent, and only original provenance, committed exact-file publication and independent current readback establish local completion
- **AND** selected saved-progress inspection is not fresh proof, a finalization key cannot select publication, and a different active transaction blocks before unrelated authority is read
- **AND** explicit attributed recovery does not replay publication; a clean rollback may complete recovery without establishing local completion, while uncertain or incomplete effects remain unsuccessful
- **AND** OpenSpec finalization, successor revalidation, provider operations and whole-directory rollback remain outside this public interface

#### Scenario: Spec Kit baseline is finalized locally
- **WHEN** Spec Kit local setup runs
- **THEN** its actual bundle/markers and checks are validated without fake OpenSpec work

#### Scenario: Retry an archived baseline after repair
- **WHEN** an archived baseline becomes retryable after repair
- **THEN** inspection preserves stored history and only explicit execution records fresh proof

#### Scenario: Archived capability is missing or invalid
- **WHEN** a required synchronized capability cannot be validated
- **THEN** verification fails without duplicate seed creation

#### Scenario: Archived setup runs from a path with spaces on Windows
- **WHEN** baseline commands run on Windows, macOS or Linux
- **THEN** separate arguments and actual component working directories preserve the same scope

### Requirement: Local setup has a finishable independent completion boundary
Local completion SHALL require current valid project/plugin/layout/agent state, applicable external tools, and workflow-appropriate local proof. OpenSpec/Spec Kit retain their seed/finalization semantics; Manual uses native input/check/finalization proof with optional agents. Commit, push, credentials, cloud deployment, enforcement and retained-state disposal SHALL not be prerequisites for local completion.

#### Scenario: Finish a fresh local project
- **WHEN** all applicable local checks/proofs are current
- **THEN** local completion is reported independently from absent or blocked activation

#### Scenario: External activation prerequisites are unavailable
- **WHEN** permissions, quotas or execution paths block activation
- **THEN** local completion is retained and the actual missing prerequisite remains visible

#### Scenario: Local infrastructure still needs repair
- **WHEN** required local conformance is unresolved
- **THEN** local completion remains blocked with supported repair/planning guidance

#### Scenario: Shared state is malformed
- **WHEN** required shared identity/proof cannot be validated
- **THEN** local scope does not hide the integrity failure

### Requirement: Supported activation phases have production producers
The release SHALL provide real bounded production producers for every advertised new-environment Azure/GitHub phase: publication, discovery, approval, secure credentials, providers, backend/execution prerequisites, immutable artifacts, deployment, qualification, enforcement, recovery and due lifecycle. Actual operation IDs, owned scope, independent readback and partial progress SHALL be retained. Public pre-existing deployment/state migration remains excluded; a private primitive or test injection is not production qualification.

#### Scenario: Activate a supported fresh project
- **WHEN** actual account/host prerequisites and exact approvals are satisfied
- **THEN** required real operations run through verified deployment and enforcement

#### Scenario: A provider request is still running
- **WHEN** bounded polling ends before completion
- **THEN** actual pending operation identity is recorded for observation/resume without duplicate dispatch

#### Scenario: An operation partly changes resources
- **WHEN** an external effect precedes failure
- **THEN** checkpoints and permitted recovery remain visible rather than claiming local rollback undid cloud effects

## ADDED Requirements

### Requirement: New-environment ownership cannot expand into existing-deployment migration
Execution SHALL distinguish new approved resources, verified effects already created by the same recorded activation, and pre-existing deployment/state ownership. Only the first two can use qualified new-environment execution/resume and its exact protected bootstrap handover. Existing-deployment import, partition, relocation and address migration SHALL remain publicly planning-only. Missing local files, matching names or broad approval SHALL not prove ownership.

#### Scenario: A retry finds its own previously created resource
- **WHEN** current evidence verifies the exact recorded operation and ownership
- **THEN** bounded resume observes that effect without recreating it

#### Scenario: A planned resource already belongs to an existing deployment
- **WHEN** current discovery identifies pre-existing or uncertain ownership
- **THEN** dependent creation/import stops with the deferred adoption boundary
