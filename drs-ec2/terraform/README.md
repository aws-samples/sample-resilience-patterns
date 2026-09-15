# drs-region-switch (Terraform module)

DRS orchestration steps for an [ARC Region Switch](https://docs.aws.amazon.com/r53recovery/latest/dg/region-switch.html)
plan: fail a DRS-replicated EC2 tier over to the secondary region and -- for stateful instances --
back **onto the original instance**, ending every cycle at the same resting state. The Terraform
flavour of the CDK construct in [`../lib/constructs`](../lib/constructs); same Python handlers,
same seven steps.

```hcl
module "drs" {
  source    = "github.com/aws-samples/sample-resilience-patterns//drs-ec2/terraform?ref=<tag>"
  providers = { aws.primary = aws.primary, aws.secondary = aws.secondary }

  project                    = "myapp"
  primary_region             = "us-east-2"
  secondary_region           = "us-west-2"
  primary_target_group_arn   = aws_lb_target_group.primary.arn
  secondary_target_group_arn = aws_lb_target_group.secondary.arn
  app_instance_profile_arn   = aws_iam_instance_profile.app.arn
  app_instance_role_arn      = aws_iam_role.app.arn
  db_endpoint_parameter_name = "/myapp/db-writer-endpoint"   # optional
  secondary_db_endpoint      = aws_rds_cluster.secondary.endpoint
  stateful_ec2               = true
}

resource "aws_iam_role_policy" "plan_drs_steps" {
  role   = aws_iam_role.plan.id
  policy = module.drs.plan_role_policy_json
}
```

Then in `aws_arcregionswitch_plan`, add the steps with a `dynamic "step"` block over
`module.drs.activate_secondary_steps` (ACTIVATE secondary) and `module.drs.activate_primary_steps`
(ACTIVATE primary, with your Aurora / DNS steps inserted at index `module.drs.activate_primary_split`).
A complete plan is in [`examples/plan`](examples/plan/main.tf).

## What it creates

| Resource | Where | Count |
|---|---|---|
| `aws_lambda_layer_version` -- the `drs_region_switch` package | each region | 2 |
| `aws_lambda_function` -- one per step, `handler = drs_region_switch.<module>.handler`, one-line stub package | each region | 14 |
| `aws_cloudwatch_log_group` -- 1-day retention by default | each region | 14 |
| `aws_iam_role` -- orchestration role (DRS, ViaAWSService EC2 set, tag-scoped `StopInstances` for launch-into, PassRole, ELB, SSM) | global | 1 |

Functions are deployed to **both** plan regions, as ARC's custom-action guidance asks; each emitted
step references the function in its `region_to_run` region.

## The seven steps

| Step | Workflow | Runs in | What it does |
|---|---|---|---|
| `drs-recover-ec2` | activate secondary | activating | `StartRecovery` of the tagged source server; waits for RUNNING |
| `register-target` | activate secondary | activating | repoints the app's DB SSM parameter; registers the recovered EC2 in the secondary target group |
| `drs-reverse-replicate` | activate primary | deactivating | reverse replication of the recovery instance back to the primary (stateful only) |
| `drs-failback-launch` | activate primary | deactivating | launch for failback -- into the original instance when configured (stops it first) |
| `register-failback-target` | activate primary | deactivating | registers / verifies the failed-back EC2 in the primary target group |
| *(your Aurora switchover-back and DNS flip-back go here)* | | | |
| `drs-reprotect` | activate primary | deactivating | re-points the forward source server at the failed-back EC2; waits for RESCAN |
| `drs-retire` | activate primary | deactivating | terminates the recovery instance, deletes FAILBACK state, empties the secondary target group |

Stateful-only steps return `SKIPPED` in seconds when `stateful_ec2 = false`.

## Layer-only use

Prefer to define your own functions (naming, VPC config, tagging)? Use `module.drs.layer_arns`
and `module.drs.handlers`: create one `aws_lambda_function` per step with `layers = [layer_arn]`,
`handler = module.drs.handlers["<step>"]`, a stub package, the environment from the table in
`main.tf`, and a role with the statements in `iam.tf`.

## Prerequisites the module cannot create

- AWS Elastic Disaster Recovery initialised in both regions (replication template with a staging
  subnet in the secondary; the primary's launch configuration template with
  `launchIntoSourceInstance` enabled for stateful fail-back).
- The protected EC2 running the DRS agent, its source server tagged `<project>:role = app`
  (or your `source_server_tag`), replication `CONTINUOUS`.
- For launch-into-source: the EC2 boots BIOS (Linux), carries `AWSDRS = AllowLaunchingIntoThisInstance`,
  and its instance profile includes `AWSElasticDisasterRecoveryRecoveryInstancePolicy`.

## Requirements

Terraform >= 1.5, `hashicorp/aws` >= 6.0 (`aws_arcregionswitch_plan`), `hashicorp/archive` >= 2.4.
