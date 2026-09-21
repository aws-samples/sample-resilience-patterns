# Operator runbook: multi-region EKS with ARC Region Switch

How to run the two demonstrations in this sample, and what to expect while you do.

1. **Regional failover and failback** with Amazon Application Recovery Controller (ARC)
   Region switch: §5 to §7b.
2. **Single-AZ gray failures** with AWS Fault Injection Service (FIS), answered with an ARC
   zonal shift: §4 and §4b.

Prerequisites, the deploy commands and the cost table are in the README. This runbook starts
after `make deploy` and `make verify` are green. The two ARC scripts (`build/arc-switch.sh`,
`build/restore-steady-state.sh`) print what they would do and exit unless you pass
`--execute`.

---

## 1. Deploy timing

### DEPLOY THE DAY BEFORE YOU NEED A FAILOVER

ARC's EKS scaling step sizes the standby from the **maximum replica count sampled over the
previous 24 hours** (`sampledMaxInLast24Hours`, the only sampling mode the step offers). On
a same-day deploy that sample can be empty, the computed target collapses toward zero, and
because the step only scales when the destination is *below* target, **it scales nothing
and reports success**. Traffic then lands on a standby at its original size, and the Argo CD
coexistence check in §6 has nothing to show.

Deploy the day before, run the practice failover in §3, and check the plan's **Evaluation**
tab on the day (it re-runs every 30 minutes): no monitoring-data warning means the sample is
populated.

---

## 2. Before every demo

### Reach the UIs

There is no public front door. Each region's Argo CD UI sits behind an internal ALB that
admits only the observer VPC, and the cockpit (the fault and failover control page) is served
by the **standby** region's ALB at `/cockpit`. Reach both from your laptop through the
observer bastion over SSM Session Manager:

```
build/tunnel.sh <aws-profile>                 # http://localhost:8080/         us-east-2 Argo CD UI
build/tunnel.sh <aws-profile> 8081 us-west-2  # http://localhost:8081/         us-west-2 Argo CD UI
                                              # http://localhost:8081/cockpit  the cockpit
```

Argo CD's initial admin password (run through the installer CodeBuild project if you have
no other `kubectl` path):

```
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
```

The EKS API endpoint is private. `AllowedCidr` on each region stack gates its security group
and resets to deny-all (`0.0.0.0/32`) on every deploy; in-VPC traffic does not need it.
Leave it closed. If you open it to your address for diagnosis, close it afterwards.

### Pre-demo checklist

| Check | Why |
|---|---|
| ARC plan **Evaluation** tab: no monitoring-data warning, access-entry policy validated | The gate on §1's 24-hour sample. The policy must be `AmazonARCRegionSwitchScalingPolicy`; the wrong one fails evaluation while IAM, synth and deploy all look fine. |
| `kubectl get ec2nodeclass default -o wide` is **Ready** (including `InstanceProfileReady`), `kubectl get nodepool default` is Ready | Otherwise Karpenter provisions nothing and the scale-up in §5 stalls. |
| 3 app pods, one per AZ, on different nodes | Anti-affinity and the zone-scoped topology spread are `required`; pods sharing a node mean the constraints are not matching and Karpenter is never asked for capacity. |
| On-Demand Standard vCPU quota headroom in **both** regions | Plan evaluation checks running capacity, **not quota headroom**. The failover scales the standby to 150% of the primary's 24-hour maximum. |
| The load generator is emitting `ClientSuccess` | Every chart and alarm in the demo is fed by the load generator. No data means nothing is driving traffic. |
| Error-rate knob at `0` in both regions, no FIS experiment running, no `ChaosAllowed` tags left from the last run | Start from a clean baseline. |

### Expected steady state

- Availability ~100% in the primary, client p90 around 120 ms (the client sits in
  us-east-1, so every request pays one cross-region hop), three AZ lines at 100%.
- **The standby's app-health alarm sits in ALARM, by design.** Missing data is treated as
  breaching and no traffic reaches the standby until the DNS flip. Its transition to OK
  after failover *is* the measured recovery. Say so before someone points at it.
- The decision alarm (`<project>-us-east-1-ClientAvailability`) is OK. It lives in
  **us-east-1**, with the two app-health alarms and the client-view dashboard
  (`<project>-us-east-1`): the load generator runs in the observer VPC there, and alarms
  can only read metrics in their own region. The two regional dashboards read the same
  metrics cross-region.

