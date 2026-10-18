mock_provider "azurerm" {
  mock_data "azurerm_resource_group" {
    defaults = {
      location = "koreacentral"
      id       = "/subscriptions/4158373b-2ebe-4b5f-9176-187d49e0ba84/resourceGroups/rg-liftoff-prod"
    }
  }
  mock_data "azurerm_resources" {
    defaults = {
      resources = [{
        name                = "log-liftoff-telemetry-f5be1618"
        id                  = "/subscriptions/4158373b-2ebe-4b5f-9176-187d49e0ba84/resourceGroups/rg-liftoff-prod/providers/Microsoft.OperationalInsights/workspaces/log-liftoff-telemetry-f5be1618"
        location            = "koreacentral"
        type                = "Microsoft.OperationalInsights/workspaces"
        resource_group_name = "rg-liftoff-prod"
        tags                = {}
      }]
    }
  }
  mock_data "azurerm_monitor_data_collection_rule" {
    defaults = {
      location = "koreacentral"
      id       = "/subscriptions/4158373b-2ebe-4b5f-9176-187d49e0ba84/resourceGroups/rg-liftoff-prod/providers/Microsoft.Insights/dataCollectionRules/dcr-liftoff-telemetry-f5be1618"
    }
  }
}

variables {
  grafana_name          = "synthetic-grafana"
  sku_size              = "X1"
  grafana_major_version = 12
}

run "offline_scoped_identity" {
  command = plan
  assert {
    condition     = azurerm_role_assignment.logs_reader.scope == one(data.azurerm_resources.telemetry_workspace.resources).id && azurerm_role_assignment.logs_reader.role_definition_name == "Log Analytics Reader"
    error_message = "Grafana Logs read authority must stay scoped to the exact workspace."
  }
  assert {
    condition     = azurerm_role_assignment.transform_metrics_reader.scope == data.azurerm_monitor_data_collection_rule.telemetry.id && azurerm_role_assignment.transform_metrics_reader.role_definition_name == "Monitoring Reader"
    error_message = "Transform metrics read authority must target only the existing DCR, never the group or subscription."
  }
  assert {
    condition     = !azurerm_dashboard_grafana.telemetry.api_key_enabled && !azurerm_dashboard_grafana.telemetry.zone_redundancy_enabled && length(azurerm_role_assignment.grafana_access) == 0
    error_message = "No implicit API key, costly redundancy or operator access grant."
  }
}

