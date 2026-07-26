locals {
  resource_group_name       = "rg-liftoff-prod"
  function_name             = "func-liftoff-telemetry-${var.resource_suffix}"
  function_plan_name        = "plan-liftoff-telemetry-${var.resource_suffix}"
  identity_name             = "id-liftoff-telemetry-${var.resource_suffix}"
  storage_account_name      = "stliftoff${var.resource_suffix}"
  deployment_container_name = "telemetry-function"
  workspace_name            = "log-liftoff-telemetry-${var.resource_suffix}"
  dce_name                  = "dce-liftoff-telemetry-${var.resource_suffix}"
  dcr_name                  = "dcr-liftoff-telemetry-${var.resource_suffix}"
  input_stream_name         = "Custom-LiftoffCommandEvents"
  output_stream_name        = "Custom-LiftoffCommandEvents_CL"
  function_package_dir      = "${path.module}/../../../services/telemetry-ingest/build/package"
  function_package_zip      = "${path.module}/../../../services/telemetry-ingest/build/telemetry-ingest.zip"
  request_body_size_limit   = "1024"
  perimeter_profile_id      = "/subscriptions/${var.subscription_id}/resourceGroups/rg-liftoff-tfstate/providers/Microsoft.Network/networkSecurityPerimeters/nsp-liftoff-telemetry-${var.resource_suffix}/profiles/telemetry-storage"
  common_tags = {
    application = "liftoff"
    component   = "cli-telemetry"
    environment = "prod"
    managed-by  = "opentofu"
  }
}

resource "azurerm_resource_group" "telemetry" {
  name     = local.resource_group_name
  location = var.location
  tags     = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_user_assigned_identity" "telemetry" {
  name                = local.identity_name
  location            = var.location
  resource_group_name = azurerm_resource_group.telemetry.name
  tags                = local.common_tags
}

resource "azapi_resource" "telemetry_storage" {
  type      = "Microsoft.Storage/storageAccounts@2023-05-01"
  name      = local.storage_account_name
  parent_id = azurerm_resource_group.telemetry.id
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
    }
  }
}

resource "azurerm_network_security_perimeter_association" "telemetry_storage" {
  name                                  = "telemetry-storage"
  access_mode                           = "Enforced"
  network_security_perimeter_profile_id = local.perimeter_profile_id
  resource_id                           = azapi_resource.telemetry_storage.id
}

resource "azapi_update_resource" "telemetry_blob_service" {
  type        = "Microsoft.Storage/storageAccounts/blobServices@2023-05-01"
  resource_id = "${azapi_resource.telemetry_storage.id}/blobServices/default"
  body = {
    properties = {}
  }

  depends_on = [
    azurerm_network_security_perimeter_association.telemetry_storage
  ]
}

resource "azapi_resource" "function_package_container" {
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01"
  name      = local.deployment_container_name
  parent_id = "${azapi_resource.telemetry_storage.id}/blobServices/default"
  body = {
    properties = {
      publicAccess = "None"
    }
  }

  depends_on = [
    azapi_update_resource.telemetry_blob_service
  ]
}

resource "azurerm_role_assignment" "storage_blob_owner" {
  scope                = azapi_resource.telemetry_storage.id
  role_definition_name = "Storage Blob Data Owner"
  principal_id         = azurerm_user_assigned_identity.telemetry.principal_id
}

data "azurerm_client_config" "current" {}

resource "azurerm_role_assignment" "deployment_blob_contributor" {
  scope                = azapi_resource.telemetry_storage.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_log_analytics_workspace" "telemetry" {
  name                         = local.workspace_name
  resource_group_name          = azurerm_resource_group.telemetry.name
  location                     = var.location
  sku                          = "PerGB2018"
  retention_in_days            = 180
  daily_quota_gb               = var.daily_quota_gb
  local_authentication_enabled = false
  internet_ingestion_enabled   = true
  internet_query_enabled       = true
  tags                         = local.common_tags
}

