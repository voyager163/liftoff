import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EnvironmentId, LiftoffManifest } from '../../src/domain/project/contracts.js';
import { retiredFlatRootInfrastructureIdentities } from '../../src/domain/project/infrastructure-layout.js';

export const repairRoot = ['infrastructure', 'opentofu', 'azure'];

// The pre-57eba97 generator had comment-only local/default backend configuration
// and environments/<id>.tfvars (not environments/<id>/<id>.tfvars).
export const legacyInfrastructureSources: Record<string, string> = {
  'versions.tf': readFileSync(new URL('../../assets/locks/opentofu-azure/versions.tf', import.meta.url), 'utf8'),
  '.terraform.lock.hcl': readFileSync(new URL('../../assets/locks/opentofu-azure/.terraform.lock.hcl', import.meta.url), 'utf8'),
  'providers.tf': `provider "azurerm" {
  features {}
}
`,
  'variables.tf': `variable "environment" {
  type = string
  description = "Deployment environment name."
}
variable "location" {
  type = string
  default = "eastus"
}
variable "resource_suffix" {
  type = string
  validation {
    condition = can(regex("^[a-z0-9]{12}$", var.resource_suffix))
    error_message = "resource_suffix must contain exactly 12 lowercase letters or numbers."
  }
}
variable "backend_image" {
  type = string
  default = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
}
variable "backend_target_port" {
  type = number
  default = 80
}
variable "enable_private_networking" {
  type = bool
  default = false
}
variable "postgres_admin_password" {
  type = string
  sensitive = true
}
`,
  'main.tf': `resource "azurerm_resource_group" "main" {
  name = "rg-repair-\${var.environment}"
  location = var.location
}

resource "azurerm_container_registry" "main" {
  name = "acr\${var.environment}\${var.resource_suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location = azurerm_resource_group.main.location
  sku = "Basic"
  admin_enabled = false
}

resource "azurerm_user_assigned_identity" "app" {
  name = "id-repair-\${var.environment}"
  resource_group_name = azurerm_resource_group.main.name
  location = azurerm_resource_group.main.location
}

resource "azurerm_role_assignment" "acr_pull" {
  scope = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_container_app_environment" "main" {
  name = "cae-repair-\${var.environment}"
  resource_group_name = azurerm_resource_group.main.name
  location = azurerm_resource_group.main.location
}

resource "azurerm_container_app" "backend" {
  name = "ca-repair-\${var.environment}"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name = azurerm_resource_group.main.name
  revision_mode = "Single"

  identity {
    type = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }
  registry {
    server = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }
  secret {
    name = "database-url"
    value = "postgresql://liftoffadmin:\${urlencode(var.postgres_admin_password)}@\${azurerm_postgresql_flexible_server.main.fqdn}:5432/postgres?sslmode=require"
  }
  template {
    container {
      name = "backend"
      image = var.backend_image
      cpu = 0.5
      memory = "1Gi"
      env {
        name = "APP_ENV"
        value = var.environment
      }
    }
  }
  ingress {
    external_enabled = true
    target_port = var.backend_target_port
    traffic_weight {
      percentage = 100
      latest_revision = true
    }
  }
  depends_on = [azurerm_role_assignment.acr_pull]
}

resource "azurerm_postgresql_flexible_server" "main" {
  name = "psql-repair-\${var.environment}"
  resource_group_name = azurerm_resource_group.main.name
  location = azurerm_resource_group.main.location
  version = "16"
  administrator_login = "liftoffadmin"
  administrator_password = var.postgres_admin_password
  storage_mb = 32768
  sku_name = "B_Standard_B1ms"
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  count = var.enable_private_networking ? 0 : 1
  name = "AllowAzureServices"
  server_id = azurerm_postgresql_flexible_server.main.id
  start_ip_address = "0.0.0.0"
  end_ip_address = "0.0.0.0"
}

resource "azurerm_redis_cache" "main" {
  name = "redis-repair-\${var.environment}"
  resource_group_name = azurerm_resource_group.main.name
  location = azurerm_resource_group.main.location
  capacity = 0
  family = "C"
  sku_name = "Basic"
}

resource "azurerm_storage_account" "main" {
  name = "st\${var.environment}\${var.resource_suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location = azurerm_resource_group.main.location
  account_tier = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_storage_container" "documents" {
  name = "documents"
  storage_account_id = azurerm_storage_account.main.id
  container_access_type = "private"
}

resource "azurerm_servicebus_namespace" "main" {
  name = "sb-repair-\${var.environment}"
  resource_group_name = azurerm_resource_group.main.name
  location = azurerm_resource_group.main.location
  sku = "Standard"
}

resource "azurerm_servicebus_queue" "events" {
  name = "events"
  namespace_id = azurerm_servicebus_namespace.main.id
}

resource "azurerm_communication_service" "main" {
  name = "acs-repair-\${var.environment}"
  resource_group_name = azurerm_resource_group.main.name
  data_location = "United States"
}

resource "azurerm_key_vault" "main" {
  name = "kv\${var.environment}\${var.resource_suffix}"
  location = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tenant_id = data.azurerm_client_config.current.tenant_id
  sku_name = "standard"
  rbac_authorization_enabled = true
}

data "azurerm_client_config" "current" {}
`,
  'outputs.tf': `output "backend_url" {
  value = azurerm_container_app.backend.ingress[0].fqdn
}
output "container_registry" {
  value = azurerm_container_registry.main.login_server
}
`,
  'backend.local.tf': `# Local state is the V1 default for first-use simplicity.
# Teams can replace this file with backend.remote.example.tf when adopting shared state.
`,
  'backend.remote.example.tf': `# Rename to backend.tf and configure values for shared state.
# terraform {
#   backend "azurerm" {
#     resource_group_name = "rg-opentofu-state"
#     key = "mission-control/liftoff.tfstate"
#   }
# }
`,
  'README.md': 'Existing project infrastructure documentation: retain this exact text.\n'
};

