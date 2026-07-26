## Context

Liftoff is a short-lived TypeScript CLI with one centralized `runCommand` boundary and no global user configuration or telemetry today. The requested product signal is intentionally narrow: aggregate command popularity and zero/nonzero completion, not unique users, installations, diagnostics, or performance.

OpenSpec provides useful prior art: one command event, first-run disclosure, `DO_NOT_TRACK` and product-specific opt-out variables, CI disablement, bounded immediate delivery, and telemetry failure isolation. Liftoff will not copy OpenSpec's persistent UUID or PostHog path. A persistent identifier is unnecessary for the selected metrics, and a first-party Azure boundary provides stronger control over accepted fields, retention, and access.

The repository already treats OpenTofu as the Azure infrastructure contract. Telemetry service infrastructure is operator-owned repository infrastructure, not generated customer-project infrastructure, and Liftoff must never authenticate to or deploy Azure resources during normal CLI use.

```text
recognized CLI command
        |
        | notice before first eligible command
        v
runCommand() -> exit code -> strict five-field event
        |                         |
        |                         | HTTPS, one attempt, <= 1 second
        v                         v
normal CLI output       warm Container App schema gate
                                  |
                                  | managed identity
                                  v
                         Azure Monitor DCR
                                  |
                                  v
                    LiftoffCommandEvents_CL
                       (180-day retention)

pinned public Git revision -> ACR Task -> private immutable image
                                              |
                                              | managed-identity pull
                                              v
                                     one warm Container App replica
```

## Goals / Non-Goals

**Goals:**

- Measure aggregate use of recognized command paths and their zero/nonzero outcomes.
- Disclose telemetry before the first event and provide immediate, documented opt-out controls.
- Make the event contract auditable and incapable of carrying project or installation identity.
- Keep JSON stdout, command exit behavior, and offline use unchanged.
- Validate the payload again at a first-party Azure Container App gateway before storage.
- Provision the Azure service and build/deploy its immutable image only through reviewed OpenTofu.
- Keep one small gateway replica continuously available so a scale-to-zero cold start cannot consume the client's one-second delivery budget.
- Keep remote state under an enforced Azure Network Security Perimeter while eliminating production host and deployment storage.
- Keep product events for 180 days with Azure RBAC controlling query access.

**Non-Goals:**

- DAU, WAU, MAU, funnels, retention cohorts, or any cross-session correlation.
- Error messages, stack traces, timing, operating system, Node.js version, cloud choice, workload, flags, paths, project names, or generated content.
- Automatic instrumentation of either the CLI or ingestion container.
- A user-facing telemetry management command; environment variables are sufficient for the first version.
- Guaranteed delivery, offline buffering, retries, or telemetry health messages.
- Authenticating individual public CLI installations. A distributed client cannot safely retain a shared ingestion secret.
- Applying Azure infrastructure from the Liftoff CLI.
- Running production plan or apply jobs on standard GitHub-hosted runners, whose dynamic networks cannot be admitted to the perimeter.

## Decisions

### Adopt OpenSpec's minimal lifecycle but remove persistent identity

The client event is exactly:

```json
{
  "schemaVersion": 1,
  "event": "command_executed",
  "command": "infra:plan",
  "cliVersion": "0.6.1",
  "outcome": "success"
}
```

`outcome` is `success` only for exit code `0`; every nonzero exit is `failure`. No client timestamp is sent. This makes the interpretation simple and prevents clock or locale data from entering the payload. It also means expected nonzero states, such as update drift, appear in the nonzero aggregate; documentation and queries must describe the field as an exit-status class rather than a diagnostic root cause.

The CLI derives `command` only from parsed command definitions. A nested command uses `command:subcommand`; help requests normalize to `help` so they do not inflate the target command. Invocations rejected before a recognized command is parsed are not tracked. The ingestion gateway keeps a matching explicit allowlist, so an accidental raw argument can never become a stored command value.

