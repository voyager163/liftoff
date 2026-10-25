# The values each environment's backend.hcl needs.

output "state_resource_group" {
  value = azurerm_resource_group.shared.name
}

output "state_storage_account" {
  value = azurerm_storage_account.state.name
}

output "state_container" {
  value = azurerm_storage_container.state.name
}

output "container_registry" {
  value = azurerm_container_registry.shared.login_server
}
