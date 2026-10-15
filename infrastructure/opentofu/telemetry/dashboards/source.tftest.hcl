mock_provider "grafana" {}

variables {
  grafana_endpoint        = "https://synthetic.grafana.azure.com"
  synthetic_project_ids   = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]
  reporting_configuration = "disabled"
  expected_heartbeats = [{
    project_id     = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    expected_since = "2026-08-01T00:00:00Z"
  }]
}

run "offline_render" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for panel in jsondecode(grafana_dashboard.adoption.config_json).panels : [
        for target in try(panel.targets, []) : target.azureLogAnalytics.resources == [local.workspace_resource_id]
      ]
    ]))
    error_message = "Every query must target only the exact existing workspace."
  }
  assert {
    condition     = strcontains(grafana_dashboard.adoption.config_json, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") && !strcontains(grafana_dashboard.adoption.config_json, "@synthetic_ids@") && !strcontains(grafana_dashboard.adoption.config_json, "@expected_heartbeats@")
    error_message = "Exclusions and expectation templates must actually render."
  }
  assert {
    condition     = strcontains(grafana_dashboard.adoption.config_json, "datetime(2026-08-01T00:00:00Z)") && strcontains(grafana_dashboard.adoption.config_json, "reporting: disabled")
    error_message = "Explicit expected-since and configured disablement must reach native UI/query source."
  }
  assert {
    condition     = alltrue([for rule in grafana_rule_group.telemetry.rule : rule.is_paused && rule.no_data_state == "NoData" && rule.exec_err_state == "Error"])
    error_message = "Alerts must default paused and preserve unavailable/NoData semantics."
  }
  assert {
    condition     = alltrue([for rule in grafana_rule_group.ingestion_faults.rule : rule.is_paused && rule.no_data_state == "NoData" && rule.exec_err_state == "Error"])
    error_message = "The independent transform metric alert also defaults paused without hiding errors or missing metrics."
  }
}

run "explicit_reporting_enabled" {
  command = plan
  variables {
    reporting_configuration = "enabled"
    alerts_enabled          = true
  }
  assert {
    condition     = alltrue([for rule in grafana_rule_group.telemetry.rule : !rule.is_paused && rule.for == "15m" && rule.no_data_state == "NoData" && rule.exec_err_state == "Error"])
    error_message = "Explicit eligible expectations enable bounded rules without hiding datasource errors."
  }
  assert {
    condition     = grafana_rule_group.telemetry.interval_seconds == 900 && alltrue([for rule in grafana_rule_group.telemetry.rule : strcontains(rule.data[0].model, local.workspace_resource_id)])
    error_message = "Every alert stays bounded and scoped to the same exact workspace."
  }
}

run "synthetic_expectation_excluded" {
  command = plan
  variables {
    reporting_configuration = "enabled"
    alerts_enabled          = true
    expected_heartbeats = [{
      project_id     = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      expected_since = "2026-08-01T00:00:00Z"
    }]
  }
  assert {
    condition     = local.heartbeat_rows == "" && alltrue([for rule in grafana_rule_group.telemetry.rule : rule.is_paused if rule.uid == "liftoff-heartbeat_due"])
    error_message = "Synthetic expectations must be excluded from freshness and alert queries."
  }
}

run "invalid_duplicate_expectation" {
  command = plan
  variables {
    expected_heartbeats = [
      { project_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expected_since = "2026-08-01T00:00:00Z" },
      { project_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expected_since = "2026-08-02T00:00:00Z" }
    ]
  }
  expect_failures = [var.expected_heartbeats]
}

run "invalid_calendar_timestamp" {
  command = plan
  variables {
    expected_heartbeats = [{
      project_id     = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      expected_since = "2026-02-31T00:00:00Z"
    }]
  }
  expect_failures = [var.expected_heartbeats]
}

run "invalid_synthetic_id" {
  command = plan
  variables {
    synthetic_project_ids = ["not-an-id'); print credential"]
  }
  expect_failures = [var.synthetic_project_ids]
}

run "invalid_timestamp_injection" {
  command = plan
  variables {
    expected_heartbeats = [{
      project_id     = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      expected_since = "2026-08-01T00:00:00Z); print secret"
    }]
  }
  expect_failures = [var.expected_heartbeats]
}

run "ingestion_fault_requires_separate_enablement" {
  command = plan
  variables {
    alerts_enabled = true
  }
  assert {
    condition     = alltrue([for rule in grafana_rule_group.ingestion_faults.rule : rule.is_paused])
    error_message = "Enabling existing reporting alerts must not implicitly enable unqualified transform metrics."
  }
}

run "ingestion_fault_global_pause_wins" {
  command = plan
  variables {
    ingestion_fault_alerts_enabled = true
  }
  assert {
    condition     = alltrue([for rule in grafana_rule_group.ingestion_faults.rule : rule.is_paused])
    error_message = "The global alert pause must win even with explicit transform-rule enablement."
  }
}

run "ingestion_fault_explicit_source_enabled" {
  command = plan
  variables {
    alerts_enabled                 = true
    ingestion_fault_alerts_enabled = true
  }
  assert {
    condition     = grafana_rule_group.ingestion_faults.interval_seconds == 60 && alltrue([for rule in grafana_rule_group.ingestion_faults.rule : !rule.is_paused && rule.for == "5m" && rule.no_data_state == "NoData" && rule.exec_err_state == "Error"])
    error_message = "Transform faults use explicit enablement, one-minute evaluation, five-minute pending and native missing/error states."
  }
  assert {
    condition = alltrue([for rule in grafana_rule_group.ingestion_faults.rule :
      rule.data[0].relative_time_range[0].from == 900 &&
      jsondecode(rule.data[0].model).queryType == "Azure Monitor" &&
      jsondecode(rule.data[0].model).subscription == "4158373b-2ebe-4b5f-9176-187d49e0ba84" &&
      jsondecode(rule.data[0].model).azureMonitor.aggregation == "Count" &&
      jsondecode(rule.data[0].model).azureMonitor.timeGrain == "PT1M" &&
      jsondecode(rule.data[0].model).azureMonitor.metricName == "TransformationErrors_Count" &&
      jsondecode(rule.data[0].model).azureMonitor.resources == [{
        subscription    = "4158373b-2ebe-4b5f-9176-187d49e0ba84"
        resourceGroup   = "rg-liftoff-prod"
        resourceName    = "dcr-liftoff-telemetry-f5be1618"
        metricNamespace = "Microsoft.Insights/dataCollectionRules"
        region          = "koreacentral"
      }]
    ])
    error_message = "Query only the observed DCR Count metric and exact resource for the bounded fifteen-minute window."
  }
  assert {
    condition = alltrue([for rule in grafana_rule_group.ingestion_faults.rule :
      jsondecode(rule.data[1].model).conditions[0].evaluator == { type = "gt", params = [0] } &&
      jsondecode(rule.data[1].model).conditions[0].query.params == ["A"] &&
      jsondecode(rule.data[1].model).conditions[0].reducer.type == "sum"
    ])
    error_message = "Alert on positive transform errors across the window, not low requests, command volume or a last zero sample."
  }
}
