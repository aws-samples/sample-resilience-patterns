# eks-mr-demo

A multi-region EKS application behind **ARC Region Switch**, built to show what
regional failover and single-AZ gray failures look like from the client's side.
us-east-2 (Ohio) is primary, us-west-2 (Oregon) is standby, Aurora Serverless v2 runs in
both, and Argo CD manages the app so you can show ARC's EKS scaling block and GitOps
coexisting instead of fighting.

Everything is CDK (TypeScript, projen-managed), deploys from GitLab CI into a single AWS
account, and returns to steady state with one script.

## What it demonstrates

**Regional failover.** One ARC Region Switch plan, `activePassive`, three steps in a fixed
order: raise EKS capacity in the target region, move the Aurora Global Database writer,
flip Route 53 health checks so traffic follows. Fail-back is the same plan run toward the
other region. `build/arc-switch.sh` is the operator wrapper; it dry-runs by default.

**Single-AZ gray failures.** A resilience cockpit UI lets you pick a fault, arm it, and
watch per-AZ client availability against a 2 s SLO next to the live load generator and the
CloudWatch dashboard. Faults are AWS FIS experiments delivered over SSM to armed nodes:

| Fault | What it does | Measured availability (single AZ, 2 s SLO) |
|---|---|---|
| `brownout` | `tc netem` delay on the app port | 66% |
| `packet-loss` | `tc netem` loss | 64% |
| `latency` | `tc netem` delay on the DB path | 23% |
| `power-interruption` | AZ network blackhole (`disrupt-connectivity`) | zonal only with a reader in every AZ |
| `memory-stress` | built but not on the cockpit menu; nodes have no NAT to install `stress-ng` | -- |

Latency is the most severe of the three network faults under a client SLO, which is the
opposite of most people's intuition. Numbers are from the 2026-09-04 calibration runs.

**A write pool that survives the failover.** `src/app/common.py` pools writer connections
to the Aurora Global writer endpoint. When the writer moves regions, every pooled socket
is suddenly pointing at a host that is now a reader -- the classic way a "healthy" fleet
ends up with writes at 0% while reads (a fresh connection per request) stay at 100%. The
pool here is built not to do that: a connection whose write raises is closed and dropped
rather than returned; a connection idle for more than a few seconds is pinged before it is
handed out; nothing lives past a max lifetime. A writer failover therefore costs at most
one failed write per pooled connection and heals itself within a handful of requests --
no restart, no operator. `test/fixtures/pool_probe.py` simulates the failover against a
fake driver and the test suite asserts the recovery, so the behaviour cannot regress
silently.

## Architecture

```
                 CloudFront (one distribution per region, VPC private origin)
                                    |
             Route 53 failover records bound to ARC-owned health checks
                     /                                  \
        us-east-2 ALB  ->  EKS (orders-api)      us-west-2 ALB  ->  EKS (orders-api)
             |     reads -> regional reader          |     reads -> regional reader
             |     writes -> Aurora GLOBAL writer endpoint (follows the primary)
        Aurora Serverless v2 (writer + 2 readers)   Aurora Serverless v2 (secondary)
                         \________ Aurora Global Database ________/
```

The application (`src/app/`) is a small stdlib HTTP server exposing `GET/POST/PUT/DELETE
/orders` against one table. It is deliberately generic -- an instrument for the failure
stories, not a product. The read/write endpoint split is the whole point: reads stay
in-region, writes are the thing that moves.

CDK stacks (`src/cdk/lib/`):

| Stack | Region(s) | Purpose |
|---|---|---|
| `RegionStack` | both | VPC (isolated subnets, interface endpoints, no NAT), EKS + Karpenter, ALB, Aurora, IRSA roles, log shipping |
| `GlobalDataStack` / `SecondaryDbStack` | primary / standby | Aurora Global Database and the secondary member |
| `PeeringStack` | primary | VPC peering between regions |
| `FailoverStack` | primary | The ARC Region Switch plan and its Route 53 health checks |
| `DnsStack` | primary | Failover records bound to the plan's `PlanHealthChecks` |
| `FrontDoorStack` | both | CloudFront distribution with VPC origin, CloudFront Signer gating |
| `LoadGenStack` | both | Locust load generator emitting per-op / per-AZ / per-region metrics |
| `StandbyAccessStack` | standby | Cross-region access the plan's execution role needs |

