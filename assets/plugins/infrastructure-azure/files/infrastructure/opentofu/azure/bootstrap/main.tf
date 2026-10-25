# What every environment needs before its own root can be applied: storage for
# the environments' OpenTofu state, the container registry the images are
# promoted through, and each environment's resource group and app identity.

data "azurerm_client_config" "current" {}

module "shared" {
  source = "../modules/naming"

  project         = local.project
  subscription_id = data.azurerm_client_config.current.subscription_id
}

module "environment" {
  source   = "../modules/naming"
  for_each = toset(local.environments)

  project         = local.project
  environment     = each.key
  subscription_id = data.azurerm_client_config.current.subscription_id
}

resource "azurerm_resource_group" "shared" {
  name     = module.shared.resource_group
  location = var.location
}

# State is zone-redundant in every environment, versioned, kept for 30 days
# after deletion and reachable only with Microsoft Entra ID, never with keys.
resource "azurerm_storage_account" "state" {
  #checkov:skip=CKV_AZURE_33:Queue logging does not apply: the account holds only blobs.
  #checkov:skip=CKV_AZURE_43:The name comes from the naming module, which keeps it to 3 to 24 lowercase letters and digits.
  #checkov:skip=CKV_AZURE_59:GitHub-hosted runners reach the state over the internet; access needs Microsoft Entra ID and keys are disabled.
  #checkov:skip=CKV_AZURE_206:Zone-redundant storage is the agreed redundancy for state.
  #checkov:skip=CKV2_AZURE_1:Microsoft-managed keys encrypt the state; customer-managed keys need a key vault the project does not have yet.
  #checkov:skip=CKV2_AZURE_33:A private endpoint needs a private runner network, which the project does not have yet.
  name                              = module.shared.state_storage_account
  resource_group_name               = azurerm_resource_group.shared.name
  location                          = azurerm_resource_group.shared.location
  account_kind                      = "StorageV2"
  account_tier                      = "Standard"
  account_replication_type          = "ZRS"
  min_tls_version                   = "TLS1_2"
  https_traffic_only_enabled        = true
  shared_access_key_enabled         = false
  default_to_oauth_authentication   = true
  allow_nested_items_to_be_public   = false
  infrastructure_encryption_enabled = true

  blob_properties {
    versioning_enabled = true

    delete_retention_policy {
      days = 30
    }

    container_delete_retention_policy {
      days = 30
    }
  }

  sas_policy {
    expiration_period = "01.00:00:00"
  }
}

# Whoever applies bootstrap can read and write the state, which takes Microsoft
# Entra ID roles because keys are disabled. Grant others the same role on the
# container.
resource "azurerm_role_assignment" "state" {
  scope                = azurerm_storage_container.state.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_storage_container" "state" {
  #checkov:skip=CKV2_AZURE_21:Blob read logging needs a diagnostic setting and workspace the shared resources do not have.
  name                  = module.shared.state_container
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"
}

# Images are built once and promoted by digest, so every environment pulls from
# one registry, with its own identity rather than a password.
resource "azurerm_container_registry" "shared" {
  #checkov:skip=CKV_AZURE_139:Public network access is needed by GitHub-hosted runners and needs Premium for private endpoints.
  #checkov:skip=CKV_AZURE_163:Vulnerability scanning is done by Trivy when images are built.
  #checkov:skip=CKV_AZURE_164:Content trust needs Premium; images are pinned by digest instead.
  #checkov:skip=CKV_AZURE_165:Geo-replication needs Premium and is outside the small-workload defaults.
  #checkov:skip=CKV_AZURE_166:Quarantine needs Premium; images are scanned when they are built.
  #checkov:skip=CKV_AZURE_167:Retention of untagged manifests needs Premium.
  #checkov:skip=CKV_AZURE_233:Zone redundancy needs Premium and is outside the small-workload defaults.
  #checkov:skip=CKV_AZURE_237:Dedicated data endpoints need Premium.
  name                          = module.shared.container_registry
  resource_group_name           = azurerm_resource_group.shared.name
  location                      = azurerm_resource_group.shared.location
  sku                           = "Basic"
  admin_enabled                 = false
  anonymous_pull_enabled        = false
  public_network_access_enabled = true
}

resource "azurerm_resource_group" "environment" {
  for_each = module.environment

  name     = each.value.resource_group
  location = var.location
}

# The identity each environment's containers run as, allowed only to pull images.
resource "azurerm_user_assigned_identity" "app" {
  for_each = module.environment

  name                = each.value.app_identity
  resource_group_name = azurerm_resource_group.environment[each.key].name
  location            = azurerm_resource_group.environment[each.key].location
}

resource "azurerm_role_assignment" "pull" {
  for_each = azurerm_user_assigned_identity.app

  scope                = azurerm_container_registry.shared.id
  role_definition_name = "AcrPull"
  principal_id         = each.value.principal_id
}