/** Writes infrastructure only and returns the manifest for the caller to persist. */
export async function createLegacyInfrastructureFixture(
  projectRoot: string, environments: EnvironmentId[] = ['dev', 'prod']
): Promise<LiftoffManifest> {
  const manifest: LiftoffManifest = {
    artifactVersion: 7, generatedBy: 'Mission Control Liftoff', liftoffVersion: '0.10.0',
    project: {
      name: 'Repair fixture', workload: {
        kind: 'standard', apiStack: 'node-fastify', cloud: 'azure', region: 'eastus',
        frontend: false, environments
      },
      specWorkflow: 'openspec', agents: ['github-copilot']
    },
    framework: { state: 'initialized', adapter: 'openspec', contractVersion: '1.11.0' },
    governance: { profile: 'none', state: 'disabled' },
    managedArtifacts: [], projectArtifacts: []
  };
  const entries = [
    ...retiredFlatRootInfrastructureIdentities.map((identity) => ({
      ...identity, pathParts: [...identity.pathParts],
      content: legacyInfrastructureSources[identity.pathParts.at(-1)!]
    })),
    {
      logicalName: 'opentofu-readme', category: 'infrastructure',
      provisioningGroup: 'base' as const, pathParts: [...repairRoot, 'README.md'],
      content: legacyInfrastructureSources['README.md']
    },
    ...environments.map((environment) => ({
      logicalName: `opentofu-${environment}-tfvars`, category: 'infrastructure',
      provisioningGroup: `environment:${environment}` as const,
      pathParts: [...repairRoot, 'environments', `${environment}.tfvars`],
      content: `environment = "${environment}"\nlocation = "eastus"\nresource_suffix = "abcdef123456"\nbackend_target_port = 8080\n`
    }))
  ];
  for (const { content, ...identity } of entries) {
    const file = path.join(projectRoot, ...identity.pathParts);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    manifest.projectArtifacts.push({
      ...identity, generatedBy: '0.10.0',
      generationHash: `sha256:${createHash('sha256').update(content).digest('hex')}`
    });
  }
  return manifest;
}
