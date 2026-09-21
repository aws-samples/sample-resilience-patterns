# eks-multi-region

A multi-region EKS application behind **Amazon Application Recovery Controller (ARC) Region
Switch**. It exists to show what a regional failover and a single-AZ gray failure (a zone
that is degraded but not down) look like from the client's side, and what an application has
to do to survive both. us-east-2 is the primary region and us-west-2 the standby; Aurora
Serverless v2 runs in both as an Aurora Global Database, and Argo CD manages the application
so you can watch ARC's EKS scaling block and GitOps operate on the same Deployment without
conflicting.

Everything is CDK (TypeScript, managed by projen). It deploys into a single AWS account with
`make deploy`, is operated through an SSM tunnel to an observer bastion (there is no public
ingress anywhere), and is removed with `make clean`.

## What it demonstrates

**Regional failover.** One ARC Region Switch plan (`activePassive`) runs three steps in a
fixed order: raise EKS capacity in the target region, move the Aurora Global Database
writer, then flip the Route 53 health checks so traffic follows. Failing back is the same
plan run toward the other region. `build/arc-switch.sh` wraps the operator commands and
performs a dry run unless told otherwise.

**Scaling back in is not ARC's job, and nothing else does it for you.** Region Switch's EKS
scaling block only scales *up*. It raises the target region's Deployment to `targetPercent`
of the source region's recent maximum and patches the Horizontal Pod Autoscaler (HPA) with
`scaleDown.selectPolicy: Disabled` so the autoscaler cannot undo the surge while traffic
moves. The developer guide is explicit that this holds "during or after the execution": the
patch persists, and no step in the plan reverses it after a failover or a failback. Argo CD
does not reverse it either, on purpose. The Application ignores the two fields ARC
writes (`/spec/replicas` on the Deployment and `/spec/behavior/scaleDown/selectPolicy` on
the HPA), which is what lets GitOps and ARC operate on the same Deployment without fighting.
Left alone, the result is a ratchet: two round trips in one day took this app to 10 pods with
scale-down off, and because the 24-hour sample inherits the inflated count, the next
execution asks for even more.

The reset therefore has to be customer-provided. Here it is `build/restore-steady-state.sh`,
run after every failover and every failback (dry run by default). Per region it patches the
HPA back to `selectPolicy: Min`, the exact reverse of ARC's patch (`minReplicas` is never
touched, because ARC never touched it), and restarts the pods so their connection pools are
fresh. The re-enabled HPA then sizes each region on its own, Karpenter reaps the empty surge
nodes within about 10-20 minutes, and the live state once again matches what Argo CD
declares, so normal autoscaling under GitOps is back in charge until the next execution. A
production derivative would attach this to a post-recovery step; ARC has a documented
`postRecovery` workflow, and `docs/runbook.md` §7b explains why this sample chose a script.

**Single-AZ gray failures.** A resilience cockpit (a small web UI) lets you pick a fault, arm
it (tag the nodes that may receive it), and watch per-AZ client availability against a 2 s
service-level objective alongside the live load generator and the CloudWatch dashboard. Each
fault is an AWS Fault Injection Service (FIS) experiment delivered over SSM to the armed
nodes. An experiment runs for a fixed 15 minutes unless you stop it from the cockpit; there is
no alarm that halts it for you, so the operator's decision is the only thing that ends a fault
early.

| Fault | What it does | Measured availability (single AZ, 2 s SLO) |
|---|---|---|
| `brownout` | `tc netem` delay on the app port | 66% |
| `packet-loss` | `tc netem` loss | 64% |
| `latency` | `tc netem` delay on the DB path | 23% |
| `power-interruption` | AZ network blackhole (`disrupt-connectivity`) | zonal only with a reader in every AZ |

Under a client SLO, added latency does more damage than either brownout or packet loss.
CPU and memory stress faults are built but not offered from the cockpit: the nodes sit in
isolated subnets with no NAT, so `stress-ng` cannot be installed there, and only `tc`, which
ships with AL2023, is usable.

**The client sits outside both regions.** The synthetic users (Locust on Fargate) run in the
observer VPC in us-east-1, next to the operator's bastion, and reach whichever region is
active over VPC peering. Their metrics, the availability alarm an operator would act on, and
the client-view dashboard therefore live in a region that neither the failover nor a fault
touches: a real loss of the primary region degrades the graph instead of taking it down.
Per-AZ and per-region attribution comes from the app's own response body, so nothing about
the measurements depends on where the client sits.

