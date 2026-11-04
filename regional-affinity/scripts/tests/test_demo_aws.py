"""demo.py's AWS plumbing: the CLI argv, error codes, waiting for a plan execution, probe and plan lookups, verify."""
from __future__ import annotations

import json
import subprocess
import types
from pathlib import Path
from unittest import mock

import pytest
from demo_fakes import ACCOUNT, OTHER_ACCOUNT, OTHER_PLAN_ARN, PLAN_ARN, FakeClock, run_main, vended

import demo

# ---- the CLI call ------------------------------------------------------------------------------


def fake_cli(stdout="{}", stderr="", returncode=0):
    """Replaces demo.subprocess: records each argv, answers with the given output."""
    seen = []

    def run(cmd, **kwargs):
        seen.append(cmd)
        return subprocess.CompletedProcess(cmd, returncode, stdout, stderr)

    return types.SimpleNamespace(run=run), seen


def test_no_test_can_reach_the_real_aws_cli():
    """conftest.py refuses the real CLI, so a test that forgets to replace demo.aws fails by name and calls nothing."""
    with pytest.raises(AssertionError, match="a test reached the real AWS CLI: aws --region us-east-1"):
        demo.aws("us-east-1", "sts", "get-caller-identity")


def test_the_profile_goes_on_every_cli_call(monkeypatch):
    cli, seen = fake_cli('{"Account": "111122223333"}')
    monkeypatch.setattr(demo, "subprocess", cli)
    monkeypatch.setattr(demo, "PROFILE", "sandbox")
    assert demo.aws("us-east-2", "sts", "get-caller-identity") == {"Account": "111122223333"}
    assert seen == [["aws", "--region", "us-east-2", "--no-cli-pager", "--output", "json", "sts", "get-caller-identity",
                     "--profile", "sandbox"]]


def test_without_a_profile_the_cli_chooses_its_credentials(monkeypatch):
    cli, seen = fake_cli()
    monkeypatch.setattr(demo, "subprocess", cli)
    monkeypatch.setattr(demo, "PROFILE", None)
    demo.aws("us-east-1", "sts", "get-caller-identity")
    assert "--profile" not in seen[0] and seen[0][:3] == ["aws", "--region", "us-east-1"]


def test_the_profile_reaches_the_call_main_makes_first(monkeypatch, capsys):
    cli, seen = fake_cli('{"Account": "111122223333", "Arn": "arn:aws:sts::111122223333:assumed-role/x/y"}')
    monkeypatch.setattr(demo, "subprocess", cli)
    monkeypatch.setattr(demo, "PROFILE", "sandbox")
    ran = run_main(capsys, "--account", OTHER_ACCOUNT, "drain", "us-east-1")
    assert ran.code == 1 and "nothing was changed" in ran.err
    assert len(seen) == 1 and seen[0][-2:] == ["--profile", "sandbox"] and seen[0][2] == "us-east-2"


def test_an_error_carries_the_code_the_cli_printed(monkeypatch):
    stderr = ("\nAn error occurred (AccessDeniedException) when calling the GetPlanExecution operation: "
              "User is not authorized\n")
    monkeypatch.setattr(demo, "subprocess", fake_cli(stderr=stderr, returncode=254)[0])
    with pytest.raises(demo.AwsError) as raised:
        demo.aws("us-east-2", "arc-region-switch", "get-plan-execution")
    assert raised.value.code == "AccessDeniedException"
    assert str(raised.value) == ("aws arc-region-switch get-plan-execution (us-east-2): An error occurred (AccessDeniedException)"
                                 " when calling the GetPlanExecution operation: User is not authorized")


def test_a_connection_problem_has_no_code(monkeypatch):
    cli, _ = fake_cli(stderr='Could not connect to the endpoint URL: "https://x"', returncode=255)
    monkeypatch.setattr(demo, "subprocess", cli)
    with pytest.raises(demo.AwsError) as raised:
        demo.aws("us-east-1", "sts", "get-caller-identity")
    assert raised.value.code == ""


