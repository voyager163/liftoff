## MODIFIED Requirements

### Requirement: Apply failures are observable and recoverable
The system SHALL preflight all artifact paths and destinations before mutation, SHALL treat only a confirmed missing path as absent, SHALL acquire a cooperating project mutation lock before writing, and SHALL stop with exit code 1 when a write, atomic replacement, move cleanup, manifest write, or lock acquisition fails. A failed apply MUST name the affected artifact and operation, MUST NOT print a successful completion summary, and MUST NOT record a failed mutation as completed. Recovery SHALL restore only an attributable unchanged transaction write set, SHALL preserve destination modes where the host filesystem supports them, SHALL clean partial temporary files, and SHALL NOT overwrite a concurrently changed destination during rollback.

#### Scenario: Destination write fails
- **WHEN** apply cannot write an artifact because of permissions, path type, storage, or another filesystem error
- **THEN** it exits 1 with the artifact path and underlying operation, and the manifest does not claim that write succeeded

#### Scenario: Move cleanup fails
- **WHEN** apply writes a moved artifact destination but cannot remove the verified old managed path
- **THEN** it exits 1, reports the cleanup failure, and does not silently report a completed move

#### Scenario: Preflight rejects every unsafe mutation before writes
- **WHEN** any planned artifact path or destination fails project-boundary or collision validation
- **THEN** apply performs no artifact mutation and reports the preflight failure

#### Scenario: Retry after a partial filesystem failure
- **WHEN** a developer corrects the filesystem problem and reruns update after a failed apply
- **THEN** reconciliation detects the actual bytes on disk and can safely converge the project without manual manifest editing

#### Scenario: Retired alias transaction rolls back
- **WHEN** update deletes a retired alias file but fails before the manifest rewrite is committed
- **THEN** the alias file and manifest are restored to their pre-update bytes
- **AND** the command reports rollback rather than claiming alias removal

#### Scenario: Cooperating writer lock blocks concurrent mutation
- **WHEN** another Liftoff process already holds the project mutation lock
- **THEN** update exits 1 before writing any managed artifact
- **AND** it reports that a cooperating mutation is already in progress

#### Scenario: Rollback preserves a concurrently changed destination
- **WHEN** update needs rollback after writing a destination and that destination changed again before rollback can restore it
- **THEN** update preserves the newer destination bytes
- **AND** it reports the exact path as requiring developer review instead of clobbering the concurrent change

#### Scenario: Partial temporary files are cleaned up
- **WHEN** a temporary file is created for an atomic write and the write later fails
- **THEN** update removes the temporary file when it can do so safely
- **AND** it does not leave that partial path as a new managed artifact

### Requirement: Force extends apply only to conflicted managed-core files and exact retired aliases
The system SHALL accept `--force` directly on plain `liftoff update` and SHALL overwrite only conflicted managed-core files or delete exact retired generated setup aliases after the existing conflict, path, transaction, and supported-project guards pass. It SHALL identify exactly which core files can be overwritten or retired aliases can be removed, SHALL exclude all project-owned and unknown legacy artifacts from force authority, SHALL reject retired workload manifests before forceable reconciliation begins, and SHALL print a commit-first warning when the project is a Git repository with uncommitted changes. The system SHALL reject `--force` together with `--check`.

#### Scenario: Force overwrites a managed-core conflict
- **WHEN** a developer runs `liftoff update --force` with a conflicted managed-core file
- **THEN** that core file is overwritten with the current rendering without an interactive prompt

#### Scenario: Force cannot overwrite production source
- **WHEN** application source differs from the current starter and the developer runs `liftoff update --force`
- **THEN** the source file is not part of the force mutation set
- **AND** its bytes remain unchanged

#### Scenario: Force cannot overwrite a provisioning collision
- **WHEN** a newly selected component has a destination collision and the developer runs `liftoff update --force`
- **THEN** provisioning remains blocked and the existing destination is preserved

#### Scenario: Force deletes a modified retired setup alias
- **WHEN** an exact retired generated setup alias was modified after generation
- **THEN** `liftoff update --force` deletes that exact alias file and removes its manifest entry
- **AND** unrelated or unknown orphan files remain untouched

