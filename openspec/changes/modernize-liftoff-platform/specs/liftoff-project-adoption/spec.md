## Purpose

Define reviewed in-place adoption of existing supported-stack applications while preserving business behavior, exact ownership, truthful provenance, and the released repair and verification safeguards.

## ADDED Requirements

### Requirement: Adoption is a distinct supported in-place operation
The CLI SHALL provide `liftoff adopt` as a reviewed in-place operation for existing supported FastAPI, Fastify, Go/Huma, Vue, and current GenAI profiles. It SHALL select an explicit existing project/component boundary and preserve the application's business behavior and existing customizations. Existing Git history SHALL remain unchanged, and absent VCS metadata SHALL NOT be created implicitly. It SHALL NOT create another starter application, infer arbitrary framework conversion, or treat initialization, managed update, repair, and migration as interchangeable authority. `liftoff migrate` SHALL retain its source-preserving fresh-target-only behavior, including rejection of a non-empty target under force.

#### Scenario: Adopt a customized supported API
- **WHEN** an existing supported API is selected for adoption
- **THEN** planning describes only its concrete required metadata, integrations, and individually mapped approved changes
- **AND** it does not copy a complete generated backend over the application's handlers or tests

#### Scenario: Adopt an existing Vue component
- **WHEN** the selected supported component is a Vue application without a generated Liftoff backend
- **THEN** adoption records the actual Vue profile and approved component scope
- **AND** it does not invent a backend, GenAI pattern, cloud deployment, or historical generation identity

#### Scenario: An unsupported framework is selected
- **WHEN** the source uses an unregistered stack or requires an unsupported semantic conversion
- **THEN** adoption reports the unsupported scope and read-only assessment remedy before writes
- **AND** neither a model-authored patch nor force makes that conversion executable

#### Scenario: A developer requests fresh-target migration
- **WHEN** `liftoff migrate` is selected rather than adoption
- **THEN** it retains the fresh target and unchanged source guarantees
- **AND** adoption does not weaken those guarantees or make migrate operate in place

### Requirement: Adoption planning binds current evidence and exact mappings
Adoption SHALL use current bounded assessment and independently validated source observations to build an immutable project-bound plan. The plan SHALL identify the selected versioned profile, source and target identities, exact source/destination paths, bytes and modes, directory inventory, concrete additions, preserved customizations, affected references, required checks, external effects, compatibility, and expiry. Every modification or deletion SHALL name a registered artifact identity or an explicitly mapped observed project-file identity. New files SHALL have declared absence or exact byte-identical adoption preconditions. Unknown, ambiguous, or unobserved mappings SHALL block dependent execution.

#### Scenario: A handler and its imports move
- **WHEN** a proposal maps a customized handler to a supported target location
- **THEN** the plan includes its actual before/after bytes and every declared affected import, build, container, test, workflow, or documentation reference
- **AND** a generic folder move or resemblance to a generated path is not sufficient

#### Scenario: A destination is occupied
- **WHEN** an addition or move targets different existing bytes outside the approved identity
- **THEN** the candidate is blocked before its file transaction
- **AND** the existing destination is not overwritten by a broad template or force operation

#### Scenario: The report is stale
- **WHEN** source, destination, desired state, staged bytes, tools, profile, or configuration binding differs from the reviewed observation
- **THEN** adoption requires a fresh plan and approval
- **AND** a prior assessment result does not supply reusable write authority

#### Scenario: Windows mappings alias another file
- **WHEN** a source or destination uses traversal, embedded separators in portable path parts, unsafe links or junctions, or case or normalization collisions
- **THEN** admission refuses the ambiguous or escaping identity on Windows, macOS, and Linux
- **AND** absolute project selection remains separate from project-confined artifact identities

### Requirement: Adoption preserves business behavior rather than template resemblance
Adoption SHALL preserve the existing externally observable application contract, including applicable routes, request and response behavior, configuration semantics, database and migration history, worker or model boundaries, and user-authored tests and customizations. Proposed changes SHALL identify evidence and checks supporting preservation. Unresolved business semantics or unsupported required checks SHALL remain blockers. Explicitly requested standards fixes SHALL be described as bounded behavior changes rather than hidden as formatting, layout normalization, or starter replacement.

#### Scenario: Custom routes differ from the starter
- **WHEN** a supported application exposes business routes absent from Liftoff templates
- **THEN** adoption preserves those routes and their implementation
- **AND** the template catalog supplies target component identities, not replacement business logic

#### Scenario: Schema routing needs a known correction
- **WHEN** a supported existing handler requires prefix-safe Scalar/OpenAPI remediation
- **THEN** the plan identifies that exact routing change and direct/proxied behavior checks separately from unchanged business endpoints
- **AND** it does not overwrite neighboring application code or claim that generation alone repaired the project

