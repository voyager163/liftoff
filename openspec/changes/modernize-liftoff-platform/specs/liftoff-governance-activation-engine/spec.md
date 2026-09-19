## MODIFIED Requirements

### Requirement: Activation identity uses an explicit compatibility version vector
The engine SHALL distinguish CLI, activation package, policy, activation contract, graph, state, evidence, approval, compatibility, supersession, and credential-policy identities. The coordinated execution family SHALL declare one exact activation package identity, manifest artifact 8, policy 8, activation contract 4, graph schema 3 with its computed hash, state/evidence/approval schemas 4, compatibility metadata schema 5, and credential-policy schema 2. Unchanged supersession format SHALL remain schema 1. Supported v1/v2/v3 source identities and the exact pre-amendment candidate tuple with policy 7 and credential-policy schema 1 SHALL be read through their declared original contracts and advanced only through approved successor lanes. No independent setup-skill version or invented graph hash SHALL be introduced.

#### Scenario: A CLI patch changes no governance contract
- **WHEN** implementation leaves phase/proof semantics, representations, and graph bytes unchanged
- **THEN** only the applicable release metadata changes
- **AND** current proof is not retagged solely because CLI SemVer changed

#### Scenario: Normative governance behavior changes
- **WHEN** a fixed policy requirement changes
- **THEN** policy identity advances and affected work requires reconciliation

#### Scenario: Activation behavior changes
- **WHEN** ordering, approvals, permitted effects, proof, or recovery semantics change
- **THEN** the activation contract and compatibility declarations identify the new executable combination

#### Scenario: A serialized representation changes incompatibly
- **WHEN** graph/state/evidence/approval or compatibility representation changes
- **THEN** its schema advances and unsupported readers fail before mutation

#### Scenario: Managed graph bytes change without compatible identity
- **WHEN** graph bytes lack their required version/hash treatment
- **THEN** release qualification fails instead of accepting an invented or stale hash

#### Scenario: Future activation identity is encountered
- **WHEN** an unsupported future identity is read
- **THEN** it is rejected for execution without rewriting its history

#### Scenario: Historical activation v1 is encountered
- **WHEN** a known v1 source is encountered
- **THEN** it remains diagnostic-only until a declared reviewed successor is created
- **AND** update preview, not manual version editing, identifies the supported path

#### Scenario: Historical activation v2 is encountered
- **WHEN** current-contract execution encounters a supported v2 source
- **THEN** original state, evidence, plans, approvals and ancestor histories are preserved under the successor migration contract
- **AND** old success or consent is not relabeled as current authority

#### Scenario: Historical activation v3 is encountered
- **WHEN** a supported 0.12.x project carries the exact published v3 activation identity
- **THEN** inspection distinguishes historical readability, migration eligibility and current execution support
- **AND** neither the native installer nor a change in CLI SemVer silently rewrites the project into v4

#### Scenario: The pre-amendment candidate is encountered
- **WHEN** records use the exact registered policy-7 and credential-policy-schema-1 candidate tuple
- **THEN** their original bytes and approval meaning remain readable through the declared source reader
- **AND** shared activation-contract number 4 does not authorize policy-8 execution or the broader provider grant

### Requirement: Runner-preflight credential enrollment is deterministic
When `GITHUB_TOKEN` cannot read required organization runner metadata, the engine SHALL first consume an existing approved GitHub App installation token when available, otherwise guide one fine-grained PAT enrollment using the display name `<repo>-runner-preflight-read`, secret `RUNNER_CONFIGURATION_READ_TOKEN`, 30-day lifetime, and current-repository-only selection. Under governance policy 8 and credential-policy schema 2, required provider grants SHALL be exactly repository `metadata:read`, organization `organization_administration:read`, and organization `organization_network_configurations:read`, preserving the actual auth-kind-specific provider representation. No write or additional permission SHALL be inferred or accepted. The value MUST be entered through a masked or approved protected channel and MUST NOT appear in chat, command arguments, logs, evidence, screenshots, or generated files.

