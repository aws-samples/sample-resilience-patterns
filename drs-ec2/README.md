# EC2 Disaster Recovery with AWS Elastic Disaster Recovery + ARC Region Switch

A stateful EC2 workload replicated cross-region by **AWS Elastic Disaster Recovery (DRS)**, fronted
by internal ALBs, backed by an **Aurora Global Database**, and failed over **and back** by a single
**Application Recovery Controller (ARC) Region Switch** plan. The DRS orchestration is a reusable CDK
construct (and a Terraform module) that plugs DRS into any Region Switch plan as custom-action
Lambda steps; the rest of the pattern is a working three-region demo that exercises it end to end.

The pattern is **cycle-safe**: every fail-back returns the estate to its resting state (same
protected primary instance, no recovery instances, empty secondary target group), so rehearsal
N+1 is identical to rehearsal 1. In stateful mode the fail-back also brings the EC2's disk state
home onto the *original* instance (DRS "launch into source instance").

## Architecture

![Two-region DRS + ARC Region Switch with Aurora Global and Route 53 failover, observed from a third region](docs/architecture.png)

Solid lines are steady state; dashed lines are only active after an ARC failover; red edges are
the plan steps. The us-east-1 observer VPC holds the SSM-only bastion the operator tunnels through
to the app's live console; it is peered to both workload VPCs and independent of either.

**Activate secondary (fail over):**

1. **Aurora Global switch** — native ARC `GlobalAuroraConfig` block, `switchoverOnly` (zero data
   loss) with `ungraceful: failover` as the fallback the operator selects at execution time.
2. **DRS recover** — `StartRecovery` for the tagged source server, watch the launch job, adopt the
   recovery instance (`recover`).
3. **Register target** — repoint the app's DB-writer SSM parameter to the new writer, register the
   recovered instance into the secondary ALB's target group, wait for `healthy` (`register-target`).
4. **DNS flip** — native ARC `Route53HealthCheck` block flips the ARC-vended health checks bound to
   the Route 53 failover record pair.

**Activate primary (fail back)** is an activate of the original region (activePassive plans have no
deactivate). Stateless mode: Aurora back → `register-failback` (re-register the original instance)
→ `retire` (terminate the recovery instance, clean DRS state) → DNS back. Stateful mode
(`STATEFUL_EC2=true`) inserts the DRS return leg — `reverse-replicate`, `failback-launch` (launch
into the stopped original instance), `reprotect` — so the disks that served in the DR region come
home. That leg has its own diagram: [`docs/failback-stateful.png`](docs/failback-stateful.png).

The app derives its region from IMDS and re-resolves the DB writer from SSM on every request, so
the recovered block clone reports the region it is actually running in and follows the writer
without a restart.

### The reusable part

`lib/constructs/drs-region-switch-steps.ts`:

