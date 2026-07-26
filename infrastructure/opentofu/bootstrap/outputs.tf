output "resource_group_name" {
  description = "Protected resource group for Liftoff OpenTofu state."
  value       = azurerm_resource_group.state.name
}

output "storage_account_name" {
  description = "Storage account used by the production OpenTofu backend."
  value       = local.storage_account_name
}

output "container_name" {
  description = "Private production state container."
  value       = local.container_name
}

output "network_security_perimeter_id" {
  description = "Protected perimeter retained for OpenTofu state storage."
  value       = azurerm_network_security_perimeter.telemetry.id
}

output "network_security_perimeter_profile_id" {
  description = "Enforced profile used by both Liftoff storage accounts."
  value       = azurerm_network_security_perimeter_profile.telemetry_storage.id
}
