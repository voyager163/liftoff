output "url" {
  description = "Where the application is served: the frontend when there is one, otherwise the API."
  value       = "https://${local.frontend ? azurerm_container_app.web[0].ingress[0].fqdn : azurerm_container_app.api.ingress[0].fqdn}"
}

output "migrate_job" {
  description = "Start it with az containerapp job start before deploying a new API image."
  value       = azurerm_container_app_job.migrate.name
}

output "resource_group" {
  value = local.resource_group
}

output "api_app" {
  description = "The API's container app, which deployments update by image digest."
  value       = azurerm_container_app.api.name
}

output "web_app" {
  description = "The frontend's container app, if there is one."
  value       = local.frontend ? azurerm_container_app.web[0].name : null
}
