import json

import pytest

from drs_region_switch import common as c
from drs_region_switch import failback_launch, register_failback, reprotect, retire, reverse_replicate
from tests.conftest import (PRIMARY, PRI_TG, SECONDARY, SEC_TG, failback_server, forward_server,
                            recovery_instance, target)


def _failover_estate(world, launch_into=None, failback_state=None, pri_repl_state=None):
    """Post-failover: recovery instance i-rec serving in the secondary; FAILBACK server in the primary."""
    world.source_servers[SECONDARY] = [forward_server(instance_id="i-primary")]
    world.recovery_instances[SECONDARY] = [recovery_instance("i-rec", "s-fwd", failback_state=failback_state)]
    world.source_servers[PRIMARY] = [failback_server(instance_id="i-rec")]
    if launch_into:
        world.launch_configs["s-fb"] = {"ec2LaunchTemplateID": "lt-1",
                                        "launchIntoInstanceProperties": {"launchIntoEC2InstanceID": launch_into}}


# ---- stateless: every stateful step is a fast no-op ----------------------------------------

@pytest.mark.parametrize("mod", [reverse_replicate, failback_launch, register_failback, reprotect])
def test_stateful_steps_skip_when_stateless(world, mod):
    assert mod.handler({}, None)["status"] == "SKIPPED"


# ---- reverse-replicate ---------------------------------------------------------------------

def test_reverse_replicate_starts_once_keyed_on_instance_id(world, stateful):
    world.source_servers[SECONDARY] = [forward_server()]
    world.recovery_instances[SECONDARY] = [recovery_instance("i-rec", "s-fwd")]
    # a FAILBACK server for a DIFFERENT (previous-cycle) instance must not count as "done"
    world.source_servers[PRIMARY] = [failback_server(instance_id="i-old-cycle", sid="s-old")]
    with pytest.raises(c.RetryLater, match="started reversed replication"):
        reverse_replicate.handler({}, None)
    assert world.calls("drs", SECONDARY, "reverse_replication")[0][1] == {"recoveryInstanceID": "ri-i-rec"}


def test_reverse_replicate_conflict_is_retry(world, stateful):
    world.source_servers[SECONDARY] = [forward_server()]
    world.recovery_instances[SECONDARY] = [recovery_instance("i-rec", "s-fwd")]
    world.initializing.add("ri-i-rec")
    with pytest.raises(c.RetryLater, match="still initializing"):
        reverse_replicate.handler({}, None)


def test_reverse_replicate_done_when_continuous(world, stateful):
    _failover_estate(world)
    out = reverse_replicate.handler({}, None)
    assert out["status"] == "CONTINUOUS" and out["failbackSourceServerID"] == "s-fb"
    assert not world.calls("drs", SECONDARY, "reverse_replication")


# ---- failback-launch -----------------------------------------------------------------------

def test_failback_launch_stops_launch_into_target_first(world, stateful):
    # DRS: "needs to be in a stopped state but is in a running state". Live 2026-09-14.
    _failover_estate(world, launch_into="i-primary")
    world.ec2_state["i-primary"] = "running"
    with pytest.raises(c.RetryLater, match="stopping launch-into target"):
        failback_launch.handler({}, None)
    assert world.calls("ec2", PRIMARY, "stop_instances")[0][1] == {"InstanceIds": ["i-primary"]}
    assert not world.calls("drs", PRIMARY, "start_recovery")


def test_failback_launch_starts_when_target_stopped(world, stateful):
    _failover_estate(world, launch_into="i-primary")
    world.ec2_state["i-primary"] = "stopped"
    with pytest.raises(c.RetryLater, match="started failback launch job"):
        failback_launch.handler({}, None)
    assert world.calls("drs", PRIMARY, "start_recovery")[0][1]["sourceServers"] == [{"sourceServerID": "s-fb"}]


