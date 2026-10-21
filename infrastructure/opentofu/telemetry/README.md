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

The candidate gateway is **deployed; project reporting remains disabled**.
On 2026-10-18, an explicitly authorized, reviewed OpenTofu plan against the original protected
remote state added `LiftoffProjectEvents_CL` and its separate DCR stream in place.
The plan added one resource, updated three, and destroyed none. Independent
readback confirmed all nine project columns and both tables' 180-day analytics
and total retention. The original command stream and gateway image were preserved during that first
schema-only step. A separate build-only plan then built public source
`006d3aabbffc3cd3a5ff30d2692f7c30cee280b8` through ACR run `de4`. A separately
reviewed gateway-only update deployed its verified image digest
`sha256:d209118a5640250d604beca54ac3cc74d392b5fb0e90070c49779478868361b7`.

Controlled operator qualification temporarily enabled the project stream.
Five malformed/extra-field/type/digest/streamed-size controls were rejected;
four accepted synthetic events deduplicated to two roots, including repeated
clone observations and overlapping CLI/protocol-heartbeat sources. Both IDs
were registered as exclusions before upload; all 33 native panel queries
across 30/90/180-day windows still excluded them. These are operator protocol
probes, not enrolled projects, an installed-client journey or a genuine CI
heartbeat. The initial private probe incorrectly used a string policy version
and an unprefixed digest and was correctly rejected; its evidence is retained
separately from the corrected probes.

Feature disablement has been exercised: `project_ingestion_enabled=false` is
back in effect, the project route returns 503, and legacy anonymous command
ingestion still accepts schema 1. The four synthetic records survive; one
explicit operator schema-1 command probe is not real command-usage evidence.
The final telemetry plan has no changes. No client or heartbeat was enrolled.
The two synthetic exclusions also have a byte-verified durable operator
inventory at `grafana/synthetic-qualification-20261018.json` in the existing
protected `tfstate` container, separate from all state keys. Keep those IDs in
dashboard inputs for at least 180 days after their last accepted observation;
this inventory is not consent or a client configuration.

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

Both Azure providers explicitly disable automatic registration in this root:
AzureRM uses `resource_provider_registrations = "none"` and AzAPI uses
`skip_provider_registration = true`. The Grafana root also disables automatic
registration. Provider registration remains a separately approved operator
prerequisite, never an incidental effect of a plan or provider initialization.
Do not override these settings to work around an unregistered provider.

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

### Build a candidate before switching the gateway

Do not pair a new `source_revision` with the old image digest to force a build.
Keep the currently deployed `source_revision`, `image_digest` and retained
revisions unchanged, and add the full public candidate SHA to
`prepared_image_revisions` in the private production variable file. This set
defaults to empty and only adds explicit build tasks/runs; it cannot change
the active image or enable project ingestion.

Review a saved plan that preserves existing resources and the active gateway,
then apply that exact plan. Verify the actual ACR run succeeded and read the
candidate tag's manifest digest using Entra authentication:

```bash
az acr repository show --subscription <approved-subscription> \
  --name <existing-registry> --image telemetry-ingest:<full-candidate-sha> \
  --query digest --output tsv
```

Only then set `source_revision` to that candidate and `image_digest` to its
observed digest, move the previous active revision into
`retained_image_revisions`, and remove the candidate from the prepared set.
Review and apply a fresh non-replacing plan. The build-task identity is
unchanged across this handover; removing a prepared revision without retaining
or deploying it is a separately reviewed resource deletion, not cleanup
authority. Keep `project_ingestion_enabled=false` until the independent
synthetic-ingestion approval/verification step.
These are telemetry operator steps, not Liftoff application artifact,
native release, programme-delivery or whole-job custody qualification.

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

## Managed Grafana deployment and remaining qualification

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
Workspace discovery uses the generic management-plane resource metadata
lookup, not the shared-key-capable Log Analytics workspace datasource. It
requires exactly one matching resource ID, name, group and type, and refuses
region drift before granting access. Grafana preparation does not request
workspace shared keys, including when workspace local authentication is
disabled; it does not need ingestion credentials.
This change does not sanitize previously saved plans or state; retain their
existing private handling and separately authorized cleanup boundaries.
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
Set each rule's `query_type` as well as its native model `queryType`; Grafana
canonicalizes the former on creation. Omitting it produces perpetual plan
drift. The deployed configuration includes both and converges without ignoring
rule changes.

