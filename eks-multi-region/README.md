# eks-multi-region

A multi-region EKS application behind **ARC Region Switch**, built to show what regional
failover and single-AZ gray failures look like from the client's side -- and what an
application that survives them looks like. us-east-2 is primary, us-west-2 is standby,
Aurora Serverless v2 runs in both as an Aurora Global Database, and Argo CD manages the app
so you can watch ARC's EKS scaling block and GitOps coexist instead of fighting.

Everything is CDK (TypeScript, projen-managed). It deploys into a single AWS account with
`make deploy`, is operated through an SSM-tunnelled observer bastion (no public ingress
anywhere), and tears down with `make clean`.

## What it demonstrates

**Regional failover.** One ARC Region Switch plan, `activePassive`, three steps in a fixed
order: raise EKS capacity in the target region, move the Aurora Global Database writer,
flip Route 53 health checks so traffic follows. Fail-back is the same plan run toward the
other region. `build/arc-switch.sh` is the operator wrapper; it dry-runs by default.

**Single-AZ gray failures.** A resilience cockpit lets you pick a fault, arm it, and watch
per-AZ client availability against a 2 s SLO next to the live load generator and the
CloudWatch dashboard. Faults are AWS FIS experiments delivered over SSM to armed nodes:

| Fault | What it does | Measured availability (single AZ, 2 s SLO) |
|---|---|---|
| `brownout` | `tc netem` delay on the app port | 66% |
| `packet-loss` | `tc netem` loss | 64% |
| `latency` | `tc netem` delay on the DB path | 23% |
| `power-interruption` | AZ network blackhole (`disrupt-connectivity`) | zonal only with a reader in every AZ |

Latency is the most severe of the three network faults under a client SLO, which is the
opposite of most people's intuition. (CPU/memory stress faults are built but not offered:
the nodes sit in isolated subnets with no NAT, so `stress-ng` cannot be installed; only
`tc`, which ships with AL2023, works there.)

**A write pool that survives the failover.** `src/app/common.py` pools writer connections
to the Aurora Global writer endpoint. When the writer moves regions, every pooled socket is
suddenly pointing at a host that is now a reader -- the classic way a "healthy" fleet ends
up with writes at 0% while reads (a fresh connection per request) stay at 100%. The pool
here is built not to do that: a connection whose write raises is closed and dropped rather
than returned; a connection idle for more than a few seconds is pinged before it is handed
out; nothing lives past a max lifetime. A writer failover costs at most one failed write
per pooled connection and heals within a handful of requests -- no restart, no operator.
`test/fixtures/pool_probe.py` simulates the failover against a fake driver and the test
suite asserts the recovery.

## Architecture

```
   operator laptop --SSM port-forward--> observer bastion (us-east-1, no public IP, no inbound)
                                              |  VPC peering to both regions
                 Route 53 failover records bound to ARC-owned health checks
                     /                                          \
   us-east-2 internal ALB -> EKS (orders-api)      us-west-2 internal ALB -> EKS (orders-api)
        |  reads  -> regional reader                    |  reads  -> regional reader
        |  writes -> Aurora GLOBAL writer endpoint (follows the primary)
   Aurora Serverless v2 (writer + readers)          Aurora Serverless v2 (secondary)
                     \__________ Aurora Global Database __________/
```

The application (`src/app/`) is a small stdlib HTTP server exposing `GET/POST/PUT/DELETE
/orders` against one table. It is deliberately generic -- an instrument for the failure
stories, not a product. The read/write endpoint split is the point: reads stay in-region,
writes are the thing that moves.

There is **no public front door**. Each region's `access-<region>` stack fronts the Argo
CD UI (and, in us-west-2, the cockpit at `/cockpit`) with an internal ALB whose only
ingress is the observer VPC's CIDR. You reach it with `build/tunnel.sh`, which port-forwards
through the bastion over SSM Session Manager -- IAM is the only identity in the path.

CDK stacks (`src/cdk/lib/`):

| Stack | Region(s) | Purpose |
|---|---|---|
| `RegionStack` | both | VPC (isolated subnets, interface endpoints, no NAT), EKS + Karpenter, Aurora, IRSA roles, in-VPC installer, log shipping |
| `GlobalDataStack` / `SecondaryDbStack` | primary / standby | Aurora Global Database and its secondary member |
| `PeeringStack` | primary | VPC peering between the two workload regions |
| `FailoverStack` | primary | The ARC Region Switch plan and its Route 53 health checks |
| `DnsStack` | primary | Failover records bound to the plan's `PlanHealthChecks` |
| `ObserverStack` | us-east-1 | Observer VPC, SSM-only bastion, peerings to both workload VPCs |
| `OperatorAccessStack` | both | Internal ALB fronting Argo CD (+ cockpit in the standby), observer-CIDR ingress only |
| `LoadGenStack` | primary | Locust load generator emitting per-op / per-AZ / per-region metrics |
| `StandbyAccessStack` | standby | Cross-region access the plan's execution role needs |

