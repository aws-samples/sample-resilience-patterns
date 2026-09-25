"""Step ``drs-retire`` -- return the estate to its resting state so the next cycle is identical.

Runs in: deactivatingRegion. Mode: BOTH (always the last fail-back step).

Resting-state invariant after this step:
  * exactly one FAILOVER source server carrying the project tag, protecting the primary EC2,
    CONTINUOUS;
  * no recovery instances in either region; no FAILBACK-direction source servers;
  * the secondary target group is empty;
  * the per-cycle recovery-job tag is cleared.

Order follows the DRS cross-region failback guide ("Clean your environment"):
  1. stop replication on the FAILBACK source server(s) in the primary -- required before the
     recovery instance that feeds them can be terminated ("cannot be terminated during failback");
  2. stop-failback + terminate the recovery instance(s) in the secondary;
  3. delete the primary-side recovery-instance RECORD ("Delete server", never terminate -- with
     launch-into-source that record IS the live primary EC2), then disconnect + delete the
     FAILBACK source server(s);
  4. deregister stale targets from the secondary target group.
Idempotent; RetryLater while DRS is still winding things down.
"""
from . import common as c
from .recover import job_tag_key

STEP = "drs-retire"


def handler(event, context):
    cfg = c.config()
    drs_sec = c.client("drs", cfg.secondary_region)
    drs_pri = c.client("drs", cfg.primary_region)
    elb_sec = c.client("elbv2", cfg.secondary_region)

    fwd = c.tagged_source_server(drs_sec, cfg)
    keep_ec2 = c.protected_instance_id(fwd)
    if c.replication_state(fwd) != "CONTINUOUS":
        raise c.RetryLater("forward protection of the primary is not CONTINUOUS yet; not retiring anything")

    pending = []

    # 1. FAILBACK servers in the primary: stop replication.
    fb = c.failback_servers(drs_pri)
    for s in fb:
        if c.replication_state(s) not in ("STOPPED", "DISCONNECTED"):
            _try(pending, f"stop_replication {s['sourceServerID']}",
                 lambda s=s: drs_pri.stop_replication(sourceServerID=s["sourceServerID"]))

    # 2. Recovery instances in the secondary: stop failback, terminate.
    for ri in drs_sec.describe_recovery_instances(filters={}).get("items", []):
        if ri.get("ec2InstanceState") == "TERMINATED":
            continue
        if ri.get("failback", {}).get("state", "FAILBACK_NOT_STARTED") != "FAILBACK_NOT_STARTED":
            _try(pending, f"stop_failback {ri.get('recoveryInstanceID')}",
                 lambda ri=ri: drs_sec.stop_failback(recoveryInstanceID=ri["recoveryInstanceID"]), best_effort=True)
        _try(pending, f"terminate {ri.get('ec2InstanceID')} (failback winding down)",
             lambda ri=ri: drs_sec.terminate_recovery_instances(recoveryInstanceIDs=[ri["recoveryInstanceID"]]))
        pending.append(f"terminating recovery instance {ri.get('ec2InstanceID')} in {cfg.secondary_region}")

    # 3. Primary: delete recovery RECORDS (never terminate -- may be the live primary), then the FAILBACK servers.
    for ri in drs_pri.describe_recovery_instances(filters={}).get("items", []):
        if ri.get("ec2InstanceID") == keep_ec2 or ri.get("ec2InstanceState") != "TERMINATED":
            _try(pending, f"delete primary recovery record {ri['recoveryInstanceID']}",
                 lambda ri=ri: drs_pri.delete_recovery_instance(recoveryInstanceID=ri["recoveryInstanceID"]))
    for s in fb:
        _try(pending, f"disconnect {s['sourceServerID']}",
             lambda s=s: drs_pri.disconnect_source_server(sourceServerID=s["sourceServerID"]), best_effort=True)
        _try(pending, f"delete FAILBACK server {s['sourceServerID']}",
             lambda s=s: drs_pri.delete_source_server(sourceServerID=s["sourceServerID"]))

    # 4. Secondary target group must be empty at rest.
    n = c.deregister_all(elb_sec, cfg.secondary_target_group_arn)
    if n:
        pending.append(f"deregistered {n} stale target(s) from the secondary target group")

    # 5. Clear the per-cycle recovery-job marker so the next drs-recover-ec2 starts clean.
    if job_tag_key(cfg) in fwd.get("tags", {}):
        _try(pending, "untag recovery-job", lambda: drs_sec.untag_resource(resourceArn=fwd["arn"], tagKeys=[job_tag_key(cfg)]))

    leftovers = []
    if c.recovery_instances(drs_sec, None, states=("RUNNING", "PENDING", "STOPPED", "STOPPING", "SHUTTING-DOWN")):
        leftovers.append("secondary recovery instance(s) still present")
    if c.failback_servers(drs_pri):
        leftovers.append("FAILBACK source server(s) still present in the primary")
    if leftovers or pending:
        raise c.RetryLater("; ".join(leftovers + pending))

    c.log(STEP, "retired", protectedPrimary=keep_ec2, forwardSourceServer=fwd["sourceServerID"])
    return {"status": "RETIRED", "protectedPrimary": keep_ec2, "forwardSourceServer": fwd["sourceServerID"]}


def _try(pending, what, fn, best_effort=False):
    """Run one cleanup call. Every failure is logged; unless ``best_effort``, it is also appended to
    ``pending`` so the step raises RetryLater and ARC retries. Best-effort calls (stop-failback on an
    instance DRS is already tearing down, disconnect before delete) are allowed to fail without
    blocking the retire, but never silently."""
    try:
        fn()
    except Exception as e:  # DRS is winding down; report and let ARC retry
        c.log(STEP, "cleanup call failed", call=what, error=str(e), bestEffort=best_effort)
        if not best_effort:
            pending.append(f"{what}: {e}")
