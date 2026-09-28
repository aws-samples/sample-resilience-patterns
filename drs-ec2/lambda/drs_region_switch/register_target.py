"""Step ``register-target`` -- put the recovered EC2 behind the secondary ALB.

Runs in: activatingRegion. Mode: both. Runs after ``drs-recover-ec2`` and after the plan's
Aurora Global step, so the secondary cluster is already the writer.

  1. Point the app's DB-endpoint SSM parameter (in the secondary region) at the secondary writer,
     BEFORE the instance's app takes traffic. Idempotent (PutParameter Overwrite).
  2. Find the RUNNING recovery instance of the tagged source server -- via DRS, not tags.
  3. Register it into the secondary target group; RetryLater until the ALB reports healthy.
"""
from . import common as c

STEP = "register-target"


def handler(event, context):
    cfg = c.config()
    drs = c.client("drs", cfg.secondary_region)
    elb = c.client("elbv2", cfg.secondary_region)
    ssm = c.client("ssm", cfg.secondary_region)

    if cfg.secondary_db_endpoint:
        ssm.put_parameter(Name=cfg.db_param_name, Value=cfg.secondary_db_endpoint, Type="String", Overwrite=True)

    src = c.tagged_source_server(drs, cfg)
    ri = c.one_running_recovery_instance(drs, src["sourceServerID"])
    iid = ri["ec2InstanceID"]

    mine = c.ensure_registered_healthy(elb, cfg.secondary_target_group_arn, iid, cfg.target_port, STEP)
    c.log(STEP, "target healthy", instanceId=iid, targetGroupArn=cfg.secondary_target_group_arn)
    return {"status": "healthy", "instanceId": iid, "targetGroupArn": cfg.secondary_target_group_arn,
            "dbParameter": cfg.db_param_name if cfg.secondary_db_endpoint else None,
            "targetHealth": mine["TargetHealth"]["State"]}
