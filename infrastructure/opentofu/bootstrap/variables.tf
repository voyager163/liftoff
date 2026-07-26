variable "subscription_id" {
  description = "Azure subscription that owns the Liftoff OpenTofu backend."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be a UUID."
  }
}

variable "location" {
  description = "Azure region for the state storage account."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]+$", var.location))
    error_message = "location must be a lowercase Azure region slug."
  }
}

variable "resource_suffix" {
  description = "Deterministic lowercase suffix shared with production."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{6,8}$", var.resource_suffix))
    error_message = "resource_suffix must contain 6-8 lowercase letters or digits."
  }
}

variable "operator_cidrs" {
  description = "Explicit operator IPv4 /32 CIDRs admitted to the storage perimeter. Keep values in ignored local inputs."
  type        = list(string)
  sensitive   = true

  validation {
    condition = (
      length(var.operator_cidrs) > 0 &&
      alltrue([
        for cidr in var.operator_cidrs :
        can(cidrnetmask(cidr)) &&
        can(regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}/32$", cidr))
      ])
    )
    error_message = "operator_cidrs must contain at least one valid IPv4 /32 CIDR."
  }
}
