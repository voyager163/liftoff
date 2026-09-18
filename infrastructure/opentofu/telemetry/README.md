# Liftoff telemetry infrastructure

This OpenTofu root creates and manages the production telemetry service in
`rg-liftoff-prod`. Normal `liftoff` commands never read this state, authenticate
to Azure, or run infrastructure operations.

## Review boundary

Before applying, review:

- The fixed `rg-liftoff-prod` name and its `prevent_destroy` lifecycle rule.
- The Azure subscription, region, globally unique `resource_suffix`, full
  40-character public `source_revision`, and remote state backend.
- The ACR Basic registry with administrator credentials and anonymous pull
  disabled. Its endpoint is public, but it contains only already-public
  application image bytes and requires Entra authentication.
- The tokenless ACR task context pinned to
  `https://github.com/voyager163/liftoff.git#<source_revision>`, commit-tagged
  build, resolved manifest digest, successful run-now build, and reviewed
  digest-pinned Dockerfile.
- The user-assigned identity with registry-scoped `AcrPull` and DCR-scoped
  `Monitoring Metrics Publisher`.
- The Container Apps environment with persistent platform logs disabled.
- The Container App's HTTPS-only ingress, single revision, 0.25 vCPU, 0.5 GiB,
  one minimum replica, five maximum replicas, HTTP scaling, and TCP probes.
- The six-column `LiftoffCommandEvents_CL` table and 180-day retention.
- The Log Analytics daily quota and absence of Application Insights, ingress
  diagnostics, registry credentials, storage credentials, and secret outputs.

## Build and validate

From the repository root:

```bash
npm ci --prefix services/telemetry-ingest
npm run check --prefix services/telemetry-ingest
npm run package --prefix services/telemetry-ingest
npm run smoke:container --prefix services/telemetry-ingest
tofu -chdir=infrastructure/opentofu/telemetry fmt -check
tofu -chdir=infrastructure/opentofu/telemetry init -backend=false
tofu -chdir=infrastructure/opentofu/telemetry validate
```

The package and container smoke tests use the same compiled server artifact. The
provider lock file and Docker base digest are reviewed and committed.

