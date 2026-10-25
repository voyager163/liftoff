locals {
  project      = "{{liftoff.name}}"
  environments = {{liftoff.environmentList}}
}

variable "subscription_id" {
  description = "The Azure subscription to create the shared resources in."
  type        = string
}

variable "location" {
  description = "The Azure region, such as \"eastus2\". It must have availability zones for zone-redundant storage."
  type        = string
}
