## Purpose

Define plan-derived workstation readiness, safe tool installation, and optional project dependency setup for Liftoff initialization.

## Requirements

### Requirement: Workstation requirements are derived from the resolved project plan
The system SHALL build a deterministic requirement set from the selected workload and its applicable API stack, cloud provider, infrastructure output, spec workflow, frontend choice, coding agents, and optional integrations. It SHALL include only tools relevant to that plan and SHALL identify every requirement as blocking or advisory.

#### Scenario: Python OpenSpec project requirements
- **WHEN** a developer selects a Python/FastAPI project with OpenSpec and GitHub Copilot
- **THEN** the requirement set includes supported Node.js, Python, the pinned OpenSpec CLI, and a detectable Copilot installation
- **AND** it does not require Go or Spec Kit

#### Scenario: Go Spec Kit project requirements
- **WHEN** a developer selects a Go/Huma project with Spec Kit and Claude Code
- **THEN** the requirement set includes supported Node.js, Python, Go, `uv`, the pinned Spec Kit CLI, and Claude Code
- **AND** it does not require a Python backend dependency installation

#### Scenario: Power Apps OpenSpec project requirements
- **WHEN** a developer selects a Power Apps code app with OpenSpec, Copilot, and Claude Code
- **THEN** the requirement set includes the tested Node.js LTS baseline, pinned OpenSpec CLI, Copilot, and Claude Code
- **AND** it omits Python, Go, Docker, OpenTofu, Azure CLI, and backend runtime requirements

#### Scenario: Infrastructure tools are advisory
- **WHEN** an API workload includes Azure OpenTofu infrastructure and Docker-based local development
- **THEN** Docker, OpenTofu, and Azure CLI readiness appear as advisory requirements
- **AND** declining them does not falsely report them as ready

### Requirement: Liftoff automatically detects tool presence, version, and health
The system SHALL run allowlisted read-only probes for every selected requirement before destination writes, SHALL classify each result as ready, missing, outdated, unhealthy, or not observable, and SHALL compare versioned tools with the requirement registry's tested constraint.

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

### Requirement: Blocking workstation gaps stop initialization before project writes
The system SHALL require supported Node.js, every selected workload runtime, the selected spec-framework CLI and its installer prerequisites, and each selected AI-agent installation before committing the project. Authentication health MAY remain an explicit warning because Liftoff does not control credentials. Missing advisory infrastructure or optional agent-plugin tools SHALL be deferrable with remedies.

#### Scenario: Missing backend runtime blocks
- **WHEN** a selected API backend runtime is missing and the developer does not authorize or complete its installation
- **THEN** initialization exits unsuccessfully before writing the destination
- **AND** the output identifies the exact runtime remedy

#### Scenario: Missing Power Apps Node baseline blocks
- **WHEN** a Power Apps plan observes Node.js below the workload's tested LTS minimum and no successful upgrade is authorized
- **THEN** initialization exits unsuccessfully before writing the destination
- **AND** it identifies both the observed and required versions

#### Scenario: Missing selected agent blocks installation readiness
- **WHEN** Claude Code is selected and no `claude` executable is available
- **THEN** initialization requires Claude Code installation before project commit

#### Scenario: Agent authentication remains user-controlled
- **WHEN** a selected agent is installed but its health probe indicates that authentication is required
- **THEN** Liftoff reports a warning with the agent-owned login remedy
- **AND** Liftoff does not request, store, or modify credentials

#### Scenario: Advisory tool is deferred honestly
- **WHEN** an applicable advisory tool or optional Code Apps plugin is missing and the developer declines or cannot perform its setup
- **THEN** initialization may continue
- **AND** completion states what remains unavailable and shows the remedy

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
The system SHALL represent probes and installation recipes as an executable plus argument array owned by the requirement registry, SHALL NOT interpolate project input into shell command strings, SHALL fail on a non-zero installation exit, and SHALL re-run the registered probe before marking a tool ready.

#### Scenario: Installation succeeds and verifies
- **WHEN** an allowlisted installer exits successfully and the post-install probe satisfies the registered constraint
- **THEN** the requirement becomes ready and initialization continues

#### Scenario: Installer exits unsuccessfully
- **WHEN** an installation command exits non-zero
- **THEN** Liftoff stops before destination writes and displays the failed command, exit result, and manual remedy

#### Scenario: Installer success does not hide failed verification
- **WHEN** an installer exits zero but the installed command remains missing or incompatible
- **THEN** Liftoff keeps the requirement unresolved and reports the post-install probe result

