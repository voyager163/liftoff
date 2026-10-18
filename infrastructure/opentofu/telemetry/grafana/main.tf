data "azurerm_resource_group" "telemetry" {
  name = "rg-liftoff-prod"
}

data "azurerm_resources" "telemetry_workspace" {
  name                = "log-liftoff-telemetry-f5be1618"
  resource_group_name = data.azurerm_resource_group.telemetry.name
  type                = "Microsoft.OperationalInsights/workspaces"

  lifecycle {
    postcondition {
      condition = length(self.resources) == 1 && alltrue([
        for resource in self.resources :
        lower(resource.id) == lower("${data.azurerm_resource_group.telemetry.id}/providers/Microsoft.OperationalInsights/workspaces/log-liftoff-telemetry-f5be1618") &&
        lower(resource.name) == "log-liftoff-telemetry-f5be1618" &&
        lower(resource.resource_group_name) == lower(data.azurerm_resource_group.telemetry.name) &&
        lower(resource.type) == "microsoft.operationalinsights/workspaces"
      ])
      error_message = "Grafana requires exactly one existing telemetry workspace at the reviewed resource ID; missing, ambiguous or foreign metadata cannot authorize access."
    }
  }
}

data "azurerm_monitor_data_collection_rule" "telemetry" {
  name                = "dcr-liftoff-telemetry-f5be1618"
  resource_group_name = data.azurerm_resource_group.telemetry.name
}

resource "azurerm_dashboard_grafana" "telemetry" {
  name                              = var.grafana_name
  resource_group_name               = data.azurerm_resource_group.telemetry.name
  location                          = "koreacentral"
  grafana_major_version             = var.grafana_major_version
  sku                               = "Standard"
  sku_size                          = var.sku_size
  api_key_enabled                   = false
  public_network_access_enabled     = true
  deterministic_outbound_ip_enabled = false
  zone_redundancy_enabled           = false
  identity {
    type = "SystemAssigned"
  }
  tags = {
    application = "liftoff"
    component   = "telemetry-dashboard"
    environment = "prod"
    managed-by  = "opentofu"
  }
  lifecycle {
    prevent_destroy = true
    precondition {
      condition = (
        data.azurerm_resource_group.telemetry.location == "koreacentral" &&
        one(data.azurerm_resources.telemetry_workspace.resources).location == "koreacentral" &&
        data.azurerm_monitor_data_collection_rule.telemetry.location == "koreacentral"
      )
      error_message = "Existing telemetry placement changed; stop for ownership/region review."
    }
  }
}

resource "azurerm_role_assignment" "logs_reader" {
  scope                = one(data.azurerm_resources.telemetry_workspace.resources).id
  role_definition_name = "Log Analytics Reader"
  principal_id         = azurerm_dashboard_grafana.telemetry.identity[0].principal_id
}

resource "azurerm_role_assignment" "transform_metrics_reader" {
  scope                = data.azurerm_monitor_data_collection_rule.telemetry.id
  role_definition_name = "Monitoring Reader"
  principal_id         = azurerm_dashboard_grafana.telemetry.identity[0].principal_id
}

resource "azurerm_role_assignment" "grafana_access" {
  for_each             = var.grafana_access
  scope                = azurerm_dashboard_grafana.telemetry.id
  role_definition_name = each.value
  principal_id         = each.key
}

output "grafana_endpoint" {
  value = azurerm_dashboard_grafana.telemetry.endpoint
}

output "workspace_resource_id" {
  value = one(data.azurerm_resources.telemetry_workspace.resources).id
}
