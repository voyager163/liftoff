## MODIFIED Requirements

### Requirement: Baseline verification is local and deterministic
The engine SHALL run the project-applicable `liftoff validate`, backend tests,
frontend build, `docker compose config -q`, `tofu fmt -check -recursive`,
`tofu init -backend=false`, `tofu validate`, and strict OpenSpec checks before
baseline verification is recorded, including when the generated seed was
archived before activation began. It SHALL validate an active change by name
and an archived seed through its synchronized spec set with expected-capability
integrity checks. It SHALL not require a live cloud plan, start containers,
deploy, or mutate GitHub. Project paths SHALL resolve consistently on Windows,
macOS, and Linux.

#### Scenario: API project has a frontend and OpenTofu
- **WHEN** baseline setup runs
- **THEN** all applicable listed checks execute using generated commands
- **AND** success is recorded without cloud credentials or remote backend access

#### Scenario: Workload omits a component
- **WHEN** a generated workload has no frontend, Docker, or OpenTofu boundary
- **THEN** its check is recorded as inapplicable rather than simulated

#### Scenario: Baseline validation fails
- **WHEN** any applicable command fails
- **THEN** the current seed lifecycle is preserved and initial commit/push remains blocked
- **AND** no verified baseline evidence is created

#### Scenario: Seed was archived before activation began
- **WHEN** the generated bootstrap seed is already archived and no activation state exists
- **THEN** setup executes seed validation, all applicable baseline checks, and archived-spec validation through the normal phase sequence
- **AND** it does not ask OpenSpec to validate an inactive change name
- **AND** it stops at the initial publication approval gate without rewriting the archive or mutating remotes

#### Scenario: Retry an archived baseline after repair
- **WHEN** an archived seed has a persisted blocked baseline phase and its expected main capability is intact
- **THEN** read-only status, plan, and resume may expose that phase as retryable while preserving the stored blocker
- **AND** only an explicit executable transition reruns all applicable checks and records new evidence after success
- **AND** invalid identity, stale or failed predecessor evidence, and unrelated blockers remain enforced

#### Scenario: Archived capability is missing or invalid
- **WHEN** the expected main capability is missing or has a fallback Purpose
- **THEN** baseline verification fails without declaring completion or creating duplicate seed artifacts

#### Scenario: Archived setup runs from a path with spaces on Windows
- **WHEN** setup is invoked from a project directory containing spaces on Windows, macOS, or Linux
- **THEN** baseline commands receive the correct project or component working directory as a separate path value
- **AND** archived validation uses the synchronized spec set without platform-dependent path assumptions
