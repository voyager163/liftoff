## ADDED Requirements

### Requirement: Self-upgrade emits only the aggregate command event
The telemetry command allowlist and ingestion validation SHALL recognize `upgrade` as one top-level command. An eligible invocation SHALL emit at most one normal `command_executed` event from the process the developer invoked, using the existing running CLI version and zero/nonzero outcome mapping.

#### Scenario: Upgrade succeeds
- **WHEN** `liftoff upgrade` completes with exit code 0 and telemetry is enabled
- **THEN** at most one event contains command `upgrade`, the invoked CLI version, and outcome `success`

#### Scenario: Upgrade check finds an update
- **WHEN** `liftoff upgrade --check` exits 2
- **THEN** the existing nonzero outcome mapping records `failure`
- **AND** no flag or target-version detail is added

#### Scenario: Replacement verification runs
- **WHEN** apply mode executes the newly installed binary to verify its version
- **THEN** the verification subprocess emits no telemetry event or disclosure state
- **AND** the parent upgrade remains the only eligible event

### Requirement: Upgrade telemetry excludes installation details
Self-upgrade telemetry SHALL NOT include check or apply mode, current or target version beyond the existing invoked `cliVersion`, registry kind or URL, package manager output, installation origin, global prefix, current directory, project presence, reason code, error text, duration, or repair command.

#### Scenario: Upgrade is blocked by a private mirror
- **WHEN** a configured registry cannot expose the canonical target
- **THEN** any emitted event contains only the existing five telemetry fields
- **AND** contains no registry or failure detail
