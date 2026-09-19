## REMOVED Requirements

### Requirement: Liftoff exposes a Node-based CLI
**Reason**: The coordinated release provides a self-contained CLI and retires the end-user Node/npm startup prerequisite and current global-npm installation contract.
**Migration**: Use the qualified native installation or an explicitly reviewed installation handover. Historical npm artifacts remain available, but there is no new npm release or bridge. Preserve Node/npm used by projects and do not reinitialize projects.

## ADDED Requirements

### Requirement: Liftoff starts independently from project toolchains
The system SHALL expose the command `liftoff` through its qualified self-contained installation on Windows, macOS, and Linux. Starting the CLI, displaying help/version/capabilities, and performing supported metadata-only planning or assessment SHALL not require ambient Node.js, npm, Python, or Go. Selected project and official specification-tool prerequisites SHALL remain separate and explicit; the private CLI runtime SHALL not be presented as satisfying a project's Node/npm requirements. Initialization SHALL remain `liftoff init`, and `liftoff create` SHALL remain rejected.

#### Scenario: Run init command
- **WHEN** a developer runs `liftoff init`
- **THEN** initialization starts without requiring an ambient language runtime merely to start Liftoff
- **AND** subsequent selected-project and framework prerequisites remain separately checked and authorized

#### Scenario: Run non-interactive init command
- **WHEN** a developer runs `liftoff init my-app --pattern rag --cloud azure --region eastus --spec openspec --agents copilot --no-frontend --yes`
- **THEN** supplied decisions resolve without prompting for framework, API framework, infrastructure tool, database, cache, observability, or developer portal choices
- **AND** existing independent overwrite, project-tool, dependency, and global-profile consent remains required where applicable

#### Scenario: Obsolete create command is rejected
- **WHEN** a developer runs `liftoff create`
- **THEN** Liftoff exits 1 without project or machine side effects and identifies `liftoff init` as its replacement

#### Scenario: Run without ambient Node or npm
- **WHEN** a qualified native installation is invoked on a supported host without Node/npm on PATH
- **THEN** help, version, capability inspection, and supported read-only assessment remain usable
- **AND** the CLI does not invoke a project-local shim or install a runtime to start itself

#### Scenario: A Node project lacks its own toolchain
- **WHEN** the native CLI selects a Fastify or Vue project whose required Node/npm toolchain is missing
- **THEN** project readiness reports that specific prerequisite
- **AND** it neither treats the bundled CLI runtime as the project toolchain nor removes the need for project dependencies

### Requirement: Lifecycle command roles are explicit before project initialization
Help, command definitions, and capability output SHALL expose `assess`, `adopt`, `skills` management, and `installation` inspection/migration alongside existing initialization, fresh-target migration, update, repair, doctor, governance, and upgrade. Help SHALL identify target and scope requirements, read-only versus write-capable modes, supported profiles, compatibility, independent permissions, and actual installed limitations without probing tools or providers. Whole-project assessment and user-scope skills SHALL work without prior project initialization; that SHALL NOT make project-only mutation commands silently initialize metadata.

#### Scenario: Discover assessment and adoption
- **WHEN** help is requested outside a project
- **THEN** it identifies read-only `liftoff assess` and reviewed in-place `liftoff adopt` as separate commands
- **AND** it distinguishes supported-stack adoption from source-preserving fresh-target `liftoff migrate`

#### Scenario: Discover personal skill delivery
- **WHEN** a developer inspects `liftoff skills` help before creating a project
- **THEN** it describes selected-host user-scope inspection and reviewed delivery with overlap and collision handling
- **AND** it does not recommend initializing a throwaway project or blindly installing three copies

#### Scenario: Inspect installation without changing a project
- **WHEN** `liftoff installation inspect` or installation help is requested inside a repository
- **THEN** output identifies installation scope and the separate explicit migration journey
- **AND** it does not run project init, update, adoption, repair, or activation migration

#### Scenario: A supported project command has no project
- **WHEN** a mutation command requiring initialized metadata cannot resolve a valid project boundary
- **THEN** it reports that missing prerequisite and a real read-only or reviewed next step
- **AND** it does not reinterpret the command as initialization or adoption

