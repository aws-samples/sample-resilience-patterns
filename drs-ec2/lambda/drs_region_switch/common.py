"""Shared plumbing for the DRS Region Switch step functions.

Every step module in this package exposes ``handler(event, context)`` and is invoked by an
ARC Region Switch *CustomActionLambda* execution block. ARC re-invokes a step every
``RetryIntervalMinutes`` until the function returns (success) or the step's ``TimeoutMinutes``
elapses, so each step is written as an idempotent state machine: it inspects live state, takes
at most one action, and either returns a result or raises :class:`RetryLater`. Nothing in here
sleeps for long -- ARC's retry loop is the poller.

Clients are created per (service, region) on demand and cached. Regions are always explicit so
the same code runs identically whether deployed in the primary or the secondary region.
Tests replace clients through :func:`set_client_factory`.
"""
from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

import boto3


class RetryLater(Exception):
    """Raised when the step is not finished yet. ARC retries; this is not a failure."""


class StepFailed(Exception):
    """Raised when the step cannot succeed without human action. ARC pauses the execution."""


# ---------------------------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Config:
    project: str
    tag_key: str
    tag_value: str
    primary_region: str
    secondary_region: str
    primary_target_group_arn: str
    secondary_target_group_arn: str
    app_instance_profile_arn: str
    db_param_name: str
    secondary_db_endpoint: str
    stateful_ec2: bool
    target_port: int
    # recovery / failback launch template shape (used when DRS's auto template is unusable)
    primary_subnet_id: str
    primary_app_sg_id: str
    secondary_subnet_id: str
    secondary_app_sg_id: str
    instance_type: str


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def config() -> Config:
    project = _env("PROJECT", "drsdemo")
    return Config(
        project=project,
        tag_key=_env("SOURCE_SERVER_TAG_KEY", f"{project}:role"),
        tag_value=_env("SOURCE_SERVER_TAG_VALUE", "app"),
        primary_region=_env("PRIMARY_REGION", "us-east-2"),
        secondary_region=_env("SECONDARY_REGION", "us-west-2"),
        primary_target_group_arn=_env("PRIMARY_TARGET_GROUP_ARN"),
        secondary_target_group_arn=_env("SECONDARY_TARGET_GROUP_ARN"),
        app_instance_profile_arn=_env("APP_INSTANCE_PROFILE_ARN"),
        db_param_name=_env("DB_PARAM_NAME", f"/{project}/db-writer-endpoint"),
        secondary_db_endpoint=_env("SECONDARY_DB_ENDPOINT"),
        stateful_ec2=_env("STATEFUL_EC2", "false").lower() == "true",
        target_port=int(_env("TARGET_PORT", "8080")),
        primary_subnet_id=_env("PRIMARY_SUBNET_ID"),
        primary_app_sg_id=_env("PRIMARY_APP_SG_ID"),
        secondary_subnet_id=_env("SECONDARY_SUBNET_ID"),
        secondary_app_sg_id=_env("SECONDARY_APP_SG_ID"),
        instance_type=_env("INSTANCE_TYPE", "t2.small"),
    )


# ---------------------------------------------------------------------------------------------
# Clients (region-explicit, cached, replaceable in tests)
# ---------------------------------------------------------------------------------------------

ClientFactory = Callable[[str, str], Any]
_clients: Dict[tuple, Any] = {}
def _factory(service, region):
    return boto3.client(service, region_name=region)


def set_client_factory(factory: Optional[ClientFactory]) -> None:
    """Test seam: supply ``factory(service, region) -> client`` (e.g. Stubber-wrapped)."""
    global _factory
    _factory = factory or (lambda service, region: boto3.client(service, region_name=region))
    _clients.clear()


def client(service: str, region: str):
    key = (service, region)
    if key not in _clients:
        _clients[key] = _factory(service, region)
    return _clients[key]


# ---------------------------------------------------------------------------------------------
# Logging: one JSON line per decision, greppable by step name in CloudWatch
# ---------------------------------------------------------------------------------------------