Planning and approval SHALL disclose that Administration read includes broader organization, billing and Actions-settings reads and is not a hosted-runners-only grant. That provider reach SHALL NOT authorize Liftoff operations beyond the exact reviewed endpoints, principal, repository/organization, workflows and expiry. Credential use and policy creation or transition SHALL require fresh exact plan-bound approval under the new identity, including the observed grants and disclosure. Schema-1 policies and original approvals SHALL remain unchanged and SHALL NOT authorize the broader grant through normalization, version ordering or reused consent. The amendment SHALL NOT replace independent PAT bearer/lifetime proof or change reviewed create-only secret enrollment into create-or-update authority.

#### Scenario: Approved GitHub App is available
- **WHEN** setup verifies a selected-repository installation with the exact required provider grants and fresh matching approval
- **THEN** workflows generate short-lived installation tokens only within the recorded workflow/job restrictions
- **AND** no PAT enrollment is requested

#### Scenario: PAT fallback is required
- **WHEN** no approved App is available
- **THEN** setup supplies every fixed field and the actual broader-read disclosure without asking the developer to invent token names or scopes
- **AND** asks only for secure credential creation and protected enrollment under exact approval, retaining independent identity and lifetime verification

#### Scenario: Credential policy is recorded
- **WHEN** supported enrollment or existing-App verification succeeds under the new identity
- **THEN** a payload-free schema-2 policy records the auth kind, display-name template, secret name, owner, repository, expiry, rotation lead, actual provider grants, broader-read disclosure, allowed workflows/jobs and non-forwarding rule
- **AND** recording policy does not authorize unrelated provider reads, secret replacement or cloud effects

#### Scenario: Credential appears in unsafe output
- **WHEN** a credential-shaped value is detected in chat-derived content, logs, evidence, screenshots submitted for processing, or generated files
- **THEN** setup marks the credential compromised, blocks its use, and instructs revocation and rotation

#### Scenario: Provider grants have extra or missing scope
- **WHEN** independently observed permissions differ from the exact declared minimum for the selected authentication kind
- **THEN** admission preserves the safe permission observation and blocks credential use and policy writes
- **AND** generic approval or a supported schema version does not excuse extra reads, writes or missing grants

#### Scenario: An old approval is supplied for the broader grant
- **WHEN** a schema-1 policy, prior candidate approval or unchanged credential reference is offered as authority for policy-8 execution
- **THEN** admission requires a newly reviewed plan and fresh exact approval
- **AND** original records are neither retagged nor silently broadened

#### Scenario: Grant or target changes after review
- **WHEN** observed permissions, principal, repository/organization, intended operations, workflow restrictions or applicable expiry differ from the approved plan
- **THEN** execution stops before further effects and requires renewed review
- **AND** approval of an earlier disclosure is not reusable authority for changed scope

#### Scenario: Independent enrollment proof is unavailable
- **WHEN** exact PAT bearer/lifetime proof or supported conditional secret creation cannot be established
- **THEN** that operation remains blocked with its specific implementation or provider prerequisite
- **AND** the permission amendment does not fabricate proof, permit foreign-secret replacement or claim complete credential enrollment

### Requirement: Governance activation uses one canonical phase graph
The system SHALL package one versioned, machine-readable governance phase graph whose explicit phase identifiers, dependencies, applicability, scope membership, allowed mutations, required evidence, approval gates, recovery boundaries and terminal states are authoritative. The graph SHALL support local, repository, activation and lifecycle completion independently, with explicit shared prerequisites and dedicated repository-enforcement phases. Policy prose, model output and generated tasks SHALL NOT override the graph or make repository-only proof satisfy full activation.

#### Scenario: Setup starts on a fresh project
- **WHEN** the developer invokes the native setup integration
- **THEN** the engine loads the graph matching the installed managed policy and selected supported identity
- **AND** calculates readiness from project state, requested scope and verified evidence

#### Scenario: A task list reverses dependencies
- **WHEN** a task places remote import before the private execution path required by the graph
- **THEN** the engine rejects that transition even if its checkbox is complete

#### Scenario: A phase is inapplicable
- **WHEN** deterministic discovery proves a conditional phase does not apply
- **THEN** the engine records inapplicability with evidence
- **AND** dependent phases evaluate the declared selected-path edge rather than inventing placeholder work

#### Scenario: Repository enforcement is selected
- **WHEN** the developer explicitly selects repository scope after its local/publication prerequisites
- **THEN** the graph exposes its repository discovery, workflow publication, check qualification, approval, reconciliation and readback path without Azure or production dependencies
- **AND** the full activation completion result remains independently incomplete until its own requirements are satisfied

