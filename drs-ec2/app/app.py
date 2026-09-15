#!/usr/bin/env python3
"""
drs-mr-demo minimal app.

Endpoints:
  GET /        -> INSERT a heartbeat row + SELECT it back; return JSON with the serving
                  region, EC2 instance id, the DB writer endpoint in use, and the last
                  write id. Proves DB read/write from whichever region is serving.
  GET /health  -> 200 for the ALB target-group health check (no DB dependency so the
                  target is healthy the moment the app is up).

Config (env, injected by userdata):
  AWS_REGION        - fallback region; the real region is read from IMDS at runtime so a
                      DRS-recovered instance reports its actual (us-west-2) region.
  DB_PARAM_NAME     - SSM parameter holding the active Aurora writer endpoint. The app
                      re-reads it per request (15s cache) so it follows a switchover with
                      no restart. DB_ENDPOINT is only a boot-time fallback.
  DB_NAME, DB_USER, DB_PASSWORD - from Secrets Manager at boot.
"""
import json
import os
import socket
import time
import urllib.request

from flask import Flask, jsonify

try:
    import psycopg2
except ImportError:  # pragma: no cover - installed via userdata pip
    psycopg2 = None

try:
    import boto3
except ImportError:  # pragma: no cover - installed via userdata pip
    boto3 = None

app = Flask(__name__)


@app.after_request
def _no_keepalive(resp):
    """Close the TCP connection after every response.

    The demo console reaches the app through an SSM port-forward (browser -> plugin -> bastion ->
    ALB). With keep-alive, that one TCP connection is pinned to whichever ALB IP the bastion
    resolved when it opened, so the console keeps showing the OLD region after the Route 53
    failover record has flipped (live, 2026-09-11). Closing forces a fresh connect -- and a fresh
    DNS lookup on the bastion -- per poll, so the console follows the record within its TTL.
    """
    resp.headers["Connection"] = "close"
    return resp


def _imds_region():
    """Actual region from IMDSv2; fixes cross-region reporting after DRS recovery."""
    try:
        token_req = urllib.request.Request(
            "http://169.254.169.254/latest/api/token",
            method="PUT",
            headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"},
        )
        token = urllib.request.urlopen(token_req, timeout=1).read().decode()
        r = urllib.request.Request(
            "http://169.254.169.254/latest/meta-data/placement/region",
            headers={"X-aws-ec2-metadata-token": token},
        )
        return urllib.request.urlopen(r, timeout=1).read().decode()
    except Exception:
        return os.environ.get("AWS_REGION", "unknown")


REGION = _imds_region()
DB_ENDPOINT_ENV = os.environ.get("DB_ENDPOINT", "")
DB_PARAM_NAME = os.environ.get("DB_PARAM_NAME", "/drsdemo/db-writer-endpoint")
DB_NAME = os.environ.get("DB_NAME", "drsdemo")
DB_USER = os.environ.get("DB_USER", "drsadmin")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "")
DB_PORT = int(os.environ.get("DB_PORT", "5432"))

# Resolve the active writer endpoint from SSM on each request (short TTL cache). This lets
# a DRS-recovered instance follow an Aurora Global switchover WITHOUT an app restart: the
# ARC register-target Lambda updates the SSM parameter to the new (us-west-2) writer, and
# the very next request here picks it up. Falls back to the boot-time env value if SSM is
# unreachable.
_ssm_cache = {"endpoint": DB_ENDPOINT_ENV, "ts": 0.0}
_SSM_TTL = 15.0


def _db_endpoint():
    now = time.time()
    if now - _ssm_cache["ts"] < _SSM_TTL and _ssm_cache["endpoint"]:
        return _ssm_cache["endpoint"]
    if boto3 is not None:
        try:
            ssm = boto3.client("ssm", region_name=REGION)
            val = ssm.get_parameter(Name=DB_PARAM_NAME)["Parameter"]["Value"]
            _ssm_cache.update(endpoint=val, ts=now)
            return val
        except Exception:
            pass
    return _ssm_cache["endpoint"] or DB_ENDPOINT_ENV


def _instance_id():
    """Best-effort IMDSv2 instance-id lookup; falls back to hostname."""
    try:
        token_req = urllib.request.Request(
            "http://169.254.169.254/latest/api/token",
            method="PUT",
            headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"},
        )
        token = urllib.request.urlopen(token_req, timeout=1).read().decode()
        id_req = urllib.request.Request(
            "http://169.254.169.254/latest/meta-data/instance-id",
            headers={"X-aws-ec2-metadata-token": token},
        )
        return urllib.request.urlopen(id_req, timeout=1).read().decode()
    except Exception:
        return socket.gethostname()


INSTANCE_ID = _instance_id()


def _connect():
    return psycopg2.connect(
        host=_db_endpoint(),
        dbname=DB_NAME,
        user=DB_USER,
        password=DB_PASSWORD,
        port=DB_PORT,
        connect_timeout=5,
    )


