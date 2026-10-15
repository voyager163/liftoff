terraform {
  required_version = ">= 1.12.6, < 2.0.0"
  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "4.49.0"
    }
  }
  backend "azurerm" {}
}

provider "grafana" {
  url                    = var.grafana_endpoint
  retries                = 2
  retry_wait             = 2
  store_dashboard_sha256 = false
}
