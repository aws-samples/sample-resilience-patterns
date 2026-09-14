#!/usr/bin/env python3
"""VERIFY that the app's DNS records carry the ARC-vended health checks, and clear the
transient plan-evaluation warning.

This does NOT mutate any record. The failover stack's template owns the attachment: the
records take their HealthCheckId from the plan's `PlanHealthChecks` GetAtt attribute
(failover-stack.ts). This script is the guard on that mechanism, for two reasons.

1. THE FORMAT IS OBSERVED, NOT CONTRACTED. `PlanHealthChecks` is the only GetAtt attribute
   the CloudFormation reference documents for AWS::ARCRegionSwitch::Plan, and it carries no
   description at all. The shape the template parses --
   `<hostedZoneId>:<recordName>:<region>:<healthCheckId>` -- was established by deploying it
   and reading the value (2026-08-31). If AWS ever changes it, the template would bind a
   WRONG or malformed id, the plan would still report success, and the failover would shift
   traffic the wrong way. That is silent, so this script makes it loud: it re-derives the
   correct pairing from `arc-region-switch list-route53-health-checks` (which returns an
   explicit `region` per check) and fails the deploy on any mismatch.

2. THE PLAN EVALUATES BEFORE THE RECORDS EXIST. Inside one stack CloudFormation creates the
   plan first (the records depend on it via GetAtt), so ARC's first evaluation sees no
   records and caches `actionRequired` with "No records with the record name ...".
   `get-plan-evaluation-status` serves that cached result indefinitely, so a perfectly good
   deploy would end on a warning banner. A verbatim no-op `update-plan` forces a rescan
   without changing the plan ARN.

Required env (sourced from the dns and failover stack dotenvs by the deploy step):
    HOSTEDZONEID   private hosted zone id            (dns stack output)
    APPRECORDNAME  record name, e.g. app.x.internal  (dns stack output)
    PLANARN        ARC Region Switch plan arn        (failover stack output)
    AWS_REGION     region for the arc-region-switch calls
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time


def fail(msg: str) -> "None":
    print(f"attach-arc-health-checks: FAILED: {msg}", file=sys.stderr)
    sys.exit(1)


def aws(*args: str) -> dict:
    """Run an aws CLI command and parse JSON. Non-zero exit is fatal, never ignored."""
    cmd = ["aws", *args, "--output", "json"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        fail(f"{' '.join(cmd)}\n{proc.stderr.strip()}")
    out = proc.stdout.strip()
    return json.loads(out) if out else {}


def env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        fail(
            f"{name} is not set. This step sources the dns and regionswitch dotenvs; an "
            f"empty value means an earlier deploy phase did not publish its outputs."
        )
    return v


def main() -> None:
    zone_id = env("HOSTEDZONEID").replace("/hostedzone/", "")
    record_name = env("APPRECORDNAME").rstrip(".")
    plan_arn = env("PLANARN")
    region = os.environ.get("AWS_REGION") or fail("AWS_REGION is not set")

    # ---- 1. the vended checks, with their authoritative region pairing ----------------
    vended_doc = aws(
        "arc-region-switch", "list-route53-health-checks", "--arn", plan_arn, "--region", region
    )
    vended = next((v for v in vended_doc.values() if isinstance(v, list)), [])
    # Only the checks for THIS zone and record. A plan may cover several records.
    vended = [
        v
        for v in vended
        if v.get("hostedZoneId", "").replace("/hostedzone/", "") == zone_id
        and v.get("recordName", "").rstrip(".") == record_name
    ]
    if not vended:
        fail(
            f"the plan vended no health checks for {record_name} in {zone_id}. Either the "
            f"plan's Route53HealthCheck block targets a different record, or the plan has "
            f"not finished provisioning."
        )
    print(f"  vended checks: {len(vended)}")
    for v in vended:
        print(f"    {v['region']:<12} {v['healthCheckId']}")

    # ---- 2. the live records for that name -------------------------------------------
    rrs = aws("route53", "list-resource-record-sets", "--hosted-zone-id", zone_id)
    records = [
        r
        for r in rrs.get("ResourceRecordSets", [])
        if r.get("Name", "").rstrip(".") == record_name and r.get("SetIdentifier")
    ]
    if not records:
        fail(
            f"no records named {record_name} with a SetIdentifier in {zone_id}. The dns "
            f"stack must deploy before this step."
        )

    # ---- 3. verify each check is on exactly the right record -------------------------
    mismatches = []
    claimed: dict = {}
    for v in vended:
        hc_region, hc_id = v["region"], v["healthCheckId"]
        marker = f".{hc_region}."
        matches = [
            r for r in records if marker in (r.get("AliasTarget", {}).get("DNSName", "") or "")
        ]
        if len(matches) != 1:
            fail(
                f"expected exactly 1 record whose alias target is in {hc_region}, found "
                f"{len(matches)}. Cannot verify an ambiguous mapping."
            )
        rec = matches[0]
        sid = rec["SetIdentifier"]
        if sid in claimed:
            fail(
                f"record {sid} matched health checks for both {claimed[sid]} and {hc_region}."
            )
        claimed[sid] = hc_region
        actual = rec.get("HealthCheckId")
        if actual == hc_id:
            print(f"  OK   {sid:<14} {hc_region:<12} {hc_id}")
        else:
            print(f"  BAD  {sid:<14} {hc_region:<12} expected {hc_id}, found {actual or 'none'}")
            mismatches.append(sid)

    if mismatches:
        fail(
            f"{len(mismatches)} record(s) do not carry the health check ARC vended for their "
            f"region: {', '.join(mismatches)}.\n"
            f"The failover stack's template derives these from the plan's PlanHealthChecks "
            f"attribute, whose format is OBSERVED, not documented. A mismatch most likely "
            f"means that format changed -- re-read it with:\n"
            f"  aws cloudformation describe-stacks --stack-name <appId>-failover "
            f"--query \"Stacks[0].Outputs[?OutputKey=='PlanHealthChecks'].OutputValue\"\n"
            f"Do NOT paper over this by attaching them by hand: the next deploy would revert it."
        )

    # ---- 4. force a fresh evaluation and require it to pass ---------------------------
    # Always, not only on change: the plan is created BEFORE the records inside this stack,
    # so its first evaluation always warns and that result is cached.
    plan_doc = aws("arc-region-switch", "get-plan", "--arn", plan_arn, "--region", region)
    plan = plan_doc.get("plan", plan_doc)
    allowed = (
        "arn",
        "description",
        "workflows",
        "executionRole",
        "recoveryTimeObjectiveMinutes",
        "associatedAlarms",
        "triggers",
        "reportConfiguration",
    )
    update = {k: plan[k] for k in allowed if k in plan}
    os.makedirs("dist", exist_ok=True)
    upath = "dist/plan-noop-update.json"
    with open(upath, "w", encoding="utf-8") as fh:
        json.dump(update, fh)
    before = aws(
        "arc-region-switch", "get-plan-evaluation-status", "--plan-arn", plan_arn,
        "--region", region,
    ).get("lastEvaluationTime")
    aws(
        "arc-region-switch", "update-plan", "--cli-input-json", f"file://{upath}",
        "--region", region,
    )
    print("  forced a fresh plan evaluation (no-op update-plan; arn unchanged)")

    status = {}
    for _ in range(9):
        time.sleep(15)
        status = aws(
            "arc-region-switch", "get-plan-evaluation-status", "--plan-arn", plan_arn,
            "--region", region,
        )
        if status.get("lastEvaluationTime") != before:
            break
    state = status.get("evaluationState")
    active = [w for w in (status.get("warnings") or []) if w.get("warningStatus") == "active"]
    print(f"  evaluationState={state} activeWarnings={len(active)}")

    # Split the warnings by whether they concern the thing THIS script protects: the binding
    # between the app record and the health checks. Anything naming the record or the hosted
    # zone is blocking. Everything else is reported and tolerated.
    #
    # WHY THIS IS NOT "fail unless passed". A plan created minutes ago reliably carries the
    # replica-sample warning ("Region switch does not have data on resource
    # apps/v1/Deployment ..."): the EKS scaling block sizes the standby from a ~24h sample of
    # replica counts, so a fresh plan has no data yet and evaluation reports actionRequired.
    # That resolves on its own within a day and says nothing about the health checks. Failing
    # the deploy on it would mean EVERY rebuild fails at the final step having done all the
    # real work correctly -- and the reflex fix would be to delete this gate, losing the
    # silent-mis-binding protection it exists for.
    blocking, tolerated = [], []
    for w in active:
        blob = f"{w.get('resourceArn','')} {w.get('warningMessage','')} {w.get('stepName','')}"
        (blocking if (record_name in blob or zone_id in blob) else tolerated).append(w)

    for w in blocking:
        print(f"    BLOCKING  {w.get('stepName')}: {w.get('warningMessage')}")
    for w in tolerated:
        print(f"    tolerated {w.get('stepName')}: {w.get('warningMessage')}")

    if blocking:
        fail(
            f"{len(blocking)} active plan warning(s) name {record_name} or its hosted zone, so "
            f"the DNS/health-check binding is not sound. The plan would execute and shift no "
            f"traffic. Fix the records before trusting this deploy."
        )

    if tolerated:
        print(
            "  NOTE: plan evaluation is not 'passed', but every active warning is unrelated to "
            "the record/health-check binding. If the replica-sample warning is among them, it "
            "clears once the plan has ~24h of replica history -- until then the EKS scaling "
            "block will scale NOTHING while reporting success, so do not run a failover demo "
            "before then, and on the day verify replicas actually moved."
        )
    elif state != "passed":
        fail(
            f"plan evaluation is {state} with no active warnings returned. That is an unexpected "
            f"combination -- do not assume the plan is sound."
        )
    else:
        print("  plan evaluation passed with no active warnings")


if __name__ == "__main__":
    main()
