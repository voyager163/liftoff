## MODIFIED Requirements

### Requirement: Eligible command executions emit one aggregate event
Each telemetry-eligible recognized command SHALL emit at most one anonymous command_executed event while enabled. New command events use schema 2 and exactly schemaVersion, event, command, cliVersion and outcome, with semantic outcome success, attention-required, cancelled or failure. Actual failed partial execution SHALL remain failure even if its exit is 2; expected drift/update availability SHALL be attention-required. Legacy schema-1 zero/nonzero records SHALL remain unchanged. Separately opted-in project observations follow their own contract and SHALL not add project fields to anonymous command events.

#### Scenario: Top-level command succeeds
- **WHEN** a recognized command completes its requested scope successfully
- **THEN** one anonymous command event reports success

#### Scenario: Nested command fails
- **WHEN** a nested command has an actual execution failure
- **THEN** its explicit command:subcommand identity reports failure

#### Scenario: Invocation is rejected before command recognition
- **WHEN** parsing cannot resolve an allowlisted command
- **THEN** no event is sent

#### Scenario: Command help is requested
- **WHEN** eligible help is requested
- **THEN** its anonymous command is help, preserving all existing assessment/help exclusions

#### Scenario: Expected differences return exit two
- **WHEN** a successful check finds actionable maintenance without an execution failure
- **THEN** schema 2 records attention-required rather than failure

### Requirement: Event payloads contain no identifying or project data
Anonymous command events SHALL retain their prohibition on installation/session/user/device IDs, client timestamps, IP, arguments, flags, paths, project names/URLs, source/manifests, errors, duration, OS/runtime/cloud/workload/environment choices. Only separately and explicitly consented project observations SHALL carry a random project ID plus the exact allowed release/policy/template/source dimensions. Project IDs are pseudonymous/linkable, not anonymous, and SHALL not be derived from repository URLs, names, paths or device identity.

#### Scenario: Command includes project details and flags
- **WHEN** an invocation contains paths, names or configuration
- **THEN** those raw values never appear in either telemetry payload

#### Scenario: Commands run across multiple sessions
- **WHEN** anonymous command events are emitted repeatedly
- **THEN** they contain no installation/session correlation identity

#### Scenario: Project is not enrolled
- **WHEN** project consent is absent or cannot be validated
- **THEN** no project identifier is generated or transmitted

### Requirement: Users and automation can disable telemetry
LIFTOFF_TELEMETRY=0 and DO_NOT_TRACK=1 SHALL disable all telemetry, notice/consent writes and transport. CI=true SHALL continue disabling ordinary command/project telemetry. The sole CI exception SHALL be an explicit project-report/heartbeat operation whose project enrollment and separate CI enablement are valid; it SHALL still obey both global opt-outs. Installation, migration, yes flags or ordinary CI execution SHALL not enable the exception.

#### Scenario: Liftoff-specific opt-out
- **WHEN** LIFTOFF_TELEMETRY=0 is set
- **THEN** no telemetry side effects occur, including in an enabled heartbeat job

#### Scenario: Standard do-not-track signal
- **WHEN** DO_NOT_TRACK=1 is set
- **THEN** all delivery and disclosure/consent mutation is disabled

#### Scenario: Continuous integration
- **WHEN** CI=true and no separately enabled explicit heartbeat/report operation runs
- **THEN** ordinary telemetry remains disabled regardless of project records

### Requirement: Telemetry transport is bounded and failure-isolated
Ordinary eligible commands SHALL make at most one command-event request and, only with valid separate consent, one project-observation request, sharing an absolute one-second overall delivery budget. Each uses HTTPS with no retries, queue or event persistence. Ordinary command output/exit status SHALL remain unchanged on any delivery result. Explicit report commands SHALL instead report their own delivery/disabled/failure result without initiating command-event recursion.

#### Scenario: Endpoint accepts the event
- **WHEN** accepted delivery completes in budget
- **THEN** the original ordinary command status is preserved

#### Scenario: Endpoint fails or times out
- **WHEN** any delivery fails or exhausts the shared budget
- **THEN** ordinary execution does not wait longer, retry, queue or change its exit status

