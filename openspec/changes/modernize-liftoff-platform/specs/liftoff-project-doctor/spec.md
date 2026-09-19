## MODIFIED Requirements

### Requirement: Doctor runs layered diagnostics selected by context
The system SHALL run `liftoff doctor` as layered read-only diagnostics with native CLI and environment layers in every context. Project, runtime, and cloud-from-manifest layers SHALL run only after locating a supported generated or adopted manifest through project-root discovery; explicit `--cloud` SHALL continue to request cloud checks outside a project. A malformed, unreadable, dangling, symlinked, or retired manifest boundary SHALL stop discovery rather than fall back to another project. Diagnosis SHALL NOT install, migrate, issue preview receipts, refresh package-manager sources, or change configuration.

#### Scenario: Full preflight inside a project
- **WHEN** a developer runs doctor inside a supported generated or adopted project
- **THEN** CLI, environment, project, runtime, and applicable cloud results are grouped and labeled
- **AND** installation readiness is distinct from the selected project's readiness

#### Scenario: Diagnostics outside a project
- **WHEN** a developer runs doctor outside any supported Liftoff project without flags
- **THEN** only CLI and environment layers run
- **AND** missing project initialization does not prevent native installation diagnosis

#### Scenario: Doctor never writes
- **WHEN** any doctor run completes
- **THEN** no project, environment, preview-receipt, or telemetry notice-state file is created or modified
- **AND** npm, Homebrew, WinGet, PATH, and source configuration remain unchanged

#### Scenario: Broken inner manifest blocks outer-project fallback
- **WHEN** a nested directory contains a malformed, unreadable, dangling, or retired `liftoff.manifest.json` and an ancestor contains a valid project
- **THEN** doctor stops at the nested boundary with an error
- **AND** it does not diagnose the ancestor as though it were the selected project

### Requirement: The manifest configures project-aware checks
The system SHALL read the normalized manifest to configure diagnostics from the selected workload, supported profile, API stack, spec workflow, coding agents, requested integrations, and declared framework contract. Cloud checks SHALL target a declared API cloud with `--cloud` as an override; an undeclared cloud SHALL not be invented. The project layer SHALL verify manifest loading, exact registered managed-core artifact requirements, and declared framework markers. Generated, adopted, and repaired provenance SHALL NOT create authority to restore project-owned files or assert that custom bytes were generated. A retired workload discriminator SHALL be rejected before deeper selection.

#### Scenario: Cloud checks come from an API manifest
- **WHEN** doctor runs inside an API project whose manifest records Azure
- **THEN** the separate Azure authentication checks run without requiring `--cloud`
- **AND** their result does not determine unrelated local or repository-only completion

#### Scenario: Structure failures surface
- **WHEN** a required managed-core manifest artifact is missing from disk
- **THEN** the project layer reports the exact missing registered artifact
- **AND** it does not create the file

#### Scenario: Power Apps does not inherit Azure checks
- **WHEN** doctor encounters a retired Power Apps manifest
- **THEN** it reports unsupported workload before Azure or former Power Apps diagnostic selection

#### Scenario: Worker tooling check
- **WHEN** doctor runs inside a worker-enabled Azure project without Azure Functions Core Tools
- **THEN** it reports the applicable warning and installation remedy

#### Scenario: Framework checks come from the manifest
- **WHEN** a supported manifest selects Spec Kit, Copilot, and Claude Code
- **THEN** doctor checks the pinned framework contract and both recorded integrations without requiring a workflow flag

#### Scenario: Missing framework marker fails project readiness
- **WHEN** the manifest declares an initialized integration whose required marker is missing
- **THEN** the project layer reports that integration and its supported framework-owned repair remedy

#### Scenario: Legacy v2 framework state is not fabricated
- **WHEN** doctor reads a supported v2 project without agent or official initializer metadata
- **THEN** it reports a legacy framework-state warning
- **AND** it does not claim official Copilot, Claude, OpenSpec, or Spec Kit initialization

#### Scenario: Retired workload manifest is rejected before deeper checks
- **WHEN** the manifest workload is `power-apps-code-app`
- **THEN** doctor exits with the retired-workload error before runtime, dependency, or cloud selection

#### Scenario: Adopted source differs from a starter
- **WHEN** a manifest-8 adopted project contains intentional custom application files
- **THEN** doctor evaluates its declared profile and actual evidence without requiring starter-byte equality
- **AND** filenames, prefixes, and matching hashes do not grant managed ownership

### Requirement: Doctor reports version freshness and managed-core drift
Doctor SHALL report the running CLI and use bounded authoritative native release discovery independently of project discovery. It SHALL distinguish upstream freshness, actual installation owner, and configured-owner delivery readiness. Within a supported project it SHALL compare recorded/running versions and report managed-core drift as one count-based warning using the shared pure update classification and directing the user to `liftoff update --check`. Activation migration/revalidation SHALL be separate from production-template drift. Doctor SHALL never create a preview, apply an update, compare project-owned production files with current templates, or imply that installation upgrades migrate projects. Release lookup failure SHALL leave local diagnosis available and freshness explicitly unobserved.