def _ensure_table(cur):
    cur.execute(
        "CREATE TABLE IF NOT EXISTS heartbeat ("
        "id SERIAL PRIMARY KEY, "
        "region TEXT NOT NULL, "
        "instance_id TEXT NOT NULL, "
        "ts TIMESTAMPTZ NOT NULL DEFAULT now())"
    )
    cur.execute("CREATE INDEX IF NOT EXISTS heartbeat_ts_idx ON heartbeat (ts)")


# Every GET / inserts a row (that is the point: it proves the DB is writable from whichever
# region is serving, and a rising id across a failover is the "rows survived" evidence). The
# console polls every 2 s, so an open tab adds ~43k rows/day. Storage is negligible, but the
# per-request count(*) is a full scan, so keep the table bounded: prune rows older than
# HEARTBEAT_RETENTION_DAYS on ~1 in PRUNE_EVERY requests (amortised, no scheduler needed --
# Aurora PostgreSQL has none without a pg_cron parameter-group change). Retention is
# deliberately longer than any demo cycle so the failover evidence is never pruned mid-demo.
RETENTION_DAYS = int(os.environ.get("HEARTBEAT_RETENTION_DAYS", "2"))
PRUNE_EVERY = 500
_request_counter = 0


def _maybe_prune(cur):
    global _request_counter
    _request_counter += 1
    if _request_counter % PRUNE_EVERY:
        return
    cur.execute("DELETE FROM heartbeat WHERE ts < now() - (%s || ' days')::interval", (str(RETENTION_DAYS),))


@app.route("/health")
def health():
    return "ok", 200


@app.route("/")
def index():
    result = {
        "region": REGION,
        "instance_id": INSTANCE_ID,
        "db_writer_endpoint": _db_endpoint(),
    }
    if psycopg2 is None:
        result["db"] = "psycopg2 not installed"
        return jsonify(result), 200
    try:
        conn = _connect()
        conn.autocommit = True
        with conn.cursor() as cur:
            _ensure_table(cur)
            _maybe_prune(cur)
            cur.execute(
                "INSERT INTO heartbeat (region, instance_id) VALUES (%s, %s) RETURNING id",
                (REGION, INSTANCE_ID),
            )
            last_id = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM heartbeat")
            total = cur.fetchone()[0]
        conn.close()
        result["last_write_id"] = last_id
        result["total_rows"] = total
        result["db"] = "ok"
    except Exception as exc:  # surface DB errors in the demo response
        result["db"] = f"error: {exc}"
    return jsonify(result), 200


# ---------------------------------------------------------------------------------------
# Demo dashboard. /ui is a static page; /api/status aggregates the control-plane view
# (read-only: ARC plan + latest execution, DRS, Aurora writer, ALB target health, Route 53
# health-check state); /api/failover starts a plan execution. All calls use the instance
# role; permissions are in templates/06-iam-roles.yaml (DashboardReadOnly / DashboardRunPlan).
# ---------------------------------------------------------------------------------------
from threading import Lock

from flask import request, send_file

PROJECT = os.environ.get("PROJECT", "drsdemo")
PRIMARY_REGION = os.environ.get("PRIMARY_REGION", "us-east-2")
SECONDARY_REGION = os.environ.get("SECONDARY_REGION", "us-west-2")
PLAN_NAME = f"{PROJECT}-switchover"
_status_cache = {"at": 0.0, "data": None}
_status_lock = Lock()


def _iso(dt):
    return dt.isoformat() if dt else None


def _plan_arn():
    arc = boto3.client("arc-region-switch", region_name=PRIMARY_REGION)
    for p in arc.list_plans().get("plans", []):
        if p.get("name") == PLAN_NAME:
            return p["arn"]
    return None


def _latest_execution(plan_arn):
    """Most recent execution across both regional endpoints (executions are region-scoped)."""
    best = None
    for region in (PRIMARY_REGION, SECONDARY_REGION):
        arc = boto3.client("arc-region-switch", region_name=region)
        items = arc.list_plan_executions(planArn=plan_arn, maxResults=1).get("items", [])
        for it in items:
            if best is None or it["startTime"] > best["startTime"]:
                best = dict(it, _region=region)
    if not best:
        return None
    arc = boto3.client("arc-region-switch", region_name=best["_region"])
    ex = arc.get_plan_execution(planArn=plan_arn, executionId=best["executionId"].split("/")[-1])
    return {
        "executionId": best["executionId"],
        "action": ex.get("executionAction"),
        "region": ex.get("executionRegion"),
        "mode": ex.get("mode"),
        "state": ex.get("executionState"),
        "startTime": _iso(ex.get("startTime")),
        "endTime": _iso(ex.get("endTime")),
        "steps": [
            {"name": st["name"], "status": st["status"],
             "startTime": _iso(st.get("startTime")), "endTime": _iso(st.get("endTime"))}
            for st in ex.get("stepStates", [])
        ],
    }