#### Scenario: Force cannot bypass retired workload rejection
- **WHEN** a project manifest or desired-state input identifies the retired `power-apps-code-app` workload and the developer runs `liftoff update --force`
- **THEN** update exits before managed-artifact classification or deletion
- **AND** it leaves the project's application files and historical state unchanged

#### Scenario: Force with check is rejected
- **WHEN** a developer runs `liftoff update --check --force`
- **THEN** the command exits 1 before project mutation and explains that a read-only check cannot authorize overwrites

#### Scenario: Removed apply flag is rejected
- **WHEN** a developer runs `liftoff update --apply`
- **THEN** the command exits 1 before project discovery or writes and directs the developer to plain `liftoff update`

#### Scenario: Dirty worktree warning
- **WHEN** a developer runs an update that can write in a Git repository with uncommitted changes
- **THEN** the command prints a hint to commit before applying and proceeds within the managed-core boundary

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

### Requirement: Update reconciles managed phase definitions without owning execution state
Normal managed-core update SHALL reconcile the canonical phase graph and setup integrations. It SHALL preserve user-owned activation state and evidence, mark policy-incompatible active work as reconciliation-required, and never silently advance, reset, delete, or rewrite a phase. Historical activation bytes that are readable only for diagnosis SHALL remain preserved unless an explicit supported migration path in the compatibility matrix authorizes a transactional rewrite.

#### Scenario: Phase graph has managed drift
- **WHEN** `liftoff update --check` detects a newer managed graph
- **THEN** it reports the graph and setup integration changes without modifying user-owned state

#### Scenario: Updated graph affects active work
- **WHEN** plain update installs the reviewed graph
- **THEN** the next governance status reports the affected phases and required reconciliation
- **AND** performs no remote mutation

#### Scenario: Historical phase state remains compatible
- **WHEN** existing evidence satisfies the new graph
- **THEN** update preserves it and governance verification records compatibility

#### Scenario: Historical diagnostic-only state is preserved
- **WHEN** a supported project contains historical v1 activation state that remains readable only for diagnosis
- **THEN** update preserves those user-owned bytes
- **AND** it does not silently rewrite them as current executable state while applying managed-core updates

### Requirement: Update applies the activation compatibility matrix
The system SHALL maintain an explicit compatibility matrix among supported manifest, policy, activation-contract, phase-graph, activation-state, evidence-header, approval-envelope, compatibility-metadata, supersession, and credential-policy versions. The current executable set SHALL be manifest version 7, policy version 6, activation contract version 2, phase graph schema version 1, activation state schema version 2, evidence header schema version 2, approval envelope schema version 2, compatibility metadata schema version 2, supersession schema version 1, and credential-policy schema version 1. It SHALL migrate only supported historical representations transactionally, SHALL preserve known historical v1 activation history as diagnostic-only bytes rather than executable proof, and SHALL leave future or incompatible identities untouched and blocked.

#### Scenario: Historical activation state is supported
- **WHEN** update reads a supported older manifest, contract, or schema that the compatibility matrix marks as upgradeable to the current executable set
- **THEN** check mode reports the complete migration without writing
- **AND** apply writes the new representation only after every managed-artifact and user-state migration preflight succeeds

#### Scenario: Historical v1 activation history is diagnostic-only
- **WHEN** a project records activation contract or user-owned activation state using the historical v1 identity
- **THEN** update reports that history as diagnostic-only and reconciliation-required or unsupported for execution
- **AND** it preserves the original state and evidence bytes without automatic migration

#### Scenario: Activation identity is from the future
- **WHEN** a project records a newer unsupported contract or schema version
- **THEN** update and setup block without downgrading or rewriting it
- **AND** report the exact unsupported field and required Liftoff upgrade

#### Scenario: Policy and activation contract are incompatible
- **WHEN** their versions are individually known but their combination is absent from the compatibility matrix
- **THEN** verification reports the incompatible pair
- **AND** no phase advances
