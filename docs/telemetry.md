# Telemetry and privacy

Liftoff collects a small aggregate event to understand which CLI commands are
useful and whether they complete, need operator attention, are cancelled, or
fail. Telemetry is enabled by default, disclosed before the first eligible
command, and never required for the CLI to work.
It creates no persistent installation or session identifier.

## Event contract

Each telemetry-eligible command can send at most one current event after it
finishes:

```json
{
  "schemaVersion": 2,
  "event": "command_executed",
  "command": "infra:plan",
  "cliVersion": "0.12.3",
  "outcome": "attention-required"
}
```

Schema-2 `outcome` is the invocation-local semantic result: `success`,
`attention-required`, `cancelled`, or `failure`. Help requests are recorded as
`help`, except assessment help as described below. Rejected input that never
resolves to a recognized command is not recorded.

Older released clients and the retained legacy `trackCommand` compatibility API
send schema 1 records with the same field names. Schema 1 keeps its original
zero-to-`success`, nonzero-to-`failure` meaning.

`liftoff governance assess` skips telemetry and disclosure entirely, including
`--live` and `--help`. It sends no telemetry event, displays no disclosure notice,
and writes no disclosure state, regardless of the default telemetry setting.
Opting into live assessment authorizes only its scoped read-only observations,
not telemetry delivery.

`liftoff assess` has the same exclusions in local, live and help modes, including
`liftoff help assess`.

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

`liftoff doctor` and its JSON/help forms, `liftoff help doctor`,
`liftoff upgrade --help`, and `liftoff help upgrade` bypass anonymous telemetry,
disclosure, and consent/enrollment writes. Ownership, freshness and replacement
verification subprocesses opt out with both `DO_NOT_TRACK=1` and
`LIFTOFF_TELEMETRY=0`, including in ordinary CI environments. Updating the CLI
does not enroll project reporting or change the user's reporting configuration.

Liftoff does **not** send:

- An installation, user, device, or session identifier.
- A client timestamp or duration.
- Arguments, flags, paths, project names, config values, manifests, or generated
  content.
- Error text, stack traces, operating-system details, Node.js version, cloud,
  workload, region, or environment choices.
- A source IP address or derived location in the event.

Liftoff creates no telemetry queue and stores no event locally. Anonymous
disclosure uses a numeric notice version. Separately approved project reporting
also records the project UUID and an external checkout-bound consent, as described
below. None of these records is an installation, user or device identity.

## Versioned ingestion rollout

The gateway accepts command schemas 1 and 2 independently. Schema 1
retains its original zero/nonzero meaning; schema 2 accepts `success`,
`attention-required`, `cancelled`, and `failure` from the command's semantic
result. Expected exit-2 drift is attention-required, while an actual partial
execution failure is failure. A schema-1 event is never reinterpreted as schema
2. The current default client sends schema 2. The candidate client exposes
separate explicit project enrollment; this is not a claim that the latest
published release or production ingestion has been qualified for it.

Telemetry payloads admit only bounded release versions: stable versions and the
declared `alpha`, `beta`, or `rc` prerelease forms. Reserved unpublished source
versions such as `0.13.0-dev.0` do not display the ordinary disclosure, invoke
telemetry hooks, or send command/project events. Explicit local telemetry
status, enrollment, and disablement commands remain available; an explicit
report from an unpublished build returns `unreleased-cli` without transport.

Command producers also record an invocation-local semantic outcome. Expected
update drift or an available CLI upgrade is `attention-required`; an explicit
decline or interactive cancellation is `cancelled`. Failed verification,
partial execution, recovery or cleanup remains `failure`, even if its public
exit is 2 or a later prompt is cancelled. An unclassified nonzero exit stays
`failure`; numeric exit codes and command output are unchanged.

A committed adoption with successful independent readback is `success`.
An adoption preview or a clean recovery rollback is `attention-required`:
neither completes adoption. Failed approval, publication or recovery remains
`failure`.

