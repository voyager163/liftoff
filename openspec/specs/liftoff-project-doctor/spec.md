## Purpose

Define the layered, read-only `liftoff doctor` diagnostics covering environment, project, runtime, and cloud readiness, configured by the project manifest.

## Requirements

### Requirement: Doctor runs layered diagnostics selected by context
The system SHALL run `liftoff doctor` as layered read-only diagnostics with native CLI and environment layers in every context. Project, runtime, and cloud-from-manifest layers SHALL run only after locating a supported generated or adopted manifest through project-root discovery; explicit `--cloud` SHALL continue to request cloud checks outside a project. A malformed, unreadable, dangling, symlinked, or retired manifest boundary SHALL stop discovery rather than fall back to another project or ordinary environment-only execution for that same path. Diagnosis SHALL NOT install, migrate, issue preview receipts, refresh package-manager sources, or change configuration.

#### Scenario: Full preflight inside a project
- **WHEN** a developer runs `liftoff doctor` inside a supported generated or adopted project
- **THEN** the output reports CLI, environment, project, runtime, and cloud layers grouped and labeled
- **AND** installation readiness is distinct from the selected project's readiness

#### Scenario: Diagnostics outside a project
- **WHEN** a developer runs `liftoff doctor` outside any generated project without flags
- **THEN** only the CLI and environment layers run
- **AND** missing project initialization does not prevent native installation diagnosis

#### Scenario: Doctor never writes
- **WHEN** any doctor run completes
- **THEN** no project, environment, preview-receipt, or telemetry notice-state file is created or modified
- **AND** npm, Homebrew, WinGet, PATH, and source configuration remain unchanged

#### Scenario: Broken inner manifest blocks outer-project fallback
- **WHEN** a nested directory contains a malformed, unreadable, dangling, or retired `liftoff.manifest.json` and an ancestor contains a different valid project
- **THEN** doctor stops at the nested boundary with an error
- **AND** it does not walk outward to diagnose the ancestor project instead

### Requirement: The manifest configures project-aware checks
The system SHALL read the normalized manifest to configure diagnostics. Cloud checks SHALL target a declared API workload cloud with `--cloud` acting as an override; a workload without declared cloud infrastructure SHALL not inherit a default cloud. Environment and runtime checks SHALL target the selected supported workload, API stack when applicable, spec workflow, configured coding agents, optional requested integrations, and declared framework contract. The project layer SHALL verify that the manifest loads, required managed-core artifacts exist, and declared framework integration markers are present; project provenance SHALL NOT become an additional managed-file existence or restoration contract. A retired workload discriminator SHALL be rejected before deeper workload-specific diagnostic selection.

Checks SHALL bind the selected supported profile and exact registered managed-core requirements. Generated, adopted, and repaired provenance SHALL NOT authorize restoring project-owned files or asserting that custom bytes were generated.

#### Scenario: Cloud checks come from an API manifest
- **WHEN** doctor runs inside an API project whose manifest records Azure
- **THEN** Azure authentication checks run without any `--cloud` flag
- **AND** their result does not determine unrelated local or repository-only completion

#### Scenario: Structure failures surface
- **WHEN** a required managed-core manifest artifact is missing from disk
- **THEN** the project layer reports a failure naming the missing artifact
- **AND** it does not create the file

#### Scenario: Power Apps does not inherit Azure checks
- **WHEN** doctor encounters a retired Power Apps manifest
- **THEN** it reports unsupported workload before Azure or former Power Apps diagnostic selection

#### Scenario: Worker tooling check
- **WHEN** doctor runs inside a worker-enabled Azure project without Azure Functions Core Tools installed
- **THEN** the output includes a warning with an installation remedy

#### Scenario: Framework checks come from the manifest
- **WHEN** doctor runs inside a supported project configured for Spec Kit, Copilot, and Claude Code
- **THEN** it checks the pinned Spec Kit contract and both recorded integrations without requiring a workflow flag

#### Scenario: Missing framework marker fails project readiness
- **WHEN** a manifest declares an initialized agent integration whose required marker is missing
- **THEN** the project layer reports a failure naming that integration and its framework-owned repair command

#### Scenario: Legacy v2 framework state is not fabricated
- **WHEN** doctor reads a supported v2 project with no agent or official initializer metadata
- **THEN** it reports a legacy framework-state warning
- **AND** it does not claim that Copilot, Claude Code, OpenSpec, or Spec Kit integration was officially initialized

