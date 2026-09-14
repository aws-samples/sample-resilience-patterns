"""Status + Chaos Cockpit Lambda handler — PDD 2026-08-31-chaos-status-page, STEPS 0-4.

An ALB Lambda target. Routes:
  GET  /cockpit                 -> the single-page UI (ui.html)
  GET  /cockpit/api/status      -> JSON status aggregate (public AWS API reads)
  POST /cockpit/api/knob        -> set the L1 error-rate knob for one region   (Step 2)
  POST /cockpit/api/fis         -> arm / disarm / start / stop the gray failure (Step 3)
  POST /cockpit/api/failover    -> dry-run or execute the ARC Region switch     (Step 4)
  POST /cockpit/api/step        -> unstick a stuck execution step (skip / ungraceful)

EVERY WRITE REQUIRES A TYPED CONFIRMATION. That is UI friction, not the authorization —
the IAM grant plus the CFS gate on the front door are the real controls. The plan itself
carries no approval gate, so `StartPlanExecution` succeeding IS the authorization.

DESIGN NOTES
- Active region is DERIVED FROM OBSERVED TRAFFIC (RegionSuccess/RegionError per Region),
  not from a DNS or HTTP probe — see _region_traffic's docstring for why neither can
  answer the question here.
- All AWS metrics/EMF land in PRIMARY_REGION (single load generator), so CloudWatch reads
  target PRIMARY_REGION regardless of where this Lambda runs. FIS templates and node
  tagging are primary-only for the same structural reason.
- RUNTIME ARN DISCOVERY: the ARC plan, knob names, FIS template ids, cluster and node
  group names are resolved from stack outputs (Step 5 replaces this with threaded
  CfnParameters). Every READ degrades gracefully: a tile that cannot be read returns
  {"available": false, "note": ...} rather than failing the whole status call. WRITES do
  the opposite and fail loudly — a write that silently did nothing is the worst outcome
  here, since it looks like a working control that injected nothing.
- ALB target response shape: {statusCode, statusDescription, isBase64Encoded, headers, body}.
"""
import http.client
import json
import os
import re
import time
import urllib.request

import boto3
from botocore.config import Config

# Module-scope clients with explicit timeouts — a hanging control-plane call must fail
# fast, well inside the 29s Lambda / ALB budget, so a degraded tile never hangs the page.
_CFG = Config(connect_timeout=2, read_timeout=4, retries={"max_attempts": 2})

APP_ID = os.environ["APP_ID"]
PRIMARY_REGION = os.environ["PRIMARY_REGION"]
STANDBY_REGION = os.environ["STANDBY_REGION"]
METRIC_NAMESPACE = os.environ.get("METRIC_NAMESPACE", "MyResilienceDemo")

# ── The Az-dimensioned availability family (D1) — READER SIDE ─────────────────────────
#
# These are declared HERE, as literals, on purpose. The authority is the TypeScript
# constant in constructs/observability/metric-namespace.ts, and the emitter reads its own
# copy from src/locust/az_metrics.py — but this file CANNOT import that module. The Lambda
# asset is `lambda.Code.fromAsset(.../'lambda')`: this directory and nothing else, so
# nothing under src/locust/ is on sys.path here. `import az_metrics` would pass synth and
# every local test, then raise ModuleNotFoundError on the first invocation (D7b).
#
# So three files hold these names, and the control is a DERIVED CONTRACT TEST — 'the Az
# metric-name contract' in test/topology.test.ts — which parses all three and asserts they
# agree. Nothing type-checks a CloudWatch metric string: spell it AZSuccess here and the
# code compiles, the stack deploys green, and the AZ chart lines are permanently empty,
# which reads as a broken load generator rather than a naming bug.
#
# Declared before the query code that uses them (Step 4 of the plan) so the contract test
# has all three sides from the moment it exists. A two-sided test would pass while THIS
# side — the chart reader — was wrong, which is worse than no test at all (D7c).
AZ_DIMENSION = "Az"
AZ_SUCCESS = "AzSuccess"
AZ_ERROR = "AzError"
AZ_LATENCY = "AzLatency"
# Non-error AND within AZ_SLO_MS -- the numerator of the client-perceived availability
# chart (2026-09-03). Classified at EMIT time (locust cannot be asked after the fact, and
# CloudWatch metric math has no "count of datapoints above X", so a breach count cannot be
# derived from the AzLatency percentiles). This side only READS it and prints the threshold
# as the chart's axis label -- which is why the threshold is in the contract test too: a
# divergence here produces a chart labelled with a definition the data was not built with.
AZ_SLO_SUCCESS = "AzSloSuccess"
AZ_SLO_MS = 2000

_cw = boto3.client("cloudwatch", region_name=PRIMARY_REGION, config=_CFG)
# The replica reporters publish to their OWN region's CloudWatch (a regional VPC
# interface endpoint serves only its own region), so the replicas tile reads BOTH.
_cw_standby = boto3.client("cloudwatch", region_name=STANDBY_REGION, config=_CFG)
_CW = {PRIMARY_REGION: _cw, STANDBY_REGION: _cw_standby}
_rds = boto3.client("rds", region_name=PRIMARY_REGION, config=_CFG)
_ssm_primary = boto3.client("ssm", region_name=PRIMARY_REGION, config=_CFG)
_ssm_standby = boto3.client("ssm", region_name=STANDBY_REGION, config=_CFG)
_arc = boto3.client("arc-region-switch", region_name=PRIMARY_REGION, config=_CFG)

# Write-path clients (Steps 2-4). FIS and EC2 tagging are PRIMARY-REGION ONLY because the
# experiment templates are primary-only (region-stack.ts) — tagging standby nodes would
# arm nothing while still being a write.
_fis = boto3.client("fis", region_name=PRIMARY_REGION, config=_CFG)
_ec2 = boto3.client("ec2", region_name=PRIMARY_REGION, config=_CFG)
_eks = boto3.client("eks", region_name=PRIMARY_REGION, config=_CFG)
_asg = boto3.client("autoscaling", region_name=PRIMARY_REGION, config=_CFG)

_SSM = {PRIMARY_REGION: _ssm_primary, STANDBY_REGION: _ssm_standby}

# ── STEP 5: threaded configuration, NOT runtime discovery ────────────────────────────
#
# These were resolved at cold start via cloudformation:DescribeStacks. They now arrive as
# CfnParameters threaded through the dotenv rail, which let the role DROP that grant —
# ARCC's privilege-escalation guidance documents PassRole + CreateStack + DescribeStacks as
# an escalation chain, and this role held two of the three.
#
# EVERY ONE IS REQUIRED, deliberately: os.environ[...] raises at import if the deploy did
# not supply it, so the Lambda fails immediately and loudly. The alternative — .get() with
# a default — produces a cockpit that renders fine and whose controls quietly address the
# wrong resource, or nothing at all.
PLAN_ARN = os.environ["PLAN_ARN"]
PRIMARY_CLUSTER_NAME = os.environ["PRIMARY_CLUSTER_NAME"]
# Tolerate BOTH the bare name and the CloudFormation `<cluster>/<nodegroup>` physical id.
# The region stack now emits the bare name, but this crosses a stack boundary and the EKS
# API rejects the composite form outright ("nodegroup name parameter contains invalid
# characters" — hit live 2026-09-01 with every stack green). Normalizing here means a
# regression in the producer degrades to nothing rather than breaking arming.
PRIMARY_NODE_GROUP_NAME = os.environ["PRIMARY_NODE_GROUP_NAME"].rsplit("/", 1)[-1]
KNOB_PARAM = {
    PRIMARY_REGION: os.environ["PRIMARY_KNOB_PARAM"],
    STANDBY_REGION: os.environ["STANDBY_KNOB_PARAM"],
}
# STEP 10 — the zonal-shift control. Both REQUIRED (same fail-at-import rule as above).
# StartZonalShift.awayFrom takes an AZ **ID** (use2-az1); everything else in this file
# speaks AZ **NAMES** (us-east-2a). The mapping is account-specific and threaded from the
# region stack's live DescribeAvailabilityZones as explicit name=id pairs — a dict here,
# so no consumer ever correlates two lists by index (bug class 19). NEVER derive an ID
# from a name by string rule; the post-deploy verifier proves this map against the live
# account and fails the deploy on divergence.
APP_NLB_ARN = os.environ["APP_NLB_ARN"]
AZ_NAME_TO_ID = dict(
    p.split("=", 1) for p in os.environ["AZ_NAME_ID_PAIRS"].split(",") if "=" in p
)
AZ_ID_TO_NAME = {v: k for k, v in AZ_NAME_TO_ID.items()}
# The CloudWatch `LoadBalancer` dimension value is the ARN suffix after ":loadbalancer/"
# (`net/<name>/<id>`) — the same derivation the zonal-shift resource identifier uses.
_NLB_LB_DIM = APP_NLB_ARN.partition(":loadbalancer/")[2]
_azs = boto3.client("arc-zonal-shift", region_name=PRIMARY_REGION, config=_CFG)


