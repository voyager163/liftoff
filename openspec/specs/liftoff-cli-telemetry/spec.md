## Purpose

Define Liftoff's privacy-preserving CLI telemetry contract and its Azure ingestion infrastructure.

## Requirements

### Requirement: Eligible command executions emit one aggregate event
The system SHALL emit at most one `command_executed` event after each recognized CLI command completes while telemetry is enabled. The event SHALL contain exactly `schemaVersion`, `event`, `command`, `cliVersion`, and `outcome`; `outcome` SHALL be `success` for exit code zero and `failure` for every nonzero exit code.

#### Scenario: Top-level command succeeds
- **WHEN** a developer runs a recognized top-level command that exits zero
- **THEN** the client submits one event with the canonical command name and `outcome: "success"`

#### Scenario: Nested command fails
- **WHEN** a developer runs a recognized nested command that exits nonzero
- **THEN** the client submits one event whose command uses the explicit `command:subcommand` path and whose outcome is `failure`

#### Scenario: Invocation is rejected before command recognition
- **WHEN** argument parsing cannot resolve an allowlisted command
- **THEN** the system sends no telemetry event

#### Scenario: Command help is requested
- **WHEN** a developer requests general or command-specific help
- **THEN** the telemetry command value is `help` rather than the command being described

### Requirement: Event payloads contain no identifying or project data
The system SHALL NOT include an installation or session identifier, client timestamp, source IP, command arguments, flag values, paths, project names, manifest or generated content, error text, duration, operating system, Node.js version, cloud choice, workload choice, or environment choice in a telemetry payload.

#### Scenario: Command includes project details and flags
- **WHEN** a developer runs a command with a project path, project name, configuration file, or flags
- **THEN** none of those values appears in the serialized telemetry request

#### Scenario: Commands run across multiple sessions
- **WHEN** a developer runs Liftoff repeatedly
- **THEN** events contain no value that correlates those executions to one installation or session

### Requirement: First eligible use is disclosed before collection
The system SHALL write a concise telemetry disclosure to stderr before the first eligible command can send an event. The disclosure SHALL identify the collected fields and both opt-out environment variables, and subsequent commands SHALL suppress the same notice after its current version is recorded.

#### Scenario: First eligible command
- **WHEN** telemetry is enabled and the current disclosure version has not been recorded
- **THEN** the notice is written before command execution and before any telemetry request

#### Scenario: Disclosure was already recorded
- **WHEN** telemetry is enabled and the current disclosure version exists in global config
- **THEN** the command runs without repeating the notice

#### Scenario: Machine-readable command runs first
- **WHEN** the first eligible command uses JSON output
- **THEN** the notice is written only to stderr and stdout remains valid command JSON

### Requirement: Users and automation can disable telemetry
The system SHALL disable telemetry when `LIFTOFF_TELEMETRY=0`, `DO_NOT_TRACK=1`, or `CI=true` is present. Disablement SHALL prevent notice display, global telemetry-state creation, transport initialization, and event submission.

#### Scenario: Liftoff-specific opt-out
- **WHEN** `LIFTOFF_TELEMETRY=0` is set
- **THEN** the command runs without telemetry side effects

#### Scenario: Standard do-not-track signal
- **WHEN** `DO_NOT_TRACK=1` is set
- **THEN** the command runs without telemetry side effects

#### Scenario: Continuous integration
- **WHEN** `CI=true` is set
- **THEN** telemetry remains disabled regardless of other telemetry settings

### Requirement: Telemetry transport is bounded and failure-isolated
The system SHALL use one HTTPS request with an absolute timeout no greater than one second, SHALL NOT retry or persist an event, and SHALL preserve command output and exit status for every telemetry result.

#### Scenario: Endpoint accepts the event
- **WHEN** the telemetry endpoint returns a success response within the timeout
- **THEN** the CLI exits with the command's original status

#### Scenario: Endpoint fails or times out
- **WHEN** DNS, connection, timeout, or HTTP response handling fails
- **THEN** the CLI emits no telemetry error, performs no retry, writes no queued event, and exits with the command's original status

### Requirement: Disclosure state is portable and non-identifying
The system SHALL store only a numeric telemetry notice version in platform-appropriate global configuration, SHALL use platform-correct path operations, and SHALL update valid configuration atomically without replacing invalid existing JSON.

#### Scenario: XDG configuration is selected
- **WHEN** `XDG_CONFIG_HOME` is set on any supported operating system
- **THEN** the notice state resolves beneath that directory using platform-correct path handling

#### Scenario: Windows fallback is selected
- **WHEN** Liftoff runs on Windows without `XDG_CONFIG_HOME`
- **THEN** the notice state resolves beneath `%APPDATA%` using Windows path semantics

#### Scenario: Unix fallback is selected
- **WHEN** Liftoff runs on macOS or Linux without `XDG_CONFIG_HOME`
- **THEN** the notice state resolves beneath the user's `.config` directory

#### Scenario: Existing config is invalid or read-only
- **WHEN** global configuration cannot be parsed or updated
- **THEN** the command and telemetry transport remain usable, the invalid file is not overwritten, and the disclosure is shown again on a later eligible run