#### Scenario: Terminal restart is required
- **WHEN** an installation succeeds but the executable is not observable in the current process after documented install locations are checked
- **THEN** Liftoff asks the developer to refresh or restart the terminal and rerun the printed `liftoff init` command
- **AND** no destination file has been written

### Requirement: Project dependency installation is a separate final phase
The system SHALL offer workload-specific project dependency installation only after the staged scaffold has been committed successfully. Interactive execution SHALL require a separate confirmation, non-interactive execution SHALL require `--install-dependencies`, and `--install-tools` SHALL NOT imply project dependency installation. Every command SHALL consume committed dependency metadata without rewriting it.

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

#### Scenario: Install Power Apps project dependencies
- **WHEN** a Power Apps code app was initialized and dependency installation is authorized
- **THEN** Liftoff runs the platform-correct lockfile-preserving `npm ci` command once at the project root

#### Scenario: Prepare Go project dependencies
- **WHEN** a Go project was initialized and dependency installation is authorized
- **THEN** Liftoff downloads modules using the generated `go.mod` and `go.sum` without requiring an unrecorded metadata rewrite

#### Scenario: Dependency installation is declined
- **WHEN** a developer declines the final dependency-install prompt
- **THEN** initialization completes with the valid scaffold intact and prints the exact workload-specific project-local frozen install command

#### Scenario: Dependency installation fails
- **WHEN** an authorized project dependency command fails or changes protected dependency metadata
- **THEN** Liftoff exits unsuccessfully without deleting the committed scaffold
- **AND** it identifies the failed command and exact resume command

#### Scenario: Install on Windows
- **WHEN** an authorized Python dependency setup runs on Windows
- **THEN** Liftoff invokes `uv` with argument arrays and platform-native working-directory resolution
- **AND** it does not construct a shell activation command or hardcode a Unix virtual-environment path

### Requirement: Power Apps project tooling is verified without global installation
The system SHALL treat the Power Apps SDK, Vite plugin, and npm-based Code Apps CLI as project dependencies pinned by the generated package and lockfile rather than global workstation tools. Before dependencies exist, Liftoff SHALL verify their declared package metadata; after installation, doctor MAY run the packaged binary only with `npx --no-install`.

#### Scenario: Plan does not require a global Power Apps CLI
- **WHEN** Liftoff evaluates a new Power Apps plan before project dependency installation
- **THEN** it does not fail because `power-apps` or `pac` is absent from the global PATH
- **AND** it identifies root `npm ci` as the project-local setup action

#### Scenario: Installed project CLI is probed safely
- **WHEN** doctor runs in a Power Apps project whose dependencies are installed
- **THEN** it may invoke `npx --no-install power-apps --version` as a read-only probe
- **AND** it does not permit npx to download a missing package

### Requirement: Code Apps plugin readiness is optional and host-specific
The system SHALL derive a Code Apps plugin advisory only when the Power Apps plan enables that preference. It SHALL evaluate each selected coding-agent host independently through an allowlisted read-only probe when available, distinguish ready, missing, and not observable states, and SHALL NOT classify the plugin as a blocking framework or agent requirement.

#### Scenario: Plugin preference is disabled
- **WHEN** a Power Apps plan does not request the preview plugin
- **THEN** initialization and doctor omit plugin readiness results

#### Scenario: Plugin is observable for one selected agent
- **WHEN** Copilot reports the canonical plugin installed but Claude Code plugin state cannot be observed
- **THEN** Liftoff reports Copilot ready and Claude Code not observable
- **AND** the unobservable advisory does not block initialization

#### Scenario: No safe targeted installer exists
- **WHEN** the requested plugin is missing and the requirement registry has no target-specific noninteractive recipe
- **THEN** Liftoff prints pinned manual marketplace guidance
- **AND** `--install-tools` does not run Microsoft's broad installer or an agent-session slash command

### Requirement: Workstation probes use the release baseline
The shared workstation requirement registry SHALL derive runtime and framework minimums from the named supported-stack baseline. Initialization SHALL reject a selected runtime below its recorded floor and SHALL accept compatible newer patches within the supported release policy without substituting the observed version into generated bytes.

#### Scenario: Probe current supported runtimes
- **WHEN** a plan requires Node.js 24 LTS, Python 3.14, Go 1.27, OpenSpec 1.11, or Spec Kit 1.0
- **THEN** the corresponding probe compares the observed version with the baseline constraint
- **AND** its installation remedy references the same release line

#### Scenario: Host has a newer unsupported major
- **WHEN** a host tool is numerically newer but outside the baseline's supported constraint
- **THEN** initialization reports it as incompatible rather than automatically treating it as ready
