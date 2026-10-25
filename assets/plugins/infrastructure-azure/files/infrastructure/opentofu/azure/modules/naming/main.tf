# Resource names, from the project, the environment and a short hash of the
# subscription. The same inputs always give the same names, and two
# subscriptions never compete for a globally unique name.

variable "project" {
  description = "The project's name: lowercase letters, digits and hyphens."
  type        = string
}

variable "environment" {
  description = "dev, staging or prod; empty for the resources the environments share."
  type        = string
  default     = ""

  validation {
    condition     = contains(["", "dev", "staging", "prod"], var.environment)
    error_message = "The environment must be dev, staging, prod or empty."
  }
}

variable "subscription_id" {
  description = "The Azure subscription the resources are created in."
  type        = string
}

locals {
  suffix  = substr(sha256("${var.subscription_id}/${var.project}"), 0, 6)
  letters = replace(var.project, "-", "")
  scope   = var.environment == "" ? var.project : "${var.project}-${var.environment}"
  # Container app and job names allow at most 32 characters.
  short = replace(substr(var.project, 0, 16), "/-+$/", "")
}

output "suffix" {
  description = "The subscription hash in globally unique names."
  value       = local.suffix
}

output "resource_group" {
  value = "rg-${local.scope}"
}

output "state_storage_account" {
  description = "Globally unique: 3 to 24 lowercase letters and digits."
  value       = "st${substr(local.letters, 0, 16)}${local.suffix}"
}

output "state_container" {
  value = "tfstate"
}

output "container_registry" {
  description = "Globally unique: 5 to 50 letters and digits."
  value       = "cr${substr(local.letters, 0, 42)}${local.suffix}"
}

output "app_identity" {
  value = "id-${local.scope}-app"
}

output "log_analytics_workspace" {
  value = "log-${local.scope}"
}

output "virtual_network" {
  value = "vnet-${local.scope}"
}

output "container_app_environment" {
  value = "cae-${replace(substr(local.scope, 0, 56), "/-+$/", "")}"
}

output "postgres_server" {
  description = "Globally unique: at most 63 lowercase letters, digits and hyphens."
  value       = "psql-${replace(substr(local.scope, 0, 50), "/-+$/", "")}-${local.suffix}"
}

output "postgres_dns_zone" {
  value = "${replace(substr(local.scope, 0, 50), "/-+$/", "")}.private.postgres.database.azure.com"
}

output "api_app" {
  value = "${local.short}-${var.environment}-api"
}

output "web_app" {
  value = "${local.short}-${var.environment}-web"
}

output "migrate_job" {
  value = "${local.short}-${var.environment}-migrate"
}