### Right after a deploy

For the first five minutes or so after the load generator starts, the client-view dashboard
shows a burst of fast errors with no region attribution (`Region=unknown`, about 800 a
minute, ~2 ms each), the primary's app-health alarm is in ALARM, and the decision alarm
follows it into ALARM a few minutes later. The cause is deploy order: the app's DNS records
are created by the failover stack, which deploys after the load generator because it takes
the load generator's alarm ARNs as input, so the client is running before its target name
resolves. Nothing needs doing. The errors stop once the records exist, both alarms return to
OK within about ten minutes of the client starting, and the standby's app-health alarm
settles into the ALARM state described above. The plan has no automatic triggers, so none of
this starts an execution. Take the steady-state readings above only after the decision alarm
is back to OK.

---

## 3. Practice run

Run §5 to §7b end to end once against the deployed environment before the live run. It
populates the 24-hour replica sample §1 depends on, and it is the only way to time the real
3 → 5 scale-up in your account.

---

## 4. Single-AZ gray failures (FIS)

All faults run in the **primary region**; the standby is the healthy region you switch to.
Every FIS experiment runs for 15 minutes unless stopped from the cockpit. Nothing halts one
for you: there is no stop-condition alarm, so a fault that has made its point is yours to
stop.

### Arm the nodes first

FIS targets EC2 instances tagged `ChaosAllowed=true`. Nothing is armed after a deploy.

- **Cockpit Arm button** (use this). It tags every node in the cluster, including
  Karpenter-launched nodes (found by the `karpenter.sh/nodepool` tag), and the managed node
  group's Auto Scaling group, which the power fault needs in order to pause in-AZ
  relaunches. Nodes Karpenter launches later are born armed.
- Command line, region-wide faults:
  `bash build/start-region-wide-injection.sh <region> <cluster> <nodegroup> <template-ids-csv>`.
  It fails if no node is registered with SSM, the usual reason an experiment runs and
  injects nothing.
- Disarm: `aws ec2 delete-tags --region <region> --resources <ids> --tags Key=ChaosAllowed`.

`/health` is excluded from every fault on purpose: failing it would deregister pods and turn
a gray failure into connection refusals.

### Fault menu

| Fault (cockpit name) | What it does | What to expect |
|---|---|---|
| Error-rate knob (SSM parameter, primary) | Fails a fraction of requests, deterministically | Aggregate availability lands in the 90–96% band. The default fault for the regional failover story. |
| **FIS latency 400 ms**, region-wide | `tc netem` delay on the database path, on every armed node | Reads land at ~4.9–5.0 s against the 5 s read timeout, so a fraction fail: availability in the 90s. Writes ~1.3 s and healthy. Health checks green throughout. |
| **FIS packet loss 25%**, region-wide | `tc netem` loss on the database path | Availability in a band below 100%, varying request by request. |
| `latency-single-az` | The latency fault on one AZ's nodes | **The most severe fault on the menu:** that zone's client-perceived availability falls to ~23%, p90 ~4.9 s, zero errors, target health 3/3. |
| `packet-loss-single-az` | The loss fault on one AZ's nodes | That zone at ~64%. A near-duplicate of the brownout. |
| `brownout-single-az` | 800 ms ± 400 ms delay on one AZ's pod↔NLB path; database path excluded | That zone's line sags to ~66%, its p90 climbs ~95 ms → ~2.2 s, the other two zones hold at 100%, health checks stay green, zero errors. The gray-failure judgment call. |
| `power-interruption-single-az` | Stops the armed instances in one AZ for 15 min, pauses ASG and Karpenter relaunches in that AZ, blackholes the AZ's subnets for the first 2 min | That zone goes dark: badge 2/3, its line gaps to no-data. The fault a zonal shift exists for. |

The single-AZ faults pick the AZ for you (the busiest by recent traffic). CPU-stress and
memory-stress are **gone from the menu**: `stress-ng` cannot install in these no-NAT
subnets, so both ran cleanly and changed nothing. Only `tc`-based network faults work here.

### Why these severities

