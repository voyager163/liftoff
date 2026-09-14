## ADDED Requirements

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

## MODIFIED Requirements

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
