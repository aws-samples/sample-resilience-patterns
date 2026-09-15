import pytest

from drs_region_switch import common as c
from drs_region_switch import recover, register_target
from tests.conftest import (PRIMARY, SECONDARY, SEC_TG, forward_server, recovery_instance, target)


def test_recover_starts_job_and_records_it(world):
    world.source_servers[SECONDARY] = [forward_server()]
    with pytest.raises(c.RetryLater, match="started recovery job"):
        recover.handler({}, None)
    assert world.calls("drs", SECONDARY, "start_recovery")[0][1] == {
        "sourceServers": [{"sourceServerID": "s-fwd"}], "isDrill": False}
    tag = world.calls("drs", SECONDARY, "tag_resource")[0][1]
    assert tag["tags"] == {"drsdemo:recovery-job": f"job-new-{SECONDARY}"}


def test_recover_waits_on_own_job_and_does_not_start_another(world):
    world.source_servers[SECONDARY] = [forward_server(tags={"drsdemo:recovery-job": "job-1"})]
    world.jobs[SECONDARY] = [{"jobID": "job-1", "type": "LAUNCH", "status": "STARTED",
                              "participatingServers": [{"sourceServerID": "s-fwd"}]}]
    with pytest.raises(c.RetryLater, match="job-1 is STARTED"):
        recover.handler({}, None)
    assert not world.calls("drs", SECONDARY, "start_recovery")


def test_recover_surfaces_failed_launch_with_job_log(world):
    world.source_servers[SECONDARY] = [forward_server(tags={"drsdemo:recovery-job": "job-1"})]
    world.jobs[SECONDARY] = [{"jobID": "job-1", "type": "LAUNCH", "status": "COMPLETED",
                              "participatingServers": [{"sourceServerID": "s-fwd", "launchStatus": "FAILED"}]}]
    world.job_logs["job-1"] = [{"event": "LAUNCH_FAILED", "eventData": {"rawError": "UnauthorizedOperation"}}]
    with pytest.raises(c.StepFailed, match="UnauthorizedOperation"):
        recover.handler({}, None)


def test_recover_done_when_own_instance_running(world):
    world.source_servers[SECONDARY] = [forward_server(tags={"drsdemo:recovery-job": "job-1"})]
    world.recovery_instances[SECONDARY] = [recovery_instance("i-rec", "s-fwd", job_id="job-1")]
    out = recover.handler({}, None)
    assert out == {"status": "RUNNING", "instanceId": "i-rec", "sourceServerID": "s-fwd", "adopted": False}
    assert world.calls("ec2", SECONDARY, "create_tags")


def test_recover_stateless_adopts_leftover_instance(world):
    world.source_servers[SECONDARY] = [forward_server()]
    world.recovery_instances[SECONDARY] = [recovery_instance("i-old", "s-fwd", job_id="job-old")]
    out = recover.handler({}, None)
    assert out["adopted"] is True and out["instanceId"] == "i-old"
    assert not world.calls("drs", SECONDARY, "start_recovery")


def test_recover_stateful_refuses_leftover_instance(world, stateful):
    # A leftover clone would serve stale state. Live finding 2026-09-11.
    world.source_servers[SECONDARY] = [forward_server()]
    world.recovery_instances[SECONDARY] = [recovery_instance("i-old", "s-fwd", job_id="job-old")]
    with pytest.raises(c.StepFailed, match="stale state"):
        recover.handler({}, None)


def test_recover_requires_exactly_one_tagged_server(world):
    world.source_servers[SECONDARY] = [forward_server(sid="s-1"), forward_server(sid="s-2")]
    with pytest.raises(c.StepFailed, match="expected exactly one"):
        recover.handler({}, None)


def test_register_target_repoints_db_and_registers_then_waits(world):
    world.source_servers[SECONDARY] = [forward_server()]
    world.recovery_instances[SECONDARY] = [recovery_instance("i-rec", "s-fwd")]
    with pytest.raises(c.RetryLater, match="awaiting health check"):
        register_target.handler({}, None)
    assert world.calls("ssm", SECONDARY, "put_parameter")[0][1]["Value"] == "db.usw2.example"
    reg = world.calls("elbv2", SECONDARY, "register_targets")[0][1]
    assert reg["Targets"] == [{"Id": "i-rec", "Port": 8080}] and reg["TargetGroupArn"] == SEC_TG


def test_register_target_returns_when_healthy(world):
    world.source_servers[SECONDARY] = [forward_server()]
    world.recovery_instances[SECONDARY] = [recovery_instance("i-rec", "s-fwd")]
    world.targets[SEC_TG] = [target("i-rec", "healthy")]
    out = register_target.handler({}, None)
    assert out["status"] == "healthy" and out["instanceId"] == "i-rec"
    assert not world.calls("elbv2", SECONDARY, "register_targets")
