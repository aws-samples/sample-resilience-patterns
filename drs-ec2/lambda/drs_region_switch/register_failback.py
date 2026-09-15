"""Step ``register-failback-target`` -- put the failed-back EC2 behind the primary ALB.

Runs in: deactivatingRegion. Mode: stateful only.

The instance is found through DRS -- the RUNNING recovery instance of the origin-region FAILBACK
server -- which covers both forms: with launch-into-source it is the ORIGINAL primary (untagged
by us, already registered, so this is a health verification); with the new-instance form it is
the fresh EC2 that needs registering.
"""
from . import common as c

STEP = "register-failback-target"


def handler(event, context):
    cfg = c.config()
    if not cfg.stateful_ec2:
        return {"status": "SKIPPED", "reason": "STATEFUL_EC2 is not true"}

    drs_pri = c.client("drs", cfg.primary_region)
    elb_pri = c.client("elbv2", cfg.primary_region)

    fb = c.failback_servers(drs_pri)
    if not fb:
        raise c.StepFailed("no FAILBACK source server in the primary region; did drs-reverse-replicate run?")
    live = [ri for s in fb for ri in c.recovery_instances(drs_pri, s["sourceServerID"], states=("RUNNING",))]
    if not live:
        raise c.StepFailed("no RUNNING failback recovery instance; did drs-failback-launch run?")
    iid = sorted(ri["ec2InstanceID"] for ri in live)[-1]

    mine = c.ensure_registered_healthy(elb_pri, cfg.primary_target_group_arn, iid, cfg.target_port, STEP)
    others = [h["Target"]["Id"] for h in c.target_health(elb_pri, cfg.primary_target_group_arn) if h["Target"]["Id"] != iid]
    c.log(STEP, "failback target healthy", instanceId=iid, otherTargets=others)
    return {"status": "healthy", "instanceId": iid, "targetGroupArn": cfg.primary_target_group_arn,
            "targetHealth": mine["TargetHealth"]["State"], "otherTargets": others}