### Requirement: New review journeys have human-first exact approval
In-place adoption and skill delivery/migration SHALL display immutable project- or user-bound plans and offer action-specific Yes/No approval with default No on genuine usable terminals. Normal users SHALL not need to copy or type fingerprints. Check and capability modes SHALL remain non-executing, while JSON/non-TTY execution SHALL require the exact registered plan and independent execution permissions without prompting. Generic Yes, host autopilot, piped input, an agent-authored approval, or a change of command name SHALL not widen authority.

#### Scenario: The developer approves a displayed adoption plan
- **WHEN** required independently authorized verification succeeds and the developer explicitly approves the current file effects
- **THEN** the CLI binds the interactive decision to the immutable fingerprint internally
- **AND** it rechecks scope and preconditions before any file transaction

#### Scenario: JSON has no execution permission
- **WHEN** a new review journey is requested with JSON or non-TTY input without exact execution authority
- **THEN** it returns the registered non-executing preview or approval-required result
- **AND** it does not prompt, consume piped Yes as consent, or begin side effects

#### Scenario: Later approval is declined
- **WHEN** earlier separately approved preparation or checks have run but file or delivery approval is declined
- **THEN** no further unapproved effects occur
- **AND** output states earlier actual effects rather than claiming the host and project were untouched

### Requirement: Every continuation carries complete native execution context
Help-derived remedies, completion guidance, JSON, and `nextActions` SHALL use the shared versioned continuation contract with `executable`, separate `args`, `cwd`, `scope`, canonical `project` or explicit user/installation target, configuration reference and digest binding, compatibility identity, and required approval. Human command shortening SHALL preserve an independently recorded exact target and working directory. A relative `--inputs` or other configuration path SHALL remain bound to the original resolved file when a continuation changes directories. Secrets SHALL remain opaque protected references.

#### Scenario: Azure inputs are supplied from another directory
- **WHEN** governance is invoked for an explicit project with a relative `--inputs` file
- **THEN** plan, approval, execution, verify, and resume actions preserve the same resolved file and digest
- **AND** none drops the option or resolves it relative to a new working directory

#### Scenario: A consumed configuration value changes
- **WHEN** configuration used by the requested phase changes after review
- **THEN** the continuation requires renewed planning and approval for affected work
- **AND** it does not reuse a fingerprint for different effective inputs

#### Scenario: A Windows path contains metacharacters
- **WHEN** a next action targets a Windows drive or UNC path containing spaces, apostrophes, or shell-significant characters
- **THEN** its argument array preserves the literal value and its PowerShell display is safe
- **AND** equivalent POSIX displays preserve the same target, scope, and configuration binding on macOS and Linux

#### Scenario: Discovery cannot prove an implicit target
- **WHEN** command shortening would depend on ambiguous aliases, textual prefixes, or an unknown invocation boundary
- **THEN** guidance retains the explicit canonical target and working directory
- **AND** unsafe links, junctions, escapes, and case/normalization collisions do not become valid through presentation

### Requirement: Capability negotiation preserves command-specific JSON identities
The new public command/capability envelope schema 1 SHALL remain independent from registered CLI result/report bodies. Existing commands SHALL not acquire a schema-1 wrapper or be relabeled solely to participate in the shared protocol. Current governance setup/execution output SHALL move explicitly to schema 3; unchanged update output 3, governance-assessment report 1, repair contract 1/report 2, and registered legacy record identities SHALL retain their respective contracts. Help and negotiation SHALL identify the relevant command schema rather than present one universal JSON version.

#### Scenario: A caller invokes repair after capability negotiation
- **WHEN** a caller negotiates the shared schema-1 protocol and requests an unchanged current repair JSON result
- **THEN** the repair body retains report schema 2 and repair contract 1
- **AND** negotiation does not rewrite the body or historical repair records

#### Scenario: A caller requests governance output
- **WHEN** the current governance setup or execution command emits JSON
- **THEN** the body identifies output schema 3 and its actual selected scope
- **AND** the shared envelope version does not replace the governance body version or reinterpret older stored output