Kubernetes manifests (`k8s/`) are rendered by `build/render-manifest.py` (which refuses to
emit on any unresolved placeholder) and applied by an in-VPC CodeBuild installer, because
the cluster API endpoint is private. `k8s/namespaces.yaml` applies first; everything
namespaced names its namespace explicitly. Pod logs for every namespace ship to CloudWatch
Logs via a fluent-bit DaemonSet.

Third-party images (Argo CD, its cache -- served by Valkey, see `THIRD-PARTY-LICENSES` -- and dex, metrics-server) are **mirrored into your
own ECR** by `make mirror` from the digest-pinned list in `src/mirror/images.json`. The
node subnets have no route to the internet, so this is not optional -- and it is the reason
the cluster can run with no NAT and no egress at all.

## Prerequisites

- An AWS account you can create IAM roles, VPCs, EKS clusters and Aurora clusters in. Use
  a dedicated sandbox account with no customer data.
- Node 20 with corepack (yarn berry is pinned by `packageManager`), Python 3.11+, the AWS
  CLI v2, and the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
  for `tunnel.sh`. `crane` for `make mirror`. `cfn-lint` for the template gate (the build
  warns and skips if it is absent; set `CFN_LINT_REQUIRED=1` to make that fatal, as CI does).
- Service quotas: enough On-Demand Standard vCPU in both regions for ARC to scale the
  standby (`targetPercent` 150 of the primary's 24-hour max replica count).
- Two environment variables, with **no defaults** so a deploy that forgot them fails at the
  first AWS call rather than landing in the wrong account:

  ```bash
  export AWS_REGION=us-east-2               # primary
  export ASSETS_BUCKET_PREFIX=eks-multi-region   # buckets: $ASSETS_BUCKET_PREFIX-<region>
  ```

For CI, `docs/iam/README.md` describes the two-role setup the GitHub Actions e2e uses (a
narrow OIDC role plus a CloudFormation execution role) and the exact commands to create it.

## Cost

This is not a free-tier sample. A full deployment runs, continuously, in **two regions plus
an observer region**: two EKS clusters (control plane charged per hour, plus Graviton nodes
managed by a node group and Karpenter), two Aurora Serverless v2 clusters with three
instances each (a writer and two readers, held at a minimum capacity), a Fargate load
generator that issues traffic around the clock, interface VPC endpoints in every isolated
subnet, per-region NLBs and ALBs created by the Load Balancer Controller and the access
stacks, an SSM-only bastion instance, and CloudWatch logs and metrics for all of it. Expect
a **three-figure USD bill per day** while it is up; the exact number depends on your
region pricing and on how long the load generator and any ARC scale-up run.

Deploy it into a sandbox account, keep it up only as long as the walkthrough needs, and
tear it down with `make clean` (which is `cleanup.sh`, in reverse dependency order across
all three regions). Verify the teardown finished -- a `DELETE_FAILED` region stack keeps
its VPC, nodes and load balancers billing until it is cleared; `cleanup.sh` drains those
on its own on the next run.

## Security posture

Written to be deployed by someone who may take it to production, so the defaults are the
secure ones:

- **No public ingress anywhere.** The EKS API endpoint is private-only; the application
  and Argo CD sit behind internal load balancers reachable only through an SSM
  Session Manager port-forward to a bastion with no public IP and no inbound rules. IAM is
  the only identity in the path. Nodes live in isolated subnets with no NAT and reach AWS
  services through interface endpoints.
- **Cluster hardening.** All five control-plane log types ship to CloudWatch Logs;
  Kubernetes API data is envelope-encrypted by EKS's default KMS key (bring a customer
  managed key via `encryptionConfig` if your policy requires one -- note that adding a
  provider after creation replaces the cluster); access is through EKS access entries with
  no standing cluster-admin grant for the deploying identity; IMDSv2 is required on every
  node. Every workload runs as non-root (fluent-bit excepted, below) on the runtime-default
  seccomp profile with all capabilities dropped, no privilege escalation and a read-only
  root filesystem; pods that never call the Kubernetes API mount no service-account token.
  The `demo` namespace enforces the `baseline` Pod Security Standard and audits/warns on
  `restricted`.
- **Least privilege.** Every IAM statement in the stacks is resource-scoped except where
  the action has no resource type (those are read-only or condition-bound). `iam:PassRole`
  is always a named role plus `iam:PassedToService`. The two roles with write authority
  over the failover -- ARC's execution role and the cockpit's Lambda role -- carry
  permissions boundaries that deny the IAM privilege-escalation set outright;
  `docs/cockpit-threat-model.md` enumerates the one PassRole edge the cockpit keeps. The CI
  roles in `docs/iam/` are split into a narrow OIDC runner role and a CloudFormation
  execution role whose IAM authority is bounded to the sample's own name prefix.
