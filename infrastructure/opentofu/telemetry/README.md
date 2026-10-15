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
- The separate nine-column `LiftoffProjectEvents_CL` table, its explicit DCR
  projection and 180-day analytics/total retention. The command table and
  existing data are preserved.
- `project_ingestion_enabled=false` until separately approved synthetic
  verification; enabling the project endpoint does not grant client consent.
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

## Remote state and deployment

### Backward-compatible schema rollout

The command/project schema additions in this checkout are **not yet deployed**.
The gateway continues accepting command schema 1 with its original zero/nonzero
outcomes. Command schema 2 adds semantic `attention-required` and `cancelled`
alongside `success` and `failure`; the schema column preserves that distinction.
Older published clients emit schema 1. The candidate default client emits
schema 2; source availability is not publication or production qualification.

Project schema 2 uses `/api/projects` and `Custom-LiftoffProjectEvents`, never the
command stream. The table has exactly `TimeGenerated`, `EventName`,
`SchemaVersion`, `ProjectId`, `CliVersion`, `PolicyProfile`, `PolicyVersion`,
`TemplateSetDigest`, and `Source`. Policy versions are strings in storage.
Both endpoints reject additional fields and count streamed bytes against 1 KiB.
Gateway time is authoritative; no request, IP, console or client-time fields
are added.

Deploy the backward-compatible table/DCR and qualified gateway image first,
using the existing reviewed production inputs and preserving Korea Central,
workspace, accepted data, resource identities, backend and perimeter. The
project endpoint is disabled unless the exact project stream is configured.
After separate operator approval, enable it and qualify synthetic project
observations, rejection paths, managed-identity query access, retention and
logging exclusions before enabling a reporting client or heartbeat.
No client is enrolled by enabling this endpoint. Keep synthetic UUIDs in an
operator-controlled exclusion inventory rather than an additional payload field.
These offline tests do not prove Azure deployment or real identity access.

Set `project_ingestion_enabled=false` in the same reviewed production variable
file to stop project ingestion while retaining both tables and command delivery.
This flag only controls the project-stream environment setting, not resource
counts or destruction. Do not remove the table/DCR from configuration to disable
reporting. Client disablement is independent and does not delete accepted data.

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
3. Submit one synthetic event that uses an allowlisted command and verify wrong
   methods, malformed JSON, additional fields, and oversized bodies are rejected.
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

## Managed Grafana source preparation (not deployed)

The `grafana/` root adds only a Managed Grafana instance and explicitly reviewed
roles. It reads the existing `rg-liftoff-prod` and
`log-liftoff-telemetry-f5be1618`; it cannot create a replacement group/workspace,
edit DCRs, publish an image, or manage the state perimeter. AzureRM is pinned to
5.3.0; automatic provider registration is disabled. The instance is fixed to
Korea Central, protected with `prevent_destroy`, and uses a system identity
with **Log Analytics Reader at that workspace only**, plus **Monitoring Reader
at the existing DCR only** for native transformation metrics, never
subscription-wide Monitoring Reader. This additional DCR-scoped read grant
needs its own reviewed plan/approval; it is not inherited from an earlier
Logs-only plan. The DCR must also remain in Korea Central.
Viewer/editor/admin role entries are existing Entra object
IDs at the Grafana instance scope, reviewed independently; an empty map grants
nobody access. The identity has Logs/metric read access, not ingestion or state
access.

The separate `dashboards/` root pins Grafana provider 4.49.0 and provisions the
folder, Azure Monitor Logs MSI datasource, native dashboard JSON and paused
reporting-availability rules. It uses authenticated Grafana's standard theme
and table/time-series controls. There is no custom frontend, Prometheus, Loki,
Kubernetes, service-account creation, public sharing or embedded credential.
The public HTTPS interface still requires Entra/RBAC authentication; this is
not a private-network endpoint claim. The API-key setting is disabled; this
source creates no service accounts.
Provisioning uses an existing operator's short-lived Entra token privately in
`GRAFANA_AUTH`, with the documented **https://dashboard.azure.com** audience.
Never print it, put it in tfvars, save it in a dashboard, or commit it. No token
is needed for the backend-free checks below.

The same native Azure Monitor datasource also supports the independently
paused DCR transformation-error rule. It does not add a second data pipeline
or a custom fault producer.

### Gates and recurring cost

Read-only metadata observed on 2026-10-13 found only the six-column command
table/DCR stream, no project table/stream and no Grafana instance.
`Microsoft.Dashboard` was **NotRegistered**. Korea Central is advertised, but
actual Standard X1/X2 availability, quota, major version and size-specific
subscription pricing are **unqualified**. No provider was registered, resource
or role changed, state payload read, event uploaded or production plan run.
Protected state ownership/lineage and approved writer/network access also
remain unqualified. Do not infer these prerequisites from configuration.