Lifecycle-command rollout preserves schema 1 and all released v0.12.3 events.
Before candidate client publication, independently authorize and verify the
gateway's exact source/image/revision and its old/new command compatibility.
Source tests or a dashboard deployment do not establish deployed gateway
readiness. See [backward-compatible lifecycle rollout](../../../docs/telemetry.md#backward-compatible-lifecycle-rollout)
for the unchanged six-column boundary, disposable qualification, release block,
and rollback constraints. No synthetic validation events belong in production.

## Remote state and deployment

Copy `backend.hcl.example` and `production.tfvars.example` outside the
repository, replace their placeholders, and keep Azure credentials out of both
files. The state storage account and container must already exist in the
separately bootstrapped `rg-liftoff-tfstate` resource group and use Entra
authentication. Keeping backend resources outside `rg-liftoff-prod` avoids a
create/import conflict and keeps production rollback from affecting state.

Run production operations only from an operator CIDR admitted by the bootstrap.
Use the same reviewed production variable file for every plan and apply. This
prevents emergency operations from reverting the region, immutable source
revision, or ingestion quota to defaults. The selected source commit must
already be reachable from the public repository; uncommitted or unpushed code
cannot become a production image.

Standard GitHub-hosted runners are static-validation-only because personal
GitHub accounts cannot attach them to private Azure networking and their dynamic
addresses are not perimeter rules.

```bash
tofu -chdir=infrastructure/opentofu/telemetry init \
  -backend-config=/secure/path/telemetry-backend.hcl
tofu -chdir=infrastructure/opentofu/telemetry plan \
  -var-file=/secure/path/telemetry-production.tfvars \
  -out=telemetry.tfplan
tofu -chdir=infrastructure/opentofu/telemetry apply telemetry.tfplan
tofu -chdir=infrastructure/opentofu/telemetry output telemetry_endpoint
```

OpenTofu creates the registry task, waits for the ACR build to succeed, waits for
the `AcrPull` role to propagate, and then creates the Container App revision
using the exact commit-tagged image. Do not push production images out of band
or place a GitHub token, registry password, storage key, SAS token, endpoint key,
or Azure Monitor credential in variables, state configuration, source, or
outputs.

## Verification

Before compiling the endpoint into a Liftoff release:

1. Confirm ACR administrator and anonymous access are disabled, the build tag
   equals `source_revision`, the configured `image_digest` resolves from that
   tag, and the Container App pulls the digest with managed identity.
2. Confirm exactly one idle 0.25-vCPU/0.5-GiB replica is ready and repeated
   `/api/events` requests complete within the client's one-second budget.
3. Submit a disposable approved-scope validation probe to verify wrong methods,
   malformed JSON, additional fields, and oversized bodies are rejected, keeping
   test records isolated to disposable approved scopes rather than sending fake
   production usage to qualify or populate the telemetry dashboard.
4. Query `LiftoffCommandEvents_CL` and verify the Liftoff-defined columns are
   exactly `TimeGenerated`, `EventName`, `SchemaVersion`, `Command`,
   `CliVersion`, and `Outcome`. Additional columns must be expected Azure
   Monitor system columns, not additional Liftoff event fields.
5. Confirm server-generated time and 180-day analytics and total retention.
6. Confirm there are no Application Insights, Container Apps ingress, console,
   request, IP, or geolocation records.

The smallest always-ready Consumption replica avoids scale-to-zero cold starts.
At Korea Central retail rates observed during design, its post-free-grant idle
compute was approximately USD 4.29 per 730-hour month, plus roughly USD 5 per
month for ACR Basic. Actual cost depends on current rates and subscription-wide
free-grant usage.

The final architecture contains no Function App, FC1 plan, product storage,
OneDeploy action, or storage-specific production role. State storage remains
`SecuredByPerimeter` and reachable only from ignored operator `/32` inputs with
Entra/RBAC authorization.

## Emergency disablement and rollback

Disable public ingestion without deleting data or the resource group:

```bash
tofu -chdir=infrastructure/opentofu/telemetry apply \
  -var-file=/secure/path/telemetry-production.tfvars \
  -var ingestion_enabled=false
```

Then publish a Liftoff patch with client delivery disabled. Remove individual
telemetry resources only through a reviewed OpenTofu plan. Never destroy
`rg-liftoff-prod`; its deletion protection is intentional.

## Azure Monitor Grafana telemetry dashboard

This directory contains the operator dashboard definition for Azure Monitor's
built-in Grafana experience. After separately approved deployment, locate it under
**Azure Monitor > Dashboards with Grafana** or through
`telemetry_dashboard_portal_url`. Source validation is not live-host qualification.

### Architecture and bindings

- **Host resource**: Azure-native `Microsoft.Dashboard/dashboards@2025-08-01`
  managed by OpenTofu AzAPI provider in `rg-liftoff-prod`, with definition child
  resource `Microsoft.Dashboard/dashboards/dashboardDefinitions@2025-09-01-preview`.
  The definition is canonically JSON-encoded before submission. The Azure
  `GrafanaDashboardTags` tag mirrors the source model's tags because Grafana JSON
  tags alone do not populate the portal gallery.
- **Data source**: Queries the existing `log-liftoff-telemetry-<resource_suffix>`
  workspace and `LiftoffCommandEvents_CL` table without creating a duplicate store,
  new collector, or paid Managed Grafana workspace.
- **Outputs**:
  - `telemetry_dashboard_id`: Azure Resource Manager ID of the dashboard.
  - `telemetry_dashboard_portal_url`: Direct Azure portal link to the dashboard.
- **Zero ($0) hosting charge**: Azure Monitor's built-in Grafana carries no separate
  Grafana instance fee. Existing Log Analytics data ingestion, storage (180 days),
  and standard query charges apply.

### Current-user access and RBAC

Azure Monitor built-in Grafana executes queries using the current signed-in user's
Microsoft Entra ID token:

1. **Dashboard access**: Viewer needs `Reader` on `rg-liftoff-prod` or the dashboard
   resource itself (`Microsoft.Dashboard/dashboards/read`).
2. **Data query access**: Viewer needs `Monitoring Reader` or `Log Analytics Reader`
   on the telemetry workspace (`Microsoft.OperationalInsights/workspaces/query/read`).
3. **Access independence**: Sharing a dashboard link does **not** grant data access.
   Viewers who lack workspace query access must remain denied; confirm the actual
   host's error presentation during viewer qualification rather than granting a
   broader role to make an empty panel disappear.
4. **No shared secrets**: The dashboard requires no service principal secret,
   API key, or connection string. The Container App's user-assigned ingestion identity
   (`id-liftoff-telemetry-<resource_suffix>`) is never reused or granted query rights.

### Six panels and interpretation

All six panels represent anonymous aggregate counts matching selected filters.
They never track unique users, device IDs, or individual activity:

1. **Recorded Command Events** (`stat`): Total accepted command events matching the
   selected time window and filters. This is an event count, not a headcount or
   installation inventory. Successful empty observations distinguish an empty
   time range from no records matching selected command/version filters.
2. **Latest Matching Event** (`stat`): Server-generated `TimeGenerated` timestamp
   and age in minutes at the last query, alongside **Query observed at** even for
   successful empty results. Time and text fields are explicitly selected rather
   than relying on the stat panel's numeric-field default. Refresh to recalculate age. Absence of recent events is
   not proof of service outage (runs may be opted out, in CI, or offline).
3. **Nonzero Exit Outcomes** (`piechart`): Breakdown of zero (`success`) vs nonzero
   (`failure`) command exits. `Outcome = failure` includes normal non-error outcomes
   such as `liftoff upgrade --check` finding an update (exit 2) or `doctor` reporting
   diagnostic items. It is an exit-status classification, **not** an application crash
   rate. Unexpected or missing outcome values are grouped as `Unknown outcome`,
   not counted as successful exits.
4. **Event Volume Over Time** (`timeseries`): Hourly command-event counts based on
   server-generated `TimeGenerated` timestamps.
5. **Events by Command** (`barchart`): Top 50 most frequently recorded canonical command
   names.
6. **Events by CLI Version** (`table`): Top 50 observed CLI release versions. Does not
   represent installed user bases or package manager channels.

### Filters, defaults, and troubleshooting states

- **Default time range**: 7 days (`now-7d` to `now`). Log Analytics retention is
  180 days; queries beyond this window return no data.
- **Manual refresh**: Default refresh is manual (`refresh: ""`) to prevent background
  query consumption.
- **Variables**: `$command` and `$cliVersion` use JSON-literal interpolation and
  exact value matching. Each time-filtered dropdown suggests at most 100 values
  plus an ordinary `All` option. `All` removes that filter, including values
  outside those suggestions; it does not expand only the visible options.
  Changing the time range refreshes the suggestions.
- **Required host-qualification states**:
  - *Loading*: Visual indication while queries run.
  - *Empty result*: A successful count can be zero; other panels can show no data.
  - *Filtered no-data*: No records match the selected scope; this is not an outage.
  - *Access denied*: Displays explicit authorization error if user lacks Log Analytics
    read permissions; never defaults to 0 or healthy.
  - *Missing table*: Displays table-not-found error if `LiftoffCommandEvents_CL` is absent.
  - *Query throttling*: Displays rate-limiting error if Azure Monitor limits are hit.
  - *Stale display*: Values and event age reflect the last query, not a live clock.
    Compare **Query observed at** to current time. The selected time range alone
    does not prove a recent successful refresh. A failed refresh must preserve its
    native error indication even if the host retains earlier values.

### Deployment and qualification status

Live dashboard deployment, portal rendering, and repeat live no-op/removal qualification
are strictly **blocked absent explicit operator authority**. Generic implementation
authorization does not authorize cloud deployments. The committed model and OpenTofu
configuration are statically verified via `tofu validate` and synthetic contract tests.
The committed Grafana schema-39 model still needs actual Azure Monitor
export/import parity, rendered aggregate/query comparisons, narrow-layout and
error-state checks. These missing observations block coordinated publication.

The [Azure Monitor ARM export contract](https://learn.microsoft.com/azure/azure-monitor/visualize/visualize-use-grafana-dashboards#manage-a-dashboard-as-an-arm-template)
defines the dashboard and definition resources. [Grafana variable formatting](https://grafana.com/docs/grafana/latest/dashboards/variables/variable-syntax/)
defines JSON interpolation; no unescaped custom-All expression is used.

The official contracts reviewed on 2026-09-17 confirm `serializedData` is a JSON
string in the `default` child, introduced in `2025-09-01-preview`; the stable
`2025-08-01` parent alone cannot carry the definition. They do not pin the Azure
host's Grafana schema, datasource UID or panel/plugin version. Schema 39 and the
committed datasource references remain candidates pending real export/import
comparison. Do not replace this qualification with a standalone Grafana render,
invent an export payload, or introduce a paid hosting fallback.

### Operator-only reconciliation and dashboard removal

After separate authorization, use the established production backend and the
same reviewed operator inputs for a saved OpenTofu plan. Inspect the complete
plan, not a targeted subset. A dashboard-only change may affect only
`azapi_resource.telemetry_dashboard` and
`azapi_resource.telemetry_dashboard_definition`; their outputs are informational.
Stop for any workspace, table, DCR, gateway, role, protected resource-group,
retention, image-build or state-perimeter change. Dashboard approval does not
authorize those effects.

After approved apply and actual definition readback, repeat the normal plan with
`-detailed-exitcode`: 0 is no changes, 2 requires review, and 1 is an error. Inspect
the dashboard's effective definition and bindings as well as plan status. A
portal edit must appear as drift; never suppress `serializedData` differences
with `ignore_changes`, silently adopt them into state or blindly reapply source.

To roll back, review the exact earlier dashboard model and its compatible
resource definition, then approve only the resulting dashboard changes. To
remove it, prepare a reviewed configuration change removing the two exact
dashboard resource blocks and their two outputs. A saved full plan must delete
only that child/parent pair while preserving all telemetry resources and data.
Never run whole-root destroy or assume `-target` proves the absence of related
effects. Apply only the separately approved saved plan, independently verify
the result and preservation, and confirm the next full plan is a no-op.
These are qualification steps, not operations performed by source tests.

## Related operator documentation

- [OpenTofu state bootstrap](../bootstrap/README.md)
- [Telemetry and privacy guide](../../../docs/telemetry.md)
