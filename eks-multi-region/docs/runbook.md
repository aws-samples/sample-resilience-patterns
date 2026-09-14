# Operator runbook — multi-region EKS with ARC Region switch

What CDK cannot express. Written for someone who did not build this.

Everything below was verified against AWS documentation or by running it. Where something
is an assumption, it says so.

---

## 0. Prerequisites (one-time, and none of them are automatable from here)

| # | Item | Notes |
|---|---|---|
| 1 | GitLab project at `aws-cre/benchmarking-reference-apps/eks-mr-demo` (moved from `aws-cre/resilience-demos/` 2026-09-14; the old path redirects) | Create empty. Nothing can be pushed until it exists. |
| 2 | Deploy IAM role in the target account | Trusted by your CI provider's identity (OIDC or a runner role) with a condition scoping it to THIS repository/project. **If the role is shared across projects, MERGE the new project into the existing condition list, never replace it.** (Public port: replaced by GitHub Actions OIDC -- see the root `.projenrc.ts` `patterns[]` entry.) |
| 3 | CI variables | `AWS_CREDS_TARGET_ROLE` (type **Variable**, not File), `ASSETS_BUCKET_PREFIX=eks-mr-demo`. |
| 4 | Two S3 buckets | `eks-mr-demo-us-east-2`, `eks-mr-demo-us-west-2`. |
| 5 | Target account | Your own AWS account. Use a dedicated sandbox/demo account with no customer data. Provision a ReadOnly role alongside your Admin role so the read-only checks in this runbook can run least-privilege. |
| 6 | Runner ECR permissions must cover `eks-mr-demo/mirror/*` in **both** regions | `GetAuthorizationToken`, `DescribeRepositories`, `CreateRepository`, `DescribeImages`, `BatchCheckLayerAvailability`, `InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload`, `PutImage`. A policy scoped to `cdk-*` repository ARNs **denies the third-party image mirror while every other deploy step stays green.** |
| 7 | Runner needs `elasticloadbalancing:DescribeLoadBalancers` | The DNS stack needs each NLB's canonical hosted zone id, and the in-VPC installer's subnet has no ELB endpoint, so the runner does that lookup. Step 12 reuses it to resolve the argocd NLB's ARN. |
| 8 | **Front door (step 12), per deployer:** in the public port the CloudFront + signed-cookie front door is REPLACED by an observer bastion reached over SSM Session Manager port-forwarding (`scripts/tunnel.sh`). No public ingress, no identity-provider onboarding, no CloudFront distributions. | Needs `session-manager-plugin` on the operator machine and `ssm:StartSession` on the operator's role. See "Operate" below. |

**ARC Region switch availability in us-east-2 and us-west-2: VERIFIED 2026-08-25.**
The ARC developer guide states Region switch "is available in all commercial AWS
Regions", the endpoints-and-quotas table lists `arc-region-switch.us-east-2.api.aws`
and `arc-region-switch.us-west-2.api.aws` explicitly, and both hostnames resolve via
DNS. Not yet exercised with a live API call in the target account (no credentials from
this environment) — the first `list-plans` on deploy day 1 is the final confirmation,
but the region pair is no longer at risk of changing.

---

## 1. Deploy

```
npx projen build          # must be green before anything else
# then the GitLab pipeline: build -> deploy
```

Stack order is forced, not chosen: `region-us-east-2` → `region-us-west-2` → `globaldata` →
`secondarydb` → `peering` → `dns` → `loadgen` → `regionswitch` → `standbyaccess` →
`frontdoor-us-east-2` → `frontdoor-us-west-2` (the front doors deploy after the installers
because their VPC origins target the Kubernetes-created argocd NLBs; VPC origin creation
can take up to 15 minutes per region).

### DEPLOY THE DAY BEFORE A CUSTOMER-FACING RUN

Not a nicety. ARC's EKS scaling block sizes the standby from the **maximum replica count
sampled over the previous 24 hours**, and there is no knob to shorten that window. On a
same-day deploy that sample may not be populated, in which case the computed desired count
can collapse toward zero — and because the block only scales when the destination is *lower*
than desired, **it scales nothing and reports success.** Traffic then shifts to a standby at
its original size.

That is worse than a missed scale-up, because it also makes the Argo coexistence claim
vacuous: if ARC scaled nothing, Argo has nothing to revert, and "Argo stayed Synced" proves
nothing at all.

*The collapse-to-zero path is inference from the documented formula and the "lower than"
condition, not documented behaviour. The 24-hour sampling window and the "lower than"
condition are both quoted from AWS docs.*

---

## 2. Immediately after every deploy

### Re-open the demo UI