#### Scenario: Retired workload manifest is rejected before deeper checks
- **WHEN** doctor reads a manifest whose workload discriminator is `power-apps-code-app`
- **THEN** it exits with an unsupported retired-workload error before selecting workload-specific runtime, dependency, or cloud checks

#### Scenario: Adopted source differs from a starter
- **WHEN** a manifest-8 adopted project contains intentional custom application files
- **THEN** doctor evaluates its declared profile and actual evidence without requiring starter-byte equality
- **AND** filenames, prefixes, and matching hashes do not grant managed ownership

### Requirement: Doctor reports version freshness and managed-core drift
Doctor SHALL report the running CLI and use bounded authoritative native release discovery independently of project discovery. It SHALL distinguish upstream freshness, actual installation owner, and configured-owner delivery readiness. Within a supported project it SHALL compare recorded/running versions and report managed-core drift as one count-based warning using the shared pure update classification and directing the user to `liftoff update --check`. Activation migration/revalidation SHALL be separate from production-template drift. Doctor SHALL never create a preview, approve/apply an update, compare project-owned production files with current templates, or imply that installation upgrades migrate projects. Release lookup failure SHALL leave local diagnosis available and freshness explicitly unobserved.

#### Scenario: Freshness check runs outside a project
- **WHEN** doctor runs outside a project with native release authority available
- **THEN** it reports the running version and whether a newer stable native CLI is published

#### Scenario: Authoritative registry is newer than the running CLI
- **WHEN** the authoritative native stable target is newer than the running CLI
- **THEN** doctor names both exact versions and recommends `liftoff upgrade --check` followed by `liftoff upgrade`
- **AND** npm-owned or unlinked installations receive explicit installation inspection/migration guidance rather than a current npm install fallback

#### Scenario: Configured managed mirror is stale
- **WHEN** the approved native owner source does not expose the authoritative target
- **THEN** doctor reports the synchronization blocker rather than declaring the CLI current
- **AND** it neither changes sources nor performs a cross-channel upgrade

#### Scenario: Drift warning line
- **WHEN** four managed-core differences are present
- **THEN** one warning identifies four core maintenance actions and `liftoff update --check`
- **AND** it neither counts project-template differences nor creates the external receipt itself

#### Scenario: Production files differ from templates
- **WHEN** only production templates differ
- **THEN** doctor reports no managed-core drift and retains independent runtime/structural diagnostics

#### Scenario: Offline doctor preserves local version diagnostics
- **WHEN** native release lookup is unavailable
- **THEN** local diagnostics and the running version remain available without a freshness error
- **AND** freshness is identified as unavailable rather than current

### Requirement: Doctor distinguishes migration eligibility from current readiness
Doctor SHALL distinguish supported historical activation v1/v2/v3 readers, exact registered migration eligibility, committed successor identity, incomplete revalidation, current activation-4 execution readiness, and invalid declared history. Historical readability or eligible migration SHALL NOT authorize current execution. The human-first remedy SHALL remain the actual `liftoff update --check` lane where registered. Valid retained historical snapshots SHALL NOT invalidate otherwise valid current proof solely through their presence. Diagnosis SHALL retain each journal's actual version and report phase-specific recovery without resets, version editing, old-approval reuse, or force bypass.

#### Scenario: A supported v1 migration is available
- **WHEN** active v1 satisfies the installed migration lane
- **THEN** doctor explains that migration can be previewed through `liftoff update --check`
- **AND** it does not claim current execution readiness or require JSON

#### Scenario: Migration has committed but validation failed
- **WHEN** a journal identifies a committed successor with blocked revalidation, including a preserved historical v2 successor
- **THEN** doctor reports that actual identity, exact failed phase/blocker, and supported preview/retry remedy
- **AND** it neither labels the project as unmigrated v1, restores v1 automatically, nor retags the successor as current v4

#### Scenario: Retained history is valid
- **WHEN** a registered v1/v2 historical link or the current linked successor is valid alongside its exact preserved source inventory
- **THEN** historical presence alone does not cause an incompatible-identity failure
- **AND** current readiness is assessed only against the applicable execution contract

#### Scenario: Declared history is damaged
- **WHEN** a declared history/index link is missing, unsafe, or digest-mismatched
- **THEN** doctor reports that specific problem without silently repairing or reinterpreting it

#### Scenario: Diagnosis does not acknowledge a preview
- **WHEN** doctor diagnoses migration or revalidation
- **THEN** it writes no project/environment file or preview receipt
- **AND** the user still needs the actual update check before new update writes