def _reconcile_nlb_az(label):
    """An NLB metric AZ label reconciled to the pod-emitted AZ-NAME vocabulary, or None.

    THE LOAD-BEARING CONTRACT (design D5). The per-AZ chart's keys now come from the NLB
    metric's ``AvailabilityZone`` dimension while ``_faulted_az`` speaks AZ NAMES — the
    highlight comparison ``faultedAz === az`` in ui.html is only meaningful if both sides
    use one vocabulary. Live-verified 2026-09-02 that THIS NLB emits zone names, so today
    this is an identity map — but an ELB metrics change to zone IDs would otherwise
    silently unhighlight the faulted line with everything still green (the exact failure
    class hit four times on 2026-09-02).

    Membership in the threaded name=id map, never a string rule (bug class 19): the map is
    built from the region stack's live DescribeAvailabilityZones and covers every AZ the
    subnets span. Unknown labels are DROPPED — a chart key the highlight can never match
    is worse than a missing line.
    """
    if label in AZ_NAME_TO_ID:
        return label
    return AZ_ID_TO_NAME.get(label)


def _nlb_chart_azs():
    """``{azName: targetGroupDim}`` for the app NLB's per-AZ target-health metrics.

    Discovery for the CHART ONLY — AZ eligibility for fault selection stays on the
    pod-emitted Az traffic totals (design D4: fault where traffic IS, not where a target
    merely exists). Discovered per poll rather than threaded because the TargetGroup
    dimension value carries an LBC-generated hash that changes if the Service is ever
    recreated (it was, live, during the LBC migration).

    ListMetrics is filtered by the LoadBalancer dimension so only THIS NLB's metrics
    return — one target group and three AZs in practice, far under one page, so no token
    walk. Metrics WITHOUT an AvailabilityZone dimension (the aggregate rollup series) are
    skipped. Namespace is AWS/NetworkELB, published by the AWS-managed LB nodes: it keeps
    emitting for a dark AZ (surviving-AZ nodes report its targets unhealthy), which is the
    entire reason the chart moved here — the pod-emitted family goes to NO-DATA when the
    AZ's instances stop, and the line vanishes instead of diving.

    Never raises: an empty dict degrades the chart to its aggregate lines.
    """
    try:
        r = _cw.list_metrics(
            Namespace="AWS/NetworkELB",
            MetricName="HealthyHostCount",
            Dimensions=[{"Name": "LoadBalancer", "Value": _NLB_LB_DIM}],
        )
        out = {}
        for m in r.get("Metrics", []):
            dims = {d["Name"]: d["Value"] for d in m.get("Dimensions", [])}
            label, tg = dims.get("AvailabilityZone"), dims.get("TargetGroup")
            if not label or not tg:
                continue  # the no-AZ aggregate series
            az = _reconcile_nlb_az(label)
            if az:
                out[az] = tg
        return out
    except Exception:  # noqa: BLE001 — chart degrades, page never fails
        return {}

# ARC executes from the region being ACTIVATED — the plan runs on a regional data plane
# precisely so the switch does not depend on the region being evacuated. So a failover to
# region R must call the R endpoint (build/arc-switch.sh documents the trap at length).
_ARC_BY_REGION = {
    PRIMARY_REGION: _arc,
    STANDBY_REGION: boto3.client("arc-region-switch", region_name=STANDBY_REGION, config=_CFG),
}

# The three faults the region stack ships templates for, with their per-AZ template ids
# threaded in. THE MENU CARRIES ONLY FAULTS PROVEN TO MOVE THE GRAPH. Every entry here is
# an implicit promise that starting it can force a failover decision, so a fault that cannot
# is worse than a missing one -- it wastes the operator's time mid-demo and teaches the wrong
# lesson about the signal.
#
# Both flags were established by live measurement on 2026-09-01, and one fault was REMOVED
# outright after two failed attempts to make it work:
#
#   latency     True. At the construct default of 100ms it genuinely could not move
#               availability (reads 97 -> 1,325ms, ZERO errors) because a slow request still
#               succeeds. Delay is amplified ~12.3x by the database round trips per read, so
#               region-stack.ts injects 400ms, putting the amplified p90 just under the 5s
#               read timeout: the slow tail crosses and fails, the rest does not.
#   packet-loss True. 10% was absorbed COMPLETELY by TCP retransmission (zero errors); now
#               25%, which threatens both the 3s connect and 5s read timeouts stochastically.
#
# REMOVED -- cpu-stress, then its replacement memory-stress. cpu-stress ran at the SSM
# document's maximum (CPU=0 all stressors, LoadPercent=100) and moved nothing. memory-stress
# replaced it and ALSO moved nothing: started 16:22:44 UTC at Percent=85 on 8GiB nodes, and
# over five minutes availability stayed 100.0% with read p90 flat at 96ms, no pod eviction,
# no node instability. FIS delivered both commands (SSM InProgress), so it was not a plumbing
# failure. Two explanations remain and were NOT distinguished: the kernel OOM killer takes
# stress-ng (the node's largest allocator) before the kubelet reports MemoryPressure, or
# stress-ng cannot install at all -- these nodes have no NAT and no internet route, and
# InstallDependencies must fetch it from a package repo, which is also why the network faults
# work (tc ships with AL2023 and needs no download). If it is the latter, NO stress-based
# fault can work in this VPC without pre-baking the binary into the AMI.
#
# The FIS construct still BUILDS the templates, so nothing is lost and re-enabling is a
# one-line change once a stressor is proven to run here. Only the menu is honest.
FAULTS = {
    "packet-loss": {"env": "FIS_PACKET_LOSS_TEMPLATE_IDS", "availability": True},
    "latency": {"env": "FIS_LATENCY_TEMPLATE_IDS", "availability": True},
    # SINGLE-AZ variants. SEPARATE MENU ENTRIES rather than a modifier on the region-wide
    # ones: the two have different blast radii, different expected chart shapes and different
    # mitigations, and a checkbox on one entry would let an operator start "latency" without
    # knowing which they got.
    #
    # Same severity values as the region-wide faults (400ms / 25%) -- reused deliberately, so
    # there is one set of numbers to defend rather than two calibrations. Diluted across three
    # AZs the aggregate lands ~96-97%, below the 99% decision alarm and far above the 50%
    # guardrail that self-terminated the 500ms experiment.
    "latency-single-az": {"env": "FIS_LATENCY_TEMPLATES_BY_AZ",
                          "availability": True, "singleAz": True},
    "packet-loss-single-az": {"env": "FIS_PACKET_LOSS_TEMPLATES_BY_AZ",
                              "availability": True, "singleAz": True},
    # THE AZ IMPAIRMENT (2026-09-02). The network faults above degrade one AZ and the app
    # produces no ERRORS -- but see their note: on the client-perceived measure
    # latency-single-az is the most severe fault here (22.7%), so "the app rides them out"
    # is an error-rate claim, not an availability claim. This one stops the AZ's instances
    # (modeled on the FIS AZ Power Interruption scenario, autoshift action stripped by
    # construction): pods stop reporting, the faulted zone's SLO line GAPS rather than
    # diving, the target-health badge drops, and the right tool is the operator's zonal
    # shift. Genuinely zonal only since each Aurora member runs one instance per AZ
    # (2026-09-04) -- its 2-minute subnet blackhole also cuts that zone's database, and
    # with the single-instance cluster it replaced, hitting the writer's zone took the
    # whole region to 0.00% and tripped the 50% guardrail. Same armed-nodes interlock: the
    # stop action targets ChaosAllowed=true, so the generic armed==0 refusal below covers
    # it.
    "power-interruption-single-az": {"env": "FIS_POWER_TEMPLATES_BY_AZ",
                                     "availability": True, "singleAz": True},
    # THE GRAY BEAT (2026-09-02; recalibrated 2026-09-03, flap claim RETRACTED 2026-09-04).
    # Same latency document as latency-single-az, aimed at the pod<->NLB path instead of
    # the database. Health checks DO NOT FLAP and cannot: the check pays ONE shaped hop, so
    # at 800ms +/- 400ms its RTT tops out ~1.24s against the live 2s timeout -- 3/3 targets
    # stayed healthy through both live runs, with zero errors. The client pays ~2.8 hops:
    # p90 ~2,240ms, which puts the faulted zone at ~66% client-perceived availability while
    # the other two hold at 100%. A flap would need ~1,800-2,000ms of delay, which pushes
    # client p90 past the app's 5s read timeout -- flapping checks and surviving clients are
    # mutually exclusive. Nothing stops, nothing evicts, no line snaps to 0: degradation
    # with a judgment call, and the platform's own verdict stays green while it happens.
    # Same armed-nodes interlock and busiest-AZ selection as the other single-AZ faults.
    "brownout-single-az": {"env": "FIS_BROWNOUT_TEMPLATES_BY_AZ",
                           "availability": True, "singleAz": True},
}


def _template_ids(fault):
    """Per-AZ template ids for one fault, from the threaded CSV."""
    return [i for i in (os.environ.get(FAULTS[fault]["env"]) or "").split(",") if i]


def _templates_by_az(fault):
    """``{az: templateId}`` for a single-AZ fault, parsed from the threaded az=id pairs.

    The pairs are built beside the template-creation loop (FisNetworkExperiments.templatesByAz)
    and threaded as CfnOutput -> CfnParameter -> env. Parsed by NAME here, never by position:
    selecting a template by list index would inject into a different AZ than the operator was
    told about -- the fault reports success and a different line moves on the chart.

    Never raises: a malformed pair is skipped rather than breaking the status poll.
    """
    out = {}
    for pair in (os.environ.get(FAULTS[fault]["env"]) or "").split(","):
        if "=" not in pair:
            continue
        az, _, tid = pair.partition("=")
        az, tid = az.strip(), tid.strip()
        if az and tid:
            out[az] = tid
    return out


