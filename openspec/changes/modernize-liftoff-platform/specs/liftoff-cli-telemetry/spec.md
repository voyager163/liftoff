## MODIFIED Requirements

### Requirement: Eligible command executions emit one aggregate event
The system SHALL emit at most one `command_executed` event after an eligible recognized command completes while telemetry is enabled. The event SHALL contain exactly `schemaVersion`, `event`, `command`, `cliVersion`, and `outcome`; zero exit SHALL map to `success` and every nonzero exit SHALL map to `failure`. Native channels and new lifecycle engines SHALL use the same aggregate contract, explicit command allowlist, and existing command/help exclusions rather than emit per-phase or per-engine events.

#### Scenario: Top-level command succeeds
- **WHEN** an eligible recognized top-level command exits zero
- **THEN** the client submits at most one event with its canonical command name and outcome `success`

#### Scenario: Nested command fails
- **WHEN** an eligible recognized nested command exits nonzero
- **THEN** at most one event uses the exact allowlisted `command:subcommand` path and outcome `failure`

#### Scenario: Invocation is rejected before command recognition
- **WHEN** parsing cannot resolve an allowlisted command
- **THEN** no telemetry event is sent

#### Scenario: Command help is requested
- **WHEN** general or command-specific help is eligible for telemetry
- **THEN** its command value is `help` rather than the described command
- **AND** help for a telemetry-excluded assessment or inspection surface remains excluded

#### Scenario: A workflow uses several engines
- **WHEN** one eligible invocation performs approved work spanning multiple engines, checks, or recovery steps
- **THEN** only the outer invocation can emit its single aggregate command event
- **AND** no phase progress, individual finding, or provider action is emitted

### Requirement: Event payloads contain no identifying or project data
The system SHALL NOT include installation/session identifiers, client timestamps, source IP, arguments, flags, paths, project names, repository or resource IDs, manifest/generated content, errors, durations, OS, architecture, Node version, cloud/workload/environment choices, model/provider identities, prompts, responses, conversations, or agent-host context in telemetry. It SHALL also exclude plan fingerprints, receipt or migration IDs, approval/evidence contents, artifact checksums, resource/catalog identities, PATH observations, and installation-owner details. Hashing or redacting such values SHALL NOT make them permitted telemetry fields.

#### Scenario: Command includes project details and flags
- **WHEN** a command includes a project name/path, configuration file, flags, or approval fingerprint
- **THEN** none of those values or derived hashes appears in the serialized request

#### Scenario: Commands run across multiple sessions
- **WHEN** a developer runs Liftoff repeatedly from different hosts or channels
- **THEN** events contain no value correlating executions to one installation, user, host session, or migration record

#### Scenario: An agent proposes adoption or repair
- **WHEN** an external host provides model reasoning, an application patch, or a reviewed plan for an eligible CLI operation
- **THEN** the event contains only the five aggregate fields
- **AND** it excludes model IDs, prompts, responses, source content, paths, mappings, and plan/receipt IDs

#### Scenario: Native path diagnostics are detailed
- **WHEN** local diagnostics contain macOS/Linux paths or Windows drive, UNC, or shim paths
- **THEN** no raw, normalized, truncated, or hashed path appears in telemetry

### Requirement: First eligible use is disclosed before collection
The system SHALL write the concise disclosure to stderr before an eligible command can send an event, identifying the five fields and both opt-out variables. A persisted current notice version SHALL suppress repeat notices. Commands whose read-only contract prohibits configuration writes SHALL NOT persist disclosure state; they SHALL still disclose before any otherwise eligible collection without changing stdout or the command's result. Telemetry-excluded inspection, preview, or assessment/help operations SHALL remain excluded from notice and state creation.

#### Scenario: First eligible command
- **WHEN** telemetry is enabled and the current notice version is not recorded for an eligible command
- **THEN** stderr receives the notice before eligible command execution and any telemetry request

#### Scenario: Disclosure was already recorded
- **WHEN** telemetry is enabled and global configuration already records the current notice version
- **THEN** an eligible command runs without repeating the notice

#### Scenario: Machine-readable command runs first
- **WHEN** the first eligible command uses JSON output
- **THEN** disclosure appears only on stderr and stdout remains valid command JSON

#### Scenario: A fully read-only check runs first
- **WHEN** doctor or `upgrade --check` is otherwise telemetry-eligible but cannot write configuration
- **THEN** disclosure is shown without recording state and the command remains filesystem-read-only
- **AND** a later eligible command can show the notice again until permitted persistence succeeds

