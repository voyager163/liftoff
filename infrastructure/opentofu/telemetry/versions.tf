terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    azapi = {
      source  = "Azure/azapi"
      version = "2.11.0"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "4.81.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "0.14.0"
    }
  }

  backend "azurerm" {}
}

provider "azapi" {}

provider "azurerm" {
  subscription_id     = var.subscription_id
  storage_use_azuread = true

  features {
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
  }
}