#### Scenario: Freshness check runs outside a project
- **WHEN** doctor runs outside a project with native release authority available
- **THEN** it reports the running version and whether a newer stable native CLI is published

#### Scenario: Authoritative registry is newer than the running CLI
- **WHEN** the authoritative native stable target is newer
- **THEN** doctor names both versions and recommends owner-aware upgrade check/apply where supported
- **AND** npm-owned or unlinked installations receive explicit installation inspection/migration guidance rather than a current npm install fallback

#### Scenario: Configured managed mirror is stale
- **WHEN** the approved owner source does not expose the authoritative target
- **THEN** doctor reports manager/source synchronization as a separate blocker rather than declaring the CLI current
- **AND** it neither changes sources nor performs a cross-channel upgrade

#### Scenario: Drift warning line
- **WHEN** four managed-core differences are present
- **THEN** one warning identifies four core maintenance actions and `liftoff update --check`
- **AND** it excludes production-template differences and does not create a receipt

#### Scenario: Production files differ from templates
- **WHEN** only project-owned production templates differ
- **THEN** doctor reports no managed-core drift and retains independent runtime and structural diagnostics

#### Scenario: Offline doctor preserves local version diagnostics
- **WHEN** native release lookup is unavailable
- **THEN** local diagnostics and the running version remain available without a freshness failure invalidating them
- **AND** freshness is identified as unavailable rather than current

### Requirement: Doctor distinguishes migration eligibility from current readiness
Doctor SHALL distinguish supported historical activation v1/v2/v3 readers, exact registered migration eligibility, committed successor identity, incomplete revalidation, current activation-4 execution readiness, and invalid declared history. Historical readability or eligible migration SHALL NOT authorize current execution. The human-first remedy SHALL remain the actual `liftoff update --check` lane where registered. Valid retained historical snapshots SHALL NOT invalidate otherwise valid current proof solely through their presence. Diagnosis SHALL retain each journal's actual version and report phase-specific recovery without resets, version editing, old-approval reuse, or force bypass.

#### Scenario: A supported v1 migration is available
- **WHEN** active v1 satisfies an exact installed migration lane
- **THEN** doctor explains the update-check preview and required fresh proof
- **AND** it does not claim current readiness or require JSON for the human workflow

#### Scenario: Migration has committed but validation failed
- **WHEN** a journal identifies a committed successor with blocked revalidation, including a preserved historical v2 successor
- **THEN** doctor reports that actual identity, the failed phase, and its supported preview/retry remedy
- **AND** it neither relabels the project as unmigrated v1 nor retags the successor as current v4

#### Scenario: Retained history is valid
- **WHEN** a registered v1/v2 historical link or the current linked successor is valid alongside its preserved source inventory
- **THEN** historical presence alone does not cause incompatibility
- **AND** current readiness is assessed only against the applicable execution contract

#### Scenario: Declared history is damaged
- **WHEN** a declared history/index link is missing, unsafe, or digest-mismatched
- **THEN** doctor reports that exact problem without repairing, deleting, or reinterpreting it

#### Scenario: Diagnosis does not acknowledge a preview
- **WHEN** doctor diagnoses migration or revalidation
- **THEN** it writes no project/environment file or preview receipt
- **AND** new update writes still require the real matching check and approval

#### Scenario: Historical publication is affected by later Azure inputs
- **WHEN** a supported schema-3 publication record is invalidated by the old global-input behavior after later Azure bindings are supplied
- **THEN** doctor identifies the exact reviewed history-preserving migration/revalidation lane and missing proof
- **AND** it does not recommend dropping inputs, rewriting old digests, recommitting, or pushing merely to clear the diagnostic

### Requirement: Doctor checks the selected API runtime
The system SHALL use the normalized manifest and supported profile to select API-stack runtime diagnostics separately from native CLI, Docker, project, and cloud checks. It SHALL observe the external project executable and required package manager, not Liftoff's private runtime.

#### Scenario: Check Python project runtime
- **WHEN** doctor runs inside a `python-fastapi` project
- **THEN** it reports whether the supported external Python runtime is available and gives its remedy when missing

#### Scenario: Check Node.js project runtime
- **WHEN** doctor runs inside a `node-fastify` project
- **THEN** it reports external Node.js and applicable npm readiness
- **AND** successful private-runtime startup cannot satisfy either result

#### Scenario: Check Go project runtime
- **WHEN** doctor runs inside a `go-huma` project
- **THEN** it reports whether the supported Go toolchain is available and gives its remedy when missing