**Every deploy resets `AllowedCidr` to `0.0.0.0/32`** — it is a `CfnParameter` with a
deny-all default, by design. Re-open it to your address, and **close it again when you are
finished.** An open CIDR left behind is a finding.

### Open the Argo CD UIs through the front doors (step 12)

Each region's `frontdoor` stack outputs `DistributionDomainName`. Browse to
`https://<that domain>/` — the first visit 403s, bounces through CloudFrontSigner (Midway
+ your Bindle), sets signed cookies, and lands on the Argo CD UI. Both regions, because
§6's coexistence proof is read from the **standby's** UI.

If it never leaves the 403 page: prerequisite 8 was skipped (onboarding or the Bindle
grant), or `CFS_BINDLE_ID` was unset at deploy (the Phase 7 log says so loudly). If Argo
loads but loops or 502s: `server.insecure` — see §8. Argo's initial admin password:
`kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d`
(via the installer CodeBuild if no other kubectl path exists yet).

### Pre-demo checklist — all of these, every time

| Check | Why it matters |
|---|---|
| ARC **Plan evaluation** tab shows no monitoring-data warning | Evaluation re-runs every 30 minutes, so this is checkable rather than a guess. It is the gate on §1's 24-hour sample. |
| Plan evaluation shows the correct access-entry policy | It validates `AmazonARCRegionSwitchScalingPolicy` specifically. The wrong policy fails evaluation while IAM, synth and deploy all look correct. |
| `kubectl get ec2nodeclass default -o wide` → **Ready**, incl. `InstanceProfileReady` | Karpenter's policy includes `iam:GetInstanceProfile` and IAM is unreachable from these subnets. It is documented to work this way, but if that condition never goes true, **nothing provisions.** |
| `kubectl get nodepool default` → Ready | No NodePool means Karpenter installs, elects a leader, and provisions nothing. |
| Karpenter controller logs — check the pricing call degrades rather than stalls | `pricing:GetProducts` targets an endpoint-less API. The NodePool constrains instance types so pricing is not needed to choose, but confirm. |
| 2 app pods, on 2 **different** nodes | Anti-affinity is `required`. If both landed on one node the selector is not matching — which makes the constraint vacuous and Karpenter will never be asked for capacity. |
| Service quotas: running On-Demand Standard vCPU headroom | Plan evaluation covers running capacity, **not quota headroom**, and scaling the standby to 200% is the first thing a sharp audience pokes at. |
| Load generator is emitting `ClientSuccess` | If availability shows no data, nothing is driving traffic and every later observation is meaningless. |

### Expected steady state, so surprises are recognisable

- Availability ~100% in the primary.
- **The standby's app-health alarm sits in ALARM, by design.** Missing-data is treated as
  breaching and there is no traffic in the standby until the DNS flip. Its transition to OK
  after failover *is* the measured recovery. Say this out loud before someone spots it.
- The FIS guardrail alarm (50%, 2-of-2) is OK and stays OK unless things go badly wrong.

---

## 3. Practice run before the live run

Run the whole sequence end to end at least once against the deployed stack. Two reasons
beyond confidence: it populates the 24-hour replica sample §1 depends on, and it is the only
way to measure the real 2 → 4 scale-up duration (see §6).

---

## 4. Inject the failure

The demo's fault is a **gray failure** — degraded, not down. Three layers exist; they do not
do the same thing.

| Layer | Mechanism | What it actually moves |
|---|---|---|
| **L1** | Error-rate knob (SSM parameter), primary only | **Availability.** Lands the 90–96% band deterministically. This is the stage default. |
| **L2** | FIS packet loss 25%, per-AZ, region-wide fan | **Availability**, stochastically. Less precise than L1, but a real band rather than a cliff. |
| **L3** | FIS latency 400 ms, per-AZ, region-wide fan | **Availability** on reads, latency on writes. Deterministic, so closer to a cliff. |
| **L4** | The same two faults, **single-AZ** (`latency-single-az` / `packet-loss-single-az`) | **The most severe faults on the menu — and NOT the contrast beat any more.** Zero errors, every target healthy, but the injected delay hits the DB path where it amplifies ~12.3× on reads: client p90 ~4.9 s, so **client-perceived availability reads 22.7%** (packet-loss 64.3%). Measured 2026-09-04. The app avoids errors by *waiting*; the error-only measure called that healthy. See the calibration table below. |
| **L5** | **AZ power interruption** (`power-interruption-single-az`): stops the armed AZ's instances 15 min, pauses ASG/Karpenter relaunches in-AZ, 2-min subnet blackhole | **One AZ's badge and line go dark** — the impairment the app *cannot* absorb, and the one ARC zonal shift exists for. AZ auto-selected by recent traffic. Genuinely zonal only since each Aurora member runs one instance per AZ (2026-09-04); before that, hitting the writer's zone took the whole region down. See "The AZ segment" below. |
| **L6** | **Brownout** (`brownout-single-az`): 800 ms ± 400 ms latency on ONE AZ's pod↔NLB path, DB path excluded by construction, 15 min | **The GRAY AZ beat.** That zone's client p90 climbs ~95 ms → ~2.2 s (~2.8 shaped round trips, measured) and its **client-perceived availability sags to ~66%** while the other two hold at 100%. Health checks stay GREEN throughout — see "the flap that cannot happen" below. Nothing dies; the judgment-call fault. See "The AZ segment" below. |