#### Scenario: Installation inspection runs from an unlinked bundle
- **WHEN** the developer runs `installation inspect` or a non-executing installation-migration preview
- **THEN** no telemetry event, disclosure notice, or notice-state file is created

### Requirement: The ingestion gateway enforces the public event contract
The system SHALL expose `/api/events` through an HTTPS-only Azure Container App accepting only POST JSON requests no larger than 1 KiB. It SHALL validate exact property names, types, schema version, event name, explicit command allowlist, bounded CLI release version, and outcome before ingestion. Accepted versions SHALL remain stable SemVer or `alpha`, `beta`, or `rc` prereleases with an optional numeric suffix; build metadata and arbitrary labels SHALL be rejected. It SHALL count streamed bytes before parsing and SHALL NOT depend on the Azure Functions host. Newly eligible lifecycle commands SHALL be explicitly registered without expanding the event shape or admitting arbitrary command prefixes.

#### Scenario: Valid event is accepted
- **WHEN** a request exactly matches the supported five-field event contract and an explicitly allowed command
- **THEN** the gateway accepts it and submits one approved record to Azure Monitor

#### Scenario: Additional field is supplied
- **WHEN** a request adds an identifier, timestamp, model prompt, path, channel, owner, or any other property
- **THEN** the gateway rejects it without submitting a record

#### Scenario: Payload is malformed or oversized
- **WHEN** a request has an invalid method/content type, JSON, array body, unsupported value, or more than 1 KiB
- **THEN** the gateway rejects it without logging its body

#### Scenario: A new public operation is registered
- **WHEN** an eligible adoption, skill, or installation command is added to the release's exact command allowlist
- **THEN** client and gateway agree on its canonical command value under the unchanged event shape
- **AND** the next lifecycle implementation cannot add telemetry metadata implicitly

#### Scenario: A similar command name is submitted
- **WHEN** a request uses an unregistered name sharing a prefix with an allowed lifecycle command
- **THEN** ingestion rejects it rather than accepting a pattern match

### Requirement: Azure telemetry infrastructure is OpenTofu-owned
The system SHALL create and manage `rg-liftoff-prod`, state-storage Network Security Perimeter resources and association, every production telemetry resource, ACR image build, and Container App revision through version-pinned OpenTofu. The production resource group SHALL be protected from accidental destruction. Configuration SHALL support static initialization and validation without Azure credentials. CLI telemetry collection, native installation, and upgrade SHALL NOT authenticate, plan, apply, or destroy telemetry infrastructure; separately approved project Azure activation SHALL remain a different authority and resource scope.

#### Scenario: Contributor validates infrastructure
- **WHEN** a contributor runs the documented `tofu fmt -check`, `tofu init -backend=false`, and `tofu validate`
- **THEN** telemetry configuration validates without requiring Azure sign-in

#### Scenario: Maintainer deploys telemetry
- **WHEN** a maintainer reviews and applies telemetry infrastructure
- **THEN** the plan represents `rg-liftoff-prod` creation/reconciliation, resource placement, deletion protection, identity wiring, retention, cost bounds, ACR build, immutable image, and Container App revision

#### Scenario: Maintainer removes the legacy Function deployment
- **WHEN** the Container App has passed endpoint and data-boundary verification
- **THEN** removal of the Function App, FC1 plan, OneDeploy action, package resources, product storage, production association, approved-subscription rule, and regional OneDeploy rule is isolated in a separately reviewed plan
- **AND** that plan preserves `rg-liftoff-prod`, remote state, state perimeter/operator rules, workspace, custom table, DCE, DCR, and accepted events

#### Scenario: Maintainer rolls back telemetry
- **WHEN** a maintainer disables or removes the telemetry service
- **THEN** the plan preserves `rg-liftoff-prod`
- **AND** rollback does not destroy the production resource group

#### Scenario: Developer runs Liftoff
- **WHEN** a developer runs any CLI command
- **THEN** telemetry collection does not invoke OpenTofu, Azure CLI, Bicep, Terraform CLI, or `azd`
- **AND** an explicitly approved project activation cannot inherit authority over telemetry infrastructure

