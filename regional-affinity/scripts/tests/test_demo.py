"""Unit tests for scripts/demo.py. They need no AWS access: every AWS call is replaced."""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import types
from pathlib import Path
from unittest import mock

import pytest
from demo_fakes import ALL_HEALTHY, CIDRS, PLAN_ARN, UE1, UE2, FakeAws, drained, installed, vended

import demo

# ---- names -----------------------------------------------------------------------------------


def test_default_names():
    assert demo.REGION_LESS == "ingest.example.com"
    assert demo.REGIONAL == {"us-east-1": UE1, "us-east-2": UE2}
    assert demo.APP_NAME == {"us-east-1": "ingest-app.ue1.example.com", "us-east-2": "ingest-app.ue2.example.com"}
    assert demo.TABLE == "regional-affinity-customers"


@pytest.mark.parametrize("region,label", [("us-east-1", "ue1"), ("us-west-2", "uw2"), ("eu-central-1", "ec1"),
                                          ("ap-southeast-2", "as2"), ("us-gov-west-1", "ugw1")])
def test_region_labels(region, label):
    assert demo.region_label(region) == label


@pytest.mark.parametrize("bad", ["useast1", "us-east", "US-EAST-1", "us-east-x", ""])
def test_region_label_rejects_non_region_names(bad):
    with pytest.raises(ValueError):
        demo.region_label(bad)


# ---- where DNS should answer -------------------------------------------------------------------


def test_at_rest_every_name_answers_from_its_own_region():
    exp = demo.expected_regions(ALL_HEALTHY)
    assert exp["ingest.example.com"] == {"us-east-1", "us-east-2"}
    assert (exp[UE1], exp[UE2]) == ({"us-east-1"}, {"us-east-2"})
    assert exp["ingest-app.ue1.example.com"] == {"us-east-1"}
    assert exp["ingest-app.ue2.example.com"] == {"us-east-2"}


@pytest.mark.parametrize("gone,stays", [("us-east-1", "us-east-2"), ("us-east-2", "us-east-1")])
def test_draining_a_region_moves_every_arc_name_to_the_other(gone, stays):
    exp = demo.expected_regions(drained(gone))
    assert all(exp[name] == {stays} for name in demo.ARC_NAMES)
    assert exp[demo.APP_NAME[gone]] == {gone}  # the app names are pinned to their ALBs and never move


def test_a_regional_failover_alone_also_moves_its_weighted_share():
    state = {**ALL_HEALTHY, (UE1, "us-east-1"): "unhealthy"}
    exp = demo.expected_regions(state)
    assert exp[UE1] == {"us-east-2"}
    assert exp["ingest.example.com"] == {"us-east-2"}


def test_all_unhealthy_answers_as_if_all_were_healthy():
    assert demo.expected_regions({key: "unhealthy" for key in ALL_HEALTHY}) == demo.expected_regions(ALL_HEALTHY)


def test_region_summary():
    assert demo.region_summary(ALL_HEALTHY) == "us-east-1 active, us-east-2 active"
    assert demo.region_summary(drained("us-east-1")) == "us-east-1 drained, us-east-2 active"
    assert demo.region_summary({**ALL_HEALTHY, (UE1, "us-east-1"): "unhealthy"}) == "us-east-1 mixed, us-east-2 active"


def test_weighted_name_may_show_a_subset_failover_names_must_match():
    both = {"us-east-1", "us-east-2"}
    assert demo.matches(demo.REGION_LESS, {"us-east-1"}, both)
    assert not demo.matches(demo.REGION_LESS, {"us-east-1"}, {"us-east-2"})
    assert not demo.matches(demo.REGION_LESS, set(), both)
    assert demo.matches(UE1, {"us-east-1"}, {"us-east-1"})
    assert not demo.matches(UE1, both, {"us-east-1"})


def test_summarize_maps_addresses_to_regions_and_counts_problems():
    samples = [{"rcode": "NOERROR", "ttl": 60, "addresses": ["10.11.0.7", "10.11.1.9"]},
               {"rcode": "NOERROR", "ttl": 42, "addresses": ["10.12.1.4"]},
               {"rcode": "NXDOMAIN", "ttl": None, "addresses": []},
               {"error": "timeout: timed out"}]
    s = demo.summarize(samples, CIDRS)
    assert dict(s["counts"]) == {"us-east-1": 1, "us-east-2": 1}
    assert dict(s["problems"]) == {"NXDOMAIN": 1, "timeout: timed out": 1}
    assert s["ttls"] == [60, 42]
    assert demo.answered_regions(["192.0.2.1"], CIDRS) == {"192.0.2.1"}


