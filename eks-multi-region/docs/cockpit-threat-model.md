# Threat model note: Resilience Cockpit write role

Scope: the `Cockpit` construct's Lambda execution role in `eks-mr-demo`
(`src/cdk/lib/constructs/cockpit/cockpit.ts`), which holds fault-injection and
region-failover write permissions, including one `iam:PassRole` grant.

This note exists because it is **required**, not as documentation garnish. AWS guidance's
privilege-escalation guidance states the obligation directly:

> If your service needs to make use of IAM operation which can potentially lead to
> privilege escalation for your service intended operations, please speak with your
> security reviewer and enumerate any threats/risks regarding the necessary allowed
> actions in your threat model.

`iam:PassRole` is such an operation. What follows is that enumeration.

Guidance consulted: AWS IAM least-privilege guidance (IAM Authorization and Least Privilege
Defaults), AWS guidance **Prevent Privilege Escalation**, and the recommendation engine's
**Use IAM Roles and Scoped Down Policies** (BEST_PRACTICE).

---

## 1. What the role can do

| Action | Resource | Constraint |
|---|---|---|
| `ssm:GetParameter(s)`, `ssm:PutParameter` | the two error-rate parameter ARNs | threaded names, no wildcard segment |
| `ec2:CreateTags` / `DeleteTags` | `arn:aws:ec2:us-east-2:<acct>:instance/*` | primary region, instances only |
| `fis:StartExperiment` / `StopExperiment` / read | primary-region templates + experiments | pre-existing templates only |
| `iam:PassRole` | the FIS service role ARN (threaded) | `iam:PassedToService = fis.amazonaws.com` |
| `arc-region-switch:StartPlanExecution`, `UpdatePlanExecutionStep` | the plan ARN (threaded) | one plan |
| `arc-zonal-shift:StartZonalShift` / `UpdateZonalShift` / `CancelZonalShift` | `*` + `StringLike` on `arc-zonal-shift:ResourceIdentifier` = the app NLB ARN (threaded) | the service scopes by CONDITION KEY, not the Resource element; an ARN in `Resource` authorizes nothing. No `iam:PassRole`: zonal shift passes no service role. Blast radius: one AZ removed from one demo NLB in the primary region, self-expiring (≤72h, default 15m). |
| `arc-zonal-shift:ListZonalShifts` / `ListManagedResources` / `GetManagedResource` | `*` | account/Region-wide listers with no resource type; read-only, own statement so nothing mutating rides the wildcard |
| assorted `Describe*` / `List*` / CloudWatch reads | `*` where AWS does not support scoping | read-only |

A `CockpitRoleBoundary` permissions boundary caps all of it. Because a boundary is an
intersection, its explicit `Deny` wins over any future `Allow` added to the role in a hurry.

## 2. The `iam:PassRole` grant

AWS FIS requires the caller to pass it a service role; there is no way to start an
experiment without `iam:PassRole`. That role
(`AWSFaultInjectionSimulator{EC2,ECS,EKS,Network,RDS,SSM}Access`) can degrade compute,
networking and databases in the account, so the grant is genuinely powerful.

Controls, defence in depth:

1. **Exact resource.** The threaded FIS role ARN, not a wildcard and no longer a prefix on
   a generated role name.
2. **Condition key.** `StringEquals: {"iam:PassedToService": "fis.amazonaws.com"}`; the
   role cannot be handed to EC2, Lambda, CloudFormation or anything else.
3. **Boundary counterpart.** The boundary carries the inverse:
   `Deny iam:PassRole` with `StringNotEquals: {"iam:PassedToService": "fis.amazonaws.com"}`.
   Both halves must be edited to widen this, and the boundary deny cannot be overridden by
   an identity policy.
4. **The FIS role's own trust policy** restricts `sts:AssumeRole` to `fis.amazonaws.com`
   with `aws:SourceAccount` and `aws:SourceArn` conditions, so possession of the ARN is not
   sufficient to assume it.

**The FIS service-linked role is deploy-time plumbing, never a cockpit grant.** On the
first `fis:StartExperiment` in an account, FIS creates `AWSServiceRoleForFIS` using the
*caller's* `iam:CreateServiceLinkedRole`. The boundary's `Deny iam:Create*` blocks that.
This was observed live 2026-09-01 as an AccessDenied naming this boundary, so the control
is working. It is not a defect: a demo-facing web role must not create IAM roles of any
kind (per the "Prevent Privilege Escalation" best practice; SLRs are also the tamper-proof
model that AWS service-linked-role guidance favors). Phase 0 of `make deploy` creates the
SLR idempotently with the deployer's credentials instead, so the cockpit role never needs
the action. Do not "fix" a recurrence by widening the boundary.

**Why the boundary differs from `PlanRoleBoundary` on purpose.** That policy denies
`iam:PassRole` outright. Cloning it here would intersect away the one grant FIS needs, and
the failure would surface as an authorization error pointing at a role policy where the
grant is present and looks correct. The narrower `StringNotEquals` form is the reason this
is a separate managed policy rather than a reuse.

## 3. Escalation chains considered

