"""Step ``drs-failback-launch`` -- launch the failed-back EC2 in the primary from the FAILBACK server.

Runs in: deactivatingRegion. Mode: stateful only.

Two forms, chosen by DRS from the FAILBACK server's launch configuration:
  * launch-into-source-instance (``launchIntoEC2InstanceID`` set -- the default when the primary
    region's launch template has ``launchIntoSourceInstance=true`` and the original EC2 carries
    ``AWSDRS=AllowLaunchingIntoThisInstance`` and boots BIOS): DRS swaps the ORIGINAL instance's
    volumes. Same instance id, same tags, same target-group membership. **The target must be
    STOPPED first** (undocumented; ConflictException otherwise) -- this step stops it.
  * new-instance form: DRS launches a fresh EC2 from the FAILBACK server's launch template; this
    step makes sure that template has a subnet, security group and instance profile (DRS's
    auto-created template has none) and tags the new instance.

State machine:
  1. RUNNING recovery instance of the FAILBACK server exists -> done (tag only in new-instance form)
  2. PENDING instance or in-flight LAUNCH job -> RetryLater
  3. latest LAUNCH job FAILED -> StepFailed with the job-log reason
  4. launch-into target RUNNING -> StopInstances, RetryLater; STOPPING -> RetryLater
  5. StartRecovery(isDrill=False) -> RetryLater
"""
from . import common as c

STEP = "drs-failback-launch"


def handler(event, context):
    cfg = c.config()
    if not cfg.stateful_ec2:
        return {"status": "SKIPPED", "reason": "STATEFUL_EC2 is not true"}

    drs_sec = c.client("drs", cfg.secondary_region)
    drs_pri = c.client("drs", cfg.primary_region)
    ec2_pri = c.client("ec2", cfg.primary_region)

    fwd = c.tagged_source_server(drs_sec, cfg)
    ri_sec = c.one_running_recovery_instance(drs_sec, fwd["sourceServerID"])
    rev = c.failback_server_for(drs_pri, ri_sec["ec2InstanceID"])
    if rev is None:
        raise c.StepFailed(f"no FAILBACK source server for recovery instance {ri_sec['ec2InstanceID']} "
                           f"in {cfg.primary_region}; did drs-reverse-replicate run?")
    sid = rev["sourceServerID"]
    target = drs_pri.get_launch_configuration(sourceServerID=sid) \
        .get("launchIntoInstanceProperties", {}).get("launchIntoEC2InstanceID")

    live = c.recovery_instances(drs_pri, sid, states=("RUNNING",))
    if live:
        iid = live[0]["ec2InstanceID"]
        if iid != target:
            # New-instance form only. With launch-into, the "recovery instance" IS the original,
            # CloudFormation/Terraform-managed EC2 -- leave its tags alone.
            ec2_pri.create_tags(Resources=[iid], Tags=[
                {"Key": "Name", "Value": f"{cfg.project}-app-failedback"},
                {"Key": cfg.tag_key, "Value": f"{cfg.tag_value}-failedback"},
            ])
        c.log(STEP, "failback instance running", instanceId=iid, launchedInto=iid == target)
        return {"status": "RUNNING", "instanceId": iid, "launchedInto": iid == target,
                "recoveryInstanceID": live[0]["recoveryInstanceID"], "failbackSourceServerID": sid}
    if c.recovery_instances(drs_pri, sid, states=("PENDING",)):
        raise c.RetryLater("failback instance is PENDING")

    job = c.latest_launch_job(drs_pri, sid)
    if job and job.get("status") != "COMPLETED":
        raise c.RetryLater(f"failback launch job {job['jobID']} is {job['status']}")
    if job:
        err = c.launch_job_failure(drs_pri, job)
        if err:
            raise c.StepFailed(err)
        # COMPLETED+LAUNCHED but no live instance: launch again below.

    if target:
        _ensure_stopped(ec2_pri, target)
    else:
        _ensure_launch_template(drs_pri, ec2_pri, cfg, sid)

    new = drs_pri.start_recovery(sourceServers=[{"sourceServerID": sid}], isDrill=False)["job"]
    c.log(STEP, "started failback launch", jobId=new["jobID"], failbackSourceServerID=sid, launchInto=target)
    raise c.RetryLater(f"started failback launch job {new['jobID']}")


def _ensure_stopped(ec2, instance_id):
    """DRS refuses to launch into a running instance. The target is the idle old primary (traffic
    is in the secondary), so stopping it is safe; DRS swaps its volumes and starts it again."""
    state = ec2.describe_instances(InstanceIds=[instance_id])["Reservations"][0]["Instances"][0]["State"]["Name"]
    if state == "stopped":
        return
    if state == "running":
        ec2.stop_instances(InstanceIds=[instance_id])
        c.log(STEP, "stopping launch-into target", instanceId=instance_id)
        raise c.RetryLater(f"stopping launch-into target {instance_id} (required by DRS)")
    raise c.RetryLater(f"launch-into target {instance_id} is {state}; waiting for stopped")


def _ensure_launch_template(drs, ec2, cfg, sid):
    """New-instance form: DRS's auto-created template has no network/profile -- add ours."""
    lt_id = drs.get_launch_configuration(sourceServerID=sid)["ec2LaunchTemplateID"]
    cur = ec2.describe_launch_template_versions(LaunchTemplateId=lt_id, Versions=["$Default"]
                                                )["LaunchTemplateVersions"][0]["LaunchTemplateData"]
    nics = cur.get("NetworkInterfaces") or []
    if nics and nics[0].get("SubnetId") == cfg.primary_subnet_id and cur.get("InstanceType") == cfg.instance_type:
        return
    v = ec2.create_launch_template_version(
        LaunchTemplateId=lt_id, SourceVersion="$Default",
        LaunchTemplateData={
            "InstanceType": cfg.instance_type,
            "IamInstanceProfile": {"Arn": cfg.app_instance_profile_arn},
            "NetworkInterfaces": [{"DeviceIndex": 0, "SubnetId": cfg.primary_subnet_id,
                                   "Groups": [cfg.primary_app_sg_id], "AssociatePublicIpAddress": False}],
        })["LaunchTemplateVersion"]["VersionNumber"]
    ec2.modify_launch_template(LaunchTemplateId=lt_id, DefaultVersion=str(v))
    drs.update_launch_configuration(sourceServerID=sid, targetInstanceTypeRightSizingMethod="NONE")
    c.log(STEP, "launch template configured", launchTemplateId=lt_id, version=v)
