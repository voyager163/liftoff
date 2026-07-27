locals {
  resource_group_name  = "rg-liftoff-tfstate"
  storage_account_name = "stliftofftfstate${var.resource_suffix}"
  container_name       = "tfstate"
  perimeter_name       = "nsp-liftoff-telemetry-${var.resource_suffix}"
  perimeter_profile    = "telemetry-storage"
  common_tags = {
    application = "liftoff"
    component   = "opentofu-state"
    environment = "prod"
    managed-by  = "opentofu"
  }
}

resource "azurerm_resource_group" "state" {
  name     = local.resource_group_name
  location = var.location
  tags     = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_network_security_perimeter" "telemetry" {
  name                = local.perimeter_name
  resource_group_name = azurerm_resource_group.state.name
  location            = var.location
  tags                = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_network_security_perimeter_profile" "telemetry_storage" {
  name                          = local.perimeter_profile
  network_security_perimeter_id = azurerm_network_security_perimeter.telemetry.id

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_network_security_perimeter_access_rule" "operators" {
  name                                  = "operator-cidrs"
  network_security_perimeter_profile_id = azurerm_network_security_perimeter_profile.telemetry_storage.id
  direction                             = "Inbound"
  address_prefixes                      = var.operator_cidrs
}

resource "azapi_resource" "state_storage" {
  type      = "Microsoft.Storage/storageAccounts@2023-05-01"
  name      = local.storage_account_name
  parent_id = azurerm_resource_group.state.id
  location  = var.location
  tags      = local.common_tags
  body = {
    kind = "StorageV2"
    sku = {
      name = "Standard_LRS"
    }
    properties = {
      accessTier                   = "Hot"
      allowBlobPublicAccess        = false
      allowSharedKeyAccess         = false
      defaultToOAuthAuthentication = true
      minimumTlsVersion            = "TLS1_2"
      publicNetworkAccess          = "SecuredByPerimeter"
      supportsHttpsTrafficOnly     = true
      encryption = {
        keySource                       = "Microsoft.Storage"
        requireInfrastructureEncryption = true
        services = {
          blob = {
            enabled = true
          }
          file = {
            enabled = true
          }
        }
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_network_security_perimeter_association" "state_storage" {
  name                                  = "state-storage"
  access_mode                           = "Enforced"
  network_security_perimeter_profile_id = azurerm_network_security_perimeter_profile.telemetry_storage.id
  resource_id                           = azapi_resource.state_storage.id

  depends_on = [
    azurerm_network_security_perimeter_access_rule.operators
  ]
}

resource "azapi_update_resource" "blob_service" {
  type        = "Microsoft.Storage/storageAccounts/blobServices@2023-05-01"
  resource_id = "${azapi_resource.state_storage.id}/blobServices/default"
  body = {
    properties = {
      isVersioningEnabled = true
      containerDeleteRetentionPolicy = {
        enabled = true
        days    = 30
      }
      deleteRetentionPolicy = {
        enabled = true
        days    = 30
      }
    }
  }

  depends_on = [
    azurerm_network_security_perimeter_association.state_storage
  ]
}

resource "azapi_resource" "state_container" {
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01"
  name      = local.container_name
  parent_id = "${azapi_resource.state_storage.id}/blobServices/default"
  body = {
    properties = {
      publicAccess = "None"
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [
    azapi_update_resource.blob_service
  ]
}

data "azurerm_client_config" "current" {}

resource "azurerm_role_assignment" "state_blob_contributor" {
  scope                = azapi_resource.state_storage.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "time_sleep" "role_propagation" {
  create_duration = "10m"
  triggers = {
    role_assignment_id = azurerm_role_assignment.state_blob_contributor.id
  }
}