#### Scenario: A repository receipt is supplied to full activation
- **WHEN** a receipt proves only repository-scope checks or controls
- **THEN** it cannot satisfy a production rehearsal, full-activation green/red proof or other differently scoped evidence contract

### Requirement: Activation state is typed, evidence-backed, and resumable
The engine SHALL retain explicit pending, blocked, ready, approved, running, verified, failed, inapplicable, retained and disposed outcomes, together with planning, approval and external-operation progress. Current success SHALL require the selected graph's exact evidence, scope, approval, applicability and current readback. Proof SHALL bind execution identity, graph, consumed inputs, reviewed operation, actual producer/run, body and relevant repository/resource/backend/artifact identities. Historical v1/v2/v3 records SHALL remain immutable source history, not automatically current v4 proof. Partial effects SHALL remain inspectable and recoverable.

#### Scenario: Setup is invoked repeatedly
- **WHEN** current verified work still satisfies the requested contract
- **THEN** inspection identifies it without repeating mutations
- **AND** new execution remains an explicit supported operation

#### Scenario: Evidence is missing or stale
- **WHEN** a completed task lacks current correctly bound proof
- **THEN** dependent effects remain blocked until supported revalidation or recovery

#### Scenario: Evidence contradicts a task checkbox
- **WHEN** a checked task conflicts with authoritative proof
- **THEN** verification reports the mismatch without treating the checkbox as authority
- **AND** any correction follows an explicitly planned permitted operation

#### Scenario: Remote binding changes after local anchoring
- **WHEN** current verified repository/resource/backend binding differs from prior proof
- **THEN** stable local history is preserved and stale remote proof is not reused

#### Scenario: Successor is not automatically verified
- **WHEN** an approved successor is created from supported historical records
- **THEN** current proof is established through its declared revalidation/readback path
- **AND** historical success or approval is not translated into current mutation permission

#### Scenario: A remote operation is partially complete
- **WHEN** a producer cannot finish after persisted effects
- **THEN** state retains its exact operation/checkpoint identity and recovery boundary
- **AND** failure does not erase the effects or authorize a blind retry

#### Scenario: A planned transition changes tracked source
- **WHEN** approved workflow publication or configuration cutover produces its exact reviewed outputs
- **THEN** proof binds the authorized before/after transition and refreshes affected checks
- **AND** the expected write does not invalidate unrelated proof through a global configuration digest

#### Scenario: A source change was not planned
- **WHEN** an input or output differs outside the approved transition
- **THEN** the affected plan and dependent proof remain blocked
- **AND** generated-file status does not exempt it from integrity checks

### Requirement: Setup exposes strict project-aware commands
The CLI SHALL expose project-aware governance planning, approval, execution, enrollment, inspection, recovery and verification under explicit local, repository, activation and lifecycle scopes. Unscoped governance SHALL retain its existing activation default; repository-only completion requires explicit selection. Inspection SHALL NOT mutate project or provider state; approval-oriented planning can save a disclosed external preview. Apply-next SHALL execute at most one currently authorized graph phase. Local revalidation, repository enforcement, full activation and stateful repair SHALL each use their own exact operation/authority contracts. Governance output schema 3 SHALL report selected-scope success separately from consistency and the completion of other scopes.

#### Scenario: Developer runs the slash skill
- **WHEN** setup is invoked from a subdirectory through a supported agent integration
- **THEN** it resolves the exact project, begins with local readiness and guides the requested journey through declared boundaries

#### Scenario: Status is requested
- **WHEN** governance status runs
- **THEN** output identifies identity, graph, active work, phase states, blockers, approval/freshness, migration/repair progress and supported next actions
- **AND** local completion, repository enforcement, full activation and lifecycle completion are separately reported

#### Scenario: An existing caller omits scope
- **WHEN** a governance command is invoked without a scope selection
- **THEN** it retains the activation scope contract
- **AND** it does not substitute repository completion for the requested default activation result

#### Scenario: Apply-next is requested
- **WHEN** multiple phases appear ready
- **THEN** the engine selects only a phase in the requested scope satisfying current dependencies and approvals
- **AND** reports its actual permitted effects