### Requirement: The ingestion gateway enforces the public event contract
The system SHALL expose `/api/events` through an HTTPS-only Azure Container App that accepts only POST requests with JSON no larger than 1 KiB and validates exact property names, types, schema version, event name, explicit command allowlist, bounded CLI release version, and outcome before ingestion. Accepted CLI versions SHALL be stable semantic versions or `alpha`, `beta`, or `rc` prereleases with an optional numeric suffix; build metadata and arbitrary prerelease labels SHALL be rejected. The gateway SHALL count streamed request bytes before parsing and SHALL NOT depend on the Azure Functions host.

#### Scenario: Valid event is accepted
- **WHEN** a request exactly matches the supported event contract
- **THEN** the gateway accepts it and submits one approved record to Azure Monitor

#### Scenario: Additional field is supplied
- **WHEN** a request includes an identifier, timestamp, extra property, or other unrecognized field
- **THEN** the gateway rejects the request without submitting a record

#### Scenario: Payload is malformed or oversized
- **WHEN** a request has the wrong method or content type, invalid JSON, an array body, unsupported values, or more than 1 KiB
- **THEN** the gateway rejects the request without logging its body

### Requirement: Stored events exclude request metadata
The system SHALL assign ingestion time at the gateway and SHALL define only `TimeGenerated`, `EventName`, `SchemaVersion`, `Command`, `CliVersion`, and `Outcome` as Liftoff event columns. Azure Monitor MAY add its standard workspace system columns after the data collection rule transformation. The system SHALL NOT populate Liftoff-defined or Azure system columns from source IP, headers, query strings, request bodies, derived geolocation, or Container Apps ingress telemetry.

#### Scenario: Public request reaches Azure
- **WHEN** Azure networking routes a telemetry request to the gateway
- **THEN** the product data pipeline does not copy the source address or request metadata into Azure Monitor

#### Scenario: DCR receives a gateway record
- **WHEN** the gateway uploads an approved record
- **THEN** the data collection rule projects only the six approved Liftoff-defined columns into the custom table
- **AND** any additional stored columns are Azure Monitor system columns rather than additional Liftoff event fields

#### Scenario: Gateway monitoring is configured
- **WHEN** the telemetry Container App is deployed
- **THEN** it has no Application Insights connection string or instrumentation key
- **AND** its Container Apps environment has persistent log storage disabled
- **AND** no diagnostic setting stores ingress, console, or HTTP access logs in the product workspace

### Requirement: Azure ingestion uses managed identity and least privilege
The system SHALL use a user-assigned managed identity for private container-image pull and Azure Monitor ingestion, and SHALL grant only `AcrPull` on the registry and the required ingestion role on the data collection rule. The CLI, container, application settings, OpenTofu outputs, and repository SHALL contain no Azure ingestion secret, registry password, storage key, SAS token, or endpoint key.

#### Scenario: Gateway writes an event
- **WHEN** the gateway submits an approved record
- **THEN** it authenticates to the Logs Ingestion API through its assigned managed identity

#### Scenario: Maintainer inspects outputs and source
- **WHEN** a maintainer reviews OpenTofu outputs, application settings, and tracked files
- **THEN** no static Azure credential or secret telemetry key is present

### Requirement: The Container App remains warm and cost-bounded
The system SHALL run the gateway on the Azure Container Apps Consumption plan with 0.25 vCPU and 0.5 GiB per replica, one minimum replica, no more than five replicas, and HTTP-based autoscaling. The system SHALL use single-revision mode and HTTPS-only external ingress.

#### Scenario: Gateway is idle
- **WHEN** no telemetry requests are active
- **THEN** one gateway replica remains allocated rather than scaling to zero

#### Scenario: Request volume increases
- **WHEN** HTTP concurrency exceeds one replica's configured threshold
- **THEN** the gateway MAY scale out but SHALL NOT exceed five replicas

#### Scenario: Cost controls are inspected
- **WHEN** a maintainer reviews the Container App plan
- **THEN** it specifies the Consumption workload profile, 0.25 vCPU, 0.5 GiB, one minimum replica, and five maximum replicas

### Requirement: Container image delivery is immutable and identity-authenticated
The system SHALL use an Azure Container Registry Basic registry with administrator credentials and anonymous pull disabled. An OpenTofu-managed ACR task SHALL build the gateway from a full 40-character commit SHA reachable in the public Liftoff repository and SHALL tag the image with that SHA. The built tag SHALL be resolved to a `sha256` manifest digest, and the Container App SHALL reference that digest through OpenTofu. Production SHALL NOT run from branch, `latest`, date-only, or tag-only image references.

#### Scenario: Production source is selected
- **WHEN** a maintainer supplies a source revision for deployment
- **THEN** validation accepts only a full commit SHA
- **AND** the ACR task uses the public repository at that pinned revision as its build context

#### Scenario: Image is built
- **WHEN** the OpenTofu ACR task run completes
- **THEN** it pushes an image whose tag equals the pinned source revision
- **AND** the operator resolves that tag to its manifest digest
- **AND** the Container App references the exact `sha256` digest

