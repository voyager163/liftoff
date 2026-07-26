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
  `https://github.com/voyager163/liftoff.git#<source_revision>`, immutable image
  tag, successful run-now build, and reviewed digest-pinned Dockerfile.
- The user-assigned identity with registry-scoped `AcrPull` and DCR-scoped
  `Monitoring Metrics Publisher`.
- The Container Apps environment with persistent platform logs disabled.
- The Container App's HTTPS-only ingress, single revision, 0.25 vCPU, 0.5 GiB,
  one minimum replica, five maximum replicas, HTTP scaling, and TCP probes.
- The six-column `LiftoffCommandEvents_CL` table and 180-day retention.
- The Log Analytics daily quota and absence of Application Insights, ingress
  diagnostics, registry credentials, storage credentials, and secret outputs.
- The migration guards that freeze the legacy package blob and keep OneDeploy
  disabled until the superseded Function resources are separately removed.

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

For the first migration apply, inspect the saved plan and require zero destroys.
It may create the ACR, task/run, `AcrPull` role, Container Apps environment, and
Container App while preserving the existing Function, plan, package storage,
and perimeter association. Do not combine legacy cleanup with this rollout.

## Verification

Before compiling the endpoint into a Liftoff release:

1. Confirm ACR administrator and anonymous access are disabled, the image tag
   equals `source_revision`, and the Container App pulls with managed identity.
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

## Staged legacy cleanup

Only after live endpoint and data-boundary verification, generate a separate
plan that removes the Function App, FC1 plan, OneDeploy action, package
blob/container, product storage account and association, and obsolete storage
roles. A destructive apply requires explicit approval. Preserve
`rg-liftoff-prod`, remote state, the workspace/table, DCE/DCR, accepted events,
ACR, Container App, state perimeter, and operator rules.

After production cleanup, separately reconcile the bootstrap to remove the
approved-subscription and regional OneDeploy rules. The state account remains
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
