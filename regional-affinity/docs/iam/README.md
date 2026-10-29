# IAM for the GitHub Actions e2e

The `regional-affinity: e2e` workflow deploys this sample, drains and restores each Region with
the Amazon Application Recovery Controller (ARC) Region switch plan, and deletes everything. It
assumes one role through GitHub OIDC: `github-actions-regional-affinity`. This directory holds that
role's trust policy and permissions policy.

## Two tiers, one role to create

`make deploy` runs `cdk deploy` without `--role-arn`, so AWS CloudFormation creates the stacks'
resources under the CDK bootstrap execution role (`cdk-hnb659fds-cfn-exec-role-*`) that the
account's `cdk bootstrap` created. The runner needs no permissions for what the stacks declare,
only `sts:AssumeRole` on the bootstrap deploy and file-publishing roles in the two Regions. The
`github-actions-drs-ec2` and `github-actions-aurora` roles in the e2e account use the same model.

The rest of the policy covers what the workflow's own steps call:

| Concern | What the runner calls | Where |
|---|---|---|
| Stack state and teardown | `DescribeStacks`, `DescribeStackEvents`, `DeleteStack` on `regional-affinity*` stacks | `Makefile`, `cleanup.sh`, `scripts/demo.py` |
| Customer profiles | `BatchWriteItem` into the first Region's replica, `GetItem` from the second to confirm replication | `scripts/demo.py seed` |
| The plan | `ListRoute53HealthChecks`, `GetPlan`, `UpdatePlan` (a no-op update that makes ARC evaluate the plan again once the records exist), `GetPlanEvaluationStatus`, `StartPlanExecution`, `GetPlanExecution` | `scripts/demo.py` |
| The plan's execution role | `iam:PassRole` to `arc-region-switch.amazonaws.com` only; `UpdatePlan` passes the role the plan already names | `scripts/demo.py verify` |
| Record bindings | `route53:ListResourceRecordSets` | `scripts/demo.py verify` |
| Requests from inside the VPCs | `lambda:InvokeFunction` on the two `*-probe` functions | `scripts/demo.py` |

`test/github-actions-role-policy.test.ts` reads every AWS CLI call in the `Makefile`, `cleanup.sh`
and `scripts/demo.py`, and fails when the policy does not grant the matching action or grants one
that nothing calls.

## Create the role (once per account)

The JSON files use the placeholder `ACCOUNT_ID`. The GitHub OIDC provider
(`token.actions.githubusercontent.com`) must already exist in the account, and the account must
be CDK-bootstrapped in `us-east-1` and `us-east-2`.

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
sub() { sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" "$1"; }

# 2 h max session: the workflow requests role-duration-seconds 7200, and a full run takes about
# 1 h (deploy ~15 min, rehearsal ~20 min, cleanup ~25 min).
aws iam create-role --role-name github-actions-regional-affinity \
  --assume-role-policy-document "$(sub docs/iam/github-actions-role-trust.json)" \
  --max-session-duration 7200 \
  --description "GitHub Actions OIDC role for the regional-affinity sample e2e"
aws iam put-role-policy --role-name github-actions-regional-affinity \
  --policy-name deploy-and-cleanup \
  --policy-document "$(sub docs/iam/github-actions-role-policy.json)"
```

The trust condition `repo:aws-samples/sample-resilience-patterns:*` matches the other roles in the
same account. For a fork, change the `sub` claim to your repository.

## Quotas the e2e account needs

Each run creates one VPC in each Region (the default quota is 5 per Region) and one Region switch
plan (the default quota is 10 per account). The e2e names every stack and resource
`regional-affinity-<first 6 characters of the commit>`, so runs of different commits do not collide.

## Known limits

- The stack, table, function and role grants are bounded by the `regional-affinity` prefix, not by
  run: the role can act on any run's resources in the account, which is what lets a run clean up
  after an earlier one of the same commit.
- `route53:ListResourceRecordSets` is on `hostedzone/*`: the zone ID exists only after the plan
  stack is deployed, and Route 53 hosted zones cannot be scoped by name.
- A run that fails leaves its stacks in place for diagnosis; the next run uses a new prefix and
  does not delete them. Remove them from a terminal with
  `PROJECT=regional-affinity-<sha6> ./cleanup.sh`.