CPU-stress and memory-stress are **gone from the menu**, deliberately: `stress-ng` cannot
install in these no-NAT isolated subnets (only `tc`-based network faults work, because `tc`
ships with AL2023), so both delivered cleanly over SSM and moved nothing. A fault that
reports success and changes nothing measurable is worse than no fault.

### Fault severity is calibrated to the app's timeouts — and it is TWO-SIDED

Every fault on the cockpit's menu has to be able to force the failover **decision**, which
means it has to fail a request, which means it has to cross `common.py`'s
`connect_timeout=3 s` / `read_timeout=5 s`. **The construct defaults did not.** Measured
live on 2026-09-01, both were injecting correctly and neither failed a single request:

| Fault at construct default | Read p90 | Write p90 | Errors |
|---|---|---|---|
| 100 ms latency | 97 ms → **1,325 ms** | 13 ms → **330 ms** | **0** |
| 10% packet loss | ~**1,100 ms** sustained | — | **0** |

A slow request still succeeds, and TCP retransmission absorbs 10% loss completely. Both
therefore showed a **flat 100% line** on the availability graph — the precise failure a
runbook step saying "inject latency, watch availability sag" would produce in front of an
audience.

But there is a **ceiling as well as a floor**, and the demo's own guardrail is the ceiling.
At 500 ms the amplified read p90 (~6.2 s) put **every** read past the 5 s timeout:
availability hit 0%, the 50% `ClientAvailabilityGuardrail` fired, and **FIS halted the
experiment itself** ~3 minutes in — the demo healed before an operator could decide. The
usable band is `50% guardrail < target < ~99% decision alarm`.

The arithmetic: injected delay is multiplied by the database round trips per request —
**reads ~12.3×** (+1,228 ms per 100 ms), **writes ~3.0×**. The shipped values:

- **Latency 400 ms** — reads land ~4.9–5.0 s, straddling the 5 s timeout, so a *fraction*
  fails: a band in the 90s, above the guardrail, below a total outage. Writes (~1.3 s)
  degrade but hold. Still a **gray** failure: `/health` makes no database call, so every
  load-balancer and ARC health check stays green throughout.
- **Packet loss 25%** — enough to defeat retransmission on a fraction of requests (10% was
  absorbed ENTIRELY); per-request outcomes vary, so this is the one that lands a band.

**Re-validate both numbers after any change to the armed fleet.** These were calibrated
when only the 2 managed-node-group instances were armed; with the Karpenter nodes armed
too (all 5), the effect size changes — more of the fleet degrades, so the band moves down.
Every severity number in this demo that was reasoned rather than measured has been wrong
at least once. Run the region-wide latency fault for 5 minutes and confirm the aggregate
line sits between the 50% guardrail and the ~99% decision threshold before a live run.

### The single-AZ calibration table — all four faults, measured 2026-09-04

Measured against the **client-perceived availability** chart (a request counts only if it
is non-error **and** answered within 2 s). One run per fault, faulted zone only:

| Fault | AZ | Faulted-zone SLO availability | Client p90 | Target health | Errors |
|---|---|---|---|---|---|
| `brownout-single-az` 800 ms ± 400 ms (pod↔NLB) | 2c | **66.2%** | 2,039 → 2,718 ms | healthy 3/3 | **0** |
| `packet-loss-single-az` 25% (DB path) | 2c | **64.3%** | 1,665 → 2,711 ms | healthy 3/3 | 1 |
| `latency-single-az` 400 ms (DB path) | 2b | **22.7%** | ~4,900 ms | healthy 3/3 | **0** |
| `power-interruption-single-az` | 2b | no data (nothing served) | — | 1/1 then no-data | region hit 0% |

Three things in that table matter more than the individual numbers.