Explicit local integrations may also observe the schema-2 event through the
optional `CliTelemetryHooks.afterSemanticCommand` hook. It uses the same command
allowlist, disclosure readiness, global opt-outs and assessment/capability
exclusions. Existing `afterCommand(parsed, exitCode, env)` hooks still receive
their original arguments. The default client reports only the semantic event;
it does not also send a schema-1 request. This hook contract does not enroll
projects or create identifiers.

Operator queries must group outcomes by schema until the oldest schema-1 records
have aged past the published 180-day retention window. Combining the two
schemas would falsely treat historical expected nonzero states as semantic
failures.

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
enrollment/reporting prerequisites. The candidate client calls this reader only
for supported project reporting, never to grant project-file or provider authority.

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

## Explicit project consent candidate client

Check `liftoff capabilities --json` in the installed CLI before using these
commands. Installation, initialization, generated README/setup guidance, agent
autonomy, generic `--yes`, a prior anonymous notice, and a copied tracked record
never enroll a developer.

```bash
liftoff telemetry status ./project --json
liftoff telemetry enroll ./project --check --json
liftoff telemetry enroll ./project --approve-plan <full-review-fingerprint> --json
liftoff telemetry report ./project --json
liftoff telemetry disable ./project --check --json
liftoff telemetry disable ./project --approve-plan <full-review-fingerprint> --json
```

Enrollment displays disclosure version 1, purpose, exact fields and exact writes.
It creates a random UUIDv4 only after current approval, outside deterministic
generation, in `.liftoff/telemetry/project.json`. It does not send an event during
enrollment. Bare JSON/non-TTY mutation requests preview only (exit 2); a genuine
terminal can approve the displayed exact plan with default-No consent. Automation
must supply its complete current fingerprint. Status performs no network,
disclosure, receipt, consent or project writes. All telemetry command/help routes
avoid anonymous aggregate recursion.

User-local `config.json` preserves unknown valid fields and adds only
`telemetry.projectConsents` entries: canonical checkout root, project UUID and
disclosure version. Storage uses `XDG_CONFIG_HOME/liftoff`, Windows
`APPDATA/liftoff`, or `~/.config/liftoff`; relative configuration roots and
project-local consent storage are refused. Invalid/read-only configuration or
unsafe aliases block consent/reporting without overwriting the file.
Configuration and project record writes use locking, exact snapshot review,
atomic replacement and readback. They are not a cross-directory atomic
transaction: an interrupted/failed final config write may leave an unenrolled
project record. Inspect status and obtain a fresh review; no event is queued.
Installer ownership changes must leave these preferences untouched, not
reinterpret them as consent; the native installer migration remains unqualified.

One identity represents one validated root/manifest, not its raw path, Git
remote, repository name, machine or device. Commit the approved project record
when intentionally sharing that project's identity. Each clone/worktree needs
its own explicit `telemetry enroll --preserve-identity` review to establish local
consent. A copied record alone cannot opt in another developer or checkout.
For an independent fork/template copy use an explicitly approved
`telemetry enroll --new-identity`; unrelated monorepo roots enroll separately
and obtain different random IDs. Liftoff cannot infer whether a copy is a clone
or an independent project. Moving a checkout preserves its tracked UUID but
invalidates local consent and write-review fingerprints; review the new checkout
with `--preserve-identity`. A telemetry fingerprint cannot select an update,
repair, governance operation or deletion request.

Explicit report returns schema 1 `delivered`, `disabled` or `failed` and whether
a request was attempted. Failed delivery exits 1; disabled/delivered exits 0.
Delivery proves only a successful endpoint response, not durable storage.
If the shared deadline expires after fetch starts, `attempted` remains true:
that request may have been accepted despite the missing response. Collection
exhaustion or other refusal before fetch retains `attempted: false`. Collection
and transport share one deadline, not separate one-second allowances.
Unsupported/missing project metadata or unavailable consent sends nothing.
After an eligible ordinary project command, the candidate client can send one
consented project observation alongside its one anonymous command event. Both
use the parent's single one-second deadline, one request per channel and no
retry/queue. Ordinary output and exit status are unchanged. Assessment (including
live/help), capabilities, repair discovery, telemetry status, generic help and
self-upgrade never collect a project observation.

## Separately approved monthly heartbeat