Unlike OpenSpec, Liftoff does not create an anonymous UUID. This deliberately gives up active-installation and retention metrics in exchange for eliminating durable user correlation.

### Integrate around the existing CLI boundary

`src/cli.ts` will:

1. validate the Node.js runtime and parse a recognized command;
2. show the telemetry notice when required;
3. run the existing command and preserve its exit code;
4. submit one event after completion; and
5. set the original exit code regardless of telemetry behavior.

Tracking after `runCommand` is required to include the outcome. The entrypoint uses a narrow `try/finally`-style lifecycle rather than process termination inside telemetry code. Runtime and parse failures that occur before a safe command identity exists remain untracked.

The first-run notice is written to stderr, not stdout. This preserves machine-readable stdout for `--json` commands. The notice is informational and non-blocking because the selected consent model is enabled by default.

### Store only versioned disclosure state

The global file stores only a numeric telemetry notice version:

```json
{
  "telemetry": {
    "noticeVersion": 1
  }
}
```

Paths follow platform conventions:

- `$XDG_CONFIG_HOME/liftoff/config.json` when explicitly set;
- `%APPDATA%\liftoff\config.json` on Windows; and
- `~/.config/liftoff/config.json` on macOS and Linux.

All paths use `path.join`. Writes use same-directory temporary-file replacement and preserve unrelated future fields. Missing, unreadable, read-only, or invalid configuration never blocks a command. Invalid existing JSON is not overwritten; the notice is shown again and the event may proceed only after that disclosure. Opted-out and CI runs neither read nor create notice state.

The numeric notice version allows a future material expansion of collection to trigger a new disclosure. It is not an installation identifier.

### Enable by default with precedence-based disablement

Telemetry is disabled when any of these conditions is true:

- `LIFTOFF_TELEMETRY=0`;
- `DO_NOT_TRACK=1`; or
- `CI=true`.

CI disablement takes precedence over any future explicit enablement. The first implementation has no force-enable variable. Disabled runs do not show a notice, create config, or initialize transport.

### Use built-in fetch with a hard delivery budget

The CLI uses Node.js built-in `fetch` rather than an analytics SDK. This avoids SDK-added context and keeps the serialized body fully visible in Liftoff source.

The client performs one HTTPS POST with `Content-Type: application/json`, a one-second absolute timeout, no retry, no response-body read, no queue, and no disk persistence. Network errors, timeouts, DNS failures, non-2xx responses, and endpoint absence are contained inside the telemetry module and cannot alter output or exit status.

The production endpoint is a reviewed source constant populated from the OpenTofu output only after the Azure service is deployed. Tests inject an endpoint and fetch implementation; there is no general runtime endpoint override. A release must not enable the client until the production endpoint exists.

### Use an anonymous plain Node.js Container App as a strict schema gate

The public endpoint must be anonymous because any key embedded in an open-source CLI is public and provides no meaningful authentication. A plain Node.js HTTP server exposes only the existing `/api/events` route through external Container Apps ingress. It accepts only HTTPS POST requests with JSON no larger than 1 KiB. The server counts bytes while streaming the body so an oversized request is rejected before unbounded buffering. It rejects arrays, missing or additional properties, unsupported schema versions, unknown commands, invalid semantic versions, and unknown outcomes before calling Azure Monitor.

The existing validation and record-mapping logic remains framework-independent. The Azure Functions registration layer and `@azure/functions` dependency are removed; the server adds `TimeGenerated` from server time and uploads only the six approved Liftoff-defined columns. It never logs request bodies, headers, query strings, validation details, or ingestion failures. TCP startup, readiness, and liveness probes verify only that the process accepts connections and do not add a public health route.

