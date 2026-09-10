## Purpose

Define the layered, read-only `liftoff doctor` diagnostics covering environment, project, runtime, and cloud readiness, configured by the project manifest.

## Requirements

### Requirement: Doctor runs layered diagnostics selected by context
The system SHALL run `liftoff doctor` as layered read-only diagnostics with CLI and environment layers in every context; project, runtime, and cloud-from-manifest layers SHALL run only when a supported generated project is located via project-root discovery, and cloud checks SHALL also run outside a project when `--cloud` is passed. A malformed, unreadable, dangling, symlinked, or retired manifest boundary SHALL stop project discovery with an error rather than falling back to an outer project or ordinary environment-only execution for that same path.

#### Scenario: Full preflight inside a project
- **WHEN** a developer runs `liftoff doctor` inside a generated project
- **THEN** the output reports CLI, environment, project, runtime, and cloud layers grouped and labeled

#### Scenario: Diagnostics outside a project
- **WHEN** a developer runs `liftoff doctor` outside any generated project without flags
- **THEN** only the CLI and environment layers run

#### Scenario: Doctor never writes
- **WHEN** any doctor run completes
- **THEN** no file in the project or environment has been created or modified
- **AND** npm registry configuration remains unchanged

#### Scenario: Broken inner manifest blocks outer-project fallback
- **WHEN** a nested directory contains a malformed, unreadable, dangling, or retired `liftoff.manifest.json` and an ancestor contains a different valid project
- **THEN** doctor stops at the nested boundary with an error
- **AND** it does not walk outward to diagnose the ancestor project instead

### Requirement: The manifest configures project-aware checks
The system SHALL read the normalized manifest to configure diagnostics. Cloud checks SHALL target a declared API workload cloud with `--cloud` acting as an override; a workload without declared cloud infrastructure SHALL not inherit a default cloud. Environment and runtime checks SHALL target the selected supported workload, API stack when applicable, spec workflow, configured coding agents, optional requested integrations, and declared framework contract. The project layer SHALL verify that the manifest loads, required managed-core artifacts exist, and declared framework integration markers are present; project provenance SHALL NOT become an additional managed-file existence or restoration contract. A retired workload discriminator SHALL be rejected before deeper workload-specific diagnostic selection.

#### Scenario: Cloud checks come from an API manifest
- **WHEN** doctor runs inside an API project whose manifest records Azure
- **THEN** Azure authentication checks run without any `--cloud` flag

#### Scenario: Structure failures surface
- **WHEN** a required managed-core manifest artifact is missing from disk
- **THEN** the project layer reports a failure naming the missing artifact

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

### Requirement: Doctor reports version freshness and managed-core drift
Doctor SHALL always report the running CLI and use the existing bounded authoritative stable-release lookup independently of project discovery. Inside a project it SHALL compare recorded and running CLI versions and report managed-core drift as one count-based warning directing the user to `liftoff update --check`, using the shared pure update classification. It SHALL report activation migration/revalidation separately, not count it as production-template drift. Doctor SHALL never issue a preview receipt, approve/apply an update, compare production files with current templates, or imply that upgrading the CLI replaces production files. Registry failure SHALL suppress only freshness, not local diagnosis.

#### Scenario: Freshness check runs outside a project
- **WHEN** doctor runs outside a generated project with registry access
- **THEN** it reports the running version and whether a newer stable CLI is published

#### Scenario: Authoritative registry is newer than the running CLI
- **WHEN** canonical stable release data is newer than the running CLI
- **THEN** doctor names both exact versions and recommends `liftoff upgrade --check` followed by `liftoff upgrade`
- **AND** it retains the exact manual npm fallback for unsupported origins or recovery

#### Scenario: Configured managed mirror is stale
- **WHEN** the configured mirror does not expose the authoritative target
- **THEN** doctor reports the synchronization blocker rather than declaring the CLI current
- **AND** it neither changes registry configuration nor performs an upgrade

#### Scenario: Drift warning line
- **WHEN** four managed-core differences are present
- **THEN** one warning identifies four core maintenance actions and `liftoff update --check`
- **AND** it neither counts project-template differences nor creates the external receipt itself

#### Scenario: Production files differ from templates
- **WHEN** only production templates differ
- **THEN** doctor reports no managed-core drift and retains independent runtime/structural diagnostics

#### Scenario: Offline doctor preserves local version diagnostics
- **WHEN** the registry is unavailable
- **THEN** local diagnostics and the running version remain available without a freshness error

### Requirement: Doctor distinguishes migration eligibility from current readiness
Doctor SHALL identify known active v1, supported migration eligibility, committed linked v2, incomplete revalidation, and invalid declared history as distinct diagnostic conditions. Eligible v1 SHALL still be non-executable, with `liftoff update --check` as the human-first remedy. A valid retained v1 snapshot SHALL not fail otherwise valid current v2 simply because it exists. Post-commit revalidation blockers SHALL identify the failed phase and actual repair/resume path without recommending a reset, manual version editing, or force bypass.