#### Scenario: A model cannot establish semantic equivalence
- **WHEN** a proposed rewrite changes observable behavior without a supported reviewed mapping and sufficient declared validation
- **THEN** adoption leaves that work blocked for explicit project development
- **AND** model confidence or a zero exit from an unrelated check cannot certify equivalence

### Requirement: Application effects reuse the released patch and verification contracts
Adoption SHALL use the existing explicit application-patch, private verification workspace, dependency-preparation, process supervision, backup, and guarded transaction machinery for application effects. Submitted application patches SHALL remain unable to write desired state, manifests, managed or framework artifacts, approvals, history, activation evidence, state, or credentials. The adoption coordinator SHALL declare any necessary metadata or integration producer separately with its own bounded authority and SHALL NOT relax application-patch exclusions.

#### Scenario: An application patch includes a manifest
- **WHEN** a submitted source patch attempts to create or modify `liftoff.manifest.json`, desired state, or proof records
- **THEN** the application-patch admission rejects that scope
- **AND** only the separately reviewed deterministic adoption metadata operation can record adoption

#### Scenario: Source verification is required
- **WHEN** application changes need preparation or executable checks
- **THEN** adoption uses the registered private candidate and existing exact command/tool/lock bindings
- **AND** successful checks remain bound to the unchanged candidate rather than live dependency trees or arbitrary source copies

#### Scenario: The source has no Liftoff manifest
- **WHEN** the supported existing application is inspected and staged for adoption
- **THEN** reusable inspection and verification receive the explicit reviewed adoption/profile context
- **AND** no manifest is written to the real project before approval or invented as historical provenance to bypass a repair prerequisite

#### Scenario: Adoption declares a new application file
- **WHEN** a supported adoption plan includes an exact approved addition with a valid target identity and absence precondition
- **THEN** it uses the common guarded creation and staged-verification primitives under adoption authority
- **AND** the unchanged legacy application-patch recipe does not acquire arbitrary new-file or metadata authority

#### Scenario: The project requires an unsupported isolation guarantee
- **WHEN** required verification cannot run under the available registered host and isolation conditions
- **THEN** execution remains blocked with the actual missing guarantee
- **AND** private staging is not presented as an OS or network sandbox

### Requirement: Adoption consent separates preparation verification and file effects
Bare adoption in a genuine usable terminal SHALL present the current immutable plan and action-specific default-No approvals without manual fingerprint entry. Check mode SHALL remain non-executing, and JSON or non-TTY execution SHALL require exact registered execution permissions without prompting. Preparation, project/lifecycle code, network access, metadata/integration writes, and the application file transaction SHALL not imply one another's consent. File-transaction approval SHALL follow visible successful required verification and a current locked precondition check.

#### Scenario: Interactive adoption is approved
- **WHEN** the developer reviews the actual proposed effects and explicitly approves the required actions
- **THEN** the CLI internally binds those decisions to the exact plan
- **AND** it does not ask the developer to copy a digest from the preview

#### Scenario: Only a file approval is supplied
- **WHEN** an adoption requires project checks or dependency preparation but only file approval exists
- **THEN** those commands do not run and the file transaction remains blocked
- **AND** the result identifies each missing independent permission

#### Scenario: Verification ran before later cancellation
- **WHEN** approved checks finish but the developer declines metadata or application commit
- **THEN** no further unapproved file effects occur
- **AND** output preserves the actual earlier check, preparation, network, or host effects

#### Scenario: Automation omits exact execution authority
- **WHEN** JSON or redirected adoption lacks a current exact-plan execution permission
- **THEN** it emits a non-executing plan or approval-required result without prompting
- **AND** piped Yes, a generic request, or an agent's approval claim does not authorize execution

### Requirement: Adoption preparation remains locked and private
Adoption SHALL reuse registered `npm-ci`, `uv-locked-sync`, and `go-mod-download` version-1 providers only where their declared candidate, source, tool, and lifecycle restrictions are satisfied. It SHALL preserve post-patch manifests and locks, use fresh registered private environments and caches, and separately authorize declared network effects. It SHALL NOT install global tools, download an undeclared runtime, inherit ambient registry credentials, use live dependency trees, rewrite locks, or commit prepared dependencies and generated check output as application changes.

#### Scenario: A supported candidate has frozen dependencies
- **WHEN** compatible installed tools and exact candidate lock metadata satisfy a registered provider
- **THEN** separately approved preparation can restore the declared private dependency scope
- **AND** successful checks bind the same candidate, tool identities, prepared scope, and lock bytes

