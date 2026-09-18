## Purpose

Define plan-derived workstation readiness, safe tool installation, and optional project dependency setup for Liftoff initialization.

## Requirements

### Requirement: Workstation requirements are derived from the resolved project plan
The system SHALL build a deterministic requirement set from the selected workload and applicable API stack, cloud provider, infrastructure output, spec workflow, frontend, coding agents, and optional integrations. It SHALL include only external tools required by that plan, model required package managers separately from runtimes, and classify every requirement as blocking or advisory. The native CLI's private runtime SHALL NOT create an unconditional global Node/npm requirement or satisfy a selected project's external tool requirement.

#### Scenario: Python OpenSpec project requirements
- **WHEN** a developer selects a Python/FastAPI project with OpenSpec and GitHub Copilot
- **THEN** the requirement set includes Python, external Node/npm and the pinned OpenSpec CLI required by the selected workflow, and a detectable compatible Copilot installation
- **AND** it does not require Go or Spec Kit

#### Scenario: Go Spec Kit project requirements
- **WHEN** a developer selects a Go/Huma project with Spec Kit and Claude Code
- **THEN** the requirement set includes Python, Go, `uv`, pinned Spec Kit, Claude Code, and additional tools required by explicitly selected frontend or integrations
- **AND** it does not require a Python backend dependency installation or external Node solely to run Liftoff

#### Scenario: Power Apps OpenSpec project requirements
- **WHEN** a request identifies Power Apps with OpenSpec
- **THEN** it is rejected before a former Power Apps requirement set is selected or probed

#### Scenario: Required package manager is included explicitly
- **WHEN** a selected stack, framework, agent contract, or dependency phase requires `npm`
- **THEN** the requirement set includes a compatible npm prerequisite distinct from the Node.js runtime
- **AND** neither an observed `node` executable nor the bundled CLI runtime establishes npm readiness

#### Scenario: Infrastructure tools are advisory
- **WHEN** an API workload includes Azure OpenTofu infrastructure and Docker-based local development
- **THEN** Docker, OpenTofu, and Azure CLI readiness are advisory for local initialization where their execution is not required
- **AND** declining them does not falsely report them ready or satisfy later activation prerequisites

### Requirement: Liftoff automatically detects tool presence, version, and health
The system SHALL run allowlisted read-only probes for every selected requirement before destination writes and classify availability, compatibility, and health with a specific cause. It SHALL compare versioned runtimes, package managers, and framework tools with their registered tested constraints rather than registry latest. Stable exact pins and runtime floors SHALL continue rejecting prereleases unless explicitly allowed. Compatible official stable or preview Copilot, Claude, and Codex installations SHALL satisfy their agent requirements, with preview status reported as a notice rather than an outdated-tool blocker.

#### Scenario: Supported runtime is ready
- **WHEN** the selected Python runtime probe returns a version satisfying the registered minimum
- **THEN** Liftoff reports Python as ready and does not offer to reinstall it

#### Scenario: Outdated runtime is not accepted
- **WHEN** a selected runtime is installed below its registered minimum version
- **THEN** Liftoff reports the observed and required versions and treats the blocking requirement as unresolved

#### Scenario: Failed probe is not a successful check
- **WHEN** a tool executable exists but its version or required health probe exits unsuccessfully
- **THEN** Liftoff reports the actual probe failure
- **AND** does not classify the tool as satisfying a required constraint

#### Scenario: Unselected runtimes are omitted
- **WHEN** a standard Node.js project is selected
- **THEN** Python and Go backend runtime probes are not required for that project

#### Scenario: Stable exact pin rejects a prerelease build
- **WHEN** a selected framework CLI or package manager is required at an exact stable version and the probe returns its numeric version with a prerelease suffix
- **THEN** Liftoff reports the observed prerelease as incompatible with that requirement
- **AND** it does not classify the tool as satisfying the stable exact pin

#### Scenario: Stable runtime floor rejects a prerelease
- **WHEN** a stable Python floor is required and the observed interpreter is a release candidate
- **THEN** its prerelease identity is retained and the runtime is not silently accepted as stable

#### Scenario: Compatible preview coding agent is installed
- **WHEN** a selected Copilot, Claude, or Codex installation is usable and compatible but reports an official preview version
- **THEN** the agent requirement is ready with a preview notice
- **AND** setup does not demand a downgrade merely to remove the suffix

