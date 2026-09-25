# DRS orchestration steps for an ARC Region Switch plan -- Terraform flavour of the CDK
# construct in ../lib/constructs. One Lambda layer (the drs_region_switch package), seven thin
# functions per region selected by handler string, one orchestration role, and outputs shaped
# for aws_arcregionswitch_plan. See ../README.md "Terraform".

locals {
  tag_key   = var.source_server_tag != null ? var.source_server_tag.key : "${var.project}:role"
  tag_value = var.source_server_tag != null ? var.source_server_tag.value : "app"
  db_param  = coalesce(var.db_endpoint_parameter_name, "/${var.project}/db-writer-endpoint")
  src_dir   = coalesce(var.lambda_source_dir, "${path.module}/../lambda")

  # The seven-step contract. Keep in sync with lambda/drs_region_switch/__init__.py and
  # lib/constructs/step-table.ts.
  steps = {
    "drs-recover-ec2" = {
      module      = "recover", region_to_run = "activatingRegion", workflow = "activateSecondary", order = 0
      timeout     = 900, retry_minutes = 1, step_timeout_minutes = 30, stateful_only = false
      description = "DRS StartRecovery of the tagged source server; RUNNING recovery instance in the activating region"
    }
    "register-target" = {
      module      = "register_target", region_to_run = "activatingRegion", workflow = "activateSecondary", order = 1
      timeout     = 300, retry_minutes = 1, step_timeout_minutes = 15, stateful_only = false
      description = "Repoint the app DB parameter; register the recovered EC2 in the secondary target group; wait healthy"
    }
    "drs-reverse-replicate" = {
      module      = "reverse_replicate", region_to_run = "deactivatingRegion", workflow = "activatePrimary", order = 0
      timeout     = 120, retry_minutes = 1, step_timeout_minutes = 120, stateful_only = true
      description = "Reverse replication from the recovery instance back to the primary until CONTINUOUS"
    }
    "drs-failback-launch" = {
      module      = "failback_launch", region_to_run = "deactivatingRegion", workflow = "activatePrimary", order = 1
      timeout     = 120, retry_minutes = 1, step_timeout_minutes = 45, stateful_only = true
      description = "Launch for failback in the primary (into the original instance when configured; stops it first)"
    }
    "register-failback-target" = {
      module      = "register_failback", region_to_run = "deactivatingRegion", workflow = "activatePrimary", order = 2
      timeout     = 300, retry_minutes = 1, step_timeout_minutes = 15, stateful_only = true
      description = "Register the failed-back EC2 in the primary target group; wait healthy"
    }
    # -- the consumer's Aurora switchover-back and DNS flip-back steps go between order 2 and 3 --
    "drs-reprotect" = {
      module      = "reprotect", region_to_run = "deactivatingRegion", workflow = "activatePrimary", order = 3
      timeout     = 120, retry_minutes = 1, step_timeout_minutes = 120, stateful_only = true
      description = "Re-point the forward source server at the failed-back EC2; wait for RESCAN to complete"
    }
    "drs-retire" = {
      module      = "retire", region_to_run = "deactivatingRegion", workflow = "activatePrimary", order = 4
      timeout     = 120, retry_minutes = 1, step_timeout_minutes = 30, stateful_only = false
      description = "Retire cycle residue (recovery instance, FAILBACK server, stale targets); assert the resting state"
    }
  }

  environment = merge(
    {
      PROJECT                    = var.project
      SOURCE_SERVER_TAG_KEY      = local.tag_key
      SOURCE_SERVER_TAG_VALUE    = local.tag_value
      PRIMARY_REGION             = var.primary_region
      SECONDARY_REGION           = var.secondary_region
      PRIMARY_TARGET_GROUP_ARN   = var.primary_target_group_arn
      SECONDARY_TARGET_GROUP_ARN = var.secondary_target_group_arn
      APP_INSTANCE_PROFILE_ARN   = var.app_instance_profile_arn
      STATEFUL_EC2               = tostring(var.stateful_ec2)
      TARGET_PORT                = tostring(var.target_port)
      DB_PARAM_NAME              = local.db_param
      INSTANCE_TYPE              = var.launch_template.instance_type
    },
    var.secondary_db_endpoint != null ? { SECONDARY_DB_ENDPOINT = var.secondary_db_endpoint } : {},
    var.launch_template.primary_subnet_id != null ? { PRIMARY_SUBNET_ID = var.launch_template.primary_subnet_id } : {},
    var.launch_template.primary_security_group_id != null ? { PRIMARY_APP_SG_ID = var.launch_template.primary_security_group_id } : {},
    var.launch_template.secondary_subnet_id != null ? { SECONDARY_SUBNET_ID = var.launch_template.secondary_subnet_id } : {},
    var.launch_template.secondary_security_group_id != null ? { SECONDARY_APP_SG_ID = var.launch_template.secondary_security_group_id } : {},
  )
}

data "aws_caller_identity" "current" { provider = aws.primary }
data "aws_partition" "current" { provider = aws.primary }

# One artifact: the whole package as a layer laid out as python/drs_region_switch/*.py.
# Functions carry a one-line stub and select the step via handler =
# "drs_region_switch.<module>.handler". Built with archive_file source blocks -- no local-exec,
# so it works the same on every OS.
data "archive_file" "layer" {
  type        = "zip"
  output_path = "${path.module}/.build/drs_region_switch-layer.zip"
  dynamic "source" {
    for_each = fileset(local.src_dir, "drs_region_switch/*.py")
    content {
      content  = file("${local.src_dir}/${source.value}")
      filename = "python/${source.value}"
    }
  }
}

data "archive_file" "stub" {
  type        = "zip"
  output_path = "${path.module}/.build/stub.zip"
  source {
    content  = "# Handlers live in the drs_region_switch layer; see the function's Handler setting.\n"
    filename = "README.txt"
  }
}

# ARC wants a function per plan region. Provider selection must be static in Terraform, so the
# per-region resources live in a submodule instantiated once per provider alias.
module "primary" {
  source    = "./modules/region"
  providers = { aws = aws.primary }

  project            = var.project
  steps              = local.steps
  environment        = local.environment
  role_arn           = aws_iam_role.orchestration.arn
  layer_zip          = data.archive_file.layer.output_path
  layer_hash         = data.archive_file.layer.output_base64sha256
  stub_zip           = data.archive_file.stub.output_path
  lambda_runtime     = var.lambda_runtime
  log_retention_days = var.log_retention_days
  function_overrides = var.function_overrides
  tags               = var.tags
}

module "secondary" {
  source    = "./modules/region"
  providers = { aws = aws.secondary }

  project            = var.project
  steps              = local.steps
  environment        = local.environment
  role_arn           = aws_iam_role.orchestration.arn
  layer_zip          = data.archive_file.layer.output_path
  layer_hash         = data.archive_file.layer.output_base64sha256
  stub_zip           = data.archive_file.stub.output_path
  lambda_runtime     = var.lambda_runtime
  log_retention_days = var.log_retention_days
  function_overrides = var.function_overrides
  tags               = var.tags
}
