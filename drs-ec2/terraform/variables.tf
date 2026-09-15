variable "project" {
  description = "Resource-name prefix; also the default tag namespace (<project>:role)."
  type        = string
}

variable "primary_region" {
  type = string
}

variable "secondary_region" {
  type = string
}

variable "source_server_tag" {
  description = "Tag on the DRS source server that identifies the protected instance."
  type        = object({ key = string, value = string })
  default     = null
}

variable "primary_target_group_arn" {
  type = string
}

variable "secondary_target_group_arn" {
  type = string
}

variable "app_instance_profile_arn" {
  description = "Instance profile the recovered / failed-back EC2 runs with (needs the DRS recovery-instance policy)."
  type        = string
}

variable "app_instance_role_arn" {
  description = "Role behind that instance profile; DRS passes it at launch (iam:PassRole)."
  type        = string
}

variable "db_endpoint_parameter_name" {
  description = "SSM parameter (same name in both regions) the app reads for its DB endpoint. Optional."
  type        = string
  default     = null
}

variable "secondary_db_endpoint" {
  description = "Secondary-region Aurora writer endpoint written to the parameter on failover. Optional."
  type        = string
  default     = null
}

variable "stateful_ec2" {
  description = "Enable the stateful fail-back path (reverse-replicate, launch-into, re-protect)."
  type        = bool
  default     = false
}

variable "launch_template" {
  description = "Recovery / failback launch template shape, used only when DRS's auto template is unusable (new-instance form)."
  type = object({
    primary_subnet_id           = optional(string)
    primary_security_group_id   = optional(string)
    secondary_subnet_id         = optional(string)
    secondary_security_group_id = optional(string)
    instance_type               = optional(string, "t2.small")
  })
  default = {}
}

variable "target_port" {
  type    = number
  default = 8080
}

variable "log_retention_days" {
  type    = number
  default = 1
}

variable "lambda_runtime" {
  type    = string
  default = "python3.12"
}

variable "lambda_source_dir" {
  description = "Directory containing the drs_region_switch Python package. Defaults to ../lambda in this repo."
  type        = string
  default     = null
}

variable "function_overrides" {
  description = "Per-step Lambda timeout (seconds) / memory (MB) overrides, keyed by step name."
  type        = map(object({ timeout = optional(number), memory_size = optional(number) }))
  default     = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}
