# Telemetry and privacy

Liftoff collects a small aggregate event to understand which CLI commands are
useful and whether they exit with zero or nonzero status. Telemetry is enabled
by default, disclosed before the first eligible command, and never required for
the CLI to work. It creates no persistent installation or session identifier.

## Event contract

Each telemetry-eligible command can send at most one event after it finishes:

```json
{
  "schemaVersion": 1,
  "event": "command_executed",
  "command": "infra:plan",
  "cliVersion": "0.6.1",
  "outcome": "success"
}
```

`outcome` is `success` for exit code zero and `failure` for every nonzero exit
code. It is an exit-status class, not an error diagnosis. Help requests are
recorded as `help`, except assessment help as described below. Rejected input
that never resolves to a recognized command is not recorded.

`liftoff governance assess` skips telemetry and disclosure entirely, including
`--live` and `--help`. It sends no telemetry event, displays no disclosure notice,
and writes no disclosure state, regardless of the default telemetry setting.
Opting into live assessment authorizes only its scoped read-only observations,
not telemetry delivery.

The same exclusion applies to `liftoff assess`, `capabilities`,
`installation inspect`, and skill listing, inspection, and planning, including
their help forms. Non-executing adoption, skill, and installation-migration
previews and installation recovery inspection are also excluded.

The only newly eligible command values are `adopt`, `installation:migrate`,
`skills:install`, `skills:update`, `skills:remove`, and `skills:migrate`. This is
an explicit allowlist, not permission to record arbitrary engine, host, or phase
names. Preview exclusions still apply, and eligible operations emit at most the
single outer invocation's event.

The read-only `liftoff repair --capabilities` and `liftoff repair --inspect-layout`
modes also bypass telemetry and disclosure, including their help/JSON forms.
Capability negotiation and application inventory therefore introduce no
telemetry network request or disclosure-state write.

Otherwise eligible read-only commands, including `doctor`, `upgrade --check`,
metadata planning, help, and governance status/resume/verify, display any needed
disclosure on stderr without persisting notice state. Their JSON stdout and
project/installation bytes remain unchanged. The notice can repeat until a
write-capable eligible command is permitted to record the numeric notice version.

`upgrade` is recorded only as the aggregate command value. Check/apply mode,
target or configured-registry details, installation origin, paths, npm output,
reason codes, and errors are not added. The replacement binary's verification
process runs with telemetry and disclosure disabled, so at most the originally
invoked parent command emits an event.

Liftoff does **not** send:

- An installation, user, device, or session identifier.
- A client timestamp or duration.
- Arguments, flags, paths, project names, config values, manifests, or generated
  content.
- Error text, stack traces, operating-system details, Node.js version, cloud,
  workload, region, or environment choices.
- A source IP address or derived location in the event.

Liftoff creates no telemetry queue and stores no event locally. Its only local
telemetry state is a numeric disclosure version in the platform configuration
directory.

## Disable telemetry

Set either variable before running Liftoff:

```bash
export LIFTOFF_TELEMETRY=0
export DO_NOT_TRACK=1
```

On PowerShell:

```powershell
$env:LIFTOFF_TELEMETRY = "0"
$env:DO_NOT_TRACK = "1"
```

Telemetry is also disabled when `CI=true`. Disabled runs do not show the notice,
create telemetry state, or initialize network transport.

## Delivery and failure behavior

The CLI makes one HTTPS request after command completion with a maximum
one-second delivery budget. It does not retry, buffer, read a response body, or
report telemetry failures. Offline use, command output, JSON stdout, and the
original exit status remain unchanged when the service is unavailable.

## Azure processing and retention

The public endpoint is a strict-schema plain Node.js service in Azure Container
Apps. It counts streamed bytes before parsing, rejects unknown or additional
fields, and adds server-side `TimeGenerated`. A managed identity then writes only
these Liftoff-defined columns through an Azure Monitor data collection rule:

