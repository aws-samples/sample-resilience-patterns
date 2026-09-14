#!/usr/bin/env python3
"""VERIFY the zonal-shift control's two deploy-only, silent-failure risks (Step 10).

This mutates NOTHING. It exists because both failures below pass synth, cfn-lint, and
every unit test, and would otherwise surface for the first time at DEMO time:

1. THE AZ NAME->ID PAIRING MIS-BINDS SILENTLY. The cockpit translates the faulted AZ's
   NAME (us-east-2a — what FIS speaks) into its ID (use2-az1 — what StartZonalShift's
   `awayFrom` takes) through the threaded `AzNameIdPairs` map. That map is produced by a
   deploy-time custom resource; if it ever disagrees with the live account (a stale
   custom-resource response, a template edit that reorders the positional reads), the
   shift reports ACTIVE while draining a DIFFERENT AZ than the fault is degrading — the
   exact bug-class-18/19 shape that cost this project a day. This script re-derives the
   authoritative map from a live DescribeAvailabilityZones and fails on ANY divergence.

2. THE NLB MAY NOT BE OPTED IN. StartZonalShift 404s unless the load balancer carries
   `zonal_shift.config.enabled=true` — set by the Load Balancer Controller from the app
   Service's annotation (Step 8). If that migration did not land (old Service still
   in-tree, annotation typo'd — unknown annotations are silently ignored), the cockpit
   control is dead on arrival. `get-managed-resource` proves the opt-in here instead.

Required env (mapped through the deploy step's `env:` block — a bare sourced dotenv sets
UNEXPORTED, PREFIXED shell vars this process cannot see; bug class 20):
    APPNLBARN       app NLB ARN                      (installer capture, primary)
    AZNAMEIDPAIRS   name=id,name=id from the region stack's AzNameIdPairs output
    AWS_REGION      primary region
"""
from __future__ import annotations

import json
import os
import subprocess
import sys


def fail(msg: str) -> "None":
    print(f"verify-zonal-shift-azs: FAILED: {msg}", file=sys.stderr)
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
            f"{name} is not set. This step maps its values through the deploy step's "
            f"env: block; an empty value means an earlier phase did not publish it."
        )
    return v


def main() -> None:
    nlb_arn = env("APPNLBARN")
    pairs_raw = env("AZNAMEIDPAIRS")
    region = os.environ.get("AWS_REGION") or fail("AWS_REGION is not set")

    threaded = dict(p.split("=", 1) for p in pairs_raw.split(",") if "=" in p)
    if not threaded:
        fail(f"AZNAMEIDPAIRS carries no name=id pairs: {pairs_raw!r}")

    # ---- 1. the threaded map vs the live account ---------------------------------------
    live_doc = aws(
        "ec2", "describe-availability-zones", "--region", region,
        "--filters", f"Name=region-name,Values={region}",
    )
    live = {z["ZoneName"]: z["ZoneId"] for z in live_doc.get("AvailabilityZones", [])}
    for name, zid in threaded.items():
        if name not in live:
            fail(f"threaded AZ name {name!r} does not exist in {region} (live: {sorted(live)})")
        if live[name] != zid:
            fail(
                f"AZ pairing DIVERGED: threaded {name}={zid} but the live account says "
                f"{name}={live[name]}. StartZonalShift.awayFrom would drain the wrong AZ. "
                f"Redeploy the region stack so AzNameIdPairs is re-derived."
            )
    print(f"verify-zonal-shift-azs: {len(threaded)} threaded pair(s) agree with the live account")

    # ---- 2. the NLB is opted in to zonal shift ------------------------------------------
    # get-managed-resource raises ResourceNotFoundException when the NLB was never opted
    # in — the aws() helper turns that non-zero exit into a loud deploy failure, which is
    # the point: better here than a 404 at demo time.
    managed = aws(
        "arc-zonal-shift", "get-managed-resource",
        "--resource-identifier", nlb_arn, "--region", region,
    )
    applied = managed.get("appliedWeights") or {}
    reported = sorted(applied)
    missing = [n for n, zid in threaded.items() if zid not in applied and n not in applied]
    if missing:
        fail(
            f"the NLB is managed but reports no weight for {missing}; it serves "
            f"{reported}, the threaded map says {sorted(threaded)}. The NLB and the FIS "
            f"AZ set have diverged — a shift away from a missing AZ moves nothing."
        )
    print(
        f"verify-zonal-shift-azs: NLB is opted in to zonal shift, weights present for "
        f"{reported}"
    )


if __name__ == "__main__":
    main()
