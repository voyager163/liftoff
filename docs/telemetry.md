# Telemetry and privacy

Liftoff collects a small aggregate event to understand which CLI commands are
useful and whether they exit with zero or nonzero status. Telemetry is enabled
by default, disclosed before the first eligible command, and never required for
the CLI to work. It creates no persistent installation or session identifier.

## Event contract

Each recognized command can send at most one event after it finishes:

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
recorded as `help`, and rejected input that never resolves to a recognized
command is not recorded.

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
replica, sub-second endpoint response, synthetic allowlisted event, six
Liftoff-defined columns, expected Azure system columns, server time, retention,
and absence of request, IP, geolocation, Container Apps platform/console, or
Application Insights records before compiling the endpoint into a Liftoff
release.

The final production architecture contains no Function App, FC1 plan, product
storage, OneDeploy action, or production storage-perimeter association.

For emergency disablement, apply the OpenTofu configuration with
`ingestion_enabled=false`, then publish a patch with client delivery disabled.
Rollback preserves `rg-liftoff-prod`; do not destroy the protected production
resource group.

Normal `liftoff` commands never authenticate to Azure, read OpenTofu state, or
deploy telemetry infrastructure.