```text
TimeGenerated, EventName, SchemaVersion, Command, CliVersion, Outcome
```

Azure Monitor adds standard workspace system columns after the data collection
rule transformation. Those platform columns contain tenant, type, item, and
billing metadata; they are not additional Liftoff event fields and are not
populated from the request body, source IP, or derived geolocation.

Azure networking necessarily handles the source network address while routing
HTTPS. Liftoff does not copy that address into the event, derive geolocation
from it, forward it to the data collection rule, or configure the product
workspace to persist Container Apps ingress or console telemetry. The Container
Apps environment has persistent platform logs disabled, and the gateway has no
Application Insights connection string or instrumentation key.

Accepted events are stored in `LiftoffCommandEvents_CL` in the operator-selected
Azure region for 180 days of analytics and total retention, with no additional
long-term retention. Query access uses Microsoft Entra ID and Azure RBAC.
Aggregate counts are directional because a public, unauthenticated endpoint can
receive forged events.

## Operator deployment boundary

Production telemetry resources are created and managed in the fixed resource
group `rg-liftoff-prod`. OpenTofu owns the group, applies deletion protection,
and deploys ACR Basic, a commit-pinned ACR build task, a Container Apps
environment, one warm Container App replica, managed identity, workspace,
custom table, data collection endpoint, and data collection rule.

The registry contains only the already-public gateway image. Administrator
credentials and anonymous pull are disabled; the Container App uses its
resource-scoped `AcrPull` identity. A full public Git commit SHA identifies the
build tag; the running Container App is pinned to the resolved `sha256` manifest
digest, never a branch, `latest`, or tag-only reference.

OpenTofu state storage remains in a separate enforced Azure Network Security
Perimeter. Its explicit operator IPv4 `/32` CIDRs live only in ignored local
inputs, and Entra authentication plus storage-scoped RBAC remain required. The
Container App needs no Function host/deployment storage, package blob, or Azure
Files share.

The gateway uses the smallest Container Apps Consumption allocation: 0.25 vCPU,
0.5 GiB, one minimum replica, and five maximum replicas. Keeping one replica
ready prevents scale-to-zero cold starts from consuming the client's one-second
delivery budget. It adds reduced idle compute cost plus ACR Basic cost.

From the repository root, operators build and validate with:

```bash
npm ci --prefix services/telemetry-ingest
npm run check --prefix services/telemetry-ingest
npm run package --prefix services/telemetry-ingest
npm run smoke:container --prefix services/telemetry-ingest
tofu -chdir=infrastructure/opentofu/telemetry fmt -check
tofu -chdir=infrastructure/opentofu/telemetry init -backend=false
tofu -chdir=infrastructure/opentofu/telemetry validate
```

The service check compiles its TypeScript and runs its own Vitest 5 suite,
including the real local HTTP boundary. The repository-root test runner is
separate and does not qualify the service. Vitest 5 no longer discovers config
files in parent directories, so `services/telemetry-ingest/vitest.config.ts`
preserves the Node environment, service-only test discovery, automatic spy
restoration, and 30-second timeout explicitly. Its default mock-history clearing
is compatible with the suite's per-test mocks. The pinned Vite 8.2.2 and supported
Node.js 24.20+ satisfy Vitest 5's runtime requirements.

### Backward-compatible lifecycle rollout

The candidate client and gateway share `src/telemetry/contract.ts`; service
packaging includes that compiled module rather than an independently maintained
command list. The gateway preserves every v0.12.3 command and both outcome
values under schema 1. The released allowlist fixture is pinned to commit
`70d10881b46d873118d825735696f39b6d35ebe0`. Local handler and HTTP tests exercise
the six new values, reject similar prefixes and additional fields, and submit
only to a local server with a test ingestion dependency.

