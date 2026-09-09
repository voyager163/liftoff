## MODIFIED Requirements

### Requirement: Workstation requirements are derived from the resolved project plan
The system SHALL build a deterministic requirement set from the selected workload and its applicable API stack, cloud provider, infrastructure output, spec workflow, frontend choice, coding agents, and optional integrations. It SHALL include only tools relevant to that plan, SHALL model required package managers separately from runtimes when a selected framework or dependency phase depends on them, and SHALL identify every requirement as blocking or advisory.

#### Scenario: Python OpenSpec project requirements
- **WHEN** a developer selects a Python/FastAPI project with OpenSpec and GitHub Copilot
- **THEN** the requirement set includes supported Node.js, Python, the pinned OpenSpec CLI, and a detectable Copilot installation
- **AND** it does not require Go or Spec Kit

#### Scenario: Go Spec Kit project requirements
- **WHEN** a developer selects a Go/Huma project with Spec Kit and Claude Code
- **THEN** the requirement set includes supported Node.js, Python, Go, `uv`, the pinned Spec Kit CLI, and Claude Code
- **AND** it does not require a Python backend dependency installation

#### Scenario: Power Apps OpenSpec project requirements
- **WHEN** a request identifies Power Apps with OpenSpec
- **THEN** it is rejected before a former Power Apps requirement set is selected or probed

#### Scenario: Required package manager is included explicitly
- **WHEN** a selected stack, framework contract, or dependency phase requires `npm`
- **THEN** the requirement set includes a compatible npm prerequisite distinct from the Node.js runtime
- **AND** initialization does not treat `node` alone as sufficient readiness

#### Scenario: Infrastructure tools are advisory
- **WHEN** an API workload includes Azure OpenTofu infrastructure and Docker-based local development
- **THEN** Docker, OpenTofu, and Azure CLI readiness appear as advisory requirements
- **AND** declining them does not falsely report them as ready

### Requirement: Liftoff automatically detects tool presence, version, and health
The system SHALL run allowlisted read-only probes for every selected requirement before destination writes, SHALL classify each result as ready, missing, outdated, unhealthy, or not observable, and SHALL compare versioned runtimes, package managers, and framework tools with the requirement registry's tested constraint. Stable-release requirements, including exact pins and minimum floors, SHALL reject prerelease identifiers unless the requirement explicitly allows them.

#### Scenario: Supported runtime is ready
- **WHEN** the selected Python runtime probe returns a version satisfying the registered minimum
- **THEN** Liftoff reports Python as ready and does not offer to reinstall it

#### Scenario: Outdated runtime is not accepted
- **WHEN** a selected runtime is installed below its registered minimum version
- **THEN** Liftoff reports the observed and required versions and treats the blocking requirement as unresolved

#### Scenario: Failed probe is not a successful check
- **WHEN** a tool executable exists but its version or health probe exits unsuccessfully
- **THEN** Liftoff reports the tool as unhealthy with the failed probe's remedy
- **AND** it does not classify the tool as ready

#### Scenario: Unselected runtimes are omitted
- **WHEN** a standard Node.js project is selected
- **THEN** Python and Go backend runtime probes are not required for that project

#### Scenario: Stable exact pin rejects a prerelease build
- **WHEN** a selected framework CLI or package manager is required at an exact stable version and the probe returns the matching numeric version with a prerelease suffix
- **THEN** Liftoff reports the observed prerelease as incompatible
- **AND** it does not classify that tool as satisfying the stable exact pin

#### Scenario: Stable runtime floor rejects a prerelease
- **WHEN** a stable Python floor is required and the observed interpreter is a release candidate
- **THEN** its prerelease identity is retained and the runtime is not silently accepted as a stable release

### Requirement: Blocking workstation gaps stop initialization before project writes
The system SHALL require supported Node.js, every selected workload runtime, every required package manager, the selected spec-framework CLI and its installer prerequisites, and each selected AI-agent installation before committing the project. Authentication health MAY remain an explicit warning because Liftoff does not control credentials. Missing advisory infrastructure tools SHALL be deferrable with remedies.

#### Scenario: Missing backend runtime blocks
- **WHEN** a selected API backend runtime is missing and the developer does not authorize or complete its installation
- **THEN** initialization exits unsuccessfully before writing the destination
- **AND** the output identifies the exact runtime remedy

#### Scenario: Missing Power Apps Node baseline blocks
- **WHEN** a retired Power Apps request is made regardless of the installed Node.js version
- **THEN** workload retirement blocks preparation without probing or offering its former Node baseline

#### Scenario: Missing required package manager blocks
- **WHEN** a selected framework or dependency phase requires npm and no compatible `npm` executable is available
- **THEN** initialization exits unsuccessfully before writing the destination
- **AND** it identifies npm as the missing prerequisite even when `node` is installed

#### Scenario: Missing selected agent blocks installation readiness
- **WHEN** Claude Code is selected and no `claude` executable is available
- **THEN** initialization requires Claude Code installation before project commit

#### Scenario: Agent authentication remains user-controlled
- **WHEN** a selected agent is installed but its health probe indicates that authentication is required
- **THEN** Liftoff reports a warning with the agent-owned login remedy
- **AND** Liftoff does not request, store, or modify credentials

