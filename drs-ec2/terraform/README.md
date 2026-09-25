# AWS DRS custom actions for ARC Region Switch

Use this Terraform module to add AWS Elastic Disaster Recovery (AWS DRS) custom actions to an Amazon Application Recovery Controller (ARC) Region Switch plan. It fails a DRS-replicated Amazon EC2 tier over to a secondary AWS Region and, for stateful instances, fails back into the original instance. The module packages the same Python handlers as [`../lib/constructs`](../lib/constructs).

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

In `aws_arcregionswitch_plan`, add a `dynamic "step"` block over `module.drs.activate_secondary_steps` for ACTIVATE secondary and `module.drs.activate_primary_steps` for ACTIVATE primary. Insert Aurora and DNS steps at `module.drs.activate_primary_split`. See [`examples/plan`](examples/plan/main.tf) for a complete plan.

## Resources

| Resource | Scope | Count |
|---|---|---|
| `aws_lambda_layer_version`, the `drs_region_switch` package | each AWS Region | 2 |
| `aws_lambda_function`, one per step, `handler = drs_region_switch.<module>.handler`, one-line stub package | each AWS Region | 14 |
| `aws_cloudwatch_log_group`, 1-day retention by default | each AWS Region | 14 |
| `aws_iam_role`, orchestration role for AWS DRS, the `ViaAWSService` EC2 set, tag-scoped `StopInstances` for launch-into, `PassRole`, Elastic Load Balancing, and Systems Manager | global | 1 |

Functions run in both plan AWS Regions. Each emitted step references its function through `region_to_run`.

## Steps

| Step | Workflow | Runs in | Action |
|---|---|---|---|
| `drs-recover-ec2` | activate secondary | activating | `StartRecovery` for the tagged source server and wait for RUNNING |
| `register-target` | activate secondary | activating | Update the app DB Systems Manager parameter and register the recovered Amazon EC2 instance in the secondary target group |
| `drs-reverse-replicate` | activate primary | deactivating | Reverse replication from the recovery instance to the primary, stateful only |
| `drs-failback-launch` | activate primary | deactivating | Launch fail-back into the original instance when configured, after stopping it |
| `register-failback-target` | activate primary | deactivating | Register and verify the failed-back Amazon EC2 instance in the primary target group |
| *(your Aurora switchover-back and DNS flip-back go here)* | | | |
| `drs-reprotect` | activate primary | deactivating | Repoint the forward source server at the failed-back Amazon EC2 instance and wait for RESCAN |
| `drs-retire` | activate primary | deactivating | Terminate the recovery instance, delete `FAILBACK` state, and empty the secondary target group |

Stateful-only steps return `SKIPPED` in seconds when `stateful_ec2 = false`.

## Layer-only use

To define your own functions, use `module.drs.layer_arns` and `module.drs.handlers`. Create one `aws_lambda_function` per step with `layers = [layer_arn]`, `handler = module.drs.handlers["<step>"]`, a stub package, the environment from the table in `main.tf`, and a role that uses the statements in `iam.tf`.

## Prerequisites

- Initialize AWS DRS in both AWS Regions. Configure a replication template with a staging subnet in the secondary, and configure the primary launch configuration template with `launchIntoSourceInstance` for stateful fail-back.
- Run the AWS DRS agent on the protected Amazon EC2 instance. Tag its source server with `<project>:role = app` or `source_server_tag`, and confirm replication is `CONTINUOUS`.
- For launch-into-source, use a Linux BIOS boot configuration, `AWSDRS = AllowLaunchingIntoThisInstance`, and an instance profile with `AWSElasticDisasterRecoveryRecoveryInstancePolicy`.

## Requirements

Terraform >= 1.5, `hashicorp/aws` >= 6.0 (`aws_arcregionswitch_plan`), and `hashicorp/archive` >= 2.4.