Project enrollment never installs a schedule or enables a CI exception.
`liftoff telemetry heartbeat enable ./project --repository ./repository --check --json`
currently reports a blocker: no qualified published heartbeat-capable Linux CLI
archive/digest and immutable checkout action are registered. The source producer
foundation is gated by release-owned qualification, which remains undefined;
there is no CLI flag, environment variable or caller-supplied pin override.
The latest release's presence, a syntactically valid URL/digest, a caller flag,
or a test specimen is not artifact qualification. No invented archive URL,
mutable `latest`/tag pin, automatic installation or active cron is installed.
`telemetry report --heartbeat` therefore emits nothing. Ordinary `CI=true`
continues disabling both channels; both global opt-outs always win.

The candidate deterministic workflow contract inventories only selected roots
in `.liftoff/telemetry/heartbeat.json` and exact entries in
`.github/workflows/liftoff-project-heartbeat.yml`. It requires a qualified
runtime-inclusive CLI archive/digest and immutable checkout action, monthly
schedule and contents-read permission. It never scans/enrolls projects, runs
application scripts, upgrades/repairs projects or deploys Azure resources.
Syntax/rendering tests are not real artifact/publication/CI qualification.

The gated producer reviews one explicit canonical project and repository root,
the independently verified GitHub origin and physical Git/repository identity,
current enrollment and external consent/config snapshot, and both exact target
files. Separate approval installs only the reviewed root; stale snapshots,
ambiguous ownership, different tooling and read-only targets fail before writes.
It does not enroll, generate an identity, update another root, upgrade tooling
or execute application code. Candidate-tooling tests exercise pure plans and
disposable filesystem transactions only, not the public release gate.

The future qualified workflow invokes
`liftoff telemetry report ./project --heartbeat --repository ./repository --json`
with the exact selected root and repository. It must validate the current enabled
project record, distinct enabled inventory entry, exact release-owned tooling,
owned monthly workflow/job bytes and independently verified repository binding.
A tracked record or forged CI/workflow environment is not sufficient. This path
reads no local consent/config and writes no notice, consent or event queue; its
separately approved repository inventory is the CI enablement. Both global
opt-outs are rechecked after asynchronous preparation and before transport.
Ordinary `CI=true` paths remain disabled. Collection, proof revalidation and the
single project request share the existing one-second deadline with no retries.

Removing the last entry deletes the two reviewed files only when the workflow
is entirely Liftoff-owned. Custom jobs and bytes are retained; custom content
without remaining jobs requires a separate review rather than an implicit
overwrite or deletion.

For an existing exact inventoried entry,
`liftoff telemetry heartbeat disable ./project --repository ./repository --check --json`
reviews separate repository-level writes. Exact fingerprint/default-No approval
removes only that entry, preserving other roots, custom workflow bytes and LF or
CRLF line endings. Modified/ambiguous owned blocks, identity mismatch, unsafe
paths or changed inputs refuse rather than replace unrelated workflow content.
Local project disablement also prevents future project delivery; removing a
shared repository entry requires the separate repository review. Heartbeat
activation/addition and the valid CI exception remain unqualified gates.

An eventual heartbeat means only that the configured repository reported an
enrolled project. It is not recent developer activity, deployment health,
compliance or proof of ownership. Monthly schedules may be delayed or disabled
by GitHub policy/inactivity; silence is stale/unknown reporting, not abandonment.
Metrics are opted-in distinct projects over retained 30/90/180-day windows and
first-observed projects **within retained data**, not lifetime totals or a census.
Disablement is not deletion; privacy deletion remains operator-reviewed and
requires independent authority, never possession of the public UUID.

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
create telemetry state, or initialize network transport, even with
`telemetry report --heartbeat`. A future qualified explicit heartbeat producer
must still obey both global opt-outs; no such producer is registered today.

## Delivery and failure behavior

The CLI makes at most one request per eligible channel after command completion,
sharing a maximum one-second delivery budget. It does not retry, buffer, read a response body, or
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
both in one invocation. The default CLI supplies one schema-2 command slot and,
only with validated independent project consent, one project slot.

