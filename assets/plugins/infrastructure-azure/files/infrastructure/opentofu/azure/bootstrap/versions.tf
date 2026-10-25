terraform {
  required_version = ">= 1.13.2"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "5.10.0"
    }
  }

  # Bootstrap creates the state storage, so its own state starts out local.
  # Keep it somewhere private and backed up; it holds no secrets, but losing
  # it means importing the shared resources again.
}

provider "azurerm" {
  features {}
  subscription_id     = var.subscription_id
  storage_use_azuread = true
}
