variable "subscription_id" {
  description = "The Azure subscription bootstrap created this environment's resource group in."
  type        = string
}

variable "location" {
  description = "The Azure region bootstrap used."
  type        = string
}

variable "api_image" {
  description = "The API image by digest, such as <registry>.azurecr.io/{{liftoff.name}}-api@sha256:<digest>."
  type        = string
}
{{liftoff.webImageVariable}}