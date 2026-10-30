"""What the demo.py tests share: constants, a clock that does not wait, and a fake of the AWS calls."""
from __future__ import annotations

import contextlib
import ipaddress
import json
import time as real_time
from pathlib import Path
from typing import NamedTuple
from unittest import mock
from urllib.parse import urlsplit

import demo

ACCOUNT = "111122223333"
OTHER_ACCOUNT = "ACCOUNT_ID"  # the pin only has to differ from the credentials' account
CIDRS = {"us-east-1": ipaddress.ip_network("10.11.0.0/16"), "us-east-2": ipaddress.ip_network("10.12.0.0/16")}
ALL_HEALTHY = {(name, region): "healthy" for name in demo.ARC_NAMES for region in demo.REGIONS}
PLAN_ARN = "arn:aws:arc-region-switch::111122223333:plan/regional-affinity:abc123"
OTHER_PLAN_ARN = "arn:aws:arc-region-switch::111122223333:plan/something-else:def456"
UE1, UE2 = "ingest.ue1.example.com", "ingest.ue2.example.com"


def vended() -> list:
    """The six health checks ARC lists for the plan, as list-route53-health-checks returns them."""
    return [{"recordName": f"{name}.", "region": region, "healthCheckId": f"id-{name}-{region}", "status": "healthy"}
            for name in demo.ARC_NAMES for region in demo.REGIONS]


def drained(region: str) -> dict:
    """ARC's states after a deactivate execution of region: that Region's checks are unhealthy."""
    return {key: ("unhealthy" if key[1] == region else "healthy") for key in ALL_HEALTHY}


class FakeClock:
    """Stands in for demo.time. sleep() moves the clock instead of waiting, so a loop that runs until its
    time limit ends at once, and a test that goes wrong fails instead of hanging for 15 minutes."""

    def __init__(self):
        self.now, self.sleeps = 1_000_000.0, []

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds

    strftime = staticmethod(real_time.strftime)


class FakeAws:
    """The AWS calls the operate commands make, answered the way the sample would answer them.

    calls records (Region, service, operation) for every call, and requests the HTTP requests sent through the
    probe. A call addressed to a Region in down raises, as it does when that Region's endpoints cannot be
    reached. A plan execution moves the Region's health checks at once, unless stuck: then ARC completes it
    and marks nothing. With stale_dns the resolver goes on answering as if nothing were drained."""

    def __init__(self, down=(), drained=(), stuck=False, stale_dns=False):
        self.down, self.drained, self.stuck, self.stale_dns = set(down), set(drained), stuck, stale_dns
        self.calls, self.started, self.requests = [], [], []

    def health(self, drained=None) -> dict:
        drained = self.drained if drained is None else drained
        return {(name, region): ("unhealthy" if region in drained else "healthy")
                for name in demo.ARC_NAMES for region in demo.REGIONS}

    def regions_called(self) -> set:
        return {region for region, _, _ in self.calls}

    def __call__(self, region, service, operation, *args):
        self.calls.append((region, service, operation))
        if region in self.down:
            raise demo.AwsError(f"aws {service} {operation} ({region}): Could not connect to the endpoint URL")
        handler = getattr(self, f"{service}_{operation}".replace("-", "_"), None)
        if handler is None:
            raise AssertionError(f"unexpected AWS call: {region} {service} {operation} {args}")
        return handler(region, args)

    def sts_get_caller_identity(self, region, args):
        return {"Account": ACCOUNT, "Arn": f"arn:aws:sts::{ACCOUNT}:assumed-role/operator/me"}

    def arc_region_switch_list_plans_in_region(self, region, args):
        return {"plans": [{"name": "something-else", "arn": OTHER_PLAN_ARN, "regions": list(demo.REGIONS)},
                          {"name": demo.PROJECT, "arn": PLAN_ARN, "regions": list(demo.REGIONS)}]}

    def arc_region_switch_list_route53_health_checks_in_region(self, region, args):
        assert args == ("--arn", PLAN_ARN)
        return {"healthChecks": [{"recordName": f"{name}.", "region": r, "healthCheckId": f"id-{name}-{r}", "status": status}
                                 for (name, r), status in self.health().items()]}

    def arc_region_switch_start_plan_execution(self, region, args):
        options = dict(zip(args[::2], args[1::2]))
        assert options["--plan-arn"] == PLAN_ARN
        target, action = options["--target-region"], options["--action"]
        self.started.append((region, target, action))
        if not self.stuck:
            (self.drained.add if action == "deactivate" else self.drained.discard)(target)
        return {"executionId": f"{region}/{len(self.started)}"}

    def arc_region_switch_get_plan_execution(self, region, args):
        return {"executionState": "completed", "stepStates": []}

    def lambda_invoke(self, region, args):
        assert args[args.index("--function-name") + 1] == f"{demo.PROJECT}-probe"
        payload = json.loads(args[args.index("--payload") + 1])
        expected = demo.expected_regions(self.health(set() if self.stale_dns else None))
        out = {"region": region, "resolver": "10.0.0.2"}
        if "requests" in payload:
            self.requests.extend(payload["requests"])
            out["traces"] = [self.trace(request, expected) for request in payload["requests"]]
        else:
            out["results"] = {name: [self.answer(expected[name])] * payload["samples"] for name in payload["names"]}
        Path(args[-1]).write_text(json.dumps(out))
        return {"StatusCode": 200}

    @staticmethod
    def address(region: str) -> str:
        return str(CIDRS[region][4])

    def answer(self, regions: set) -> dict:
        return {"rcode": "NOERROR", "ttl": 60, "addresses": [self.address(sorted(regions)[0])]}

    def trace(self, request: dict, expected: dict) -> list:
        """A request for a customer as the router and the app would answer it: the router, or the app's guard,
        redirects to the customer's home Region name, and the app that name resolves to answers."""
        customer = json.loads(request["body"])["customerId"]
        home = demo.home_region_of(int(customer.split("-")[1]))
        url, hops = request["url"], []
        for _ in range(3):
            host, path = urlsplit(url).hostname, urlsplit(url).path
            region = sorted(expected[host])[0]
            hop = {"method": request["method"], "url": url, "address": self.address(region),
                   "body": {"customerId": customer, "homeRegion": home, "servedBy": region}}
            hops.append(hop)
            if host == demo.REGIONAL[home]:
                hop.update(status=200, servedBy=f"app {region}", location=None)
                break
            hop.update(status=307, servedBy=f"{'router' if host == demo.REGION_LESS else 'app'} {region}",
                       location=f"http://{demo.REGIONAL[home]}{path}")
            url = hop["location"]
        return hops


@contextlib.contextmanager
def installed(fake: FakeAws):
    """Run demo against fake, with a clock that does not wait; yields the clock."""
    clock = FakeClock()
    with mock.patch.object(demo, "aws", fake), mock.patch.object(demo, "time", clock):
        yield clock


class Ran(NamedTuple):
    code: int
    err: str
    out: str


def run_main(capsys, *argv) -> Ran:
    """demo.main(argv): its exit code (0 when it returns) and what it printed to stderr and stdout."""
    code = 0
    try:
        demo.main(list(argv))
    except SystemExit as exc:
        code = exc.code
    captured = capsys.readouterr()
    return Ran(code, captured.err, captured.out)
