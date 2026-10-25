# The {{liftoff.environment}} environment. Its settings live here; what it is
# made of lives in the shared module, so environments differ only on purpose.

module "app" {
  source = "../../modules/app"

  project         = "{{liftoff.name}}"
  environment     = "{{liftoff.environment}}"
  subscription_id = var.subscription_id
  location        = var.location

  api_image           = var.api_image
  api_min_replicas    = {{liftoff.apiMinReplicas}}
  migrate_command     = {{liftoff.migrateCommand}}
  database_url_scheme = "{{liftoff.databaseUrlScheme}}"

  database = {
    sku_name              = "{{liftoff.databaseSku}}"
    storage_mb            = 32768
    high_availability     = {{liftoff.databaseHighAvailability}}
    backup_retention_days = {{liftoff.databaseBackupRetentionDays}}
  }
{{liftoff.webImageArgument}}}
