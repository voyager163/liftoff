locals {
  dashboard_name            = var.dashboard_name != "" ? var.dashboard_name : "liftoff-telemetry-${var.resource_suffix}"
  dashboard_title           = "Liftoff Telemetry (${var.resource_suffix})"
  dashboard_definition_json = jsonencode(jsondecode(replace(replace(file("${path.module}/dashboard.json"), "__WORKSPACE_ID__", azurerm_log_analytics_workspace.telemetry.id), "__DASHBOARD_TITLE__", local.dashboard_title)))
}

resource "azapi_resource" "telemetry_dashboard" {
  type      = "Microsoft.Dashboard/dashboards@2025-08-01"
  name      = local.dashboard_name
  parent_id = azurerm_resource_group.telemetry.id
  location  = var.location
  tags = merge(local.common_tags, {
    GrafanaDashboardTags = join(",", jsondecode(local.dashboard_definition_json).tags)
  })

  body = {
    properties = {}
  }
}

resource "azapi_resource" "telemetry_dashboard_definition" {
  type      = "Microsoft.Dashboard/dashboards/dashboardDefinitions@2025-09-01-preview"
  name      = "default"
  parent_id = azapi_resource.telemetry_dashboard.id

  body = {
    properties = {
      serializedData = local.dashboard_definition_json
    }
  }
}
