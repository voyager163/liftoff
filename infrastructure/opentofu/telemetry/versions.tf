terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    azapi = {
      source  = "Azure/azapi"
      version = "2.12.0"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "5.3.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "0.14.1"
    }
  }

  backend "azurerm" {}
}

provider "azapi" {
  skip_provider_registration = true
}

provider "azurerm" {
  subscription_id                 = var.subscription_id
  resource_provider_registrations = "none"
  storage_use_azuread             = true

  features {
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
  }
}