# ---- record roles and the health table -------------------------------------------------------


def test_at_rest_each_primary_answers_and_each_standby_waits():
    roles = demo.record_roles(ALL_HEALTHY)
    assert roles[(UE1, "us-east-1")] == ("primary", "healthy", True)
    assert roles[(UE1, "us-east-2")] == ("standby", "healthy", False)
    assert roles[(UE2, "us-east-2")] == ("primary", "healthy", True)
    assert roles[(UE2, "us-east-1")] == ("standby", "healthy", False)
    assert all(roles[("ingest.example.com", r)] == ("weighted", "healthy", True) for r in demo.REGIONS)
    assert len(roles) == 6


def test_after_a_drain_the_drained_regions_standby_takes_over():
    roles = demo.record_roles(drained("us-east-1"))
    assert roles[(UE1, "us-east-1")] == ("primary", "unhealthy", False)
    assert roles[(UE1, "us-east-2")] == ("standby", "healthy", True)
    assert roles[(UE2, "us-east-2")] == ("primary", "healthy", True)
    assert roles[(UE2, "us-east-1")] == ("standby", "unhealthy", False)
    assert roles[("ingest.example.com", "us-east-1")] == ("weighted", "unhealthy", False)


def test_with_both_failover_records_unhealthy_route_53_returns_the_primary():
    roles = demo.record_roles({key: "unhealthy" for key in ALL_HEALTHY})
    assert roles[(UE1, "us-east-1")][2] and not roles[(UE1, "us-east-2")][2]
    assert all(roles[("ingest.example.com", r)][2] for r in demo.REGIONS)


def table_lines(health: dict) -> list:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        demo.print_health(health, "us-east-2")
    return out.getvalue().splitlines()


def test_health_table_labels_roles_by_region_column():
    lines = table_lines(ALL_HEALTHY)
    assert "set by the Region switch plan" in lines[1]
    row = {line.split()[0]: line for line in lines[3:6]}
    assert row["ingest.example.com"].split()[1:] == ["weighted", "healthy", "answering", "weighted", "healthy", "answering"]
    assert row[UE1].split()[1:] == ["primary", "healthy", "answering", "standby", "healthy"]
    assert row[UE2].split()[1:] == ["standby", "healthy", "primary", "healthy", "answering"]
    row = {line.split()[0]: line for line in table_lines(drained("us-east-1"))[3:6]}
    assert row[UE1].split()[1:] == ["primary", "unhealthy", "standby", "healthy", "answering"]


def test_plan_name_comes_from_the_arn():
    assert demo.plan_name(PLAN_ARN) == "regional-affinity"


# ---- health check binding ----------------------------------------------------------------------


def test_picks_all_six_by_name_and_region_regardless_of_order():
    picked = demo.pick_health_checks(list(reversed(vended())))
    assert len(picked) == 6
    assert all(hc_id == f"id-{name}-{region}" for (name, region), hc_id in picked.items())


def test_a_missing_check_is_retryable_and_a_duplicate_is_not():
    with pytest.raises(LookupError):
        demo.pick_health_checks(vended()[1:])
    with pytest.raises(ValueError):
        demo.pick_health_checks(vended() + [dict(vended()[0], healthCheckId="another")])


def without_id(check: dict) -> dict:
    return {key: value for key, value in check.items() if key != "healthCheckId"}


def test_a_check_listed_before_it_has_an_id_is_not_found_yet():
    """healthCheckId is optional in ARC's API. Counting such a check as found would hand None to the records stack."""
    with pytest.raises(LookupError) as missing:
        demo.pick_health_checks([without_id(check) for check in vended()])
    assert all(name in str(missing.value) for name in demo.ARC_NAMES)
    one_short = vended()
    one_short[3] = without_id(one_short[3])  # the second Region's check of the second name
    with pytest.raises(LookupError) as missing:
        demo.pick_health_checks(one_short)
    assert str(missing.value) == f"no health check yet for {demo.ARC_NAMES[1]} {demo.REGIONS[1]}"


