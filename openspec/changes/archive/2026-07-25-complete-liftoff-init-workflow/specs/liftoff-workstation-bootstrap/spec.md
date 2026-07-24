## ADDED Requirements

### Requirement: Workstation requirements are derived from the resolved project plan
The system SHALL build a deterministic requirement set from the selected project type, API stack, cloud provider, infrastructure output, spec workflow, frontend choice, and AI coding agents. It SHALL include only tools relevant to that plan and SHALL identify every requirement as blocking or advisory.

#### Scenario: Python OpenSpec project requirements
- **WHEN** a developer selects a Python/FastAPI project with OpenSpec and GitHub Copilot
- **THEN** the requirement set includes supported Node.js, Python, the pinned OpenSpec CLI, and a detectable Copilot installation
- **AND** it does not require Go or Spec Kit

#### Scenario: Go Spec Kit project requirements
- **WHEN** a developer selects a Go/Huma project with Spec Kit and Claude Code
- **THEN** the requirement set includes supported Node.js, Python, Go, `uv`, the pinned Spec Kit CLI, and Claude Code
- **AND** it does not require a Python backend dependency installation

#### Scenario: Infrastructure tools are advisory
- **WHEN** a plan includes Azure OpenTofu infrastructure and Docker-based local development
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
The system SHALL require supported Node.js, the selected backend runtime, the selected spec-framework CLI and its installer prerequisites, and each selected AI-agent installation before committing the project. Authentication health MAY remain an explicit warning because Liftoff does not control credentials. Missing advisory infrastructure tools SHALL be deferrable with remedies.

#### Scenario: Missing backend runtime blocks
- **WHEN** the selected backend runtime is missing and the developer does not authorize or complete its installation
- **THEN** initialization exits unsuccessfully before writing the destination
- **AND** the output identifies the exact runtime remedy

#### Scenario: Missing selected agent blocks installation readiness
- **WHEN** Claude Code is selected and no `claude` executable is available
- **THEN** initialization requires Claude Code installation before project commit

#### Scenario: Agent authentication remains user-controlled
- **WHEN** a selected agent is installed but its health probe indicates that authentication is required
- **THEN** Liftoff reports a warning with the agent-owned login remedy
- **AND** Liftoff does not request, store, or modify credentials

#### Scenario: Advisory tool is deferred honestly
- **WHEN** Docker is missing and the developer declines its offered installation
- **THEN** initialization may continue
- **AND** the completion output states that Docker-based local development remains unavailable and shows the remedy

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
The system SHALL offer stack-specific project dependency installation only after the staged scaffold has been committed successfully. Interactive execution SHALL require a separate confirmation, non-interactive execution SHALL require `--install-dependencies`, and `--install-tools` SHALL NOT imply project dependency installation.

#### Scenario: Install Python project dependencies
- **WHEN** a Python project was initialized and dependency installation is authorized
- **THEN** Liftoff creates the documented project-local virtual environment and installs through its interpreter

#### Scenario: Install Node.js project dependencies
- **WHEN** a Node.js backend or selected frontend was initialized and dependency installation is authorized
- **THEN** Liftoff runs the registered lockfile-preserving `npm ci` command in each applicable project directory

#### Scenario: Prepare Go project dependencies
- **WHEN** a Go project was initialized and dependency installation is authorized
- **THEN** Liftoff downloads modules using the generated `go.mod` and `go.sum` without requiring an unrecorded metadata rewrite

#### Scenario: Dependency installation is declined
- **WHEN** a developer declines the final dependency-install prompt
- **THEN** initialization completes with the valid scaffold intact and prints the exact project-local install command

#### Scenario: Dependency installation fails
- **WHEN** an authorized project dependency command fails
- **THEN** Liftoff exits unsuccessfully without deleting the committed scaffold
- **AND** it identifies the failed command and exact resume command

