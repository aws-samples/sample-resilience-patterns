# IAM for the GitHub Actions e2e

The `drs-ec2: e2e` workflow deploys this sample from an empty account, runs a fail-over and
fail-back cycle, and deletes everything. It assumes one role through GitHub OIDC:
`github-actions-drs-ec2`. This directory holds that role's trust policy and permissions
policy.

## Two tiers, one role to create

`make deploy` runs `cdk deploy` without `--role-arn`, so CloudFormation creates the stacks'
resources under the CDK bootstrap execution role (`cdk-hnb659fds-cfn-exec-role-*`), which
the account's `cdk bootstrap` created. The runner never needs resource permissions for what
the stacks declare. It needs `sts:AssumeRole` on the bootstrap deploy, file-publishing,
image-publishing and lookup roles in the three Regions, which is the same model the
`github-actions-aurora` role in the e2e account uses.

Everything else in the policy is what the workflow's own shell steps call directly:

| Concern | What the runner calls | Where |
|---|---|---|
| Stack state and teardown | `DescribeStacks`, `DescribeStackEvents`, `DescribeStackResources`, `DeleteStack` on `drsdemo-*` | `Makefile`, `cleanup.sh`, `scripts/*.sh` |
| Application code bucket | create, upload, empty, delete `drsdemo-app-code-ACCOUNT_ID-us-east-2` | `scripts/app-code.sh`, `cleanup.sh` |
| Observer peering | `ec2:AcceptVpcPeeringConnection` | `Makefile` (`net-3`) |
| AWS DRS set-up | `InitializeService`, replication and launch configuration templates, source-server configuration, `TagResource` | `scripts/drs-setup.sh` |
| AWS DRS service roles | `iam:CreateRole`, `iam:AttachRolePolicy`, `iam:CreateInstanceProfile`, `iam:AddRoleToInstanceProfile` on the six `AWSElasticDisasterRecovery*Role` names, the six AWS managed policies only | `scripts/create-drs-service-roles.py` |
| Launch template for recovery | `ec2:CreateLaunchTemplateVersion`, `ec2:ModifyLaunchTemplate` on DRS-managed templates; `iam:PassRole` of `drsdemo-app-instance-role` to EC2 | `scripts/drs-setup.sh` |
| Agent install and app refresh | `ssm:SendCommand` with `AWS-RunShellScript`, `ssm:GetCommandInvocation`, `ssm:DescribeInstanceInformation` | `scripts/app-code.sh`, `scripts/drs-setup.sh`, `scripts/rehearse-cycle.sh` |
| Rehearsal | `arc-region-switch:StartPlanExecution`, `GetPlanExecution`, `GetPlanEvaluationStatus`, `ListRoute53HealthChecks` on the `drsdemo-switchover` plan; `rds:DescribeGlobalClusters`; `elasticloadbalancing:DescribeTargetHealth`; `lambda:GetFunctionConfiguration` | `scripts/rehearse-cycle.sh`, `scripts/rehearse-switchover.sh`, `scripts/status.sh` |
| AWS DRS teardown | `StopReplication`, `StopFailback`, `TerminateRecoveryInstances`, `DisconnectSourceServer`, `DeleteSourceServer`; delete the two security groups DRS creates per staging VPC; delete the runtime SSM parameter | `cleanup.sh` |

The runner does not call `drs:StartRecovery`, `drs:ReverseReplication` or
`drs:StartFailbackLaunch`. The ARC Region switch plan's Lambda functions do, under their own
orchestration role (`lib/constructs/drs-region-switch-steps.ts`). That role, not this one,
carries the forwarded-access DRS actions and the `aws:ViaAWSService` EC2 grants that a
recovery launch needs.

`test/github-actions-role-policy.test.ts` reads every `aws <service> <operation>` in the
runner's scripts and the helper's boto3 calls, and fails when the policy does not grant the
matching action. A new call in a script fails there instead of as an `AccessDenied` an hour
into a live run.

## Create the role (once per account)

The JSON files use the placeholder `ACCOUNT_ID`. The GitHub OIDC provider
(`token.actions.githubusercontent.com`) must already exist in the account, and the account
must be CDK-bootstrapped in `us-east-1`, `us-east-2` and `us-west-2`.

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
sub() { sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" "$1"; }

# 4 h max session: the workflow requests role-duration-seconds 14400 and a full run takes
# about 2 h (deploy ~60 min, two-leg stateful rehearsal ~55 min, cleanup ~30 min).
aws iam create-role --role-name github-actions-drs-ec2 \
  --assume-role-policy-document "$(sub docs/iam/github-actions-role-trust.json)" \
  --max-session-duration 14400 \
  --description "GitHub Actions OIDC role for the drs-ec2 sample e2e"
aws iam put-role-policy --role-name github-actions-drs-ec2 \
  --policy-name deploy-and-cleanup \
  --policy-document "$(sub docs/iam/github-actions-role-policy.json)"
```

The trust condition `repo:aws-samples/sample-resilience-patterns:*` matches the existing
`github-actions-aurora` and `github-actions-s3mrap-crr` roles in the same account. For a
fork, change the `sub` claim to your repository. To restrict the role to pull requests,
use `repo:<owner>/<repo>:pull_request`.

## Known limits of the static derivation

- `drs:InitializeService` creates the `AWSServiceRoleForElasticDisasterRecovery`
  service-linked role the first time AWS DRS is used in an account. The e2e account already
  has it. If a first run in a new account fails at that step, add `iam:CreateServiceLinkedRole`
  on `arn:aws:iam::ACCOUNT_ID:role/aws-service-role/drs.amazonaws.com/AWSServiceRoleForElasticDisasterRecovery`
  with the condition `iam:AWSServiceName = drs.amazonaws.com`.
- `iam:CreateRole` on the six AWS DRS service-role names lets the runner set those roles'
  trust policies. IAM cannot constrain the trust document itself. Creating the roles once by
  hand and removing the two `iam:Create*` statements is the tighter option.
- The AWS DRS source-server and recovery-instance grants are bounded by account and Region,
  not by tag. `cleanup.sh` deletes every source server it finds, including the untagged
  FAILBACK servers a stateful fail-back creates.
- `ec2:DeleteSecurityGroup` is bounded by Region. `cleanup.sh` selects the groups by the
  `AWS Elastic Disaster Recovery` name prefix that DRS gives them.