def _fault_already_running():
    """The id of a non-terminal FIS experiment, or ``None``.

    THE INTERLOCK, AUTHORED. An earlier docstring on ``_do_fis`` asserted that mixing faults was
    refused; nothing enforced it, and that prose was read as behaviour and repeated as a safety
    property this demo did not have. Two concurrent faults make the resulting availability
    number impossible to attribute, which is the one thing the chart exists to support.

    SCOPED TO FIS EXPERIMENTS ONLY, and that scope is the design rather than an oversight: an ARC
    zonal shift is ``arc-zonal-shift:StartZonalShift``, not an FIS experiment, so it is invisible
    to ``list_experiments``. Fault-then-shift-then-recover -- the entire AZ demo beat -- stays
    permitted BY CONSTRUCTION, with no special case to get wrong.
    """
    try:
        for e in _fis.list_experiments(maxResults=20).get("experiments", []):
            if (e.get("state") or {}).get("status") in ("pending", "initiating", "running"):
                return e["id"]
    except Exception:  # noqa: BLE001 — a failed check must not block a legitimate start
        return None
    return None


def _faulted_az():
    """The AZ a running single-AZ experiment is degrading, or ``None``.

    Derived from the RUNNING experiment's template id matched back against the threaded pairs --
    not from anything the UI passed in, so it survives a page reload and reports what is
    actually happening rather than what was last requested.
    """
    try:
        for e in _fis.list_experiments(maxResults=20).get("experiments", []):
            if (e.get("state") or {}).get("status") not in ("pending", "initiating", "running"):
                continue
            tid = e.get("experimentTemplateId")
            for fault, meta in FAULTS.items():
                if not meta.get("singleAz"):
                    continue
                for az, template in _templates_by_az(fault).items():
                    if template == tid:
                        return az
    except Exception:  # noqa: BLE001
        return None
    return None

_HERE = os.path.dirname(__file__)
with open(os.path.join(_HERE, "ui.html"), encoding="utf-8") as _f:
    _UI_HTML = _f.read()


def _resp(status, body, content_type="application/json"):
    is_json = content_type == "application/json"
    # statusDescription MUST be "<code> <reason-phrase>". A bare "400" is a MALFORMED
    # response to the ALB, which discards the whole thing and serves its own 502 HTML
    # page — so every non-200 this handler ever returned reached the browser as
    # "Unexpected token '<' ... is not valid JSON", hiding the real error. Found live
    # 2026-09-01: the Lambda logged clean 1.7ms invocations while the client saw 502.
    # The stub-server UI test accepted any dict; the real ALB is the strict consumer.
    reason = http.client.responses.get(status, "Error")
    return {
        "statusCode": status,
        "statusDescription": f"{status} {reason}",
        "isBase64Encoded": False,
        "headers": {"content-type": content_type, "cache-control": "no-store"},
        "body": json.dumps(body) if is_json else body,
    }


def _aurora_writer_region():
    try:
        gcs = _rds.describe_global_clusters().get("GlobalClusters", [])
        for gc in gcs:
            for m in gc.get("GlobalClusterMembers", []):
                if m.get("IsWriter"):
                    # arn:aws:rds:<region>:acct:cluster:name -> region is field 3
                    return {"available": True, "region": m["DBClusterArn"].split(":")[3]}
        return {"available": False, "note": "no writer member found"}
    except Exception as exc:  # noqa: BLE001 - degrade this tile, never fail the page
        return {"available": False, "note": f"rds read failed: {exc}"}


def _knob(client, region):
    name = KNOB_PARAM[region]
    try:
        v = client.get_parameter(Name=name)["Parameter"]["Value"]
        return {"available": True, "param": name, "rate": int(v)}
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "param": name, "note": str(exc)}


def _discover_azs(recently_active=True):
    """AZ dimension values currently present on the Az family, newest data first.

    The handler CANNOT know these ahead of time: they are whichever AZs the scheduler
    actually placed pods in, which changes on any rollout. So they are discovered rather
    than threaded.

    ``RecentlyActive="PT3H"`` is a documented ListMetrics filter meaning "had data points in
    the past three hours". That is also precisely the question D3's AZ eligibility asks, so
    the same call serves both the chart and fault selection.

    Chosen over a GetMetricData SEARCH expression on purpose: SEARCH needs no extra IAM
    action, but the format of the labels it returns is undocumented, and parsing an
    undocumented identifier format is exactly how this project lost a day once
    (AGENTS.md bug class 18). ListMetrics has a documented response shape.

    Never raises: an empty list degrades the chart to the aggregate lines it already had.
    """
    try:
        kwargs = {
            "Namespace": METRIC_NAMESPACE,
            "MetricName": AZ_SUCCESS,
            "Dimensions": [{"Name": AZ_DIMENSION}],
        }
        if recently_active:
            kwargs["RecentlyActive"] = "PT3H"
        azs = set()
        token = None
        # Bounded page walk. Three AZs in practice; the cap exists so a surprising response
        # cannot turn a status poll into a long-running call.
        for _ in range(5):
            if token:
                kwargs["NextToken"] = token
            r = _cw.list_metrics(**kwargs)
            for m in r.get("Metrics", []):
                for d in m.get("Dimensions", []):
                    if d.get("Name") == AZ_DIMENSION and d.get("Value"):
                        azs.add(d["Value"])
            token = r.get("NextToken")
            if not token:
                break
        # "unknown" is a real emitted value (the loadgen's exception path, and any response
        # missing the az field during a rollout). It is legitimate ON THE CHART but must never
        # be offered as a FAULT TARGET, so it is filtered where selection happens, not here.
        return sorted(azs)
    except Exception:  # noqa: BLE001 — a degraded chart must not break the status poll
        return []


def _az_traffic_totals(minutes=15):
    """Requests each AZ has served recently: ``{az: total}``, descending by total.

    THIS IS AZ ELIGIBILITY (decision D3). An AZ is a valid fault target if it has SERVED
    TRAFFIC recently -- ``Sum(AzSuccess + AzError)`` over the window.

    WHY TRAFFIC AND NOT POD COUNT. The obvious test is "does this AZ have a pod", but that
    needs a pod ``list`` plus a CLUSTER-SCOPED node read to resolve each pod's
    ``topology.kubernetes.io/zone`` label -- a ClusterRole granting the reporter cluster-wide
    node visibility to answer one question. Traffic needs no new RBAC at all, because the
    metric family this feature already adds carries the answer.

    It is also MORE CORRECT. Fault selection wants an AZ whose degradation will move the
    graph. A pod-count test would happily select an AZ holding an idle pod, where the fault
    injects cleanly, reports success, and changes nothing measurable -- the "reports success,
    injected nothing" failure this project keeps hitting (AGENTS.md bug class 22).

    THE TRADE-OFF IS DELIBERATE: with the load generator stopped, no AZ has served traffic and
    NOTHING is eligible. The correct behaviour there is to refuse with a stated reason rather
    than pick an AZ anyway -- see ``_eligible_fault_az``.

    ``"unknown"`` is excluded: it is a real emitted value (the loadgen's exception path, and
    any response missing the az field mid-rollout) and belongs on the chart, but it is not an
    AZ and FIS could not target it.

    Never raises: eligibility must degrade to "cannot determine" rather than break the poll.
    """
    import datetime as dt
    azs = [a for a in _discover_azs() if a != "unknown"]
    if not azs:
        return {}
    end = dt.datetime.utcnow().replace(second=0, microsecond=0)
    start = end - dt.timedelta(minutes=minutes)
    try:
        queries = []
        for i, az in enumerate(azs):
            for metric in (AZ_SUCCESS, AZ_ERROR):
                queries.append({
                    "Id": f"elig{i}_{metric.lower()}",
                    "MetricStat": {
                        "Metric": {
                            "Namespace": METRIC_NAMESPACE,
                            "MetricName": metric,
                            "Dimensions": [{"Name": AZ_DIMENSION, "Value": az}],
                        },
                        # ONE datapoint over the whole window, not per-minute: this is a
                        # yes/no question about recent traffic, and a coarse period keeps the
                        # call cheap on a 5-second poll.
                        "Period": max(60, minutes * 60),
                        "Stat": "Sum",
                    },
                    "ReturnData": True,
                })
        r = _cw.get_metric_data(
            MetricDataQueries=queries, StartTime=start, EndTime=end,
            ScanBy="TimestampAscending",
        )
        sums = {m["Id"]: sum(m.get("Values") or []) for m in r["MetricDataResults"]}
        totals = {}
        for i, az in enumerate(azs):
            total = (sums.get(f"elig{i}_{AZ_SUCCESS.lower()}", 0.0)
                     + sums.get(f"elig{i}_{AZ_ERROR.lower()}", 0.0))
            if total > 0:
                totals[az] = total
        return dict(sorted(totals.items(), key=lambda kv: kv[1], reverse=True))
    except Exception:  # noqa: BLE001
        return {}


def _eligible_fault_az():
    """``(az, reason)``: the AZ to fault, or ``(None, reason)`` explaining the refusal.

    Refusing WITH A STATED REASON is the designed behaviour, not a fallback. A control that
    silently picks something when it cannot tell is how "the fault reported success and
    injected nothing" happens; a control that fails blank is indistinguishable from a broken
    cockpit. Both are worse than saying why.

    Selects the BUSIEST eligible AZ so the fault has the largest visible effect on the chart.
    """
    totals = _az_traffic_totals()
    if not totals:
        return None, (
            "no AZ has served traffic in the last 15 minutes — start the load generator "
            "first, or an AZ fault would inject cleanly and change nothing measurable"
        )
    az = next(iter(totals))
    return az, f"{az} served {int(totals[az])} requests in the last 15 minutes"