Source compatibility does **not** establish that the deployed gateway accepts
the candidate. Before releasing a client that emits the new values, separately
authorize the gateway rollout, bind the reviewed source commit to the immutable
image digest and actual Container App revision, and qualify that exact image's
old/new allowlist and six-column behavior in an approved disposable scope.
Read back the deployed revision and digest through the operator boundary.
Missing, stale, or incompatible deployment evidence blocks coordinated release;
client best-effort delivery and successful source tests cannot hide the gap.
No gateway deployment or production-event probe is authorized by this guide,
CLI installation, project activation, or dashboard qualification.

This change needs no event, table, DCR, retention, identity, or notice-version
migration. Retain the prior usable image and its exact source/digest for
owner-approved rollback. If rollback removes support for new command values,
stop candidate publication or disable client delivery through the separately
reviewed release process; do not broaden validation, queue dropped events, or
add identifiers to recover missing counts. Production records and the protected
resource group remain intact.

Real environments must use access-controlled remote state and Entra
authentication. Before apply, review the subscription, region, unique resource
suffix, full public source revision, immutable image digest,
`rg-liftoff-prod` deletion protection, ACR administrator and anonymous-access
disablement, managed-identity roles, one-to-five replica bounds, disabled
persistent platform logs, six-column schema, 180-day retention, ingestion
quota, and state perimeter rules. Operator CIDRs live only in ignored local
inputs. If the operator IP changes, update and apply the bootstrap access rule
through the Azure control plane before retrying backend access. Use the same
reviewed production variable file for every plan, apply, and emergency
disablement so region, image revision, and quota inputs cannot fall back to
defaults.
Every infrastructure lifecycle action uses `tofu`; Liftoff does not use Bicep,
`azd`, Terraform CLI, or ad hoc Azure resource commands for this service.

Standard GitHub-hosted runners run static validation only. They do not plan or
apply production because their dynamic networks are not admitted to the
perimeter.

After apply, operators must verify the registry identity boundary, one ready
replica, sub-second endpoint response, disposable approved-scope validation
probes without injecting fake production usage to qualify or populate the
telemetry dashboard, six Liftoff-defined columns, expected Azure system columns,
server time, retention, and absence of request, IP, geolocation, Container Apps
platform/console, or Application Insights records before compiling the endpoint
into a Liftoff release. Test records remain confined to synthetic fixtures or
disposable approved verification scopes.

The final production architecture contains no Function App, FC1 plan, product
storage, OneDeploy action, or production storage-perimeter association.

For emergency disablement, apply the OpenTofu configuration with
`ingestion_enabled=false`, then publish a patch with client delivery disabled.
Rollback preserves `rg-liftoff-prod`; do not destroy the protected production
resource group. See the [telemetry infrastructure OpenTofu README](../infrastructure/opentofu/telemetry/README.md)
for complete operator review, plan, apply, verification, and rollback procedures.

## Operator Grafana telemetry dashboard

Liftoff includes a version-controlled operator dashboard definition targeting
Azure Monitor's built-in Grafana experience. After separately approved deployment,
find it under **Azure Monitor > Dashboards with Grafana** or through the OpenTofu
`telemetry_dashboard_portal_url` output. The definition has not yet been qualified
in the live Azure Monitor host.

### Architecture and data bindings

The dashboard reuses the existing telemetry store in `rg-liftoff-prod`:
- Managed through the OpenTofu AzAPI boundary using the Azure-native
  `Microsoft.Dashboard/dashboards@2025-08-01` resource and definition child
  resource `Microsoft.Dashboard/dashboards/dashboardDefinitions@2025-09-01-preview`.
- Queries the existing Log Analytics workspace `log-liftoff-telemetry-<resource_suffix>`
  and table `LiftoffCommandEvents_CL` using KQL.
- Reuses the existing six-column schema (`TimeGenerated`, `EventName`,
  `SchemaVersion`, `Command`, `CliVersion`, `Outcome`).