#### Scenario: Container App pulls the image
- **WHEN** Azure starts a gateway replica
- **THEN** ACR authorizes the assigned user-managed identity through its registry-scoped `AcrPull` role
- **AND** no registry administrator credential or password is used

#### Scenario: Registry is inspected
- **WHEN** a maintainer reviews registry configuration
- **THEN** administrator credentials and anonymous pull are disabled
- **AND** the registry contains application images but no telemetry events or ingestion credentials

### Requirement: State storage network access is perimeter-enforced
The system SHALL associate only OpenTofu state storage with the bootstrap-owned Azure Network Security Perimeter profile in `Enforced` mode. The profile SHALL admit explicit operator IPv4 CIDRs and SHALL NOT retain the approved-subscription or regional OneDeploy rules after legacy Function removal. Network admission SHALL NOT replace Entra authentication or storage-scoped RBAC.

#### Scenario: Bootstrap infrastructure is planned
- **WHEN** a maintainer plans the OpenTofu bootstrap
- **THEN** the plan creates or reconciles the perimeter, profile, operator-CIDR rules, and enforced state-storage association
- **AND** the final plan contains no approved-subscription or OneDeploy access rule

#### Scenario: Production infrastructure is planned
- **WHEN** a maintainer plans production telemetry infrastructure
- **THEN** the plan contains no production storage account, deployment blob, Azure Files share, or production NSP association

#### Scenario: Operator public IP changes
- **WHEN** the operator can no longer reach the storage data plane from the previously approved CIDR
- **THEN** the documented recovery flow updates the ignored bootstrap CIDR input through the Azure control plane before retrying backend or package access

#### Scenario: Public repository is inspected
- **WHEN** a user inspects tracked files and outputs
- **THEN** no operator IP address or CIDR is committed or exposed

#### Scenario: Standard GitHub-hosted CI runs
- **WHEN** CI runs on a standard GitHub-hosted runner without private networking
- **THEN** CI performs only static build, test, formatting, initialization without a backend, and validation operations
- **AND** it does not plan or apply production infrastructure

### Requirement: Product telemetry has bounded regional retention
The system SHALL deploy every production telemetry Azure resource into the fixed production resource group `rg-liftoff-prod` and SHALL store command events in an explicit custom Log Analytics table in the operator-selected Azure region with 180-day analytics and total retention and no additional long-term retention. Bootstrap state storage and its perimeter SHALL remain in the separate protected state resource group.

#### Scenario: Infrastructure is planned
- **WHEN** a maintainer selects an Azure region
- **THEN** the registry, ACR task, Container Apps environment, Container App, identity, data collection endpoint, data collection rule, workspace, and custom table target `rg-liftoff-prod`
- **AND** regional resources are configured for the selected Azure region

#### Scenario: Event reaches retention age
- **WHEN** a stored event reaches 180 days
- **THEN** Azure Monitor removes it under the configured retention policy rather than moving it to longer-term retention

### Requirement: Azure telemetry infrastructure is OpenTofu-owned
The system SHALL create and manage `rg-liftoff-prod`, the state-storage Network Security Perimeter resources and association, every production telemetry Azure resource, the ACR image build, and the Container App revision through version-pinned OpenTofu configuration. The production resource group SHALL be protected from accidental destruction. The configuration SHALL support static initialization and validation without Azure credentials, and normal Liftoff commands SHALL NOT authenticate, plan, apply, or destroy telemetry infrastructure.

#### Scenario: Contributor validates infrastructure
- **WHEN** a contributor runs the documented `tofu fmt -check`, `tofu init -backend=false`, and `tofu validate` commands
- **THEN** the telemetry configuration validates without requiring an Azure sign-in

#### Scenario: Maintainer deploys telemetry
- **WHEN** a maintainer reviews and applies the telemetry infrastructure
- **THEN** `rg-liftoff-prod` creation or managed reconciliation, resource placement, deletion protection, identity wiring, retention, cost bounds, ACR build, immutable image, and Container App revision are represented in the OpenTofu plan

#### Scenario: Maintainer removes the legacy Function deployment
- **WHEN** the Container App has passed endpoint and data-boundary verification
- **THEN** removal of the Function App, FC1 plan, OneDeploy action, package resources, product storage, production storage association, approved-subscription rule, and regional OneDeploy rule is isolated in a separately reviewed OpenTofu plan
- **AND** the plan preserves `rg-liftoff-prod`, remote state, the state perimeter and operator rules, the workspace, custom table, DCE, DCR, and accepted events

#### Scenario: Maintainer rolls back telemetry
- **WHEN** a maintainer disables or removes the telemetry service
- **THEN** the OpenTofu plan preserves `rg-liftoff-prod`
- **AND** rollback does not destroy the production resource group

#### Scenario: Developer runs Liftoff
- **WHEN** a developer runs any CLI command
- **THEN** Liftoff does not invoke OpenTofu, Azure CLI, Bicep, Terraform CLI, or `azd`