def _availability_series(minutes=45):
    """Per-minute read/write availability for the cockpit's line chart.

    The tiles show a 5-minute rolling ratio, which is the right number to READ but a poor
    thing to WATCH: an operator cannot tell a sag that is deepening from one that is already
    recovering, and that is exactly the judgement a failover decision turns on. One
    GetMetricData call with Period=60 gives the shape.

    Returned as parallel arrays rather than objects per point -- this crosses an ALB with a
    1MB response cap and gets polled every 5s, so the compact form is deliberate. A minute
    with no traffic yields None (not 100) so the chart can show a real gap instead of
    inventing a healthy datapoint.
    """
    import datetime as dt
    end = dt.datetime.utcnow().replace(second=0, microsecond=0)
    start = end - dt.timedelta(minutes=minutes)

    def q(op, metric):
        return {
            "Id": f"{op}_{metric.lower()}",
            "MetricStat": {
                "Metric": {
                    "Namespace": METRIC_NAMESPACE,
                    "MetricName": metric,
                    "Dimensions": [{"Name": "Op", "Value": op}],
                },
                "Period": 60,
                "Stat": "Sum",
            },
            "ReturnData": True,
        }

    # Per-AZ TARGET-HEALTH queries ride the SAME GetMetricData call, so every AZ line
    # shares the aggregate lines' timestamp grid exactly. Two calls could straddle a
    # minute boundary and produce series of different lengths, which the chart would
    # render as AZ lines offset from the aggregate -- reading as a data problem rather
    # than a rendering one.
    #
    # SOURCE MOVED (2026-09-02) from the pod-emitted Az family to the NLB's per-AZ
    # HealthyHostCount/UnHealthyHostCount. The pod family is emitted BY the pods, so the
    # honest AZ faults (power interruption stops the AZ's instances) silence it: the line
    # goes to NO-DATA and vanishes instead of diving. The NLB metrics are published by the
    # AWS-managed LB nodes and survive the AZ going dark. What the chart MEASURES changed
    # with the source — per-AZ target health, not request availability — and the axis
    # label in ui.html says so (design D2).
    az_tgs = _nlb_chart_azs()
    azs = sorted(az_tgs)

    def az_q(az, metric, idx):
        # Ids must be valid identifiers: an AZ name contains hyphens, so index instead of
        # sanitising the name (a sanitiser that collapsed two names to one Id would silently
        # merge two AZ lines).
        return {
            "Id": f"az{idx}_{metric.lower()}",
            "MetricStat": {
                "Metric": {
                    "Namespace": "AWS/NetworkELB",
                    "MetricName": metric,
                    "Dimensions": [
                        {"Name": "LoadBalancer", "Value": _NLB_LB_DIM},
                        {"Name": "TargetGroup", "Value": az_tgs[az]},
                        {"Name": "AvailabilityZone", "Value": az},
                    ],
                },
                "Period": 60,
                # Maximum, per the NLB metrics doc's own guidance for HealthyHostCount /
                # UnHealthyHostCount. Sum would multiply by however many LB nodes reported.
                "Stat": "Maximum",
            },
            "ReturnData": True,
        }

    def lat_q(az, idx):
        # LATENCY BY AZ: client-observed p90 request latency keyed by the SERVING pod's AZ.
        # Rendered as NUMERIC TILES rather than a chart since 2026-09-03 -- the SLO chart
        # carries the shape, and a latency axis invited comparing a client number against
        # the health-check timeout, which is how the retracted "flap" story survived so
        # long. Magnitude still matters on stage: this is the ~95ms -> ~2,240ms move that
        # the brownout's 66% sag is made of.
        #
        # Source is the loadgen-emitted AzLatency family, NOT an NLB flow metric: NLB
        # per-AZ metrics are keyed to the LB-NODE's AZ, which under cross-zone routing is
        # not the serving pod's AZ -- the wrong dimension for "which zone is slow". The
        # emitters survive a brownout BY CONSTRUCTION (nothing is stopped or evicted);
        # under the BLACK fault they die with the AZ and this line gaps to no-data, which
        # is honest -- that beat belongs to the target-health card.
        #
        # Stat p90 is verified queryable live (phase3 R3: Complete datapoints, baseline
        # 88-95ms/AZ). The vocabulary is zone NAMES (us-east-2a...), same as the NLB
        # dimension and _faulted_az (R5), so reusing `azs` and the highlight contract is
        # safe by construction.
        return {
            "Id": f"azlat{idx}",
            "MetricStat": {
                "Metric": {
                    "Namespace": METRIC_NAMESPACE,
                    "MetricName": AZ_LATENCY,
                    "Dimensions": [{"Name": AZ_DIMENSION, "Value": az}],
                },
                "Period": 60,
                "Stat": "p90",
            },
            "ReturnData": True,
        }

    #: Query-id prefix per pod-emitted counter. Declared once: these ids are what the
    #: response is keyed off below, so deriving them at two sites is how a rename produces
    #: an empty line rather than an error.
    client_ids = {AZ_SLO_SUCCESS: "azslo", AZ_SUCCESS: "azsucc", AZ_ERROR: "azerr"}

    def client_q(az, metric, idx):
        # CLIENT-PERCEIVED AVAILABILITY BY AZ (2026-09-03) -- the cockpit's business line.
        # Definition: AzSloSuccess / (AzSuccess + AzError), i.e. non-error AND answered
        # within AZ_SLO_MS, over everything attempted in that zone.
        #
        # Stat=Sum because these are COUNTS. Average would return the per-minute mean of a
        # 1/0 series -- already a ratio -- which the division below would then compute a
        # ratio OF, yielding a number that moves in the right direction and is wrong.
        #
        # Pod-emitted, so it measures what the CUSTOMER got, which is the entire point: the
        # NLB's own verdict is on the target-health card and under a brownout the two
        # DISAGREE. It also means the series shares the black fault's honest weakness --
        # stop the instances and there is no emitter left, so the line gaps rather than
        # diving. That beat belongs to the target-health card, which is infra-sourced and
        # survives.
        return {
            "Id": f"{client_ids[metric]}{idx}",
            "MetricStat": {
                "Metric": {
                    "Namespace": METRIC_NAMESPACE,
                    "MetricName": metric,
                    "Dimensions": [{"Name": AZ_DIMENSION, "Value": az}],
                },
                "Period": 60,
                "Stat": "Sum",
            },
            "ReturnData": True,
        }

    try:
        r = _cw.get_metric_data(
            MetricDataQueries=(
                [q(o, m) for o in ("read", "write") for m in ("OpSuccess", "OpError")]
                + [az_q(az, m, i) for i, az in enumerate(azs)
                   for m in ("HealthyHostCount", "UnHealthyHostCount")]
                + [lat_q(az, i) for i, az in enumerate(azs)]
                + [client_q(az, m, i) for i, az in enumerate(azs)
                   for m in (AZ_SLO_SUCCESS, AZ_SUCCESS, AZ_ERROR)]
            ),
            StartTime=start, EndTime=end, ScanBy="TimestampAscending",
        )
        by_id = {m["Id"]: dict(zip(m["Timestamps"], m["Values"]))
                 for m in r["MetricDataResults"]}
        stamps = sorted({t for d in by_id.values() for t in d})
        out = {"available": True, "minutes": [t.strftime("%H:%M") for t in stamps],
               "read": [], "write": []}
        for op in ("read", "write"):
            succ, err = by_id.get(f"{op}_opsuccess", {}), by_id.get(f"{op}_operror", {})
            for t in stamps:
                s, e = succ.get(t, 0.0), err.get(t, 0.0)
                out[op].append(round(100.0 * s / (s + e), 1) if s + e else None)

        # Per-AZ lines: {"us-east-2a": [pct|None, ...]} on the SAME timestamp grid — the
        # per-AZ TARGET-HEALTH fraction, 100 * healthy / (healthy + unhealthy). A minute
        # where the AZ has NO registered targets renders as a gap (None), never as 0%:
        # zero targets is "nothing to report", and inventing a red datapoint there would
        # make a quiet AZ read as a dead one. This is what makes the single-AZ story
        # visible rather than inferred — under a power interruption the faulted AZ's
        # targets go unhealthy (reported by the SURVIVING AZs' LB nodes, so the line dives
        # instead of vanishing) while the other two hold at 100.
        az_out = {}
        for i, az in enumerate(azs):
            healthy = by_id.get(f"az{i}_healthyhostcount", {})
            unhealthy = by_id.get(f"az{i}_unhealthyhostcount", {})
            pts = []
            for t in stamps:
                h, u = healthy.get(t, 0.0), unhealthy.get(t, 0.0)
                pts.append(round(100.0 * h / (h + u), 1) if h + u else None)
            az_out[az] = pts
        out["az"] = az_out
        # Latency lines on the SAME grid. A minute the AZ emitted nothing is a None GAP,
        # never 0 -- 0ms would read as "instant", the exact inverse of a browned-out zone.
        lat_out = {}
        for i, az in enumerate(azs):
            vals = by_id.get(f"azlat{i}", {})
            lat_out[az] = [round(vals[t], 1) if t in vals else None for t in stamps]
        out["latencyAz"] = lat_out

        # CLIENT-PERCEIVED AVAILABILITY BY AZ. A zone that attempted NOTHING this minute is
        # a None GAP, never 0: zero attempts is "we cannot tell", and drawing 0% there would
        # report a quiet zone as a failing one -- the same rule the other two per-AZ series
        # already follow, kept identical so all three read as one instrument.
        client_out = {}
        for i, az in enumerate(azs):
            ok = by_id.get(f"azslo{i}", {})
            succ = by_id.get(f"azsucc{i}", {})
            err = by_id.get(f"azerr{i}", {})
            pts = []
            for t in stamps:
                attempted = succ.get(t, 0.0) + err.get(t, 0.0)
                pts.append(
                    round(100.0 * ok.get(t, 0.0) / attempted, 1) if attempted else None
                )
            client_out[az] = pts
        out["clientAz"] = client_out
        # The threshold travels WITH the data so the chart's axis label is derived, not
        # hand-typed. A UI that prints "within 2s" from its own literal would keep printing
        # it after the emitter moved to 1500ms, and the chart would be mislabelled with no
        # test able to see it -- the label and the definition must have one source.
        out["sloMs"] = AZ_SLO_MS
        return out
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "note": str(exc)}


