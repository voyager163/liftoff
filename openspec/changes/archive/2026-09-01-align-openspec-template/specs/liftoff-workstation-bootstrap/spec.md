## ADDED Requirements

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
