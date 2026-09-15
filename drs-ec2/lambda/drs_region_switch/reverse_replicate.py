"""Step ``drs-reverse-replicate`` -- copy the recovery instance's disks back toward the primary.

Runs in: deactivatingRegion (the secondary, where the recovery instance lives). Mode: stateful
only (returns SKIPPED otherwise).

Closes the data gap for a stateful EC2 tier: state written while the recovery instance carried
traffic exists only on its EBS volumes in the secondary. DRS does not copy it back on its own.

State machine:
  1. no FAILBACK-direction server in the primary whose data source is THIS recovery instance
       -> ReverseReplication(recoveryInstanceID); RetryLater
       (ConflictException "not finished initializing" = agent still starting -> RetryLater)
  2. FAILBACK server exists, not CONTINUOUS -> RetryLater with progress
  3. CONTINUOUS -> done

Idempotency key: the FAILBACK server's ``identificationHints.awsInstanceID`` == the recovery
instance's EC2 id. NOT the forward server's ``reversedDirectionSourceServerArn`` (stale across
cycles). Nothing sleeps: the full block copy takes tens of minutes; ARC's retry loop polls.
"""
from . import common as c

STEP = "drs-reverse-replicate"


def handler(event, context):
    cfg = c.config()
    if not cfg.stateful_ec2:
        return {"status": "SKIPPED", "reason": "STATEFUL_EC2 is not true; EC2 tier is stateless"}

    drs_sec = c.client("drs", cfg.secondary_region)
    drs_pri = c.client("drs", cfg.primary_region)

    fwd = c.tagged_source_server(drs_sec, cfg)
    ri = c.one_running_recovery_instance(drs_sec, fwd["sourceServerID"])

    rev = c.failback_server_for(drs_pri, ri["ec2InstanceID"])
    if rev is None:
        try:
            resp = drs_sec.reverse_replication(recoveryInstanceID=ri["recoveryInstanceID"])
        except drs_sec.exceptions.ConflictException as e:
            raise c.RetryLater(f"recovery instance still initializing: {e}") from e
        c.log(STEP, "started reversed replication", recoveryInstanceID=ri["recoveryInstanceID"],
              reversedArn=resp.get("reversedDirectionSourceServerArn"))
        raise c.RetryLater("started reversed replication; full block copy in progress")

    info = rev.get("dataReplicationInfo", {})
    state = info.get("dataReplicationState")
    if state != "CONTINUOUS":
        done = sum(1 for d in info.get("replicatedDisks", []) if d.get("replicatedStorageBytes"))
        raise c.RetryLater(f"reversed replication {state}; disks with progress={done}; "
                           f"eta={info.get('etaDateTime')} lag={info.get('lagDuration')}")

    c.log(STEP, "reversed replication continuous", failbackServerID=rev["sourceServerID"])
    return {"status": "CONTINUOUS", "failbackSourceServerID": rev["sourceServerID"],
            "recoveryInstanceId": ri["ec2InstanceID"], "region": cfg.primary_region}