- `DrsRegionSwitchSteps` — instantiate once **per region**. Deploys the seven step functions from
  one Lambda asset (`lambda/drs_region_switch/`), a 1-day log group per function, and the
  orchestration role with the exact permission set DRS recovery needs (DRS launches recovery
  instances with the *caller's* credentials).
- `DrsRegionSwitchPlanSteps` — produces typed `CfnPlan.StepProperty[]` for both workflows
  (`activateSecondarySteps`, `activatePrimarySteps`), with `interleaveActivatePrimary(...)` to slot
  your own Aurora/DNS steps between the DRS ones, and `grantInvoke(role)` for the plan's execution
  role. `lib/plan-stack.ts` shows the full composition.

`terraform/` is the same Lambda package delivered as a layer plus seven thin functions per region,
for teams using `aws_arcregionswitch_plan`; see [`terraform/README.md`](terraform/README.md).

## What's Deployed

| Stack | Region | Description |
|-------|--------|-------------|
| `drsdemo-net-primary` | us-east-2 | VPC 10.0.0.0/16, 2 public + 2 private subnets, NAT, peering requester to the secondary |
| `drsdemo-net-secondary` | us-west-2 | VPC 10.1.0.0/16, same layout, return routes over the peering |
| `drsdemo-iam` | us-east-2 | App instance role + profile (SSM, DRS agent, app runtime, dashboard read/run-plan) |
| `drsdemo-db-primary` | us-east-2 | Aurora Global cluster + primary Serverless v2 cluster (PostgreSQL 16), admin secret |
| `drsdemo-db-secondary` | us-west-2 | Secondary regional cluster joined to the global cluster |
| `drsdemo-app-primary` | us-east-2 | Private hosted zone (3 VPC associations), internal ALB, t2.small Flask app with the DRS agent, PRIMARY failover record |
| `drsdemo-alb-secondary` | us-west-2 | Internal ALB with an empty target group, recovered-app security group, SECONDARY failover record |
| `drsdemo-drs-steps-primary` | us-east-2 | `DrsRegionSwitchSteps` — the seven step functions + orchestration role |
| `drsdemo-drs-steps-secondary` | us-west-2 | Same, for steps whose `regionToRun` is the secondary |
| `drsdemo-plan` | us-east-2 | ARC Region Switch plan (activePassive, RTO 30 min) + execution role |
| `drsdemo-observer` | us-east-1 | Observer VPC, SSM-only bastion (t3.nano), peerings to both workload VPCs |

Not CloudFormation: the DRS source server (the agent self-registers; `scripts/drs-setup.sh`
initializes DRS in both regions, installs the agent via SSM, configures the launch templates and
waits for `CONTINUOUS` replication) and the app-code S3 bucket.

## Prerequisites

- An AWS account with CDK bootstrapped in us-east-2, us-west-2 and us-east-1
- AWS CLI v2 configured (`PROFILE=<name>`, `AWS_PROFILE`, or the default identity)
- Node.js 20+, Python 3.12+ (for the Lambda tests), `make`; the AWS CLI Session Manager plugin for `make tunnel`
- Optional: `ACCOUNT=<12 digits>` makes every `make` target refuse any other account

Regions are configurable (`PRIMARY_REGION`, `SECONDARY_REGION`, `OBSERVER_REGION`); the defaults are
the ones the pattern was proven in.

## Deployment

```bash
npm ci
make deploy PROFILE=<aws-profile>   # ~60 min from an empty account: ~50 min of stacks (two Aurora
                                    # clusters are the floor) + ~12 min for DRS to reach CONTINUOUS
make status PROFILE=<aws-profile>   # resting-state check: writer, ARC health checks + evaluation,
                                    # DRS replication state, target groups, bastion
make help                           # every target
```

`make deploy` runs the eleven stacks in dependency order — each step reads the previous step's
outputs and passes them as CDK context (`make stacks` alone for just the stacks) — then uploads the
app code, runs the DRS setup and finishes with `make status`. It is idempotent: re-running converges
the stacks, refreshes the running app in place via SSM rather than replacing the instance (a
replacement would cost a ~12-min re-protect), and skips the agent install when the instance is
already protected. Set `STATEFUL_EC2=true` to deploy the stateful fail-back path.

## Testing

### CDK assertion and Lambda unit tests

```bash
npx projen test                       # construct + stack assertions
cd lambda && python -m pytest -q      # step functions against a fake DRS/EC2/ELB
make lint                             # cdk-nag synth, ruff, shell syntax
```

### Rehearsals

```bash
make rehearse                      # one graceful round trip via the plan, API-verified per step
make rehearse MODE=ungraceful      # forced Aurora failover on the outbound leg
make rehearse-cycle LEGS=4         # N alternating legs; the resting-state invariant is asserted
                                   # after every fail-back (no recovery instances, no FAILBACK
                                   # servers, empty secondary TG, same primary instance protected)
STATEFUL_EC2=true make rehearse-cycle LEGS=2   # stateful: a disk marker written in the DR region
                                               # must be present on the original instance after fail-back
make tunnel                        # SSM port-forward to the app console: http://localhost:8080/ui
```

Measured on an 8 GB root volume: stateless legs ~10 min out / ~5 min back; stateful fail-back
~45 min (dominated by the reverse block copy, scales with disk size). After an ungraceful
failover the old primary spends 10–18 min in `pending-resync`, and ARC holds the switchover-back
step until it is `available`.

The console at `/ui` (serving region through the failover record, ARC execution steps, Aurora
writer, DRS and target health, fail-over/fail-back buttons) is reachable only through the bastion.

## Findings

Behaviours worth knowing before running DRS under Region Switch in your own account:

- **DRS launches the recovery instance with the `StartRecovery` caller's credentials.** The
  orchestration role needs the EC2 permission set from `AWSElasticDisasterRecoveryConsoleFullAccess`,
  `iam:PassRole` for the launch-template instance profile, and `drs:*`. A gap surfaces only as
  `LAUNCH_FAILED` after a ~5-minute conversion. The construct's role is that set.
- **DRS's auto-created launch template is unusable as-is** (no subnet, security group or instance
  profile). `drs-setup.sh` configures it explicitly.