#### Scenario: Advisory tool is deferred honestly
- **WHEN** an applicable advisory tool is missing and the developer declines or cannot perform its setup
- **THEN** initialization may continue
- **AND** completion states what remains unavailable and shows the remedy

### Requirement: Project dependency installation is a separate final phase
The system SHALL offer workload-specific project dependency installation only after the staged scaffold has been committed successfully. Interactive execution SHALL require a separate confirmation, non-interactive execution SHALL require `--install-dependencies`, and `--install-tools` SHALL NOT imply project dependency installation. Every command SHALL consume committed dependency metadata without rewriting it, SHALL preserve detected edits of uncertain or concurrent origin rather than blindly restoring every protected-file difference, and SHALL report exact recovery paths with shell-literal quoting for the selected shell. Liftoff SHALL NOT claim that arbitrary project install scripts are confined to lockfiles or another narrower write set than it can actually prove.

#### Scenario: Install Python project dependencies
- **WHEN** a Python API project was initialized and dependency installation is authorized
- **THEN** Liftoff runs the registered platform-correct `uv sync --frozen` command for the generated project
- **AND** the generated `pyproject.toml` and `uv.lock` remain byte-for-byte unchanged

#### Scenario: Install Node.js backend dependencies
- **WHEN** a Node.js API backend was initialized and dependency installation is authorized
- **THEN** Liftoff runs the registered lockfile-preserving `npm ci` command in the backend directory

#### Scenario: Install an optional API frontend
- **WHEN** an API workload includes a generated frontend and dependency installation is authorized
- **THEN** Liftoff runs the registered lockfile-preserving `npm ci` command in the frontend directory

#### Scenario: Prepare Go project dependencies
- **WHEN** a Go project was initialized and dependency installation is authorized
- **THEN** Liftoff downloads modules using the generated `go.mod` and `go.sum` without requiring an unrecorded metadata rewrite

#### Scenario: Install Power Apps project dependencies
- **WHEN** dependency preparation is requested for a retired Power Apps project
- **THEN** it reports unsupported workload without executing npm or another installer in that project

#### Scenario: Dependency installation is declined
- **WHEN** a developer declines the final dependency-install prompt
- **THEN** initialization completes with the valid scaffold intact and prints the exact workload-specific project-local frozen install command

#### Scenario: Dependency installation fails
- **WHEN** an authorized project dependency command fails or changes protected dependency metadata
- **THEN** Liftoff exits unsuccessfully without deleting the committed scaffold
- **AND** it identifies the failed command, the exact preserved or restored paths, and the exact resume command

#### Scenario: Uncertain file edits are preserved
- **WHEN** a dependency command or install script fails after changing a protected file and Liftoff cannot prove that another changed path belongs to its attributable write set
- **THEN** Liftoff preserves the uncertain path on disk
- **AND** it reports that path as requiring developer review instead of restoring it automatically

#### Scenario: Recovery recipes quote literal paths for the selected shell
- **WHEN** failure output references a changed path containing spaces or `$` characters on Windows, macOS, or Linux
- **THEN** Liftoff prints a recovery recipe using literal path quoting appropriate for the selected shell
- **AND** it does not present JSON string escaping as shell-safe recovery guidance

#### Scenario: Install on Windows
- **WHEN** an authorized Python dependency setup runs on Windows
- **THEN** Liftoff invokes `uv` with argument arrays and platform-native working-directory resolution
- **AND** it does not construct a shell activation command or hardcode a Unix virtual-environment path

### Requirement: Workstation probes use the release baseline
The shared workstation requirement registry SHALL derive runtime, package-manager, and framework minimums from the named supported-stack baseline. Initialization SHALL reject a selected requirement below its recorded floor, SHALL accept compatible newer patches within the supported release policy, and SHALL reject prerelease versions when the baseline requires an exact stable release without substituting the observed version into generated bytes.

#### Scenario: Probe current supported runtimes
- **WHEN** a plan requires Node.js 24 LTS, Python 3.14, Go 1.27, OpenSpec 1.11, or Spec Kit 1.0
- **THEN** the corresponding probe compares the observed version with the baseline constraint
- **AND** its installation remedy references the same release line

#### Scenario: Host has a newer unsupported major
- **WHEN** a host tool is numerically newer but outside the baseline's supported constraint
- **THEN** initialization reports it as incompatible rather than automatically treating it as ready

#### Scenario: Stable exact baseline rejects a prerelease string
- **WHEN** a selected requirement is pinned to an exact stable release and the observed tool reports the same numeric version with a prerelease identifier
- **THEN** initialization reports the tool as incompatible with the stable baseline
- **AND** it does not silently trim the prerelease suffix

## REMOVED Requirements

### Requirement: Power Apps project tooling is verified without global installation
**Reason**: Power Apps project generation and maintenance are fully retired, so workstation readiness no longer needs a special project-local Code Apps tooling contract.

**Migration**: Liftoff rejects retired `power-apps-code-app` inputs and manifests before workload-specific dependency or doctor setup. Remaining supported workloads continue to use their explicit runtime and package-manager requirements.

### Requirement: Code Apps plugin readiness is optional and host-specific
**Reason**: Retiring Power Apps removes the only supported path that requested or reported the preview Code Apps plugin.

**Migration**: Liftoff no longer derives plugin readiness from project plans or manifests, and it does not install, probe, or report that retired plugin as part of supported workstation setup.