#### Scenario: Approval is missing but a plan is possible
- **WHEN** dependencies and required inputs establish a plannable phase
- **THEN** its preview is available before approval
- **AND** execution readiness remains false until the exact required authority is present

#### Scenario: Apply-next is previewed
- **WHEN** apply-next runs without its explicit execution option
- **THEN** it reports the transition without writing state, evidence, approvals, preview receipts or provider resources

#### Scenario: Apply-next is executed
- **WHEN** a ready phase is explicitly executed with current approval satisfied
- **THEN** at most that phase executes and its outcome is validated before successful persistence
- **AND** a new inspection supplies post-operation readiness

#### Scenario: Resume is used after a local baseline failure
- **WHEN** resume inspects a blocked local phase
- **THEN** it reports the blocker and supported next action without rerunning work
- **AND** revalidation is routed to the actual update/repair/recovery preview rather than a generic remedy

#### Scenario: Planned operation is not allowed by the phase graph
- **WHEN** an operation exceeds its phase contract or selected scope
- **THEN** preview and execution block before effects or successful evidence
- **AND** another command's approval does not override that boundary

#### Scenario: Verify is requested
- **WHEN** governance verify runs
- **THEN** it evaluates identity/integrity, the selected scope's current evidence, task projection, policy, source of truth and applicable readback
- **AND** reports consistency separately from selected-scope and overall progress

#### Scenario: Not-started state is consistent
- **WHEN** verification finds a valid not-started view
- **THEN** it reports consistent but incomplete work without manufacturing evidence

#### Scenario: Phase has a forbidden terminal result
- **WHEN** state/evidence declares a terminal result outside its phase contract
- **THEN** verification reports inconsistency and dependent execution remains blocked

#### Scenario: Governance state cannot be inspected
- **WHEN** required graph, state, identity, policy or referenced history is malformed
- **THEN** verification reports an inconsistent, incomplete result
- **AND** it does not substitute preserved history for current state

#### Scenario: An update revalidation plan reaches its boundary
- **WHEN** its next operation requires new inputs, separate approval, provider access or an unavailable producer
- **THEN** the coordinator stops and reports the next separately reviewed action

### Requirement: Readiness uses authoritative proof and the selected applicable path
Readiness SHALL distinguish current authoritative evidence, informational history and current contradictions. Validated retained v1/v2/v3 snapshots SHALL NOT become execution proof or invalidate a valid current v4 selection merely by existing. Unknown applicability SHALL remain unresolved. Alternative dependencies SHALL require proof from the selected applicable path. Migration completion or repository-only enforcement SHALL NOT make full activation complete.

#### Scenario: Fresh evidence coexists with stale history
- **WHEN** valid current proof exists alongside retained historical records
- **THEN** it determines readiness consistently across status, doctor, verification and assessment

#### Scenario: Current evidence is contradictory
- **WHEN** equally authoritative current records disagree
- **THEN** the phase and dependent execution remain blocked

#### Scenario: Private applicability has not been established
- **WHEN** current validated facts do not establish private execution or credential applicability
- **THEN** it remains unknown rather than skipping required proof

#### Scenario: Unselected backend path is inapplicable
- **WHEN** the selected path is blocked and another path is inapplicable
- **THEN** that inapplicable path does not satisfy the selected dependency

#### Scenario: Outcome cannot satisfy its own evidence contract
- **WHEN** an executor reports success without required body binding or independent proof
- **THEN** the result is blocked before successful state/evidence persistence

#### Scenario: Migration committed but work remains
- **WHEN** the successor exists but later phases lack current proof
- **THEN** migration is reported committed while the affected scopes remain incomplete

### Requirement: Local setup has a finishable independent completion boundary
Local setup SHALL consist of valid current project and selected-framework integrations, compatible selected agents and required local tools, and fresh successful seed-valid, seed-verified and seed-archived proof. Spec Kit SHALL retain its local finalization semantics. Commit, push, remote discovery, credentials, cloud infrastructure, enforcement and retained-state disposal SHALL remain non-local repository, activation or lifecycle work and SHALL NOT be prerequisites for local completion.