def _region_traffic():
    """Where client traffic is ACTUALLY landing — the honest active-region signal.

    Sums RegionSuccess/RegionError{Region=r} over the last 5 minutes for both regions.

    WHY THIS AND NOT A DNS OR HTTP PROBE. The private-zone record app.<domain> is
    LATENCY-routed with one alias record per region (dns-stack.ts), so DNS has no single
    global answer: each resolver is handed its own nearest healthy region. Failover works
    by ARC flipping a region's health check so its record drops out of answers. That
    means:
      * an HTTP probe through the front door cannot answer it — an ALB target group holds
        one region's fixed NLB IPs and can never follow the failover;
      * the ARC-vended health checks are owned by the ARC service and return AccessDenied
        to this account, so their status is unreadable here;
      * this Lambda is deliberately VPC-free, so it cannot resolve the private zone.

    Observed traffic DOES have a single answer. The load generator resolves the record and
    its requests follow whatever DNS hands it, so the region receiving RegionSuccess is
    the region clients are reaching. Both regions carrying traffic is a real state
    (failover in flight, or clients in both regions), so it is reported rather than hidden.
    """
    regions = [PRIMARY_REGION, STANDBY_REGION]

    def rid(region, metric):
        # GetMetricData Ids must be alphanumeric/underscore — region names carry hyphens.
        return f"{metric.lower()}_{region.replace('-', '_')}"

    def q(region, metric):
        return {
            "Id": rid(region, metric),
            "MetricStat": {
                "Metric": {
                    "Namespace": METRIC_NAMESPACE,
                    "MetricName": metric,
                    "Dimensions": [{"Name": "Region", "Value": region}],
                },
                "Period": 60,
                "Stat": "Sum",
            },
            "ReturnData": True,
        }

    try:
        import datetime as dt
        end = dt.datetime.utcnow()
        start = end - dt.timedelta(minutes=5)
        queries = []
        for region in regions:
            queries.append(q(region, "RegionSuccess"))
            queries.append(q(region, "RegionError"))
        res = _cw.get_metric_data(MetricDataQueries=queries, StartTime=start, EndTime=end)
        vals = {m["Id"]: sum(m["Values"]) for m in res["MetricDataResults"]}

        traffic = {
            region: {
                "success": vals.get(rid(region, "RegionSuccess"), 0.0),
                "error": vals.get(rid(region, "RegionError"), 0.0),
            }
            for region in regions
        }
        totals = {r: traffic[r]["success"] + traffic[r]["error"] for r in regions}
        serving = [r for r in regions if totals[r] > 0]

        if not serving:
            # No traffic is NOT an error: the load generator may be stopped. Say so
            # rather than naming a region we have no evidence for.
            return {
                "available": True,
                "region": None,
                "traffic": traffic,
                "note": "no client traffic in the last 5 min",
            }

        out = {
            "available": True,
            "region": max(regions, key=lambda r: totals[r]),
            "traffic": traffic,
        }
        if len(serving) > 1:
            out["note"] = "traffic in both regions — failover in flight or split clients"
        return out
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "note": str(exc)}


def _arc_status():
    try:
        # The plan ARN is THREADED (Step 5), so this no longer scans ListPlans looking for
        # one whose ARN happens to contain the app id — a match that would silently pick the
        # wrong plan if two demos shared an account.
        arn = PLAN_ARN
        out = {"available": True, "planArn": arn}
        try:
            ev = _arc.get_plan_evaluation_status(planArn=arn)
            out["evaluation"] = ev.get("evaluationState")
        except Exception as exc:  # noqa: BLE001
            out["evaluation"] = f"unavailable: {exc}"
        try:
            execs = _arc.list_plan_executions(planArn=arn).get("items", [])
            if execs:
                latest = execs[0]
                exec_id = latest.get("executionId")
                out["lastExecution"] = {
                    "status": latest.get("executionState") or latest.get("status"),
                    "id": exec_id,
                }
                # PER-STEP PROGRESS. The execution status alone is nearly useless while a
                # failover is running: "inProgress" for ten minutes tells an operator
                # nothing, and the one decision they may have to make (skip a wedged step,
                # or switch it to ungraceful) depends on knowing WHICH step is stuck and
                # for how long. GetPlanExecution carries the step list, and the role
                # already holds arc-region-switch:GetPlanExecution, so this needs no new
                # grant. Best-effort: a failure here must not blank the whole ARC tile.
                try:
                    det = _arc.get_plan_execution(planArn=arn, executionId=exec_id)
                    steps = []
                    for s in (det.get("stepStates") or det.get("steps") or []):
                        steps.append({
                            "name": s.get("name") or s.get("stepName"),
                            "status": (s.get("status") or (s.get("state") or {}).get("status")),
                            "started": str(s.get("startTime") or ""),
                            "ended": str(s.get("endTime") or ""),
                        })
                    if steps:
                        out["lastExecution"]["steps"] = steps
                    out["lastExecution"]["mode"] = det.get("mode") or det.get("executionAction")
                    out["lastExecution"]["target"] = det.get("targetRegion")
                except Exception as exc:  # noqa: BLE001
                    out["lastExecution"]["stepsNote"] = f"steps unavailable: {type(exc).__name__}"
        except Exception:  # noqa: BLE001
            pass
        return out
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "note": str(exc)}


def _active_shifts():
    """ACTIVE zonal shifts on the app NLB. One lookup, three consumers (status tile,
    cancel, F4 auto-cancel) — the Lambda is stateless, so the shift id is always
    re-discovered from the service rather than remembered from the start call.
    Raises on API failure; each caller decides whether that degrades or fails loud.
    """
    shifts = _azs.list_zonal_shifts(status="ACTIVE").get("items", [])
    return [s for s in shifts if s.get("resourceIdentifier") == APP_NLB_ARN]


def _zonal_shift():
    """Active zonal shift on the app NLB, for the status tile + expiry countdown.

    Best-effort: any failure degrades this ONE tile, never the page (same contract as
    every other reader). Reports awayFrom mapped BACK to an AZ name for display — the
    operator thinks in names; the API speaks IDs — and expiryTime so the UI renders a
    live countdown. Also reports whether the control is enabled and, when it is not,
    exactly why (F6): a disabled button with no reason is indistinguishable from a
    broken cockpit.
    """
    try:
        rt = _region_traffic()
        enabled = rt.get("region") == PRIMARY_REGION
        out = {"available": True, "enabled": enabled}
        if not enabled:
            out["reason"] = (
                "AZ controls unavailable — traffic is in "
                + (rt.get("region") or "no region (load generator stopped?)")
            )
        mine = _active_shifts()
        if mine:
            s = mine[0]
            id_to_name = {v: k for k, v in AZ_NAME_TO_ID.items()}
            out.update({
                "status": s.get("status"),
                "awayFrom": id_to_name.get(s.get("awayFrom"), s.get("awayFrom")),
                "expiryTime": str(s.get("expiryTime") or ""),
                "zonalShiftId": s.get("zonalShiftId"),
            })
        return out
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "note": str(exc)}


def _status():
    return {
        "appId": APP_ID,
        "primaryRegion": PRIMARY_REGION,
        "standbyRegion": STANDBY_REGION,
        # Active region is DERIVED FROM OBSERVED TRAFFIC, not a probe. See
        # _region_traffic's docstring for why DNS/HTTP cannot answer this.
        "activeRegion": _region_traffic(),
        "aurora": _aurora_writer_region(),
        "knob": {
            PRIMARY_REGION: _knob(_ssm_primary, PRIMARY_REGION),
            STANDBY_REGION: _knob(_ssm_standby, STANDBY_REGION),
        },
        "availabilitySeries": _availability_series(),
        "arc": _arc_status(),
        "fis": _fis_state(),
        # Paired with the UI's renderAzChart argument in the SAME change: a UI reading a field
        # nothing produces renders a plausible blank rather than failing (bug class 6), and a
        # field nothing reads is dead weight. A test asserts the two agree.
        "faultedAz": _faulted_az(),
        "zonalShift": _zonal_shift(),
        "replicas": _replicas(),
    }