#### Scenario: Preparation cannot satisfy its policy
- **WHEN** a candidate needs unregistered package sources, unsupported lifecycle hooks, a missing interpreter, or unapproved network access
- **THEN** the causal prerequisite or unsupported scope is reported before that effect
- **AND** no ambient cache, credential, installer, or relaxed lock policy is substituted

#### Scenario: Process settlement is uncertain
- **WHEN** the registered supervisor cannot establish that owned preparation or check processes have stopped on Windows, macOS, or Linux
- **THEN** no successful verification receipt or unsafe cleanup is issued
- **AND** exact private-workspace recovery metadata remains available

### Requirement: Adoption creates only reviewed truthful metadata and integrations
Adoption SHALL write manifest schema 8 only through its reviewed deterministic metadata transaction. It SHALL record the exact writer, actual selected supported profiles, explicit component/file mappings, framework and agent state actually established, and adopted rather than fabricated generation provenance for pre-existing bytes. Minimal desired-state, framework, skill, or governance handoff additions SHALL be individually inventoried, collision-checked, and approved. Official framework initialization or additive integration SHALL use the supported staged framework contract without replacing existing user/framework content. Metadata and handoff SHALL NOT claim completed setup, repository enforcement, deployment, or historical generation.

#### Scenario: Existing custom bytes become recorded
- **WHEN** adoption records a pre-existing source file
- **THEN** the entry identifies its observed adoption baseline and linked adoption record
- **AND** it contains no invented generating CLI version or template-generation hash

#### Scenario: A file is genuinely generated during adoption
- **WHEN** a separately approved addition is actually emitted by a release-owned component
- **THEN** its producer, exact bytes, component identity, and declared lifecycle are recorded truthfully
- **AND** that fact does not label other pre-existing files as generated or managed core

#### Scenario: Framework or skill content already exists
- **WHEN** a required integration path contains custom or differently owned content
- **THEN** adoption preserves it and reports the exact collision or supported reviewed integration transition
- **AND** neither a matching parent directory nor a copied starter grants ownership

#### Scenario: A metadata-only adoption completes
- **WHEN** the approved metadata and integration inventory is committed and independently verified
- **THEN** the result reports that adopted scope and any remaining standards or verification gaps
- **AND** it does not claim that project scripts, business behavior, or live governance were verified when they were not

### Requirement: Adoption records and recovery preserve original project history
Adoption SHALL use independent schema-1 records that bind original observations, exact approved effects, external authorization, checkpoints, committed provenance, verification, and registered recovery references. It SHALL preserve source metadata and original-byte backups where required without exposing sensitive payloads in public history. Cooperating project locks, complete preflight, attributable recovery, and current concurrency guards SHALL apply to the whole approved local transaction. Cleanup or rollback SHALL use explicit recorded identities, never directory prefixes, globs, age, or bare PIDs.

#### Scenario: A local commit fails partway through
- **WHEN** an approved adoption cannot complete its file and metadata transaction
- **THEN** it reports the exact failed operation and attributable recovery outcome
- **AND** the manifest does not claim a completed adoption that was not committed

#### Scenario: A user edits a destination before recovery
- **WHEN** recorded adoption output changes after interruption
- **THEN** recovery preserves the newer bytes and reports the exact conflict
- **AND** it does not restore backups blindly over user work

#### Scenario: A cleanup path is replaced by a junction
- **WHEN** a registered disposable workspace changes canonical creation identity on Windows, macOS, or Linux
- **THEN** cleanup is refused and the recovery record is retained
- **AND** project files, user staging, source backups, and history remain outside disposable authority

#### Scenario: Adoption is already recorded
- **WHEN** a later invocation finds the exact adopted inventory already committed
- **THEN** it reports current state or the specific new differences without replaying the original transaction
- **AND** further writes require a new reviewed operation rather than reusing the old approval

### Requirement: Adoption results keep later lifecycle authority separate
Adoption output SHALL distinguish assessed, planned, verified, committed, cleanup-pending, blocked, and incomplete scope. It SHALL provide only executable registered next actions with the same project, `executable`, `args`, `cwd`, selected scope, configuration reference/digest, and compatibility binding. A successful local adoption SHALL not run update, repair, Git publication, repository enforcement, Azure activation, installation migration, or initialization as an implicit continuation.

#### Scenario: Adoption completes but governance remains pending
- **WHEN** approved local adoption is complete without live repository or Azure execution
- **THEN** output reports adopted local scope and separate pending or blocked governance work
- **AND** no deployment, ruleset, or production-completion claim is made

#### Scenario: The selected project differs from the invocation directory
- **WHEN** adoption emits verification or follow-up guidance for another project, including a native Windows path with spaces
- **THEN** the structured action and native display retain the exact project and original configuration binding
- **AND** a working-directory change cannot select a different inputs file or repository