#### Scenario: Do not require unrelated runtimes
- **WHEN** doctor runs inside a supported project
- **THEN** tools used only by unselected stacks are omitted or not applicable
- **AND** external Node/npm are not required solely because the CLI bundles Node

### Requirement: Doctor evaluates the shared workstation requirement registry in probe-only mode
Doctor SHALL derive checks from the same plan/profile-aware registry used by initialization and external-tool readiness, using the discovered manifest when present. It SHALL execute only allowlisted bounded read-only probes and SHALL NOT install, allow npx downloads, alter PATH or shell configuration, initialize frameworks, install project dependencies, authenticate, or persist tool observations. Required package managers SHALL be checked separately from runtimes, and the private CLI runtime SHALL not satisfy either external requirement.

#### Scenario: Doctor checks only selected API tools
- **WHEN** a Go project selects OpenSpec, Copilot, and Claude Code
- **THEN** doctor checks Go, the external Node/npm required by the pinned OpenSpec contract, both selected agents, and applicable advisory tools
- **AND** it does not require Python backend tooling or Spec Kit

#### Scenario: Doctor checks required npm availability
- **WHEN** a project records dependency or framework commands requiring npm
- **THEN** doctor reports npm readiness separately
- **AND** a detected external or bundled Node executable is not sufficient

#### Scenario: Doctor checks only selected Power Apps tools
- **WHEN** doctor encounters a retired Power Apps workload
- **THEN** it rejects the workload instead of probing its former tool set

#### Scenario: Doctor remains read-only with missing tools
- **WHEN** a required runtime or framework CLI is missing
- **THEN** doctor reports the requirement and exact platform remedy without executing installation

#### Scenario: Doctor JSON uses the same stable requirement identifiers
- **WHEN** a developer runs `liftoff doctor --json`
- **THEN** each workstation result includes its stable registered identifier, severity, observed state, and remedy

### Requirement: Doctor uses canonical freshness and bounded subprocess observations
Doctor's default freshness lookup SHALL use the authoritative native release manifest independently of undocumented npm registry overrides. Configured-owner delivery observations SHALL remain separate. External diagnostic probes SHALL have finite bounds, preserve deterministic injected test interfaces, and report timeouts explicitly without installing tools or changing project state.

#### Scenario: An environment override names another registry
- **WHEN** `LIFTOFF_REGISTRY` is set during default doctor freshness
- **THEN** current release identity still comes from the native release authority
- **AND** the override cannot make npm or a substituted registry authoritative

#### Scenario: An external probe hangs
- **WHEN** a diagnostic command exceeds its bound
- **THEN** doctor reports timeout or unavailable observation and terminates the wait
- **AND** it does not claim the probe passed

#### Scenario: A test injects a release lookup
- **WHEN** a deterministic test supplies an explicit lookup dependency
- **THEN** doctor uses it without contacting a real release or package-manager source

### Requirement: Doctor separates local completion activation and repair progress
Doctor SHALL distinguish native installation, local project readiness, repository-only enforcement, full activation planning/approval/execution, stateful migration checkpoints, repair recovery, and lifecycle obligations. It SHALL share active-layout, compatibility, scope, and proof interpretation with other commands while remaining probe-only. Real external prerequisites SHALL remain distinct from missing implementation; repository evidence SHALL NOT satisfy cloud/production proof, and incomplete later stages SHALL NOT erase valid local completion.

#### Scenario: Local setup is complete while activation is pending
- **WHEN** local proof is current but no publication or cloud activation has occurred
- **THEN** doctor identifies completed local setup and pending activation separately

#### Scenario: Infrastructure repair needs discovery
- **WHEN** legacy conformance is unresolved and deployment eligibility is unknown
- **THEN** doctor names the supported project-bound repair preview and missing discovery
- **AND** it neither creates a receipt nor assumes undeployed state

#### Scenario: Repair committed but verification is incomplete
- **WHEN** a repair record identifies committed files and failed local checks
- **THEN** doctor reports both facts and the supported scoped retry
- **AND** it does not recommend reverting to legacy provenance

#### Scenario: Stateful migration is interrupted
- **WHEN** a journal records partial backend effects
- **THEN** doctor identifies the verified checkpoint and supported recovery inspection
- **AND** it neither writes state nor recommends blindly restoring an old snapshot

#### Scenario: Activation is verified and disposal is not due
- **WHEN** live activation proof is current while retained-state disposal is scheduled for later
- **THEN** doctor reports active governance and pending lifecycle separately
- **AND** it neither declares lifecycle complete nor deletes retained material

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
- **THEN** doctor names the actual update preview and fresh-proof requirements
- **AND** it does not recommend editing version fields or reusing historical approvals

#### Scenario: A sensitive state read is needed
- **WHEN** metadata-only diagnostics cannot establish a migration mapping
- **THEN** doctor identifies the separate state-inspection approval path
- **AND** raw state and secrets remain absent from its output

## ADDED Requirements

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