- **A Route 53 record holds one `HealthCheckId`**, so only one plan can flip a given record. Use one
  plan with `ungraceful: failover` and choose the mode at execution.
- **activePassive plans must not declare a `deactivate` action and must have an activate workflow
  per region.** Only a live create catches either.
- **A fail-back leaves cross-linked DRS state.** The recovery instance becomes the *source* of a
  FAILBACK-direction server in the primary; `TerminateRecoveryInstances` refuses "during failback".
  The order is stop replication on the FAILBACK server → terminate the recovery instance → delete
  the FAILBACK server. The `retire` step and `cleanup.sh` both follow it.
- **DRS keeps account-level state your stacks don't own.** The replication configuration template
  survives a teardown and still names the deleted staging subnet; the next source server inherits it
  and stalls at `CREATE_SECURITY_GROUP`. DRS also creates two security groups per staging VPC outside
  CloudFormation. `drs-setup.sh` reconciles the template on every run; `cleanup.sh` sweeps the
  security groups.
- **Launch into the source instance requires BIOS boot** (hence `t2.small`), the
  `AWSDRS=AllowLaunchingIntoThisInstance` tag, and the target instance **stopped** before
  `StartRecovery` (undocumented). Because the instance id is then *not* new, every "which instance
  failed back / has re-protect started / is the rescan done" question must be asked of DRS itself
  (recovery-instance state, `rescannedStorageBytes`), never inferred from ids or tags.
- **Through an SSM port-forward, HTTP keep-alive pins you to one ALB IP**, so a console can keep
  showing the old region after DNS flipped. The app sends `Connection: close`.

## Cleanup

```bash
make clean PROFILE=<aws-profile>    # or ./cleanup.sh; unattended, ~30 min
```

Parallel by dependency wave: DRS unwind in both regions → app/ALB, secondary cluster, plan, step
stacks, observer → primary cluster, IAM → DRS-created security groups swept → networks → runtime SSM
residue. Idempotent: re-run after any failure; a `DELETE_FAILED` stack is re-issued once with its
failing resources printed.

## Security Suppressions

### cdk-nag (AwsSolutions)

| Rule | Reason |
|------|--------|
| AwsSolutions-IAM4 | `AWSLambdaBasicExecutionRole`, `AmazonSSMManagedInstanceCore` and the DRS agent managed policies are the documented service policies |
| AwsSolutions-IAM5 | `drs:*` and `ViaAWSService`-conditioned EC2 grants: DRS launches recovery instances with the caller's credentials and offers no resource-level scoping for most actions |
| AwsSolutions-EC23 | Internal ALBs; ingress is limited to the workload/observer CIDRs supplied via context |
| AwsSolutions-EC26 | Demo root volume; DRS replicates the block device as-is |
| AwsSolutions-EC28 | Detailed monitoring not needed for the demo |
| AwsSolutions-EC29 | DRS protects a single instance; an ASG is out of scope |
| AwsSolutions-ELB2 | ALB access logs omitted for the demo |
| AwsSolutions-RDS6 | Password auth via Secrets Manager for the demo app |
| AwsSolutions-RDS10 | Deletion protection disabled so `make clean` can tear down |
| AwsSolutions-RDS11 | Default PostgreSQL port |
| AwsSolutions-SMG4 | Demo credential; rotation out of scope |
| AwsSolutions-VPC7 | VPC flow logs omitted for the demo |
| AwsSolutions-L1 | Python 3.12 is the current stable runtime for the step functions |

## Known constraints

- Feasibility pattern, not production-hardened: single EC2, single writer, private hosted zone.
- DRS source servers are not CloudFormation resources; `drs-setup.sh` creates them, the DRS API
  removes them.
- The secondary target group is empty at rest; the failover record only resolves there once ARC
  flips the health check and the recovered instance is registered and healthy.
- All `make` targets are non-interactive (`AWS_PAGER` is empty; scripts pass `--no-cli-pager`).

## License

MIT-0 — see [LICENSE](../LICENSE). Third-party components: see
[THIRD-PARTY-LICENSES](THIRD-PARTY-LICENSES).