the guidance asks specifically about combinations; "permissions when combined may
enable broader actions that may not be intended."

| Documented chain | Present? | Why not exploitable |
|---|---|---|
| `iam:PassRole` + `ec2:RunInstances` | **No** | The role has no `RunInstances`. It cannot create compute to attach a role to. |
| `iam:PassRole` + `cloudformation:CreateStack` + `cloudformation:DescribeStacks` | **No** | Never had `CreateStack`. Step 5 also **removed** `DescribeStacks` (see §4). |
| `iam:PassRole` + `lambda:CreateFunction` / `UpdateFunctionCode` | **No** | No Lambda write actions. Notably it cannot rewrite **its own** code, which would otherwise be a self-escalation path. |
| Permission mutation (`iam:Put*`, `Attach*`, `Create*`, …) | **No** | Enumerated in the boundary's `Deny`. |
| Credential mutation (`iam:CreateAccessKey`, `UpdateLoginProfile`, …) | **No** | Same `Deny`. |
| `organizations:*`, `account:*` | **No** | Same `Deny`. |

`iam:SimulatePrincipalPolicy` is intentionally **not** denied. It is read-only, and a
blanket `iam:*` deny previously left ARC plan evaluation permanently in `actionRequired`
because plan evaluation calls it (observed 2026-08-26).

## 4. What Step 5 changed, and why it is a security change

Before Step 5 the handler discovered ARNs at runtime with
`cloudformation:DescribeStacks`. That was convenient and it was also **two-thirds of a
documented escalation chain** sitting in one role: AWS guidance lists
`iam:PassRole` + `cloudformation:CreateStack` + `cloudformation:DescribeStacks` as a path to
"get access to an IAM role by creating a CloudFormation template to create new
instances/functions, passing the role to the instances/functions, and run them."

The chain was incomplete (`CreateStack` was never granted), so this was not an exploitable
finding. But relying on a missing third leg is a weaker position than not holding the
pattern at all. Threading the ARNs as CfnParameters removed the need for discovery, so the
grant is gone, and three resource scopes tightened as a side effect:

| | Before | After |
|---|---|---|
| knob | `:parameter/eks-mr-demo-*/error-rate` | the two exact parameter ARNs |
| PassRole | `:role/eks-mr-demo-region-us-east-2-FisFisRole*` | the exact FIS role ARN |
| ARC plan | `:plan/*` (every plan in the account) | the exact plan ARN |

## 5. Authorization for the actions themselves

The cockpit can trigger a **regional failover**, which is high-impact by design. Its
authorization is the network path plus IAM, not a browser gate:

- The cockpit is served only by the standby region's internal operator-access ALB, whose
  sole ingress is the observer VPC CIDR. The only route in is the third-region observer
  bastion (no public IP, no inbound rules) over SSM Session Manager, so reaching the
  cockpit at all requires `ssm:StartSession` on that bastion. An operator without that
  access cannot see it.
- The ARC plan carries **no approval gate**, so `StartPlanExecution` succeeding *is* the
  authorization. The typed confirmation in the handler is UI friction to prevent a misclick,
  and is **not** claimed as a security control.
- The Lambda is not internet-reachable: the ALB is internal and there is no public front door.

**Accepted risk:** anyone with SSM access to the observer bastion and the cockpit's IAM
grant can fail over the demo or inject faults into it. That is the intended capability of
an operator cockpit, the blast radius is one dedicated demo account with no customer data,
and CloudTrail records every call with the role session. Do not extend this pattern to an
account with production or customer data without replacing the typed confirmation with a
real second-actor control.

## 6. Residual items

- **Read actions on `*`.** `ec2:DescribeInstances`, `eks:ListClusters`,
  `cloudwatch:GetMetricData`, `rds:DescribeGlobalClusters` and similar do not support
  resource-level scoping. All are read-only. The same justification is carried inline in
  the region-switch execution role for the same actions.
- **`ec2:CreateTags` on `instance/*`.** Scoped to primary-region instances, but not to the
  node group's instances specifically. An instance ARN condition would need the instance
  ids, which are not known at synth time (they are AWS-owned ASG members, which is why
  tagging is the arming gesture at all). The tag written is only `ChaosAllowed`, which is
  inert unless a FIS template selects on it.
- **No EKS view access entry yet**, so the replica tile stays `unavailable`. That is a
  missing read, not a permission risk.

## 7. Verification

Automated, in `test/cockpit.test.ts`:

- no mutating action carries a bare wildcard resource
- `iam:PassRole` resolves to the threaded FIS role ARN and carries the `PassedToService` condition
- the boundary denies PassRole with `StringNotEquals` (inverting it fails the test)
- the boundary denies the escalation set but not `SimulatePrincipalPolicy`
- `cloudformation:DescribeStacks` and `CreateStack` are absent
- declared CfnParameters === threaded CfnParameters, both directions

Each of these was mutation-proven: the assertion fails when the control it describes is
removed or inverted.

Manual, per deploy: confirm plan evaluation reports `passed`, and that the knob write,
FIS arm/start/stop and a dry-run failover behave as described from the deployed cockpit.