#### Scenario: A newer compatible release exists
- **WHEN** an installed tool satisfies its declared constraints but a newer release is available
- **THEN** update availability is advisory
- **AND** the existence of that release alone does not block the requested operation

### Requirement: Blocking workstation gaps stop initialization before project writes
The system SHALL require every selected external workload runtime, package manager, specification-framework CLI and installer prerequisite, and coding-agent installation before committing the project. External Node/npm SHALL be required when the selected project or tool contract needs them, not merely because Liftoff contains a private Node runtime. Authentication health SHALL remain an explicit warning where Liftoff does not control credentials, and missing advisory infrastructure tools SHALL remain deferrable with remedies.

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
- **AND** npm remains the missing prerequisite even if external Node or the private CLI runtime is present

#### Scenario: Missing selected agent blocks installation readiness
- **WHEN** Claude Code is selected and no compatible detectable Claude installation is available
- **THEN** initialization requires Claude Code installation before project commit

#### Scenario: Agent authentication remains user-controlled
- **WHEN** a selected agent is installed but its health probe indicates that authentication is required
- **THEN** Liftoff reports a warning with the agent-owned login remedy
- **AND** Liftoff does not request, store, or modify credentials

#### Scenario: Advisory tool is deferred honestly
- **WHEN** an applicable advisory tool is missing and the developer declines or cannot perform its setup
- **THEN** initialization can continue if all blocking requirements are satisfied
- **AND** completion states what remains unavailable and shows the remedy

#### Scenario: No selected contract requires external Node
- **WHEN** all selected Go/Spec Kit, agent, and other tool contracts are satisfied without Node/npm and no frontend or integration adds that requirement
- **THEN** native Liftoff can complete local initialization without installing global Node/npm
- **AND** it does not use its own runtime as fabricated proof of an external tool

### Requirement: OpenSpec global profile compatibility is a blocking readiness check
The system SHALL inspect the selected pinned OpenSpec CLI's global configuration before initializing an OpenSpec project. A compatible configuration MUST use profile `custom`, delivery `both`, and exactly the workflow set `propose`, `explore`, `new`, `continue`, `apply`, `update`, `ff`, `sync`, `archive`, `bulk-archive`, `verify`, and `onboard`, independent of array order.

#### Scenario: Global profile already matches
- **WHEN** the pinned OpenSpec CLI reports the required profile, delivery, and workflow set
- **THEN** Liftoff performs no global configuration write
- **AND** it proceeds to staged framework initialization

#### Scenario: Global profile differs
- **WHEN** OpenSpec reports `core`, a delivery other than `both`, a missing required workflow, or an additional unsupported workflow
- **THEN** Liftoff reports the observed and required values
- **AND** it treats the mismatch as blocking until separately authorized and successfully corrected

#### Scenario: Spec Kit does not require an OpenSpec profile
- **WHEN** the resolved project selects Spec Kit
- **THEN** Liftoff does not inspect or modify the global OpenSpec profile

#### Scenario: Global profile cannot be inspected
- **WHEN** the pinned OpenSpec config command fails, times out, or returns malformed machine output
- **THEN** Liftoff exits before destination writes with the failed command and corrective guidance
- **AND** it does not assume the profile is compatible

### Requirement: Interactive machine-tool installation requires per-tool consent
The system SHALL present each unresolved selected tool separately with its purpose, required version or health state, exact allowlisted installation command, and a confirmation prompt. It SHALL execute no machine-tool installation before the corresponding confirmation.

#### Scenario: Developer accepts a tool installation
- **WHEN** an interactive run shows the exact Homebrew, WinGet, npm, or `uv` command for a missing tool and the developer confirms
- **THEN** Liftoff executes that command, streams its result, and re-probes the tool

#### Scenario: Developer declines a blocking tool
- **WHEN** the developer declines installation of a blocking requirement
- **THEN** Liftoff stops before destination writes and prints a resumable `liftoff init` command

#### Scenario: Plan confirmation does not authorize installation
- **WHEN** a developer runs `liftoff init --yes` with a missing blocking tool and without `--install-tools`
- **THEN** Liftoff does not install the tool
- **AND** the run fails before destination writes with the exact installation and rerun guidance

### Requirement: Non-interactive installation uses a dedicated authorization flag
The system SHALL treat `--install-tools` as authorization to execute all applicable allowlisted installation recipes for unresolved selected tools without individual prompts. The flag SHALL NOT authorize destination overwrites, project dependency installation, package-manager bootstrapping, elevated Linux commands, or credential setup.

