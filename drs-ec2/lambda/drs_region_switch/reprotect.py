"""Step ``drs-reprotect`` -- make the failed-back EC2 the protected primary again.

Runs in: deactivatingRegion. Mode: stateful only. Runs after Aurora/DNS have moved back.

``ReverseReplication`` on the failed-back recovery instance (in the primary) re-points the
EXISTING forward source server (in the secondary) at it: same source-server id, same replication
server; DRS goes STALLED/AGENT_NOT_SEEN briefly, then RESCAN, then CONTINUOUS.

State machine:
  1. "has re-protect started?" -- read the failback recovery instance's OWN
     ``dataReplicationInfo.dataReplicationState``: NOT_STARTED means ReverseReplication has not
     been called. (Do NOT infer from the forward server's identificationHints matching the
     instance id: with launch-into-source the id never changed, so the stale pre-failover pairing
     matches and you wait forever on a dead server. Live finding, 2026-09-14.)
       -> ReverseReplication(recoveryInstanceID); RetryLater
  2. forward server not CONTINUOUS -> RetryLater
  3. CONTINUOUS but RESCAN not complete -> RetryLater. Completion is
     ``rescannedStorageBytes == totalStorageBytes`` on every disk with zero lag. (The DRS API has
     no ``lastSnapshotDateTime`` field; an earlier guard read one and could never pass.)
  4. done; if DRS created a distinct server instead of re-pointing, move the project tag to it.
"""
from . import common as c

STEP = "drs-reprotect"


def handler(event, context):
    cfg = c.config()
    if not cfg.stateful_ec2:
        return {"status": "SKIPPED", "reason": "STATEFUL_EC2 is not true"}

    drs_sec = c.client("drs", cfg.secondary_region)
    drs_pri = c.client("drs", cfg.primary_region)

    fwd = c.tagged_source_server(drs_sec, cfg)
    ri_sec = c.recovery_instances(drs_sec, fwd["sourceServerID"], states=("RUNNING",))
    if len(ri_sec) != 1:
        raise c.StepFailed(f"expected exactly one RUNNING recovery instance in {cfg.secondary_region}, found {len(ri_sec)}")
    rev = c.failback_server_for(drs_pri, ri_sec[0]["ec2InstanceID"])
    if rev is None:
        raise c.StepFailed("FAILBACK source server missing; fail-back chain incomplete")
    ri_pri = c.one_running_recovery_instance(drs_pri, rev["sourceServerID"])
    failedback_ec2 = ri_pri["ec2InstanceID"]

    started = ri_pri.get("dataReplicationInfo", {}).get("dataReplicationState", "NOT_STARTED") != "NOT_STARTED"
    if not started:
        try:
            resp = drs_pri.reverse_replication(recoveryInstanceID=ri_pri["recoveryInstanceID"])
        except drs_pri.exceptions.ConflictException as e:
            raise c.RetryLater(f"failback instance {failedback_ec2} still initializing: {e}") from e
        c.log(STEP, "started re-protect", instanceId=failedback_ec2, reversedArn=resp.get("reversedDirectionSourceServerArn"))
        raise c.RetryLater(f"started re-protect replication for {failedback_ec2}")

    # Which secondary-region server now protects the failed-back instance? Normally the same
    # forward server, re-pointed; DRS may create a distinct one in other topologies.
    new = next((s for s in c.all_source_servers(drs_sec) if c.protected_instance_id(s) == failedback_ec2), None)
    if new is None:
        raise c.RetryLater("re-protect started; source server not yet re-pointed")

    info = new.get("dataReplicationInfo", {})
    state = info.get("dataReplicationState")
    if state != "CONTINUOUS":
        raise c.RetryLater(f"re-protect replication {state}; eta={info.get('etaDateTime')} lag={info.get('lagDuration')}")
    disks = info.get("replicatedDisks", [])
    rescanned = bool(disks) and all(d.get("rescannedStorageBytes", 0) >= d.get("totalStorageBytes", 1) for d in disks)
    if not (rescanned and _lag_zero(info.get("lagDuration"))):
        raise c.RetryLater(f"re-pointed; RESCAN not complete (rescanned={[d.get('rescannedStorageBytes') for d in disks]} "
                           f"lag={info.get('lagDuration')})")

    if new.get("tags", {}).get(cfg.tag_key) != cfg.tag_value:
        drs_sec.tag_resource(resourceArn=new["arn"], tags={cfg.tag_key: cfg.tag_value})
        if fwd["sourceServerID"] != new["sourceServerID"]:
            drs_sec.tag_resource(resourceArn=fwd["arn"], tags={cfg.tag_key: f"{cfg.tag_value}-retired"})

    c.log(STEP, "re-protected", instanceId=failedback_ec2, sourceServerID=new["sourceServerID"])
    return {"status": "CONTINUOUS", "protectedInstanceId": failedback_ec2, "sourceServerID": new["sourceServerID"],
            "retiredSourceServerID": fwd["sourceServerID"] if fwd["sourceServerID"] != new["sourceServerID"] else None}


def _lag_zero(lag) -> bool:
    lag = lag or "P0D"
    return lag in ("P0D", "PT0S") or (lag.startswith("PT") and "H" not in lag and "M" not in lag)