#### Scenario: Finish a fresh local project
- **WHEN** applicable local requirements and phase proofs are current and successful
- **THEN** setup reports local completion without requiring a remote, publication approval, cloud credentials or enforcement
- **AND** other scopes remain separately not started or blocked rather than falsely complete

#### Scenario: External activation prerequisites are unavailable
- **WHEN** permissions, quota, account capabilities or execution-path requirements block external work
- **THEN** local completion remains visible and the prerequisite is explicit
- **AND** a missing required producer is separately identified, not disguised as a permission problem

#### Scenario: Local infrastructure still needs repair
- **WHEN** an applicable local baseline lacks a supported recipe or other local prerequisite
- **THEN** local setup remains incomplete with its actual repair/discovery path
- **AND** separation from activation does not skip local checks

#### Scenario: Shared state is malformed
- **WHEN** a shared identity or state cannot be validated
- **THEN** local scope reports the integrity failure rather than ignoring it to declare completion

### Requirement: Local scope cannot authorize publication or cloud work
The engine SHALL enforce the explicit local phase/operation boundary during planning and immediately before execution. Existing approvals, adapters, repaired provenance and local completion SHALL NOT expand local execution into repository enforcement, publication or activation. Explicit repository and activation scopes SHALL retain their own graph and authority requirements.

#### Scenario: Publication approval already exists
- **WHEN** local setup completes with a valid commit or push approval stored
- **THEN** local apply-next selects no publication phase and performs no Git mutation

#### Scenario: A producer returns an out-of-scope operation
- **WHEN** a local operation attempts a provider, credential, publication or enforcement mutation
- **THEN** execution rejects it before the effect
- **AND** no successful local proof is recorded for that operation

### Requirement: Supported activation phases have production producers
The coordinated release SHALL implement real production producers for publication, scoped discovery, approval persistence, secure credentials, provider readiness, state/runner bootstrap, application prerequisites/artifacts/deployment, qualification, enforcement, recovery and due lifecycle work for its advertised supported Azure/GitHub profiles. Each producer SHALL use bounded operations, independent current readback, exact owned scope and an honest persisted outcome. Placeholder success, injected-only adapters and unimplemented executors SHALL NOT qualify the required end-to-end paths.

#### Scenario: Activate a supported fresh project
- **WHEN** the selected supported project/account satisfy the profile and all required approvals are granted
- **THEN** actual required operations execute through verified live enforcement
- **AND** completion is not inferred from generated files or successful command submission

#### Scenario: A provider request is still running
- **WHEN** a provider operation has no terminal result within its bounded observation interval
- **THEN** the engine records its actual operation/run identity and reports resumable pending work
- **AND** it neither hangs indefinitely nor dispatches a duplicate operation

#### Scenario: An operation partly changes resources
- **WHEN** a producer fails after known external effects
- **THEN** effects and recovery boundaries remain recorded
- **AND** local file rollback is not presented as undoing those effects

#### Scenario: A required baseline executor is still unavailable
- **WHEN** workflow-source, credential, provider, backend/runner/import, application, qualification or ruleset/readback execution remains unavailable or test-injected-only
- **THEN** the coordinated release fails its capability-completion gate
- **AND** removing a blocker flag or requesting broader credentials cannot satisfy it

#### Scenario: Production registration lacks qualification
- **WHEN** the exact provider/host/recipe combination lacks approved real qualification
- **THEN** it is not advertised or registered as qualified production execution
- **AND** mocked regression success is reported separately

## ADDED Requirements

### Requirement: Phase input identity contains only consumed configuration
Each phase SHALL declare and bind the configuration, project observations and parent outputs that it actually consumes. Irrelevant configuration SHALL NOT alter its expected input identity, including when an absent configuration becomes an object. Git-only committed/pushed proof SHALL exclude Azure discovery bindings. Relevant source, repository, destination or phase input changes SHALL still invalidate affected evidence and approval.

#### Scenario: Azure inputs are added after publication
- **WHEN** local setup and approved commit/push are verified and valid Azure discovery inputs are subsequently supplied
- **THEN** unchanged Git publication facts remain valid under the current contract
- **AND** Azure-dependent planning uses the supplied bindings without invalidating unrelated predecessors

#### Scenario: An irrelevant configuration object is introduced
- **WHEN** configuration changes from absent to an object containing only inputs unused by a completed phase
- **THEN** that phase's current digest does not change merely because the outer object exists