### Requirement: Self-upgrade emits only the aggregate command event
The telemetry allowlist and ingestion validation SHALL continue recognizing `upgrade` as one top-level command. An eligible invocation SHALL emit at most one aggregate event from the invoked process using its running CLI version and the existing zero/nonzero outcome mapping. Native verification, ownership probes, helpers, and replacement subprocesses SHALL have telemetry and disclosure-state creation disabled.

#### Scenario: Upgrade succeeds
- **WHEN** `liftoff upgrade` exits 0 with telemetry enabled
- **THEN** at most one event contains command `upgrade`, the invoked CLI version, and outcome `success`

#### Scenario: Upgrade check finds an update
- **WHEN** `liftoff upgrade --check` exits 2
- **THEN** any eligible event uses the existing outcome `failure`
- **AND** no mode, target-version, owner, or availability detail is added

#### Scenario: Replacement verification runs
- **WHEN** apply invokes the replacement executable to verify its version
- **THEN** the subprocess emits no telemetry event or disclosure state
- **AND** the parent remains the only eligible upgrade event

#### Scenario: Native handover verifies both executables
- **WHEN** installation migration inspects a legacy executable and verifies an unlinked or installed native candidate
- **THEN** those probes emit no telemetry or disclosure state
- **AND** an eligible outer migration emits no more than one aggregate event

### Requirement: Upgrade telemetry excludes installation details
Upgrade telemetry SHALL NOT include check/apply mode, target version beyond the invoked `cliVersion`, registry/source kind or URL, package-manager output, owner/channel, global prefix, working directory, project presence, reason, error, duration, repair command, lock status, launcher observations, or artifact/receipt identity. Historical registry boundaries and native channels SHALL be equally subject to the five-field contract.

#### Scenario: Upgrade is blocked by a private mirror
- **WHEN** a configured registry or native owner source cannot expose the target
- **THEN** any emitted event contains only the five approved fields
- **AND** contains no source or failure details

#### Scenario: WinGet needs a close or handover action
- **WHEN** a Windows upgrade remains incomplete because of locked files or enterprise policy
- **THEN** telemetry records only the allowed aggregate outcome
- **AND** no process, policy, path, or owner information is transmitted

## ADDED Requirements

### Requirement: Native distribution does not create telemetry identity or new eligibility implicitly
All native channels SHALL preserve enabled-by-default eligible collection, first-use disclosure, `LIFTOFF_TELEMETRY=0`, `DO_NOT_TRACK=1`, `CI=true`, the one-second absolute transport bound, no retries/queued events, and unchanged command output/status on transport failure. Only the numeric notice version SHALL be persisted as telemetry state under the existing platform-specific configuration contract. Native receipts, installer IDs, model-host sessions, resource catalogs, and capability registries SHALL NOT create tracking identity or implicitly expand telemetry eligibility.

#### Scenario: Opt out before native first use
- **WHEN** any existing opt-out condition is set before running a native bundle
- **THEN** no disclosure, telemetry state, transport initialization, or event submission occurs

#### Scenario: Move an installation across directories
- **WHEN** a native bundle is relocated on Windows, macOS, or Linux
- **THEN** disclosure configuration follows the existing XDG, Windows APPDATA, or Unix fallback contract
- **AND** no installation or relocation identifier is created

#### Scenario: An engine registers a new capability
- **WHEN** a capability or skill becomes available without a separately reviewed telemetry-command registration
- **THEN** the telemetry allowlist does not expand automatically
- **AND** existing assessment/help exclusions and installation-inspection/preview exclusions remain in force

### Requirement: Telemetry qualification is independent and privacy-preserving
The telemetry service SHALL qualify lines, branches, functions, and statements strictly above 80 percent independently of CLI coverage, using actual covered/total counts and including unimported production TypeScript/JavaScript. Qualification SHALL also exercise valid/invalid new command identities, exact property rejection, opt-outs, disclosure/read-only behavior, subprocess suppression, storage boundaries, and bounded failures. Synthetic tests SHALL NOT collect real prompts, paths, credentials, user identifiers, or production telemetry to obtain coverage.

#### Scenario: CLI passes but telemetry reaches exactly eighty percent
- **WHEN** any telemetry metric satisfies equality at 80 percent
- **THEN** the telemetry gate and coordinated release fail regardless of CLI results

#### Scenario: Validate the native migration event
- **WHEN** a synthetic eligible `installation:migrate` event and variants containing prompts, paths, owner details, or record IDs are exercised
- **THEN** only the exact allowed five-field form is accepted
- **AND** rejected bodies do not become stored records or logs