def test_a_check_without_an_id_does_not_make_its_twin_ambiguous():
    picked = demo.pick_health_checks(vended() + [without_id(vended()[0])])
    assert len(picked) == 6 and None not in picked.values()


def test_health_check_context_has_the_shape_the_records_stack_reads():
    context = demo.health_check_context(demo.pick_health_checks(vended()))
    assert set(context) == set(demo.ARC_NAMES)
    assert context[UE1] == {"us-east-1": f"id-{UE1}-us-east-1", "us-east-2": f"id-{UE1}-us-east-2"}


def test_binding_problems_catch_a_swapped_pair():
    ids = demo.pick_health_checks(vended())
    records = [{"Name": f"{n}.", "SetIdentifier": r, "HealthCheckId": hc} for (n, r), hc in ids.items()]
    assert demo.binding_problems(records, ids) == []
    a, b = records[2], records[3]  # the two records of one regional name
    a["HealthCheckId"], b["HealthCheckId"] = b["HealthCheckId"], a["HealthCheckId"]
    assert len(demo.binding_problems(records, ids)) == 2


# ---- seeding -----------------------------------------------------------------------------------


def test_hundreds_of_customers_alternate_home_regions_in_batches_of_25():
    batches = demo.seed_batches()
    assert all(len(b) <= 25 for b in batches)
    items = [put["PutRequest"]["Item"] for b in batches for put in b]
    assert len({i["customerId"]["S"] for i in items}) == len(items) == demo.CUSTOMERS
    assert all(i["record"]["S"] == "profile" for i in items)
    homes = {i["customerId"]["S"]: i["homeRegion"]["S"] for i in items}
    last = demo.customer_id(demo.CUSTOMERS)
    assert (homes["cust-001"], homes["cust-002"], homes[last]) == ("us-east-1", "us-east-2", "us-east-2")
    assert {c: homes[c] for c in demo.SAMPLE_CUSTOMERS} == {"cust-001": "us-east-1", "cust-002": "us-east-2"}


def test_seed_retries_unprocessed_items_and_checks_the_other_replica():
    written, calls = [], []

    def fake_aws(region, *args):
        calls.append((region, args[1]))
        if args[1] == "batch-write-item":
            path = args[args.index("--request-items") + 1][len("file://"):]
            batch = json.loads(Path(path).read_text())[demo.TABLE]
            written.extend(p["PutRequest"]["Item"]["customerId"]["S"] for p in batch)
            if len(calls) == 1:  # DynamoDB leaves the last five of the first batch unprocessed
                return {"UnprocessedItems": {demo.TABLE: batch[-5:]}}
            return {"UnprocessedItems": {}}
        if args[1] == "get-item":
            return {"Item": {"customerId": {"S": "x"}}} if calls.count((region, "get-item")) > 1 else {}
        raise AssertionError(args)

    with mock.patch.object(demo, "aws", fake_aws), mock.patch.object(demo.time, "sleep"), mock.patch.object(demo, "say"):
        demo.cmd_seed(None)
    assert len(set(written)) == demo.CUSTOMERS and len(written) == demo.CUSTOMERS + 5
    assert all(r == "us-east-1" for r, op in calls if op == "batch-write-item")
    assert [r for r, op in calls if op == "get-item"] == ["us-east-2", "us-east-2"]


# ---- request traces ----------------------------------------------------------------------------


def hop(served, status, url, **extra):
    return {"method": "POST", "url": url, "address": extra.pop("address", "10.11.0.9"), "status": status,
            "servedBy": served, **extra}


def router_hop(region="us-east-2", target=UE1, home="us-east-1"):
    return hop(f"router {region}", 307, "http://ingest.example.com/read", location=f"http://{target}/read",
               body={"customerId": "cust-001", "homeRegion": home})


def app_hop(region, home="us-east-1", host=UE1, **body):
    return hop(f"app {region}", 200, f"http://{host}/read",
               body={"customerId": "cust-001", "homeRegion": home, "servedBy": region, **body})


def guard_hop(region, home="us-east-1"):
    """The app's home-Region guard redirecting a request that came in on the other Region's name."""
    return hop(f"app {region}", 307, f"http://{UE2}/read", location=f"http://{UE1}/read",
               body={"customerId": "cust-001", "homeRegion": home, "servedBy": region})