def test_failback_launch_does_not_retag_original_instance(world, stateful):
    _failover_estate(world, launch_into="i-primary")
    world.recovery_instances[PRIMARY] = [recovery_instance("i-primary", "s-fb")]
    out = failback_launch.handler({}, None)
    assert out["launchedInto"] is True and out["instanceId"] == "i-primary"
    assert not world.calls("ec2", PRIMARY, "create_tags")


def test_failback_launch_new_instance_form_fixes_template_and_tags(world, stateful):
    _failover_estate(world)  # no launchInto
    world.launch_template_data = {}  # DRS auto template: no subnet/profile
    with pytest.raises(c.RetryLater, match="started failback launch job"):
        failback_launch.handler({}, None)
    assert world.calls("ec2", PRIMARY, "create_launch_template_version")
    world.recovery_instances[PRIMARY] = [recovery_instance("i-new", "s-fb")]
    out = failback_launch.handler({}, None)
    assert out["launchedInto"] is False
    assert world.calls("ec2", PRIMARY, "create_tags")[0][1]["Resources"] == ["i-new"]


def test_failback_launch_failed_job_is_step_failure(world, stateful):
    _failover_estate(world, launch_into="i-primary")
    world.jobs[PRIMARY] = [{"jobID": "job-x", "type": "LAUNCH", "status": "COMPLETED", "creationDateTime": "2026-09-14T18:11:11",
                            "participatingServers": [{"sourceServerID": "s-fb", "launchStatus": "FAILED"}]}]
    world.job_logs["job-x"] = [{"event": "LAUNCH_END", "eventData": {"rawError": "boom"}}]
    with pytest.raises(c.StepFailed, match="boom"):
        failback_launch.handler({}, None)


# ---- register-failback-target ---------------------------------------------------------------

def test_register_failback_finds_instance_via_drs_not_tags(world, stateful):
    _failover_estate(world, launch_into="i-primary")
    world.recovery_instances[PRIMARY] = [recovery_instance("i-primary", "s-fb")]
    world.targets[PRI_TG] = [target("i-primary", "healthy")]
    out = register_failback.handler({}, None)
    assert out["instanceId"] == "i-primary" and out["status"] == "healthy"
    assert not world.calls("elbv2", PRIMARY, "register_targets")  # launch-into: already registered


# ---- reprotect -----------------------------------------------------------------------------

def test_reprotect_starts_from_recovery_instance_state_not_instance_id_match(world, stateful):
    # launch-into keeps the id: forward server's hints still say i-primary. Must still call
    # ReverseReplication because the failback recovery instance reports NOT_STARTED. Live 2026-09-14.
    _failover_estate(world, launch_into="i-primary")
    world.source_servers[SECONDARY] = [forward_server(instance_id="i-primary", state="STALLED")]
    world.recovery_instances[PRIMARY] = [recovery_instance("i-primary", "s-fb", repl_state="NOT_STARTED")]
    with pytest.raises(c.RetryLater, match="started re-protect"):
        reprotect.handler({}, None)
    assert world.calls("drs", PRIMARY, "reverse_replication")[0][1] == {"recoveryInstanceID": "ri-i-primary"}


def test_reprotect_waits_for_rescan_using_real_fields(world, stateful):
    _failover_estate(world, launch_into="i-primary")
    world.recovery_instances[PRIMARY] = [recovery_instance("i-primary", "s-fb", repl_state="CONTINUOUS")]
    world.source_servers[SECONDARY] = [forward_server(instance_id="i-primary", state="CONTINUOUS", lag="PT11M",
                                                      disks=[{"totalStorageBytes": 100, "rescannedStorageBytes": 40}])]
    with pytest.raises(c.RetryLater, match="RESCAN not complete"):
        reprotect.handler({}, None)


def test_reprotect_done_when_rescanned_and_zero_lag(world, stateful):
    _failover_estate(world, launch_into="i-primary")
    world.recovery_instances[PRIMARY] = [recovery_instance("i-primary", "s-fb", repl_state="CONTINUOUS")]
    out = reprotect.handler({}, None)
    assert out["status"] == "CONTINUOUS" and out["protectedInstanceId"] == "i-primary"
    assert out["retiredSourceServerID"] is None


