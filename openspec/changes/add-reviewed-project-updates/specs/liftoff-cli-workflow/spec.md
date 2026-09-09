## MODIFIED Requirements

### Requirement: CLI exposes discovery and validation commands
The system SHALL expose initialization, generation planning, reviewed project update and explicit checks, non-Liftoff project adoption, pattern/provider/region discovery, validation, local-development helpers, infrastructure helpers, and diagnostics. Supported activation migration SHALL use the existing update command. `--json` SHALL remain output formatting rather than a separate safety or authorization mode.

#### Scenario: List supported patterns
- **WHEN** `liftoff patterns` runs
- **THEN** all nine GenAI patterns including the generic uncertainty option retain their scaffold status

#### Scenario: Search regions
- **WHEN** `liftoff regions search korea --cloud azure` runs
- **THEN** matching region display names and slugs are listed

#### Scenario: Run diagnostics
- **WHEN** doctor runs
- **THEN** it reports context-selected readiness without modifying the project, workstation, or preview receipts

#### Scenario: Check a project for drift
- **WHEN** a user or automation runs `liftoff update --check`
- **THEN** it previews compatibility, managed-core drift, eligible provisioning, and activation migration/revalidation without prompting or changing project files
- **AND** it discloses its external receipt rather than comparing production files with new templates

#### Scenario: Apply safe drift by default
- **WHEN** a write-capable normal update plan is requested
- **THEN** a matching prior preview and explicit exact-plan approval are required before safe core changes apply
- **AND** core conflicts remain skipped without an approved forced variant

#### Scenario: Force stays inside the core boundary
- **WHEN** a forced update is requested
- **THEN** only its separately previewed eligible core conflicts/retired aliases can be overwritten or removed
- **AND** project bytes and provisioning collisions remain protected

#### Scenario: Migrate an existing project
- **WHEN** `liftoff migrate ../legacy-app` runs
- **THEN** it retains its source-preserving adoption into a fresh adjacent Liftoff scaffold
- **AND** it is not repurposed as in-place activation migration

### Requirement: Packaged README documents the current CLI lifecycle
The packaged root README SHALL retain concise first-use, supported-workload, framework/agent, exact-Git-root initialization, safety, and diagnostic guidance. Its maintenance journey SHALL lead with `liftoff update --check`, then approval through `liftoff update`, and explain the separation between CLI self-upgrade, reviewed activation migration, application-template migration, and read-only assessment. Detailed contracts SHALL remain linked rather than imply unfinished production activation is implemented.

#### Scenario: Review first-use workflow
- **WHEN** the README is read
- **THEN** installation and interactive initialization lead the guide and Power Apps is not listed as supported

#### Scenario: Review command lifecycle
- **WHEN** a user follows lifecycle links
- **THEN** command roles and the replacement of create by init remain documented
- **AND** supported activation migration stays under update

#### Scenario: Understand initialization safety
- **WHEN** initialization guidance is read
- **THEN** staging, target/conflict behavior, manifest guards, and independent consent remain discoverable

#### Scenario: Understand update safety
- **WHEN** update guidance is read
- **THEN** it explains project-read-only preview, external receipts, exact approval, protected production files, create-only expansion, preserved history, partial recovery, and removed `--apply`

#### Scenario: Understand machine-readable and exit-code behavior
- **WHEN** the CLI reference is read
- **THEN** it identifies update JSON schema 3 and distinguishes clean/completed scope, rejected/failed operations, and drift or committed partial revalidation

#### Scenario: Review contributor workflow
- **WHEN** the contribution link is followed
- **THEN** existing root build, test, check, package-smoke, and release procedures remain documented without a workspace selector

## ADDED Requirements

### Requirement: Update approval has a strict plan-bound CLI surface
The update command SHALL accept `--approve-plan <fingerprint>` only with a complete valid fingerprint for its effective normal or forced plan. It SHALL reject missing, abbreviated, malformed, or conflicting values and reject approval flags combined with check before mutations. Interactive approval SHALL use the injected command input/output and default to decline; noninteractive runs SHALL not infer approval from redirected input, JSON, force, defaults, or a generic yes.

#### Scenario: CI supplies exact approval
- **WHEN** a matching receipt and full effective fingerprint are supplied through `--approve-plan`
- **THEN** update proceeds without prompting only after current compatibility and preconditions pass

#### Scenario: CI omits approval
- **WHEN** noninteractive apply has a receipt but no exact-plan approval
- **THEN** it exits 1 with approval-required guidance and no project write

#### Scenario: The fingerprint belongs to another plan
- **WHEN** approval names a different project, target, or normal/force variant
- **THEN** apply reports the mismatch without selecting a fallback plan

#### Scenario: Check receives an approval flag
- **WHEN** check is combined with `--approve-plan`
- **THEN** usage is rejected before issuing a receipt or touching project files

#### Scenario: Interactive cancellation
- **WHEN** the user declines or cancels the approval prompt
- **THEN** apply performs no project mutation and reports the cancellation

#### Scenario: JSON is used interactively
- **WHEN** a terminal-backed apply uses JSON output and needs explicit approval
- **THEN** the prompt/progress use stderr and stdout remains one versioned result

### Requirement: Update help and errors expose the review sequence
Command help and remedies SHALL show `liftoff update --check` as the human preview, ordinary update as explicitly approved apply, the exact-plan automation flag, and the limited force variant. Missing/stale preview errors SHALL name the check command and state that no new project update was performed. Unsupported compatibility SHALL not be described as forceable.

#### Scenario: User starts with apply
- **WHEN** actionable work exists but the user has no matching preview
- **THEN** the CLI stops and directs them to `liftoff update --check`

#### Scenario: User requests update help
- **WHEN** `liftoff update --help` runs
- **THEN** it explains preview, approval, receipt storage, normal/forced plans, JSON, and exit behavior without probing or writing

#### Scenario: Project path contains spaces on Windows
- **WHEN** help/remediation describes a supported explicit project path on Windows, macOS, or Linux
- **THEN** the displayed command uses appropriate literal quoting and the same project-bound preview rules
