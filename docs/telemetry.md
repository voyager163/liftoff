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

The read-only `liftoff repair --capabilities` and `liftoff repair --inspect-layout`
modes also bypass telemetry and disclosure, including their help/JSON forms.
Capability negotiation and application inventory therefore introduce no
telemetry network request or disclosure-state write.

`liftoff capabilities` is also telemetry/disclosure-free in text, JSON and help
forms, including `liftoff help capabilities`. It reads only installed capability
metadata and bundled assets, never a project or enrollment record.

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

## Versioned ingestion rollout

The candidate gateway accepts command schemas 1 and 2 independently. Schema 1
retains its original zero/nonzero meaning; schema 2 accepts `success`,
`attention-required`, `cancelled`, and `failure` from the command's semantic
result. Expected exit-2 drift is attention-required, while an actual partial
execution failure is failure. A schema-1 event is never reinterpreted as schema
2. The currently wired client still sends schema 1; semantic client delivery and
project enrollment are not enabled by this gateway change.

Command producers also record an invocation-local semantic outcome. Expected
update drift or an available CLI upgrade is `attention-required`; an explicit
decline or interactive cancellation is `cancelled`. Failed verification,
partial execution, recovery or cleanup remains `failure`, even if its public
exit is 2 or a later prompt is cancelled. An unclassified nonzero exit stays
`failure`; numeric exit codes and command output are unchanged.

Explicit local integrations may observe a schema-2 event through the optional
`CliTelemetryHooks.afterSemanticCommand` hook. It uses the same command
allowlist, disclosure readiness, global opt-outs and assessment/capability
exclusions. Existing `afterCommand(parsed, exitCode, env)` hooks still receive
their original arguments. The default client has no semantic hook and still
emits only its existing schema-1 request and notice. This observation contract
does not roll out schema-2 transport, enroll projects or create identifiers.

The candidate configuration is **not yet deployed**. Its separate
`/api/projects` endpoint accepts only project schema 2:

```json
{
  "schemaVersion": 2,
  "event": "project_observed",
  "projectId": "550e8400-e29b-41d4-a716-446655440000",
  "cliVersion": "0.12.3",
  "policyProfile": "single-maintainer-gitflow",
  "policyVersion": 6,
  "templateSetDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "source": "cli"
}
```

This is a synthetic contract example, not an enrolled project or a request to
send an event. IDs must be canonical random UUIDv4 values; sources are only
`cli` or `ci-heartbeat`. The policy pairs currently admitted are
single-maintainer versions 6/7, team version 1, and `none` with version `"none"`.
CLI versions use the bounded release-version grammar, and template/plugin-set
identities use canonical lowercase SHA-256 digests. Those syntactic checks do
not authenticate a claimed release, project, consent, or digest.

The private v8 metadata reader selects the validated installed modern registry's
`registryDigest` for `templateSetDigest`. This identifies the complete supported
release bundle, including plugin identities, shared core declarations/assets,
selection space and operation declarations. It is not the plugin-only
`pluginSetDigest`, nor the per-project `resolutionDigest`, which encodes project
choices. Different names, layouts, stacks, agents, regions and environments in
the same supported bundle therefore do not produce different template-set
digests. The registry does not hash renderer implementation code; released
renderer changes still require the existing reviewed content-version discipline.

The reader validates the complete v8 source against actual packaged declarations
before returning only the policy pair and bundle digest. Historical, unsupported
or mismatched source metadata is rejected, never upgraded or assigned a guessed
bundle. This describes the installed bundle that understands the source, not a
claim that application files match it, that it originally generated the project,
or that an update ran. It does not identify a filesystem root, create an ID,
establish consent, construct an event, or enable reporting. Those remain separate
enrollment/reporting prerequisites; the default CLI does not call this reader.

Project records contain exactly `TimeGenerated`, `EventName`, `SchemaVersion`,
`ProjectId`, `CliVersion`, `PolicyProfile`, `PolicyVersion`, `TemplateSetDigest`,
and `Source` in the separate `LiftoffProjectEvents_CL` table. Time is generated
by the gateway; policy versions are stored as strings, including `"none"`.
Neither endpoint accepts extra fields, client timestamps, project paths,
repository URLs, request metadata, or a synthetic-event flag. Both enforce the
same 1-KiB streamed-byte limit before parsing.

`project_ingestion_enabled=false` is the infrastructure default. A valid project
request then returns unavailable rather than falling back to anonymous command
storage. Enabling the endpoint is a separate operator deployment decision and
does not enroll clients or enable a CI heartbeat. Client enrollment must obtain
independent explicit consent before generating a project ID; merely possessing
a copied record, installing Liftoff, or accepting an unrelated prompt does not
grant that consent.

Project IDs are pseudonymous and linkable, not anonymous. Clones/worktrees can
share one enrolled project identity, while separate monorepo project roots have
distinct identities. A heartbeat records reporting, not developer activity,
deployment health or compliance. Both tables retain only 180 days of analytics
and total retention; observations cannot establish lifetime adoption or a
census. A public project ID is not authentication and cannot authorize deletion.
An operator-reviewed deletion request needs independently verified authority;
disabling delivery only stops future observations and does not claim historical
deletion. The public endpoint can receive forged observations.

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

The private delivery foundation uses one invocation-local absolute deadline
for postcommand delivery and observer awaits. Waiting for one observer does
not give a later observer or request another second. Shorter budgets can be
used by injected callers; larger values cannot raise the one-second maximum.
Waiting is bounded even when injected transport ignores its abort signal.
Late completion cannot change a timeout result or authorize another request.
This does not bound precommand disclosure/configuration I/O, guarantee
real-time scheduling while the process is suspended or its event loop is
blocked, or control arbitrary third-party code that ignores cancellation.

The internal `deliverPreparedTelemetry` seam accepts at most one fixed command
slot and one fixed project slot. Ready independent requests share the deadline
and start concurrently. A command slot accepts schema 1 **or** schema 2, never
both in one invocation. The default CLI still supplies only the existing
schema-1 command slot; no project discovery, enrollment or explicit report
command is wired by this foundation.

Requested slots return a closed local result: `delivered`, `disabled`, or
`failed`, plus whether transport was attempted and a fixed reason where
applicable. Delivery means a successful endpoint response before the deadline,
not independent proof of durable storage. A timeout cannot establish whether
the remote endpoint accepted the request; it is never retried to resolve that
uncertainty. Ordinary commands discard delivery results and preserve their
own output/exit. Unrequested slots are omitted, and a project-only private
call cannot recursively emit a command aggregate.

The seam validates exact payload shapes, HTTPS and the 1-KiB body limit, but
syntactically valid project input is **not** consent or release-ownership
evidence. A future project caller must independently validate those contracts
before supplying an observation. Global opt-outs still win and ordinary
`CI=true` disables both slots, even for a supplied `ci-heartbeat` payload.
There is no CI exception, project ID creation, public report result/exit
contract, production schema-2 switch, or task-16 enrollment in this foundation.

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