**The ladder inverts.** `latency-single-az` was scripted as the "app rides it out" contrast
beat, and on the client-perceived measure it is the **most severe fault on the menu** —
22.7% against the brownout's 66.2%. The difference is where the delay lands: 400 ms on the
**database** path amplifies ~12.3× (one request makes many round trips), while 800 ms on the
**pod↔NLB** path amplifies ~2.8×. *Severity is the injected number times the number of times
a request crosses the shaped path*, which is the actual lesson and a better one than the beat
it replaces. Zero errors the whole time: the app avoids failing by **waiting**, and a
4.9-second page load is not riding anything out.

**Brownout and packet-loss are near-duplicates** on this measure (66.2% vs 64.3%). Worth
knowing before both stay on the menu as if they showed different things.

**The power fault's row is a gap, not a zero.** The `Az*` metrics are client-emitted, so a
zone with no running pods reports nothing rather than 0% — which is why the platform-verdict
badge (target health) stays on the card. That run was also halted by the 50% guardrail three
minutes in for a reason since fixed: see the closing paragraph of §4b.

### The flap that cannot happen — read this before narrating the brownout

Earlier versions of this runbook, the segment script and the cockpit's own fault note said
the brownout makes the faulted zone's **target health flap**. It does not, and it cannot.
Proven twice live at the shipped severity (2026-09-03 and 2026-09-04): 3/3 targets stayed
**healthy** for the whole window, with zero errors.

The mechanism is an asymmetry worth saying out loud on stage:

