variable "subscription_id" {
  description = "Azure subscription that owns rg-liftoff-prod."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be a UUID."
  }
}

variable "location" {
  description = "Azure region for telemetry resources."
  type        = string
  default     = "eastus"

  validation {
    condition     = can(regex("^[a-z0-9]+$", var.location))
    error_message = "location must be a lowercase Azure region slug."
  }
}

variable "resource_suffix" {
  description = "Globally unique lowercase suffix used by bounded Azure resource names."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{6,8}$", var.resource_suffix))
    error_message = "resource_suffix must contain 6-8 lowercase letters or digits."
  }
}

variable "source_revision" {
  description = "Full public Git commit SHA used for the immutable telemetry gateway image."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.source_revision))
    error_message = "source_revision must be a full 40-character lowercase Git commit SHA."
  }
}

variable "retained_image_revisions" {
  description = "Previously deployed image revisions retained during non-destructive migration."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for revision in var.retained_image_revisions :
      can(regex("^[0-9a-f]{40}$", revision))
    ])
    error_message = "Every retained image revision must be a full 40-character lowercase Git commit SHA."
  }
}

variable "ingestion_enabled" {
  description = "Enables public Container App ingress. Set false for emergency disablement."
  type        = bool
  default     = true
}

variable "daily_quota_gb" {
  description = "Daily Log Analytics ingestion quota in GB."
  type        = number
  default     = 0.1

  validation {
    condition     = var.daily_quota_gb > 0 && var.daily_quota_gb <= 1
    error_message = "daily_quota_gb must be greater than 0 and no more than 1."
  }
}
