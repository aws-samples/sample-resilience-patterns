locals {
  # Which region hosts a step, per workflow: ARC resolves RegionToRun against the workflow's target.
  region_for = {
    activateSecondary = { activatingRegion = "secondary", deactivatingRegion = "primary" }
    activatePrimary   = { activatingRegion = "primary", deactivatingRegion = "secondary" }
  }
  arns = { primary = module.primary.function_arns, secondary = module.secondary.function_arns }

  step_objects = {
    for name, s in local.steps : name => {
      name                   = name
      description            = s.description
      workflow               = s.workflow
      order                  = s.order
      region_to_run          = s.region_to_run
      retry_interval_minutes = s.retry_minutes
      timeout_minutes        = s.step_timeout_minutes
      lambda_arn             = local.arns[local.region_for[s.workflow][s.region_to_run]][name]
      stateful_only          = s.stateful_only
    }
  }

  activate_secondary_steps = [for s in sort([for n, s in local.step_objects : format("%02d|%s", s.order, n) if s.workflow == "activateSecondary"]) : local.step_objects[split("|", s)[1]]]
  activate_primary_steps   = [for s in sort([for n, s in local.step_objects : format("%02d|%s", s.order, n) if s.workflow == "activatePrimary"]) : local.step_objects[split("|", s)[1]]]
}

output "function_arns" {
  description = "Step function ARNs by region: { primary = { <step> = arn }, secondary = { ... } }."
  value       = local.arns
}

output "layer_arns" {
  description = "The drs_region_switch layer in each region, for teams that define their own functions (handler = drs_region_switch.<module>.handler)."
  value       = { primary = module.primary.layer_arn, secondary = module.secondary.layer_arn }
}

output "orchestration_role_arn" {
  value = aws_iam_role.orchestration.arn
}

output "plan_role_policy_json" {
  description = "IAM policy to attach to the aws_arcregionswitch_plan execution role (lambda:InvokeFunction/GetFunction on all step functions)."
  value       = data.aws_iam_policy_document.plan_role.json
}

output "activate_secondary_steps" {
  description = "Ordered step objects for the ACTIVATE <secondary> workflow: drs-recover-ec2, register-target. Feed a dynamic \"step\" block."
  value       = local.activate_secondary_steps
}

output "activate_primary_steps" {
  description = "Ordered step objects for the ACTIVATE <primary> workflow: reverse-replicate, failback-launch, register-failback-target, [your Aurora/DNS steps], reprotect, retire."
  value       = local.activate_primary_steps
}

output "activate_primary_split" {
  description = "Insert your Aurora switchover-back / DNS flip-back steps before this index of activate_primary_steps."
  value       = 3
}

output "handlers" {
  description = "Step name -> Lambda handler string, for teams building their own functions on layer_arns."
  value       = { for n, s in local.steps : n => "drs_region_switch.${s.module}.handler" }
}
