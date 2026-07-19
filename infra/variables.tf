variable "s3_bucket_name" {
  type        = string
  default     = "oniwa-provider-data"
  description = "S3 bucket for user profiles, tokens, and pricing config"
}

variable "providers_json" {
  type        = string
  sensitive   = true
  default     = ""
  description = "PROVIDERS JSON (required — provider definitions with API keys)"
}

variable "model_routing_json" {
  type        = string
  default     = ""
  description = "MODEL_ROUTING JSON (model → provider ID mapping)"
}

variable "model_mapping_json" {
  type        = string
  default     = ""
  description = "MODEL_MAPPING JSON (Anthropic model → provider model ID)"
}

variable "log_group_name" {
  type        = string
  default     = "/aws/lambda/oniwa-provider"
  description = "CloudWatch Logs group for usage records"
}

variable "admin_api_key" {
  type        = string
  sensitive   = true
  description = "API key for /v1/admin/* endpoints"
}

variable "max_output_tokens" {
  type        = number
  default     = 16384
  description = "Maximum output tokens cap"
}