- **Secrets.** Database credentials are generated by Secrets Manager, never appear in
  code, templates, manifests or logs, and reach the pods at runtime through the node role;
  no Kubernetes Secret carries an application secret. All third-party images are
  digest-pinned and pulled from your own ECR mirror.

Deliberate deviations, each documented where it is made and worth closing before a
production derivative:

- **The application connects with the Aurora master credential.** A dedicated application
  role with schema-only privileges is the right shape; the schema job is where it would be
  created. Tracked in `docs/lessons.md`.
- **IMDSv2 hop limit is 2, not 1**, on both node types, because the pods obtain AWS
  credentials from the node role via IMDS (there is no IRSA / Pod Identity for the app --
  a deliberate dependency choice explained in `region-stack.ts`). Moving the app to EKS Pod
  Identity is what would allow hop limit 1.
- **Operator access is plain HTTP inside the VPC.** The bastion-to-ALB and ALB-to-Argo
  hops are unencrypted; the SSM tunnel protects the operator's hop. Supplying an ACM
  certificate to the access stacks is the fix.
- **fluent-bit runs as root with read-only `hostPath` mounts** in a `privileged`-labelled
  `logging` namespace -- the one PSS exception, required to read `/var/log/containers`.
- **No Kubernetes NetworkPolicy** is applied; pod-to-pod traffic is unrestricted inside the
  cluster.

## Running it

```bash
make deps        # corepack + yarn install
make build       # compile, synth, cfn-lint, ~370 tests, asset staging
make buckets     # once per account: the two assets buckets
make mirror      # once per account: pinned third-party images -> your ECR (both regions)
make deploy      # the rail: 12 stacks across 3 regions, ~90 minutes
make verify      # every stack in a *_COMPLETE state
```

**Deploy the day before you need to demonstrate a failover.** ARC's EKS scaling block
sizes the standby from a 24-hour max-replica sample and scales nothing for the first day;
`docs/runbook.md` §1 explains why that is worse than it sounds.

Operate:

```bash
build/tunnel.sh <aws-profile>                 # http://localhost:8080/        us-east-2 Argo CD UI
build/tunnel.sh <aws-profile> 8081 us-west-2  # http://localhost:8081/cockpit standby: cockpit + Argo
build/arc-switch.sh                           # dry-run; shows the derived start-plan-execution
build/arc-switch.sh --execute us-west-2       # fail over (fail back with the other region)
build/restore-steady-state.sh --execute       # after any round trip: re-enable HPA scale-down
                                              # (ARC disables it and nothing else turns it back on)
make clean                                    # tear everything down
```

Faults are armed and fired from the cockpit. Never lower the app's timeouts to make a fault
look worse -- the calibrated values in `docs/runbook.md` §4 are two-sided (above the 50% FIS
guardrail, below the decision alarm).

## Repository layout

```
.projenrc.ts          source of truth for package.json and the deploy-rail tasks (CI lives in the monorepo root)
Makefile              operator/CI entry points; thin front on the projen tasks
cleanup.sh            full teardown, reverse dependency order, three regions
src/cdk/              stacks and constructs (cockpit, failure-injection, load-generation, networking, observability)
src/app/              the orders-api service and its schema
src/locust/           load generator + EMF metric emitters
src/mirror/images.json  digest-pinned third-party images (arm64 child digests) for make mirror
k8s/                  rendered manifests: app, Argo CD, Karpenter NodePool, fluent-bit, schema job
build/                deploy rail scripts, tunnel.sh, arc-switch.sh, restore-steady-state.sh, verifiers
test/                 ~370 Jest tests, many pinning cross-file contracts that synth cannot catch
docs/runbook.md       operator runbook: deploy, pre-demo checklist, faults, failover, recovery, teardown,
                      and "failures that look like something else"
docs/az-segment-script.md   presenter script for the single-AZ segment
docs/cockpit-threat-model.md
docs/iam/             the CI roles: trust + permission policies and how to create them
```

## Things worth knowing before you change anything

The test suite is unusually opinionated on purpose: many tests pin contracts that span
files and that synth alone cannot check -- manifests applied in a required order,
image digests that must be the arm64 child rather than the multi-platform index, a Pod
Security Standard that silently rejects every pod of a DaemonSet, Route 53 changes that
are legal only as one atomic batch, ARC health checks that are created but must be
attached, deploy-step parameters that must match template parameters in both directions,
the teardown script that must list exactly the stacks the rail deploys. Several of them
were proven to fail before their fix landed. Keep them that way.

Two operational facts that bite repeatedly: ARC's 24-hour replica sample cannot be reset
(`targetPercent` and the step timeout are the only levers, and `targetPercent` compounds
across a round trip), and `restore-steady-state.sh` is not optional after a failover --
ARC disables HPA scale-down and nothing turns it back on.

## License

This library is licensed under the MIT-0 License. See the LICENSE file. The application
is adapted from the `aurora` pattern in this repository.