#### Scenario: A supported v1 migration is available
- **WHEN** active v1 satisfies the installed migration lane
- **THEN** doctor explains that migration can be previewed through `liftoff update --check`
- **AND** it does not claim current execution readiness or require JSON

#### Scenario: Migration has committed but validation failed
- **WHEN** the journal identifies a committed successor with blocked revalidation
- **THEN** doctor reports the retained v2 identity, exact blocker, and preview/retry remedy
- **AND** it does not label the project as unmigrated v1 or recommend restoring v1 automatically

#### Scenario: Retained history is valid
- **WHEN** linked v2 proof is valid alongside the exact preserved v1 inventory
- **THEN** historical presence alone does not cause an incompatible-identity failure

#### Scenario: Declared history is damaged
- **WHEN** a declared history/index link is missing, unsafe, or digest-mismatched
- **THEN** doctor reports that specific problem without silently repairing or reinterpreting it

#### Scenario: Diagnosis does not acknowledge a preview
- **WHEN** doctor diagnoses migration or revalidation
- **THEN** it writes no project/environment file or preview receipt
- **AND** the user still needs the actual update check before new update writes

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
The system SHALL use the normalized manifest project identity to run API-stack-specific runtime diagnostics in addition to shared CLI, Docker, project, and cloud checks.

#### Scenario: Check Python project runtime
- **WHEN** doctor runs inside a `python-fastapi` project
- **THEN** it reports whether the supported Python runtime is available and provides an installation remedy when it is missing

#### Scenario: Check Node.js project runtime
- **WHEN** doctor runs inside a `node-fastify` project
- **THEN** it reports whether the supported Node.js runtime is available for the generated backend

#### Scenario: Check Go project runtime
- **WHEN** doctor runs inside a `go-huma` project
- **THEN** it reports whether the supported Go toolchain is available and provides an installation remedy when it is missing

#### Scenario: Do not require unrelated runtimes
- **WHEN** doctor runs inside a standard project
- **THEN** runtimes used only by other API stacks are reported as not applicable or are omitted rather than failing the project

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

#### Scenario: Doctor checks only selected API tools
- **WHEN** doctor runs inside a Go project configured for OpenSpec, Copilot, and Claude Code
- **THEN** it checks supported Node.js, Go, the pinned OpenSpec contract, both agents, and applicable advisory infrastructure tools
- **AND** it does not require the Python backend runtime or Spec Kit

#### Scenario: Doctor checks required npm availability
- **WHEN** doctor runs inside a supported Node.js project or another supported project whose recorded dependency commands require npm
- **THEN** it reports npm readiness as its own workstation result
- **AND** it does not treat a detected `node` executable as sufficient evidence that npm is ready

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
The system SHALL check every agent recorded by the current supported manifest. Copilot SHALL be present when its CLI probe succeeds or an observable VS Code extension list contains the supported Copilot identifiers. Claude Code SHALL be present when its CLI probe succeeds, and its doctor result SHALL be reported without Liftoff automating authentication.

#### Scenario: Copilot CLI is detected
- **WHEN** the manifest selects Copilot and `copilot --version` succeeds
- **THEN** doctor reports the Copilot installation as ready

#### Scenario: VS Code Copilot extension is detected
- **WHEN** the Copilot CLI is absent, `code --list-extensions` succeeds, and the list contains `GitHub.copilot` or `GitHub.copilot-chat` case-insensitively
- **THEN** doctor reports Copilot as installed through VS Code

#### Scenario: VS Code extension state is not observable
- **WHEN** the Copilot CLI and the `code` command are both unavailable
- **THEN** doctor reports Copilot as not observable rather than claiming the extension is absent
- **AND** it offers the supported Copilot CLI installation remedy

#### Scenario: Claude authentication remains external
- **WHEN** `claude --version` succeeds but `claude doctor` reports an authentication problem
- **THEN** doctor reports Claude Code as installed with an authentication warning and agent-owned remedy
- **AND** it does not request credentials

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
Doctor's default Liftoff freshness lookup SHALL use canonical npm independently
of undocumented registry environment overrides. Configured-registry delivery
checks SHALL remain separate. Default external diagnostic probes SHALL have a
finite time bound, preserve existing injected test interfaces, and report
timeouts explicitly without installing tools or changing project state.

#### Scenario: An environment override names another registry
- **WHEN** `LIFTOFF_REGISTRY` is set while default doctor freshness runs
- **THEN** canonical release identity still comes from canonical npm
- **AND** the override cannot make an older or substituted registry authoritative

#### Scenario: An external probe hangs
- **WHEN** a diagnostic command exceeds its time bound
- **THEN** doctor reports a timeout or unavailable observation and terminates the wait
- **AND** does not claim the probe passed

#### Scenario: A test injects a release lookup
- **WHEN** a deterministic diagnostic test supplies an explicit lookup dependency
- **THEN** doctor uses that injected dependency without contacting a real registry