## MODIFIED Requirements

### Requirement: CLI reports the running Liftoff version
The system SHALL expose the running Liftoff release version through `liftoff --version` and general help from its installed build identity without requiring a project, ambient runtime, registry access, or any network operation. The running CLI version SHALL remain distinct from project generation, activation-package, protocol, and bundled-runtime versions.

#### Scenario: Developer requests the installed version
- **WHEN** a developer runs `liftoff --version`
- **THEN** the CLI exits successfully after printing the exact installed Liftoff release version
- **AND** output retains the one-line `Liftoff <version>` format

#### Scenario: General help identifies the running version
- **WHEN** a developer runs `liftoff help` or invokes the CLI without a command
- **THEN** general help identifies the running Liftoff release version

#### Scenario: Version output works from the packed installation
- **WHEN** installed-artifact qualification invokes `--version` through the packaged native entry point outside the build checkout
- **THEN** the reported version matches the artifact's verified build identity
- **AND** it does not resolve a source-tree or ambient npm package version

### Requirement: CLI exposes discovery and validation commands
The system SHALL expose initialization, generation planning, reviewed managed update and checks, whole-project assessment, supported in-place adoption, fresh-target migration, skills and installation management, pattern/provider/region discovery, validation, local-development and infrastructure helpers, and diagnostics. Supported activation migration SHALL remain under the reviewed update command. `--json` SHALL describe output format rather than supply any safety or authorization bypass.

#### Scenario: List supported patterns
- **WHEN** `liftoff patterns` runs
- **THEN** all nine GenAI patterns including the generic uncertainty option retain their honest scaffold status

#### Scenario: Search regions
- **WHEN** `liftoff regions search korea --cloud azure` runs
- **THEN** matching region display names and slugs are listed

#### Scenario: Run diagnostics
- **WHEN** doctor runs
- **THEN** it reports context-selected readiness without modifying the project, workstation, or preview receipts

#### Scenario: Check a project for drift
- **WHEN** a user or automation runs `liftoff update --check`
- **THEN** it previews compatibility, managed-core drift, eligible provisioning, and activation migration/revalidation without prompting or changing project files
- **AND** it discloses its external receipt instead of comparing production files with new templates

#### Scenario: Apply safe drift by default
- **WHEN** a write-capable normal update plan is requested
- **THEN** a matching prior preview and explicit exact-plan approval are required before safe core changes apply
- **AND** core conflicts remain skipped without an approved forced variant

#### Scenario: Force stays inside the core boundary
- **WHEN** a forced update is requested
- **THEN** only its separately previewed eligible core conflicts or exact retired aliases can be changed
- **AND** project bytes and provisioning collisions remain protected

#### Scenario: Migrate an existing project
- **WHEN** `liftoff migrate ../legacy-app` runs
- **THEN** it preserves the source and creates only its allowed fresh adjacent target
- **AND** it is not repurposed as in-place adoption or activation migration

### Requirement: Packaged README documents the current CLI lifecycle
The packaged root README SHALL retain concise first-use, supported-workload, framework/agent, exact-Git-root initialization, safety, and diagnostic guidance while documenting native CLI startup separately from project prerequisites. Maintenance SHALL lead with update check and human-first plan approval and distinguish CLI upgrade, installation handover, in-place adoption, fresh-target migration, managed update, repair, activation migration, and read-only assessment. It SHALL link detailed contracts and describe only qualified production capabilities, not claim completion from generated instructions. Historical npm cutover SHALL not be advertised as a new npm or bridge release.

#### Scenario: Review first-use workflow
- **WHEN** the README is read
- **THEN** qualified installation and interactive initialization lead the guide, with assessment/adoption available for existing applications
- **AND** Power Apps is not listed as supported or Node/npm as a CLI startup prerequisite

#### Scenario: Review command lifecycle
- **WHEN** a user follows lifecycle links
- **THEN** command roles and the replacement of create by init remain documented
- **AND** activation migration stays under update while adopt and fresh-target migrate remain distinct