**The observer is one Availability Zone.** The observer VPC has a single subnet, so the
bastion, the load generator and, through its metrics, the client-view dashboard and all three
alarms depend on one us-east-1 zone. If that zone is lost the application keeps serving and
only the measuring stops, but the app-health alarms treat missing data as breaching, so for
as long as the client is down they read the same as a dead primary. The plan has no
automatic triggers, so that misreading starts nothing on its own. This is an acceptable
trade for a sample; a production derivative would run the client, and anything that acts on
its metrics, in more than one zone.

**A write pool that survives the failover.** `src/app/common.py` pools connections to the
Aurora Global writer endpoint. When the writer moves to the other region, every pooled
socket still points at the old host, which is now a reader. That is how a fleet that reports
healthy ends up with write availability at 0% while reads, which open a fresh connection per
request, stay at 100%. This pool is written to avoid that: a connection whose write raises an
error is closed and discarded instead of being returned to the pool, a connection that has
been idle for more than a few seconds is checked before it is handed out, and no connection
outlives a maximum lifetime. A writer failover therefore costs at most one failed write per
pooled connection and recovers within a handful of requests, with no restart and no operator
action. `test/fixtures/pool_probe.py` simulates the failover against a fake driver and the
test suite asserts the recovery.

## Architecture

![Architecture: in us-east-1 an observer VPC holds an SSM-only bastion and the Locust load generator; both reach the workload regions over VPC peering, the operator through the internal ALBs and the clients through the app's failover record. In us-east-2 (primary) and us-west-2 (standby) an EKS cluster runs orders-api behind an NLB and reads from a regional Aurora Serverless v2 cluster; all writes go to the Aurora Global Database writer endpoint. Route 53 failover records are bound to health checks owned by an ARC Region switch plan, which also scales the standby EKS cluster and switches the global database.](docs/architecture/architecture.png)

Green is request traffic, blue is data, red is control and recovery, purple is the operator's
network path, and dotted grey is AWS API access through interface endpoints. Telemetry is
not drawn: every region ships logs to CloudWatch, and the load generator's metrics land in
us-east-1, where the alarms over them live. Deploy-time services (ECR mirror, CodeBuild
installer, S3 assets, Secrets Manager, KMS) are omitted. The picture is generated from the
official AWS Architecture Icons by `docs/architecture/render.py`; re-run it after any
topology change.

The application (`src/app/`) is a small HTTP server built on the Python standard library.
It exposes `GET/POST/PUT/DELETE /orders` against one table and is kept generic on purpose,
since it exists to make the failure modes visible rather than to be a product. What matters
in it is the split between read and write endpoints: reads stay in their own region, and
writes follow the Aurora writer wherever it is.

There is **no public front door**. Each region's `access-<region>` stack fronts the Argo
CD UI (and, in us-west-2, the cockpit at `/cockpit`) with an internal ALB whose only
permitted ingress is the observer VPC's CIDR. You reach it with `build/tunnel.sh`, which
port-forwards through the bastion over SSM Session Manager, so IAM is the only identity in
the path.

CDK stacks (`src/cdk/lib/`):

| Stack | Region(s) | Purpose |
|---|---|---|
| `RegionStack` | both | VPC (isolated subnets, interface endpoints, no NAT), EKS + Karpenter, Aurora, IAM roles for service accounts, in-VPC installer, log shipping |
| `GlobalDataStack` / `SecondaryDbStack` | primary / standby | Aurora Global Database and its secondary member |
| `PeeringStack` | primary | VPC peering between the two workload regions |
| `FailoverStack` | primary | The ARC Region Switch plan, its Route 53 health checks, and the failover records bound to them |
| `DnsStack` | primary | The private hosted zone, associated with both workload VPCs and the observer VPC |
| `ObserverStack` | us-east-1 | Observer VPC, SSM-only bastion, peerings to both workload VPCs, the ECR/Logs/S3 endpoints the load generator needs |
| `OperatorAccessStack` | both | Internal ALB fronting Argo CD (+ cockpit in the standby), observer-CIDR ingress only |
| `LoadGenStack` | us-east-1 | Locust load generator in the observer VPC, emitting per-op / per-AZ / per-region metrics; the client-view dashboard and the alarms over those metrics |
| `StandbyAccessStack` | standby | Cross-region access the plan's execution role needs |

Kubernetes manifests (`k8s/`) are rendered by `build/render-manifest.py` (which refuses to
emit on any unresolved placeholder) and applied by an in-VPC CodeBuild installer, because
the cluster API endpoint is private. `k8s/namespaces.yaml` applies first; everything
namespaced names its namespace explicitly. Pod logs for every namespace ship to CloudWatch
Logs via a fluent-bit DaemonSet.

Third-party images (Argo CD with its dex and metrics-server components, and the Valkey image
that serves as Argo CD's cache; see `THIRD-PARTY-LICENSES`) are **mirrored into your own
ECR** by `make mirror` from the digest-pinned list in `src/mirror/images.json`. The mirror is
required rather than optional because the node subnets have no route to the internet, and it
is also what lets the cluster run with no NAT and no egress at all.

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
  first AWS call rather than landing in the wrong account. They are not the same kind of
  input: `AWS_REGION` is a **fixed value**, `ASSETS_BUCKET_PREFIX` is **your choice**.

  ```bash
  export AWS_REGION=us-east-2                  # fixed: the primary region of the shipped topology
  export ASSETS_BUCKET_PREFIX=<unique-prefix>  # yours: buckets are <prefix>-us-east-2/-us-west-2/-us-east-1
  ```

  The region set lives in code rather than configuration: `src/cdk/regions.ts` fixes
  us-east-2 as primary, us-west-2 as standby and us-east-1 as observer, and the Makefile and
  `cleanup.sh` mirror it (a test pins all three). `AWS_REGION` must equal that primary.
  `make deploy` puts each stack in its own hard-wired region regardless, but the post-deploy
  ARC verifiers and `build/arc-switch.sh` read `AWS_REGION` to find the Region switch plan,
  which lives in the primary. To run in other regions, change `src/cdk/regions.ts` (and the
  two mirrors),
  run `npx projen`, and rebuild.
  `ASSETS_BUCKET_PREFIX` can be anything valid in an S3 bucket name. Bucket names are global,
  so pick something unique to you (CI uses `eks-multi-region-<short sha>`). `make buckets`
  creates the three buckets from it.

For CI, `docs/iam/README.md` describes the two-role setup the GitHub Actions e2e uses (a
narrow OIDC role plus a CloudFormation execution role) and the exact commands to create it.

## Cost

This is not a free-tier sample. At rest (deployed, load generator running, no failover or
fault in progress) it costs about **$1,740 per month, roughly $57 a day**. The table is
built from the resources in the synthesized templates and the AWS list prices for US East
(Ohio) as published in the [AWS Price List](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html)
on 2026-09-18 (US West (Oregon) prices the same items identically; the bastion is priced at
US East (N. Virginia) rates). 730 hours per month. Check the linked pricing pages before you
rely on a number; prices change and your account may have different terms.

| Service | What this sample runs | List price | Monthly |
|---|---|---|---|
| [Amazon EKS](https://aws.amazon.com/eks/pricing/) | 2 clusters, Kubernetes 1.35 (standard support) | $0.10 per cluster-hour | $146 |
| [Amazon EC2](https://aws.amazon.com/ec2/pricing/on-demand/) (node groups) | 2 x `t4g.large` per region (4) | $0.0672 per hour | $196 |
| Amazon EC2 (Karpenter) | 1 x `m7g.large` per region at rest (the one-pod-per-node, one-AZ-per-pod spread needs a third node) | $0.0816 per hour | $119 |
| [Amazon EBS](https://aws.amazon.com/ebs/pricing/) | gp3 root volumes: 6 x 20 GiB nodes + 8 GiB bastion | $0.08 per GB-month | $10 |
| [Aurora Serverless v2](https://aws.amazon.com/rds/aurora/pricing/) | 6 instances (writer + 2 readers per region); floor 0.5 ACU each = 3 ACU ($263); the primary's three run above the floor while the load generator is on, so budget ~4.5 ACU | $0.12 per ACU-hour | ~$400 |
| Aurora storage, I/O, Global Database | storage, I/O requests, replicated write I/O, backups over DB size | $0.10 per GB-month; $0.20 per million I/Os; $0.20 per million replicated write I/Os | ~$5 |
| [AWS KMS](https://aws.amazon.com/kms/pricing/) | 3 customer managed keys (Aurora storage per region, plan reports bucket) | $1.00 per key-month | $3 |
| [Interface VPC endpoints](https://aws.amazon.com/privatelink/pricing/) | 13 endpoints x 3 AZs per workload region + 6 x 1 AZ in the observer (SSM for the bastion; ECR and Logs for the load generator) = 84 endpoint-AZs | $0.01 per endpoint-AZ-hour + $0.01 per GB processed | $613 |
| [Elastic Load Balancing](https://aws.amazon.com/elasticloadbalancing/pricing/) | 4 NLBs (orders-api + Argo CD per region, created by the Load Balancer Controller) and 2 internal ALBs | $0.0225 per hour each; $0.006 per NLCU-hour; $0.008 per LCU-hour | ~$105 |
| [AWS Fargate](https://aws.amazon.com/fargate/pricing/) | 1 Locust task in us-east-1, 0.5 vCPU / 1 GB, arm64 | $0.03238 per vCPU-hour + $0.00356 per GB-hour | $14 |
| Amazon EC2 (bastion) | 1 x `t4g.nano` in us-east-1 | $0.0042 per hour | $3 |
| [Application Recovery Controller](https://aws.amazon.com/application-recovery-controller/pricing/) | 1 Region switch plan (zonal shift has no charge) | $70 per plan-month | $70 |
| [Amazon Route 53](https://aws.amazon.com/route53/pricing/) | 1 private hosted zone; queries to private zones are free; the plan's health checks are service-owned | $0.50 per hosted zone-month | $1 |
| [Amazon CloudWatch](https://aws.amazon.com/cloudwatch/pricing/) | pod logs from every namespace, 5 control-plane log types x 2 clusters, Lambda/Fargate/FIS logs; Locust EMF metrics per op, AZ and region (in us-east-1); 3 alarms; 3 dashboards (the first 3 are free) | $0.50 per GB ingested + $0.03 per GB-month; $0.30 per metric-month; $0.10 per alarm-month | ~$50 (usage) |
| [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/) | 1 database credential | $0.40 per secret-month | $0.40 |
| Amazon ECR, Amazon S3 | mirrored third-party images (~2 GB per region), the Locust image in us-east-1, assets buckets | $0.10 / $0.023 per GB-month | <$1 |
| AWS Lambda, AWS CodeBuild, Systems Manager | 6 functions invoked rarely; installers run only during a deploy; Session Manager has no charge | within free tier or per-deploy only | ~$0 |
| [Data transfer](https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer) | Aurora Global Database replication and standby writes over peering (us-east-2 -> us-west-2); the load generator's requests over peering (us-east-1 -> the active region, a few GB a month at 10 users); cross-AZ traffic | $0.02 per GB inter-region; $0.01 per GB each way cross-AZ | ~$5 |
| **Total at rest** | | | **~$1,740** |

What moves the number: every ACU an Aurora instance runs above the 0.5-ACU floor is $87.60
a month; every extra `m7g.large` Karpenter launches during an ARC scale-up is $59.57 a month
(a scale-up lasts hours rather than months, and `restore-steady-state.sh` brings the count
back down); an [AWS FIS](https://aws.amazon.com/fis/pricing/) experiment bills $0.10 per
action-minute only while it runs (a 15-minute single-action fault is $1.50); and a cluster
left on a Kubernetes version past standard support is billed at $0.60 per hour instead of
$0.10. Interface endpoints, now about a third of the bill and the largest single line, are
the price of running with no NAT and no internet route.

Deploy it into a sandbox account, keep it up only as long as the walkthrough needs, and
tear it down with `make clean` (which is `cleanup.sh`, in reverse dependency order across
all three regions). Verify that the teardown finished: a `DELETE_FAILED` region stack keeps
its VPC, nodes and load balancers billing until it is cleared, and `cleanup.sh` drains those
on its own on the next run.

## Security posture

It is written to be deployed by someone who may take it to production, so the defaults are
the secure ones:

- **No public ingress anywhere.** The EKS API endpoint is private-only; the application
  and Argo CD sit behind internal load balancers reachable only through an SSM
  Session Manager port-forward to a bastion with no public IP and no inbound rules. IAM is
  the only identity in the path. Nodes live in isolated subnets with no NAT and reach AWS
  services through interface endpoints.
- **Cluster hardening.** All five control-plane log types ship to CloudWatch Logs;
  Kubernetes API data is envelope-encrypted by EKS's default KMS key (bring a customer
  managed key via `encryptionConfig` if your policy requires one; adding a provider after
  creation replaces the cluster); access is through EKS access entries with no standing
  cluster-admin grant for the deploying identity; IMDSv2 is required on every node. Every
  workload runs as non-root (fluent-bit excepted, below) on the runtime-default seccomp
  profile with all capabilities dropped, no privilege escalation and a read-only root
  filesystem; pods that never call the Kubernetes API mount no service-account token. The
  `demo` namespace enforces the `baseline` Pod Security Standard and audits/warns on
  `restricted`.
- **Least privilege.** Every IAM statement in the stacks is resource-scoped except where
  the action has no resource type (those are read-only or condition-bound). `iam:PassRole`
  is always a named role plus `iam:PassedToService`. The two roles with write authority
  over the failover, ARC's execution role and the cockpit's Lambda role, carry permissions
  boundaries that deny the IAM privilege-escalation actions outright;
  `docs/cockpit-threat-model.md` describes the one `iam:PassRole` path the cockpit keeps and
  how it is fenced. The CI roles in `docs/iam/` are split into a narrow OIDC runner role and
  a CloudFormation execution role whose IAM authority is bounded to the sample's own name
  prefix.
- **Secrets.** Database credentials are generated by Secrets Manager, never appear in
  code, templates, manifests or logs, and reach the pods at runtime through the node role;
  no Kubernetes Secret carries an application secret. All third-party images are
  digest-pinned and pulled from your own ECR mirror.

Deviations we chose to keep, each documented where it is made; close them before a
production derivative:

- **The application connects with the Aurora master credential.** A dedicated application
  role with privileges on the schema alone would be the correct replacement, and the schema
  job is where it would be created. Tracked in `docs/lessons.md`.
- **IMDSv2 hop limit is 2 rather than 1** on both node types, because the pods obtain AWS
  credentials from the node role via IMDS; the app uses neither IRSA nor Pod Identity, a
  dependency choice explained in `region-stack.ts`. Moving the app to EKS Pod Identity would
  allow a hop limit of 1.
- **Operator access is plain HTTP inside the VPC.** The bastion-to-ALB and ALB-to-Argo
  hops are unencrypted; the SSM tunnel protects the operator's hop. Supplying an ACM
  certificate to the access stacks would close this.
- **fluent-bit runs as root with read-only `hostPath` mounts** in a `logging` namespace
  labelled `privileged`. It is the one Pod Security Standards exception, and it is required
  to read `/var/log/containers`.
- **No Kubernetes NetworkPolicy** is applied; pod-to-pod traffic is unrestricted inside the
  cluster.

## Running it

```bash
make deps        # corepack + yarn install
make build       # compile, synth, cfn-lint, ~370 tests, asset staging
make buckets     # once per account: the two assets buckets
make mirror      # once per account: pinned third-party images -> your ECR (both regions)
make deploy      # 12 stacks across 3 regions, in dependency order, ~90 minutes
make verify      # every stack in a *_COMPLETE state
```

**Deploy the day before you need to demonstrate a failover.** ARC's EKS scaling block
sizes the standby from a 24-hour max-replica sample and scales nothing for the first day;
`docs/runbook.md` §1 explains what that means for a same-day demonstration.

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

Faults are armed and fired from the cockpit. Do not lower the app's timeouts to make a fault
look worse. The calibrated values in `docs/runbook.md` §4 sit below the 99% decision alarm
and well above a collapse to 0%, where the chart stops saying anything; both limits matter.

## Repository layout

```
.projenrc.ts          source of truth for package.json and the deploy tasks, the ordered steps behind make deploy (CI lives in the monorepo root)
Makefile              operator/CI entry points; thin front on the projen tasks
cleanup.sh            full teardown, reverse dependency order, three regions
src/cdk/              stacks and constructs (cockpit, failure-injection, load-generation, networking, observability)
src/app/              the orders-api service and its schema
src/locust/           load generator + EMF metric emitters
src/mirror/images.json  digest-pinned third-party images (arm64 child digests) for make mirror
k8s/                  rendered manifests: app, Argo CD, Karpenter NodePool, fluent-bit, schema job
build/                scripts behind the deploy steps, plus tunnel.sh, arc-switch.sh, restore-steady-state.sh, verifiers
test/                 ~370 Jest tests, many pinning cross-file contracts that synth cannot catch
docs/runbook.md       operator runbook: deploy, pre-demo checklist, faults, failover, recovery, teardown,
                      and "failures that look like something else"
docs/az-segment-script.md   presenter script for the single-AZ segment
docs/cockpit-threat-model.md
docs/iam/             the CI roles: trust + permission policies and how to create them
```

## Before you change anything

Many tests pin contracts that span files and that synth alone cannot check: manifests
applied in a required order, image digests that must be the arm64 child rather than the
multi-platform index, a Pod Security Standard that rejects every pod of a DaemonSet with no
error at apply time, Route 53 changes that are legal only as one atomic batch, ARC health
checks that are created but must be attached, deploy-step parameters that must match template
parameters in both directions, and a teardown script that must list the same stacks
`make deploy` creates. Several were confirmed to fail before their fix landed, and they should
stay that strict.

Two operational facts come up repeatedly. ARC's 24-hour replica sample cannot be reset;
`targetPercent` and the step timeout are the only levers, and `targetPercent` compounds
across a round trip. And `restore-steady-state.sh` is required after every failover and every
failback, for the reasons under "Scaling back in" above.

## License

This library is licensed under the MIT-0 License. See the LICENSE file. The application
is adapted from the `aurora` pattern in this repository.
