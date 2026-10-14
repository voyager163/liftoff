variable "grafana_endpoint" {
  description = "Exact authenticated Managed Grafana endpoint from the separately qualified resource root."
  type        = string
  validation {
    condition     = can(regex("^https://[a-z0-9.-]+\\.grafana\\.azure\\.com/?$", var.grafana_endpoint))
    error_message = "Use the exact HTTPS Azure Managed Grafana endpoint, not a local/public-share endpoint."
  }
}

variable "synthetic_project_ids" {
  description = "Operator-registered synthetic UUIDv4 exclusions. Register before any qualification upload, then retain until all matching observations expire."
  type        = set(string)
  default     = []
  validation {
    condition = length(var.synthetic_project_ids) <= 1000 && alltrue([
      for id in var.synthetic_project_ids :
      can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", id))
    ])
    error_message = "Synthetic exclusions must be at most 1000 canonical UUIDv4 values."
  }
}

variable "reporting_configuration" {
  description = "Operator-configured global project reporting state, not a claim about individual clients inferred from silence."
  type        = string
  default     = "unknown"
  validation {
    condition     = contains(["unknown", "enabled", "disabled"], var.reporting_configuration)
    error_message = "reporting_configuration must be unknown, enabled or disabled."
  }
}

variable "expected_heartbeats" {
  description = "Private inventory of explicitly expected reporting, with monitoring start time. Empty until a real heartbeat producer is qualified and enabled."
  type = list(object({
    project_id     = string
    expected_since = string
  }))
  default = []
  validation {
    condition = (
      length(var.expected_heartbeats) <= 1000 &&
      length(distinct([for entry in var.expected_heartbeats : entry.project_id])) == length(var.expected_heartbeats) &&
      alltrue([for entry in var.expected_heartbeats :
        can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", entry.project_id)) &&
        can(regex("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$", entry.expected_since)) &&
        can(timecmp(entry.expected_since, entry.expected_since))
      ])
    )
    error_message = "Expected entries must be unique canonical UUIDv4 values with valid UTC monitoring-start timestamps, at most 1000."
  }
}

variable "alerts_enabled" {
  description = "Unpause only after actual queries, expectations and private notification routing are qualified. Does not create contacts or subscriptions."
  type        = bool
  default     = false
}
