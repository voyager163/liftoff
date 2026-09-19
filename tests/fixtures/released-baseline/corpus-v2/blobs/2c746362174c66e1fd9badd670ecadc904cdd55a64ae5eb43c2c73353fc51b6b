import type { GeneratorContext as ResolvedGeneratorContext } from '../context.js';
type GeneratorContext = Pick<ResolvedGeneratorContext, 'opentofu' | 'stack'>;
import type { AddArtifact } from '../../template-types.js';
import type { ApiProjectPlan } from '../../domain/project/contracts.js';
import { buildAzureResourceNames } from './names.js';
import { createArtifactAdder } from '../common/artifacts.js';
import { DEFAULT_FUNCTION_WORKER_QUEUE_NAME } from '../common/values.js';
import { formatContainerImage } from '../../domain/project/supported-stack.js';
import { functionWorkerName } from '../common/values.js';
import { genAiPattern } from '../common/values.js';
import type { GeneratedArtifact } from '../../domain/project/contracts.js';
import { hasFunctionWorker } from '../common/values.js';


import { selectedEnvironmentId } from '../common/values.js';
import { projectIdentityDigest, stableResourceSuffix } from './names.js';


export function addInfrastructureArtifacts(
  add: AddArtifact,
  artifacts: GeneratedArtifact[],
  plan: ApiProjectPlan, context: GeneratorContext
): void {
  const base = ['infrastructure', 'opentofu', 'azure'];
  const application = [...base, 'modules', 'application'];
  add('opentofu-application-versions', 'infrastructure', [...application, 'versions.tf'], context.opentofu.versions);
  add('opentofu-application-variables', 'infrastructure', [...application, 'variables.tf'], renderTofuVariables(plan, context));
  add('opentofu-application-main', 'infrastructure', [...application, 'main.tf'], renderTofuMain(plan));
  add('opentofu-application-outputs', 'infrastructure', [...application, 'outputs.tf'], renderTofuOutputs(plan));
  add('opentofu-readme', 'infrastructure', [...base, 'README.md'], renderTofuReadme(plan));
  for (const environment of plan.environments) {
    const addEnvironment = createArtifactAdder(
      artifacts,
      'project',
      `environment:${environment.id}`
    );
    const root = [...base, 'environments', environment.id];
    const rootArtifacts: Array<[string, string, string]> = [
      ['versions', 'versions.tf', context.opentofu.versions],
      ['provider-lock', '.terraform.lock.hcl', context.opentofu.providerLock],
      ['providers', 'providers.tf', renderTofuProviders()],
      ['variables', 'variables.tf', renderTofuRootVariables(plan, environment.id, context)],
      ['main', 'main.tf', renderTofuRootMain(plan)],
      ['outputs', 'outputs.tf', renderTofuRootOutputs(plan)],
      ['local-state', 'backend.local.tf', renderTofuLocalState(environment.id)],
      ['remote-state-example', 'backend.remote.example.tf', renderTofuRemoteStateExample(plan, environment.id)],
      ['tfvars', `${environment.id}.tfvars`, renderTofuTfvars(plan, environment.id, context)]
    ];
    for (const [identity, file, content] of rootArtifacts) {
      addEnvironment(`opentofu-${environment.id}-${identity}`, 'infrastructure', [...root, file], content);
    }
  }

}

export function renderTofuRootVariables(plan: ApiProjectPlan, environment: string, context: GeneratorContext): string {
  return renderTofuVariables(plan, context).replace(
    '  description = "Deployment environment name."',
    `  description = "Deployment environment name."
  default     = "${environment}"

  validation {
    condition     = var.environment == "${environment}"
    error_message = "This root only deploys ${environment}; select another environment root instead."
  }`
  );
}

export function renderTofuRootMain(plan: ApiProjectPlan): string {
  const variables = [
    'environment', 'location', 'resource_suffix', 'backend_image', 'backend_target_port',
    'postgres_admin_password', 'enable_private_networking',
    ...(plan.includeFrontend ? ['frontend_image'] : []),
    ...(hasFunctionWorker(plan) ? ['function_worker_queue_name', 'functions_python_version'] : [])
  ];
  const width = Math.max(...variables.map((name) => name.length), 'source'.length);
  return `module "application" {
  ${'source'.padEnd(width)} = "../../modules/application"
${variables.map((name) => `  ${name.padEnd(width)} = var.${name}`).join('\n')}
}
`;
}

