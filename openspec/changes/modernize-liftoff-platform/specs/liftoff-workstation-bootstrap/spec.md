## MODIFIED Requirements

### Requirement: Workstation requirements are derived from the resolved project plan
The system SHALL build a deterministic requirement set from the selected workload and applicable API stack, cloud provider, infrastructure output, spec workflow, frontend, coding agents, and optional integrations. It SHALL include only external tools required by that plan, model required package managers separately from runtimes, and classify every requirement as blocking or advisory. The native CLI's private runtime SHALL NOT create an unconditional global Node/npm requirement or satisfy a selected project's external tool requirement.

#### Scenario: Python OpenSpec project requirements
- **WHEN** a developer selects a Python/FastAPI project with OpenSpec and GitHub Copilot
- **THEN** the set includes Python, the external Node/npm and pinned OpenSpec contract required by the selected specification workflow, and a detectable compatible Copilot installation
- **AND** it does not require Go or Spec Kit

#### Scenario: Go Spec Kit project requirements
- **WHEN** a developer selects Go/Huma with Spec Kit and Claude Code
- **THEN** the set includes Python, Go, `uv`, pinned Spec Kit, Claude Code, and any additional tools required by explicitly selected frontend or integrations
- **AND** it does not require a Python backend dependency installation or external Node solely to run Liftoff

#### Scenario: Power Apps OpenSpec project requirements
- **WHEN** a request identifies Power Apps with OpenSpec
- **THEN** it is rejected before a former Power Apps requirement set is selected or probed

#### Scenario: Required package manager is included explicitly
- **WHEN** a selected stack, framework, agent contract, or dependency phase requires npm
- **THEN** the set includes compatible external npm separately from Node.js
- **AND** neither an observed `node` executable nor the bundled CLI runtime establishes npm readiness

#### Scenario: Infrastructure tools are advisory
- **WHEN** an API workload includes Azure OpenTofu infrastructure and Docker-based local development
- **THEN** Docker, OpenTofu, and Azure CLI readiness are advisory for local initialization where their execution is not required
- **AND** declining them does not falsely report them ready or satisfy later activation prerequisites

### Requirement: Blocking workstation gaps stop initialization before project writes
The system SHALL require every selected external workload runtime, package manager, specification-framework CLI and installer prerequisite, and coding-agent installation before committing the project. External Node/npm SHALL be required when the selected project or tool contract needs them, not merely because Liftoff contains a private Node runtime. Authentication health SHALL remain an explicit warning where Liftoff does not control credentials, and missing advisory infrastructure tools SHALL remain deferrable with remedies.

#### Scenario: Missing backend runtime blocks
- **WHEN** a selected API backend runtime is missing and the developer does not authorize or complete installation
- **THEN** initialization exits unsuccessfully before writing the destination
- **AND** output identifies the exact runtime remedy

#### Scenario: Missing Power Apps Node baseline blocks
- **WHEN** a retired Power Apps request is made regardless of the installed Node.js version
- **THEN** workload retirement blocks preparation without probing or offering its former Node baseline

#### Scenario: Missing required package manager blocks
- **WHEN** a selected framework or dependency phase requires npm and no compatible external npm executable is available
- **THEN** initialization exits unsuccessfully before destination writes
- **AND** npm remains the missing prerequisite even if external Node or the private CLI runtime is present

#### Scenario: Missing selected agent blocks installation readiness
- **WHEN** Claude Code is selected and no compatible detectable Claude installation is available
- **THEN** initialization requires that selected agent installation before project commit

#### Scenario: Agent authentication remains user-controlled
- **WHEN** a selected agent is installed but its health probe requires authentication
- **THEN** Liftoff reports a warning with the agent-owned login remedy
- **AND** it does not request, store, or modify credentials

#### Scenario: Advisory tool is deferred honestly
- **WHEN** an applicable advisory tool is missing and setup is declined or unavailable
- **THEN** initialization can continue if all blocking requirements are satisfied
- **AND** completion names the remaining unavailable capability and remedy

#### Scenario: No selected contract requires external Node
- **WHEN** all selected Go/Spec Kit, agent, and other tool contracts are satisfied without Node/npm and no frontend or integration adds that requirement
- **THEN** native Liftoff can complete local initialization without installing global Node/npm
- **AND** it does not use its own runtime as fabricated proof of an external tool

### Requirement: Workstation probes use the release baseline
The shared workstation requirement registry SHALL derive external runtime, package-manager, and framework constraints from named supported-stack baseline roles. Initialization SHALL reject a selected requirement below its recorded floor, accept compatible newer patches within the supported policy, and reject prereleases for exact stable requirements without substituting observed versions into generated bytes. The private native runtime SHALL be reported under its own release identity and SHALL NOT be probed as the project's executable.

#### Scenario: Probe current supported runtimes
- **WHEN** a selected plan requires a baseline entry such as Node.js 24 LTS, Python 3.14, Go 1.27, OpenSpec 1.11, or Spec Kit 1.0
- **THEN** its external tool probe compares the observed identity with that entry's constraint
- **AND** its remedy references the same tested release line

#### Scenario: Host has a newer unsupported major
- **WHEN** a host tool is numerically newer but outside the baseline's supported constraint
- **THEN** initialization reports it incompatible rather than automatically ready

#### Scenario: Stable exact baseline rejects a prerelease string
- **WHEN** an exact stable requirement observes the same numeric version with a prerelease identifier
- **THEN** initialization preserves that identity and reports incompatibility
- **AND** it does not trim the suffix or apply the coding-agent preview exception to frameworks

### Requirement: Activation and stateful execution have their own prerequisites
When a journey enters repository enforcement, Azure activation, or stateful migration, Liftoff SHALL verify the actual tools, GitHub/provider capabilities, OpenTofu/artifact requirements, authentication, private access, and protected storage needed for that selected scope. Repository-only readiness SHALL NOT require Azure discovery or imply production qualification. Missing prerequisites and missing implementation SHALL remain distinct, and neither SHALL retroactively invalidate unrelated completed local work. Installation, authentication assistance, secure enrollment, and state inspection SHALL retain distinct permissions and registered bounded operations.

#### Scenario: Local work can complete without cloud access
- **WHEN** required local tools are ready but activation identity or private access is unavailable
- **THEN** local completion remains valid and activation identifies its exact pending prerequisite

#### Scenario: A stateful execution host cannot protect state
- **WHEN** private storage, required backend access, key access, or locking support is unavailable
- **THEN** stateful execution is blocked before sensitive mutation
- **AND** it does not fall back to unprotected files or a different unapproved host

#### Scenario: Cloud authentication assistance is requested
- **WHEN** the developer explicitly authorizes a registered provider authentication flow
- **THEN** it uses the owner-controlled secure mechanism and reports resulting identity and scope
- **AND** no credential value is collected through chat or placed in source or arguments

#### Scenario: Repository-only enforcement is selected
- **WHEN** the selected journey requires source-check qualification and repository control reconciliation only
- **THEN** readiness checks the required GitHub and local capabilities without Azure access
- **AND** cloud provisioning and production readiness remain separate

#### Scenario: An executor is unavailable
- **WHEN** a required scope has ready external tools but lacks its registered production executor
- **THEN** readiness reports missing implementation
- **AND** it does not recommend reinstalling tools or authenticating again as a substitute

## ADDED Requirements

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
