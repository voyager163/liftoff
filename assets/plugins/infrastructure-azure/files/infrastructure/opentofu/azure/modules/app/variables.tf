variable "project" {
  description = "The project's name: lowercase letters, digits and hyphens."
  type        = string
}

variable "environment" {
  description = "dev, staging or prod."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "The environment must be dev, staging or prod."
  }
}

variable "subscription_id" {
  description = "The Azure subscription bootstrap created the environment's resource group in."
  type        = string
}

variable "location" {
  description = "The Azure region. Zone-redundant PostgreSQL needs one with availability zones."
  type        = string
}

variable "address_space" {
  description = "The environment's private network. The apps use the first /23 and PostgreSQL the next /24."
  type        = string
  default     = "10.20.0.0/16"
}

variable "api_image" {
  description = "The API image by digest, such as <registry>.azurecr.io/<project>-api@sha256:<digest>."
  type        = string
}

variable "api_min_replicas" {
  description = "Replicas kept running; 0 lets the API scale to zero when idle."
  type        = number
}

variable "migrate_command" {
  description = "The arguments, run in the API image, that apply the database migrations."
  type        = list(string)
}

variable "database_url_scheme" {
  description = "The scheme of APP_DATABASE_URL the API expects."
  type        = string
}

variable "database" {
  description = "PostgreSQL sizing: high availability needs a General Purpose or Memory Optimized SKU."
  type = object({
    sku_name              = string
    storage_mb            = number
    high_availability     = bool
    backup_retention_days = number
  })
}

variable "postgresql_version" {
  description = "The PostgreSQL major version."
  type        = string
  default     = "18"
}

variable "web_image" {
  description = "The frontend image by digest, or null when the project has no frontend."
  type        = string
  default     = null
}