export function renderTofuRootOutputs(plan: ApiProjectPlan): string {
  const outputs = [
    'backend_url', ...(plan.includeFrontend ? ['frontend_url'] : []),
    ...(hasFunctionWorker(plan) ? ['function_app_name', 'function_worker_queue_name'] : []),
    'container_registry', 'container_registry_name',
    ...(plan.workload === 'genai' && plan.pattern.id === 'rag'
      ? ['service_bus_fully_qualified_namespace', 'service_bus_queue_name', 'backend_azure_client_id']
      : [])
  ];
  return outputs.map((name) => `output "${name}" {
  value = module.application.${name}
}
`).join('\n');
}

export function renderTofuProviders(): string {
  return `provider "azurerm" {
  features {}
}
`;
}

export function renderTofuVariables(plan: ApiProjectPlan, context: GeneratorContext): string {
  const frontendVariables = plan.includeFrontend ? `
variable "frontend_image" {
  type        = string
  default     = "${formatContainerImage(context.stack.containers['container-apps-bootstrap'])}"
  description = "Frontend image. Replace the bootstrap image with the generated frontend image after pushing it to ACR."
}
` : '';
  const functionVariables = hasFunctionWorker(plan) ? `
variable "function_worker_queue_name" {
  type        = string
  default     = "events"
  description = "Service Bus queue consumed by the generated Azure Functions worker."
}

variable "functions_python_version" {
  type        = string
  default     = "${context.stack.runtimes.python.releaseLine}"
  description = "Python runtime version for the generated Azure Functions worker."
}
` : '';
  return `variable "environment" {
  type        = string
  description = "Deployment environment name."
}

variable "location" {
  type        = string
  description = "Azure region slug."
  default     = "${plan.region.slug}"
}

variable "resource_suffix" {
  type        = string
  description = "Twelve-character lowercase alphanumeric suffix for globally scoped Azure resource names."

  validation {
    condition     = can(regex("^[a-z0-9]{12}$", var.resource_suffix))
    error_message = "resource_suffix must contain exactly 12 lowercase letters or numbers."
  }
}

variable "backend_image" {
  type        = string
  default     = "${formatContainerImage(context.stack.containers['container-apps-bootstrap'])}"
  description = "Backend image. Replace the bootstrap image with the generated backend image after pushing it to ACR."
}

variable "backend_target_port" {
  type        = number
  default     = 80
  description = "Backend ingress port. Set to 8000 when switching from the bootstrap image to the generated backend."
}
${frontendVariables}
variable "postgres_admin_password" {
  type        = string
  sensitive   = true
  description = "PostgreSQL administrator password supplied at apply time."
}

variable "enable_private_networking" {
  type        = bool
  default     = false
  description = "Enable production-oriented private-networking-ready settings."
}
${functionVariables}
`;
}