#### Scenario: Historical publication is affected by later Azure inputs
- **WHEN** a supported schema-3 publication record is invalidated by the old global-input behavior after later Azure bindings are supplied
- **THEN** doctor identifies the exact reviewed history-preserving migration/revalidation lane and missing proof
- **AND** it does not recommend dropping inputs, rewriting old digests, recommitting, or pushing merely to clear the diagnostic

### Requirement: Runtime readiness checks degrade honestly
The system SHALL check that `.env` exists when `.env.example` is present and that the Docker Compose configuration parses when a compose file exists and docker is available; when a runtime check's prerequisites are missing, the system SHALL report the check as skipped with the reason rather than passing or failing it.

#### Scenario: Missing env file
- **WHEN** the project contains `.env.example` but no `.env`
- **THEN** doctor reports a failure with the copy remedy

#### Scenario: Compose check skipped without docker
- **WHEN** docker is not installed and a compose file exists
- **THEN** doctor reports the compose check as skipped because docker is missing

### Requirement: Doctor uses the shared severity, remedy, and output model
The system SHALL classify every check as ok, warn, or fail; SHALL print a one-line remedy for every non-ok result; SHALL exit 0 when at most warnings occurred and 1 when any check failed; and SHALL support `--json` output carrying `schemaVersion`, per-layer results, and a summary.

#### Scenario: Warnings do not fail the run
- **WHEN** doctor completes with warnings and no failures
- **THEN** the exit code is 0

#### Scenario: Any failure fails the run
- **WHEN** at least one check fails
- **THEN** the exit code is 1 and each failure line includes its remedy

#### Scenario: Machine-readable output
- **WHEN** a developer runs `liftoff doctor --json`
- **THEN** the output is a JSON object with `schemaVersion`, layer results with severities and remedies, and summary counts

### Requirement: Doctor checks the selected API runtime
The system SHALL use the normalized manifest and supported profile to select API-stack runtime diagnostics separately from native CLI, Docker, project, and cloud checks. It SHALL observe the external project executable and required package manager, not Liftoff's private runtime.

#### Scenario: Check Python project runtime
- **WHEN** doctor runs inside a `python-fastapi` project
- **THEN** it reports whether the supported Python runtime is available and provides an installation remedy when it is missing

#### Scenario: Check Node.js project runtime
- **WHEN** doctor runs inside a `node-fastify` project
- **THEN** it reports external Node.js and applicable npm readiness
- **AND** successful private-runtime startup cannot satisfy either result

#### Scenario: Check Go project runtime
- **WHEN** doctor runs inside a `go-huma` project
- **THEN** it reports whether the supported Go toolchain is available and provides an installation remedy when it is missing

#### Scenario: Do not require unrelated runtimes
- **WHEN** doctor runs inside a standard project
- **THEN** runtimes used only by other API stacks are reported as not applicable or are omitted rather than failing the project
- **AND** external Node/npm are not required solely because the CLI bundles Node

### Requirement: Doctor validates stack-specific generated configuration honestly
The system SHALL run read-only validation commands only when the selected stack's generated configuration and required local tool are present, and SHALL report a skipped result with the reason when validation cannot run.

#### Scenario: Validate available stack tooling
- **WHEN** doctor runs inside a generated project and the selected stack's local toolchain is available
- **THEN** it performs the stack-appropriate read-only project or configuration check and reports the result

#### Scenario: Skip unavailable stack validation
- **WHEN** the selected stack's optional validation command cannot run because its toolchain is unavailable
- **THEN** doctor reports the validation as skipped or failed according to whether the runtime is required
- **AND** it does not report a successful check

### Requirement: Doctor evaluates the shared workstation requirement registry in probe-only mode
The system SHALL derive doctor checks from the same workload-aware requirement registry used by initialization, based on the discovered manifest when present. Doctor SHALL execute only allowlisted read-only probes and SHALL never invoke installers, allow npx downloads, alter PATH or shell configuration, initialize a framework, install project dependencies, authenticate, or persist observed tool versions. It SHALL check required package managers separately when the selected supported workload depends on them.

The registry SHALL be plan/profile-aware, probes SHALL be bounded, and the private CLI runtime SHALL NOT satisfy an external runtime or package-manager requirement.

