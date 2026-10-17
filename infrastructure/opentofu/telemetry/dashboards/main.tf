locals {
  workspace_resource_id = "/subscriptions/4158373b-2ebe-4b5f-9176-187d49e0ba84/resourceGroups/rg-liftoff-prod/providers/Microsoft.OperationalInsights/workspaces/log-liftoff-telemetry-f5be1618"
  dashboard_source      = jsondecode(file("${path.module}/adoption.json"))
  heartbeat_rows = join(", ", [
    for entry in var.expected_heartbeats :
    "${jsonencode(entry.project_id)}, datetime(${entry.expected_since})"
    if !contains(var.synthetic_project_ids, entry.project_id)
  ])
  projects_kql = replace(file("${path.module}/queries/projects.kql"), "@synthetic_ids@", jsonencode(sort(tolist(var.synthetic_project_ids))))
  freshness_kql = replace(replace(
    "${local.projects_kql}\n${file("${path.module}/queries/freshness.kql")}",
    "@expected_heartbeats@", local.heartbeat_rows
  ), "@reporting_configuration@", var.reporting_configuration)
  rendered_dashboard = merge(local.dashboard_source, {
    panels = concat(
      [for panel in local.dashboard_source.panels : merge(panel, {
        options = merge(panel.options, {
          content = replace(panel.options.content, "@reporting_configuration@", var.reporting_configuration)
        })
      }) if panel.type == "text"],
      [for panel in local.dashboard_source.panels : merge(panel, {
        datasource = { type = "grafana-azure-monitor-datasource", uid = grafana_data_source.telemetry.uid }
        targets = [
          for target in panel.targets : merge(target, {
            datasource = { type = "grafana-azure-monitor-datasource", uid = grafana_data_source.telemetry.uid }
            azureLogAnalytics = merge(target.azureLogAnalytics, {
              resources = [local.workspace_resource_id]
              query = replace(replace(replace(target.azureLogAnalytics.query,
                "@synthetic_ids@", jsonencode(sort(tolist(var.synthetic_project_ids)))),
                "@expected_heartbeats@", local.heartbeat_rows),
              "@reporting_configuration@", var.reporting_configuration)
            })
          })
        ]
      }) if panel.type != "text"]
    )
  })
}

resource "grafana_folder" "telemetry" {
  uid   = "liftoff-telemetry"
  title = "Liftoff telemetry"
}

resource "grafana_data_source" "telemetry" {
  uid         = "liftoff-azure-logs"
  name        = "Liftoff telemetry Logs"
  type        = "grafana-azure-monitor-datasource"
  access_mode = "proxy"
  is_default  = false
  json_data_encoded = jsonencode({
    azureAuthType  = "msi"
    cloudName      = "azuremonitor"
    subscriptionId = "4158373b-2ebe-4b5f-9176-187d49e0ba84"
  })
}

resource "grafana_dashboard" "adoption" {
  folder      = grafana_folder.telemetry.uid
  config_json = jsonencode(local.rendered_dashboard)
  overwrite   = false
}

resource "grafana_rule_group" "telemetry" {
  name             = "Liftoff reporting availability"
  folder_uid       = grafana_folder.telemetry.uid
  interval_seconds = 900

  dynamic "rule" {
    for_each = {
      query_available = {
        name    = "Telemetry Logs query unavailable"
        query   = file("${path.module}/queries/query-availability.kql")
        paused  = !var.alerts_enabled
        summary = "Query/permission/table errors are unavailable data, not zero projects or ingestion health. No command-volume threshold."
      }
      heartbeat_due = {
        name    = "Explicitly expected monthly reporting overdue"
        query   = "${local.freshness_kql}\n| summarize Value = countif(Overdue)\n| project TimeGenerated = now(), Value"
        paused  = !var.alerts_enabled || var.reporting_configuration != "enabled" || local.heartbeat_rows == ""
        summary = "Monthly reporting: 31-day interval plus 9-day grace (40 days), then 15-minute pending. Unknown/stale reporting, not abandonment or deployment failure."
      }
    }
    content {
      uid            = "liftoff-${rule.key}"
      name           = rule.value.name
      condition      = "B"
      for            = "15m"
      no_data_state  = "NoData"
      exec_err_state = "Error"
      is_paused      = rule.value.paused
      annotations = {
        summary     = rule.value.summary
        runbook_url = "https://github.com/voyager163/liftoff/blob/develop/infrastructure/opentofu/telemetry/README.md"
      }
      labels = { component = "liftoff-telemetry", scope = "reporting-not-health" }
      data {
        ref_id         = "A"
        datasource_uid = grafana_data_source.telemetry.uid
        relative_time_range {
          from = 15552000
          to   = 0
        }
        model = jsonencode({
          refId     = "A"
          queryType = "Azure Log Analytics"
          azureLogAnalytics = {
            resources     = [local.workspace_resource_id]
            query         = rule.value.query
            resultFormat  = "time_series"
            dashboardTime = false
            mode          = "raw"
          }
        })
      }
      data {
        ref_id         = "B"
        datasource_uid = "-100"
        relative_time_range {
          from = 0
          to   = 0
        }
        model = jsonencode({
          refId      = "B"
          type       = "classic_conditions"
          datasource = { type = "__expr__", uid = "-100" }
          conditions = [{
            evaluator = { type = "gt", params = [0] }
            operator  = { type = "and" }
            query     = { params = ["A"] }
            reducer   = { type = "last", params = [] }
            type      = "query"
          }]
        })
      }
    }
  }
}
