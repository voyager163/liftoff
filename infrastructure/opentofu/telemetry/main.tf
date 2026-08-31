locals {
  resource_group_name = "rg-liftoff-prod"
  identity_name       = "id-liftoff-telemetry-${var.resource_suffix}"
  workspace_name      = "log-liftoff-telemetry-${var.resource_suffix}"
  dce_name            = "dce-liftoff-telemetry-${var.resource_suffix}"
  dcr_name            = "dcr-liftoff-telemetry-${var.resource_suffix}"
  input_stream_name   = "Custom-LiftoffCommandEvents"
  output_stream_name  = "Custom-LiftoffCommandEvents_CL"
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

resource "azurerm_log_analytics_workspace" "telemetry" {
  name                           = local.workspace_name
  resource_group_name            = azurerm_resource_group.telemetry.name
  location                       = var.location
  sku                            = "PerGB2018"
  retention_in_days              = 180
  daily_quota_gb                 = var.daily_quota_gb
  local_authentication_enabled   = false
  internet_ingestion_access_type = "Enabled"
  internet_query_access_type     = "Enabled"
  tags                           = local.common_tags
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
