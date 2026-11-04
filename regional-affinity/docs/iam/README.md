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
| Stack state and teardown | `DescribeStacks` (which also returns the stack's tags), `DescribeStackEvents`, `DeleteStack` on `regional-affinity*` stacks | `Makefile`, `cleanup.sh`, `scripts/demo.py` |
| Customer profiles | `BatchWriteItem` into the first Region's replica, `GetItem` from the second to confirm replication | `scripts/demo.py seed` |
| The plan | `ListPlansInRegion` (finds the plan by name, in one Region), `ListRoute53HealthChecks`, `ListRoute53HealthChecksInRegion`, `GetPlan`, `UpdatePlan` (a no-op update that makes ARC evaluate the plan again once the records exist), `GetPlanEvaluationStatus`, `StartPlanExecution`, `GetPlanExecution` | `scripts/demo.py` |
| The plan's execution role | `iam:PassRole` to `arc-region-switch.amazonaws.com` only; `UpdatePlan` passes the role the plan already names | `scripts/demo.py verify` |
| Record bindings | `route53:ListResourceRecordSets` | `scripts/demo.py verify` |
| Requests from inside the VPCs | `lambda:InvokeFunction` on the two `*-probe` functions | `scripts/demo.py` |

`test/github-actions-role-policy.test.ts` reads the AWS CLI calls written out in the `Makefile`,
`cleanup.sh` and `scripts/demo.py` (`aws <service> <operation>` in the shell files,
`aws(region, "<service>", "<operation>", ...)` in the script). It fails when the policy does not
grant the action of one of them, grants an action that none of them uses, or changes a statement's
resources or effect. It does not read a call's arguments, so it cannot tell which resource a call is
aimed at: the test pins each statement's resources instead, and a change to them is reviewed by hand.

## Create the role (once per account)

The JSON files use the placeholder `ACCOUNT_ID`. The GitHub OIDC provider
(`token.actions.githubusercontent.com`) must already exist in the account, and the account must
be CDK-bootstrapped in `us-east-1` and `us-east-2`.

Run these commands from the `regional-affinity/` directory: they read `docs/iam/*.json` by relative
path.

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
sub() { sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" "$1"; }

# 2 h max session: the workflow requests role-duration-seconds 7200, and a full run takes about
# 50 min (deploy ~13 min, rehearsal ~11 min, cleanup ~25 min).
aws iam create-role --role-name github-actions-regional-affinity \
  --assume-role-policy-document "$(sub docs/iam/github-actions-role-trust.json)" \
  --max-session-duration 7200 \
  --description "GitHub Actions OIDC role for the regional-affinity sample e2e"
aws iam put-role-policy --role-name github-actions-regional-affinity \
  --policy-name deploy-and-cleanup \
  --policy-document "$(sub docs/iam/github-actions-role-policy.json)"
```

## Who can use the role, and what it can reach

The trust condition `repo:aws-samples/sample-resilience-patterns:*` matches the other roles in the
same account. It lets any workflow run in the repository assume the role: any branch, tag,
pull request from the same repository, or manual run.

The role can assume the account's CDK deploy and file-publishing roles. The deploy role hands
CloudFormation the bootstrap execution role, and `cdk bootstrap` gives that role
`AdministratorAccess` unless you change it
([Customize bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-customizing.html)).
So a workflow that can assume this role can deploy, change or delete anything in the e2e account, not
only resources named `regional-affinity*`. The `regional-affinity` prefix bounds the statements that
name the runner's own calls, and nothing more. Use a sandbox account that holds nothing else.

To narrow what a run can reach:

- Bootstrap the account with a narrower execution policy:
  `cdk bootstrap --cloudformation-execution-policies <managed policy ARN>`. The policy has to allow
  everything the stacks create: a VPC, an ALB, Lambda functions, a DynamoDB table, Route 53 and
  Region switch resources, IAM roles and log groups.
- Or narrow the `sub` condition in `github-actions-role-trust.json` to the runs that need the role,
  for example `repo:aws-samples/sample-resilience-patterns:pull_request` and
  `repo:aws-samples/sample-resilience-patterns:ref:refs/heads/main`. A pull request from a branch
  of the same repository can still change the workflow it runs. If that matters, have the e2e job
  use a GitHub environment with required reviewers; the `sub` claim then ends in
  `environment:NAME`.

### Forks, renames and the `sub` claim

GitHub builds the `sub` claim from the repository's owner and name. For repositories created after
July 15, 2026, and for any repository renamed or transferred after that date, it also includes the
numeric owner and repository IDs, so a name cannot be reused by someone else
([OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc)):

| Repository | `sub` of a pull request run |
|---|---|
| Created before July 15, 2026, not renamed or transferred since | `repo:OWNER/REPO:pull_request` |
| Created after July 15, 2026, or renamed or transferred since | `repo:OWNER@OWNER-ID/REPO@REPO-ID:pull_request` |

A fork is a new repository, so a fork created after that date uses the second form, and a condition
written as `repo:OWNER/REPO:*` never matches it: `configure-aws-credentials` then fails with "Not
authorized to perform sts:AssumeRoleWithWebIdentity". Renaming or transferring this repository
moves it to the second form too, and its trust policy then needs the new condition.

To see which form your repository uses, print the claim from a workflow run. A job with
`permissions: id-token: write` can run this step (the claim is not a secret):

```bash
curl -sS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" \
  | python3 -c 'import sys, json, base64; t = json.load(sys.stdin)["value"].split(".")[1]; print(json.loads(base64.urlsafe_b64decode(t + "=" * (-len(t) % 4)))["sub"])'
```

The two IDs are in the repository's API record:
`gh api repos/OWNER/REPO --jq '.owner.id, .id'`. Then set the `StringLike` condition to
`repo:OWNER@OWNER-ID/REPO@REPO-ID:*` (or one of the narrower forms above, with the IDs in the same
place).

## Quotas the e2e account needs

Each run creates one VPC in each Region (the default quota is 5 per Region) and one Region switch
plan (the default quota is 10 per account). The e2e names every stack and resource
`regional-affinity-<first 6 characters of the commit>`, so runs of different commits do not collide.
Runs of different Git refs can run at the same time, and each one takes that VPC and plan from the
quotas. The e2e workflow queues the runs of one ref behind each other (a concurrency group per pull
request branch, or per ref name for a manual run) and never cancels one that is running, so two runs
of one commit never share stack names.

## Known limits

- The stack, table, function and role grants are bounded by the `regional-affinity` prefix, not by
  run: the role can act on any run's resources in the account, which is what lets a run clean up
  after an earlier one of the same commit.
- `route53:ListResourceRecordSets` is on `hostedzone/*`: the zone ID exists only after the plan
  stack is deployed, and Route 53 hosted zones cannot be scoped by name.
- `arc-region-switch:ListPlansInRegion` has no resource type, so it is the one statement with
  `Resource: "*"`. It lists the names and ARNs of the account's plans in a Region.
- The e2e account ID is a repository variable, not a secret. The credentials steps mask it in the
  output that follows them (`mask-aws-account-id`), but the log line that shows a step's own inputs,
  including the role ARN, is written before the step runs.
- A run that fails, is cancelled or times out leaves its stacks in place for diagnosis: cleanup runs
  only after a successful run, and the next run uses a new prefix, so it does not delete them. The
  failed run prints a notice with the exact command. Remove the stacks either from a terminal, in
  `regional-affinity/` with credentials for the e2e account, with
  `PROJECT=regional-affinity-<sha6> ./cleanup.sh`, or by starting the `regional-affinity: cleanup`
  workflow with its `project` input set to `regional-affinity-<sha6>`. Without that input the workflow
  cleans the default `regional-affinity` names, which the e2e never uses. Cleanup deletes only stacks
  that carry the tag `sample=regional-affinity`.