@pytest.mark.parametrize("code,message,expected", [
    ("ThrottlingException", "Rate exceeded", True),
    ("TooManyRequestsException", "slow down", True),
    ("InternalServerException", "oops", True),
    ("ServiceUnavailableException", "later", True),
    ("", 'Could not connect to the endpoint URL: "https://arc-region-switch.us-east-2.api.aws/"', True),
    ("", 'Read timeout on endpoint URL: "https://arc-region-switch.us-east-2.api.aws/"', True),
    ("AccessDeniedException", "not authorized", False),
    ("ResourceNotFoundException", "no such execution", False),
    ("ValidationException", "bad id", False),
    ("ExpiredTokenException", "The security token included in the request is expired", False),
    ("UnrecognizedClientException", "invalid token", False),
    ("", "Unable to locate credentials. You can configure credentials by running aws configure.", False),
])
def test_only_throttling_and_transient_errors_are_worth_a_retry(code, message, expected):
    assert demo.transient(demo.AwsError(f"aws x y (us-east-2): {message}", code)) is expected


# ---- waiting for a plan execution --------------------------------------------------------------


def scripted(*steps):
    """A fake aws() answering get-plan-execution with each step in turn (the last one repeats): a state name,
    or an exception to raise. Returns it and the list of its calls."""
    queue, calls = list(steps), []

    def fake(region, *args):
        calls.append((region, args))
        step = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(step, Exception):
            raise step
        return {"executionState": step, "stepStates": [{"name": "drain-dns", "status": "running"}]}

    return fake, calls


def wait(steps, limit=15 * 60):
    """Run wait_for_execution against scripted steps on a clock that does not wait: (state, calls, clock)."""
    fake, calls = scripted(*steps)
    clock = FakeClock()
    with mock.patch.object(demo, "aws", fake), mock.patch.object(demo, "time", clock):
        state = demo.wait_for_execution("us-east-2", PLAN_ARN, "us-east-2/abc", clock.time(), limit)
    return state, calls, clock


def test_wait_returns_the_state_a_finished_execution_ended_in():
    state, calls, clock = wait(["inProgress", "inProgress", "completed"])
    assert state == "completed" and len(calls) == 3 and clock.sleeps == [10, 10]
    assert calls[0] == ("us-east-2", ("arc-region-switch", "get-plan-execution", "--plan-arn", PLAN_ARN,
                                      "--execution-id", "us-east-2/abc"))


@pytest.mark.parametrize("ended", ["failed", "canceled", "planExecutionTimedOut", "completedWithExceptions"])
def test_wait_returns_a_failed_ending_for_the_caller_to_report(ended):
    assert wait(["inProgress", ended])[0] == ended


@pytest.mark.parametrize("paused", ["pausedByFailedStep", "pausedByOperator", "pendingManualApproval"])
def test_wait_stops_at_a_paused_execution_and_leaves_it_alone(paused, capsys):
    fake, calls = scripted("inProgress", paused, "completed")
    with mock.patch.object(demo, "aws", fake), mock.patch.object(demo, "time", FakeClock()), pytest.raises(SystemExit) as stopped:
        demo.wait_for_execution("us-east-2", PLAN_ARN, "us-east-2/abc", 1_000_000.0)
    assert stopped.value.code == 1
    err = capsys.readouterr().err
    assert f"plan execution us-east-2/abc is {paused}; it is left as it is" in err
    assert len(calls) == 2  # it did not poll on to the "completed" that follows


def test_wait_gives_up_after_the_limit_and_leaves_the_execution_running(capsys):
    fake, calls = scripted("inProgress")
    clock = FakeClock()
    with mock.patch.object(demo, "aws", fake), mock.patch.object(demo, "time", clock), pytest.raises(SystemExit) as stopped:
        demo.wait_for_execution("us-east-2", PLAN_ARN, "us-east-2/abc", clock.time())
    assert stopped.value.code == 1
    assert "still running after 15 minutes; it is left running" in capsys.readouterr().err
    assert clock.time() - 1_000_000.0 >= 15 * 60 and len(calls) == 90