#### Scenario: Understand initialization safety
- **WHEN** initialization guidance is read
- **THEN** staging, target/conflict behavior, manifest guards, and independent consent remain discoverable

#### Scenario: Understand update safety
- **WHEN** update guidance is read
- **THEN** it explains read-only preview, external receipts, exact default-No approval without manual hash entry, protected production files, create-only expansion, preserved history, partial recovery, and removed `--apply`

#### Scenario: Understand machine-readable and exit-code behavior
- **WHEN** the CLI reference is read
- **THEN** it identifies update output 3, governance output 3, and distinct new protocol and unchanged repair identities
- **AND** it distinguishes completed scope, rejected or failed operations, drift, consistent incomplete verification, and committed partial effects

#### Scenario: Review contributor workflow
- **WHEN** the contribution link is followed
- **THEN** root build, test, check, installed-package qualification, and coordinated release procedures remain documented without a workspace selector

### Requirement: Update approval has a strict plan-bound CLI surface
Update SHALL accept `--approve-plan <fingerprint>` only with a complete valid fingerprint for its effective normal or forced plan. Missing, abbreviated, malformed, conflicting, or check-combined approval values SHALL be rejected before mutation. Normal interactive approval SHALL show the immutable plan through genuine usable input/stderr TTYs, default to No, and bind the decision internally without manual fingerprint entry. JSON and non-TTY apply SHALL require exact explicit machine approval without prompting. Redirected answers, force, defaults, or a generic Yes SHALL not substitute.

#### Scenario: CI supplies exact approval
- **WHEN** a matching receipt and full effective fingerprint are supplied through `--approve-plan`
- **THEN** update proceeds without prompting only after current compatibility and preconditions pass

#### Scenario: CI omits approval
- **WHEN** noninteractive apply has a receipt but no exact-plan approval
- **THEN** it exits 1 with approval-required guidance and no project write

#### Scenario: The fingerprint belongs to another plan
- **WHEN** approval names a different project, target, or normal/force variant
- **THEN** apply reports the mismatch without selecting a fallback plan

#### Scenario: Check receives an approval flag
- **WHEN** check is combined with `--approve-plan`
- **THEN** usage is rejected before issuing a receipt or touching project files

#### Scenario: Interactive cancellation
- **WHEN** the user declines or cancels the approval prompt
- **THEN** apply performs no project mutation and reports cancellation rather than success

#### Scenario: JSON is used interactively
- **WHEN** a terminal-backed apply uses JSON without exact execution approval
- **THEN** it reports approval-required without prompting or writing
- **AND** stdout remains one versioned result and exact approval flags remain the machine-execution path

#### Scenario: Interactive approval requires no typed fingerprint
- **WHEN** a genuine terminal user approves the displayed current update plan
- **THEN** the immutable fingerprint is bound internally and rechecked under the project lock
- **AND** no manual hash copy is required

### Requirement: CLI exposes self-upgrade as a maintenance command
The CLI SHALL expose `liftoff upgrade` as installation maintenance distinct from project update. Its command definition SHALL retain `--check`, `--json`, and command help, reject positional project arguments, and reject unrelated consent or plan flags before release lookup or installation. Explicit invocation of routine owner-preserving upgrade SHALL authorize only its internally bound exact verified target through the proven current owner, without an additional Liftoff confirmation or fingerprint flag. Help SHALL distinguish that authorization from separately reviewed installation-owner migration, elevation, and project work, none of which upgrade authorizes. Legacy npm handover SHALL remain a separate installation-migration journey rather than global npm replacement.

#### Scenario: Show upgrade help
- **WHEN** a developer runs `liftoff upgrade --help`
- **THEN** help describes owner-aware CLI replacement, non-installing check, JSON, dedicated-command authorization, separately approved legacy handover, and separation from project update
- **AND** it performs no installation, registry lookup, or package-manager configuration refresh

#### Scenario: Reject a project argument
- **WHEN** a developer runs `liftoff upgrade ./project`
- **THEN** parsing exits 1 before filesystem or network side effects