def log(step: str, message: str, **fields: Any) -> None:
    record = {"step": step, "message": message, **fields}
    sys.stdout.write(json.dumps(record, default=str) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------------------------
# DRS lookups
# ---------------------------------------------------------------------------------------------

def all_source_servers(drs) -> List[dict]:
    out: List[dict] = []
    for page in drs.get_paginator("describe_source_servers").paginate(filters={}):
        out.extend(page.get("items", []))
    return out


def tagged_source_server(drs, cfg: Config) -> dict:
    """The one FAILOVER-direction source server carrying the project tag.

    The tag is the contract between the DRS setup step and the plan: it identifies *which*
    replicated instance this plan recovers. Anything else about the server (its id, the
    instance it currently protects) may change across fail-back cycles.
    """
    matches = [s for s in all_source_servers(drs)
               if s.get("tags", {}).get(cfg.tag_key) == cfg.tag_value
               and s.get("replicationDirection", "FAILOVER") == "FAILOVER"]
    if len(matches) != 1:
        raise StepFailed(f"expected exactly one FAILOVER source server tagged {cfg.tag_key}={cfg.tag_value}, "
                         f"found {len(matches)}: {[m.get('sourceServerID') for m in matches]}")
    return matches[0]


def protected_instance_id(source_server: dict) -> Optional[str]:
    return source_server.get("sourceProperties", {}).get("identificationHints", {}).get("awsInstanceID")


def replication_state(source_server: dict) -> str:
    return source_server.get("dataReplicationInfo", {}).get("dataReplicationState", "UNKNOWN")


def failback_servers(drs_origin) -> List[dict]:
    return [s for s in all_source_servers(drs_origin) if s.get("replicationDirection") == "FAILBACK"]


def failback_server_for(drs_origin, ec2_instance_id: str) -> Optional[dict]:
    """The origin-region FAILBACK server whose data source is this recovery instance.

    Keyed on ``identificationHints.awsInstanceID``, never on the forward server's
    ``reversedDirectionSourceServerArn``: DRS links failover/failback pairs bidirectionally
    and that ARN goes stale across cycles (live finding, 2026-09-10/11).
    """
    for s in failback_servers(drs_origin):
        if protected_instance_id(s) == ec2_instance_id:
            return s
    return None


# ---------------------------------------------------------------------------------------------
# Ownership. An account may run other DRS workloads in the same two Regions; the fail-back and
# retire steps must never select, stop, terminate or delete anything that is not this plan's.
# Ownership flows from the project tag on the forward source server(s): recovery instances are
# owned through the server that launched them, FAILBACK servers through the owned recovery
# instance that feeds them. No EC2 tag lookups; DRS alone is the source of truth.
# ---------------------------------------------------------------------------------------------

def project_source_servers(drs_secondary, cfg: Config) -> List[dict]:
    """Every FAILOVER-direction server this workload created in the secondary: the one the plan
    recovers (``tag_value``) and any a stateful re-protect left behind (``tag_value-retired``).
    A recovery instance launched from a retired server still belongs to this workload."""
    mine = {cfg.tag_value, f"{cfg.tag_value}-retired"}
    return [s for s in all_source_servers(drs_secondary)
            if s.get("tags", {}).get(cfg.tag_key) in mine
            and s.get("replicationDirection", "FAILOVER") == "FAILOVER"]


def owned_recovery_instances(drs_secondary, cfg: Config, states=None) -> List[dict]:
    """Recovery instances launched from this workload's source servers, in any EC2 state unless
    ``states`` narrows it. TERMINATED records are included on purpose: they are how a FAILBACK
    server stays linked to this workload across retire retries."""
    sids = {s["sourceServerID"] for s in project_source_servers(drs_secondary, cfg)}
    if not sids:
        return []
    items = drs_secondary.describe_recovery_instances(filters={"sourceServerIDs": sorted(sids)}).get("items", [])
    return [ri for ri in items
            if ri.get("sourceServerID") in sids and (states is None or ri.get("ec2InstanceState") in states)]


def owned_failback_servers(drs_origin, owned_recovery_ec2_ids) -> List[dict]:
    """FAILBACK-direction servers in the origin region whose data source is one of this workload's
    recovery instances (same key as :func:`failback_server_for`)."""
    ids = set(owned_recovery_ec2_ids)
    return [s for s in failback_servers(drs_origin) if protected_instance_id(s) in ids]


def recovery_instances(drs, source_server_id: Optional[str] = None, states=("RUNNING",),
                       include_drills: bool = False) -> List[dict]:
    filters = {"sourceServerIDs": [source_server_id]} if source_server_id else {}
    items = drs.describe_recovery_instances(filters=filters).get("items", [])
    return [ri for ri in items
            if ri.get("ec2InstanceState") in states and (include_drills or not ri.get("isDrill"))]


def one_running_recovery_instance(drs, source_server_id: str) -> dict:
    live = recovery_instances(drs, source_server_id)
    if len(live) != 1:
        raise StepFailed(f"expected exactly one RUNNING recovery instance for {source_server_id}, found {len(live)}")
    return live[0]


def latest_launch_job(drs, source_server_id: str) -> Optional[dict]:
    jobs = [j for j in drs.describe_jobs(filters={}).get("items", [])
            if j.get("type") == "LAUNCH"
            and any(p.get("sourceServerID") == source_server_id for p in j.get("participatingServers", []))]
    return max(jobs, key=lambda j: j["creationDateTime"]) if jobs else None


def launch_job_failure(drs, job: dict) -> Optional[str]:
    """DRS reports a failed launch only as COMPLETED + launchStatus=FAILED, with the reason
    buried in the job log. Return a human-readable error, or None if the job did not fail."""
    if job.get("status") != "COMPLETED":
        return None
    statuses = [p.get("launchStatus") for p in job.get("participatingServers", [])]
    if "FAILED" not in statuses:
        return None
    logs = drs.describe_job_log_items(jobID=job["jobID"]).get("items", [])
    raw = next((i["eventData"].get("rawError") for i in reversed(logs)
                if i.get("eventData", {}).get("rawError")), None)
    return f"DRS launch job {job['jobID']} FAILED (launchStatus={statuses}): {raw or [i.get('event') for i in logs]}"


# ---------------------------------------------------------------------------------------------
# ELB helpers
# ---------------------------------------------------------------------------------------------

def target_health(elb, target_group_arn: str, instance_id: Optional[str] = None) -> List[dict]:
    kwargs = {"TargetGroupArn": target_group_arn}
    if instance_id:
        kwargs["Targets"] = [{"Id": instance_id}]
    return elb.describe_target_health(**kwargs).get("TargetHealthDescriptions", [])


def ensure_registered_healthy(elb, target_group_arn: str, instance_id: str, port: int, step: str) -> dict:
    """Register once, then raise RetryLater until the target reports healthy."""
    mine = next((h for h in target_health(elb, target_group_arn) if h["Target"]["Id"] == instance_id), None)
    if mine is None:
        elb.register_targets(TargetGroupArn=target_group_arn, Targets=[{"Id": instance_id, "Port": port}])
        log(step, "registered target", instanceId=instance_id, targetGroupArn=target_group_arn)
        raise RetryLater(f"registered {instance_id}; awaiting health check")
    state = mine["TargetHealth"]["State"]
    if state != "healthy":
        raise RetryLater(f"{instance_id} target health is {state} ({mine['TargetHealth'].get('Reason')})")
    return mine


def deregister_all(elb, target_group_arn: str) -> int:
    targets = [{"Id": h["Target"]["Id"]} for h in target_health(elb, target_group_arn)]
    if targets:
        elb.deregister_targets(TargetGroupArn=target_group_arn, Targets=targets)
    return len(targets)


def now() -> float:  # indirection so tests can freeze time
    return time.time()