The Container App uses the Consumption workload profile with 0.25 vCPU and 0.5 GiB per replica, `min_replicas = 1`, `max_replicas = 5`, single-revision mode, and an HTTP concurrency rule. One minimum replica prevents scale-to-zero cold starts; the maximum bounds abuse cost. The environment's log destination is `none`, no diagnostic setting persists ingress or console logs, and Application Insights remains absent. The public endpoint can still be spammed with syntactically valid events, so telemetry is directional product evidence rather than an auditable source of truth. Strict validation, bounded replicas, Azure budget alerts, and the Log Analytics daily quota bound cost; no IP-based rate limiter is added because that would require additional source-address processing or storage.

### Store product events directly in Log Analytics, not Application Insights

Application Insights temporarily processes source IP for geolocation by default, while automatic platform or application logging could persist request metadata. The ingestion container therefore has no Application Insights connection string or instrumentation key, writes no request logs, uses a Container Apps environment whose log destination is `none`, and has no diagnostic setting that routes ingress or console logs to the product workspace.

The Container App uses a user-assigned managed identity with the narrow Azure Monitor ingestion role on the data collection rule. The Logs Ingestion API writes through a data collection endpoint and DCR to `LiftoffCommandEvents_CL`. A DCR projection is a second privacy boundary: Liftoff defines only `TimeGenerated`, `EventName`, `SchemaVersion`, `Command`, `CliVersion`, and `Outcome`, even if upstream code regresses. Azure Monitor adds unavoidable workspace system columns such as tenant, type, billing, and item metadata after the DCR transformation; these are platform metadata, not additional Liftoff event fields.

Azure necessarily receives a source network address while routing the HTTPS request. Liftoff does not copy it into the event, derive location from it, forward it to the DCR, or configure a product log that persists it. Public documentation must describe this transient network handling rather than claim that Azure never observes an IP address.

The workspace and custom table use the Analytics plan with 180-day analytics and total retention, no long-term retention beyond that period, local authentication disabled, and Entra/RBAC query access. OpenTofu creates and manages the fixed production resource group `rg-liftoff-prod`; the registry, ACR task, Container Apps environment and app, DCE, DCR, workspace, and identity are placed in that group and created in one operator-selected Azure region where the resource type permits.

### Make OpenTofu the only Azure deployment path

Repository-owned configuration under `infrastructure/opentofu/telemetry` provisions:

- the fixed production resource group `rg-liftoff-prod`, protected from accidental destruction, and a configurable Azure resource region;
- an Azure Container Registry Basic registry with administrator credentials and anonymous pull disabled;
- an ACR build task and immediate task run whose public Git context is pinned to a validated 40-character commit SHA and whose output image uses that immutable SHA as its tag;
- a Consumption Container Apps environment with persistent platform logging disabled;
- a plain Node.js Container App with one warm 0.25-vCPU/0.5-GiB replica, a five-replica ceiling, HTTPS-only external ingress, and the exact immutable image tag;
- a user-assigned managed identity with only `AcrPull` on the registry and the ingestion role on the DCR;
- a Log Analytics workspace and explicit custom table schema;
- a data collection endpoint and data collection rule;
- budget or ingestion-cap controls; and
- the container image build and Container App revision dependency chain.

The public repository is the ACR task's source context, so no GitHub token is required. Production input must identify a commit that is already reachable from the public repository; uncommitted or unpushed local code cannot become a production image. The Docker build uses a reviewed Node.js 22 runtime base pinned by digest, installs production dependencies from the lockfile, runs as a non-root user, and contains no credentials or telemetry data. The run-now resource waits for the ACR task to succeed before the Container App revision can reference the image.

The registry's public endpoint remains network-reachable because ACR Basic does not support Private Link, but it is not public data: anonymous pull and administrator credentials are disabled, the image contains only already-public source/build output, and the Container App must authenticate with its user-assigned identity and resource-scoped `AcrPull` role. No registry password, storage key, SAS token, Azure Monitor credential, or endpoint key is committed, stored in application settings, or exposed as an output. Moving the registry to ACR Premium and Private Link would be a separate cost and networking change.