def _build_status():
    out = {"generatedBy": {"region": REGION, "instance_id": INSTANCE_ID}, "errors": []}
    try:
        plan_arn = _plan_arn()
        out["plan"] = {"arn": plan_arn}
        if plan_arn:
            arc = boto3.client("arc-region-switch", region_name=PRIMARY_REGION)
            out["plan"]["healthChecks"] = {
                h["region"]: h["status"]
                for h in arc.list_route53_health_checks(arn=plan_arn).get("healthChecks", [])
            }
            out["plan"]["evaluation"] = {
                r: boto3.client("arc-region-switch", region_name=r)
                       .get_plan_evaluation_status(planArn=plan_arn).get("evaluationState")
                for r in (PRIMARY_REGION, SECONDARY_REGION)
            }
            out["execution"] = _latest_execution(plan_arn)
    except Exception as exc:
        out["errors"].append(f"arc: {exc}")
    try:
        rds = boto3.client("rds", region_name=PRIMARY_REGION)
        gc = rds.describe_global_clusters(GlobalClusterIdentifier=f"{PROJECT}-global")["GlobalClusters"][0]
        out["aurora"] = {
            "status": gc.get("Status"),
            "members": [
                {"region": m["DBClusterArn"].split(":")[3], "writer": m["IsWriter"],
                 "sync": m.get("SynchronizationStatus")}
                for m in gc.get("GlobalClusterMembers", [])
            ],
        }
    except Exception as exc:
        out["errors"].append(f"aurora: {exc}")
    drs_out = {}
    for region in (PRIMARY_REGION, SECONDARY_REGION):
        try:
            drs = boto3.client("drs", region_name=region)
            srcs = [
                {"id": s["sourceServerID"], "direction": s.get("replicationDirection"),
                 "instance": s.get("sourceProperties", {}).get("identificationHints", {}).get("awsInstanceID"),
                 "state": s.get("dataReplicationInfo", {}).get("dataReplicationState"),
                 "lag": s.get("dataReplicationInfo", {}).get("lagDuration"),
                 "role": s.get("tags", {}).get("drsdemo:role")}
                for s in drs.describe_source_servers(filters={}).get("items", [])
            ]
            recs = [
                {"instance": r.get("ec2InstanceID"), "state": r.get("ec2InstanceState"),
                 "source": r.get("sourceServerID")}
                for r in drs.describe_recovery_instances(filters={}).get("items", [])
            ]
            drs_out[region] = {"sourceServers": srcs, "recoveryInstances": recs}
        except Exception as exc:
            drs_out[region] = {"error": str(exc)}
    out["drs"] = drs_out
    alb_out = {}
    for region in (PRIMARY_REGION, SECONDARY_REGION):
        try:
            elb = boto3.client("elbv2", region_name=region)
            tgs = [t for t in elb.describe_target_groups().get("TargetGroups", [])
                   if t["TargetGroupName"].startswith(PROJECT)]
            alb_out[region] = {
                t["TargetGroupName"]: [
                    {"id": d["Target"]["Id"], "state": d["TargetHealth"]["State"]}
                    for d in elb.describe_target_health(TargetGroupArn=t["TargetGroupArn"]).get("TargetHealthDescriptions", [])
                ] for t in tgs
            }
        except Exception as exc:
            alb_out[region] = {"error": str(exc)}
    out["targets"] = alb_out
    out["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return out


@app.route("/api/status")
def api_status():
    # ~10 control-plane calls; cache for 5 s so several dashboards do not hammer the APIs.
    with _status_lock:
        if time.time() - _status_cache["at"] > 5:
            _status_cache["data"] = _build_status()
            _status_cache["at"] = time.time()
        return jsonify(_status_cache["data"]), 200


@app.route("/api/failover", methods=["POST"])
def api_failover():
    """Start the plan: {"target": "us-west-2"|"us-east-2", "mode": "graceful"|"ungraceful"}."""
    body = request.get_json(force=True, silent=True) or {}
    target = body.get("target")
    mode = body.get("mode", "graceful")
    if target not in (PRIMARY_REGION, SECONDARY_REGION) or mode not in ("graceful", "ungraceful"):
        return jsonify({"error": "target must be a workload region; mode graceful|ungraceful"}), 400
    plan_arn = _plan_arn()
    if not plan_arn:
        return jsonify({"error": "plan not found"}), 404
    # ARC: an activate is started on the TARGET region's endpoint.
    arc = boto3.client("arc-region-switch", region_name=target)
    resp = arc.start_plan_execution(planArn=plan_arn, targetRegion=target, action="activate",
                                    mode=mode, comment=f"started from demo dashboard on {INSTANCE_ID}")
    _status_cache["at"] = 0.0
    return jsonify({"executionId": resp.get("executionId"), "target": target, "mode": mode}), 202


@app.route("/ui")
def ui():
    return send_file(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui.html"))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