export function renderTofuMain(plan: ApiProjectPlan): string {
  const functionPattern = plan.workload === 'genai' && hasFunctionWorker(plan)
    ? genAiPattern(plan)
    : undefined;
  const names = buildAzureResourceNames(plan, '${var.environment}', '${var.resource_suffix}');
  const queueName = hasFunctionWorker(plan)
    ? 'var.function_worker_queue_name'
    : JSON.stringify(DEFAULT_FUNCTION_WORKER_QUEUE_NAME);
  const ragPublisher = plan.workload === 'genai' && plan.pattern.id === 'rag';
  const publisherEnvironment = ragPublisher ? `
      env {
        name  = "SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE"
        value = "\${azurerm_servicebus_namespace.main.name}.servicebus.windows.net"
      }

      env {
        name  = "SERVICE_BUS_QUEUE_NAME"
        value = azurerm_servicebus_queue.events.name
      }

      env {
        name  = "SERVICE_BUS_AUTH_MODE"
        value = "managed-identity"
      }

      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.app.client_id
      }
` : '';
  const senderRole = ragPublisher ? `
resource "azurerm_role_assignment" "backend_servicebus_sender" {
  scope                = azurerm_servicebus_queue.events.id
  role_definition_name = "Azure Service Bus Data Sender"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}
` : '';
  const projectIdentityEnv = plan.workload === 'genai' ? `
      env {
        name  = "GENAI_PATTERN"
        value = "${genAiPattern(plan).id}"
      }
` : `
      env {
        name  = "API_STACK"
        value = "${plan.apiStack.id}"
      }
`;
  const frontendCorsEnvironment = plan.includeFrontend ? `
      env {
        name  = "CORS_ALLOWED_ORIGINS"
        value = "https://\${azurerm_container_app.frontend.ingress[0].fqdn}"
      }
` : '';
  const frontendContainer = plan.includeFrontend ? `
resource "azurerm_container_app" "frontend" {
  name                         = "${names.frontendContainerApp}"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  template {
    container {
      name   = "frontend"
      image  = var.frontend_image
      cpu    = 0.25
      memory = "0.5Gi"
    }
  }

  ingress {
    external_enabled = true
    target_port      = 80
    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  depends_on = [azurerm_role_assignment.acr_pull]
}
` : '';
  const functionWorker = hasFunctionWorker(plan) ? `
resource "azurerm_user_assigned_identity" "worker" {
  name                = "${names.functionIdentity}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
}

resource "azurerm_service_plan" "functions" {
  name                = "${names.functionServicePlan}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = "Y1"
}

resource "azurerm_linux_function_app" "worker" {
  name                       = "${names.functionApp}"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  service_plan_id            = azurerm_service_plan.functions.id
  storage_account_name       = azurerm_storage_account.main.name
  storage_account_access_key = azurerm_storage_account.main.primary_access_key

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.worker.id]
  }

  site_config {
    application_stack {
      python_version = var.functions_python_version
    }
  }

  app_settings = {
    APP_ENV                                       = var.environment
    APP_NAME                                      = "${plan.safeProjectName}"
    GENAI_PATTERN                                 = "${functionPattern?.id}"
    FUNCTIONS_WORKER_RUNTIME                      = "python"
    SERVICEBUS_QUEUE_NAME                         = var.function_worker_queue_name
    ServiceBusConnection__clientId                = azurerm_user_assigned_identity.worker.client_id
    ServiceBusConnection__fullyQualifiedNamespace = "\${azurerm_servicebus_namespace.main.name}.servicebus.windows.net"
    SHARED_ORCHESTRATION_ROOT                     = "../../backend"
  }
}

resource "azurerm_role_assignment" "function_servicebus_receiver" {
  scope                = azurerm_servicebus_queue.events.id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = azurerm_user_assigned_identity.worker.principal_id
}

resource "azurerm_role_assignment" "function_storage_blob_contributor" {
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.worker.principal_id
}
` : '';
  return `resource "azurerm_resource_group" "main" {
  name     = "${names.resourceGroup}"
  location = var.location
}

resource "azurerm_container_registry" "main" {
  name                = "${names.containerRegistry}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Basic"
  admin_enabled       = false
}

resource "azurerm_user_assigned_identity" "app" {
  name                = "${names.identity}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_container_app_environment" "main" {
  name                = "${names.containerAppEnvironment}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
}

resource "azurerm_container_app" "backend" {
  name                         = "${names.backendContainerApp}"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  secret {
    name  = "database-url"
    value = "postgresql://liftoffadmin:\${urlencode(var.postgres_admin_password)}@\${azurerm_postgresql_flexible_server.main.fqdn}:5432/postgres?sslmode=require"
  }

  secret {
    name  = "redis-url"
    value = "rediss://:\${urlencode(azurerm_redis_cache.main.primary_access_key)}@\${azurerm_redis_cache.main.hostname}:\${azurerm_redis_cache.main.ssl_port}/0"
  }

  template {
    container {
      name   = "backend"
      image  = var.backend_image
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "APP_ENV"
        value = var.environment
      }

      env {
        name  = "APP_NAME"
        value = "${plan.safeProjectName}"
      }

      env {
        name  = "PROJECT_TYPE"
        value = "${plan.projectType.id}"
      }
${projectIdentityEnv}
      env {
        name  = "CLOUD_PROVIDER"
        value = "azure"
      }

      env {
        name  = "AZURE_REGION"
        value = var.location
      }
${frontendCorsEnvironment}

      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }

      env {
        name        = "REDIS_URL"
        secret_name = "redis-url"
      }

      env {
        name  = "MESSAGING_TRANSPORT"
        value = "azure-service-bus"
      }
${publisherEnvironment}
      env {
        name  = "BLOB_ENDPOINT"
        value = azurerm_storage_account.main.primary_blob_endpoint
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = var.backend_target_port
    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  depends_on = [azurerm_role_assignment.acr_pull${ragPublisher ? ', azurerm_role_assignment.backend_servicebus_sender' : ''}]
}
${frontendContainer}
resource "azurerm_postgresql_flexible_server" "main" {
  name                   = "${names.postgres}"
  resource_group_name    = azurerm_resource_group.main.name
  location               = azurerm_resource_group.main.location
  version                = "16"
  administrator_login    = "liftoffadmin"
  administrator_password = var.postgres_admin_password
  storage_mb             = 32768
  sku_name               = "B_Standard_B1ms"
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  count            = var.enable_private_networking ? 0 : 1
  name             = "AllowAzureServices"
  server_id        = azurerm_postgresql_flexible_server.main.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

resource "azurerm_redis_cache" "main" {
  name                = "${names.redis}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  capacity            = 0
  family              = "C"
  sku_name            = "Basic"
}

resource "azurerm_storage_account" "main" {
  name                     = "${names.storage}"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_storage_container" "documents" {
  name                  = "documents"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

resource "azurerm_servicebus_namespace" "main" {
  name                = "${names.serviceBus}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "Standard"
}

resource "azurerm_servicebus_queue" "events" {
  name         = ${queueName}
  namespace_id = azurerm_servicebus_namespace.main.id
}
${senderRole}${functionWorker}

resource "azurerm_communication_service" "main" {
  name                = "${names.communication}"
  resource_group_name = azurerm_resource_group.main.name
  data_location       = "United States"
}

resource "azurerm_key_vault" "main" {
  name                       = "${names.keyVault}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
}

data "azurerm_client_config" "current" {}
`;
}

