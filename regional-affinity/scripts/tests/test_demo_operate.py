"""demo.py through main(): exit codes, the account pin, and which Regions each command calls."""
from __future__ import annotations

from unittest import mock

import pytest
from demo_fakes import ACCOUNT, OTHER_ACCOUNT, PLAN_ARN, FakeAws, installed, run_main

import demo

# ---- the account pin -------------------------------------------------------------------------

# Each command's first call is in the Region it acts in: drain in the Region that stays, restore in the Region
# it restores, status and call in the Region they query from, the rest at the first Region.
ACTS_IN = [
    (["drain", "us-east-1"], "us-east-2"),
    (["drain", "us-east-2"], "us-east-1"),
    (["restore", "us-east-1"], "us-east-1"),
    (["restore", "us-east-2"], "us-east-2"),
    (["status"], "us-east-2"),
    (["status", "--from", "us-east-1"], "us-east-1"),
    (["call", "cust-001"], "us-east-2"),
    (["call", "cust-001", "--from", "us-east-1"], "us-east-1"),
    (["seed"], "us-east-1"),
    (["health-checks"], "us-east-1"),
    (["verify"], "us-east-1"),
    (["rehearse"], "us-east-1"),
]


@pytest.mark.parametrize("argv,region", ACTS_IN, ids=[" ".join(argv) for argv, _ in ACTS_IN])
def test_a_pinned_account_refuses_before_any_change_and_checks_in_the_region_the_command_acts_in(argv, region, capsys):
    fake = FakeAws()  # its credentials are for account 111122223333
    with installed(fake):
        ran = run_main(capsys, "--account", OTHER_ACCOUNT, *argv)
    assert ran.code == 1
    assert f"these credentials are for account {ACCOUNT}, not {OTHER_ACCOUNT}; nothing was changed" in ran.err
    assert fake.calls == [(region, "sts", "get-caller-identity")]  # the check, and not one call after it


def test_the_account_pin_can_come_from_the_environment_the_makefile_sets(monkeypatch, capsys):
    monkeypatch.setenv("ACCOUNT", OTHER_ACCOUNT)
    fake = FakeAws()
    with installed(fake):
        ran = run_main(capsys, "drain", "us-east-1")
    assert ran.code == 1 and "nothing was changed" in ran.err
    assert fake.calls == [("us-east-2", "sts", "get-caller-identity")] and fake.started == []


def test_the_right_account_goes_ahead(capsys):
    fake = FakeAws()
    with installed(fake):
        ran = run_main(capsys, "--account", ACCOUNT, "drain", "us-east-1")
    assert ran.code == 0, ran.err
    assert fake.started == [("us-east-2", "us-east-1", "deactivate")]


def test_names_needs_no_credentials(capsys):
    fake = FakeAws()
    with installed(fake):
        ran = run_main(capsys, "--account", OTHER_ACCOUNT, "names")
    assert ran.code == 0 and fake.calls == []


# ---- exit codes ------------------------------------------------------------------------------


@pytest.mark.parametrize("action,start", [("drain", set()), ("restore", {"us-east-1"})])
def test_drain_and_restore_exit_1_when_arc_marked_none_of_the_checks(action, start, capsys):
    fake = FakeAws(drained=start, stuck=True)  # the execution completes, and the health checks stay as they were
    with installed(fake):
        ran = run_main(capsys, action, "us-east-1")
    assert ran.code == 1
    assert "at 0 of 3 record names" in ran.err
    assert f"error: {action} us-east-1: the plan execution completed, but a check above failed" in ran.err


@pytest.mark.parametrize("action,start,after", [("drain", set(), {"us-east-1"}), ("restore", {"us-east-1"}, set())])
def test_drain_and_restore_exit_0_when_every_check_passes(action, start, after, capsys):
    fake = FakeAws(drained=start)
    with installed(fake):
        ran = run_main(capsys, action, "us-east-1")
    assert ran.code == 0, ran.err
    assert fake.drained == after and "DIFFERS" not in ran.out


@pytest.mark.parametrize("action", ["drain", "restore"])
def test_drain_and_restore_exit_1_when_a_check_after_the_execution_fails(action, capsys):
    """shift() False for any reason (DNS did not follow, a request landed elsewhere) is exit 1."""
    with mock.patch.object(demo, "check_account"), mock.patch.object(demo, "shift", return_value=False) as shift:
        ran = run_main(capsys, action, "us-east-2")
    assert ran.code == 1 and f"{action} us-east-2: " in ran.err
    shift.assert_called_once()


