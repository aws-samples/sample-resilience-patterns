# IAM for CI (GitHub Actions) and for CloudFormation

Two roles, two tiers -- the same shape `cdk deploy` gives the sibling patterns for free
through the `cdk-*` bootstrap roles. This pattern drives CloudFormation change-sets
directly (`build/deploy-stack.sh`, because `aws cloudformation deploy` cannot take
`--template-url`), so the split is explicit here:

| Role | Assumed by | Holds |
|---|---|---|
| `github-actions-eks-multi-region` | GitHub Actions via OIDC | ONLY what the workflow's own shell steps call: change-sets, the assets buckets, ECR (mirror + app images), CodeBuild (the in-VPC installer), read-only EKS/EC2/SSM/ARC for verification, the observer-peering accepter step -- plus `iam:PassRole` on exactly one role, below |
| `eks-multi-region-cfn-exec` | CloudFormation (`--role-arn` on every change-set) | the resource permissions the 12 templates need, derived from the resource types they declare. Its IAM authority (create/modify roles, policies, instance profiles, PassRole) is bounded to names prefixed `eks-mr-demo-` -- every stack name starts with that prefix, so every CloudFormation-generated IAM name does too. Renaming the project means renaming this prefix in the policy. |

The GitHub role can create no infrastructure by itself; CloudFormation does that with the
execution role. `build/deploy-stack.sh` passes the execution role whenever `ROLE_ARN` is
set in the environment, which the e2e workflow does. Locally, leave `ROLE_ARN` unset and
your own credentials are used for everything (the pre-existing behaviour).

## Create them (once per account)

The JSON files use the placeholder `ACCOUNT_ID`; substitute at apply time. The GitHub
OIDC provider (`token.actions.githubusercontent.com`) must already exist in the account
-- it does in the aws-samples e2e account; for your own account see the
[GitHub docs](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services).

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
sub() { sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" "$1"; }

# 1. The CloudFormation execution role (the broad one; only CloudFormation can assume it).
aws iam create-role --role-name eks-multi-region-cfn-exec \
  --assume-role-policy-document "$(sub docs/iam/cfn-exec-role-trust.json)" \
  --description "CloudFormation execution role for the eks-multi-region sample stacks"
aws iam put-role-policy --role-name eks-multi-region-cfn-exec \
  --policy-name deploy-stacks \
  --policy-document "$(sub docs/iam/cfn-exec-role-policy.json)"

# 2. The GitHub Actions role (the narrow one). 8h max session: the rail runs ~90 min and
#    the e2e requests role-duration-seconds 28800, matching the other multi-region samples.
aws iam create-role --role-name github-actions-eks-multi-region \
  --assume-role-policy-document "$(sub docs/iam/github-actions-role-trust.json)" \
  --max-session-duration 28800 \
  --description "GitHub Actions OIDC role for the eks-multi-region sample e2e"
aws iam put-role-policy --role-name github-actions-eks-multi-region \
  --policy-name deploy-and-cleanup \
  --policy-document "$(sub docs/iam/github-actions-role-policy.json)"
```

The trust condition `repo:aws-samples/sample-resilience-patterns:*` matches the existing
`github-actions-aurora` / `github-actions-s3mrap-crr` roles in the same account. For a
fork, change the `sub` claim to your repository.

## Why not reuse `github-actions-aurora`?

Its trust already covers this repository, but its permissions are aurora's: RDS, Lambda,
Synthetics, ARC, SSM, plus `sts:AssumeRole` on the CDK bootstrap roles. It has no EKS,
ECR, CodeBuild or S3, so `make mirror`, the in-VPC installer and the assets buckets would
all be denied. Extending it would widen every aurora run's blast radius for no benefit; a
per-pattern role is the convention in this repository.