Provider versions and checksums are pinned, remote state is required for real environments, and all Azure provisioning, image build, and revision deployment actions are represented by `tofu`. Bicep, Terraform CLI, `azd`, Azure CLI deployment commands, and out-of-band Docker pushes are not alternative production paths. Normal `liftoff` commands neither read this state nor invoke OpenTofu.

### Keep only OpenTofu state storage behind the enforced perimeter

The inherited Azure policy disables ordinary public network access on Storage accounts. The bootstrap state account therefore remains associated with the existing Azure Network Security Perimeter profile in `Enforced` mode.

The OpenTofu bootstrap root owns:

- the perimeter and profile;
- one or more explicit inbound operator IPv4 `/32` CIDRs supplied through ignored local variables;
- the protected state storage account and its `Enforced` profile association; and
- the deploying principal's storage data role.

The Container App has no Function host storage, deployment blob, Azure Files share, or other production storage account. The production root therefore has no NSP association and needs no subscription-wide or App Service deployment-worker exception. The existing production storage association, approved-subscription rule, and regional OneDeploy CIDR rule are removed only after the Container App passes live verification. State storage continues to require both an approved operator CIDR and Entra/RBAC authorization; network admission alone grants no data access.

Operator CIDRs are never committed to the public repository, embedded in CLI telemetry, or emitted as public outputs. If the operator's public IP changes, the operator first updates the ignored bootstrap variables and applies that control-plane change; only after the perimeter rule is active may the OpenTofu backend or package data plane be accessed.

Standard GitHub-hosted runners continue to run build, container, test, formatting, and backend-free validation only. ACR builds pull the committed public source directly and don't require a runner to enter the perimeter. Hosted runners do not plan or apply production because their dynamic addresses are not added to state-perimeter rules. Production operations run from an explicitly allowed operator network; migrating later to a private hosted runner requires a separate reviewed change.

### Test privacy as a contract

CLI tests inspect the exact serialized body, opt-out precedence, notice ordering and persistence, cross-platform config paths, timeout behavior, JSON stdout integrity, and unchanged exit codes. Gateway tests submit valid, extra-field, oversized, malformed, and unknown-command payloads to the real Node HTTP boundary and assert the exact record passed to a mocked Logs Ingestion client. Container tests verify non-root execution, the expected port and route, bounded body streaming, and graceful shutdown.

Infrastructure validation runs `tofu fmt -check`, `tofu init -backend=false`, and `tofu validate`. Static tests assert that Application Insights settings, persistent Container Apps logs, registry administrator credentials, anonymous pull, product storage, secret outputs, mutable image tags, zero minimum replicas, unbounded scale, and non-OpenTofu deployment commands are absent.

## Risks / Trade-offs