def test_at_rest_the_request_ends_in_the_home_region():
    exp = demo.expected_regions(ALL_HEALTHY)
    assert demo.trace_problem([router_hop(), app_hop("us-east-1")], exp) is None
    assert "expected us-east-1" in demo.trace_problem([router_hop(), app_hop("us-east-2")], exp)


def test_draining_the_home_region_moves_the_same_redirect_to_the_other():
    exp = demo.expected_regions(drained("us-east-1"))
    assert demo.trace_problem([router_hop(), app_hop("us-east-2")], exp) is None
    assert "expected us-east-2" in demo.trace_problem([router_hop(), app_hop("us-east-1")], exp)


def test_the_guard_redirect_is_a_routed_request_too():
    exp = demo.expected_regions(ALL_HEALTHY)
    assert demo.trace_problem([guard_hop("us-east-2"), app_hop("us-east-1")], exp) is None
    assert demo.hop_note(guard_hop("us-east-2")) == (
        "app in us-east-2: cust-001 has home Region us-east-1, go to ingest.ue1.example.com")


def test_a_redirect_to_another_name_or_a_trace_ending_in_a_redirect_is_a_problem():
    exp = demo.expected_regions(ALL_HEALTHY)
    assert "not ingest.ue1.example.com" in demo.trace_problem([router_hop(target=UE2), app_hop("us-east-1")], exp)
    assert "with 307" in demo.trace_problem([router_hop(), guard_hop("us-east-1"), guard_hop("us-east-1")], exp)


def test_errors_and_router_answers_are_problems():
    exp = demo.expected_regions(ALL_HEALTHY)
    timeout = [{"url": "http://ingest.example.com/read", "error": "timeout: timed out"}]
    assert demo.trace_problem(timeout, exp) == "timeout: timed out"
    unknown = hop("router us-east-2", 404, "http://ingest.example.com/read", body={"error": "unknown customer cust-001"})
    assert "router us-east-2 with 404" in demo.trace_problem([unknown], exp)
    assert demo.trace_problem([], exp) == "no response"


def test_a_missing_item_is_still_a_routed_request():
    missing = app_hop("us-east-1", key="demo", error="no item demo yet")
    missing["status"] = 404
    assert demo.trace_problem([router_hop(), missing], demo.expected_regions(ALL_HEALTHY)) is None


def test_notes_say_when_an_item_is_served_outside_its_home_region():
    read = app_hop("us-east-2", key="demo", value="{}", writtenIn="us-east-1", writtenAt="2026-10-22T17:40:02Z")
    assert demo.hop_note(read) == "app in us-east-2: read demo, written in us-east-1 at 17:40:02 (not its home Region)"
    assert demo.hop_note(router_hop()) == "router in us-east-2: cust-001 has home Region us-east-1, go to ingest.ue1.example.com"
    assert demo.hop_note(app_hop("us-east-1")) == "app in us-east-1: cust-001 has home Region us-east-1"
    assert demo.hop_note(app_hop("us-east-1", key="demo", writtenIn="us-east-1")) == "app in us-east-1: wrote demo"


def test_requests_name_the_customer_in_the_body_never_in_the_url(capsys):
    fake = FakeAws()
    with installed(fake):
        demo.main(["call", "cust-007"])
        demo.main(["status", "--samples", "1", "--interval", "0"])
    sent = [(r["method"], r["url"], r["body"]) for r in fake.requests]
    assert sent and all("cust-" not in url for _, url, _ in sent)
    assert all(json.loads(b)["customerId"].startswith("cust-") for _, _, b in sent)
    # status also sends the first sample customer to the other Region's name, to show the guard
    assert ("POST", f"http://{UE2}/read", json.dumps({"customerId": "cust-001"})) in sent


def test_call_takes_a_customer_id():
    assert demo.customer_arg("cust-001") == "cust-001"
    for bad in ("CUST-1", "cust/001", "", "a" * 41):
        with pytest.raises(argparse.ArgumentTypeError):
            demo.customer_arg(bad)


# ---- drain and restore -------------------------------------------------------------------------


