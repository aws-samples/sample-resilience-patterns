# Per-region half of the drs-region-switch module: one layer version, seven functions selected
# by handler string, explicit log groups. Instantiated once per plan region by the parent.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "project" { type = string }
variable "steps" { type = map(any) }
variable "environment" { type = map(string) }
variable "role_arn" { type = string }
variable "layer_zip" { type = string }
variable "layer_hash" { type = string }
variable "stub_zip" { type = string }
variable "lambda_runtime" { type = string }
variable "log_retention_days" { type = number }
variable "function_overrides" { type = map(object({ timeout = optional(number), memory_size = optional(number) })) }
variable "tags" { type = map(string) }

data "aws_region" "current" {}

resource "aws_lambda_layer_version" "steps" {
  layer_name          = "${var.project}-drs-region-switch"
  description         = "drs_region_switch step handlers (ARC Region Switch custom actions)"
  filename            = var.layer_zip
  source_code_hash    = var.layer_hash
  compatible_runtimes = [var.lambda_runtime]
}

resource "aws_cloudwatch_log_group" "step" {
  for_each          = var.steps
  name              = "/aws/lambda/${var.project}-${each.key}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_lambda_function" "step" {
  for_each = var.steps

  function_name = "${var.project}-${each.key}"
  description   = each.value.description
  role          = var.role_arn
  runtime       = var.lambda_runtime
  handler       = "drs_region_switch.${each.value.module}.handler"
  filename      = var.stub_zip
  layers        = [aws_lambda_layer_version.steps.arn]
  timeout       = try(var.function_overrides[each.key].timeout, null) != null ? var.function_overrides[each.key].timeout : each.value.timeout
  memory_size   = try(var.function_overrides[each.key].memory_size, null) != null ? var.function_overrides[each.key].memory_size : 256

  environment {
    variables = var.environment
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.step[each.key].name
  }

  tags = merge(var.tags, { "${var.project}:step" = each.key })
}

output "function_arns" {
  value = { for k, f in aws_lambda_function.step : k => f.arn }
}

output "layer_arn" {
  value = aws_lambda_layer_version.steps.arn
}

output "region" {
  value = data.aws_region.current.region
}