def test_wait_retries_throttling_and_connection_errors(capsys):
    throttled = demo.AwsError("aws arc-region-switch get-plan-execution (us-east-2): Rate exceeded", "ThrottlingException")
    offline = demo.AwsError('aws arc-region-switch get-plan-execution (us-east-2): Could not connect to the endpoint URL: "https://x"')
    state, calls, clock = wait([throttled, offline, "completed"])
    assert state == "completed" and len(calls) == 3 and clock.sleeps == [10, 10]
    assert capsys.readouterr().err.count("read failed, retrying") == 2


@pytest.mark.parametrize("code", ["AccessDeniedException", "ResourceNotFoundException", "ValidationException",
                                  "ExpiredTokenException"])
def test_wait_stops_at_an_error_that_will_not_fix_itself(code, capsys):
    refused = demo.AwsError(f"aws arc-region-switch get-plan-execution (us-east-2): An error occurred ({code})", code)
    fake, calls = scripted(refused, "completed")
    clock = FakeClock()
    with mock.patch.object(demo, "aws", fake), mock.patch.object(demo, "time", clock), pytest.raises(SystemExit) as stopped:
        demo.wait_for_execution("us-east-2", PLAN_ARN, "us-east-2/abc", clock.time())
    assert stopped.value.code == 1 and len(calls) == 1 and clock.sleeps == []  # no 15 minutes of retries
    err = capsys.readouterr().err
    assert f"({code})" in err and "it was started and may still be running" in err


# ---- the plan, by name -----------------------------------------------------------------------------


def listing(*plans):
    calls = []

    def fake(region, *args):
        calls.append((region, args))
        return {"plans": list(plans)}

    return fake, calls


def plan(name, arn):
    return {"name": name, "arn": arn, "regions": ["us-east-1", "us-east-2"]}


def test_the_plan_is_found_by_its_name_at_the_endpoint_asked():
    fake, calls = listing(plan("something-else", OTHER_PLAN_ARN), plan("regional-affinity", PLAN_ARN))
    with mock.patch.object(demo, "aws", fake):
        assert demo.plan_arn("us-east-2") == PLAN_ARN
    assert calls == [("us-east-2", ("arc-region-switch", "list-plans-in-region"))]


def test_the_plan_name_is_the_project(monkeypatch):
    monkeypatch.setattr(demo, "PROJECT", "my-demo")
    fake, _ = listing(plan("regional-affinity", OTHER_PLAN_ARN), plan("my-demo", PLAN_ARN))
    with mock.patch.object(demo, "aws", fake):
        assert demo.plan_arn("us-east-1") == PLAN_ARN


def test_no_plan_of_that_name_says_to_deploy(capsys):
    fake, _ = listing(plan("something-else", OTHER_PLAN_ARN))
    with mock.patch.object(demo, "aws", fake), pytest.raises(SystemExit):
        demo.plan_arn("us-east-2")
    err = capsys.readouterr().err
    assert "no Region switch plan named regional-affinity at the us-east-2 endpoint; run make deploy first" in err


def test_two_plans_of_that_name_are_not_guessed_between(capsys):
    fake, _ = listing(plan("regional-affinity", PLAN_ARN), plan("regional-affinity", OTHER_PLAN_ARN))
    with mock.patch.object(demo, "aws", fake), pytest.raises(SystemExit):
        demo.plan_arn("us-east-2")
    err = capsys.readouterr().err
    assert PLAN_ARN in err and OTHER_PLAN_ARN in err


# ---- ARC's health checks, from one endpoint ----------------------------------------------------


