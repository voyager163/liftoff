## Infrastructure

`infrastructure/opentofu/azure/` describes the Azure resources the
application runs on, as [OpenTofu](https://opentofu.org/) code. Liftoff
generates and checks it; nothing is created in Azure until you apply it.

- `bootstrap/` creates what the environments share: zone-redundant storage
  for their state, the container registry images are promoted through, and
  each environment's resource group and the identity its containers run as.
- `environments/<name>/` is one root per environment, each with its own
  state. They differ only in their settings.
- `modules/app/` is what an environment is made of: a private network,
  PostgreSQL reachable only from it, and Azure Container Apps for the API,
  its migrations job and, if the project has one, the frontend.

| Setting | dev | staging | prod |
| --- | --- | --- | --- |
| PostgreSQL | Burstable B1ms | Burstable B1ms | General Purpose D2ds v5 |
| Zone-redundant standby | no | no | yes |
| Backup retention | 7 days | 7 days | 35 days |
| API replicas kept running | 0 | 1 | 1 |

Costs depend on the region and on use; check the
[Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/)
before applying. The main recurring costs are PostgreSQL, which is billed
while it runs, the Log Analytics data ingested, and Container Apps beyond
the monthly free grant. Production's zone-redundant standby doubles its
PostgreSQL compute cost and needs a region with availability zones.

Checks, run from `infrastructure/opentofu/azure`:

| Command | What it checks |
| --- | --- |
| `tofu fmt -check -recursive` | Formatting |
| `tofu -chdir=<root> init -backend=false -lockfile=readonly` then `tofu -chdir=<root> validate` | Each root (`bootstrap`, `environments/<name>`) against the committed provider locks |
| `checkov --directory . --framework terraform` | Security scan; accepted findings are skipped next to the resource with their reason |

To apply them yourself, apply `bootstrap/` first, which needs Owner or User
Access Administrator on the subscription because it grants roles: AcrPull
for the environments' identities, and Storage Blob Data Contributor on the
state for you, since the state accepts only Microsoft Entra ID. Then apply
each environment with a `backend.hcl` made from `backend.hcl.example` and a
`terraform.tfvars` made from `terraform.tfvars.example`. Before each
deployment of a new API image, start the environment's migrations job.

The workflows deploy by digest once Azure is set up for them: set the
`AZURE_DEPLOYMENTS` repository variable to `on`, and on each GitHub
environment the `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and
`AZURE_SUBSCRIPTION_ID` of the identity GitHub signs in as, the
`AZURE_CONTAINER_REGISTRY` from bootstrap's outputs, and the
`AZURE_RESOURCE_GROUP`, `AZURE_API_APP`, `AZURE_WEB_APP`,
`AZURE_MIGRATE_JOB` and `APP_URL` from the environment's outputs. Until
then, a deployment fails and says what is missing.
