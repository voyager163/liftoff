variable "grafana_name" {
  description = "Exact approved new Managed Grafana name; absence and ownership must be qualified before apply."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,21}[a-z0-9]$", var.grafana_name))
    error_message = "Use a lowercase Managed Grafana name of 3-23 characters."
  }
}

variable "sku_size" {
  description = "Explicitly qualified/approved Standard size. No default: retail meters alone do not establish size, quota or cost."
  type        = string
  validation {
    condition     = contains(["X1", "X2"], var.sku_size)
    error_message = "sku_size must be a separately qualified Standard X1 or X2."
  }
}

variable "grafana_major_version" {
  description = "Explicitly approved regional Grafana major version supported by the pinned AzureRM provider."
  type        = number
  validation {
    condition     = contains([12, 13], var.grafana_major_version)
    error_message = "The pinned provider supports Grafana major 12 or 13."
  }
}

variable "grafana_access" {
  description = "Reviewed existing Entra object UUIDs mapped to instance-scoped roles; no implicit subscription-wide access."
  type        = map(string)
  default     = {}
  validation {
    condition = alltrue([
      for principal, role in var.grafana_access :
      can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", principal)) &&
      contains(["Grafana Viewer", "Grafana Editor", "Grafana Admin"], role)
    ])
    error_message = "Each access entry must select an existing Entra object UUID and an explicit Grafana role."
  }
}
