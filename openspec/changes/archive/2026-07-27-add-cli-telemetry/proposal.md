## Why

Liftoff has no aggregate visibility into which CLI commands are useful or whether they complete successfully. A minimal, first-party telemetry path can answer those product questions without collecting installation identity, command arguments, project data, or diagnostics.

## What Changes

- Add enabled-by-default CLI telemetry with a one-time disclosure shown before the first event and opt-out through `LIFTOFF_TELEMETRY=0` or `DO_NOT_TRACK=1`.
- Disable telemetry automatically in CI and ensure telemetry failures, timeouts, or unavailable local config never change command output or exit behavior.
- Emit only a versioned `command_executed` event containing an allowlisted command path, Liftoff version, and success/failure outcome. Do not collect a persistent identifier, arguments, flags, paths, project names, manifest contents, errors, timing, host details, or source IP.
- Add a strict-schema Node.js HTTP ingestion gateway in Azure Container Apps that discards request metadata and writes only approved event columns to a custom Log Analytics table through managed identity and an Azure Monitor data collection rule.
- Provision the telemetry Azure resources, private container registry, immutable container image, and Container App revision through reviewed OpenTofu configuration only, with 180-day retention and no Application Insights or HTTP access-log auto-instrumentation.
- Run the gateway on the Container Apps Consumption plan with one continuously available 0.25-vCPU/0.5-GiB replica, a five-replica ceiling, and HTTP autoscaling so scale-to-zero cold starts cannot consume the client's one-second delivery budget.
- Build the image from a pinned public Git revision using an OpenTofu-triggered Azure Container Registry task. Keep the registry private with anonymous pull and administrator credentials disabled, and authorize image pulls only through the gateway's managed identity and resource-scoped `AcrPull` role.
- Keep OpenTofu state storage in the enforced Azure Network Security Perimeter with explicit operator `/32` CIDRs. The Container App needs no Function host or deployment storage, so remove the production storage association and regional OneDeploy network exception.
- Keep standard GitHub-hosted runners limited to static validation because they cannot enter the perimeter; production plan and apply operations run only from an explicitly allowed operator network.
- Document collection, transient network handling, retention, opt-out controls, and the absence of user or installation tracking.
- Add unit, integration, infrastructure, and documentation coverage for privacy boundaries and failure isolation.
- **BREAKING (infrastructure only):** Replace the partially deployed Flex Consumption Function App, FC1 plan, OneDeploy action, and product storage account after the Container App replacement is validated.

## Capabilities

### New Capabilities

- `liftoff-cli-telemetry`: Privacy-preserving command telemetry, disclosure and opt-out behavior, the Azure ingestion contract, retention, and OpenTofu-managed service infrastructure.

### Modified Capabilities

- `liftoff-user-documentation`: Add public, packaged guidance that discloses telemetry behavior, data boundaries, retention, and opt-out controls.

## Impact

- Affected CLI surfaces include `src/cli.ts`, a new telemetry module and global notice-state storage, and command-entry integration.
- A new containerized TypeScript HTTP service and OpenTofu deployment root will be added to the public repository.
- Production Azure resources are deployed into the fixed resource group `rg-liftoff-prod` and include an Azure Container Registry, ACR build task, Container Apps environment and app, managed identity and RBAC, a Log Analytics workspace and custom table, and an Azure Monitor data collection endpoint/rule.
- The protected OpenTofu bootstrap owns the Network Security Perimeter, profile, operator access rules, state-storage association, and remote-state boundary. Production telemetry has no storage account or perimeter association.
- The CLI uses the Node.js built-in `fetch`; Azure SDK dependencies remain isolated to the ingestion service.
- Documentation, CI, package metadata or lockfiles, and tests will change. Normal non-CI CLI execution gains one bounded outbound request unless the user opts out.