resource "azurerm_log_analytics_workspace_table_custom_log" "command_events" {
  name                    = "LiftoffCommandEvents_CL"
  workspace_id            = azurerm_log_analytics_workspace.telemetry.id
  plan                    = "Analytics"
  retention_in_days       = 180
  total_retention_in_days = 180
  description             = "Non-identifying Liftoff CLI command and zero/nonzero outcome aggregates."

  column {
    name = "TimeGenerated"
    type = "dateTime"
  }
  column {
    name = "EventName"
    type = "string"
  }
  column {
    name = "SchemaVersion"
    type = "int"
  }
  column {
    name = "Command"
    type = "string"
  }
  column {
    name = "CliVersion"
    type = "string"
  }
  column {
    name = "Outcome"
    type = "string"
  }
}

resource "azurerm_monitor_data_collection_endpoint" "telemetry" {
  name                          = local.dce_name
  resource_group_name           = azurerm_resource_group.telemetry.name
  location                      = var.location
  kind                          = "Linux"
  public_network_access_enabled = true
  description                   = "Regional endpoint for validated Liftoff CLI command events."
  tags                          = local.common_tags
}

resource "azurerm_monitor_data_collection_rule" "telemetry" {
  name                        = local.dcr_name
  resource_group_name         = azurerm_resource_group.telemetry.name
  location                    = var.location
  data_collection_endpoint_id = azurerm_monitor_data_collection_endpoint.telemetry.id
  description                 = "Projects only the six approved Liftoff telemetry columns."
  tags                        = local.common_tags

  destinations {
    log_analytics {
      name                  = "liftoff-command-events"
      workspace_resource_id = azurerm_log_analytics_workspace.telemetry.id
    }
  }

  data_flow {
    streams       = [local.input_stream_name]
    destinations  = ["liftoff-command-events"]
    output_stream = local.output_stream_name
    transform_kql = "source | project TimeGenerated, EventName, SchemaVersion, Command, CliVersion, Outcome"
  }

  stream_declaration {
    stream_name = local.input_stream_name

    column {
      name = "TimeGenerated"
      type = "datetime"
    }
    column {
      name = "EventName"
      type = "string"
    }
    column {
      name = "SchemaVersion"
      type = "int"
    }
    column {
      name = "Command"
      type = "string"
    }
    column {
      name = "CliVersion"
      type = "string"
    }
    column {
      name = "Outcome"
      type = "string"
    }
  }

  depends_on = [
    azurerm_log_analytics_workspace_table_custom_log.command_events
  ]
}

resource "azurerm_role_assignment" "monitor_ingestion" {
  scope                = azurerm_monitor_data_collection_rule.telemetry.id
  role_definition_name = "Monitoring Metrics Publisher"
  principal_id         = azurerm_user_assigned_identity.telemetry.principal_id
}

resource "azurerm_service_plan" "telemetry" {
  name                = local.function_plan_name
  resource_group_name = azurerm_resource_group.telemetry.name
  location            = var.location
  os_type             = "Linux"
  sku_name            = "FC1"
  tags                = local.common_tags
}

data "archive_file" "function_package" {
  type        = "zip"
  source_dir  = local.function_package_dir
  output_path = local.function_package_zip
}

resource "azurerm_storage_blob" "function_package" {
  name                 = "${substr(data.archive_file.function_package.output_sha256, 0, 16)}/released-package.zip"
  storage_container_id = azapi_resource.function_package_container.id
  type                 = "Block"
  source               = data.archive_file.function_package.output_path

  lifecycle {
    create_before_destroy = true
    ignore_changes = [
      name,
      source
    ]
  }

  depends_on = [
    azapi_resource.function_package_container,
    azurerm_network_security_perimeter_association.telemetry_storage,
    time_sleep.storage_role_propagation
  ]
}