def run_shift(action, target, states):
    said, calls, reads = [], [], []
    states = iter(states)

    def fake_aws(region, *args):
        calls.append((region, args))
        return {"executionId": f"{region}/abc"}

    def fake_plan_arn(region):
        reads.append(("plan", region))
        return PLAN_ARN

    def fake_health_states(arn, region):
        reads.append(("health", region))
        return next(states)

    with mock.patch.object(demo, "plan_arn", fake_plan_arn), mock.patch.object(demo, "health_states", fake_health_states), \
            mock.patch.object(demo, "aws", fake_aws), mock.patch.object(demo, "wait_for_execution", lambda *a: "completed"), \
            mock.patch.object(demo, "wait_for_dns", lambda *a: True), mock.patch.object(demo, "show", lambda *a: True), \
            mock.patch.object(demo, "say", said.append):
        ok = demo.shift(target, action, None, 1, 0)
    return said, calls, ok, reads


def test_drain_runs_the_plans_deactivate_workflow_at_the_endpoint_that_stays():
    said, calls, ok, reads = run_shift("deactivate", "us-east-1", [ALL_HEALTHY, drained("us-east-1")])
    assert said[0] == "starting ARC Region switch plan regional-affinity: deactivate workflow, target us-east-1, graceful mode"
    assert said[1] == ("  plan execution us-east-2/abc started at the us-east-2 endpoint"
                       " (a deactivate runs in the Region that stays)")
    assert said[2] == "plan execution completed: ARC marked us-east-1's health checks unhealthy at 3 of 3 record names"
    ((region, args),) = calls
    assert region == "us-east-2" and args[:2] == ("arc-region-switch", "start-plan-execution")
    assert args[args.index("--action") + 1] == "deactivate" and ok
    # the plan and the health checks are read where the drain runs, never in the Region being drained
    assert reads == [("plan", "us-east-2"), ("health", "us-east-2"), ("health", "us-east-2")]


def test_restore_runs_the_activate_workflow_at_its_target_and_counts_what_changed():
    said, calls, ok, reads = run_shift("activate", "us-east-1", [{**ALL_HEALTHY, (UE1, "us-east-1"): "unhealthy"}])
    assert said[0].startswith("starting ARC Region switch plan regional-affinity: activate workflow")
    assert said[1] == "  plan execution us-east-1/abc started at the us-east-1 endpoint (an activate runs in its target Region)"
    assert "healthy at 2 of 3 record names" in said[2]
    assert calls[0][0] == "us-east-1" and not ok  # one name did not change, so the shift reports a problem
    # the plan is read where the activate runs, the health checks from the Region that stays
    assert reads == [("plan", "us-east-1"), ("health", "us-east-2")]


def test_a_refused_drain_says_no_plan_execution_started(capsys):
    """The Region that stays is itself drained. If the precondition broke, the fake clock and the fake execution
    would let the drain run to the end at once, and the assertions below fail by name instead of after 15 minutes."""
    fake = FakeAws(drained={"us-east-2"})
    with installed(fake), pytest.raises(SystemExit):
        demo.shift("us-east-1", "deactivate", None, 1, 0)
    assert "no plan execution was started" in capsys.readouterr().err
    assert fake.started == [] and ("us-east-2", "arc-region-switch", "start-plan-execution") not in fake.calls
    assert fake.regions_called() == {"us-east-2"}


# ---- rehearsal ---------------------------------------------------------------------------------