def _replicas():
    """orders-api desired/ready per region, from the in-cluster reporter's metrics.

    The reporter (k8s/app.yaml CronJob) publishes DesiredReplicas/ReadyReplicas each
    minute to its OWN region's CloudWatch — the only path that exists, because this
    Lambda is no-VPC and the cluster API endpoint is private. `Maximum` over the last
    3 minutes tolerates the CronJob's 1-minute cadence plus publish jitter; a region
    with no datapoints reports its own note instead of failing the whole tile.
    """
    def q(metric, region):
        return {
            "Id": metric.lower(),
            "MetricStat": {
                "Metric": {
                    "Namespace": METRIC_NAMESPACE,
                    "MetricName": metric,
                    "Dimensions": [{"Name": "Region", "Value": region}],
                },
                "Period": 60,
                "Stat": "Maximum",
            },
            "ReturnData": True,
        }

    import datetime as dt
    end = dt.datetime.utcnow()
    start = end - dt.timedelta(minutes=3)
    out = {"available": True, "regions": {}}
    for region, client in _CW.items():
        try:
            r = client.get_metric_data(
                MetricDataQueries=[
                    q("DesiredReplicas", region), q("ReadyReplicas", region),
                ],
                StartTime=start, EndTime=end,
            )
            vals = {}
            for m in r["MetricDataResults"]:
                # Latest datapoint wins: results are timestamp-descending by default,
                # but sort defensively rather than assuming.
                pairs = sorted(zip(m["Timestamps"], m["Values"]), reverse=True)
                if pairs:
                    vals[m["Id"]] = int(pairs[0][1])
            if vals:
                out["regions"][region] = {
                    "desired": vals.get("desiredreplicas"),
                    "ready": vals.get("readyreplicas"),
                }
            else:
                out["regions"][region] = {"note": "no reporter data yet"}
        except Exception as e:  # a dead region's read must not kill the tile
            out["regions"][region] = {"note": f"read failed: {type(e).__name__}"}
    return out


def _fis_state():
    """Which faults have templates, whether nodes are ARMED, and any running experiments.

    "Armed" is the ChaosAllowed=true tag on the managed node group's instances. It is
    reported separately from "running" because an experiment started against UNARMED nodes
    resolves zero targets and reports SUCCESS having injected nothing — so a UI that only
    showed "running" would show a green experiment doing nothing at all.
    """
    out = {"available": True, "region": PRIMARY_REGION, "faults": {}, "running": []}
    for fault, meta in FAULTS.items():
        ids = _template_ids(fault)
        out["faults"][fault] = {
            "templateCount": len(ids),
            "movesAvailability": meta["availability"],
        }
    try:
        # Only non-terminal experiments matter for the control state.
        for e in _fis.list_experiments(maxResults=20).get("experiments", []):
            state = (e.get("state") or {}).get("status")
            if state in ("pending", "initiating", "running"):
                out["running"].append({"id": e.get("id"), "state": state,
                                       "template": e.get("experimentTemplateId")})
    except Exception as exc:  # noqa: BLE001
        out["runningNote"] = str(exc)
    try:
        armed, total = _armed_counts()
        out["armed"] = armed
        out["nodeCount"] = total
    except Exception as exc:  # noqa: BLE001
        out["armed"] = None
        out["armedNote"] = str(exc)
    return out


def _node_instance_ids():
    """Resolve EVERY node the faults should reach: managed node group + Karpenter.

    Mirrors build/start-region-wide-injection.sh for the managed half: node group -> its
    AWS-owned ASG -> InService instances. CloudFormation cannot tag those instances, which
    is exactly why tagging is the arming gesture rather than deploy-time state.

    THE KARPENTER HALF IS THE ONE THAT WAS MISSING. Karpenter-launched nodes belong to no
    ASG, so the node-group walk never sees them — measured 2026-09-01: 3 of 5 nodes were
    Karpenter's and silently immune to every fault, thinning the injection while the
    experiment reported success. They are resolved by the karpenter.sh/nodepool tag that
    Karpenter stamps on every instance it launches. New Karpenter nodes are born armed
    (EC2NodeClass spec.tags carries ChaosAllowed at LAUNCH); this arm action is what
    covers the ones already running, since Karpenter's controller policy cannot retro-tag.
    """
    ng = _eks.describe_nodegroup(clusterName=PRIMARY_CLUSTER_NAME,
                                 nodegroupName=PRIMARY_NODE_GROUP_NAME)["nodegroup"]
    asgs = ng.get("resources", {}).get("autoScalingGroups", [])
    if not asgs:
        raise RuntimeError("node group has no Auto Scaling group")
    groups = _asg.describe_auto_scaling_groups(
        AutoScalingGroupNames=[asgs[0]["name"]])["AutoScalingGroups"]
    if not groups:
        raise RuntimeError(f"ASG {asgs[0]['name']} not found")
    ids = [i["InstanceId"] for i in groups[0]["Instances"]
           if i.get("LifecycleState") == "InService"]
    # Karpenter-launched nodes for THIS cluster: the eks:eks-cluster-name tag scopes the
    # nodepool match to our cluster, so a second cluster's Karpenter fleet in the same
    # account is never armed by accident.
    paginator = _ec2.get_paginator("describe_instances")
    for page in paginator.paginate(Filters=[
        {"Name": "tag-key", "Values": ["karpenter.sh/nodepool"]},
        {"Name": "tag:eks:eks-cluster-name", "Values": [PRIMARY_CLUSTER_NAME]},
        {"Name": "instance-state-name", "Values": ["running"]},
    ]):
        for res in page["Reservations"]:
            for inst in res["Instances"]:
                if inst["InstanceId"] not in ids:
                    ids.append(inst["InstanceId"])
    return ids


def _node_asg_names():
    """The managed node group's ASG name(s) — the ASG half of the arming gesture.

    Power interruption's Pause-ASG-Scaling action targets ``aws:ec2:autoscaling-group`` by
    the same ``ChaosAllowed=true`` tag as the instances, and it is LOAD-BEARING: without
    it the ASG relaunches the stopped instances in the faulted AZ within minutes, the
    targets come back healthy, and the chart recovers WITHOUT the operator's shift — the
    heal-race steals the exact beat the fault exists to create. The ASG is AWS-owned
    (created by EKS), so CloudFormation cannot tag it; tagging at arm time is the same
    reasoning as the instances. Karpenter nodes belong to no ASG — their relaunch path is
    blocked by the template's Pause-Instance-Launches action on the controller role.
    """
    ng = _eks.describe_nodegroup(clusterName=PRIMARY_CLUSTER_NAME,
                                 nodegroupName=PRIMARY_NODE_GROUP_NAME)["nodegroup"]
    return [a["name"] for a in ng.get("resources", {}).get("autoScalingGroups", [])
            if a.get("name")]


def _armed_counts():
    ids = _node_instance_ids()
    if not ids:
        return 0, 0
    r = _ec2.describe_instances(
        InstanceIds=ids,
        Filters=[{"Name": "tag:ChaosAllowed", "Values": ["true"]}],
    )
    armed = sum(len(res.get("Instances", [])) for res in r.get("Reservations", []))
    return armed, len(ids)


def _require_confirm(body, expected, what):
    """Typed confirmation. UI friction, deliberately — the IAM grant is the real authz.

    Returns an error response when the typed value does not match, else None. Kept as one
    function so every write path enforces it identically and a test can prove each one does.
    """
    if (body.get("confirm") or "").strip() != expected:
        return _resp(400, {
            "error": "confirmation required",
            "detail": f"type exactly '{expected}' to confirm {what}",
        })
    return None


def _do_knob(body):
    """STEP 2 — set the L1 error-rate knob for one region.

    The knob is app-cooperative: the pods read it through error_rate.py with a 5s TTL
    cache, so nothing happens for up to ~5 seconds after the write and the UI has to say
    so. Writing the parameter is inert on its own — it is the app that honors it.
    """
    region = body.get("region")
    if region not in _SSM:
        return _resp(400, {"error": "region must be one of " + ", ".join(_SSM)})
    try:
        rate = int(body.get("rate"))
    except (TypeError, ValueError):
        return _resp(400, {"error": "rate must be an integer 0-100"})
    if not 0 <= rate <= 100:
        return _resp(400, {"error": "rate must be between 0 and 100"})
    bad = _require_confirm(body, region, f"setting the {region} error knob to {rate}%")
    if bad:
        return bad
    name = KNOB_PARAM[region]
    try:
        _SSM[region].put_parameter(Name=name, Value=str(rate), Type="String", Overwrite=True)
    except Exception as exc:  # noqa: BLE001
        return _resp(502, {"error": f"put_parameter failed: {exc}", "param": name})
    return _resp(200, {
        "ok": True, "param": name, "rate": rate, "region": region,
        "note": "the app caches this for 5s — expect the change to land within ~5 seconds",
    })