#### Scenario: Deployment readiness lags the client
- **WHEN** the client can emit a new allowed command but the qualified gateway revision does not admit it
- **THEN** coordinated qualification reports the client/gateway incompatibility
- **AND** release preparation does not deploy production infrastructure without separate operator approval

### Requirement: Operator Grafana dashboards reuse the existing telemetry store
The coordinated change SHALL deliver an operator-facing dashboard using Azure Monitor dashboards with Grafana in the Azure portal. It SHALL query the existing configured Log Analytics workspace and `LiftoffCommandEvents_CL` table without creating a second ingestion path or separately hosted Managed Grafana instance. It SHALL preserve the existing client event, six Liftoff-defined stored columns, opt-outs, exclusions and 180-day retention. Dashboard implementation SHALL remain outside normal CLI execution and generated-application provisioning.

#### Scenario: Open the telemetry dashboard
- **WHEN** an authorized maintainer opens the deployed Azure Monitor Grafana dashboard
- **THEN** its queries use the operator-configured existing workspace and telemetry table
- **AND** no CLI installation or generated project is needed to host the dashboard

#### Scenario: Dashboard hosting is selected
- **WHEN** the operator dashboard is provisioned
- **THEN** it uses the Azure-native dashboard resource rather than a dedicated Managed Grafana service
- **AND** existing Azure Monitor storage/query charges remain distinct from the absence of a separate Grafana hosting charge

#### Scenario: Telemetry collection is disabled or incomplete
- **WHEN** CLI invocations are opted out, excluded, in CI or unable to deliver within the existing budget
- **THEN** dashboard documentation identifies the resulting limits of recorded event counts
- **AND** no new tracking fields, retries, local event queue or replacement collection pipeline is introduced

### Requirement: Dashboard panels describe recorded events rather than users or crashes
The dashboard SHALL show recorded command-event totals, volume over time, command distribution, CLI-version distribution, nonzero exit outcomes and the latest matching event timestamp. Its default time range SHALL be seven days with manual refresh; time, command and version filters SHALL be applied consistently with safe query interpolation. Nonzero exit labels SHALL explain that `Outcome = failure` includes expected exit-2 and other nonzero outcomes. Event recency SHALL NOT alone be labeled service health, and the dashboard SHALL NOT infer unique users, installations, devices, geography or individual activity.

#### Scenario: Aggregate the selected window
- **WHEN** the maintainer selects a time range and optional command/version filters
- **THEN** panels report the matching recorded events and clearly identify their time/filter scope
- **AND** event counts are not labeled as people or installations

#### Scenario: A nonzero exit is not an application crash
- **WHEN** records include normal nonzero results such as detected drift or an available update
- **THEN** the outcome panel includes them under nonzero exits
- **AND** it does not present that count or percentage as a diagnosed error/crash rate

#### Scenario: A version appears in the records
- **WHEN** the table contains events for a CLI version
- **THEN** the dashboard describes observed event distribution for that version
- **AND** it does not infer installed-user totals or package-manager ownership from the version

#### Scenario: No recent event exists
- **WHEN** no event matches the selected range and filters
- **THEN** the dashboard reports no matching events and an unavailable matching-event timestamp
- **AND** it does not conclude that ingestion is down or users are absent

### Requirement: Telemetry visualization distinguishes empty data from failed observation
Dashboard queries SHALL use bounded time ranges, aggregation and row limits and SHALL expose loading, successful empty results, filtered no-data, missing-table, access-denied, query/throttling-failure and stale-display states distinctly. Query failure SHALL NOT become zero usage or a healthy status. Panels SHALL use readable labels, units and native accessible controls, with information not conveyed by color alone.

#### Scenario: A valid query returns no rows
- **WHEN** a successful query finds no matching records
- **THEN** the panel explains the empty time/filter result without inventing events or an outage

#### Scenario: The query cannot read the workspace
- **WHEN** the viewer lacks data access or the configured table cannot be queried
- **THEN** the dashboard shows the causal observation failure
- **AND** it does not substitute a successful zero-valued result

#### Scenario: A query times out or is throttled
- **WHEN** Azure Monitor cannot complete a query within the supported bound
- **THEN** the panel identifies the failed or incomplete observation and a supported retry action
- **AND** it does not retry indefinitely or silently query another source