run "invalid_role" {
  command = plan
  variables {
    grafana_access = { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" = "Owner" }
  }
  expect_failures = [var.grafana_access]
}

run "invalid_size" {
  command = plan
  variables {
    sku_size = "Essential"
  }
  expect_failures = [var.sku_size]
}

run "existing_region_drift" {
  command = plan
  override_data {
    target = data.azurerm_resource_group.telemetry
    values = {
      location = "eastus"
      id       = "/subscriptions/4158373b-2ebe-4b5f-9176-187d49e0ba84/resourceGroups/rg-liftoff-prod"
    }
  }
  expect_failures = [azurerm_dashboard_grafana.telemetry]
}

run "existing_dcr_region_drift" {
  command = plan
  override_data {
    target = data.azurerm_monitor_data_collection_rule.telemetry
    values = { location = "eastus" }
  }
  expect_failures = [azurerm_dashboard_grafana.telemetry]
}

run "missing_workspace" {
  command = plan
  override_data {
    target = data.azurerm_resources.telemetry_workspace
    values = { resources = [] }
  }
  expect_failures = [data.azurerm_resources.telemetry_workspace]
}

run "ambiguous_workspace" {
  command = plan
  override_data {
    target = data.azurerm_resources.telemetry_workspace
    values = {
      resources = [{
        name                = "log-liftoff-telemetry-f5be1618"
        id                  = "/subscriptions/4158373b-2ebe-4b5f-9176-187d49e0ba84/resourceGroups/rg-liftoff-prod/providers/Microsoft.OperationalInsights/workspaces/log-liftoff-telemetry-f5be1618"
        location            = "koreacentral"
        type                = "Microsoft.OperationalInsights/workspaces"
        resource_group_name = "rg-liftoff-prod"
        tags                = {}
        }, {
        name                = "log-liftoff-telemetry-f5be1618"
        id                  = "/subscriptions/4158373b-2ebe-4b5f-9176-187d49e0ba84/resourceGroups/rg-liftoff-prod/providers/Microsoft.OperationalInsights/workspaces/log-liftoff-telemetry-f5be1618"
        location            = "koreacentral"
        type                = "Microsoft.OperationalInsights/workspaces"
        resource_group_name = "rg-liftoff-prod"
        tags                = {}
      }]
    }
  }
  expect_failures = [data.azurerm_resources.telemetry_workspace]
}

run "foreign_workspace_identity" {
  command = plan
  override_data {
    target = data.azurerm_resources.telemetry_workspace
    values = {
      resources = [{
        name                = "log-liftoff-telemetry-f5be1618"
        id                  = "/subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourceGroups/rg-liftoff-prod/providers/Microsoft.OperationalInsights/workspaces/log-liftoff-telemetry-f5be1618"
        location            = "koreacentral"
        type                = "Microsoft.OperationalInsights/workspaces"
        resource_group_name = "rg-liftoff-prod"
        tags                = {}
      }]
    }
  }
  expect_failures = [data.azurerm_resources.telemetry_workspace]
}

run "foreign_workspace_name" {
  command = plan
  override_data {
    target = data.azurerm_resources.telemetry_workspace
    values = {
      resources = [{
        name                = "other-workspace"
        id                  = "/subscriptions/4158373b-2ebe-4b5f-9176-187d49e0ba84/resourceGroups/rg-liftoff-prod/providers/Microsoft.OperationalInsights/workspaces/log-liftoff-telemetry-f5be1618"
        location            = "koreacentral"
        type                = "Microsoft.OperationalInsights/workspaces"
        resource_group_name = "rg-liftoff-prod"
        tags                = {}
      }]
    }
  }
  expect_failures = [data.azurerm_resources.telemetry_workspace]
}

run "foreign_workspace_group" {
  command = plan
  override_data {
    target = data.azurerm_resources.telemetry_workspace
    values = {
      resources = [{
        name                = "log-liftoff-telemetry-f5be1618"
        id                  = "/subscriptions/4158373b-2ebe-4b5f-9176-187d49e0ba84/resourceGroups/rg-liftoff-prod/providers/Microsoft.OperationalInsights/workspaces/log-liftoff-telemetry-f5be1618"
        location            = "koreacentral"
        type                = "Microsoft.OperationalInsights/workspaces"
        resource_group_name = "other-group"
        tags                = {}
      }]
    }
  }
  expect_failures = [data.azurerm_resources.telemetry_workspace]
}

run "foreign_workspace_type" {
  command = plan
  override_data {
    target = data.azurerm_resources.telemetry_workspace
    values = {
      resources = [{
        name                = "log-liftoff-telemetry-f5be1618"
        id                  = "/subscriptions/4158373b-2ebe-4b5f-9176-187d49e0ba84/resourceGroups/rg-liftoff-prod/providers/Microsoft.OperationalInsights/workspaces/log-liftoff-telemetry-f5be1618"
        location            = "koreacentral"
        type                = "Microsoft.Storage/storageAccounts"
        resource_group_name = "rg-liftoff-prod"
        tags                = {}
      }]
    }
  }
  expect_failures = [data.azurerm_resources.telemetry_workspace]
}

run "workspace_region_drift" {
  command = plan
  override_data {
    target = data.azurerm_resources.telemetry_workspace
    values = {
      resources = [{
        name                = "log-liftoff-telemetry-f5be1618"
        id                  = "/subscriptions/4158373b-2ebe-4b5f-9176-187d49e0ba84/resourceGroups/rg-liftoff-prod/providers/Microsoft.OperationalInsights/workspaces/log-liftoff-telemetry-f5be1618"
        location            = "eastus"
        type                = "Microsoft.OperationalInsights/workspaces"
        resource_group_name = "rg-liftoff-prod"
        tags                = {}
      }]
    }
  }
  expect_failures = [azurerm_dashboard_grafana.telemetry]
}

run "workspace_arm_case_variant" {
  command = plan
  override_data {
    target = data.azurerm_resources.telemetry_workspace
    values = {
      resources = [{
        name                = "LOG-LIFTOFF-TELEMETRY-F5BE1618"
        id                  = "/SUBSCRIPTIONS/4158373B-2EBE-4B5F-9176-187D49E0BA84/RESOURCEGROUPS/RG-LIFTOFF-PROD/PROVIDERS/MICROSOFT.OPERATIONALINSIGHTS/WORKSPACES/LOG-LIFTOFF-TELEMETRY-F5BE1618"
        location            = "koreacentral"
        type                = "MICROSOFT.OPERATIONALINSIGHTS/WORKSPACES"
        resource_group_name = "RG-LIFTOFF-PROD"
        tags                = {}
      }]
    }
  }
  assert {
    condition     = lower(azurerm_role_assignment.logs_reader.scope) == lower(one(data.azurerm_resources.telemetry_workspace.resources).id)
    error_message = "ARM case variations must retain exactly the independently selected workspace scope."
  }
}