#### Scenario: The push destination really changes
- **WHEN** repository identity, reviewed payload or push destination changes
- **THEN** affected publication proof and approvals become stale
- **AND** Azure-input isolation does not weaken those checks

### Requirement: Provider discovery rejects missing and placeholder bindings
Azure discovery SHALL require an explicitly selected valid non-placeholder subscription and tenant binding and any required region input before an executable provider operation is offered. It SHALL verify the requested account's actual identity and usable state, not substitute the ambient default. Missing inputs SHALL produce structured non-executable guidance without inserting all-zero identifiers.

#### Scenario: No Azure inputs exist
- **WHEN** activation reaches Azure discovery without required public bindings
- **THEN** the phase is blocked for missing inputs with the supported input contract
- **AND** no executable placeholder discovery action or provider call is produced

#### Scenario: A nil subscription is supplied
- **WHEN** a required UUID is all-zero or otherwise invalid
- **THEN** validation fails before provider execution
- **AND** a syntactically UUID-shaped placeholder does not establish readiness

#### Scenario: The active account differs
- **WHEN** an account readback identifies a different subscription/tenant from the reviewed target
- **THEN** discovery fails without issuing matching-success evidence

#### Scenario: Repository-only discovery is selected
- **WHEN** the requested scope is repository and its GitHub prerequisites are available
- **THEN** discovery proceeds without Azure configuration, credential access or Azure calls

### Requirement: Continuation retains exact project scope and input binding
Status, plan, verify, resume, approval and recovery guidance SHALL preserve the selected project, working directory, scope and normalized public configuration binding in their structured actions. Paths SHALL be handled natively on Windows, macOS and Linux. A saved immutable plan can bind its configuration instead of repeating a file option only when that relationship is explicit and verified.

#### Scenario: A blocked command was invoked with inputs
- **WHEN** a command receives a public input file and returns a planning or recovery action
- **THEN** the action retains that file binding or an explicitly equivalent saved-plan binding
- **AND** following it cannot silently return to unconfigured placeholder planning

#### Scenario: A relative input file is used from another directory
- **WHEN** a command is invoked from a subdirectory and returns an action with a different cwd
- **THEN** the action still resolves the original selected input file and project
- **AND** spaces, Windows drive paths and PowerShell metacharacters do not change its argument boundaries

#### Scenario: The bound configuration changes
- **WHEN** relevant input bytes change after planning
- **THEN** execution rejects the stale binding and requests a fresh plan rather than substituting the changed configuration

### Requirement: Verification exits distinguish complete incomplete and invalid scope
Governance verification SHALL return exit 0 only when the selected scope is both consistent and complete, exit 2 when consistent but incomplete, and exit 1 for inconsistency or inspection failure. Human and schema-3 JSON output SHALL agree. `ok` SHALL identify selected-scope success; consistency and completion SHALL remain explicit independent fields.

#### Scenario: Consistent activation is incomplete
- **WHEN** publication or another required activation phase remains incomplete without an integrity failure
- **THEN** verify returns 2 with `consistent: true`, `complete: false` and `ok: false`
- **AND** it does not print a completed-activation result

#### Scenario: Repository scope is complete but activation is not
- **WHEN** repository evidence is consistent and complete while cloud activation remains incomplete
- **THEN** repository verification returns 0 and identifies only repository completion
- **AND** activation verification returns 2 if otherwise consistent

#### Scenario: Current evidence is inconsistent
- **WHEN** the selected scope has stale, contradictory or invalid authoritative evidence
- **THEN** verification returns 1 with no completed success result

#### Scenario: The selected scope is not started
- **WHEN** its not-started view is structurally consistent
- **THEN** verification returns 2 rather than treating the absence of work as completion

### Requirement: Private-state execution uses qualified native host custody
Private-state-dependent activation SHALL have native implementations for macOS, Linux and Windows under independently registered supported host/provider combinations. Path selection, bootstrap, backend proof, import, application foundation and retained-state disposal SHALL use the selected adapter's observed encrypted storage, principal-bound key custody, exact tool identity, locking/write protocol, protected I/O, process settlement and recovery. Missing implementation, unmet host prerequisites and missing qualification SHALL remain distinct; removing a platform guard or injecting a fixture SHALL NOT establish production support.