| | shaped hops per request | at 800 ms ± 400 ms | verdict |
|---|---|---|---|
| NLB health check | **1** (pod's egress response) | ~0.5–1.3 s, max observed **1.24 s** | passes every time, against a 2 s timeout |
| Customer request | **~2.8** (measured) | p90 **2,240 ms** | outside the 2 s SLO bar |

So the load balancer and the customer are held to the *same two seconds* and reach opposite
verdicts — the balancer measures one hop and passes, the customer measures the whole journey
and gets 66%. That coincidence of numbers is the punchline, not a problem; the two constants
are pinned by separate tests precisely so it stays a coincidence and not a coupling.

**A flap is not available at any severity.** Straddling the 2 s check timeout needs ~1,800–
2,000 ms of delay, which puts client p90 at ~5.0–5.6 s — past the app's 5 s read timeout. A
flapping check and a surviving client are mutually exclusive. What the demo shows instead is
a truer gray failure than a flap would have been: one zone at 24× baseline latency, health
checks green, **zero errors**, capacity quietly halved (that zone's throughput 253 →
142 req/min), and no automatic remediation anywhere. The platform says healthy, the customer
says slow, and the zonal shift is a real operator judgment call rather than something
health-check timing was going to settle on its own.

A test derives this contract from the application source — it parses `read_timeout` out of
`common.py` and fails the build if any advertised availability fault cannot clear it.

### The arming gesture

FIS targets `aws:ec2:instance` by the tag `ChaosAllowed=true`. Nothing is armed until you
tag it:

```
bash build/start-region-wide-injection.sh <region> <cluster> <nodegroup> <template-ids-csv>
```

It **fails loudly if no node is SSM-registered**, which is the common cause of an experiment
that runs and injects nothing. To disarm:

```
aws ec2 delete-tags --region <region> --resources <ids> --tags Key=ChaosAllowed
```

**The cockpit's Arm button now covers the WHOLE fleet, not just the managed node group.**
Karpenter-launched nodes belong to no ASG, so the node-group walk never saw them — measured
2026-09-01, 3 of 5 nodes were Karpenter's and silently immune to every fault. The arm
action now also resolves instances by the `karpenter.sh/nodepool` tag (scoped to this
cluster), and **new** Karpenter nodes are born armed: the EC2NodeClass carries
`ChaosAllowed: "true"` in `spec.tags`, which applies at launch. That tag cannot retro-tag
nodes already running — the Arm button is what covers those. After changing the armed
fleet, re-validate the fault severities (see above): the calibration was measured against
2 armed nodes.

`/health` is deliberately excluded from the injected failure. Failing it would pull degraded
pods from the target group and turn a gray failure into connection refusals.

---

## 4b. The AZ segment — gray to black: brownout, power interruption, zonal shift

The region-wide story ends in a Region switch. This segment tells the OTHER story: one sick
AZ's correct answer is a **zonal shift**, not a failover. It runs in the **primary region
only** — the cockpit disables the AZ controls with a stated reason when traffic is
elsewhere, because the NLB it can shift is the primary's, and a shift while traffic is in
the standby would report ACTIVE and move nothing measurable.

**What the per-AZ card measures — read this before narrating it.**

Since 2026-09-03 the AZ story is **one chart, one badge and three tiles**, not two charts.

The **chart** is *Client-Perceived Availability by AZ*: per minute, per serving AZ, the share
of requests that were **non-error AND answered within 2 s** (`AzSloSuccess` over attempts,
classified at emit time by the load generator). Y axis 0–100%, with the same dashed 50% /
99% references the aggregate availability chart uses. It replaced a raw latency-by-AZ chart
because a latency axis invites the audience to compare a client number against a
health-check timeout, which is exactly the mistake that produced the flap story above.

The **badge** above it is the platform's verdict — NLB target health, as
`load balancer: 3 / 3 zones healthy`. It is deliberately a badge rather than a second chart,
because the contradiction is sharpest that way: during the brownout it reads **3 / 3 healthy
while the chart under it sits at 66%**. That is the whole gray-failure thesis in one card.
It also covers the case the chart structurally cannot: the `Az*` family is client-emitted, so
under the black fault the faulted zone's pods stop reporting and its line **gaps to no-data
instead of diving to 0** — the badge flips to 2 / 3 and carries that beat.

The **tiles** carry client p90 per AZ as numbers, so magnitude stays one glance away without
an axis to misread.

Say "client-perceived availability" for the chart and "target health" for the badge — the
audience will check, and the two disagreeing is the point.

**The segment is THREE beats, and the ladder does NOT run in menu order.** Calibration on
2026-09-04 measured `latency-single-az` at **22.7%** — worse than the brownout's 66.2% —
because 400 ms on the database path amplifies ~12.3× while 800 ms on the pod↔NLB path
amplifies ~2.8×. So the fault that was scripted as the "app rides it out" contrast beat is
the most severe one on the menu. Two ways to run the segment honestly:

- **Recommended — make it the point.** Open with `latency-single-az` as the *hidden* severity
  beat: zero errors, every target healthy, and 77% of that zone's customers outside a
  two-second bar. "Our error rate said we were fine." Then the brownout as the visible gray
  middle, then the power interruption as the black close. The ladder becomes a lesson about
  measurement rather than a lesson about severity.
- **If you want the original contrast beat back**, it needs a milder fault than anything
  currently on the menu — 10% packet loss was absorbed *entirely* by TCP retransmission
  (zero errors, no measurable effect), which is the honest "rides it out" shape. That fault
  is not deployed; do not substitute the 25% one, which reads 64.3%.

Either way, do not say "the app rode that out" over a 4.9-second p90.

The sequence, from the cockpit page:

1. **Confirm the per-AZ card is live.** Three lines at 100%, badge reading 3 / 3 zones
   healthy, three p90 tiles at baseline (~95 ms). Three pods run one per AZ (zone-scoped
   topology spread), so each AZ has one registered target in steady state.
2. **Hidden-severity beat — start `latency-single-az`**, let it run ~3 minutes. The
   aggregate availability chart holds ~100% and every target stays healthy — and the
   faulted zone's line on the per-AZ chart falls to roughly **23%** while its p90 tile
   reads ~4.9 s. Narrate the gap: "zero errors, every health check green, and roughly
   three quarters of that zone's customers waiting longer than two seconds." Stop it.
3. **Arm the fleet** (Arm button). Arming tags the instances **and the node group's ASG**
   — the ASG tag is what lets the power fault pause in-AZ relaunches, without which the
   ASG heals the zone in minutes and steals the beat. The brownout and power faults both
   target armed instances only.
4. **Gray beat — start `brownout-single-az`** and type the confirmation.
   **You do not pick the AZ** — the cockpit selects the busiest by recent traffic and
   refuses with a stated reason if none qualifies. What it does: 800 ms ± 400 ms of latency
   on that AZ's pod↔NLB path for 15 minutes — health checks AND client responses, DB path
   excluded by construction. Watch that zone's **line sag to ~66%** while two hold at 100%,
   its **p90 tile climb ~95 ms → ~2.2 s**, and the **badge stay at 3 / 3 zones healthy**.
   Errors stay at zero and the aggregate availability chart barely moves. Do NOT promise a
   flap — the check pays one shaped hop and passes every time (see "the flap that cannot
   happen" above). Nothing is down, and that is the point: this is the day the dashboards
   argue with each other.
5. **Start the zonal shift on the gray zone.** The judgment call, said aloud: **every
   automated signal says this zone is fine.** Target health is green, error rate is zero,
   no alarm has fired and nothing will remove the zone on its own — so clients keep landing
   on it and keep waiting. Nothing in the platform is going to make this decision for you.
   The shift makes the removal deterministic and auditable: that zone serves nothing until
   you (or the expiry) say otherwise. The confirmation is the faulted AZ's name, derived
   server-side from the running experiment. After the shift, the zone's line goes **quiet
   (no-data)** — nobody is being served there, which is the shift working — while the badge
   keeps reading 3 / 3 healthy, because the checks still probe the slow zone. Narrate that
   as "still sick, just no longer in the path."
6. **Stop the brownout.** The shift **auto-cancels with it** (the stop response lists
   `autoCancelledShifts`); the zone's line returns to 100% within a few polls.
7. **Black beat — start `power-interruption-single-az`** and type the confirmation. What
   it does: stops every armed instance in the busiest AZ for 15 minutes, pauses ASG
   scaling and Karpenter launches **in that AZ only**, and blackholes the AZ's subnets
   for the first 2 minutes (the DNS-refresh blip a real power event produces — narrate
   it; during that window expect ALL THREE zones to wobble, because the blackhole
   disrupts the health-check plumbing itself, not just the faulted zone. It settles into
   the true one-zone-dark shape; never apologize for it). **The badge drops to 2 / 3 and
   the faulted zone's line gaps to no-data** — nothing is being served there to report,
   which is why the badge exists. The app pods tolerate the node's unreachable/not-ready
   taints for 900 s, so the target stays registered-unhealthy for the whole window instead
   of gapping out at ~5 minutes when eviction would have deregistered it.
8. **Say what the aggregate does, before the audience does: it recovers on its own within
   about a minute.** Cross-zone routing stops sending to unhealthy targets as soon as the
   checks fail — no operator action involved. Do NOT narrate the shift as what restores
   availability; the chart will contradict you. The zonal shift here is the operator's
   **control move, not the recovery mechanism**: it makes the zone's removal
   deterministic, auditable and self-expiring instead of an emergent side effect of
   health-check timing — and it is what a real event's runbook would demand before the
   post-incident review asks "so what did you actually do?"
9. **Start the shift, then stop the fault.** Same mechanics as the gray beat: typed AZ
   name, live expiry countdown (default `15m`, matched to the fault), auto-cancel on
   stop. Power returns, the instances restart, targets re-register, the line climbs back
   to 100 within a few poll cycles.

**Under the hood, the things worth knowing when it misbehaves:** FIS selects the AZ by
**name** (`us-east-2a`); the shift's `awayFrom` takes the AZ **ID** (`use2-az1`), and the
name→ID mapping is account-specific — threaded from a live lookup at deploy and re-verified
post-deploy by `build/verify-zonal-shift-azs.py`, which also proves the NLB is opted in to
zonal shift. If the shift 409s with "not opted into zonal shift", the Service migration
(Step 8) did not land. If a fault dies seconds after starting with
"Target resolution returned empty set", the busiest AZ holds no **armed** instance —
re-arm and check the armed count covers all five nodes. If the brownout runs and the faulted
zone's line does NOT sag, read the real target-group health-check settings back
(`aws elbv2 describe-target-groups`) and check the p90 tile: the calibration assumes the live
2 s HTTP timeout (the LBC honors the `"2"` annotation, verified 2026-09-03) and a client
amplification of ~2.8×. A zone whose p90 sits under 2 s produces no sag by definition. Do
NOT expect target health to move either way — it never does at this severity, by design; the
brownout's Sources is the app record (`app.eks-mr-demo.internal`), resolved on
the node by dig at experiment start, so it also requires the private zone to resolve from
the nodes (it always has). The 2-minute subnet blip blackholes *everything* in the faulted
AZ's demo subnets — **including that zone's Aurora instance**, because the private-isolated
tier is shared by the nodes and the DB subnet group. Each regional member now runs a writer
plus two readers, one per AZ (2026-09-04), so this costs one instance and Aurora fails over
if it was the writer: expect a short write wobble on the aggregate, not a regional outage.
Before that change the cluster was a **single** instance, and a run that happened to pick
the writer's zone took all three AZs to 0.00% and was halted by the 50%
`ClientAvailabilityGuardrail` three minutes in — proven live 2026-09-04. If you see that
shape again, check the DB instance count per AZ first
(`aws rds describe-db-instances --query 'DBInstances[].[DBInstanceIdentifier,AvailabilityZone]'`).
One more consequence worth expecting: an Aurora failover briefly breaks writes, which is
exactly the trigger for the planted connection-pool defect, so a power-fault run can leave
writes parked around 68% until `build/restore-steady-state.sh --execute` cycles the pools.

A **written segment script** (the on-stage narrative beats) lives at
`docs/az-segment-script.md`.

---

## 5. Execute the failover

**Use the wrapper. Do not type the CLI call by hand.**

First get the plan ARN from the stack, never from a note:

```
aws cloudformation describe-stacks --stack-name $PROJECT_NAME-regionswitch --region us-east-2 \
  --query "Stacks[0].Outputs[?OutputKey=='PlanArn'].OutputValue" --output text
```

**The ARN changes whenever the plan is REPLACED rather than updated** — changing
`recoveryApproach` does exactly that, and it happened on 2026-08-26 (`:fwz3k0` became
`:72qy3c`). A stale ARN fails with a 404 that looks like a permissions problem. When a plan
is replaced, also re-check that its EKS replica sample is still trusted (section 2.0) before
relying on the scaling block.

```
bash build/arc-switch.sh activate us-west-2 <plan-arn>            # dry run, prints the call
bash build/arc-switch.sh activate us-west-2 <plan-arn> --execute
```

`activate <standby>` IS the failover: the plan is `activePassive` with a single `activate`
workflow, so bringing the standby up takes the primary out as one sequenced cutover. Fail
back by naming the other region. The wrapper **refuses** `deactivate` and prints this form,
because `StartPlanExecution` would otherwise reject it with no matching workflow after you
had already typed a failover command.

### Why the wrapper exists

`start-plan-execution` takes two regions that are **not the same thing**:

- `--target-region` — the semantic target. Per the CLI: *"the Region that traffic will be
  shifted to or **from**, depending on the action."*
- `--region` — the API endpoint.

ARC runs on a regional data plane and AWS is explicit: *"Region switch plans are executed
from the Region being **activated**. This design eliminates dependencies on the impacted
Region during the switch."*

For `activate` the two coincide. **For `deactivate` they are different regions** —
`deactivate --target-region us-east-2` means us-west-2 is being activated, so the call must
go to the **us-west-2** endpoint. The natural thing to type is `--region` equal to
`--target-region`, which for a deactivate points the call at the region you are abandoning:
in a real event, the impaired one. It is the single dependency the regional data plane exists
to remove, and it fails exactly when it matters and never in a practice run against a healthy
primary.

This demo's failover is a `deactivate` of the primary, so the trap is directly on the path.

### Watch from the regional data plane

There is **no approval gate** — execution runs straight through, so `start-plan-execution`
is itself the authorization. There are no automatic triggers, deliberately: with the gate
gone, that absence is the only thing preventing an unattended regional failover.

Read progress with `get-plan-execution --region <activating region>`, not the global
dashboard: *"if there are impairments in a Region, the global dashboard might not show all
your plan data... rely only on the Regional executions dashboard during operational events."*

The plan is **activePassive with ONE workflow**, and it pins no region: `StartPlanExecution`
requires `--action` and `--target-region`, so you choose the direction at run time.
Activating the standby deactivates the primary as one sequenced cutover, and failing back is
the same workflow naming the other region. There is no `deactivate` workflow — `arc-switch.sh`
rejects that verb with an explanation.

Block order is `scale-target-capacity` (EKSResourceScaling) → `switch-aurora-writer`
(AuroraGlobalDatabase) → `shift-dns-to-target` (Route53HealthCheck).
Capacity arrives **before** traffic shifts; that ordering is the point,
not an implementation detail.

---

## 6. Verify recovery — and verify the right things

Do **not** conclude success from the plan reporting success.

| Check | Why |
|---|---|
| The standby's replica count actually moved **2 → 4** | §1's failure mode is a scaling step that reports success having scaled nothing. |
| Karpenter provisioned nodes for replicas 3 and 4 | With `required` anti-affinity they cannot fit on the existing two. `kubectl get nodes -l karpenter.sh/nodepool`. |
| Argo CD still shows **Synced/Healthy**, and did not revert the replica count | This is goal 1. But it is only meaningful *after* the replica-count check above — "Argo did not revert" is equally true when nothing changed. |
| Availability recovers, and the **decision alarm clears** | The 99%/3-of-5 alarm is the signal an operator would act on. |
| **Writes recover, not just reads** — POST a new order and confirm it persists | Infrastructure recovery and application recovery are different claims. Every platform signal can be green while the application has not recovered. If writes do not come back, the fault is in the application, not the platform, and that is where to look. |
| The standby's app-health alarm transitions ALARM → OK | This is the measured recovery. |

**If the EKS scaling block fails:** with `minimumSuccessPercentage: 90`, three of four ready
is 75% and the block fails rather than shifting traffic onto a standby that cannot serve it.
That is correct behaviour. Look at pending pods and Karpenter's logs, then at vCPU quota.

**Measure the 2 → 4 duration on the first live run.** The block's `timeoutMinutes: 20` is
headroom, not a measurement. If the real path fits comfortably in a few minutes, bring it
down — an over-long timeout turns a genuine capacity failure into a long silent wait on
stage instead of a clear failed step.

---

## 7. Failback and teardown

```
bash build/arc-switch.sh activate us-east-2 <plan-arn>              # dry run first
```

Endpoint derivation flips automatically; that is the wrapper's job.

## 7b. Restore steady state (post-failover cleanup — do NOT skip this)

A failover deliberately leaves two things behind, and **nothing reverts them on its
own**: ARC patches the HPA with `scaleDown.selectPolicy: Disabled` ("during or after
the execution", per the developer guide — persistence is intentional), and the scaled-up
replica count therefore never comes back down. Live consequence (2026-08-27): two
failovers in one day ratcheted the app to 10 pods with scale-down off. The 24-hour
replica sample also inherits the inflated number, so the *next* failover over-scales —
that part self-heals 24 h after you restore steady state; the replica count itself
does not.

The cleanup is an operator script (same dry-run contract as `arc-switch.sh`):

```
bash build/restore-steady-state.sh                # dry run: prints what it would do
bash build/restore-steady-state.sh --execute      # starts one cleanup build per region
```

Per region (serially, fail-loud), via the in-VPC installer CodeBuild project:

1. `kubectl patch hpa` — revert `scaleDown.selectPolicy` to `Min` (the exact reverse of
   ARC's patch; **not** `minReplicas`, which ARC never touched). The re-enabled HPA then
   rightsizes each region on its own — no explicit scale command.
2. `kubectl rollout restart` — fresh pods, fresh DB connection pools. **This is also the
   remediation for the demo's planted write defect**, so run it only when the
   parked-at-75% diagnosis story is over.

Timing is entirely the operator's call — an hour or a day later is fine. Until it runs,
the write path stays degraded (poisoned pools) and scale-down stays disabled.

The third leftover cleans itself: the Karpenter **nodes** provisioned for the surge sit
empty once the HPA rightsizes pods away, and the NodePool reaps them (`WhenEmpty`,
`consolidateAfter: 5m`, one node per evaluation). Live consequence that motivated this
(2026-08-29): with the earlier `nodes: '0'` budget, eight empty nodes per region billed
indefinitely after a failover/restore cycle. Expect the node count to drift back to
baseline within ~10–20 minutes of the restore; `WhenEmpty` never evicts a node carrying
a pod, so this reaping cannot touch a live demo.

Design note: an ARC-native `postRecovery` workflow was built, deployed (plan v4) and
executed live on 2026-08-27, then deliberately removed — the judgment being that two
kubectl verbs of cleanup should not be coupled to ARC's execution model. Worth knowing
for customer conversations: the ARC feature exists (documented `postRecovery` workflow
action, `activeRegion`/`inactiveRegion` Lambda targeting, execution-id validation,
both-regions-healthy posture) and this demo can speak to it from live experience; this
repo simply chooses the script.

Teardown checklist:

1. Disarm injection (remove `ChaosAllowed` tags, stop any running experiment).
2. Reset the error-rate SSM parameter to `0` in both regions.
3. **Close `AllowedCidr`.**
4. Destroy stacks in reverse deploy order, or leave running — it is roughly **$0.66/hr**,
   about $3/day for a working day.

---

## 8. Failures that look like something else

| Symptom | Likely cause |
|---|---|
| Everything green, workload dead, `ImagePullBackOff` | Image not in the region's ECR, or the mirror pinned a digest that region does not hold. |
| Cross-region requests time out; peering, routes, DNS and health checks all green | NodePort ingress. The in-tree controller preserves client IP, so the node sees the *peer* CIDR as source. DNS resolves names; it does not move packets. |
| Availability alarm stuck in `INSUFFICIENT_DATA` forever | Nothing is emitting the metric names the alarm reads. Check the load generator's EMF output. |
| FIS experiment runs, injects nothing | No node SSM-registered, or no `ChaosAllowed` tag. The arming script fails loudly on the first; the second is silent. |
| Karpenter node joins EC2 but never appears as a Kubernetes Node | Missing `EC2_LINUX` access entry. Instances look healthy while pods stay Pending, which points at scheduling rather than authentication. |
| Injection appears to work but availability barely moves | Surge pods on Karpenter nodes not reading the knob. IMDS hop limit must be **2**; Karpenter's default of 1 blocks pods off the host network. |
| Plan evaluation fails, IAM looks correct | Wrong cluster access policy. It must be `AmazonARCRegionSwitchScalingPolicy`, not `AmazonEKSEditPolicy`. |