- Does **not** deploy a paid Azure Managed Grafana instance, Azure Workbooks,
  or a secondary ingestion pipeline.
- Built-in Grafana hosting has **zero ($0) additional hosting cost**. Standard
  Log Analytics 180-day retention and query costs apply.

### Access control and identity

Azure Monitor built-in Grafana queries execute under the signed-in viewer's
Microsoft Entra ID identity:
1. **Dashboard permissions**: Viewers need the `Reader` role on `rg-liftoff-prod`
   or on the dashboard resource itself.
2. **Data permissions**: Viewers independently require `Monitoring Reader` or
   `Log Analytics Reader` on the telemetry workspace.
3. **Sharing boundary**: Sharing a dashboard link does **not** grant underlying
   data access. Missing workspace query permissions must remain an authorization
   failure, not be represented as zero usage.
4. **No shared secrets**: The dashboard introduces no client secrets, API keys,
   or connection strings, and never reuses the Container App's ingestion identity.

### Six panels and data interpretation

Panels visualize aggregate directional telemetry while respecting user privacy:
1. **Recorded Command Events** (`stat`): Total accepted command executions matching
   the selected window and filters. Labeled strictly as recorded command events,
   **not** as unique users, people, or installations.
2. **Event Volume Over Time** (`timeseries`): Hourly command event volume based on
   server-generated `TimeGenerated` timestamps.
3. **Events by Command** (`barchart`): Ranked distribution of the top 50 recorded
   canonical command names.
4. **Events by CLI Version** (`table`): Ranked distribution of the top 50 observed
   CLI versions. Does not represent installation inventory or user adoption.
5. **Nonzero Exit Outcomes** (`piechart`): Breakdown of zero (`success`) vs nonzero
   (`failure`) exit codes. `Outcome = failure` encompasses expected exit code 2
   states—such as `liftoff upgrade --check` finding an available update or `doctor`
   detecting an advisory—and is **not** an error or crash rate. Unexpected outcomes
   remain a separate `Unknown outcome` category.
6. **Latest Matching Event** (`stat`): Timestamp and age at the last query.
   Refresh manually before interpreting age; it is not a live clock.
   Absence of recent events is not proof of an outage, as executions may be
   opted-out, running in CI, or offline.

### Filtering, defaults, and states

- **Default range**: 7 days (`now-7d` to `now`). Log Analytics retention is
  capped at 180 days.
- **Manual refresh**: Default refresh is manual (`refresh: ""`) to prevent
  automatic query execution.
- **Variables**: JSON-formatted `$command` and `$cliVersion` dropdowns suggest at
  most 100 observed values for the chosen time range. Their ordinary `All` option
  removes the filter independently of that limit; exact values, not substring
  matches, select events.
- **Required host-qualification states**:
  - *Empty/Filtered No-Data*: A successful count can be zero or a panel can have no
    matching data; neither means no people use Liftoff or that ingestion is down.
  - *Access Denied*: Distinctly displayed when user lacks workspace permissions;
    never falls back to zero or healthy status.
  - *Missing Table / Throttling*: Explicit error displays; never masks failures
    as zero usage.
  - *Stale Display*: Values reflect the last successful query; the selected time
    range is not itself evidence of a recent refresh.

### Limitations

- No Grafana alerts, scheduled reports, or custom plugins are supported in the
  built-in host.
- No user, device, session, geographic, or machine tracking is performed.
- Live deployment and actual-host rendering are strictly **blocked absent explicit
  operator deployment authorization**. Generic implementation authorization is
  not deployment authorization.
- Schema-39 export/import parity, actual aggregate/filter results, viewer errors,
  narrow layouts, repeat no-op provisioning and dashboard-only rollback remain
  qualification requirements. JSON validity and source tests do not satisfy them.

Telemetry collection never authenticates to Azure, reads OpenTofu state, or
deploys telemetry infrastructure. Separately approved project Azure activation
does not grant authority over the operator telemetry resources.