#### Scenario: Select a Linux private-state adapter
- **WHEN** an approved operation selects a registered Linux host/provider combination
- **THEN** admission verifies local encrypted-storage coverage, private ownership/access, the principal-bound key reference, exact tools and applicable POSIX lock/process semantics
- **AND** a path name, mode assertion, network share or supplied encryption flag cannot substitute for native observation

#### Scenario: Select a Windows private-state adapter
- **WHEN** an approved operation selects a registered Windows host/provider combination
- **THEN** admission verifies encrypted-storage coverage, SID/DACL ownership, native key custody, the pinned OpenTofu build's actual Windows lock/write protocol and owned Job Object execution
- **AND** POSIX lock evidence, a successful CLI startup or an unrelated host's proof cannot satisfy that combination

#### Scenario: A private observation changes after approval
- **WHEN** the host, principal, volume, directory, key, tool, helper, lock provider or reviewed input binding changes before an effect
- **THEN** the old operation is refused before further effects and requires renewed exact review
- **AND** no fallback provider, replacement key or broader filesystem permission is inferred

#### Scenario: Private process output would use ordinary temporary storage
- **WHEN** a selected runner cannot keep state and credentials within the admitted private transport and storage boundary
- **THEN** execution is blocked before dispatch
- **AND** ordinary stdout/stderr logs, argv, public evidence and unqualified temporary directories are not substitutes for protected I/O

#### Scenario: Private helper settlement is uncertain
- **WHEN** cancellation or failure leaves an owned helper or descendant unproven
- **THEN** success and cleanup remain blocked and the original private recovery scope is retained
- **AND** root exit, age, a bare PID or a larger timeout does not grant cleanup authority

### Requirement: New private-state platforms preserve original macOS authority
New platform/provider identities SHALL preserve existing macOS readers, encrypted records, keys, ownership receipts and approvals without rewriting or reinterpreting them. New record semantics SHALL have explicit identities and registered preservation/transition readers before new writers are enabled. Cross-host movement, rekeying and conversion SHALL NOT be inferred from installing a new CLI or selecting another platform.

#### Scenario: Another host encounters macOS private-state material
- **WHEN** Linux or Windows encounters records or key references bound to the original macOS provider
- **THEN** it preserves the original identity and material and reports the supported historical/recovery boundary
- **AND** it does not decrypt, copy, rekey, retag or execute them under a new provider without a separately registered and approved transition

#### Scenario: Old approval names a different custody provider
- **WHEN** a new host/provider combination requests execution using an older approval
- **THEN** admission rejects the mismatching custody and effect binding
- **AND** schema compatibility or numeric version ordering does not grant new native authority

### Requirement: Controlled Linux keystore enrollment has independent authority and custody
Linux managed-keystore enrollment SHALL be a separately selected registered operation, not implicit readiness or activation. Its immutable review SHALL bind the project/account, host/principal, protected parent, absent destination, daemon/helper/dependency identities, configuration and intended effects. Enrollment, unlock, protected key reads, recovery and disposal SHALL retain their own declared authority. The workflow SHALL use only admitted supported provider interfaces and SHALL NOT adopt or modify ordinary desktop keyrings.

#### Scenario: Plan an enrollment without execution authority
- **WHEN** the operator inspects or plans a controlled Linux store
- **THEN** the result describes its exact effects and unresolved prerequisites without launching a daemon, requesting a password, creating a store or reading key bytes
- **AND** an input-channel flag, installation approval or ordinary activation request cannot supply enrollment authority

#### Scenario: The selected destination is occupied
- **WHEN** the absence-bound store destination becomes occupied or its parent identity/protection changes
- **THEN** execution refuses the old plan before creating or replacing material
- **AND** an empty-looking directory or matching name does not grant adoption or overwrite authority

#### Scenario: Enroll into an approved fresh private scope
- **WHEN** the exact enrollment is approved and current native prerequisites hold
- **THEN** execution records pre-effect custody and binds its actual store, daemon, configuration, principal, IPC endpoints and returned object identities
- **AND** it does not replace the ordinary Secret Service owner, silently change data directories or use a plaintext/empty-password fallback