A fault has to fail requests to be visible, which means crossing the app's
`connect_timeout=3 s` / `read_timeout=5 s`. Injected delay is multiplied by the number of
times a request crosses the delayed path: ~12.3× on the database path for reads, ~3.0× for
writes, ~2.8× on the pod↔NLB path. The FIS construct defaults (100 ms latency, 10% loss)
never fail a request and produce a **flat 100% line**; TCP retransmission absorbs 10% loss
completely.

Severity has a **ceiling as well as a floor**. At 500 ms every read misses the timeout and
availability hits 0%: the reads-vs-writes chart turns into two flat lines and there is
nothing left to decide from. The usable band is
`readable chart (well above 0%) < target < ~99% decision alarm`; 400 ms and 25% sit inside
it, at roughly 90-96% aggregate availability.

**Re-validate both numbers after any change to the armed fleet**, and after changing the
Aurora capacity floor: the values were measured with two armed nodes and a fixed 2 ACU
floor. The same goes for the per-zone figures below and the ~95 ms resting p90 they quote:
those were measured from a client inside the primary region, and the client now runs in
us-east-1, where every request pays a cross-region hop (resting p90 about 120 ms). Run the
region-wide latency fault for five minutes and confirm the aggregate line sits between the
two reference lines before a live run.

### Single-AZ calibration table

Measured on the client-perceived availability chart (a request counts only if it is
non-error **and** answered within 2 s), faulted zone only:

| Fault | Faulted-zone availability | Client p90 | Target health | Errors |
|---|---|---|---|---|
| `brownout-single-az` | **66.2%** | 2.0–2.7 s | 3/3 healthy | 0 |
| `packet-loss-single-az` | **64.3%** | 1.7–2.7 s | 3/3 healthy | 1 |
| `latency-single-az` | **22.7%** | ~4.9 s | 3/3 healthy | 0 |
| `power-interruption-single-az` | no data (nothing served) | no data | 2/3, then no data | region briefly at 0% |

Three things to know before narrating it:

- **Latency on the database path is the most severe fault**, not the mildest: 400 ms
  amplified ~12.3× is worse than 800 ms amplified ~2.8×. Zero errors the whole time: the app
  avoids failing by waiting, and a 4.9-second page is not "riding it out".
- **Brownout and packet loss are near-duplicates** on this measure. Pick one.
- **The power fault's row is a gap, not a zero.** The per-AZ metrics are emitted by the load
  generator, so a zone with no running pods reports nothing; the target-health badge carries
  that beat instead.

### Health checks stay green during the brownout

Do not promise a target-health flap; it is **the flap that cannot happen** at this severity.
The NLB health check pays one delayed hop (~0.5–1.3 s against a 2 s timeout) and passes
every time; a client request pays ~2.8 delayed hops and lands at p90 ~2.2 s, outside the 2 s
bar. Load balancer and customer measure the same two seconds and reach opposite verdicts,
which is what the segment shows. Delay large enough to fail the check (~1.8–2.0 s) would
put client p90 past the 5 s read timeout, so a flapping check and a surviving client are
mutually exclusive.

---

## 4b. The AZ segment: brownout, power interruption, zonal shift

One sick AZ's correct answer is a **zonal shift**, not a regional failover. The segment runs
in the primary region; the cockpit disables the AZ controls when traffic is in the standby,
because the NLB it can shift is the primary's.

### What the card shows

- **Chart**: *Client-Perceived Availability by AZ*: per minute, per serving AZ, the share of
  requests that were non-error and answered within 2 s, with dashed 50% and 99% reference
  lines.