#### Scenario: Doctor checks only selected API tools
- **WHEN** doctor runs inside a Go project configured for OpenSpec, Copilot, and Claude Code
- **THEN** it checks Go, external Node/npm required by pinned OpenSpec, both selected agents, and applicable advisory infrastructure tools
- **AND** it does not require the Python backend runtime or Spec Kit

#### Scenario: Doctor checks required npm availability
- **WHEN** doctor runs inside a supported Node.js project or another supported project whose recorded dependency commands require npm
- **THEN** it reports npm readiness as its own workstation result
- **AND** it does not treat a detected external or bundled Node executable as sufficient evidence that npm is ready

#### Scenario: Doctor checks only selected Power Apps tools
- **WHEN** doctor encounters a retired Power Apps workload
- **THEN** it rejects the workload rather than probing a former Power Apps-specific tool set

#### Scenario: Doctor remains read-only with missing tools
- **WHEN** a required runtime or framework CLI is missing
- **THEN** doctor reports the missing requirement and exact platform remedy
- **AND** no installation command is executed

#### Scenario: Doctor JSON uses the same stable requirement identifiers
- **WHEN** a developer runs `liftoff doctor --json`
- **THEN** each workstation result includes the stable registry identifier, severity, observed state, and remedy

### Requirement: Doctor reports selected AI coding-agent readiness honestly
The system SHALL check every agent recorded by the supported manifest using the shared compatibility and cause model. Copilot SHALL be present when its compatible CLI probe succeeds or supported VS Code extension identifiers are observed. Claude and Codex SHALL be present when their compatible CLI probes succeed. Compatible official preview agents SHALL be ready with a notice, not an outdated-tool failure. Authentication SHALL remain external and SHALL not be automated or collected by doctor.

#### Scenario: Copilot CLI is detected
- **WHEN** the manifest selects Copilot and its compatible version probe succeeds
- **THEN** doctor reports the installation as ready with its actual observed version

#### Scenario: VS Code Copilot extension is detected
- **WHEN** the Copilot CLI is absent and a successful extension listing contains `GitHub.copilot` or `GitHub.copilot-chat` case-insensitively
- **THEN** doctor reports Copilot as installed through VS Code

#### Scenario: VS Code extension state is not observable
- **WHEN** both the Copilot CLI and the VS Code command are unavailable
- **THEN** doctor reports not-observable installation rather than claiming the extension is absent
- **AND** it offers the supported CLI installation remedy

#### Scenario: Claude authentication remains external
- **WHEN** Claude's version probe succeeds but its doctor command reports an authentication problem
- **THEN** Liftoff reports an installed agent with an authentication warning and agent-owned remedy
- **AND** it does not request credentials

#### Scenario: Codex is selected
- **WHEN** the manifest selects Codex with OpenSpec or Spec Kit
- **THEN** doctor probes the registered Codex executable and native framework markers
- **AND** it does not require unselected Copilot or Claude integrations

#### Scenario: A selected preview agent is compatible
- **WHEN** a selected agent reports a compatible official preview build
- **THEN** doctor agrees with setup that the requirement is ready with a preview notice
- **AND** it does not recommend reinstalling merely to remove the preview suffix

### Requirement: Doctor distinguishes blocking and advisory workstation readiness
The system SHALL preserve each selected requirement's blocking or advisory classification in human and JSON output. Missing blocking requirements SHALL contribute a failure, while missing advisory infrastructure tools SHALL contribute warnings and SHALL never be reported as successful.

#### Scenario: Missing selected runtime fails doctor
- **WHEN** the selected backend runtime is missing
- **THEN** doctor records a failure and exits 1

#### Scenario: Missing deferred infrastructure tool warns
- **WHEN** Docker, OpenTofu, or Azure CLI is applicable but missing
- **THEN** doctor records a warning with the exact remedy
- **AND** the warning alone does not make doctor exit 1

### Requirement: Doctor validates locked dependency readiness
The system SHALL use the supported-stack baseline and explicit supported workload identity to check that every expected dependency manifest and lock pair exists, agrees on project identity, and can be consumed without mutation. Doctor SHALL remain read-only and SHALL report missing, stale, malformed, or mismatched metadata with the exact frozen install or repair command.

#### Scenario: Check a locked Python project
- **WHEN** doctor runs inside a Python project with `pyproject.toml` and `uv.lock`
- **THEN** it verifies the expected lock is present and reports `uv sync --frozen` as the dependency command
- **AND** it does not run `uv lock` or change either file

