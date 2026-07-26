## 1. Telemetry Contract and Local State

- [x] 1.1 Define the versioned five-field client event, six-column storage record, canonical command-path allowlist, help normalization, semantic-version validation, and zero/nonzero outcome mapping in explicit typed constants.
- [x] 1.2 Add parity coverage that fails when the CLI and ingestion service command allowlists or event schemas diverge.
- [x] 1.3 Implement cross-platform global config resolution for XDG, Windows AppData, and Unix `.config` paths using `path.join`.
- [x] 1.4 Implement atomic notice-version reads and writes that preserve valid unrelated fields, do not replace invalid JSON, and never create identity or queued-event state.
- [x] 1.5 Add config tests for missing, valid, invalid, read-only, XDG, Windows, macOS/Linux, and concurrent first-run cases.

## 2. CLI Telemetry Lifecycle

- [x] 2.1 Implement telemetry enablement with `LIFTOFF_TELEMETRY=0`, `DO_NOT_TRACK=1`, and `CI=true` precedence and no force-enable path.
- [x] 2.2 Implement the versioned first-run disclosure on stderr before command execution while preserving JSON stdout and suppressing all notice/config work when disabled.
- [x] 2.3 Implement one built-in `fetch` POST after recognized command completion with the exact payload, HTTPS enforcement, a one-second absolute timeout, no retries, no response-body read, and no persistence.
- [x] 2.4 Integrate telemetry at `src/cli.ts` so recognized commands report their original zero/nonzero outcome while parse/runtime failures without a safe command identity remain untracked.
- [x] 2.5 Add CLI tests for top-level, nested, help, success, nonzero, cancellation, JSON, opt-out, CI, network failure, timeout, non-2xx, and unchanged output/exit behavior.
- [x] 2.6 Update package smoke execution and test helpers to opt out deterministically so validation never contacts the production endpoint.

## 3. Gateway Contract and Superseded Function Adapter

- [x] 3.1 Create an independently buildable, locked TypeScript ingestion service under `services/telemetry-ingest`; the initial Azure Functions v4 adapter is retained as superseded implementation history.
- [x] 3.2 Implement an anonymous HTTPS POST handler that enforces content type, a 1 KiB body limit, object shape, exact fields, supported schema/event values, command allowlist, semantic version, and outcome without logging rejected content.
- [x] 3.3 Add server-side `TimeGenerated` and map accepted input to exactly `TimeGenerated`, `EventName`, `SchemaVersion`, `Command`, `CliVersion`, and `Outcome`.
- [x] 3.4 Upload accepted records through the Logs Ingestion API using the assigned managed identity, configured DCE endpoint, DCR immutable ID, and custom stream name.
- [x] 3.5 Configure the initial Function host without Application Insights, request-body logging, or diagnostics that route HTTP access metadata to the product workspace; this adapter will be removed after Container App verification.
- [x] 3.6 Add gateway tests for valid events, every invalid field class, extra properties, arrays, malformed JSON, wrong methods/content types, oversized bodies, ingestion failures, and exact approved records.

## 4. Superseded Flex OpenTofu Infrastructure

- [x] 4.1 Add version-pinned OpenTofu configuration under `infrastructure/opentofu/telemetry` that creates and manages the fixed production resource group `rg-liftoff-prod` with deletion protection, plus the initial Flex Consumption Function App, private storage, and bounded instance scale; these hosting resources are superseded.
- [x] 4.2 Provision a user-assigned managed identity and least-privilege role assignments for identity-based Function storage, deployment-package access, and DCR-scoped Azure Monitor ingestion.
- [x] 4.3 Provision the Log Analytics workspace, `LiftoffCommandEvents_CL` custom table, six Liftoff-defined columns plus Azure system columns, Analytics plan, 180-day analytics/total retention, disabled local authentication, daily ingestion quota, DCE, and DCR projection.
- [x] 4.4 Package the built Function artifact and represent OneDeploy through OpenTofu without committed keys, SAS tokens, Function keys, secret outputs, Bicep, `azd`, Terraform CLI, or ad hoc Azure resource commands; live OneDeploy remained blocked by enforced NSP.
- [x] 4.5 Add explicit outputs for the public HTTPS event endpoint and non-sensitive resource identifiers, plus partial remote-state and rollback guidance that preserves `rg-liftoff-prod`.
- [x] 4.6 Add static infrastructure tests that require the exact `rg-liftoff-prod` name and deletion protection and reject Application Insights settings, HTTP diagnostic routing, secret-bearing outputs, local-auth storage configuration, retention drift, unbounded scale, and non-OpenTofu deployment paths.
- [x] 4.7 Generate the provider lock file and verify `tofu fmt -check`, `tofu init -backend=false`, and `tofu validate` from a clean directory without Azure credentials.