#### Scenario: Reject unrelated consent flags
- **WHEN** a developer supplies `--force`, `--yes`, `--install-tools`, or `--install-dependencies` to upgrade
- **THEN** the unsupported flag is rejected
- **AND** another command's flag cannot authorize self-upgrade

### Requirement: Upgrade follows shared output and exit conventions
Human upgrade output SHALL use the shared terminal renderer, and JSON SHALL retain its registered versioned body without decoration. The dedicated owner-preserving upgrade invocation SHALL retain the same exact validated operation authority in TTY, redirected, and JSON modes without a second Liftoff prompt or fingerprint flag. JSON itself SHALL add no authority, and `--check` SHALL remain non-installing in every presentation mode. Exit 0 SHALL mean current or verified upgraded scope, exit 2 SHALL identify a read-only check's installable update, and exit 1 SHALL identify invalid, blocked, or failed scope. Partial installation failures SHALL describe actual effects and remaining recovery without claiming verified replacement. Upstream availability, installation-owner availability, unsupported targets, and manual action SHALL remain distinguishable.

#### Scenario: Run in a redirected terminal
- **WHEN** upgrade output is redirected without JSON
- **THEN** it uses deterministic plain presentation without prompting
- **AND** the explicitly invoked owner-preserving operation retains its imperative semantics only for the internally bound verified target, without an extra approval flag or owner switch

#### Scenario: Run JSON mode
- **WHEN** upgrade uses `--json`
- **THEN** stdout contains only the documented versioned result
- **AND** diagnostics or child progress use stderr while JSON neither adds authority beyond the dedicated command nor weakens read-only check

### Requirement: CLI exposes deterministic governance setup commands
The CLI SHALL retain governance inspection/execution, approval, protected credential enrollment, and recovery with strict syntax and schema-3 command output. Explicit scopes SHALL be `local`, `repository`, `activation`, and `lifecycle`; direct governance invocations SHALL continue to default to activation rather than silently select repository-only. Output SHALL separate journey/local/repository/migration/activation/lifecycle progress. Dependency-ready planning SHALL not require already-granted approval, selected/executed phase identity SHALL remain distinct from current next readiness, and neither scope nor JSON SHALL supply authorization. Continuations SHALL retain project and configuration bindings.

#### Scenario: Run governance status outside a project
- **WHEN** no supported Liftoff manifest is resolvable, including an ordinary Git-only repository
- **THEN** setup commands fail with a project-root remedy without initialization or mutation

#### Scenario: Inspect governance identity
- **WHEN** governance JSON is requested
- **THEN** it identifies running CLI/executable, policy 8, credential-policy schema 2, activation contract 4, graph schema 3, current schema identities, and actual graph digest
- **AND** recorded generator identity remains separate and no independent setup-skill version is added

#### Scenario: Preview next transitions
- **WHEN** governance plan is requested
- **THEN** it reports dependency-ready plans, authority, evidence, real operations, and cost scope without execution
- **AND** external preview persistence is disclosed rather than confused with approval

#### Scenario: Apply a ready transition
- **WHEN** `apply-next --json --execute` selects an executable evidence-ready phase with current required approval
- **THEN** only allowlisted operations in that exact scope execute
- **AND** successful state is persisted transactionally only after outcome validation

#### Scenario: Preview a ready transition
- **WHEN** apply-next is called without `--execute`
- **THEN** it reports exact operations and required execution authority without local or remote mutation

#### Scenario: Adapter returns a phase-forbidden terminal result
- **WHEN** an adapter returns an undeclared terminal result or incomplete required evidence
- **THEN** execution reports a blocker without successful invalid evidence or descendant authorization

#### Scenario: Verification is consistent before setup starts
- **WHEN** a supported project has no activation state and no inconsistent required artifacts
- **THEN** verify reports consistency, incomplete not-started selected scope, `ok: false`, and exit 2
- **AND** it identifies the next local boundary without manufacturing state