#### Scenario: A private input is needed
- **WHEN** the selected approved operation needs a master password or key material
- **THEN** only the registered operator-controlled protected CLI channel supplies it within bounded private handling
- **AND** chat, argv, environment variables, public records, telemetry and ordinary temporary files never become input or storage channels

### Requirement: Managed Linux key readiness proves persistence and fresh-process recovery
A managed Linux key SHALL become ready only after authoritative backing-store and encrypted-generation binding, private key-bound readback, required durability verification, owned-session settlement and successful readback from a fresh admitted process. New receipts/key references SHALL have explicit registered identities; a collection label, modification time, nonempty loaded password or transport encryption SHALL NOT substitute for persisted-key custody. Existing macOS records and external keys SHALL retain their original meanings.

#### Scenario: Verify restart recovery
- **WHEN** enrollment reaches its persistence checkpoint
- **THEN** the owned daemon/session stops with verified settlement, cached application-key material is discarded, and a fresh admitted process reads the same key from the bound persisted store
- **AND** only matching scoped cryptographic readback can establish readiness; a cached key or unchanged item label cannot

#### Scenario: A provider cannot expose the required result
- **WHEN** an admitted interface cannot establish backing-object identity, encrypted persistence, save completion or key-bound recovery
- **THEN** enrollment remains incomplete with the exact evidence gap
- **AND** neither a successful call nor controlled daemon launch is promoted into readiness

#### Scenario: Enrollment is interrupted after a possible effect
- **WHEN** a response is lost, a process exits, persistence is uncertain or a returned object cannot be attributed
- **THEN** original checkpoints and the exact registered scope are retained for supported reconciliation
- **AND** recovery does not blindly repeat creation, reset a password, replace a key or recreate missing storage under the old identity

#### Scenario: Unlock material or key identity no longer matches
- **WHEN** restart encounters a wrong/unavailable password, changed key, changed generation or different host/principal
- **THEN** the old operation remains blocked and original material is preserved
- **AND** no empty-password fallback, rekeying or cross-host conversion is inferred

#### Scenario: Dispose a managed store
- **WHEN** separately reviewed disposal is requested
- **THEN** it requires exact owned-object attribution, settled processes and complete accounting for dependent retained artifacts
- **AND** foreign material, unknown references or uncertain work block deletion; no user keyring tree or preexisting external key is swept

### Requirement: Guarded Linux restart selects an exact null-device profile
The system SHALL preserve the original strict read-only process profile and helper identity. A controlled restart requiring the null-device sink SHALL explicitly select a separately registered profile bound to its exact operation plan, helper digest and current native device observation. Its only additional Landlock right SHALL be `WRITE_FILE` on fixed `/dev/null`, admitted through anchored no-follow retained descriptors as a root-owned character device with major 1 and minor 3. Object identity and path binding SHALL be rechecked before and after confinement. The profile SHALL NOT grant parent-directory access, truncation, device creation, additional rights on other devices, caller-supplied device paths, permission repair, inherited writable handles or automatic fallback.

#### Scenario: Start the private bus under the selected sink profile
- **WHEN** the exact reviewed restart selects the registered null-sink profile and current observations match
- **THEN** descendants may open only the verified fixed device with the additional write right, after the guard closes its retained device descriptor
- **AND** the three fresh private writable trees, persisted-store content and entry denial, protected stdio and owned-process lifecycle remain unchanged

#### Scenario: The fixed device or path is not admitted
- **WHEN** `/dev/null` is absent, linked, substituted, a regular file, another device number, differently owned or inconsistent with the bound observation
- **THEN** the new profile refuses before target execution and preserves any existing recovery scope
- **AND** it does not create or repair a device, broaden the writable roots or reuse an unqualified inherited handle

#### Scenario: The old profile or approval is supplied
- **WHEN** a caller omits the new profile or supplies authority bound to the original strict profile
- **THEN** original strict behavior remains unchanged or mismatched authority is rejected, respectively
- **AND** failure to start D-Bus does not automatically select the more permissive profile

#### Scenario: The sink succeeds but recovery does not
- **WHEN** `/dev/null` and private-bus startup succeed without complete persisted-key recovery or process settlement
- **THEN** readiness and unsafe cleanup remain blocked
- **AND** the sink grant does not claim full sandboxing, encrypted custody, native qualification or publication authority