export function renderTofuOutputs(plan: ApiProjectPlan): string {
  const functionOutputs = hasFunctionWorker(plan) ? `
output "function_app_name" {
  value = azurerm_linux_function_app.worker.name
}

output "function_worker_queue_name" {
  value = azurerm_servicebus_queue.events.name
}
` : '';
  const publisherOutputs = plan.workload === 'genai' && plan.pattern.id === 'rag' ? `
output "service_bus_fully_qualified_namespace" {
  value = "\${azurerm_servicebus_namespace.main.name}.servicebus.windows.net"
}

output "service_bus_queue_name" {
  value = azurerm_servicebus_queue.events.name
}

output "backend_azure_client_id" {
  value = azurerm_user_assigned_identity.app.client_id
}
` : '';
  return `output "backend_url" {
  value = azurerm_container_app.backend.ingress[0].fqdn
}

${plan.includeFrontend ? `output "frontend_url" {
  value = azurerm_container_app.frontend.ingress[0].fqdn
}
` : ''}${functionOutputs}output "container_registry" {
  value = azurerm_container_registry.main.login_server
}

output "container_registry_name" {
  value = azurerm_container_registry.main.name
}
${publisherOutputs}
`;
}

export function renderTofuLocalState(environment: string): string {
  return `terraform {
  backend "local" {
    path = "state/${environment}.tfstate"
  }
}
`;
}

export function renderTofuRemoteStateExample(plan: ApiProjectPlan, environment: string): string {
  return `# Replace backend.local.tf with a reviewed backend.tf using this example.
# Use approved private, encrypted ZRS state storage; blob leases provide locking.
# State may contain secrets. Do not commit it or place credentials in this file.
# terraform {
#   backend "azurerm" {
#     resource_group_name  = "rg-opentofu-state"
#     storage_account_name = "stliftoffstate"
#     container_name       = "tfstate"
#     key                  = "${plan.safeProjectName}-${projectIdentityDigest(plan)}/${environment}/terraform.tfstate"
#     use_azuread_auth     = true
#   }
# }
`;
}

