# One environment of the application: a private network, PostgreSQL reachable
# only from it, and Container Apps for the API, its migrations and, when the
# project has one, the frontend. Bootstrap creates the resource group, the
# registry and the identity the containers run as.

module "names" {
  source = "../naming"

  project         = var.project
  environment     = var.environment
  subscription_id = var.subscription_id
}

module "shared" {
  source = "../naming"

  project         = var.project
  subscription_id = var.subscription_id
}

data "azurerm_resource_group" "environment" {
  name = module.names.resource_group
}

data "azurerm_container_registry" "shared" {
  name                = module.shared.container_registry
  resource_group_name = module.shared.resource_group
}

data "azurerm_user_assigned_identity" "app" {
  name                = module.names.app_identity
  resource_group_name = data.azurerm_resource_group.environment.name
}

locals {
  resource_group = data.azurerm_resource_group.environment.name
  frontend       = var.web_image != null
  database_url   = "${var.database_url_scheme}://${azurerm_postgresql_flexible_server.main.administrator_login}:${random_password.database.result}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/${azurerm_postgresql_flexible_server_database.app.name}?sslmode=require"
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = module.names.log_analytics_workspace
  resource_group_name = local.resource_group
  location            = var.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

# Network: one subnet for the Container Apps environment and one delegated to
# PostgreSQL, each behind a network security group.

resource "azurerm_virtual_network" "main" {
  name                = module.names.virtual_network
  resource_group_name = local.resource_group
  location            = var.location
  address_space       = [var.address_space]
}

resource "azurerm_subnet" "apps" {
  name                 = "apps"
  resource_group_name  = local.resource_group
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [cidrsubnet(var.address_space, 7, 0)]

  delegation {
    name = "container-apps"

    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "database" {
  name                 = "database"
  resource_group_name  = local.resource_group
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [cidrsubnet(var.address_space, 8, 2)]

  delegation {
    name = "postgresql"

    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_network_security_group" "apps" {
  name                = "nsg-${module.names.virtual_network}-apps"
  resource_group_name = local.resource_group
  location            = var.location
}

resource "azurerm_network_security_group" "database" {
  name                = "nsg-${module.names.virtual_network}-database"
  resource_group_name = local.resource_group
  location            = var.location
}

resource "azurerm_subnet_network_security_group_association" "apps" {
  subnet_id                 = azurerm_subnet.apps.id
  network_security_group_id = azurerm_network_security_group.apps.id
}

resource "azurerm_subnet_network_security_group_association" "database" {
  subnet_id                 = azurerm_subnet.database.id
  network_security_group_id = azurerm_network_security_group.database.id
}

# PostgreSQL, reachable only from the network through private DNS. Production
# keeps a standby in another availability zone.

resource "azurerm_private_dns_zone" "database" {
  name                = module.names.postgres_dns_zone
  resource_group_name = local.resource_group
}

resource "azurerm_private_dns_zone_virtual_network_link" "database" {
  name                = "database"
  private_dns_zone_id = azurerm_private_dns_zone.database.id
  virtual_network_id  = azurerm_virtual_network.main.id
}

resource "random_password" "database" {
  length  = 32
  special = false
}

resource "azurerm_postgresql_flexible_server" "main" {
  #checkov:skip=CKV_AZURE_136:Geo-redundant backups are outside the small-workload defaults; backups stay zone-redundant where the region allows.
  #checkov:skip=CKV2_AZURE_57:The server is reached privately through its delegated subnet and private DNS, with public access off; Azure does not support private endpoints for such servers.
  name                          = module.names.postgres_server
  resource_group_name           = local.resource_group
  location                      = var.location
  version                       = var.postgresql_version
  sku_name                      = var.database.sku_name
  storage_mb                    = var.database.storage_mb
  backup_retention_days         = var.database.backup_retention_days
  geo_redundant_backup_enabled  = false
  delegated_subnet_id           = azurerm_subnet.database.id
  private_dns_zone_id           = azurerm_private_dns_zone.database.id
  public_network_access_enabled = false
  administrator_login           = "appadmin"
  administrator_password        = random_password.database.result
  zone                          = var.database.high_availability ? "1" : null

  authentication {
    password_auth_enabled = true
  }

  dynamic "high_availability" {
    for_each = var.database.high_availability ? [1] : []

    content {
      mode                      = "ZoneRedundant"
      standby_availability_zone = "2"
    }
  }

  lifecycle {
    # After a failover the standby is the primary; keep it there rather than
    # moving the server back on the next apply.
    ignore_changes = [zone, high_availability[0].standby_availability_zone]
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.database]
}

resource "azurerm_postgresql_flexible_server_database" "app" {
  name      = "app"
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# Container Apps: the API, its migrations as a job started before each
# deployment, and the frontend, which is the only public entry point when the
# project has one.

resource "azurerm_container_app_environment" "main" {
  name                       = module.names.container_app_environment
  resource_group_name        = local.resource_group
  location                   = var.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  infrastructure_subnet_id   = azurerm_subnet.apps.id

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

resource "azurerm_container_app" "api" {
  name                         = module.names.api_app
  resource_group_name          = local.resource_group
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [data.azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = data.azurerm_container_registry.shared.login_server
    identity = data.azurerm_user_assigned_identity.app.id
  }

  secret {
    name  = "database-url"
    value = local.database_url
  }

  ingress {
    external_enabled = !local.frontend
    target_port      = 8000

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.api_min_replicas
    max_replicas = 3

    container {
      name   = "api"
      image  = var.api_image
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "APP_ENVIRONMENT"
        value = var.environment
      }

      env {
        name        = "APP_DATABASE_URL"
        secret_name = "database-url"
      }

      liveness_probe {
        transport = "HTTP"
        port      = 8000
        path      = "/health/live"
      }

      readiness_probe {
        transport = "HTTP"
        port      = 8000
        path      = "/health/ready"
      }
    }
  }
}

resource "azurerm_container_app_job" "migrate" {
  name                         = module.names.migrate_job
  resource_group_name          = local.resource_group
  location                     = var.location
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 600
  replica_retry_limit          = 0

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [data.azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = data.azurerm_container_registry.shared.login_server
    identity = data.azurerm_user_assigned_identity.app.id
  }

  secret {
    name  = "database-url"
    value = local.database_url
  }

  template {
    container {
      name   = "migrate"
      image  = var.api_image
      args   = var.migrate_command
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "APP_ENVIRONMENT"
        value = var.environment
      }

      env {
        name        = "APP_DATABASE_URL"
        secret_name = "database-url"
      }
    }
  }
}

resource "azurerm_container_app" "web" {
  count = local.frontend ? 1 : 0

  name                         = module.names.web_app
  resource_group_name          = local.resource_group
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [data.azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = data.azurerm_container_registry.shared.login_server
    identity = data.azurerm_user_assigned_identity.app.id
  }

  ingress {
    external_enabled = true
    target_port      = 8080

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.api_min_replicas
    max_replicas = 3

    container {
      name   = "web"
      image  = var.web_image
      cpu    = 0.25
      memory = "0.5Gi"

      # The API's internal HTTPS address: ingress routes by host name, which
      # nginx sends along, and redirects plain HTTP.
      env {
        name  = "API_UPSTREAM"
        value = "https://${azurerm_container_app.api.ingress[0].fqdn}"
      }

      liveness_probe {
        transport = "HTTP"
        port      = 8080
        path      = "/healthz"
      }

      readiness_probe {
        transport = "HTTP"
        port      = 8080
        path      = "/healthz"
      }
    }
  }
}