Kubernetes manifests (`k8s/`) are rendered by `build/render-manifest.py` (which refuses to
emit on any unresolved placeholder) and applied by an in-VPC CodeBuild installer, because
the cluster API endpoint is private. `k8s/namespaces.yaml` applies first; everything
namespaced names its namespace explicitly. Pod logs for every namespace ship to
CloudWatch Logs (`/eks/<project>/pods`) via a fluent-bit DaemonSet in the privileged
`logging` namespace.

## Repository layout

```
.projenrc.ts          source of truth for package.json, tasks, and the GitLab pipeline
src/cdk/              stacks and constructs (auth, cockpit, failure-injection, load-generation,
                      networking, observability)
src/app/              the orders-api service and its schema
src/locust/           load generator + EMF metric emitters
src/mirror/images.json  digest-pinned third-party images mirrored into ECR (arm64 child digests)
k8s/                  rendered manifests: app, Argo CD, Karpenter NodePool, fluent-bit, schema job
build/                deploy rail scripts, arc-switch.sh, restore-steady-state.sh, verifiers
test/                 ~300 Jest tests, many pinning cross-file contracts synth cannot catch
docs/runbook.md       operator runbook: prerequisites, deploy, pre-demo checklist, faults,
                      failover, recovery, teardown, and "failures that look like something else"
docs/az-segment-script.md   presenter script for the single-AZ segment
docs/cockpit-threat-model.md
AGENTS.md             conventions and the catalogue of bug classes this demo has hit
```

## Running it

Prerequisites (one-time, account-level -- full table in `docs/runbook.md` §0): a GitLab
project, a `GitLabRunner` role with ECR mirror permissions in both regions, two assets
buckets, and CloudFront Signer onboarding for the front doors.

```bash
yarn install                 # yarn berry -- never npm install
npx projen build             # compile, synth, cfn-lint, tests, container build
npx projen deploy            # the full rail, or let GitLab CI run it on merge to main
```

Deploy the day before a customer-facing run: ARC's EKS scaling block sizes the standby
from a 24-hour replica sample and scales nothing for the first day.

Operate:

```bash
build/arc-switch.sh                      # dry-run; shows the derived start-plan-execution
build/arc-switch.sh --execute us-west-2  # fail over (or fail back with the other region)
build/restore-steady-state.sh --execute  # after any round trip: re-enable HPA scale-down
                                         # (ARC disables it and nothing else turns it back on)
```

Faults are armed and fired from the cockpit UI behind the CloudFront front door. Never
lower the app's timeouts to make a fault look worse -- the calibrated values in
`docs/runbook.md` §4 are two-sided (above the 50% FIS guardrail, below the decision
alarm).

## Things worth knowing before you change anything

Read `AGENTS.md`. It records twenty-six classes of bug this demo has actually shipped,
each of which looked like something else: manifests applied in the wrong order, multi-
platform image digests that do not exist in ECR, a Pod Security Standard silently
rejecting every pod of a DaemonSet, Route 53 changes that are only legal as one atomic
batch, ARC health checks that are created but never attached, `--query` expressions that
aggregate per page. Several have tests that fail without their fix; keep them that way.

Two operational facts that bite repeatedly: ARC's 24-hour replica sample cannot be reset
(only `targetPercent` and the step timeout are yours to tune), and `restore-steady-state.sh`
is not optional after a failover -- ARC disables HPA scale-down and nothing turns it back
on.

## License

Apache-2.0. The application is ported from
[aws-samples/sample-resilience-patterns](https://github.com/aws-samples/sample-resilience-patterns)
(MIT-0).