- **Badge**: the platform's verdict, NLB **target health**, as `load balancer: 3 / 3 zones
  healthy`.
- **Tiles**: client p90 per AZ.

Say "client-perceived availability" for the chart and "target health" for the badge. The
disagreement between the two is what the segment is about.

### Order of the beats

The AZ segment is **THREE beats**, and the ladder does NOT run in menu order: open with
`latency-single-az` (the hidden-severity beat, **22.7%** with every platform signal green),
then `brownout-single-az` (the visible gray middle, **66.2%**), then
`power-interruption-single-az` (the black close). Do not say "the app rode that out" over a
4.9-second p90. A spoken script for the same three beats is in `docs/az-segment-script.md`.

### The sequence, from the cockpit page

1. **Confirm the card is live**: three lines at 100%, badge 3 / 3, three p90 tiles near
   95 ms. Three pods run one per AZ, so each AZ has one registered target.
2. **Start `latency-single-az`** and let it run ~3 minutes. Expect: aggregate availability
   holds ~100%, every target healthy, the faulted zone's line falls to ~23% and its p90 tile
   reads ~4.9 s. Say: zero errors, every health check green, three quarters of that zone's
   customers waiting longer than two seconds. Stop it.
3. **Arm** (Arm button). Arming also tags the node group's Auto Scaling group, which is what
   lets the power fault pause in-AZ relaunches.
4. **Start `brownout-single-az`** and type the confirmation. **You do not pick the AZ**; the
   cockpit selects the busiest by recent traffic and refuses with a reason if none qualifies.
   Expect: that zone's line sags to ~66%, its p90 tile climbs to ~2.2 s, the other two hold
   at 100%, the badge stays 3 / 3, errors stay at zero, the aggregate chart barely moves.
   Nothing is down; the dashboards disagree with each other.
5. **Start the zonal shift on the gray zone.** Say the judgment call aloud: every automated
   signal says this zone is fine, nothing will remove it on its own, clients keep landing on
   it and keep waiting. The confirmation is the faulted AZ's name, derived server-side from
   the running experiment. Expect: the zone's line goes quiet (no data, because nobody is
   served there) while the badge still reads 3 / 3, because the checks still probe the slow
   zone. "Still sick, just no longer in the path."
6. **Stop the brownout.** The shift **auto-cancels with it** (the stop response lists
   `autoCancelledShifts`); the zone's line returns to 100% within a few polls.
7. **Start `power-interruption-single-az`** and type the confirmation. During the first two
   minutes **expect ALL THREE zones to wobble**, because the subnet blackhole disrupts the
   health-check plumbing itself, not just the faulted zone; narrate it as the DNS-refresh
   blip a real power event produces. It then settles into one zone dark: **the badge drops
   to 2 / 3 and the faulted zone's line gaps to no-data.** The pods tolerate the node's
   not-ready taints for 900 s, so the target stays
   **registered-unhealthy for the whole window** instead of disappearing after ~5 minutes.
8. **Say what the aggregate does before the audience does: it recovers on its own within
   about a minute.** Cross-zone routing stops sending to unhealthy targets as soon as the
   checks fail, with no operator action. The zonal shift here is the operator's
   **control move, not the recovery mechanism**: it makes the zone's removal deterministic,
   auditable and self-expiring instead of a side effect of health-check timing.
9. **Start the shift, then stop the fault.** Same mechanics as beat two: typed AZ name, live
   expiry countdown (default `15m`, matched to the fault), auto-cancel on stop. Instances
   restart, targets re-register, the line climbs back to 100% within a few polls.

### If it misbehaves

- FIS selects the AZ by **name** (`us-east-2a`); the zonal shift's `awayFrom` takes the AZ
  **ID** (`use2-az1`), and the mapping is account-specific. It is looked up at deploy and
  re-verified by `build/verify-zonal-shift-azs.py`, which also proves the NLB is opted in to
  zonal shift. A 409 "not opted into zonal shift" means the Service annotation did not land.
- A fault that dies seconds after starting with **"Target resolution returned empty set"**
  found no armed instance in the busiest AZ. Re-arm and check the armed count covers every
  node.
- The brownout runs but the zone's line does not sag: read the target group's health-check
  settings back (`aws elbv2 describe-target-groups`; the calibration assumes the 2 s HTTP
  timeout) and the p90 tile. A zone whose p90 sits under 2 s produces no sag by definition.
  Target health never moves at this severity.
- The 2-minute blackhole takes **that AZ's Aurora instance** with it (nodes and database
  share the isolated subnets). Each regional Aurora member runs one instance per AZ, so this
  costs one reader, or a writer failover if the faulted zone held the writer: expect a short
  write dip (one failed write per pooled connection) and recovery within seconds as the pool
  replaces its dead sockets. No cleanup needed.
- All three zones drop to 0% and stay there: stop the experiment from the cockpit, then
  check the instance count per AZ (`aws rds describe-db-instances --query
  'DBInstances[].[DBInstanceIdentifier,AvailabilityZone]'`). A single-instance member turns
  the blackhole into a regional outage.

---

## 5. Fail over

**Use the wrapper; do not type the CLI call by hand** (see "Why the wrapper" below).

Get the plan ARN from the stack, never from a note. The ARN changes whenever the plan is
replaced rather than updated, and a stale one fails with a 404 that reads like a
permissions error:

```
aws cloudformation describe-stacks --stack-name eks-mr-demo-failover --region us-east-2 \
  --query "Stacks[0].Outputs[?OutputKey=='PlanArn'].OutputValue" --output text