#### Scenario: A valid bootstrap seed is still active
- **WHEN** a supported seed is intact with no competing work or contradictory finalization record
- **THEN** local setup remains incomplete rather than inconsistent merely because finalization is pending
- **AND** publication remains separately approved

#### Scenario: Active seed contradicts stored archive completion
- **WHEN** current state claims OpenSpec archival while the same seed remains active
- **THEN** verification reports an inconsistency instead of ordinary pending progress

#### Scenario: Verification cannot inspect state
- **WHEN** a required shared governance artifact is malformed
- **THEN** verify exits 1 with inconsistent, incomplete, indeterminate selected scope and `ok: false`
- **AND** local scope does not hide malformed shared identity or state

#### Scenario: Resume after a blocker
- **WHEN** a developer resumes after repairing a blocker
- **THEN** resume recalculates selected-scope readiness using the same project and configuration binding without executing operations
- **AND** repaired failures can be retried explicitly without repeating unchanged verified work

#### Scenario: Unsupported governance syntax is supplied
- **WHEN** a subcommand, flag, scope, or positional combination is unsupported
- **THEN** it fails before project discovery or mutation

#### Scenario: Distinguish selection from post-transition readiness
- **WHEN** seed-valid executes successfully
- **THEN** `selectedPhase` and `executedPhase` identify seed-valid while `nextReadyPhase` comes from fresh selected-scope inspection
- **AND** failed execution names no successfully executed phase

#### Scenario: Explain an OpenSpec validation failure
- **WHEN** OpenSpec returns a safe failure diagnostic
- **THEN** the command and exit condition are explained with bounded text stripped of terminal controls

#### Scenario: Diagnostic includes credential-shaped content
- **WHEN** framework output contains credential-shaped content
- **THEN** it is withheld before truncation and never copied into reports or activation state

#### Scenario: Historical state requires reconciliation
- **WHEN** state uses a recognized non-executable v1, v2, or v3 activation identity
- **THEN** commands explain exact declared migration eligibility or the unavailable-migration blocker
- **AND** they do not rewrite history, change old digest meanings, or recommend fabricated receipts

#### Scenario: Production capability is not implemented
- **WHEN** a required producer is absent or unqualified for an advertised supported activation path
- **THEN** that path blocks coordinated release qualification rather than shipping a placeholder as implemented
- **AND** genuinely unsupported external capabilities remain explicit without invalidating completed local work

#### Scenario: An existing governance caller omits scope
- **WHEN** a caller invokes governance status, plan, resume, verify, or apply-next without selecting scope
- **THEN** the effective scope remains activation in the result and applicable continuations
- **AND** repository-only execution or success is not substituted even if that narrower path is already complete

#### Scenario: Repository scope is explicitly selected
- **WHEN** a developer plans or executes the registered repository-only path
- **THEN** the CLI reports repository discovery, source publication, check qualification, enforcement approval, owned-control reconciliation, and readback independently
- **AND** it makes no Azure call and does not mark production phases complete merely to reach enforcement

#### Scenario: Azure discovery lacks a real target
- **WHEN** an Azure-dependent phase lacks explicit valid subscription and tenant bindings or receives placeholders
- **THEN** it reports the missing exact input and bound continuation before discovery
- **AND** it does not substitute the ambient account's default subscription

### Requirement: Governance verification reports selected-scope completion honestly
Schema-3 verification SHALL return 0 for consistent complete selected scope, 2 for consistent incomplete scope, and 1 for inconsistency or failed inspection. `ok` SHALL mean selected-scope success and SHALL be true only with both `consistent` and `complete`; those fields and distinct progress groups SHALL remain explicit. Status, plan, and resume SHALL retain exit 0 for successful inspection even when reporting incomplete work. Committed execution followed by failed inspection SHALL preserve committed progress and indeterminate readiness as a partial outcome. Historical schema semantics SHALL not be rewritten in stored records.

#### Scenario: Local setup is complete while activation is pending
- **WHEN** local verification succeeds but publication or activation has not started
- **THEN** local-scoped verify exits 0 with `ok: true` and local completion
- **AND** pending activation remains separately visible