#### Scenario: Install selected tools non-interactively
- **WHEN** a developer runs a fully specified `liftoff init` command with `--install-tools`
- **THEN** Liftoff installs and verifies each unresolved tool for which a supported recipe exists

#### Scenario: Tool authorization does not overwrite files
- **WHEN** `--install-tools` is present and destination preflight finds a conflicting file
- **THEN** the conflict still requires interactive overwrite confirmation or `--force`

#### Scenario: Unsupported automatic recipe remains unresolved
- **WHEN** `--install-tools` is present but a blocking requirement has no safe installation recipe on the host
- **THEN** Liftoff exits before project writes with the exact manual command
- **AND** it does not construct or execute an unregistered fallback command

### Requirement: Global OpenSpec configuration requires dedicated consent and verification
The system SHALL display the exact profile changes and allowlisted OpenSpec config commands before requesting interactive consent. Noninteractive configuration SHALL require `--configure-openspec-profile`. Liftoff SHALL use the pinned OpenSpec CLI to preserve unrelated global settings, set the complete workflow list and `both` delivery, select `custom`, and then re-read the effective configuration before any project write.

#### Scenario: Developer accepts interactive profile configuration
- **WHEN** an interactive run finds an incompatible OpenSpec profile and the developer confirms the separately displayed global changes
- **THEN** Liftoff runs only the declared OpenSpec config commands
- **AND** it proceeds only after the effective profile verifies successfully

#### Scenario: Developer declines global profile configuration
- **WHEN** the developer declines the global-profile confirmation
- **THEN** Liftoff leaves the global configuration and destination unchanged
- **AND** it prints commands the developer can run and a resumable Liftoff invocation

#### Scenario: Noninteractive profile change lacks authorization
- **WHEN** a noninteractive OpenSpec `init` or `migrate` finds an incompatible global profile without `--configure-openspec-profile`
- **THEN** Liftoff exits unsuccessfully before project writes
- **AND** it does not treat `--yes` or any other consent flag as authorization

#### Scenario: Profile update fails verification
- **WHEN** an authorized config command fails or the re-read configuration still differs from the required contract
- **THEN** Liftoff exits before destination writes and reports the effective observed state
- **AND** it does not claim successful configuration

#### Scenario: Existing unrelated global settings survive
- **WHEN** the global OpenSpec config contains telemetry, feature flags, store settings, or future unknown fields
- **THEN** the authorized profile update preserves those fields while changing only profile, delivery, and workflows

### Requirement: System-tool installation uses the supported platform adapter
The system SHALL use Homebrew recipes on macOS and exact WinGet package identifiers on Windows. On Linux it SHALL detect available platform context, SHALL run cross-platform npm or `uv` recipes only when their host tool exists, and SHALL provide exact manual system-tool instructions instead of automatically invoking elevated distribution package managers.

#### Scenario: Install a macOS runtime
- **WHEN** a missing selected runtime has a registered Homebrew recipe and installation is authorized on macOS
- **THEN** Liftoff invokes `brew` with the registered formula or cask arguments

#### Scenario: Install a Windows runtime
- **WHEN** a missing selected runtime has a registered WinGet recipe and installation is authorized on Windows
- **THEN** Liftoff invokes `winget install` with the recipe's exact package ID

#### Scenario: Missing platform package manager
- **WHEN** Homebrew or WinGet is unavailable on its corresponding platform
- **THEN** Liftoff explains how to install or enable that package manager
- **AND** it does not download and execute a package-manager bootstrap script

#### Scenario: Linux system tool uses manual guidance
- **WHEN** a blocking system runtime is missing on Linux
- **THEN** Liftoff prints the detected distribution's registered manual remedy and stops before destination writes
- **AND** it does not invoke `sudo`, `apt`, `dnf`, or `pacman` automatically

#### Scenario: Linux ecosystem tool can be installed
- **WHEN** Node.js or `uv` is already available on Linux and the selected framework CLI is missing
- **THEN** authorized initialization may run the registered npm or `uv tool install` command and verify the resulting framework CLI

### Requirement: Installation commands are allowlisted and verified
The system SHALL represent probes and remediation recipes as a registry-owned executable and argument array, SHALL NOT interpolate project input into shell command strings, SHALL fail on a non-zero installer exit, and SHALL re-probe before marking a tool ready. It SHALL select remedies according to the actual cause and installation origin, compare before/after observations, and distinguish improvement, unchanged incompatibility, failed execution, and genuine executable-discovery problems. An installer exit of zero SHALL not establish that files were written or that PATH is faulty.

