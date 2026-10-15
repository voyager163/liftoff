terraform {
  required_version = ">= 1.12.6, < 2.0.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "5.3.0"
    }
  }
  backend "azurerm" {}
}

provider "azurerm" {
  subscription_id                 = "4158373b-2ebe-4b5f-9176-187d49e0ba84"
  resource_provider_registrations = "none"
  storage_use_azuread             = true
  features {}
}
