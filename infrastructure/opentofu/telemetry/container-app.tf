locals {
  container_registry_name = "acrliftoff${var.resource_suffix}"
  container_environment   = "cae-liftoff-telemetry-${var.resource_suffix}"
  container_app_name      = "ca-liftoff-telemetry-${var.resource_suffix}"
  container_name          = "telemetry-ingest"
  container_port          = 8080
  image_repository        = "telemetry-ingest"
  image_tag               = var.source_revision
  image_name              = "${local.image_repository}:${local.image_tag}"
  image_source_context    = "https://github.com/voyager163/liftoff.git#${var.source_revision}"
  image_build_task_name   = "build-${substr(var.source_revision, 0, 12)}"
}

resource "azurerm_container_registry" "telemetry" {
  name                          = local.container_registry_name
  resource_group_name           = azurerm_resource_group.telemetry.name
  location                      = var.location
  sku                           = "Basic"
  admin_enabled                 = false
  anonymous_pull_enabled        = false
  public_network_access_enabled = true
  tags                          = local.common_tags
}

resource "azapi_resource" "telemetry_image_build_task" {
  type      = "Microsoft.ContainerRegistry/registries/tasks@2019-04-01"
  name      = local.image_build_task_name
  parent_id = azurerm_container_registry.telemetry.id
  location  = var.location
  tags      = local.common_tags
  body = {
    properties = {
      agentConfiguration = {
        cpu = 2
      }
      credentials = {
        sourceRegistry = {
          loginMode = "Default"
        }
      }
      platform = {
        architecture = "amd64"
        os           = "Linux"
      }
      status = "Enabled"
      step = {
        contextPath    = local.image_source_context
        dockerFilePath = "services/telemetry-ingest/Dockerfile"
        imageNames     = [local.image_name]
        isPushEnabled  = true
        noCache        = false
        type           = "Docker"
      }
      timeout = 1800
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "azurerm_container_registry_task_schedule_run_now" "telemetry_image" {
  container_registry_task_id = azapi_resource.telemetry_image_build_task.id

  timeouts {
    create = "45m"
  }
}

resource "azurerm_role_assignment" "container_registry_pull" {
  scope                = azurerm_container_registry.telemetry.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.telemetry.principal_id
}

resource "time_sleep" "container_registry_pull_propagation" {
  create_duration = "5m"
  triggers = {
    role_assignment_id = azurerm_role_assignment.container_registry_pull.id
  }
}

resource "azurerm_container_app_environment" "telemetry" {
  name                = local.container_environment
  resource_group_name = azurerm_resource_group.telemetry.name
  location            = var.location
  logs_destination    = ""
  tags                = local.common_tags

  lifecycle {
    ignore_changes = [workload_profile]
  }
}

resource "azurerm_container_app" "telemetry" {
  name                         = local.container_app_name
  container_app_environment_id = azurerm_container_app_environment.telemetry.id
  resource_group_name          = azurerm_resource_group.telemetry.name
  revision_mode                = "Single"
  tags                         = local.common_tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.telemetry.id]
  }

  registry {
    server   = azurerm_container_registry.telemetry.login_server
    identity = azurerm_user_assigned_identity.telemetry.id
  }

  ingress {
    allow_insecure_connections = false
    external_enabled           = var.ingestion_enabled
    target_port                = local.container_port
    transport                  = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas                     = 1
    max_replicas                     = 5
    polling_interval_in_seconds      = 15
    cooldown_period_in_seconds       = 300
    revision_suffix                  = substr(var.source_revision, 0, 12)
    termination_grace_period_seconds = 30

    container {
      name   = local.container_name
      image  = "${azurerm_container_registry.telemetry.login_server}/${local.image_name}"
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.telemetry.client_id
      }
      env {
        name  = "TELEMETRY_DCE_ENDPOINT"
        value = azurerm_monitor_data_collection_endpoint.telemetry.logs_ingestion_endpoint
      }
      env {
        name  = "TELEMETRY_DCR_IMMUTABLE_ID"
        value = azurerm_monitor_data_collection_rule.telemetry.immutable_id
      }
      env {
        name  = "TELEMETRY_STREAM_NAME"
        value = local.input_stream_name
      }

      startup_probe {
        failure_count_threshold = 30
        interval_seconds        = 2
        port                    = local.container_port
        timeout                 = 1
        transport               = "TCP"
      }

      readiness_probe {
        failure_count_threshold = 3
        interval_seconds        = 5
        port                    = local.container_port
        success_count_threshold = 1
        timeout                 = 1
        transport               = "TCP"
      }

      liveness_probe {
        failure_count_threshold = 3
        initial_delay           = 5
        interval_seconds        = 30
        port                    = local.container_port
        timeout                 = 1
        transport               = "TCP"
      }
    }

    http_scale_rule {
      name                = "http-concurrency"
      concurrent_requests = "20"
    }
  }

  depends_on = [
    azurerm_container_registry_task_schedule_run_now.telemetry_image,
    azurerm_role_assignment.monitor_ingestion,
    time_sleep.container_registry_pull_propagation
  ]

  lifecycle {
    ignore_changes = [workload_profile_name]
  }
}