def _do_fis(body):
    """STEP 3 — arm, start or stop the region-wide gray failure.

    START FANS EVERY PER-AZ TEMPLATE OF ONE FAULT. The construct emits one template per
    AZ, so starting a single template degrades ONE availability zone — and the correct
    answer to one sick AZ is a zonal shift, not a Region switch. Starting them together is
    what makes the blast radius a Region, which is the failure this demo's failover
    answers.

    NOT ENFORCED YET — MIXING TWO FAULTS IS CURRENTLY POSSIBLE. Mixing faults makes the
    resulting availability number impossible to attribute, so it SHOULD be refused, but
    this function does not check for an already-running experiment. The guards below are
    the complete set: the fault name is known, the confirm string matches, templates were
    threaded, and at least one node is armed. Nothing else. An earlier version of this
    docstring asserted the refusal as fact, and that prose was read as behavior and
    repeated as a safety property the demo does not have — the only thing preventing two
    concurrent faults today is operator discipline.

    The guard is designed and owed: list non-terminal experiments (the same query
    `_fis_state` already runs) and refuse a start when any is running. Scope it to FIS
    experiments ONLY — an ARC zonal shift is not an FIS experiment and must stay permitted
    concurrently with a fault, because fault-then-shift-then-recover is the AZ demo beat.
    See .agents/2026-09-01-single-az-fault-zonal-shift/research/failure-injection.md §(c).
    """
    action = body.get("action")
    if action not in ("arm", "disarm", "start", "stop"):
        return _resp(400, {"error": "action must be arm, disarm, start or stop"})

    if action in ("arm", "disarm"):
        bad = _require_confirm(body, action, f"{action}ing the node fleet")
        if bad:
            return bad
        try:
            ids = _node_instance_ids()
        except Exception as exc:  # noqa: BLE001
            return _resp(502, {"error": f"could not resolve node instances: {exc}"})
        if not ids:
            return _resp(409, {"error": "no InService nodes to arm"})
        try:
            if action == "arm":
                # The SSM-registration precheck. aws:ssm:send-command faults reach nodes
                # through the SSM agent, and these subnets have no NAT — they depend on the
                # ssm/ssmmessages/ec2messages interface endpoints. Unregistered nodes mean
                # the experiment resolves zero targets and reports success having done
                # nothing, so this refuses to arm rather than hand back a false green.
                info = _ssm_primary.describe_instance_information(
                    Filters=[{"Key": "InstanceIds", "Values": ids}])
                managed = len(info.get("InstanceInformationList", []))
                if managed == 0:
                    return _resp(409, {
                        "error": "no nodes are registered with Systems Manager",
                        "detail": ("aws:ssm:send-command faults would resolve zero targets "
                                   "and the experiment would report success having done "
                                   "nothing. Check the ssm, ssmmessages and ec2messages "
                                   "VPC endpoints and the node role."),
                        "nodes": len(ids), "ssmManaged": managed,
                    })
                _ec2.create_tags(Resources=ids,
                                 Tags=[{"Key": "ChaosAllowed", "Value": "true"}])
                # The ASG half (power interruption's Pause-ASG-Scaling target — see
                # _node_asg_names for why it is load-bearing). PropagateAtLaunch=False:
                # instances get the tag from THIS arm action or from EC2NodeClass at
                # launch; propagating from the ASG would arm replacement instances that
                # the operator never armed.
                asg_names = _node_asg_names()
                if asg_names:
                    _asg.create_or_update_tags(Tags=[
                        {"ResourceId": n, "ResourceType": "auto-scaling-group",
                         "Key": "ChaosAllowed", "Value": "true",
                         "PropagateAtLaunch": False}
                        for n in asg_names])
                return _resp(200, {"ok": True, "armed": len(ids), "ssmManaged": managed,
                                   "asgsArmed": len(asg_names)})
            _ec2.delete_tags(Resources=ids, Tags=[{"Key": "ChaosAllowed"}])
            asg_names = _node_asg_names()
            if asg_names:
                _asg.delete_tags(Tags=[
                    {"ResourceId": n, "ResourceType": "auto-scaling-group",
                     "Key": "ChaosAllowed"}
                    for n in asg_names])
            return _resp(200, {"ok": True, "disarmed": len(ids)})
        except Exception as exc:  # noqa: BLE001
            return _resp(502, {"error": f"tagging failed: {exc}"})

    if action == "stop":
        exp_id = body.get("experimentId")
        try:
            if exp_id:
                _fis.stop_experiment(id=exp_id)
                stopped = [exp_id]
            else:
                stopped = []
                for e in _fis.list_experiments(maxResults=20).get("experiments", []):
                    if (e.get("state") or {}).get("status") in ("pending", "initiating", "running"):
                        _fis.stop_experiment(id=e["id"])
                        stopped.append(e["id"])
        except Exception as exc:  # noqa: BLE001
            return _resp(502, {"error": f"stop failed: {exc}"})
        # F4: a zonal shift is a MITIGATION of the fault, so when the fault stops the
        # shift must stop with it — otherwise the demo ends with one AZ silently drained
        # and the next fault run measures a two-AZ baseline. Direct API call in the stop
        # path, never prose-driven (bug class 8). Best-effort AFTER the stops succeeded,
        # so a cancel failure is reported without masking a successful fault-stop; the
        # shift's own expiresIn is the walk-away backstop.
        auto_cancelled = []
        auto_cancel_note = None
        try:
            for s in _active_shifts():
                _azs.cancel_zonal_shift(zonalShiftId=s["zonalShiftId"])
                auto_cancelled.append(s["zonalShiftId"])
        except Exception as exc:  # noqa: BLE001
            auto_cancel_note = str(exc)
        out = {"ok": True, "stopped": stopped, "autoCancelledShifts": auto_cancelled}
        if auto_cancel_note:
            out["autoCancelNote"] = auto_cancel_note
        return _resp(200, out)

    # action == start
    fault = body.get("fault")
    if fault not in FAULTS:
        return _resp(400, {"error": "fault must be one of " + ", ".join(FAULTS)})
    single_az = bool(FAULTS[fault].get("singleAz"))
    scope = "in one AZ" if single_az else "fleet-wide"
    bad = _require_confirm(body, fault, f"starting the {fault} experiment {scope}")
    if bad:
        return bad

    # THE INTERLOCK. Refuses a second FAULT; a zonal shift is not an FIS experiment and stays
    # permitted, which is what makes fault-then-shift-then-recover possible by construction.
    running = _fault_already_running()
    if running:
        return _resp(409, {
            "error": "a fault is already running",
            "detail": ("Two concurrent faults make the resulting availability number impossible "
                       "to attribute, which is the one thing the chart exists to support. Stop "
                       "the running experiment first. A zonal SHIFT is not a fault and is "
                       "permitted concurrently."),
            "experimentId": running,
        })

    if single_az:
        # D3: the AZ is CHOSEN, not passed in. Eligibility is recent traffic
        # (Sum(AzSuccess + AzError) by Az), so the fault lands where it will actually move the
        # graph. A pod-count test would happily select an AZ holding an idle pod, where the
        # fault injects cleanly, reports success and changes nothing measurable.
        by_az = _templates_by_az(fault)
        if not by_az:
            return _resp(409, {"error": f"no per-AZ experiment templates threaded for {fault}"})
        az, reason = _eligible_fault_az()
        if not az:
            # REFUSES WITH A STATED REASON rather than picking something. Silently choosing when
            # we cannot tell is how "reported success, injected nothing" happens; failing blank
            # is indistinguishable from a broken cockpit.
            return _resp(409, {"error": "no AZ is eligible for a single-AZ fault",
                               "detail": reason})
        if az not in by_az:
            return _resp(409, {
                "error": f"the busiest AZ ({az}) has no experiment template",
                "detail": ("Templates are threaded per AZ by NAME. This means the AZ serving "
                           "traffic is not one the templates cover -- check the threaded pairs "
                           "rather than starting a fault in a different AZ."),
                "eligible": az, "templatedAzs": sorted(by_az),
            })
        ids = [by_az[az]]
    else:
        ids = _template_ids(fault)
    if not ids:
        return _resp(409, {"error": f"no experiment templates found for {fault}"})
    try:
        armed, total = _armed_counts()
    except Exception:  # noqa: BLE001
        armed, total = None, None
    if armed == 0:
        return _resp(409, {
            "error": "nodes are not armed",
            "detail": ("the templates target aws:ec2:instance by ChaosAllowed=true; "
                       "starting now would resolve zero targets and report success having "
                       "injected nothing. Arm first."),
            "nodeCount": total,
        })
    started, failed = [], []
    for template_id in ids:
        try:
            e = _fis.start_experiment(
                experimentTemplateId=template_id,
                tags={"Name": "region-wide-gray-failure", "StartedBy": "cockpit"},
            )
            started.append({"template": template_id, "experiment": e["experiment"]["id"]})
        except Exception as exc:  # noqa: BLE001
            failed.append({"template": template_id, "error": str(exc)})

    # VERIFY TARGETS RESOLVED. A 200 from StartExperiment means FIS ACCEPTED the request,
    # NOT that the experiment found anything to break. Observed live 2026-09-01: three
    # per-AZ templates started, and the third died 1s later with "Target resolution returned
    # empty set" because there were only two nodes across two AZs -- while this handler had
    # already reported all three as started. That is the house failure mode: reporting
    # success having injected nothing. Cheap to close, because the failure is immediate.
    if started:
        time.sleep(3)
        verified, unresolved = [], []
        for s in started:
            try:
                st = _fis.get_experiment(id=s["experiment"])["experiment"]["state"]
                s["state"] = st.get("status")
                if s["state"] == "failed":
                    s["reason"] = st.get("reason")
                    unresolved.append(s)
                else:
                    verified.append(s)
            except Exception as exc:  # noqa: BLE001
                s["state"] = f"unknown: {type(exc).__name__}"
                verified.append(s)  # cannot prove it failed; do not claim it did
        started, failed = verified, failed + unresolved
    return _resp(200 if started else 502, {
        "ok": bool(started) and not failed,
        "fault": fault, "started": started, "failed": failed,
        "movesAvailability": FAULTS[fault]["availability"],
        "note": ("this fault runs at MAX severity already (all stressors, 100% load) and "
                 "still moves LATENCY only: the app is I/O bound on Aurora, not CPU bound"
                 if not FAULTS[fault]["availability"] else
                 "severity is calibrated past the app's timeouts (5s read, 3s connect), so "
                 "availability should sag within a few minutes -- watch the availability "
                 "tile, and give the 5-minute rolling window time to fill"),
    })


