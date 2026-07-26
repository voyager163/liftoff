output "telemetry_endpoint" {
  description = "Public HTTPS endpoint compiled into a Liftoff release after verification."
  value       = "https://${azurerm_container_app.telemetry.ingress[0].fqdn}/api/events"
}

output "resource_group_name" {
  description = "Fixed production resource group managed by this OpenTofu root."
  value       = azurerm_resource_group.telemetry.name
}

output "container_app_id" {
  description = "Telemetry Container App resource ID."
  value       = azurerm_container_app.telemetry.id
}

output "container_registry_id" {
  description = "Private telemetry image registry resource ID."
  value       = azurerm_container_registry.telemetry.id
}

output "log_analytics_workspace_id" {
  description = "Product telemetry workspace resource ID."
  value       = azurerm_log_analytics_workspace.telemetry.id
}

output "data_collection_rule_id" {
  description = "Data collection rule resource ID."
  value       = azurerm_monitor_data_collection_rule.telemetry.id
}