## 5. Documentation and Packaging

- [x] 5.1 Add packaged telemetry documentation covering exact collected/excluded fields, no persistent ID, enabled-by-default disclosure, opt-outs, CI behavior, transient Azure source-address handling, regional storage, failure isolation, and 180-day retention.
- [x] 5.2 Link telemetry guidance from the README and safety documentation without exceeding the README size contract or implying that Azure never processes a source network address.
- [x] 5.3 Document operator-only OpenTofu review, build, plan, apply, verification, emergency disablement, rollback, remote state, RBAC, quota, retention, and `rg-liftoff-prod` ownership and preservation procedures.
- [x] 5.4 Update documentation and package-smoke tests so `docs/telemetry.md` is required, linked safely, and included in the npm package while service and infrastructure sources remain excluded.

## 6. Superseded Flex Deployment Investigation

- [x] 6.1 Extend CI to install, build, and test the ingestion service and to run telemetry client/config tests on Windows, macOS, and Linux.
- [x] 6.2 Add Linux CI coverage for OpenTofu formatting, backend-free initialization, validation, and static privacy checks.
- [x] 6.3 Run the targeted telemetry, gateway, documentation, package-smoke, build, and OpenTofu checks, then run the existing repository check to catch integration regressions.
- [x] 6.4 Extend the OpenTofu bootstrap to create one Network Security Perimeter, profile, approved-subscription rule, ignored operator-CIDR rules, regional `AppService.KoreaCentral` OneDeploy rule, and enforced state-storage association.
- [x] 6.5 Extend production OpenTofu to resolve the bootstrap-owned profile and associate Function storage in `Enforced` mode while preserving managed identity, shared-key disablement, and resource-scoped RBAC.
- [x] 6.6 Add ignored operator-CIDR deployment inputs, CIDR validation, static perimeter/privacy tests, operator-IP recovery guidance, and explicit standard GitHub-hosted-runner static-only guidance.
- [x] 6.7 Reconcile the bootstrap and production associations, verify both storage accounts report `SecuredByPerimeter`, apply the regional App Service CIDRs, and record that OneDeploy still receives an NSP denial.
- [x] 6.8 Rerun root/gateway/package/OpenSpec/OpenTofu validation and record policy-compliant deployment proof.
- [x] 6.9 Record the decision to supersede Flex Consumption and OneDeploy after the reviewed regional exception failed, without activating a production telemetry endpoint.

## 7. Plain Container Gateway

- [x] 7.1 Replace the Azure Functions registration layer with a plain Node.js HTTP server that exposes only `/api/events`, reuses the exact validator and record mapper, and counts request bytes before JSON parsing.
- [x] 7.2 Remove the `@azure/functions` dependency and Function host configuration while retaining Azure Identity and Azure Monitor ingestion dependencies.
- [x] 7.3 Add TCP startup, readiness, and liveness behavior, graceful shutdown, a fixed nonprivileged port, and no public health or diagnostics route.
- [x] 7.4 Add a production Dockerfile based on the reviewed Node.js 22 Functions-independent runtime image pinned by digest, install from the lockfile, copy only runtime output, and run as a non-root user.
- [x] 7.5 Update build and package scripts so local tests and the container use the same compiled server artifact without embedding credentials, telemetry data, or mutable build metadata.
- [x] 7.6 Extend gateway tests through the real Node HTTP boundary for exact valid records, streaming oversize rejection, malformed input, unsupported methods/content types, ingestion failures, and absence of request logging.
- [x] 7.7 Add container smoke tests for the expected port and route, non-root execution, readiness, graceful shutdown, and bounded request handling.

## 8. ACR and Container Apps OpenTofu