```

```
bash build/arc-switch.sh activate us-west-2 <plan-arn>            # dry run: prints the call
bash build/arc-switch.sh activate us-west-2 <plan-arn> --execute
```

`activate <standby>` **is** the failover. The plan is `activePassive` with one `activate`
workflow, so bringing the standby up takes the primary out as one sequenced cutover; fail
back by naming the other region. The wrapper refuses `deactivate` (`StartPlanExecution`
would reject it with no matching workflow) and prints the correct form.

There is **no approval gate** and there are no automatic triggers: `start-plan-execution` is
itself the authorization, and the absence of triggers is what prevents an unattended
regional failover.

### What to expect

The plan runs three steps in a fixed order, and capacity arrives **before** traffic moves:

| Step | Block | Expect |
|---|---|---|
| `scale-target-capacity` | EKS resource scaling | Standby Deployment 3 → 5 replicas (150% of the primary's 24-hour maximum of 3); Karpenter adds nodes for the two new pods. 3–6 minutes when capacity exists; bounded at `timeoutMinutes: 8`. The HPA's scale-down is disabled here and stays disabled (§7b). |
| `switch-aurora-writer` | Aurora global database | The writer moves to the standby. Writes fail for a few seconds while the pods' write pools replace their dead sockets, then recover; reads never stop (each region uses its own reader endpoint). |
| `shift-dns-to-target` | Route 53 health checks | ARC flips its health checks and the failover records follow. Load-generator traffic appears in the standby within the record TTL. |

If the scaling step ends with fewer than 90% of the replicas ready, the plan stops rather
than shifting traffic onto a standby that cannot serve it. That is correct behaviour: look
at pending pods, then Karpenter's logs, then vCPU quota.

Read progress from the **regional data plane** of the region being activated, not the
global dashboard, which AWS documents may not show all plan data during a regional
impairment:

```
aws arc-region-switch get-plan-execution --region us-west-2 \
  --plan-arn <plan-arn> --execution-id <execution-id>