### Requirement: Disclosure state is portable and non-identifying
Global configuration SHALL preserve the anonymous notice version and add only explicitly approved project-consent bindings needed for project reporting, without creating installation/session/user/device IDs. Enrollment identity lives in its explicit project record, outside deterministic rendering. Config updates SHALL be atomic, platform-correct and preserve unknown valid fields; invalid/read-only configuration SHALL not be overwritten or treated as consent.

#### Scenario: XDG configuration is selected
- **WHEN** XDG_CONFIG_HOME is set
- **THEN** user-local notice/consent paths use native safe resolution beneath it

#### Scenario: Windows fallback is selected
- **WHEN** Windows lacks XDG_CONFIG_HOME
- **THEN** configuration uses the declared APPDATA location with Windows semantics

#### Scenario: Unix fallback is selected
- **WHEN** macOS/Linux lacks XDG_CONFIG_HOME
- **THEN** the declared user configuration path is used without project-local fallback

#### Scenario: Existing config is invalid or read-only
- **WHEN** consent cannot be safely read or persisted
- **THEN** project enrollment/delivery is blocked with an honest result and the file remains unchanged
- **AND** anonymous disclosure retains its existing repeat-notice behavior without fabricated consent

### Requirement: The ingestion gateway enforces the public event contract
The HTTPS-only Container App SHALL retain POST/JSON/1-KiB streamed-byte validation for /api/events and add an independently strict project-event endpoint. Each endpoint SHALL accept only its explicitly versioned property set, event/command allowlist, bounded release values and valid outcome/dimensions. Legacy command schema 1 remains accepted; command schema 2 and project schema 2 SHALL not be confused. Unsupported versions/fields, arrays, malformed bodies and oversized requests SHALL be rejected without body logging.

#### Scenario: Valid event is accepted
- **WHEN** a request exactly matches its endpoint's supported schema
- **THEN** one approved record is submitted through managed identity

#### Scenario: Additional field is supplied
- **WHEN** an anonymous command event includes an ID or either endpoint includes a raw name/path/timestamp or unknown property
- **THEN** the gateway rejects it without ingestion

#### Scenario: Payload is malformed or oversized
- **WHEN** method, content type, schema, values, body shape or byte limit is invalid
- **THEN** it is rejected without logging its body

### Requirement: Stored events exclude request metadata
The command table SHALL retain TimeGenerated, EventName, SchemaVersion, Command, CliVersion and Outcome. A distinct project table SHALL contain only TimeGenerated, EventName, SchemaVersion, ProjectId, CliVersion, PolicyProfile, PolicyVersion, TemplateSetDigest and Source from the validated project schema. Ingestion time is server-generated; raw requests, headers, query strings, IP/geolocation and ingress/console traces SHALL not populate either table. Only Azure's documented system columns may be additional storage columns.

#### Scenario: Public request reaches Azure
- **WHEN** networking routes a request
- **THEN** product ingestion does not copy its source address or transport metadata into storage

#### Scenario: DCR receives a gateway record
- **WHEN** a validated command or project record is uploaded
- **THEN** the corresponding rule projects only that table's explicit application columns

#### Scenario: Gateway monitoring is configured
- **WHEN** telemetry infrastructure is deployed or extended
- **THEN** no Application Insights credentials or persistent request/console/IP logging is introduced

### Requirement: Self-upgrade emits only the aggregate command event
Upgrade SHALL emit at most one anonymous aggregate from the originally invoked process, using its CLI version and schema-2 semantic outcome. It SHALL never emit a project observation merely because invocation occurred inside a project. Replacement verification and installer migration probes SHALL suppress telemetry and disclosure.

#### Scenario: Upgrade succeeds
- **WHEN** verified replacement succeeds
- **THEN** the original process can emit one success event

#### Scenario: Upgrade check finds an update
- **WHEN** check reports an installable update with exit 2
- **THEN** the new schema records attention-required without target or installation details

#### Scenario: Replacement verification runs
- **WHEN** the replacement executable is invoked for verification
- **THEN** it creates no event or disclosure state

