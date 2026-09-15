# Example: an ARC Region Switch plan that fails an Aurora Global Database, a DRS-replicated EC2
# tier and a Route 53 failover record over to the secondary region and back -- with the DRS steps
# coming from the module. Everything below `module "drs"` is a normal plan; the only wiring is the
# two `dynamic "step"` blocks and the role policy.
#
# Prerequisites (outside Terraform): DRS initialised in both regions; the protected instance's
# DRS source server tagged <project>:role = app; for stateful fail-back the EC2 is BIOS-boot,
# tagged AWSDRS=AllowLaunchingIntoThisInstance, and the primary region's DRS launch template has
# launchIntoSourceInstance enabled. See ../../README.md.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws     = { source = "hashicorp/aws", version = ">= 6.0" }
    archive = { source = "hashicorp/archive", version = ">= 2.4" }
  }
}

variable "project" { default = "drsdemo" }
variable "primary_region" { default = "us-east-2" }
variable "secondary_region" { default = "us-west-2" }
variable "stateful_ec2" { default = true }

# --- the consumer's existing resources, referenced here as variables for brevity ---
variable "primary_target_group_arn" { type = string }
variable "secondary_target_group_arn" { type = string }
variable "app_instance_profile_arn" { type = string }
variable "app_instance_role_arn" { type = string }
variable "global_cluster_identifier" { type = string }
variable "primary_cluster_arn" { type = string }
variable "secondary_cluster_arn" { type = string }
variable "secondary_writer_endpoint" { type = string }
variable "hosted_zone_id" { type = string }
variable "record_name" { type = string } # e.g. app.example.internal

provider "aws" {
  alias  = "primary"
  region = var.primary_region
}
provider "aws" {
  alias  = "secondary"
  region = var.secondary_region
}

module "drs" {
  source    = "../../"
  providers = { aws.primary = aws.primary, aws.secondary = aws.secondary }

  project                    = var.project
  primary_region             = var.primary_region
  secondary_region           = var.secondary_region
  primary_target_group_arn   = var.primary_target_group_arn
  secondary_target_group_arn = var.secondary_target_group_arn
  app_instance_profile_arn   = var.app_instance_profile_arn
  app_instance_role_arn      = var.app_instance_role_arn
  db_endpoint_parameter_name = "/${var.project}/db-writer-endpoint"
  secondary_db_endpoint      = var.secondary_writer_endpoint
  stateful_ec2               = var.stateful_ec2
}

# --- plan execution role -----------------------------------------------------------------------

data "aws_iam_policy_document" "plan_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["arc-region-switch.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "plan" {
  provider           = aws.primary
  name               = "${var.project}-region-switch"
  assume_role_policy = data.aws_iam_policy_document.plan_assume.json
}

# Aurora Global + Route 53 permissions the plan's own blocks need (trimmed to this example).
data "aws_iam_policy_document" "plan_blocks" {
  statement {
    actions   = ["rds:SwitchoverGlobalCluster", "rds:FailoverGlobalCluster", "rds:DescribeGlobalClusters", "rds:DescribeDBClusters"]
    resources = ["*"]
  }
  statement {
    actions   = ["route53:GetHealthCheck", "route53:UpdateHealthCheck", "route53:ListHealthChecks", "route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "plan_blocks" {
  provider = aws.primary
  role     = aws_iam_role.plan.id
  policy   = data.aws_iam_policy_document.plan_blocks.json
}

# Exactly what the module's functions need from the plan role.
resource "aws_iam_role_policy" "plan_drs_steps" {
  provider = aws.primary
  role     = aws_iam_role.plan.id
  policy   = module.drs.plan_role_policy_json
}

# --- the plan --------------------------------------------------------------------------------

locals {
  aurora = { global_cluster_identifier = var.global_cluster_identifier, arns = [var.primary_cluster_arn, var.secondary_cluster_arn] }
  # ACTIVATE <primary>: module steps 0..2, then Aurora back + DNS back, then module steps 3..4.
  primary_head = slice(module.drs.activate_primary_steps, 0, module.drs.activate_primary_split)
  primary_tail = slice(module.drs.activate_primary_steps, module.drs.activate_primary_split, length(module.drs.activate_primary_steps))
}

resource "aws_arcregionswitch_plan" "this" {
  provider          = aws.primary
  name              = "${var.project}-switchover"
  execution_role    = aws_iam_role.plan.arn
  recovery_approach = "activePassive"
  primary_region    = var.primary_region
  regions           = [var.primary_region, var.secondary_region]

  # ================= ACTIVATE secondary =================
  workflow {
    workflow_target_action = "activate"
    workflow_target_region = var.secondary_region

    step {
      name                 = "aurora-switchover"
      execution_block_type = "AuroraGlobalDatabase"
      global_aurora_config {
        behavior                  = "switchoverOnly"
        global_cluster_identifier = local.aurora.global_cluster_identifier
        database_cluster_arns     = local.aurora.arns
        timeout_minutes           = 60
        ungraceful { ungraceful = "failover" }
      }
    }

    dynamic "step" {
      for_each = module.drs.activate_secondary_steps
      content {
        name                 = step.value.name
        description          = step.value.description
        execution_block_type = "CustomActionLambda"
        custom_action_lambda_config {
          region_to_run          = step.value.region_to_run
          retry_interval_minutes = step.value.retry_interval_minutes
          timeout_minutes        = step.value.timeout_minutes
          lambda { arn = step.value.lambda_arn }
          ungraceful { behavior = "skip" }
        }
      }
    }

    step {
      name                 = "dns-flip"
      execution_block_type = "Route53HealthCheck"
      route53_health_check_config {
        hosted_zone_id  = var.hosted_zone_id
        record_name     = var.record_name
        timeout_minutes = 15
      }
    }
  }

  # ================= ACTIVATE primary (fail-back) =================
  workflow {
    workflow_target_action = "activate"
    workflow_target_region = var.primary_region

    dynamic "step" {
      for_each = local.primary_head
      content {
        name                 = step.value.name
        description          = step.value.description
        execution_block_type = "CustomActionLambda"
        custom_action_lambda_config {
          region_to_run          = step.value.region_to_run
          retry_interval_minutes = step.value.retry_interval_minutes
          timeout_minutes        = step.value.timeout_minutes
          lambda { arn = step.value.lambda_arn }
          ungraceful { behavior = "skip" }
        }
      }
    }

    step {
      name                 = "aurora-switchover-back"
      execution_block_type = "AuroraGlobalDatabase"
      global_aurora_config {
        behavior                  = "switchoverOnly"
        global_cluster_identifier = local.aurora.global_cluster_identifier
        database_cluster_arns     = local.aurora.arns
        timeout_minutes           = 60
        ungraceful { ungraceful = "failover" }
      }
    }

    step {
      name                 = "dns-flip-back"
      execution_block_type = "Route53HealthCheck"
      route53_health_check_config {
        hosted_zone_id  = var.hosted_zone_id
        record_name     = var.record_name
        timeout_minutes = 15
      }
    }

    dynamic "step" {
      for_each = local.primary_tail
      content {
        name                 = step.value.name
        description          = step.value.description
        execution_block_type = "CustomActionLambda"
        custom_action_lambda_config {
          region_to_run          = step.value.region_to_run
          retry_interval_minutes = step.value.retry_interval_minutes
          timeout_minutes        = step.value.timeout_minutes
          lambda { arn = step.value.lambda_arn }
          ungraceful { behavior = "skip" }
        }
      }
    }
  }
}

output "plan_arn" {
  value = aws_arcregionswitch_plan.this.arn
}