resource "azapi_resource" "telemetry_function" {
  type      = "Microsoft.Web/sites@2024-04-01"
  name      = local.function_name
  parent_id = azurerm_resource_group.telemetry.id
  location  = var.location
  tags      = local.common_tags

  schema_validation_enabled = false
  ignore_casing             = true
  body = {
    kind = "functionapp,linux"
    identity = {
      type = "UserAssigned"
      userAssignedIdentities = {
        (azurerm_user_assigned_identity.telemetry.id) = {}
      }
    }
    properties = {
      serverFarmId        = azurerm_service_plan.telemetry.id
      enabled             = var.ingestion_enabled
      httpsOnly           = true
      publicNetworkAccess = var.ingestion_enabled ? "Enabled" : "Disabled"
      functionAppConfig = {
        deployment = {
          storage = {
            type  = "blobContainer"
            value = "https://${local.storage_account_name}.blob.core.windows.net/${local.deployment_container_name}"
            authentication = {
              type                           = "UserAssignedIdentity"
              userAssignedIdentityResourceId = azurerm_user_assigned_identity.telemetry.id
            }
          }
        }
        scaleAndConcurrency = {
          maximumInstanceCount = var.maximum_instance_count
          instanceMemoryMB     = 512
        }
        runtime = {
          name    = "node"
          version = "22"
        }
      }
      siteConfig = {
        http20Enabled          = true
        minTlsVersion          = "1.2"
        remoteDebuggingEnabled = false
        scmMinTlsVersion       = "1.2"
        appSettings = [
          {
            name  = "AZURE_CLIENT_ID"
            value = azurerm_user_assigned_identity.telemetry.client_id
          },
          {
            name  = "AzureWebJobsStorage__accountName"
            value = local.storage_account_name
          },
          {
            name  = "AzureWebJobsStorage__clientId"
            value = azurerm_user_assigned_identity.telemetry.client_id
          },
          {
            name  = "AzureWebJobsStorage__credential"
            value = "managedidentity"
          },
          {
            name  = "FUNCTIONS_REQUEST_BODY_SIZE_LIMIT"
            value = local.request_body_size_limit
          },
          {
            name  = "TELEMETRY_DCE_ENDPOINT"
            value = azurerm_monitor_data_collection_endpoint.telemetry.logs_ingestion_endpoint
          },
          {
            name  = "TELEMETRY_DCR_IMMUTABLE_ID"
            value = azurerm_monitor_data_collection_rule.telemetry.immutable_id
          },
          {
            name  = "TELEMETRY_STREAM_NAME"
            value = local.input_stream_name
          }
        ]
      }
    }
  }

  depends_on = [
    azapi_resource.function_package_container,
    azurerm_role_assignment.monitor_ingestion,
    azurerm_network_security_perimeter_association.telemetry_storage,
    azurerm_role_assignment.storage_blob_owner
  ]
}

resource "azapi_update_resource" "scm_basic_auth" {
  type        = "Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01"
  resource_id = "${azapi_resource.telemetry_function.id}/basicPublishingCredentialsPolicies/scm"
  body = {
    properties = {
      allow = false
    }
  }
}

resource "azapi_update_resource" "ftp_basic_auth" {
  type        = "Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01"
  resource_id = "${azapi_resource.telemetry_function.id}/basicPublishingCredentialsPolicies/ftp"
  body = {
    properties = {
      allow = false
    }
  }
}

resource "time_sleep" "storage_role_propagation" {
  create_duration = "10m"
  triggers = {
    deployment_role_assignment_id = azurerm_role_assignment.deployment_blob_contributor.id
    function_storage_role_id      = azurerm_role_assignment.storage_blob_owner.id
    monitor_ingestion_role_id     = azurerm_role_assignment.monitor_ingestion.id
  }

  depends_on = [
    azurerm_role_assignment.deployment_blob_contributor,
    azurerm_role_assignment.monitor_ingestion,
    azurerm_role_assignment.storage_blob_owner
  ]
}

resource "azapi_resource_action" "function_deployment" {
  count = var.legacy_onedeploy_enabled ? 1 : 0

  type        = "Microsoft.Web/sites@2022-09-01"
  resource_id = azapi_resource.telemetry_function.id
  action      = "extensions/onedeploy"
  method      = "PUT"
  when        = "apply"

  body = {
    properties = {
      packageUri  = azurerm_storage_blob.function_package.url
      remoteBuild = false
      type        = "zip"
    }
  }

  depends_on = [
    azapi_update_resource.ftp_basic_auth,
    azapi_update_resource.scm_basic_auth,
    time_sleep.storage_role_propagation
  ]
}