export function renderTofuReadme(plan: ApiProjectPlan): string {
  const env = selectedEnvironmentId(plan);
  const governanceGate = plan.governanceProfile.id === 'none' ? '' : `
## Governance Gate

The commands below are reference material, not authorization to mutate Azure.
Do not run the plan/apply, ACR build, or image-replacement sequence until the
separately approved \`application-foundation\` governance phase authorizes the
exact operation. \`/liftoff-setup\` can evaluate and resume managed phases, but it
does not imply that every managed phase has an executable production adapter.
An unavailable production adapter remains a blocker; do not bypass it by running
these commands directly.
`;
  const functionSection = plan.workload === 'genai' && hasFunctionWorker(plan) ? `
## Azure Functions Worker

This project includes an Azure Functions worker under \`functions/${functionWorkerName(plan)}\`. The worker has a separate user-assigned identity with Azure Service Bus Data Receiver on the generated queue only, selected through \`ServiceBusConnection__clientId\` plus \`ServiceBusConnection__fullyQualifiedNamespace\`. \`function_worker_queue_name\` provisions the queue, configures \`SERVICEBUS_QUEUE_NAME\`, and drives the worker queue output. Function host storage uses the complete key-backed \`AzureWebJobsStorage\` connection setting.
${plan.workload === 'genai' && plan.pattern.id === 'rag' ? '\nThe RAG backend identity has only Azure Service Bus Data Sender on that queue, not receiver authority. Its namespace, queue, managed-identity authentication mode, and client ID are injected by the application module. The worker trigger is a handoff foundation; retrieval and indexing are not implemented.\n' : ''}
` : '';
  return `# Azure OpenTofu

Azure is the supported infrastructure starter. Generated files are not production-readiness evidence.
${governanceGate}

## Bootstrap Infrastructure

The first apply uses a public bootstrap image so Azure Container Apps can start before the new ACR contains application images.

\`\`\`bash
cd infrastructure/opentofu/azure/environments/${env}
tofu init
tofu plan -var-file=${env}.tfvars
tofu apply -var-file=${env}.tfvars
\`\`\`

Build the generated backend in ACR, then replace the bootstrap image:

\`\`\`bash
ACR_NAME="$(tofu output -raw container_registry_name)"
SOURCE_SHA="$(git rev-parse HEAD)"
az acr build --registry "$ACR_NAME" --image ${plan.safeProjectName}-backend:"$SOURCE_SHA" ../../../../..
${plan.includeFrontend ? `BACKEND_URL="https://$(tofu output -raw backend_url)"
az acr build --registry "$ACR_NAME" --image ${plan.safeProjectName}-frontend:"$SOURCE_SHA" --build-arg VITE_API_BASE_URL="$BACKEND_URL" ../../../../../frontend
` : ''}\`\`\`

Persist the deployed images in this root's \`${env}.tfvars\` so future applies do not restore the bootstrap image:

\`\`\`hcl
backend_image       = "<login-server>/${plan.safeProjectName}-backend@sha256:<manifest-digest>"
backend_target_port = 8000
${plan.includeFrontend ? `frontend_image      = "<login-server>/${plan.safeProjectName}-frontend@sha256:<manifest-digest>"
` : ''}\`\`\`

\`\`\`bash
tofu apply -var-file=${env}.tfvars
\`\`\`

Each selected environment (${plan.environments.map(({ id }) => id).join(', ')}) has its own root,
provider lock, named tfvars, and \`state/<environment>.tfstate\`. Shared resource definitions
live under \`modules/application\`; do not run plan/apply from that module or the Azure parent directory.
Switch environment by selecting its root, never by passing another environment's tfvars.

Operational \`tofu init\` initializes the root's configured backend. Only local baseline checks
use \`tofu init -backend=false\` followed by \`tofu validate\` in each selected root.
For reviewed remote-state adoption, replace \`backend.local.tf\` using that root's
\`backend.remote.example.tf\`. Each example has a distinct project-and-environment blob key.
State is secret-sensitive: require private access, encryption, ZRS redundancy, and blob-lease locking;
do not commit state or credentials. Existing flat-root projects need a separate reviewed migration;
Liftoff update and force do not move infrastructure or state.
The default PostgreSQL firewall permits Azure-hosted services. Replace it with private networking before production; set \`enable_private_networking=true\` only when the required VNet, delegated subnet, and private DNS resources are added.

## Azure Name Suffixes

Every bounded Azure name includes a stable digest of the full project identity, not only its truncated display prefix.
Each environment tfvars also supplies a deterministic 12-character \`resource_suffix\` for global names.
If Azure reports that a name is already taken, replace that environment's suffix with another unique value matching \`^[a-z0-9]{12}$\`; \`tofu validate\` rejects invalid overrides before deployment.
${functionSection}
`;
}

export function renderTofuTfvars(plan: ApiProjectPlan, environment: string, context: GeneratorContext): string {
  const values: Array<[string, string]> = [
    ['environment', JSON.stringify(environment)],
    ['location', JSON.stringify(plan.region.slug)],
    ['resource_suffix', JSON.stringify(stableResourceSuffix(plan, environment))],
    ['backend_image', JSON.stringify(formatContainerImage(context.stack.containers['container-apps-bootstrap']))],
    ['backend_target_port', '80'],
    ['enable_private_networking', 'false']
  ];
  if (plan.includeFrontend) {
    values.push(['frontend_image', JSON.stringify(formatContainerImage(context.stack.containers['container-apps-bootstrap']))]);
  }
  if (hasFunctionWorker(plan)) {
    values.push(
      ['function_worker_queue_name', JSON.stringify(DEFAULT_FUNCTION_WORKER_QUEUE_NAME)],
      ['functions_python_version', JSON.stringify(context.stack.runtimes.python.releaseLine)]
    );
  }
  const width = Math.max(...values.map(([key]) => key.length));
  return values.map(([key, value]) => `${key.padEnd(width)} = ${value}`).join('\n');
}