def _do_zonalshift(body):
    """STEP 10 — start or cancel an ARC zonal shift away from the faulted AZ.

    The shift is the MITIGATION half of the single-AZ story: one AZ is degraded (FIS),
    the operator shifts traffic away from it, the chart recovers attributably. So:

    * ``start`` requires a RUNNING single-AZ fault and always targets ITS AZ, derived
      from the running experiment (never from the page — same rule as faultedAz). A
      shift with nothing to mitigate would drain a healthy AZ and corrupt the baseline.
    * ``start`` is PRIMARY-ONLY with a stated reason (F6): the NLB this control can act
      on is the primary's, so when traffic is elsewhere the shift would report ACTIVE
      and move nothing measurable — the control refuses rather than pretends.
    * ``cancel`` is deliberately NOT gated on the active region: it is restorative, and
      refusing it because traffic moved would strand an active shift.
    * The name→ID translation goes through the threaded AZ_NAME_TO_ID map only. FIS
      speaks AZ names, awayFrom takes the ID, and deriving one from the other by string
      rule mis-binds silently on some accounts.
    """
    action = body.get("action")
    if action not in ("start", "cancel"):
        return _resp(400, {"error": "action must be start or cancel"})

    if action == "cancel":
        try:
            cancelled = []
            for s in _active_shifts():
                _azs.cancel_zonal_shift(zonalShiftId=s["zonalShiftId"])
                cancelled.append(s["zonalShiftId"])
            return _resp(200, {"ok": True, "cancelled": cancelled,
                               "note": None if cancelled else "no active shift to cancel"})
        except Exception as exc:  # noqa: BLE001
            return _resp(502, {"error": f"cancel failed: {exc}"})

    # action == start
    rt = _region_traffic()
    if rt.get("region") != PRIMARY_REGION:
        # region:None (loadgen stopped) is treated as "not primary", never a crash.
        return _resp(409, {
            "error": "AZ controls unavailable — traffic is in "
                     + (rt.get("region") or "no region (load generator stopped?)"),
        })

    az_name = _faulted_az()
    if not az_name:
        return _resp(409, {
            "error": "no single-AZ fault is running — the shift recovers the faulted AZ, "
                     "so start a single-AZ fault first",
        })

    zone_id = AZ_NAME_TO_ID.get(az_name)
    if not zone_id:
        # The verifier proves the threaded map against the live account at deploy, so
        # reaching this means the map and the FIS AZ list have diverged since.
        return _resp(502, {
            "error": f"no AZ ID threaded for {az_name} — the AzNameIdPairs map and the "
                     "FIS AZ list have diverged; redeploy",
        })

    expires_in = str(body.get("expiresIn") or "15m")
    m = re.fullmatch(r"([1-9][0-9]*)(m|h)", expires_in)
    if not m or int(m.group(1)) * (60 if m.group(2) == "h" else 1) > 72 * 60:
        return _resp(400, {"error": "expiresIn must look like 15m or 2h, at most 72h"})

    bad = _require_confirm(body, az_name, f"starting a zonal shift away from {az_name}")
    if bad:
        return bad

    try:
        shift = _azs.start_zonal_shift(
            resourceIdentifier=APP_NLB_ARN,
            awayFrom=zone_id,
            expiresIn=expires_in,
            comment=f"cockpit: shift away from {az_name} (single-AZ fault mitigation)",
        )
        return _resp(200, {
            "ok": True,
            "zonalShiftId": shift.get("zonalShiftId"),
            "awayFrom": az_name,
            "expiresIn": expires_in,
        })
    except Exception as exc:  # noqa: BLE001
        # The one failure worth translating: ResourceNotFound here means the NLB was
        # never OPTED IN to zonal shift (the Service annotation didn't land). The
        # post-deploy verifier exists to catch this before demo time; name the cause
        # anyway rather than surfacing a bare exception.
        if "ResourceNotFound" in type(exc).__name__ or "ResourceNotFound" in str(exc):
            return _resp(409, {
                "error": "the app NLB is not opted into zonal shift — the "
                         "zonal_shift.config.enabled Service annotation did not land",
            })
        return _resp(502, {"error": f"start failed: {exc}"})


def _do_failover(body):
    """STEP 4 — dry-run, then execute, the ARC Region switch.

    THE ENDPOINT REGION IS NOT A FREE CHOICE. `start_plan_execution` takes a semantic
    --target-region AND is called against a regional endpoint, and ARC is explicit that a
    plan executes from the region being ACTIVATED so the switch does not depend on the
    region being evacuated. This plan is activePassive with a single `activate` workflow,
    so activating one region deactivates the other as one sequenced cutover — and the
    endpoint always coincides with the target. `deactivate` is refused because the plan has
    no deactivate workflow and StartPlanExecution would reject it.
    """
    target = body.get("targetRegion")
    if target not in _ARC_BY_REGION:
        return _resp(400, {"error": "targetRegion must be one of " + ", ".join(_ARC_BY_REGION)})
    mode = body.get("mode", "graceful")
    if mode not in ("graceful", "ungraceful"):
        return _resp(400, {"error": "mode must be graceful or ungraceful"})
    plan_arn = PLAN_ARN
    derived = {
        "service": "arc-region-switch", "operation": "start-plan-execution",
        "endpointRegion": target,  # == target: the region being activated
        "planArn": plan_arn, "targetRegion": target, "action": "activate", "mode": mode,
        "cli": (f"aws arc-region-switch start-plan-execution --region {target} "
                f"--plan-arn {plan_arn} --target-region {target} "
                f"--action activate --mode {mode}"),
    }
    if not body.get("execute"):
        # DRY RUN CALLS NOTHING. It renders exactly what execute would issue.
        return _resp(200, {"ok": True, "dryRun": True, "derived": derived})

    bad = _require_confirm(body, target, f"FAILING OVER to {target}")
    if bad:
        return bad
    try:
        r = _ARC_BY_REGION[target].start_plan_execution(
            planArn=plan_arn, targetRegion=target, action="activate", mode=mode,
            comment=body.get("comment") or "started from the resilience cockpit",
        )
    except Exception as exc:  # noqa: BLE001
        return _resp(502, {"error": f"start_plan_execution failed: {exc}", "derived": derived})
    return _resp(200, {"ok": True, "dryRun": False, "derived": derived,
                       "executionId": r.get("executionId")})


def _do_step_recovery(body):
    """Unstick a stuck execution step. ONLY skip / switchToUngraceful exist.

    There is NO retry action — verified live twice when the EKS scale step exceeded its
    20-minute budget (Karpenter provisioning under ratcheted target counts). Offering a
    third option would be an invented API, so the enum is closed here and in the UI.
    """
    allowed = ("skip", "switchToUngraceful")
    action = body.get("actionToTake")
    if action not in allowed:
        return _resp(400, {"error": "actionToTake must be one of " + ", ".join(allowed)})
    for field in ("executionId", "stepName", "region"):
        if not body.get(field):
            return _resp(400, {"error": f"{field} is required"})
    region = body["region"]
    if region not in _ARC_BY_REGION:
        return _resp(400, {"error": "region must be one of " + ", ".join(_ARC_BY_REGION)})
    try:
        _ARC_BY_REGION[region].update_plan_execution_step(
            planArn=PLAN_ARN, executionId=body["executionId"],
            stepName=body["stepName"], actionToTake=action,
            comment=body.get("comment") or "step recovery from the resilience cockpit",
        )
    except Exception as exc:  # noqa: BLE001
        return _resp(502, {"error": f"update_plan_execution_step failed: {exc}"})
    return _resp(200, {"ok": True, "actionToTake": action, "stepName": body["stepName"]})


def handler(event, _context):
    path = event.get("path", "/cockpit")
    method = event.get("httpMethod", "GET")
    if method == "GET" and path in ("/cockpit", "/cockpit/"):
        return _resp(200, _UI_HTML, content_type="text/html; charset=utf-8")
    if method == "GET" and path == "/cockpit/api/status":
        return _resp(200, _status())
    if method == "POST":
        try:
            body = json.loads(event.get("body") or "{}")
        except ValueError:
            return _resp(400, {"error": "body must be JSON"})
        if not isinstance(body, dict):
            return _resp(400, {"error": "body must be a JSON object"})
        if path == "/cockpit/api/knob":
            return _do_knob(body)
        if path == "/cockpit/api/fis":
            return _do_fis(body)
        if path == "/cockpit/api/zonalshift":
            return _do_zonalshift(body)
        if path == "/cockpit/api/failover":
            return _do_failover(body)
        if path == "/cockpit/api/step":
            return _do_step_recovery(body)
    return _resp(404, {"error": "not found", "path": path})