#### Scenario: The view is narrow or uses another supported theme
- **WHEN** the operator uses a supported narrow viewport or portal/Grafana theme
- **THEN** labels, tables, filters and state descriptions remain usable and legible
- **AND** outcome meaning does not depend solely on a color distinction

### Requirement: Dashboard access uses current-user authorization and least privilege
Azure Monitor Grafana queries SHALL run under the signed-in viewer's supported Azure authorization. Dashboard access and Log Analytics/table-query access SHALL remain independent. Provisioning SHALL NOT create a shared data-source credential, reuse ingestion identity, grant broad subscription access automatically or enable anonymous viewing. Any required dashboard/data role assignment SHALL have its own explicit minimal operator approval.

#### Scenario: Dashboard access exists without data permission
- **WHEN** a viewer can open the dashboard but cannot query its workspace
- **THEN** query access remains denied and the missing permission is explained
- **AND** dashboard sharing does not bypass workspace authorization

#### Scenario: An authorized viewer reads telemetry
- **WHEN** the viewer holds the required dashboard and scoped data permissions
- **THEN** the existing telemetry can be queried without a dashboard client secret or new ingestion identity

#### Scenario: Additional access is requested
- **WHEN** another viewer or editor needs permissions
- **THEN** the required minimal resource/data scope is reviewed explicitly
- **AND** normal CLI usage or project Azure approval grants no telemetry-administration authority

### Requirement: Dashboard source and provisioning have explicit operator ownership
The dashboard model, KQL and source bindings SHALL be version-controlled with stable dashboard/resource identity and managed through the approved telemetry OpenTofu boundary. Workspace/subscription bindings SHALL come from operator configuration and existing outputs rather than hard-coded observed GUIDs or secrets in public source. Deployment SHALL present exact dashboard/access effects, preserve unrelated resources, and verify actual readback. Matching reconciliation SHALL be zero-write; portal edits SHALL appear as drift for review.

#### Scenario: Deploy a reviewed dashboard definition
- **WHEN** the operator approves the exact definition and required resource/access plan
- **THEN** only that owned dashboard scope is provisioned and verified against the committed model and queries
- **AND** the existing workspace, table, DCR, gateway, retention and state perimeter remain unchanged

#### Scenario: Reapply an unchanged definition
- **WHEN** current owned dashboard configuration matches the reviewed source
- **THEN** reconciliation performs no dashboard write
- **AND** qualification confirms the effective query/source configuration

#### Scenario: A portal edit differs from source
- **WHEN** someone modifies an owned dashboard outside the declared source
- **THEN** the difference is shown in a new review
- **AND** neither blind overwrite nor silent adoption hides the drift

#### Scenario: Roll back or remove the dashboard
- **WHEN** an explicit operator plan retires or restores the owned dashboard
- **THEN** only its reviewed attributable dashboard/access effects are changed
- **AND** no telemetry data, protected resource group, workspace or ingestion resource is destroyed

#### Scenario: Source files are handled on another platform
- **WHEN** dashboard definitions and operator input paths are validated on Windows, macOS or Linux
- **THEN** native path handling preserves the exact files and literal deployment arguments
- **AND** a path prefix or similarly named dashboard does not grant ownership

### Requirement: Dashboard limitations do not silently expand the product
The built-in dashboard SHALL disclose best-effort anonymous counts and the public ingestion endpoint's susceptibility to forged valid events. Grafana alerts, scheduled reports and features unavailable in the selected Azure Monitor host SHALL remain out of scope. If the selected host/API cannot satisfy the required dashboard behavior, qualification SHALL block rather than substitute a paid Grafana instance, Workbook, tracking schema or new collector without an explicitly revised change.

#### Scenario: A user requests a unique-user panel
- **WHEN** the requested panel needs identifiers not present in the telemetry contract
- **THEN** the dashboard identifies that metric as unavailable
- **AND** it does not add identifiers or present command counts as unique users

#### Scenario: A built-in-host feature is unavailable
- **WHEN** a requested alert, report or unsupported dashboard feature cannot run in the selected hosting model
- **THEN** that limitation is explicit
- **AND** no dedicated Managed Grafana service or paid fallback is provisioned implicitly

#### Scenario: Qualification needs example data
- **WHEN** dashboard behavior is exercised for empty, sparse, malformed or error cases
- **THEN** synthetic records stay in fixtures or separately approved disposable qualification scope
- **AND** production ingestion is not populated with fabricated usage to make panels appear complete