- **Aggregate events cannot measure unique adoption** -> Accept this explicitly; do not introduce an identifier later without a new proposal and disclosure version.
- **A public endpoint can receive forged valid events** -> Treat trends as directional, enforce exact schemas and bounded scaling, and monitor quotas and spend.
- **A one-second post-command request adds exit latency** -> Keep a hard timeout, no retries, and measure only through controlled tests; reduce the budget later if needed.
- **Expected nonzero command states appear as failures** -> Name and document the field as zero/nonzero outcome semantics in operator queries.
- **First-run notice state can race across concurrent processes** -> Use atomic replacement; duplicate notices are acceptable and safer than suppressing disclosure.
- **Azure networking transiently handles source IP** -> Do not persist or derive from it, avoid Application Insights request telemetry, and document the boundary precisely.
- **Telemetry endpoint outage loses events** -> Prefer loss over queues, retries, or user-visible failures.
- **OpenTofu state can expose infrastructure metadata** -> Use access-controlled remote state, managed identity, sensitive outputs, and no embedded credentials.
- **The operator public IP can change and lock out the backend** -> Keep the CIDR in ignored bootstrap inputs, document the control-plane recovery sequence, and retain protected bootstrap state for rule updates.
- **A zero-replica gateway could miss requests during cold start** -> Keep exactly one minimum replica and verify the live endpoint stays within the client's one-second budget.
- **A warm replica adds idle cost** -> Use the smallest Consumption allocation; current Korea Central retail rates put the post-free-grant idle compute near US$4.29 per 730-hour month, subject to subscription-wide grant usage and price changes.
- **ACR Basic has a public data-plane endpoint** -> Store only already-public build output, disable anonymous/admin access, require Entra `AcrPull`, and never send telemetry events or credentials to the registry.
- **A public Git source could move after review** -> Require a full commit SHA reachable from the public repository, tag the image with that SHA, and prohibit branch, `latest`, or date-only production tags.
- **Container base images require patching** -> Pin a reviewed digest for reproducibility and regularly update that digest through a tested change.
- **Disabling persistent platform logs reduces diagnosis data** -> Prefer privacy; use control-plane health and short-lived live log streaming without recording request content when troubleshooting.
- **Standard hosted CI cannot enter the perimeter** -> Restrict CI to static validation and require an explicitly allowed operator network for production plan/apply.
- **Destroying a managed production resource group can remove unrelated resources** -> Keep `rg-liftoff-prod` under explicit OpenTofu ownership, add deletion protection, and perform rollback by disabling or removing telemetry resources without destroying the group.
- **Removing the partially deployed Function resources is destructive** -> Create and verify the Container App first, generate a separate destruction plan, obtain explicit approval, and preserve `rg-liftoff-prod`, remote state, and accepted event data.
- **Six-month retention increases privacy and cost exposure** -> Store only non-identifying aggregates, prohibit long-term retention, enforce 180 days in code, and require a future change to extend it.

## Migration Plan

1. Convert the gateway registration layer to a plain Node.js HTTP server, add the reviewed container build, and validate exact contract, streaming-size, non-root, and shutdown behavior with client delivery still disabled.
2. Extend production OpenTofu alongside the existing Function resources to create ACR Basic, the commit-pinned ACR task/run, the no-log Container Apps environment, managed-identity roles, and the one-warm-replica Container App.
3. From the admitted operator network, review and apply a non-destructive plan that builds the immutable image and creates the Container App without removing the Function, OneDeploy resources, product storage, or its perimeter association.
4. Verify the Container App remains ready, responds within the one-second client budget, rejects malformed and oversized input, and accepts a synthetic allowlisted event.
5. Verify the six approved Liftoff-defined columns reach the custom table alongside only expected Azure system columns and that no request, IP, geolocation, Container Apps platform, console, or Application Insights records are persisted.
6. Set the reviewed Container App endpoint constant, run CLI contract and package tests, and publish the telemetry-enabled release documentation.
7. Remove the legacy Function, FC1 plan, OneDeploy action, package blob/container, product storage account and association, approved-subscription rule, and regional OneDeploy rule only through a separately generated destructive OpenTofu plan with explicit approval. Preserve `rg-liftoff-prod`, the Log Analytics data path, the state account, perimeter, profile, and operator rules.
8. Reconcile state and confirm the final plan is empty, the registry permits only Entra-authenticated pulls, one gateway replica remains available, and budget/retention controls remain active.

For emergency rollback, change the immutable image SHA to the last verified image through OpenTofu or disable external ingress; released clients will fail silently if the endpoint is disabled. Follow with a patch release that disables client delivery when needed. Preserve or remove stored events according to the 180-day policy and the reviewed OpenTofu plan, but do not destroy `rg-liftoff-prod`.

## Open Questions

None. Region, globally unique resource suffix, pinned public source revision, and operator CIDRs remain deployment inputs rather than product behavior; `rg-liftoff-prod` is fixed and OpenTofu-managed.