# ---- retire ------------------------------------------------------------------------------

def test_retire_follows_drs_cleanup_order_and_retries_until_clean(world):
    _failover_estate(world, launch_into="i-primary", failback_state="FAILBACK_COMPLETED")
    world.recovery_instances[PRIMARY] = [recovery_instance("i-primary", "s-fb")]
    world.targets[SEC_TG] = [target("i-rec")]
    with pytest.raises(c.RetryLater):
        retire.handler({}, None)
    assert world.calls("drs", PRIMARY, "stop_replication")[0][1] == {"sourceServerID": "s-fb"}
    assert world.calls("drs", SECONDARY, "stop_failback")
    assert world.calls("drs", SECONDARY, "terminate_recovery_instances")[0][1] == {"recoveryInstanceIDs": ["ri-i-rec"]}
    # never TERMINATE the primary-side record -- it is the live primary
    assert world.calls("drs", PRIMARY, "delete_recovery_instance")[0][1] == {"recoveryInstanceID": "ri-i-primary"}
    assert not world.calls("drs", PRIMARY, "terminate_recovery_instances")
    assert world.calls("drs", PRIMARY, "delete_source_server")[0][1] == {"sourceServerID": "s-fb"}
    assert world.calls("elbv2", SECONDARY, "deregister_targets")[0][1]["Targets"] == [{"Id": "i-rec"}]


def test_retire_holds_until_forward_continuous(world):
    world.source_servers[SECONDARY] = [forward_server(state="RESCAN")]
    with pytest.raises(c.RetryLater, match="not CONTINUOUS"):
        retire.handler({}, None)
    assert not world.calls("drs", SECONDARY, "terminate_recovery_instances")


def test_retire_returns_at_resting_state_and_clears_job_tag(world):
    world.source_servers[SECONDARY] = [forward_server(tags={"drsdemo:recovery-job": "job-1"})]
    out = retire.handler({}, None)
    assert out["status"] == "RETIRED" and out["protectedPrimary"] == "i-primary"
    assert world.calls("drs", SECONDARY, "untag_resource")[0][1]["tagKeys"] == ["drsdemo:recovery-job"]


def test_retire_logs_best_effort_failures_without_blocking(world, capsys):
    """stop_failback may fail while DRS is already tearing the instance down. It must be logged
    (before this pin it was discarded through a throwaway list) but must not stop the terminate."""
    _failover_estate(world, launch_into="i-primary", failback_state="FAILBACK_COMPLETED")
    world.targets[SEC_TG] = []
    drs_sec = world.client("drs", SECONDARY)

    def boom(**_):
        raise Exception("StopFailback refused: failback already stopping")
    drs_sec.stop_failback = boom
    with pytest.raises(c.RetryLater) as ex:
        retire.handler({}, None)
    logged = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
    failures = [r for r in logged if r["message"] == "cleanup call failed"]
    assert failures and failures[0]["bestEffort"] is True and "stop_failback ri-i-rec" == failures[0]["call"]
    assert "StopFailback refused" in failures[0]["error"]
    # best-effort: not part of the retry reason, and the terminate still happened
    assert "stop_failback" not in str(ex.value)
    assert world.calls("drs", SECONDARY, "terminate_recovery_instances")


def test_retire_logs_and_retries_blocking_failures(world, capsys):
    _failover_estate(world, launch_into="i-primary", failback_state="FAILBACK_COMPLETED")
    world.targets[SEC_TG] = []
    world.refuse_terminate = True
    with pytest.raises(c.RetryLater, match="terminate i-rec"):
        retire.handler({}, None)
    logged = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
    blocking = [r for r in logged if r["message"] == "cleanup call failed" and r["bestEffort"] is False]
    assert blocking and blocking[0]["call"].startswith("terminate i-rec")