The authenticated [adoption dashboard](https://amg-liftoff-f5be1618-h3byfdaghwfveue4.sel.grafana.azure.com/d/liftoff-observed-adoption)
is deployed. Actual Entra `/api/org`, dashboard and native datasource queries
succeeded; the instance reports Grafana 13.1.3. The MSI has exactly the
workspace-scoped Log Analytics Reader and DCR-scoped Monitoring Reader grants;
the existing operator has instance-scoped Grafana Admin. API keys and zone
redundancy are disabled. All three alert rules remain paused, with no expected
heartbeat inventory or notification routing.

Native query errors were verified as HTTP 400 errors, not zero-project results.
The DCR metric query succeeds but currently has an empty timeseries: **unknown**,
not a verified zero-fault or end-to-end health signal. An approved dashboard-only
rollback returned actual 404 while retaining the datasource/rules; restoration
returned 200 and the full dashboard root converged without changes. Normal
native browser journeys are qualified below; fault-alert firing/routing,
published-client and genuine heartbeat qualification remain outstanding.
API evidence is not a claim that these journeys ran.

The subsequent native browser check rendered all 12 panels, exercised the
30/90/180-day selector and received 25 successful native query responses:
seven window-dependent panels rerun for each selection; unchanged panels reuse
their original results. A separate narrow-screen check rendered all 12 panels
and exposed the full measurement caveats through native panel scrolling.
An isolated missing-table query produced an actual HTTP 400, the native error
status button and its detailed Azure error, with no zero-result substitution.
Successful empty panels now say **No retained value**, not "unavailable";
use the native query status/error details to distinguish failure from emptiness.
Authentication used the existing approved operator's bearer token, injected
only for the exact Grafana origin in a disposable browser. No interactive
sign-in, new account, credential persistence or broader viewer role was tested.

This is not a query-availability guarantee. A later extra forced-reload probe
retained 24 successful responses but stalled on the 180-day timeline at its
60-second observation bound; other stalled diagnostic probes are also retained.
Their cause is unestablished, and later passing normal journeys do not repair
or relabel them. Datasource health HTTP 200 alone is not query-path proof.
The reviewed correction changed only 11 empty-value labels and one description;
the separate dashboard state advanced from serial 4 to 5 with its lineage
preserved and a final no-change plan. Roles, datasource, alerts, logging and
query timeouts were not changed.

### Gates and recurring cost

Read-only metadata observed on 2026-10-13 found only the six-column command
table/DCR stream, no project table/stream and no Grafana instance.
`Microsoft.Dashboard` was **NotRegistered**. Korea Central is advertised, but
actual Standard X1/X2 availability, quota, major version and size-specific
subscription pricing are **unqualified**. No provider was registered, resource
or role changed, state payload read, event uploaded or production plan run.
Protected state ownership/lineage and approved writer/network access also
remain unqualified. Do not infer these prerequisites from configuration.

Those observations are historical, not the current provider/table status.
Separately authorized work on 2026-10-18 registered `Microsoft.Dashboard` and
verified terminal `Registered` readback. Provider-level ARM validation accepted
a proposed Standard X1, Grafana major 13 instance in Korea Central; validation
does not create an instance, reserve capacity, approve recurring cost, or prove
real managed-identity/query access. Subsequent explicitly authorized provisioning
created Standard X1 in Korea Central, followed by the scoped roles and native
dashboard described above. Retail meters inspected before apply imply two
Standard units at $0.04617/hour each: approximately USD 67.41 per 730 hours,
plus $6/month per active user, or approximately USD 73.41/month for one user,
before taxes and existing telemetry costs. This is a disclosed retail estimate,
not an actual subscription-specific invoice or an X2 quote.
The schema rollout above used the existing Entra-authenticated remote backend
and preserved its original lineage while advancing its serial. Original and
post-apply state and full saved plans are retained privately, not in the repo.
The first backend initialization rejected simultaneous subscription/tenant CLI
credential options; the corrected invocation pinned the exact subscription and
independently checked its tenant without changing the global Azure default.
This is operator deployment evidence, not whole-job/host custody or application
deployment qualification.

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
Standard Node **$0.04617/hour** (about **$33.70 per billed unit for 730 hours**),
Standard User **$6/month**, and optional Standard Zone Redundancy
**$0.055485/hour** (about **$40.50 for 730 hours**). Zone redundancy is off in
this source. These API meters alone have no ARM size mapping and are **not an X1/X2
quote or cost approval**.

The [official Microsoft pricing table](https://azure.microsoft.com/en-us/pricing/details/managed-grafana/),
retrieved on 2026-10-15, explicitly maps **Standard X1 to 2 Standard Units** and
**Standard X2 to 4 Standard Units**. Applying the Korea Central retail unit
rate above gives these steady-state illustrations for 730 hours:

| Proposed size | Billed instance units | Instance only | With one billed active user |
| --- | --- | --- | --- |
| Standard X1 | 2 Standard Units | USD 67.41 | USD 73.41 |
| Standard X2 | 4 Standard Units | USD 134.82 | USD 140.82 |

The USD 33.70 figure is for **one unit**, not an X1 instance. Optional zone
redundancy adds one zone-redundancy unit for X1 or two for X2; it remains off.
These are retail arithmetic, **not a subscription quote or approved budget**.
Actual regional SKU/version availability and quota, subscription offer/discounts,
tax, billed active-user counts, workspace query/ingestion and existing
gateway/ACR costs remain separately qualified/approved inputs. Any introductory
free period advertised on the pricing page is not assumed available to this
subscription. Do not assume an Essential price qualifies Standard. No billable
resources are provisioned by these static checks.

The Grafana inputs intentionally have no SKU-size/major/name defaults. Obtain
fresh authorized metadata, actual cost/region/quota/provider proof, exact
ownership and a reviewed non-replacing plan before any future apply. The
2026-10-18 operator rollout and non-destructive rollback above are actual
deployment evidence, separate from these static checks. Native release,
published-client/heartbeat and fault-alert firing/routing gates remain
incomplete; no source-only check grants that qualification. The bounded native
browser evidence above does not qualify interactive sign-in or reload stress.

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
with the CLI runtime. These commands do not replace the separate live native
rendering, error-display and KQL evidence described above.
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
   Set `alert_contact_point_name` to the exact existing, separately approved
   contact point name in private inputs; unpausing without one fails validation.
   Independently verify its current destination and Grafana's
   `alertingSimplifiedRouting` support. Selecting a name is not proof of
   existence, successful delivery or permission to create/change a receiver.
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
The monthly table also carries the explicit operator reporting configuration.
An empty inventory, including one entirely excluded as synthetic, returns an
**unconfigured** status row with zero expected projects; it is not a healthy
heartbeat observation. Future monitoring starts remain visible as **pending**,
not stale or silently absent. A configured `disabled` value describes operator
configuration, not consent or disablement inferred for individual clients.
These status rows do not create project identities or events. Query/table/
permission errors still fail as unavailable rather than returning these rows.
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
body, IP or console logging, contact point or notification destination.
When an existing `alert_contact_point_name` is explicitly selected, all three
Liftoff rules use direct `notification_settings`, without taking ownership of
the global notification-policy tree, contact points or subscriptions. Names
are bounded literal aliases, not email addresses, webhook URLs or credentials.
Notifications group by folder and alert name, wait 30 seconds, group subsequent
changes for five minutes and repeat ongoing alerts every four hours. Direct
routing requires Grafana's `alertingSimplifiedRouting` support; inspect that
capability and the exact receiver before a separately approved apply. A missing
or unsupported receiver is a blocking qualification failure, not permission to
fall back to ambient routing.
Leaving the name unset preserves the existing paused rules with no routing
block. Selecting a name does not unpause them. These source checks do not
verify the receiver, evaluate a live fault or send a test notification.
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