- [x] 8.1 Add a validated full 40-character public source revision input and derive one immutable image name/tag from that revision without accepting branches, `latest`, or date-only tags.
- [x] 8.2 Add an ACR Basic registry in `rg-liftoff-prod` with administrator credentials and anonymous pull disabled and no secret-bearing outputs.
- [x] 8.3 Add an OpenTofu-managed ACR task and immediate run that build from the public Liftoff repository at the pinned revision, use the reviewed Dockerfile, push the immutable image, and block apply on build failure.
- [ ] 8.4 Reuse the gateway user-assigned identity, grant only registry-scoped `AcrPull` and DCR-scoped ingestion access, and remove storage roles from the final architecture.
- [x] 8.5 Add a Consumption Container Apps environment in `rg-liftoff-prod` with persistent platform log storage disabled and no diagnostic setting that routes ingress or console logs.
- [x] 8.6 Add the plain Container App with HTTPS-only external ingress, single-revision mode, 0.25 vCPU, 0.5 GiB, one minimum replica, five maximum replicas, HTTP autoscaling, TCP probes, and the exact immutable ACR image.
- [x] 8.7 Ensure the Container App revision depends on successful image build and propagated `AcrPull`, supplies only the DCE/DCR/stream and identity settings, and contains no registry, storage, or ingestion credential.
- [x] 8.8 Replace Function-specific endpoint outputs with the fully qualified Container App `/api/events` URL while keeping all outputs non-sensitive.
- [x] 8.9 Add static tests that reject Functions/OneDeploy in the target architecture, ACR admin or anonymous access, mutable image tags, product storage, persistent Container Apps logs, zero minimum replicas, more than five replicas, oversized compute, broad RBAC, and non-OpenTofu deployment paths.
- [x] 8.10 Preserve the currently deployed Function resources in the first migration plan so Container App creation can be reviewed and applied with zero destroys.

## 9. Documentation, Validation, and Non-Destructive Rollout

- [x] 9.1 Revise public and operator documentation for the plain Container App, warm-replica cost trade-off, ACR image privacy boundary, immutable revision input, managed-identity pull, disabled persistent logs, state-only NSP, and staged migration.
- [x] 9.2 Update CI to build and smoke-test the container and run backend-free ACR/Container Apps OpenTofu validation while standard GitHub-hosted runners remain unable to plan or apply production.
- [x] 9.3 Run targeted gateway/container/infrastructure/documentation/package checks, the full repository check, strict OpenSpec validation, OpenTofu formatting/init/validation, and diff hygiene.
- [x] 9.4 Re-run Azure preparation and validation for the revised architecture, confirm regional availability and quotas, and record current ACR Basic plus one-warm-replica cost evidence.
- [x] 9.5 Generate a fresh production plan from remote state and assert it creates the ACR, build task/run, Container Apps environment/app, and roles with no changes or destroys to legacy resources or retained telemetry data.
- [x] 9.6 Apply only the validated non-destructive plan from the admitted operator network and verify every new production resource is in `rg-liftoff-prod`.
- [x] 9.7 Verify the registry has admin and anonymous access disabled, the image tag equals the pinned commit, the Container App uses managed-identity pull, and exactly one idle replica remains ready.
- [x] 9.8 Verify `/api/events` stays within the one-second client budget, accepts a synthetic allowlisted event, and rejects wrong-method, malformed, extra-field, and oversized requests.
- [x] 9.9 Query the custom table and verify the six approved Liftoff-defined columns plus only expected Azure system columns, server time, and no request, IP, geolocation, Container Apps platform, console, or Application Insights records.
- [x] 9.10 Set the reviewed Container App endpoint constant, rerun offline/failure/package tests, and confirm a release cannot enable telemetry before the live privacy gate passes.

## 10. Legacy Cleanup and Release Gate

- [x] 10.1 Remove the Azure Functions adapter, Function package scripts, and superseded Function-specific documentation only after the Container App endpoint and data boundary are verified.
- [x] 10.2 Generate a separate destructive production plan limited to the Function App, FC1 plan, OneDeploy action, package blob/container, product storage account and association, and obsolete storage roles.
- [ ] 10.3 Obtain explicit approval for the reviewed destructive plan before applying it; preserve `rg-liftoff-prod`, remote state, workspace, custom table, DCE, DCR, gateway identity, accepted events, ACR, and Container App.
- [ ] 10.4 Apply the approved legacy cleanup and verify the production state contains no Function, OneDeploy, package-storage, or Azure Files resources.
- [ ] 10.5 Remove the approved-subscription and regional OneDeploy rules from bootstrap OpenTofu through a separate reviewed plan while preserving the perimeter, profile, operator CIDRs, state account, enforced association, shared-key disablement, and data role.
- [ ] 10.6 Regenerate both OpenTofu plans and confirm they are empty, state storage remains `SecuredByPerimeter`, and no operator CIDR appears in tracked files, outputs, logs, or review evidence.
- [ ] 10.7 Review the final diff for payload expansion, identifiers, credentials, secret state/output, operator CIDR exposure, mutable images, registry admin access, persistent request logs, incorrect resource-group placement, missing deletion protection, non-OpenTofu Azure paths, and documentation accuracy.
- [ ] 10.8 Run final root, gateway, container, package, OpenSpec, and OpenTofu validation and record the fully qualified production endpoint and release gate outcome.