## ADDED Requirements

### Requirement: Project enrollment has independent explicit consent
Project-level reporting SHALL be off until a developer explicitly approves its disclosed pseudonymous fields and purpose. Enrollment SHALL create a random UUID only for one validated Liftoff project root/manifest and bind local consent externally; a copied project record alone SHALL not enroll another developer. Clones/worktrees share the measurement identity, independent monorepo projects differ, and independent forks/copies require deliberate new enrollment rather than automatic URL/path hashing.

#### Scenario: Existing npm user migrates to Homebrew
- **WHEN** installer ownership changes
- **THEN** existing opt-outs/consent remain intact and project reporting is not enabled automatically

#### Scenario: Deterministic project rendering runs
- **WHEN** the same plan is rendered twice
- **THEN** no random reporting ID or consent affects generated bytes

#### Scenario: Two projects share a repository
- **WHEN** both roots are explicitly enrolled
- **THEN** each has a distinct ID and repeated observations across its clones deduplicate to that ID

### Requirement: Monthly CI heartbeat requires a second enablement
Setup SHALL offer a separately approved monthly reporting workflow only for enrolled projects. It SHALL use exact repository-scoped artifact ownership and an explicit selected-root inventory, pinned tooling and read-only permissions. It SHALL not execute application scripts, discover/enroll unrelated manifests, repair/update projects or deploy resources. Removing one project's enablement SHALL preserve other enrolled roots and unrelated workflow content.

#### Scenario: Enrollment is approved but heartbeat is declined
- **WHEN** the developer consents only to project reporting
- **THEN** no scheduled workflow or CI exception is enabled

#### Scenario: Nested project enables CI reporting
- **WHEN** a repository-root workflow outside the project needs modification
- **THEN** the separate exact repository write scope is reviewed and existing project entries are preserved

#### Scenario: Enrolled project disables reporting
- **WHEN** its enrollment or heartbeat enablement is disabled
- **THEN** subsequent CI runs emit no observation for that root

### Requirement: Assessment and discovery never enroll or report projects
Whole-project and governance assessment, including live/help modes, capability discovery, repair capability/layout inventory, telemetry status and installer dry-run SHALL perform no telemetry/disclosure/consent side effects. Reporting/enrollment SHALL be explicit operations, not hidden consequences of diagnosing a project.

#### Scenario: Opted-in project runs live assessment
- **WHEN** assessment uses its separately authorized provider reads
- **THEN** no project/command telemetry or consent-state write occurs

### Requirement: Project events and retention have a bounded privacy contract
Project schema 2 SHALL contain only schemaVersion, event, projectId, cliVersion, policyProfile, policyVersion, templateSetDigest and source, with strictly validated release-owned values and explicit none where inapplicable. Both command and project tables SHALL retain 180-day analytics/total retention with no implicit lifetime identifier store. Disablement stops future reporting, not historical deletion; documentation SHALL distinguish the operator-reviewed deletion process from possession of a public project ID.

#### Scenario: An accepted project event ages out
- **WHEN** its 180-day retention expires
- **THEN** it is removed rather than moved into an undeclared lifetime store

#### Scenario: A heartbeat is received
- **WHEN** source is ci-heartbeat
- **THEN** it establishes only a reporting observation, not developer activity, deployment health or compliance

#### Scenario: Unsupported policy text is supplied
- **WHEN** an event dimension contains arbitrary prose, secret-like input or a nonallowlisted value
- **THEN** validation rejects it rather than sending or persisting free-form project data

#### Scenario: Supported projects use the same release bundle
- **WHEN** complete source validation resolves projects with different names, layouts, stacks, agents, regions or environments against the same installed registry
- **THEN** templateSetDigest is that registry's release-wide registryDigest, not a project-specific resolutionDigest or plugin-only digest
- **AND** the value describes the supported source bundle, not current application-file compliance or original generation history

#### Scenario: Source bundle cannot be established
- **WHEN** source metadata is historical, malformed, unsupported or mismatched with the validated installed declarations
- **THEN** no guessed templateSetDigest is returned and source collection does not upgrade, enroll or report the project
