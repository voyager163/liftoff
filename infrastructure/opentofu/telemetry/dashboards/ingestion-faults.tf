resource "grafana_rule_group" "ingestion_faults" {
  name             = "Liftoff DCR transformation faults"
  folder_uid       = grafana_folder.telemetry.uid
  interval_seconds = 60

  rule {
    uid            = "liftoff-dcr-transform-errors"
    name           = "Liftoff DCR transformation errors observed"
    condition      = "B"
    for            = "5m"
    no_data_state  = "NoData"
    exec_err_state = "Error"
    is_paused      = !var.alerts_enabled || !var.ingestion_fault_alerts_enabled
    annotations = {
      summary     = "DCR transformation error Count > 0 over 15 minutes, evaluated each minute with 5-minute pending. Missing metrics are unknown, not zero; this does not verify gateway/auth/network health or project activity."
      runbook_url = "https://github.com/voyager163/liftoff/blob/develop/infrastructure/opentofu/telemetry/README.md"
    }
    labels = { component = "liftoff-telemetry", scope = "dcr-transform-errors-only" }
    data {
      ref_id         = "A"
      datasource_uid = grafana_data_source.telemetry.uid
      relative_time_range {
        from = 900
        to   = 0
      }
      model = jsonencode({
        refId        = "A"
        queryType    = "Azure Monitor"
        subscription = "4158373b-2ebe-4b5f-9176-187d49e0ba84"
        azureMonitor = {
          aggregation     = "Count"
          metricName      = "TransformationErrors_Count"
          metricNamespace = "Microsoft.Insights/dataCollectionRules"
          region          = "koreacentral"
          timeGrain       = "PT1M"
          resources = [{
            subscription    = "4158373b-2ebe-4b5f-9176-187d49e0ba84"
            resourceGroup   = "rg-liftoff-prod"
            resourceName    = "dcr-liftoff-telemetry-f5be1618"
            metricNamespace = "Microsoft.Insights/dataCollectionRules"
            region          = "koreacentral"
          }]
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
          reducer   = { type = "sum", params = [] }
          type      = "query"
        }]
      })
    }
  }
}