class FakeSystem:
    """Just enough of the sample for cmd_rehearse: a drained Region, a replicated item, the guard.

    send_fails, shift_fails and health_fails make the nth call (counting from 1) fail. For a shift the value is
    (error, takes_effect): whether the Region is drained or restored before the error, as when the plan
    execution ran and a later check died."""

    def __init__(self, break_replication=False, send_fails=None, shift_fails=None, health_fails=None):
        self.drained, self.items, self.shifts = set(), {}, []
        self.break_replication = break_replication
        self.send_fails, self.shift_fails, self.health_fails = send_fails or {}, shift_fails or {}, health_fails or {}
        self.sends = self.reads = 0

    def serving(self, customer):
        home = demo.home_region_of(int(customer.split("-")[1]))
        return other_region(home) if home in self.drained else home

    def health_states(self, arn, region):
        self.reads += 1
        if self.reads in self.health_fails:
            raise self.health_fails[self.reads]
        return {key: ("unhealthy" if key[1] in self.drained else "healthy") for key in ALL_HEALTHY}

    def shift(self, target, action, *_):
        self.shifts.append((action, target))
        error, takes_effect = self.shift_fails.get(len(self.shifts), (None, True))
        if takes_effect:
            (self.drained.add if action == "deactivate" else self.drained.discard)(target)
        if error:
            raise error
        return True

    def send(self, observer, requests, expected, cidrs):
        self.sends += 1
        if self.sends in self.send_fails:
            raise self.send_fails[self.sends]
        (method, url, raw), = requests
        req = json.loads(raw)
        region = self.serving(req["customerId"])
        answer = {"customerId": req["customerId"], "servedBy": region, "key": req["key"]}
        if url.endswith("/write"):
            self.items[req["customerId"]] = req["value"]
        elif req["customerId"] in self.items and not (self.break_replication and region not in ("us-east-1",)):
            answer["value"] = self.items[req["customerId"]]
        return True, [[{"status": 200, "body": answer}]]


def other_region(region):
    return "us-east-2" if region == "us-east-1" else "us-east-1"


def run_rehearse(system):
    with mock.patch.object(demo, "plan_arn", lambda region: PLAN_ARN), \
            mock.patch.object(demo, "health_states", system.health_states), \
            mock.patch.object(demo, "shift", system.shift), mock.patch.object(demo, "send", system.send), \
            mock.patch.object(demo, "say"):
        demo.cmd_rehearse(types.SimpleNamespace(samples=1, interval=0))


def test_rehearse_drains_and_restores_each_region_in_turn():
    system = FakeSystem()
    run_rehearse(system)
    assert system.shifts == [("deactivate", "us-east-1"), ("activate", "us-east-1"),
                             ("deactivate", "us-east-2"), ("activate", "us-east-2")]
    assert not system.drained


def test_rehearse_fails_when_the_other_region_does_not_see_the_data_but_still_restores():
    system = FakeSystem(break_replication=True)
    with mock.patch("sys.stderr", new_callable=io.StringIO) as err, pytest.raises(SystemExit):
        run_rehearse(system)
    assert "during the drain cust-001 read None in us-east-2" in err.getvalue()
    assert not system.drained  # every drained Region was restored before the run failed


# The requests of the first rehearsal: 1 writes before the drain, 2 reads and 3 writes while us-east-1 is
# drained, 4 reads after the restore. The second rehearsal's are 5 to 8. Its shifts are 1 and 2, then 3 and 4.
DRAIN_AND_RESTORE_US_EAST_1 = [("deactivate", "us-east-1"), ("activate", "us-east-1")]


@pytest.mark.parametrize("error", [SystemExit(1), demo.AwsError("aws lambda invoke (us-east-2): TooManyRequestsException"),
                                   KeyboardInterrupt()], ids=["die", "aws-error", "ctrl-c"])
@pytest.mark.parametrize("request_number", [2, 3])
def test_rehearse_restores_the_region_when_anything_fails_while_it_is_drained(error, request_number):
    system = FakeSystem(send_fails={request_number: error})
    with pytest.raises(type(error)):
        run_rehearse(system)
    assert system.shifts == DRAIN_AND_RESTORE_US_EAST_1
    assert not system.drained


def test_rehearse_restores_the_second_region_too():
    system = FakeSystem(send_fails={6: SystemExit(1)})
    with pytest.raises(SystemExit):
        run_rehearse(system)
    assert system.shifts == [("deactivate", "us-east-1"), ("activate", "us-east-1"),
                             ("deactivate", "us-east-2"), ("activate", "us-east-2")]
    assert not system.drained


def test_rehearse_leaves_a_region_it_never_drained_alone(capsys):
    system = FakeSystem(send_fails={1: SystemExit(1)})
    with pytest.raises(SystemExit):
        run_rehearse(system)
    assert system.shifts == [] and system.reads == 1  # not even a look at ARC: nothing was drained
    assert "drained" not in capsys.readouterr().err


def test_a_failure_before_the_drain_never_claims_a_region_is_drained(capsys):
    """ARC unreadable from the first call (no permission, expired credentials) must not end in "still drained"."""
    system = FakeSystem(health_fails={1: demo.AwsError("aws arc-region-switch (us-east-2): AccessDeniedException")})
    with pytest.raises(demo.AwsError):
        run_rehearse(system)
    assert system.shifts == [] and "drained" not in capsys.readouterr().err