```

### Why the wrapper

`start-plan-execution` takes two regions that mean different things: `--target-region` is
the region traffic moves to or from, `--region` is the API endpoint, and ARC executes plans
from the region being **activated**. For `activate` they coincide. For a `deactivate` the
natural thing to type sends the call to the region you are abandoning, which fails only in a
real event and never in a practice run. The wrapper derives the endpoint and refuses the
verb.

---

## 6. Verify recovery

Do not conclude success from the plan reporting success.

| Check | Why |
|---|---|
| The standby's replica count actually moved **3 → 5** | The failure mode in §1 is a scaling step that reports success having scaled nothing. |
| Karpenter provisioned nodes for the new replicas (`kubectl get nodes -l karpenter.sh/nodepool`) | With `required` anti-affinity they cannot fit on the existing nodes. |
| Argo CD still shows **Synced / Healthy** and did not revert the replica count | The coexistence claim. Only meaningful *after* the replica check: "Argo did not revert" is equally true when nothing changed. |
| Availability recovers and the decision alarm (99%, 3 of 5 periods) clears | The signal an operator would act on. |
| **Writes recover, not just reads.** POST an order and read it back | Platform recovery and application recovery are different claims. If writes do not return, look at the application. |
| The standby's app-health alarm goes ALARM → OK | The measured recovery. |

**`targetPercent` compounds across a round trip.** Each execution sizes from the *source*
region's 24-hour maximum times 150%, so within one window failover asks 3 → 5 and failback
asks 5 → 8, which fits the 10-pod ceiling (HPA `maxReplicas`). A third execution in the same
24 hours would ask for 12 and stall in the scaling step: **two executions per day** is the
operating limit.

---

## 7. Fail back

```
bash build/arc-switch.sh activate us-east-2 <plan-arn>              # dry run first
bash build/arc-switch.sh activate us-east-2 <plan-arn> --execute
```

The same three steps in the other direction; the wrapper derives the endpoint. Expect the
same short write dip during the writer switch, and run §6 again with the regions swapped.

## 7b. Restore steady state (after every failover and every failback)

ARC's scaling step patches the HPA with `scaleDown.selectPolicy: Disabled`, and the patch
persists after the execution ("during or after the execution", per the developer guide).
Argo CD ignores that field and the replica count on purpose, so nothing reverts either. Left
alone, two round trips in a day ratchet the app to 10 pods with scale-down off, and the next
execution sizes from the inflated sample.

```
bash build/restore-steady-state.sh                # dry run: prints what it would do
bash build/restore-steady-state.sh --execute      # one cleanup build per region
```

Per region, through the in-VPC installer CodeBuild project:

1. `kubectl patch hpa` sets `scaleDown.selectPolicy` back to `Min` (the reverse of ARC's
   patch; `minReplicas` is untouched). The HPA then rightsizes each region on its own.
2. `kubectl rollout restart` for fresh pods and fresh connection pools. Hygiene, not a
   remediation: writes recovered during the switch.

Expect the Karpenter node count to return to baseline within 10–20 minutes: the NodePool
reaps empty nodes (`WhenEmpty`, `consolidateAfter: 5m`) and never evicts a node carrying a
pod. Timing is yours; an hour or a day later is fine. The 24-hour replica sample corrects
itself a day after the restore.

ARC offers a `postRecovery` workflow that could carry these two commands inside the plan.
This sample keeps them in a script so cleanup is not coupled to ARC's execution model; the
feature is there if a customer wants it in the plan.

### Teardown

1. Disarm (remove `ChaosAllowed` tags, stop any running experiment).
2. Reset the error-rate SSM parameter to `0` in both regions.
3. `make clean` (runs `cleanup.sh`): every stack in reverse dependency order across the
   three regions, then the mirror ECR repositories and the assets buckets. Idempotent and
   safe against a partial deploy.
4. Or leave it running: about **$2.40/hr**, $57 a day at rest (README, Cost).

---

## 8. Failures that look like something else

| Symptom | Likely cause |
|---|---|
| Everything green, workload dead, `ImagePullBackOff` | Image not in the region's ECR, or the mirror pinned a digest that region does not hold. |
| Load generator task stuck in `PROVISIONING`/`PENDING`, or `CannotPullContainerError` | The observer VPC is missing an ECR or S3 endpoint, or the Locust image was not pushed to the us-east-1 repository. The task has no internet route; there is no fallback. |
| Every chart empty, every alarm `INSUFFICIENT_DATA`, task running | The Locust task cannot resolve `app.eks-mr-demo.internal`: the private zone is not associated with the observer VPC, or the observer peerings were not accepted and routed in a workload region. |
| Hundreds of ~2 ms errors a minute with `Region=unknown`, both us-east-1 alarms in ALARM, minutes after a deploy | Normal. The failover stack that creates the app's DNS records deploys after the load generator (§2, "Right after a deploy"). It clears within about ten minutes; if it persists, treat it as the row above. |
| Availability alarm stuck in `INSUFFICIENT_DATA` | Nothing is emitting the metrics the alarm reads. Check the load generator's log group in **us-east-1**. |
| FIS experiment runs, injects nothing | No node registered with SSM, or no `ChaosAllowed` tag. The arming script fails on the first; the second is silent. |
| Karpenter node joins EC2 but never appears as a Kubernetes Node | Missing `EC2_LINUX` access entry. Instances look healthy while pods stay Pending. |
| Injection works but availability barely moves | Surge pods on Karpenter nodes are not reading the knob: the IMDS hop limit must be **2**; Karpenter's default of 1 blocks pods off the host network. |
| Plan evaluation fails, IAM looks correct | Wrong cluster access policy. It must be `AmazonARCRegionSwitchScalingPolicy`, not `AmazonEKSEditPolicy`. |
| Argo CD tunnel connects but the UI redirects in a loop or returns 502 | `server.insecure` was not applied (`k8s/argocd-config.yaml`). Argo CD redirects plain HTTP to HTTPS behind an HTTP-only ALB. |
| `start-plan-execution` returns 404 | The plan was replaced (for example after a `recoveryApproach` change) and the ARN is stale. Re-read it from the stack output. |