def test_health_states_are_read_from_the_endpoint_asked_and_no_other():
    calls = []

    def fake(region, *args):
        calls.append((region, args))
        return {"healthChecks": [{"recordName": "Ingest.Example.com.", "region": "us-east-1", "status": "unhealthy"},
                                 {"recordName": "ingest.ue1.example.com.", "region": "us-east-2"}]}

    with mock.patch.object(demo, "aws", fake):
        states = demo.health_states(PLAN_ARN, "us-east-2")
    assert states == {("ingest.example.com", "us-east-1"): "unhealthy", ("ingest.ue1.example.com", "us-east-2"): "unknown"}
    assert calls == [("us-east-2", ("arc-region-switch", "list-route53-health-checks-in-region", "--arn", PLAN_ARN))]


def test_health_states_do_not_fall_back_to_the_other_region(capsys):
    calls = []

    def fake(region, *args):
        calls.append(region)
        raise demo.AwsError(f"aws arc-region-switch list-route53-health-checks-in-region ({region}): timed out")

    with mock.patch.object(demo, "aws", fake), pytest.raises(SystemExit):
        demo.health_states(PLAN_ARN, "us-east-2")
    assert calls == ["us-east-2"]  # a drain must not wait on the Region it is draining
    assert "cannot read the ARC health checks" in capsys.readouterr().err


# ---- the probe -------------------------------------------------------------------------------------


def probe_aws(function_error=None, body=None):
    calls = []

    def fake(region, *args):
        assert args[:2] == ("lambda", "invoke"), f"unexpected AWS call {args[:2]}"  # and so nothing writes to args[-1]
        calls.append((region, args))
        Path(args[-1]).write_text(json.dumps(body if body is not None else {"results": {}}))
        return {"StatusCode": 200, **({"FunctionError": function_error} if function_error else {})}

    return fake, calls


def test_a_probe_error_stops_the_command_with_the_functions_message(capsys):
    fake, _ = probe_aws("Unhandled", {"errorMessage": "Task timed out after 60.00 seconds"})
    with mock.patch.object(demo, "aws", fake), pytest.raises(SystemExit) as stopped:
        demo.invoke_probe("us-east-2", {"names": []})
    assert stopped.value.code == 1
    assert "the probe in us-east-2 failed: Task timed out after 60.00 seconds" in capsys.readouterr().err


def test_the_probe_is_invoked_by_its_fixed_name_with_no_cloudformation_lookup():
    fake, calls = probe_aws(body={"region": "us-east-2", "results": {"x": []}})
    with mock.patch.object(demo, "aws", fake):
        assert demo.invoke_probe("us-east-2", {"names": ["x"], "samples": 1}) == {"region": "us-east-2", "results": {"x": []}}
    ((region, args),) = calls
    assert region == "us-east-2" and args[:4] == ("lambda", "invoke", "--function-name", "regional-affinity-probe")
    assert json.loads(args[args.index("--payload") + 1]) == {"names": ["x"], "samples": 1}


# ---- the deploy-time commands ------------------------------------------------------------------


def test_stack_outputs_say_to_deploy_when_the_stack_is_not_there(capsys):
    def fake(region, *args):
        raise demo.AwsError("aws cloudformation describe-stacks (us-east-1): Stack does not exist")

    with mock.patch.object(demo, "aws", fake), pytest.raises(SystemExit):
        demo.stack_outputs("us-east-1", "regional-affinity-plan")
    err = capsys.readouterr().err
    assert "cannot read stack regional-affinity-plan in us-east-1" in err and "run make deploy first" in err


def listed(checks):
    return lambda region, *args: {"healthChecks": checks}