#### Scenario: Installation succeeds and verifies
- **WHEN** an allowlisted installer exits successfully and the post-install probe satisfies the registered constraint
- **THEN** the requirement becomes ready and initialization continues

#### Scenario: Installer exits unsuccessfully
- **WHEN** an installation command exits non-zero
- **THEN** Liftoff stops the dependent operation and displays the failed command, exit result, and causal remedy

#### Scenario: Installer success does not hide failed verification
- **WHEN** an installer exits zero but the installed command remains missing or incompatible
- **THEN** Liftoff keeps the requirement unresolved and reports the actual post-install result
- **AND** incompatibility is not relabeled as an executable-discovery failure

#### Scenario: Terminal restart is required
- **WHEN** installation succeeds but the executable is not observable in the current process after documented locations are checked
- **THEN** Liftoff reports the discovery evidence and a terminal/PATH remedy
- **AND** it does not claim that project initialization completed

#### Scenario: Package manager makes no change
- **WHEN** an installer exits zero and the same executable, version, and unsatisfied constraint remain
- **THEN** the result identifies no progress and retains the original incompatibility reason
- **AND** it neither claims the installer wrote the existing executable nor recommends the identical ineffective command repeatedly

#### Scenario: Version probe succeeds but a channel requirement fails
- **WHEN** the command is found and exits successfully but a requirement that demands stable rejects its channel
- **THEN** the remedy describes the actual supported channel/version operation or its availability limitation
- **AND** it does not ask the developer to repair PATH merely because the requirement is unresolved

#### Scenario: Windows installer leaves a shim unresolved
- **WHEN** a registered Windows installation succeeds but the current process cannot resolve its executable shim
- **THEN** native path and shim observations determine whether restart guidance is appropriate
- **AND** an already resolved incompatible executable is not confused with this case

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

These constraints SHALL identify external baseline roles. The private native runtime SHALL be reported under its own release identity and SHALL NOT be probed as the project's executable; the coding-agent preview exception SHALL NOT apply to stable framework requirements.

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

### Requirement: Version parsing preserves identity without presentation punctuation
Workstation probes SHALL parse the registered tools' supported output formats, preserving real prerelease/build identifiers while excluding surrounding prose and presentation punctuation. The observed version and executable SHALL be shown separately from the requirement and its cause. Unparseable output SHALL not be used to satisfy a versioned constraint.

#### Scenario: Stable Copilot output ends in a period
- **WHEN** the probe returns `GitHub Copilot CLI 1.0.83.`
- **THEN** the observed version is `1.0.83`, not an absent version

#### Scenario: Preview Copilot output ends in a period
- **WHEN** the probe returns `GitHub Copilot CLI 1.0.84-5.`
- **THEN** the observed version is `1.0.84-5` without the final period
- **AND** its preview identity is retained

#### Scenario: A framework uses a numeric prerelease identifier
- **WHEN** a stable-pinned framework returns a real version such as `1.11.0-1`
- **THEN** the numeric prerelease is preserved and rejected for that stable pin
- **AND** the coding-agent policy does not weaken the framework constraint

### Requirement: Workstation failures are scoped to dependent operations
Liftoff SHALL identify which requested operation depends on an unresolved tool. Required local runtimes, framework commands, selected agent installations, and applicable baseline tools SHALL remain prerequisites for that local work. Cloud authentication, provider operations, and unrelated optional tools SHALL not prevent otherwise completed local setup. Authentication notices SHALL remain user-controlled.

#### Scenario: Azure authentication is unavailable during local setup
- **WHEN** local project checks do not require provider access and Azure authentication is unavailable
- **THEN** local completion is not blocked solely by that activation prerequisite

#### Scenario: A required baseline executable is missing
- **WHEN** an applicable local check needs an unavailable executable
- **THEN** that check remains incomplete with a supported installation/remediation action
- **AND** the CLI does not silently skip it to declare completion

#### Scenario: Codex is the only selected agent
- **WHEN** Codex alone is selected for either supported framework
- **THEN** readiness probes Codex through its registered executable
- **AND** it does not require Copilot or Claude to satisfy agent readiness

