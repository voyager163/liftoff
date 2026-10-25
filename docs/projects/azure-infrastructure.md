# Azure infrastructure

`--infrastructure azure` adds the Azure resources an API project runs on, as
[OpenTofu](https://opentofu.org/) code, for the environments named with
`--environments` (dev, staging and prod by default). Liftoff generates and
checks this code; it never applies it, so nothing is created in Azure until
you do.

## What it creates

| Root | Resources |
| --- | --- |
| `bootstrap/` | A resource group for what the environments share; zone-redundant, versioned storage for their OpenTofu state, reachable only with Microsoft Entra ID; a container registry; and, for each environment, its resource group and the identity its containers pull images with |
| `environments/<name>/` | A private network with a network security group per subnet; PostgreSQL Flexible Server reachable only from that network through private DNS; a Log Analytics workspace; and a Container Apps environment with the API, a job that runs the stack's migrations and, with a frontend, the frontend |

With a frontend, the frontend is the only public entry point: it forwards
`/api/` to the API, which has internal ingress only. Without one, the API is
public. The containers run as the environment's identity, so pulling images
needs no password, and the database password lives only in a Container Apps
secret and the environment's state.

Each environment differs only in its settings:

| Setting | dev | staging | prod |
| --- | --- | --- | --- |
| PostgreSQL SKU | `B_Standard_B1ms` | `B_Standard_B1ms` | `GP_Standard_D2ds_v5` |
| Zone-redundant standby | no | no | yes |
| Backup retention | 7 days | 7 days | 35 days |
| API replicas kept running | 0 | 1 | 1 |

There is no application storage account: the API does not use one, and no
service is provisioned without a consumer. When the application needs
storage, use LRS in dev and ZRS in staging and prod.

## Names, state and locks

- **Names** come from the project, the environment and a short hash of the
  subscription (`modules/naming`), so the same inputs always give the same
  names and two subscriptions never compete for a globally unique one.
- **State:** each environment root uses the azurerm backend with its own key
  (`<environment>.tfstate`) in the storage bootstrap creates. Bootstrap's own
  state starts out local.
- **Locks:** each root commits a `.terraform.lock.hcl` pinning exactly its
  providers (azurerm, and random for the database password), with hashes for
  macOS arm64, Windows x64 and Linux x64. Liftoff's `npm run lock:opentofu`
  regenerates them.

## Checks

The project's CI runs `tofu fmt -check -recursive`, then
`tofu init -backend=false -lockfile=readonly` and `tofu validate` in every
root, and [Checkov](https://www.checkov.io/). Findings that the
small-workload defaults accept, such as features that need the registry's
Premium tier, are skipped next to the resource with their reason. Dependabot
proposes provider updates, and changes under `infrastructure/` are high risk
and always need a person's review.

## Costs and limits

Prices depend on the region and on use; check the
[Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/)
before applying. The recurring costs are PostgreSQL, billed while it runs;
the Log Analytics data ingested; Container Apps beyond the monthly free
grant; and the Basic container registry. Production's zone-redundant standby
doubles its PostgreSQL compute cost and needs a region with availability
zones, as does zone-redundant state storage. Check your subscription's quota
for PostgreSQL vCores and Container Apps environments in the region first.

## Applying it

Applying is separate from generating. Apply `bootstrap/` first with
`terraform.tfvars` made from its example; it grants the environments'
identities AcrPull, so it needs Owner or User Access Administrator on the
subscription. Then apply each environment with a `backend.hcl` and
`terraform.tfvars` made from theirs. Before deploying a new API image, start
the environment's migrations job. Deploying from CI with a managed identity
and OIDC comes with the generated delivery workflows.