#### Scenario: Only one local phase is complete
- **WHEN** local state is consistent but further local work remains
- **THEN** local verify exits 2 with `consistent: true`, `complete: false`, and `ok: false`
- **AND** it does not call the project inconsistent or complete

#### Scenario: Readiness cannot be observed after commit
- **WHEN** execution commits successfully but reinspection fails
- **THEN** the result retains the executed phase and failure detail
- **AND** reports indeterminate next readiness rather than the executed phase as a future action

#### Scenario: Repository enforcement is complete without production
- **WHEN** repository-scoped checks, approved enforcement, and current readback are complete while Azure or production work is pending
- **THEN** repository verify succeeds only for repository scope
- **AND** activation verify remains incomplete or reports its actual blocker without reusing repository proof as production qualification

#### Scenario: Unscoped verification cannot report repository-only success
- **WHEN** a current project has complete repository enforcement but consistent incomplete activation and verification is invoked without scope
- **THEN** verify evaluates activation, returns schema 3 with `consistent: true`, `complete: false`, and `ok: false`, and exits 2
- **AND** only an explicitly repository-scoped verification can report that narrower completion

### Requirement: Setup drives the approved end-to-end journey
The canonical native setup integration SHALL guide supported projects through local readiness, required repair/migration, publication, the explicitly requested repository-only or activation path, separately approved execution, and independent verification. It SHALL retain local-only operation, preserve progress when later authority is declined, and negotiate actual installed capabilities. Full-journey success SHALL require the requested immediate migration and activation scope to be verified, while a repository-only stopping point SHALL be labeled narrowly and leave production work visible.

#### Scenario: Developer approves the full journey
- **WHEN** supported prerequisites hold and the developer approves each required scope
- **THEN** setup continues beyond local preparation through the real approved cloud/governance plan
- **AND** completion depends on actual deployment, qualification, and enforcement readback

#### Scenario: Developer declines activation
- **WHEN** local readiness is complete but later approval is declined
- **THEN** output reports local completion and activation not performed
- **AND** it does not claim a deployed governed system

#### Scenario: Developer requests repository-only enforcement
- **WHEN** the developer explicitly selects repository scope and approves its current plan
- **THEN** setup completes only the registered repository path and any separately reviewed main-update hold
- **AND** it does not create a production release/tag or fabricate cloud qualification

### Requirement: Approval credential and recovery commands are executable interfaces
Governance SHALL expose real exact-plan approval persistence, protected credential enrollment, and registered recovery through its command registry. Genuine interactive approval SHALL show exact immutable scope and default to No without requiring manual fingerprint or approval-file entry; machine approval SHALL bind the same exact plan and current schema-4 envelope. Persisting approval SHALL not execute the plan. Credential input SHALL use private operator channels or approved secure references, never argv or chat values. Recovery SHALL validate current conditions and the exact compensation boundary rather than force-unlock, remove protections, or restore arbitrary state.

#### Scenario: A dependency-ready phase awaits approval
- **WHEN** a phase has a complete plan but no valid approval
- **THEN** the CLI offers the actual human-first approval command and exact automation alternative with its plan identity
- **AND** the user is not asked to hand-create a file or manually copy a hash for normal interactive approval

#### Scenario: An automation caller enrolls a credential
- **WHEN** approved enrollment uses explicitly selected protected stdin or a supported secure reference
- **THEN** the value is excluded from command arguments, output, evidence, and source files

#### Scenario: Credential permission scope is broader than runner metadata
- **WHEN** the plan requires GitHub's `organization_administration:read` grant
- **THEN** human and machine review disclose its broader organization, billing and Actions-settings read reach and the narrower intended Liftoff operations
- **AND** fresh exact approval is required under policy 8 and credential-policy schema 2; an old policy, generic Yes or approval of the design supplies no credential-use authority

#### Scenario: A migration is partially executed
- **WHEN** recovery is requested for recorded partial effects
- **THEN** the CLI identifies the current checkpoint and exact permitted recovery plan
- **AND** it does not automatically rerun the original mutation or retag historical approval