def test_vended_health_checks_wait_for_all_six_ids():
    without_ids = [{k: v for k, v in check.items() if k != "healthCheckId"} for check in vended()]
    answers = iter([without_ids, vended()[:5], vended()])
    clock = FakeClock()
    calls = []

    def fake(region, *args):
        calls.append((region, args[:2]))
        return {"healthChecks": next(answers)}

    with mock.patch.object(demo, "aws", fake), mock.patch.object(demo, "time", clock):
        ids = demo.vended_health_checks(PLAN_ARN)
    assert len(ids) == 6 and None not in ids.values()
    assert clock.sleeps == [10, 10]  # two answers that were not complete yet
    assert calls == [("us-east-1", ("arc-region-switch", "list-route53-health-checks"))] * 3


def test_vended_health_checks_give_up_and_say_what_is_missing(capsys):
    clock = FakeClock()
    with mock.patch.object(demo, "aws", listed(vended()[1:])), mock.patch.object(demo, "time", clock), pytest.raises(SystemExit):
        demo.vended_health_checks(PLAN_ARN)
    err = capsys.readouterr().err
    assert "did not vend every health check the records need: no health check yet for ingest.example.com us-east-1" in err
    assert len(clock.sleeps) == 18


def test_vended_health_checks_stop_at_a_duplicate_on_the_first_look(capsys):
    clock, calls = FakeClock(), []

    def fake(region, *args):
        calls.append(region)
        return {"healthChecks": vended() + [dict(vended()[0], healthCheckId="another")]}

    with mock.patch.object(demo, "aws", fake), mock.patch.object(demo, "time", clock), pytest.raises(SystemExit):
        demo.vended_health_checks(PLAN_ARN)
    err = capsys.readouterr().err
    assert err.startswith("error: more than one health check for ingest.example.com us-east-1")
    assert len(calls) == 1 and clock.sleeps == []  # waiting would not make it go away


class VerifyAws:
    """What `verify` calls: the plan stack, the health checks, the records, and the plan's evaluation. Until
    update-plan runs, get-plan-evaluation-status answers an old evaluation; then each Region's `after` steps."""

    PLAN = {"arn": PLAN_ARN, "name": "regional-affinity", "regions": ["us-east-1", "us-east-2"], "owner": ACCOUNT,
            "recoveryApproach": "activeActive", "version": "7", "updatedAt": "t", "description": "d", "workflows": [],
            "executionRole": "arn:aws:iam::111122223333:role/r", "recoveryTimeObjectiveMinutes": 10,
            "serviceQuotaChecksEnabled": True}

    def __init__(self, after, records="bound"):
        self.after, self.records, self.updated, self.update_body, self.calls = after, records, False, None, []

    def __call__(self, region, service, operation, *args):
        self.calls.append((region, service, operation))
        if operation == "describe-stacks":
            outputs = {"PlanArn": PLAN_ARN, "HostedZoneId": "Z123"}
            return {"Stacks": [{"Outputs": [{"OutputKey": k, "OutputValue": v} for k, v in outputs.items()]}]}
        if operation == "list-route53-health-checks":
            return {"healthChecks": vended()}
        if operation == "list-resource-record-sets":
            ids = demo.pick_health_checks(vended())
            records = [{"Name": f"{name}.", "SetIdentifier": r, "HealthCheckId": hc} for (name, r), hc in ids.items()]
            if self.records == "swapped":  # the two records of one regional name
                a, b = records[2], records[3]
                a["HealthCheckId"], b["HealthCheckId"] = b["HealthCheckId"], a["HealthCheckId"]
            return {"ResourceRecordSets": records}
        if operation == "get-plan":
            return {"plan": dict(self.PLAN)}
        if operation == "update-plan":
            self.updated = True
            self.update_body = json.loads(Path(args[args.index("--cli-input-json") + 1][len("file://"):]).read_text())
            return {}
        assert operation == "get-plan-evaluation-status", operation
        if not self.updated:
            return {"lastEvaluationTime": "old", "evaluationState": "actionRequired", "warnings": []}
        steps = self.after[region]
        return steps.pop(0) if len(steps) > 1 else steps[0]


def evaluated(state="passed", warnings=(), time="new"):
    return {"lastEvaluationTime": time, "evaluationState": state, "warnings": list(warnings)}