### Requirement: Activation and stateful execution have their own prerequisites
When a journey enters repository enforcement, Azure activation, or stateful migration, Liftoff SHALL verify the actual tools, GitHub/provider capabilities, OpenTofu/artifact requirements, authentication, private access, and protected storage needed for that selected scope. Repository-only readiness SHALL NOT require Azure discovery or imply production qualification. Missing prerequisites and missing implementation SHALL remain distinct, and neither SHALL retroactively invalidate unrelated completed local work. Installation, authentication assistance, secure enrollment, and state inspection SHALL retain distinct permissions and registered bounded operations.

#### Scenario: Local work can complete without cloud access
- **WHEN** required local tools are ready but activation identity or private access is unavailable
- **THEN** local completion remains valid and activation identifies its exact pending prerequisite

#### Scenario: A stateful execution host cannot protect state
- **WHEN** private storage, required backend access, key access, or locking support is unavailable on that host
- **THEN** stateful execution is blocked before sensitive mutation
- **AND** it does not fall back to unprotected files or a different unapproved host

#### Scenario: Cloud authentication assistance is requested
- **WHEN** the developer explicitly authorizes a registered provider authentication flow
- **THEN** it uses the owner-controlled secure mechanism and reports resulting identity/scope
- **AND** no credential value is collected through chat or placed in source/arguments

#### Scenario: Repository-only enforcement is selected
- **WHEN** the selected journey requires source-check qualification and repository control reconciliation only
- **THEN** readiness checks the required GitHub and local capabilities without Azure access
- **AND** cloud provisioning and production readiness remain separate

#### Scenario: An executor is unavailable
- **WHEN** a required scope has ready external tools but lacks its registered production executor
- **THEN** readiness reports missing implementation
- **AND** it does not recommend reinstalling tools or authenticating again as a substitute

### Requirement: Bundled runtime and external workstation tools remain separate
Readiness SHALL distinguish the Liftoff executable/private runtime from each independently selected project, framework, and agent executable. It SHALL NOT place the private runtime on the user's PATH, use it as a general package manager, install tools into the native bundle, or change CLI installation ownership while satisfying project prerequisites. Installing Node/npm or specification tools for a selected project SHALL remain permitted under the existing per-tool consent and exact recipe contracts.

#### Scenario: Native Liftoff is ready but a Node project is not
- **WHEN** native startup succeeds and no compatible external Node/npm pair is available for a selected Node backend or Vue frontend
- **THEN** CLI readiness passes separately and project readiness remains blocked
- **AND** the remedy installs or selects the project toolchain, not a different Liftoff distribution

#### Scenario: OpenSpec still needs an external npm toolchain
- **WHEN** the selected OpenSpec installation recipe depends on external Node/npm
- **THEN** those requirements are probed and separately approved like other selected tools
- **AND** retiring npm distribution of Liftoff does not retire npm-based project or framework tooling

#### Scenario: A package-manager installation already exists
- **WHEN** the selected project tool is owned by Homebrew or WinGet
- **THEN** remediation follows that tool's observed owner and registered recipe
- **AND** it does not confuse ownership of Node with ownership of the Liftoff native package

### Requirement: Prerequisite continuations preserve exact external targets
Workstation installation, probe, and dependency continuations SHALL carry the intended external executable and argument array, selected project target, working directory, relevant configuration binding, and required consent. Displayed commands SHALL use literal quoting for the selected shell on Windows, macOS, and Linux. Changed working directories or native-bundle relocation SHALL NOT rebind relative project inputs or select Liftoff's private runtime in place of the external tool.

#### Scenario: Windows project tool lives beneath a spaced path
- **WHEN** a selected external executable or project directory has spaces on Windows
- **THEN** probes and continuations preserve the exact executable, working directory, and argument boundaries with native path and shim handling
- **AND** they do not rely on POSIX activation paths or a shell-expanded command string

#### Scenario: Resume from another directory
- **WHEN** a developer follows a dependency or prerequisite continuation from another directory on macOS or Linux
- **THEN** the continuation still targets the originally selected project and normalized configuration reference
- **AND** a changed binding requires a fresh observation rather than silently acting on another project

#### Scenario: CLI migration is not tool-install consent
- **WHEN** installation migration or native CLI upgrade completes
- **THEN** unresolved project tool and dependency requirements still need their own applicable consent
- **AND** the handover does not authorize dependency installation, framework initialization, global profile changes, or cloud operations
