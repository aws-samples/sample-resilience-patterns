"""Step ``drs-recover-ec2`` -- launch the DRS recovery instance in the activating (secondary) region.

Runs in: activatingRegion. Mode: both.

State machine (ARC retries drive it):
  1. a RUNNING recovery instance exists for the tagged source server
       - launched by the job THIS cycle started (job id recorded on the source server) -> done
       - otherwise it is a leftover from an earlier cycle:
           stateless -> adopt it (warm standby; a stale clone is fine for a stateless tier)
           stateful  -> StepFailed: its disks are a clone from an earlier cycle, not the current
                        primary. ``drs-retire`` removes it after every fail-back, so this only
                        fires if something was left behind.
  2. a recovery instance is PENDING, or a LAUNCH job is in flight -> RetryLater
  3. the job we started COMPLETED with launchStatus=FAILED -> StepFailed with the job-log reason
  4. otherwise -> StartRecovery(isDrill=False), record its job id, RetryLater

Cycle state lives on the DRS source server as tag ``<project>:recovery-job`` (this step writes
it, ``drs-retire`` removes it). Lambda invocations carry no state between ARC retries.
"""
from . import common as c

STEP = "drs-recover-ec2"


def job_tag_key(cfg: c.Config) -> str:
    return f"{cfg.project}:recovery-job"


def handler(event, context):
    cfg = c.config()
    drs = c.client("drs", cfg.secondary_region)
    ec2 = c.client("ec2", cfg.secondary_region)

    src = c.tagged_source_server(drs, cfg)
    sid = src["sourceServerID"]
    our_job = src.get("tags", {}).get(job_tag_key(cfg))

    live = c.recovery_instances(drs, sid, states=("RUNNING",))
    if live:
        ri = live[0]
        ours = bool(our_job) and ri.get("jobID") == our_job
        if not ours and cfg.stateful_ec2:
            raise c.StepFailed(
                f"stateful mode: recovery instance {ri['ec2InstanceID']} was not launched by this cycle "
                f"(job {ri.get('jobID')} != {our_job}); it would serve stale state. Run drs-retire and retry.")
        return _done(ec2, cfg, sid, ri["ec2InstanceID"], adopted=not ours)

    if c.recovery_instances(drs, sid, states=("PENDING",)):
        raise c.RetryLater("recovery instance is PENDING")

    if our_job:
        jobs = drs.describe_jobs(filters={"jobIDs": [our_job]}).get("items", [])
        job = jobs[0] if jobs else None
        if job and job.get("status") != "COMPLETED":
            raise c.RetryLater(f"launch job {our_job} is {job['status']}")
        if job:
            err = c.launch_job_failure(drs, job)
            if err:
                raise c.StepFailed(err + " -- common cause: the caller lacks the EC2 permissions DRS exercises on its behalf")
            # COMPLETED + LAUNCHED but no live instance (terminated out of band): fall through and relaunch.

    new = drs.start_recovery(sourceServers=[{"sourceServerID": sid}], isDrill=False)["job"]
    drs.tag_resource(resourceArn=src["arn"], tags={job_tag_key(cfg): new["jobID"]})
    c.log(STEP, "started recovery", jobId=new["jobID"], sourceServerID=sid)
    raise c.RetryLater(f"started recovery job {new['jobID']}")


def _done(ec2, cfg, sid, instance_id, adopted):
    ec2.create_tags(Resources=[instance_id], Tags=[
        {"Key": "Name", "Value": f"{cfg.project}-app-recovered"},
        {"Key": cfg.tag_key, "Value": f"{cfg.tag_value}-recovered"},
    ])
    c.log(STEP, "recovery instance running", instanceId=instance_id, sourceServerID=sid, adopted=adopted)
    return {"status": "RUNNING", "instanceId": instance_id, "sourceServerID": sid, "adopted": adopted}
