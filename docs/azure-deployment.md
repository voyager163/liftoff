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