Separately authorized read-only preparation on 2026-10-15 produced a
non-replacing telemetry schema plan and a local-empty-state proposed Grafana
plan. Neither was applied and no provider was registered. The subscription
SKU response was an empty list: this is inconclusive, not proof of availability
or unavailability. The later DCR metric permission/rule source requires a new
reviewed plan; it does not inherit either earlier plan's qualification.
Saved plans and full JSON can contain sensitive workspace values even with
local authentication disabled. Keep them private and permission-restricted;
use separately redacted summaries for review, never paste raw state into PRs.

The public [Azure Retail Prices API](https://prices.azure.com/api/retail/prices?$filter=contains(productName,%27Grafana%27)%20and%20armRegionName%20eq%20%27koreacentral%27)
returned Korea Central USD consumption meters on 2026-10-13:
Standard Node **$0.04617/hour** (about **$33.70 for 730 hours**),
Standard User **$6/month**, and optional Standard Zone Redundancy
**$0.055485/hour** (about **$40.50 for 730 hours**). Zone redundancy is off in
this source. These meters have no ARM size mapping and are **not an X1/X2
quote or cost approval**. Required node counts, active-user charges, discounts,
tax, workspace query/ingestion and the existing gateway/ACR costs must be
qualified with the actual SKU and subscription before approval. Do not assume
an Essential price qualifies Standard. No billable resources are provisioned
by these static checks.

The Grafana inputs intentionally have no SKU-size/major/name defaults. Obtain
fresh authorized metadata, actual cost/region/quota/provider proof, exact
ownership and a reviewed non-replacing plan before any future apply. Native
release and heartbeat production prerequisites in tasks 9 and 16 are still
unmet. This layer is source preparation, not task 17.7 deployment or task 17.8
exercised rollback. All section-17 task flags remain unchecked.

### Static validation and future operator sequence

Run from the repository root on Windows, macOS or Linux, using OpenTofu 1.12.6:

```bash
npm run check:telemetry-dashboards
npx vitest run tests/telemetry-dashboard.test.ts tests/telemetry-infrastructure.test.ts tests/telemetry-bootstrap.test.ts
tofu -chdir=infrastructure/opentofu/telemetry/grafana fmt -check
tofu -chdir=infrastructure/opentofu/telemetry/grafana init -backend=false -input=false -lockfile=readonly
tofu -chdir=infrastructure/opentofu/telemetry/grafana validate
tofu -chdir=infrastructure/opentofu/telemetry/grafana test -no-color
tofu -chdir=infrastructure/opentofu/telemetry/dashboards fmt -check
tofu -chdir=infrastructure/opentofu/telemetry/dashboards init -backend=false -input=false -lockfile=readonly
tofu -chdir=infrastructure/opentofu/telemetry/dashboards validate
tofu -chdir=infrastructure/opentofu/telemetry/dashboards test -no-color
```

The committed dashboard is deterministically generated from the reviewed KQL
catalog by `node scripts/telemetry-dashboards.mjs --write`; `--check` rejects
drift. The pinned Microsoft Kusto language service performs offline syntax and
schema analysis, with a fixed-dataset semantic oracle. This is **not execution
against Azure Logs**, a rendered native UI/access test, or proof of ingestion.
The MIT language-service dependency is development-only and is not bundled
with the CLI runtime. Native Grafana rendering, error displays and real KQL
results remain live qualification gates.
The `source.tftest.hcl` tests use mocked providers only; their plans assert
rendered configuration and negative inputs without production plan/refresh,
Azure credentials, Grafana requests, state/backend access or writes.

After separate operator approval (not performed by this source layer):

1. Preserve the actual subscription, Korea Central group/workspace/DCR,
   image delivery, logging exclusions, accepted records and both state network
   layers. The corrected example/default region is not authority over an
   existing production input; never apply examples or a replacement plan.
2. Deploy and verify the backward-compatible gateway/project table/DCR first.
   Register every synthetic UUID in `synthetic_project_ids` **before** an
   approved upload. Keep exclusions for 180 days after its last observation,
   including across rollback; there is no new payload flag.
3. Use separately approved **distinct backend keys** in the existing private
   container for `grafana/` and `dashboards/`. Do not repoint or copy/import the
   telemetry or bootstrap state. No remote-state data source is used. Existing
   storage/perimeter admission, Entra data access, locking, lineage and writer
   ownership are prerequisites; neither Grafana identity receives that access.
4. Review saved OpenTofu plans and apply the resource root, then verify its
   exact identity, workspace-scoped role and approved Entra operator access.
   Provision the datasource/dashboard root only at the returned exact endpoint,
   using existing private ephemeral operator authentication. Reobserve access
   after RBAC propagation; static provider validation does not verify it.
5. Run the real 30/90/180-day queries and native UI scenarios, including absent
   table, denied access, no events, known disabled configuration, expired
   retention, legacy-only data and delayed monthly reporting. Verify both
   tables retain analytics/total 180 days and no new request/IP/console logs.
6. Set `reporting_configuration` only from independently observed operator
   configuration, not silence. Populate `expected_heartbeats` only for genuinely
   enabled, qualified reporting, with its UTC monitoring-start timestamp.
   Qualify private notification routing before unpausing `alerts_enabled`.
   Independently qualify the exact Grafana managed identity's DCR metric
   access, native query/error/empty displays and positive bounded fault
   evaluation before also enabling `ingestion_fault_alerts_enabled`. Neither
   switch grants Azure roles, changes ingestion or registers providers.

### Definitions and alert limits

The dashboard always shows approximate observed and first-observed counts for
30/90/180 days. First-observed is earliest within retained data, never lifetime
enrollment. Distributions show each ID's latest observed CLI/policy/complete
registry digest in the chosen window, not the version installed everywhere or
conformance; equal server-time ties are unspecified. Source counts overlap
when an ID uses both CLI and heartbeat. Counts are directional, opted-in and
forgeable; IDs are not authentication. Dashboard text distinguishes configured
disabled/unknown reporting, successful empty queries, native unavailable
errors, potential retention expiry and explicit stale/unknown expectations.
The API query uses its KQL time range, not a dashboard-picker intersection.
Command availability and schema-separated outcome panels query the anonymous
command table independently, so legacy-only data remains readable without a
project table. Anonymous events have no project identifier: those event counts
are not project counts and cannot be classified by synthetic project ID.

Reporting-availability and heartbeat alerts evaluate every 15 minutes and
default **paused**. Query errors retain
Grafana's `DatasourceError`, and missing results retain `NoData`; successful
queries with no command events return zero **faults**, not a failure.
The availability probe verifies only command-table query/permission access.
It is not a gateway upload/ingestion-health signal.

The separate DCR rule queries Azure Monitor's actual
`TransformationErrors_Count` metric, not command/event volume or an invented
fault table. Authorized read-only metadata established Count aggregation,
one-minute granularity and `InputStreamId`/`ErrorType` dimensions for the
existing DCR. The source uses the native Grafana 12 Azure Monitor metric-query
contract and aggregates the DCR metric without splitting/filtering dimensions.
It evaluates every minute, sums Count points over a **15-minute window**, and
requires positive errors for a **5-minute pending** period. Late metrics or
faults outside that window can be missed; this is not a completeness guarantee.
Both `alerts_enabled` and the separate, default-false
`ingestion_fault_alerts_enabled` must be enabled. Global pause always wins.
Missing results remain `NoData`, query/auth errors remain `Error`, and no
missing/null series is explicitly filled with zero. The observed read-only
metric query returned an **empty timeseries**, not proof of zero faults.

This signal covers DCR transformation errors only: it is **not end-to-end
ingestion health**, gateway rejection/auth/network/queue health, a delivery
success rate, or a project activity/deployment signal. It creates no request,
body, IP or console logging and no contact/notification destination.
**Verified ingestion-fault alerting remains a live qualification gate** until
the actual Grafana identity/query, missing/error states, positive fault
evaluation and approved private routing are exercised. Source/mock success
does not complete task 17.5's production verification or any deployment gate.

Explicit monthly expectations use a maximum 31-day interval plus 9-day grace
(40 days), then a 15-minute pending period. Overdue is `now > due`, not `>=`.
A never-received or expired heartbeat is unknown reporting; an overdue expected
observation is stale/unknown, not abandonment or deployment failure. A CLI
observation cannot refresh a heartbeat deadline. Disabled configured reporting
pauses its alert; remove an individual's expectation only on independently
confirmed disablement, never infer it from silence. No contacts/subscriptions
or notification destinations are created by this root.

### Non-destructive dashboard disablement and rollback

Use the **same reviewed private inputs and backend keys** throughout.
Set `alerts_enabled=false` to pause evaluation without removing rules.
Set `project_ingestion_enabled=false` in the original telemetry root to stop
only new project delivery; preserve anonymous command ingress and both tables.
Client disablement remains separately consented and never deletes accepted data.
Changing `reporting_configuration` is a display/alert expectation input only;
it does not disable ingestion or clients.

For a dashboard/query regression, apply reviewed earlier dashboard/query
configuration with the same UIDs, datasource, exclusion inventory and expected
entry authority. Reconcile operator changes first. Do not blindly downgrade
the whole telemetry root or remove the datasource/folder to hide an error.
Do not run `destroy` on any of these roots, remove state, delete records or
relax `prevent_destroy`. Grafana is not count-gated by a disable switch:
pausing dashboards/alerts does **not stop its recurring service charges**.
Actual decommissioning needs a separate approved ownership/cost plan. No source
rollback instruction establishes that production rollback has been exercised.