def test_a_failure_after_the_restore_has_nothing_left_to_restore(capsys):
    system = FakeSystem(send_fails={4: SystemExit(1)})  # the read after us-east-1 is restored
    with pytest.raises(SystemExit):
        run_rehearse(system)
    assert system.shifts == DRAIN_AND_RESTORE_US_EAST_1 and not system.drained
    assert "drained" not in capsys.readouterr().err


def test_rehearse_restores_a_region_whose_drain_started_but_did_not_finish():
    """The plan execution ran and then something died (a paused step, a probe error): the Region is drained."""
    system = FakeSystem(shift_fails={1: (SystemExit(1), True)})
    with pytest.raises(SystemExit):
        run_rehearse(system)
    assert system.shifts == DRAIN_AND_RESTORE_US_EAST_1
    assert not system.drained


def test_rehearse_does_not_run_a_second_activate_when_the_first_one_worked():
    system = FakeSystem(shift_fails={2: (SystemExit(1), True)})  # the restore ran; a check after it died
    with pytest.raises(SystemExit):
        run_rehearse(system)
    assert system.shifts == DRAIN_AND_RESTORE_US_EAST_1
    assert not system.drained


def test_rehearse_tries_the_restore_once_more_when_its_own_restore_did_not_work():
    system = FakeSystem(shift_fails={2: (SystemExit(1), False)})
    with pytest.raises(SystemExit):
        run_rehearse(system)
    assert system.shifts == [*DRAIN_AND_RESTORE_US_EAST_1, ("activate", "us-east-1")]
    assert not system.drained


def test_rehearse_restores_even_when_arc_cannot_be_read_to_check():
    unreadable = demo.AwsError("aws arc-region-switch list-route53-health-checks-in-region (us-east-2): failed")
    system = FakeSystem(send_fails={2: SystemExit(1)}, health_fails={3: unreadable})
    with pytest.raises(SystemExit):
        run_rehearse(system)
    assert system.shifts == DRAIN_AND_RESTORE_US_EAST_1
    assert not system.drained


@pytest.mark.parametrize("second_error", [SystemExit(1), KeyboardInterrupt()], ids=["die", "ctrl-c"])
def test_rehearse_says_how_to_restore_by_hand_when_the_restore_fails_too(second_error, capsys):
    system = FakeSystem(send_fails={2: SystemExit(7)}, shift_fails={2: (second_error, False)})
    with pytest.raises(SystemExit) as stopped:
        run_rehearse(system)
    assert stopped.value.code == 7  # the error that stopped the rehearsal is the one that propagates
    assert system.shifts == DRAIN_AND_RESTORE_US_EAST_1  # one try, not a loop
    assert system.drained == {"us-east-1"}
    assert "error: us-east-1 is still drained: run make restore REGION=us-east-1" in capsys.readouterr().err


def test_rehearse_does_not_claim_more_than_it_knows_when_arc_cannot_be_read_and_the_restore_fails(capsys):
    unreadable = demo.AwsError("aws arc-region-switch list-route53-health-checks-in-region (us-east-2): failed")
    system = FakeSystem(send_fails={2: SystemExit(1)}, health_fails={3: unreadable}, shift_fails={2: (SystemExit(1), False)})
    with pytest.raises(SystemExit):
        run_rehearse(system)
    err = capsys.readouterr().err
    assert ("error: us-east-1 may still be drained (ARC could not be read to check): "
            "run make status, then run make restore REGION=us-east-1 if it is") in err
    assert "is still drained" not in err


def test_a_second_ctrl_c_while_rehearse_checks_arc_stops_without_starting_the_restore(capsys):
    system = FakeSystem(send_fails={2: SystemExit(7)}, health_fails={3: KeyboardInterrupt()})
    with pytest.raises(SystemExit) as stopped:
        run_rehearse(system)
    assert stopped.value.code == 7  # still the error that stopped the rehearsal
    assert system.shifts == [("deactivate", "us-east-1")] and system.drained == {"us-east-1"}  # the user said stop
    assert "error: us-east-1 may still be drained" in capsys.readouterr().err
