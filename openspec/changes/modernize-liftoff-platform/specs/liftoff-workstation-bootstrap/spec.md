## MODIFIED Requirements

### Requirement: Workstation requirements are derived from the resolved project plan
The system SHALL derive a deterministic blocking/advisory requirement set from the selected workload, framework or explicit Manual workflow, agents, frontend, infrastructure and requested operation. The packaged CLI runtime SHALL be distinguished from external project runtimes and package managers. Only applicable external requirements SHALL be probed; Manual SHALL not require OpenSpec/Spec Kit, and no-agent Manual SHALL not require an agent installation.

#### Scenario: Python OpenSpec project requirements
- **WHEN** a Python/OpenSpec project selects Copilot
- **THEN** requirements include the selected backend tools, pinned framework and its external installer/runtime prerequisites, and Copilot
- **AND** Go and Spec Kit are omitted

#### Scenario: Go Spec Kit project requirements
- **WHEN** a Go/Spec Kit project selects Claude
- **THEN** Go, the applicable Python/uv framework prerequisites and Claude are required
- **AND** global Node is not required solely because the native CLI uses an embedded Node runtime

#### Scenario: Power Apps OpenSpec project requirements
- **WHEN** a retired Power Apps request is supplied
- **THEN** retirement is rejected before probing its former requirement set

#### Scenario: Required package manager is included explicitly
- **WHEN** a selected dependency or framework operation requires npm
- **THEN** external compatible npm is a distinct prerequisite and embedded Node is not proof of its availability

#### Scenario: Infrastructure tools are advisory
- **WHEN** local initialization does not execute infrastructure
- **THEN** applicable Docker/OpenTofu/Azure tools retain their advisory classification and honest deferral

#### Scenario: Manual CLI-only project
- **WHEN** a native-installed user selects Manual and no agents
- **THEN** readiness omits framework/agent probes and global profile reads
- **AND** selected workload toolchains still apply

### Requirement: Blocking workstation gaps stop initialization before project writes
Before committing a project, Liftoff SHALL require its own supported execution runtime and every external runtime, package manager, selected framework/installer and selected agent needed by the actual plan. A native bundle's runtime SHALL not imply external tools are installed. Manual/no-agent selections SHALL impose no external framework/agent prerequisite. Authentication stays user-controlled; advisory infrastructure tools remain deferrable.

#### Scenario: Missing backend runtime blocks
- **WHEN** the selected backend runtime is unavailable and installation is declined
- **THEN** initialization stops before destination writes with the actual remedy

#### Scenario: Missing Power Apps Node baseline blocks
- **WHEN** a retired Power Apps request is supplied
- **THEN** retirement blocks without probing the former runtime

#### Scenario: Missing required package manager blocks
- **WHEN** the selected operation needs npm and external compatible npm is unavailable
- **THEN** it blocks even when the embedded or external Node executable is usable

#### Scenario: Missing selected agent blocks installation readiness
- **WHEN** Claude is explicitly selected but unavailable
- **THEN** its installation remains a prerequisite rather than silently dropping the selection

#### Scenario: Agent authentication remains user-controlled
- **WHEN** a selected installed agent needs sign-in
- **THEN** Liftoff shows the agent-owned remedy without collecting credentials

#### Scenario: Advisory tool is deferred honestly
- **WHEN** an advisory tool is declined
- **THEN** completion identifies that unavailable capability without marking it ready

## ADDED Requirements

### Requirement: Manual does not invoke global framework configuration
Manual operations SHALL not inspect, initialize, update or repair OpenSpec/Spec Kit global state. Explicit framework-only flags SHALL be rejected when incompatible with Manual before effects. Selecting optional Liftoff skills SHALL not indirectly install a spec framework.

#### Scenario: Manual runs beside an existing OpenSpec configuration
- **WHEN** Manual initialization or adoption runs on Windows, macOS or Linux
- **THEN** unrelated global framework files remain byte-identical and unselected tools are not probed