#### Scenario: Check npm and Go metadata
- **WHEN** doctor runs inside a Node.js, frontend-enabled API, or Go project
- **THEN** it validates the explicit package-lock or module-checksum pair applicable to that workload
- **AND** it omits unrelated ecosystem checks

#### Scenario: Lock metadata is missing
- **WHEN** an expected lockfile or checksum file is absent
- **THEN** doctor reports a failure naming the missing path and baseline-owned dependency set
- **AND** it does not report dependency readiness as successful

#### Scenario: Check paths on Windows
- **WHEN** doctor resolves dependency files in a project on Windows
- **THEN** it uses the same explicit path-part definitions as generation
- **AND** produces the same logical check identifiers as macOS and Linux

### Requirement: Doctor reports baseline identity without resolving it
Doctor SHALL report the current Liftoff supported-stack baseline identity and applicable runtime constraints from packaged state. It MAY perform the existing bounded Liftoff CLI freshness lookup, but SHALL NOT contact dependency registries to replace or rewrite the project's baseline.

#### Scenario: Run doctor offline
- **WHEN** dependency registries are unavailable
- **THEN** doctor still reports the packaged baseline and completes every local check
- **AND** it does not classify the project as upgraded from cached or speculative registry data

### Requirement: Doctor uses canonical freshness and bounded subprocess observations
Doctor's default Liftoff freshness lookup SHALL use the authoritative native release manifest independently
of undocumented npm registry environment overrides. Configured-owner delivery
checks SHALL remain separate. Default external diagnostic probes SHALL have a
finite time bound, preserve existing injected test interfaces, and report
timeouts explicitly without installing tools or changing project state.

#### Scenario: An environment override names another registry
- **WHEN** `LIFTOFF_REGISTRY` is set while default doctor freshness runs
- **THEN** current release identity still comes from the native release authority
- **AND** the override cannot make npm or a substituted registry authoritative

#### Scenario: An external probe hangs
- **WHEN** a diagnostic command exceeds its time bound
- **THEN** doctor reports a timeout or unavailable observation and terminates the wait
- **AND** does not claim the probe passed

#### Scenario: A test injects a release lookup
- **WHEN** a deterministic diagnostic test supplies an explicit lookup dependency
- **THEN** doctor uses that injected dependency without contacting a real release or package-manager source

### Requirement: Doctor separates local completion activation and repair progress
Doctor SHALL distinguish native installation, local project readiness, repository-only enforcement, full activation planning/approval/execution, stateful migration checkpoints, repair recovery, and lifecycle obligations. It SHALL share active-layout, compatibility, scope, and proof interpretation with other commands while remaining probe-only. Real external prerequisites SHALL remain distinct from missing implementation; repository evidence SHALL NOT satisfy cloud/production proof, and incomplete later stages SHALL NOT erase valid local completion.

#### Scenario: Local setup is complete while activation is pending
- **WHEN** local proof is current but no publication or cloud activation has occurred
- **THEN** doctor identifies completed local setup and pending activation separately

#### Scenario: Infrastructure repair needs discovery
- **WHEN** legacy conformance is unresolved and deployment eligibility is unknown
- **THEN** doctor names the supported project-bound repair preview and missing discovery
- **AND** it does not create a receipt, perform the repair, or assume undeployed state

#### Scenario: Repair committed but verification is incomplete
- **WHEN** a repair progress record identifies committed files and failed local checks
- **THEN** doctor reports both facts and the supported scoped retry
- **AND** it does not recommend reverting to legacy provenance

#### Scenario: Stateful migration is interrupted
- **WHEN** a journal records partial backend effects
- **THEN** doctor identifies the verified checkpoint and supported recovery inspection
- **AND** it neither writes state nor recommends blindly restoring an old snapshot

#### Scenario: Activation is verified and disposal is not due
- **WHEN** live activation proof is current while retained-state disposal is scheduled for later
- **THEN** doctor reports active governance and pending lifecycle separately
- **AND** it does not declare lifecycle complete or delete retained material

#### Scenario: Repository enforcement is complete without production
- **WHEN** repository-only source-check and control-readback evidence is valid while production qualification is deferred
- **THEN** doctor reports repository completion and any approved main-update hold separately
- **AND** full activation remains incomplete or blocked without fabricated staging or production evidence

#### Scenario: A capability lacks its implementation
- **WHEN** external prerequisites are satisfied but a required executor is unavailable
- **THEN** doctor identifies missing implementation instead of an authentication, PATH, or tool-installation remedy

