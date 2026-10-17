# Azure deployment

Azure infrastructure is generated for GenAI and API workloads that select the
available Azure provider. The former Power Apps workload is retired rather than
offered as an alternative hosting path.

Liftoff generates infrastructure code but does not authenticate, plan, or apply
it. Review all files and use your organization's delivery controls.

## OpenTofu layout

New API and GenAI projects share application resources through one module, with
an independent OpenTofu root for each selected environment:

```text
infrastructure/opentofu/azure/
|-- modules/application/
`-- environments/
    |-- dev/       # only when selected; dev.tfvars and its own backend/lock
    |-- staging/   # only when selected; staging.tfvars and its own backend/lock
    `-- prod/      # only when selected; prod.tfvars and its own backend/lock
```

`liftoff infra` prints the applicable OpenTofu commands; it does not execute
them. For a project that selected prod:

```bash
liftoff infra init --env prod
liftoff infra plan --env prod
liftoff infra apply --env prod
liftoff infra output --env prod
```

All four commands select the same prod root. Plan/apply use `prod.tfvars` inside
that root; they do not switch variable files against one shared state address.
Operational `init` initializes the selected configured backend. Only local
baseline validation uses `init -backend=false`.

Each root has independent local state. Remote examples use distinct
project-and-environment blob keys. The default declaration is `backend.local.tf`
with `state/<env>.tfstate`; the example is `backend.remote.example.tf`.
Each root also contains `versions.tf`, `providers.tf`, `variables.tf`, `main.tf`,
`outputs.tf`, `.terraform.lock.hcl`, and its named `<env>.tfvars`.
Replace the local backend declaration when
adopting a remote backend; do not configure two backends in one root. Review the
canonical policy's private access, encryption, locking, and ZRS requirements,
not an illustrative public-storage default. See Microsoft's
[state storage guidance](https://learn.microsoft.com/en-us/azure/developer/terraform/store-state-in-azure-storage).

Existing shared-state or unknown layouts are a **migration-required boundary**.
Update may still maintain safe core files, but adding an environment cannot
rewrite a shared module, move state, or create a root pointing to missing module
files. Force cannot bypass this gate. Helpers do not imply that updating the
CLI or generated context has migrated project-owned infrastructure.

## Explicit flat-root identity retirement

New 0.11.0 scaffolds retire exactly these eight logical identities, whose
historical files are relative to `infrastructure/opentofu/azure/`:

| Retired logical name | Historical file |
| --- | --- |
| `opentofu-versions` | `versions.tf` |
| `opentofu-provider-lock` | `.terraform.lock.hcl` |
| `opentofu-providers` | `providers.tf` |
| `opentofu-variables` | `variables.tf` |
| `opentofu-main` | `main.tf` |
| `opentofu-outputs` | `outputs.tf` |
| `opentofu-local-state` | `backend.local.tf` |
| `opentofu-remote-state-example` | `backend.remote.example.tf` |

Replacement declarations are
`opentofu-application-{versions,variables,main,outputs}` in the shared module
(project lifecycle, `base` provisioning group), and
`opentofu-<env>-{versions,provider-lock,providers,variables,main,outputs,local-state,remote-state-example,tfvars}`
in each selected root (`environment:<env>` group). Expansion is finite: only
`dev`, `staging`, and `prod`, not wildcard ownership.

`opentofu-readme` and `opentofu-<env>-tfvars` retain their logical names.
Old tfvars paths were `environments/<env>.tfvars`; new ones are
`environments/<env>/<env>.tfvars`. Existing manifests retain their old records,
paths, and generation hashes. Update, force, helpers, and assessment do not
delete or retarget that provenance, move state, or convert old files.

This is a narrow exception to append-only naming, not permission for other
renames. Independent-layout recognition requires explicit shared-module and
environment-root provenance plus safe existing shared-module files. New-looking
directories or a core-context update cannot substitute for those records.

## Collision-resistant resource names

Resource groups, managed identities, Container Apps environments/applications,
and globally scoped services include a stable digest of the full project
identity and environment, not only a truncated display prefix.

Each environment tfvars file has a deterministic 12-character lowercase
alphanumeric `resource_suffix` for globally scoped Azure names.

If Azure reports a collision, replace that environment's suffix with another
unique value matching:

```text
^[a-z0-9]{12}$
```

Generated validation rejects an invalid override. The override is not the sole
collision defense; similar project-name prefixes retain distinct resource names.

## Worker-enabled projects

Worker-enabled GenAI projects:

- Configure `ServiceBusConnection__fullyQualifiedNamespace`.
- Configure `ServiceBusConnection__clientId` for the attached user-assigned
  managed identity.
- Grant that identity's principal Azure Service Bus Data Receiver on the
  generated queue, not the namespace.
- Use `function_worker_queue_name` for the provisioned queue, Function setting,
  and output.

Function host storage uses one complete key-backed `AzureWebJobsStorage`
configuration rather than mixed partial identity settings.

For the existing RAG publishing path, the backend receives
`SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE`, `SERVICE_BUS_QUEUE_NAME`, and
`AZURE_CLIENT_ID`, with `SERVICE_BUS_AUTH_MODE=managed-identity`, for its selected
sender identity. That identity receives only
Azure Service Bus Data Sender on the generated queue; the worker's receiver
identity remains separate. Queue overrides feed the resource, publisher,
receiver, and output consistently. Missing namespace, entity, or selected
identity cannot produce a successful ingestion result.

See Microsoft's [managed identity and role-scope guidance](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-managed-service-identity).
This wiring does not implement RAG retrieval or citations. The generated Function
trigger currently decodes/logs message keys and returns; successful publication
is not proof that indexing or other job processing occurred.

## Frontend origins

Generated backends allow their local frontend origin by default.
`VITE_API_BASE_URL` identifies the backend URL; if the frontend runs on another
origin, include that frontend origin in the comma-separated
`CORS_ALLOWED_ORIGINS` value. Generated Azure infrastructure
sets it to the deployed frontend URL.

## Deployment boundary

For governed projects, these are reference steps, not the next setup action.
The separately approved `application-foundation` phase must authorize the exact
mutation, but its production executor and a public approval-persistence channel
are not supplied in this release. Do not bypass those blockers by executing
printed commands directly. Separately reviewed platform implementation is needed;
generated files alone are not deployment authority.

Before applying infrastructure:

1. Run `liftoff validate` and `liftoff doctor`.
2. Install and verify OpenTofu separately.
3. Authenticate with Azure under the intended tenant and subscription.
4. Review tfvars, names, role assignments, networking, and state storage.
5. Run plan through your normal review process.

Liftoff never stores Azure credentials or signs in on your behalf.

## Application readiness source boundary

TASK14.1 now has bounded source producers, not production qualification or an
enabled public provisioning command. Both protected handover and custody ports
must be registered, independently requalified, and bound to the actual current
execution host before any registry/identity write or build dispatch. The
protected bootstrap must retain its original opaque custody references and exact
30-day disposal obligation. Missing task13 production storage, non-exporting
keys, locking, runner admission or disposable qualification still blocks.

Read-only `governance status --json`, `governance status --scope local --json`
and `governance resume --json` describe these two application executors as
`injected-only`, with the exact protected-source blocker. This is not production
readiness or approval to run the source adapters. CLI review history covers each
scope separately; its frozen captures, normalization, prior records, exit codes
and stderr are preserved.
Forward source integration retains both the application disclosure review and
the six separately reviewed HCL fingerprint/planning-digest changes. Neither
static contract data nor an installed package supplies execution authority.

`application-prerequisites-ready` accepts only the selected declared environment,
`registrySku: "Basic"` and explicit `assignRegistryRoles: true`, with nonzero
fixed/usage cost ceilings. It creates the deterministic registry and workload
identity inside the previously verified same-operation bootstrap group, disables
registry admin credentials, and assigns only registry-scoped AcrPull to that
workload identity and AcrPush to the existing verified tenant service principal.
It does not create an account, federated credential, provider registration,
broader role, application deployment or brownfield import. Permission/provider
readback, collision inspection, independent deployed-recipe export and exact
resource/role readback are required. Provider conditional creation and competing
resource-creation scenarios still require real disposable qualification; source
tests cannot qualify an Azure resource provider's concurrency behavior.

**Execution-ref source admission is read-only, not production qualification.**
The artifact route accepts only the existing lightweight
`liftoff-execution-<full-source-SHA>` tag, independently bound to the complete
reviewed commit and tree. It rereads effective repository tag update/deletion
protection with no bypass, provider grants, the commit tree and tag before
dispatch and accepted/resumed observation. Missing tags, unknown or inherited
policy, bypass, changed source/tree or unsupported credentials block; this
producer never creates tags, changes policy or falls back to a branch/raw SHA.
Exact current approval and lease are checked again after awaited tag admission,
immediately before dispatch; provider observation cannot prolong write authority.
The current admission supports independently observed classic OAuth `repo` and
`workflow` grants plus repository push access, not inferred installation or
fine-grained permissions. Policy administrators remain an external trust
boundary. Public-v8 activation, protected production ports and real disposable
execution-ref qualification remain separate blockers.

`application-artifact-ready` requires an existing separately reviewed/published
workflow and private-network runner admission. Its exact plan binds the complete
Git `sourceSha`, required complete `sourceTreeSha`, derived protected execution
tag, raw workflow byte digest, one observed source context and
Dockerfile, image repository, canonical registry resource, environment, principal,
backend/runner identity and cost. `sourceTransmissionApproved`,
`dependencyNetworkApproved` and `buildExecutionApproved` must each be explicitly
true; resource approval alone cannot authorize them. Changed or uncommitted
customizations are preserved and block rather than being reset or uploaded.
The tree is obtained with `git rev-parse <sourceSha>^{tree}` and independently
checked against both local Git and the provider commit. Runner admission must
name `<repository>/<workflowPath>@refs/tags/<execution-tag>`, not a branch.
Older plans without the exact tree/tag binding are stale and require review;
accepted runs cannot be silently retagged under a new plan.

Generated standard and GenAI Dockerfiles live at the repository root and copy
both `backend` and `database`. For this layout, `contextPath: "."` is allowed only
with an explicit `contextPaths` positive inventory of **leaf files**, including
the actual `Dockerfile`. A directory, glob or broad `.` upload is not an
inventory. The plan binds the exact sorted paths and `sourceManifestDigest`;
current-v8 preparation uses independently validated current active layout
bindings, never original generation paths. Historical manifest readers and their
receipt meanings are unchanged; this helper does not enable public-v8 execution.
Review additional application files explicitly rather than sweeping a component
directory or overwriting customizations.

The first-party `applicationArtifactContextStep(paths)` helper prepares a fresh
context from the approved commit's raw Git blobs, preserving exact file bytes
and `100644`/`100755` modes. Git archive attributes cannot omit or substitute
approved content. Metadata, credentials, state and unselected files never enter
this projection; `.dockerignore` is not source-transmission authority. Bounds
are 512 files, 1 MiB per file and 8 MiB total, with a two-minute projection
deadline and 30-second Git-process deadlines. Missing files, links, submodules,
aliases, changed source or unsupported paths block before source upload.
The committed workflow must contain this exact step once; subsequent shell
steps must use `${{ steps.liftoff-context.outputs.path }}` as their working
directory. The existing dispatch input names, action, destination and effects
do not change. Workflow publication, installed host admission and independent
exact transmission/network/build approval remain separate prerequisites.

The reviewed workflow protocol is one `publish` job named
`Liftoff application artifact`, with the exact qualified runner group/label, a
1–20 minute timeout, immutable action references, and this pre-effect guard:
`${{ github.sha == inputs.source_sha && github.run_attempt == 1 }}`.
Its run name is `Liftoff application artifact ${{ inputs.binding_digest }}`.
Workflow concurrency is exactly
`liftoff-application-artifact-${{ inputs.binding_digest }}`, with
`cancel-in-progress: false`; retries must not cancel an already dispatched build.
Required string dispatch inputs are `binding_digest`, `source_sha`,
`context_path`, `dockerfile_path`, `image_repository`, `image_tag`, `registry_id`,
`client_id`, `subscription_id`, `tenant_id` and `environment`. Human review must
verify that the actual committed recipe consumes these exact inputs, performs
only the approved build/transmission, keeps credentials out of arguments/logs,
publishes one ACR QuickBuild image, locks tag and manifest write/delete, and
creates its GitHub build-provenance attestation. The successful final step name
reports only `Liftoff artifact sha256:<actual-digest> run <actual-acr-run-id>`.
That name is discovery, **not proof**.

The producer independently observes the actual workflow run/job/runner, ACR run
and output image, locked tag plus digest, then uses bounded
`gh attestation verify` with exact repository, signer workflow, signer/source SHA
and hosted-runner constraints. Certificate run-invocation/repository identity
and the immutable subject digest must match; caller annotations and user-controlled
predicate metadata cannot replace them. Existing protected OCI authentication is
required; there is no token login or ambient credential fallback. Only verified
`<registry>/<repository>@sha256:<digest>` output can become artifact readiness.
The read-only observer captures the original publication values and workflow-run
resource ID before its first asynchronous read. Caller changes during ACR or
attestation readback cannot select a replacement run, tag, source or digest:
unchanged observations remain bound to the original inputs, and replacement
provider proof is refused. This grants no dispatch or execution-ref authority.

Confirmed provider handles are checkpointed privately before subsequent
observation. Engine-owned dispatch intent is written only after preflight and
before the actual external dispatch; permission/validation refusals are not
misreported as uncertain acceptance. The documented GitHub API 2026-03-10
dispatch response returns an actual run ID and URLs: the producer validates
their repository/run scope and checkpoints that handle before metadata polling,
even if run-list discovery is delayed. A legacy empty response or an intent-only
recovery without its original accepted run ID remains uncertain. Even a unique
listed run with matching source and recipe cannot supply original dispatch
provenance. Malformed or cross-scope acceptance never invents a handle or permits
redispatch. Unexpected response fields are not retained.
Actual terminal run status is checkpointed before the fallible job inventory
read, including when source changes prevent a later outcome from being saved.
Every polled run ID must match the exact accepted or resumed workflow handle
before status, jobs or attestation can advance publication. A different run
with otherwise matching source and recipe cannot replace the recorded operation.
Known terminal prerequisite deployments also refuse contradictory nonterminal
readback during recovery; the original handle remains terminal, not pending.
Known unsuccessful conclusions (including failure, cancellation and timeout)
checkpoint a failed handle even if job readback is unavailable; unknown terminal
conclusions explicitly block publication rather than implying success.
Contradictory nonterminal readback of a recorded terminal handle also blocks
without downgrading its prior outcome or reporting a false pending operation.
Provider completion alone does not verify publication: unavailable job readback
blocks artifact readiness. The existing explicit terminal-operation recovery
gate remains required; recovery observes the same handle without dispatch.
Prerequisite deployment success/failure is likewise checkpointed before recipe
export or final local freshness checks; deployment completion does not invent
registry, identity or role verification.
Native processes, registered network reads
and custody qualification have 30-second calls within one shared three-minute
observation deadline; a timed-out dispatch is never automatically repeated.
Pending retries retain the original dispatch plan/time/handle while checking
exact current reviewed authority, rather than retagging history to a newly
timestamped observation plan. Actual completed provider operations remain
completed even if immutable publication qualification is refused.
Pending retries and explicitly approved terminal observation recovery do not
redispatch; uncertain dispatch
acceptance, multiple matching runs, mutable/changed tags, expired/revoked
authority and failed jobs remain explicit blockers with retained partial-effect
warnings. Workflow publication, deployment, health/release checks and recovery
mutations are separate phases. TASK14.1 remains unchecked until real task13
dependencies, scoped disposable authority, publication scenarios and exact-head
qualification exist.

Dependent source consumers can use `ApplicationPrerequisiteBinding` with
`applicationPrerequisiteBinding`/`observeApplicationPrerequisites`, and
`ApplicationArtifactBinding` with `executeApplicationArtifactPublication`.
`readVerifiedApplicationArtifact` returns `VerifiedApplicationArtifact` only
from current authoritative, resource-bound evidence, exact approved source and
immutable digest; `observeImmutableApplicationArtifact` independently reobserves
the actual publication. These are private preparation/readback interfaces, not
deployment authority or a task14.3 workflow/source publication implementation.