def verify(fake, capsys):
    """Run cmd_verify on a clock that does not wait: (what it raised or None, stderr, the clock)."""
    clock = FakeClock()
    stopped = None
    with mock.patch.object(demo, "aws", fake), mock.patch.object(demo, "time", clock):
        try:
            demo.cmd_verify(None)
        except SystemExit as exc:
            stopped = exc
    return stopped, capsys.readouterr().err, clock


def test_verify_passes_when_both_endpoints_evaluate_as_passed(capsys):
    fake = VerifyAws({"us-east-1": [evaluated()], "us-east-2": [evaluated()]})
    stopped, err, _ = verify(fake, capsys)
    assert stopped is None and "evaluates clean at both endpoints" in err
    # the no-op update carries what UpdatePlan accepts, serviceQuotaChecksEnabled among it, and nothing it refuses
    assert fake.update_body["serviceQuotaChecksEnabled"] is True
    assert set(fake.update_body) == set(demo.UPDATE_KEYS) & set(VerifyAws.PLAN)
    assert not {"name", "regions", "owner", "recoveryApproach", "version", "updatedAt"} & set(fake.update_body)


def test_verify_waits_out_an_evaluation_that_is_still_pending(capsys):
    pending = evaluated("pendingEvaluation")
    stopped, err, clock = verify(VerifyAws({"us-east-1": [pending, evaluated()], "us-east-2": [evaluated()]}), capsys)
    assert stopped is None and clock.sleeps.count(15) == 3  # two polls for us-east-1, one for us-east-2


@pytest.mark.parametrize("state", ["actionRequired", "unknown", "pendingEvaluation"])
def test_verify_requires_the_state_passed_even_without_a_warning(state, capsys):
    fake = VerifyAws({"us-east-1": [evaluated()], "us-east-2": [evaluated(state)]})
    stopped, err, _ = verify(fake, capsys)
    assert stopped is not None and stopped.code == 1
    if state == "pendingEvaluation":  # ARC never finished: that is "did not refresh", not a verdict
        assert "the us-east-2 endpoint did not refresh its evaluation within 4 minutes" in err
    else:
        assert f"the us-east-2 endpoint evaluates the plan as {state}, not passed" in err


def test_verify_reports_active_warnings_and_prints_them(capsys):
    warning = {"warningStatus": "active", "stepName": "drain-dns", "warningMessage": "the record is missing"}
    resolved = {"warningStatus": "resolved", "stepName": "old", "warningMessage": "was missing"}
    fake = VerifyAws({"us-east-1": [evaluated("actionRequired", [warning, resolved])], "us-east-2": [evaluated()]})
    stopped, err, _ = verify(fake, capsys)
    assert stopped.code == 1
    assert "drain-dns: the record is missing" in err and "was missing" not in err
    assert "the us-east-1 endpoint reports 1 active warning(s), listed above" in err


def test_verify_says_so_when_the_evaluation_never_refreshes_and_does_not_blame_warnings(capsys):
    fake = VerifyAws({"us-east-1": [evaluated(time="old")], "us-east-2": [evaluated()]})  # the old time again and again
    stopped, err, clock = verify(fake, capsys)
    assert stopped.code == 1
    assert "the us-east-1 endpoint did not refresh its evaluation within 4 minutes" in err
    assert "warning" not in err.split("error: ")[-1]  # a slow evaluation is not a warning
    assert clock.sleeps.count(15) == 16 + 1  # all sixteen polls for us-east-1, one for us-east-2


def test_verify_stops_at_a_record_with_the_wrong_health_check_before_touching_the_plan(capsys):
    fake = VerifyAws({"us-east-1": [evaluated()], "us-east-2": [evaluated()]}, records="swapped")
    stopped, err, _ = verify(fake, capsys)
    assert stopped.code == 1 and "records do not carry the expected ARC health checks" in err
    assert not fake.updated