### Requirement: Doctor identifies successor and sensitive-operation boundaries
Doctor SHALL identify historical v1/v2/v3 activation identities, exact successor eligibility, current execution identity, and corrupted or incomplete migration links without rewriting them. It SHALL NOT pull sensitive state, run deployment plans, grant authority, enroll credentials, release locks, or execute recovery merely to diagnose a project.

#### Scenario: Historical contract needs upgrade
- **WHEN** current execution requires a supported reviewed successor
- **THEN** doctor names the actual update preview and required fresh-proof work
- **AND** it does not tell the developer to edit version fields or reuse historical approvals

#### Scenario: A sensitive state read is needed
- **WHEN** metadata-only diagnostics cannot establish a migration mapping
- **THEN** doctor identifies the separate state-inspection approval path
- **AND** it does not include raw state or secrets in its output

### Requirement: Doctor reports native installation ownership and causal channel readiness
Doctor SHALL report the running native build/runtime/resource identity, supported host compatibility, and actual installation owner separately from PATH observations and project manifest versions. It SHALL distinguish npm migration-required, unlinked candidate, Homebrew, WinGet, direct receipt, unknown owner, source lag, enterprise restrictions, and Windows handover blockers without changing them. Paths in local diagnostics SHALL use native Windows/macOS/Linux semantics and SHALL NOT be sent to telemetry.

#### Scenario: Homebrew Node hosts legacy Liftoff
- **WHEN** npm owns the Liftoff package beneath a Homebrew-related path
- **THEN** doctor reports npm ownership and the explicit native migration journey
- **AND** it does not recommend native Homebrew upgrade based on the prefix alone

#### Scenario: PATH resolves another installed version
- **WHEN** multiple launchers or Windows shims select a different executable from the expected installation
- **THEN** doctor reports the observed executable and actual resolution conflict
- **AND** it does not infer that every incompatibility is a PATH failure or remove a conflicting launcher

#### Scenario: An owner source is unavailable
- **WHEN** the native target is known but manager/source availability cannot be established read-only
- **THEN** doctor separates known upstream freshness from unobserved or blocked owner delivery
- **AND** it does not refresh, reconfigure, or replace that owner

#### Scenario: The current Windows payload is locked
- **WHEN** a known pending owner-specific handover cannot complete while its executable is in use
- **THEN** doctor identifies the actual close/handover remedy
- **AND** it does not kill processes or clean the active version

### Requirement: Doctor distinguishes adoption provenance from installation migration
Doctor SHALL diagnose supported manifest-8 generated, adopted, and repaired provenance without inventing historical generation versions. For a repository without a Liftoff manifest, it SHALL preserve environment-only diagnosis and direct whole-project evaluation to `liftoff assess` rather than initialize it. Native installation migration, project adoption, managed update, repair, and activation migration SHALL be separate readiness and approval boundaries.

#### Scenario: Assess an ordinary existing repository
- **WHEN** a user needs project-specific findings for a repository with no Liftoff manifest
- **THEN** guidance identifies read-only whole-project assessment and separately reviewed adoption where supported
- **AND** doctor does not create a manifest or call init

#### Scenario: A project needs maintenance after cutover
- **WHEN** the native installation verifies but project contracts or managed integrations need migration
- **THEN** doctor reports installation success separately from the exact project maintenance eligibility
- **AND** no inspection result becomes approval to rewrite the project

### Requirement: Doctor reports executable identity and causal remedies
Doctor SHALL expose running CLI identity and selected tool executable observations separately from manifest-writing versions, release-channel notices, and required constraints. It SHALL distinguish unavailable executables, no-op repairs, incompatible versions/channels, and actual PATH problems. Diagnostics SHALL remain read-only and SHALL not infer successful installation from a path's existence.

#### Scenario: A compatibility-rejected executable is found
- **WHEN** a tool version command resolves and succeeds but a real constraint is not satisfied
- **THEN** doctor reports the constraint mismatch and actual executable
- **AND** it does not diagnose PATH solely from the unresolved requirement

#### Scenario: Command availability differs between sessions
- **WHEN** installation identity is needed to investigate an unknown-command report
- **THEN** doctor identifies the running CLI version and resolved executable/package boundary without claiming that another session used the same binary

#### Scenario: Windows uses an executable shim
- **WHEN** a selected tool resolves through a Windows executable shim
- **THEN** observations and remedies distinguish that resolved path from a missing-command condition using native path handling