@pytest.mark.parametrize("ok,code", [(True, 0), (False, 1)])
def test_status_exits_1_when_show_finds_a_difference(ok, code, capsys):
    with mock.patch.object(demo, "check_account"), mock.patch.object(demo, "plan_arn", return_value=PLAN_ARN), \
            mock.patch.object(demo, "show", return_value=ok):
        ran = run_main(capsys, "status")
    assert ran.code == code
    assert ("a check above differs" in ran.err) == (code == 1)


@pytest.mark.parametrize("ok,code", [(True, 0), (False, 1)])
def test_call_exits_1_when_a_request_does_not_end_where_dns_sends_it(ok, code, capsys):
    with mock.patch.object(demo, "check_account"), mock.patch.object(demo, "plan_arn", return_value=PLAN_ARN), \
            mock.patch.object(demo, "health_states", return_value={}), mock.patch.object(demo, "send", return_value=(ok, [])):
        ran = run_main(capsys, "call", "cust-001")
    assert ran.code == code
    assert ("did not end at the app" in ran.err) == (code == 1)


def test_status_and_call_exit_0_at_rest(capsys):
    fake = FakeAws()
    with installed(fake):
        assert run_main(capsys, "status", "--samples", "1", "--interval", "0").code == 0
        assert run_main(capsys, "call", "cust-001").code == 0


def test_status_exits_1_when_dns_does_not_follow_the_health_checks(capsys):
    fake = FakeAws(drained={"us-east-1"}, stale_dns=True)  # ARC says us-east-1 is drained; the resolver has not caught up
    with installed(fake):
        ran = run_main(capsys, "status", "--samples", "1", "--interval", "0")
    assert ran.code == 1 and "a check above differs" in ran.err and "DIFFERS" in ran.out


# ---- the Regions a command calls ---------------------------------------------------------------


@pytest.mark.parametrize("drained_region,stays", [("us-east-1", "us-east-2"), ("us-east-2", "us-east-1")])
def test_drain_works_when_every_endpoint_of_the_drained_region_is_down(drained_region, stays, capsys):
    fake = FakeAws(down={drained_region})
    with installed(fake):
        ran = run_main(capsys, "--account", ACCOUNT, "drain", drained_region)
    assert ran.code == 0, ran.err
    assert fake.started == [(stays, drained_region, "deactivate")]  # started at the endpoint of the Region that stays
    assert fake.regions_called() == {stays}  # and the Region being drained was never called
    assert fake.drained == {drained_region}


def test_no_operate_command_calls_cloudformation(capsys):
    fake = FakeAws()
    with installed(fake):
        for argv in (["status", "--samples", "1", "--interval", "0"], ["call", "cust-001"], ["drain", "us-east-1"],
                     ["restore", "us-east-1"]):
            ran = run_main(capsys, *argv)
            assert ran.code == 0, (argv, ran.err)
    assert {service for _, service, _ in fake.calls} == {"sts", "arc-region-switch", "lambda"}


def test_restore_runs_at_its_target_and_asks_for_the_plan_there_only(capsys):
    fake = FakeAws(drained={"us-east-1"})
    with installed(fake):
        ran = run_main(capsys, "restore", "us-east-1")
    assert ran.code == 0, ran.err
    assert fake.started == [("us-east-1", "us-east-1", "activate")]
    looked_up = [region for region, _, operation in fake.calls if operation == "list-plans-in-region"]
    assert looked_up == ["us-east-1"]


@pytest.mark.parametrize("argv,down,region", [
    (["status", "--samples", "1", "--interval", "0"], "us-east-1", "us-east-2"),
    (["call", "cust-001"], "us-east-1", "us-east-2"),
    (["status", "--samples", "1", "--interval", "0", "--from", "us-east-1"], "us-east-2", "us-east-1"),
    (["call", "cust-001", "--from", "us-east-1"], "us-east-2", "us-east-1"),
])
def test_status_and_call_call_only_the_region_they_query_from(argv, down, region, capsys):
    fake = FakeAws(down={down})
    with installed(fake):
        ran = run_main(capsys, *argv)
    assert ran.code == 0, ran.err
    assert fake.regions_called() == {region}


@pytest.mark.parametrize("action,start,started", [
    ("drain", set(), ("us-east-2", "us-east-1", "deactivate")),
    ("restore", {"us-east-1"}, ("us-east-1", "us-east-1", "activate")),
])
def test_from_still_names_the_vpc_drain_and_restore_look_from(action, start, started, capsys):
    fake = FakeAws(drained=start)
    with installed(fake):
        ran = run_main(capsys, action, "us-east-1", "--from", "us-east-1")
    assert ran.code == 0, ran.err
    assert ("us-east-1", "lambda", "invoke") in fake.calls  # the probe ran in the VPC --from names
    assert fake.started == [started]  # and the plan execution still started where it belongs