Requested slots return a closed local result: `delivered`, `disabled`, or
`failed`, plus whether transport was attempted and a fixed reason where
applicable. Delivery means a successful endpoint response before the deadline,
not independent proof of durable storage. A timeout cannot establish whether
the remote endpoint accepted the request; it is never retried to resolve that
uncertainty. Ordinary commands discard delivery results and preserve their
own output/exit. Unrequested slots are omitted, and a project-only private
call cannot recursively emit a command aggregate.

The internal `reportCommandEvent` API returns the command-slot result directly.
This gives explicit reporting integrations the same `delivered`,
`disabled`, or `failed` result without invoking the CLI lifecycle again and
therefore without recursively emitting another command aggregate. Repeated
reports using the same delivery object return `duplicate-channel` without
another request. Fixed failure reasons contain no endpoint response or exception
text; missing requested results are errors, never assumed success. The ordinary
CLI intentionally discards delivery results after the shared deadline.

The seam validates exact payload shapes, HTTPS and the 1-KiB body limit, but
syntactically valid project input is **not** consent or release-ownership
evidence. The project reporting caller independently validates those contracts
before supplying an observation. Global opt-outs still win and ordinary
`CI=true` disables both slots, even for a supplied `ci-heartbeat` payload.
The transport alone never creates IDs or consent. The separate public
status/enrollment/disable/report layer supplies those boundaries; qualified
heartbeat activation and its narrow CI exception remain unavailable.

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

## Grafana adoption dashboard (source only)

Reviewed source now lives in `infrastructure/opentofu/telemetry/grafana` and
`infrastructure/opentofu/telemetry/dashboards`; it is **not deployed**. See the
[operator runbook](https://github.com/voyager163/liftoff/tree/develop/infrastructure/opentofu/telemetry#managed-grafana-source-preparation-not-deployed)
in the source repository. Infrastructure is operator-owned, not part of the CLI
package or something normal commands apply.

The authenticated native Grafana view shows approximate opted-in distinct
projects over **30/90/180 days**, first-observed projects **within retained
data**, latest observed CLI/policy/complete registry distributions, CLI versus
heartbeat sources, last-observed data and explicitly configured monthly
expectations. A clone/worktree shares its enrolled ID; independent monorepo
roots differ. `dcount(..., 2)` is approximate (nominal 0.4% standard error).
Source counts overlap; a heartbeat is not a daily active developer, healthy
deployment or compliance proof. The public ingestion endpoint permits forged
events, so these are directional observations, not a census or lifetime total.

Query/permission/table errors stay **unavailable**, never zero projects.
A successful empty query means no retained observations; older records may
have expired. Operator-configured disabled reporting is shown separately from
unknown configuration, never inferred per project from silence. Explicit
monthly status includes an **unconfigured** row for an empty or fully
synthetic-excluded expectation inventory, with zero expected projects rather
than a fabricated healthy heartbeat. Future monitoring starts show **pending**.
The operator configuration is a separate column, not inferred client consent;
query failures remain unavailable even when there are no expectations. Explicit
monthly expectations use **31 days plus 9 days grace (40 days)**, followed by
a 15-minute alert pending period; late/missing observations mean stale/unknown
reporting, not abandonment. Query availability does not establish ingestion
health. Verified ingestion-fault alerting is unavailable without a real
privacy-safe signal; no low daily CLI-volume alert is used.

Schema-2 semantic success/attention-required/cancelled/failure has its own panel.
Schema-1 zero/nonzero history is labeled separately and never reinterpreted.
Operator-registered synthetic UUIDs are excluded from every project query,
including freshness; no extra payload field is added. No embedded secrets,
public sharing, request/IP/console logging or new backend is introduced.

Provider registration, Standard size/region/quota/actual recurring cost,
protected state ownership, real datasource access, project ingestion,
published heartbeat tooling and native UI/live query scenarios remain external
qualification gates. Pausing alerts or rolling back dashboard JSON preserves
workspace/tables, history, command ingress and backend/perimeter; it does not
delete records or stop Managed Grafana service charges. Source tests are not
production deployment or an exercised rollback.
