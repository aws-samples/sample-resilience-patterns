"""Operate the regional-affinity sample: seed it, check it, send requests, drain or restore a Region.

The Makefile runs every command; run them directly with the same environment if you prefer:

  PROJECT     stack and resource prefix                  (default regional-affinity)
  REGIONS     the two Regions, first one first           (default us-east-1,us-east-2)
  DOMAIN      private hosted zone name                   (default example.com)
  APP_LABEL   first label of every record name           (default ingest)
  ACCOUNT     refuse to run against any other account    (optional)
  PROFILE     AWS CLI profile                            (optional; else the CLI's credential chain)

  python3 scripts/demo.py status [--from us-east-1] [--samples 20] [--interval 0.5]
  python3 scripts/demo.py call cust-001 [--from us-east-1]
  python3 scripts/demo.py drain us-east-1
  python3 scripts/demo.py restore us-east-1
  python3 scripts/demo.py rehearse
  python3 scripts/demo.py seed | health-checks [--json] | verify | names --json

drain and restore each start an execution of the ARC Region switch plan: its deactivate workflow
drains a Region and its activate workflow restores it, at all three ARC-controlled record names.
drain, restore, status and call exit 1 when a check they print fails.

Every command but names makes AWS calls, and all but the three deploy-time ones make data plane calls
and no CloudFormation call: the plan is found by name, the probe has a fixed name and the VPC CIDRs
are constants. So drain talks only to the Region that stays, restore to the Region it restores and the
one that stays, and status and call to the Region they query from (--from). rehearse needs both Regions.
seed, health-checks and verify run at deploy time and read stack outputs and ARC's control plane at the
first Region.

All AWS calls go through the AWS CLI v2, so this needs only the Python 3.9+ standard library.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from typing import NoReturn
from urllib.parse import urlsplit

PROJECT = os.environ.get("PROJECT") or "regional-affinity"
DOMAIN = os.environ.get("DOMAIN") or "example.com"
APP_LABEL = os.environ.get("APP_LABEL") or "ingest"
PROFILE = os.environ.get("PROFILE") or None


def region_label(region: str) -> str:
    """us-east-1 -> ue1: the first letter of each word, then the number (the same rule as lib/names.ts)."""
    parts = region.split("-")
    if len(parts) < 3 or not parts[-1].isdigit() or not all(re.fullmatch(r"[a-z0-9]+", p) for p in parts):
        raise ValueError(f'"{region}" is not an AWS Region name such as us-east-1')
    return "".join(p[0] for p in parts[:-1]) + parts[-1]


def parse_regions(value: str) -> tuple:
    """The two Regions of a comma-separated list, by the rules of parseRegions in lib/names.ts."""
    regions = tuple(r.strip() for r in value.split(",") if r.strip())
    if len(regions) != 2 or regions[0] == regions[1]:
        raise ValueError("it must name two different Regions, such as us-east-1,us-east-2")
    labels = [region_label(r) for r in regions]
    if labels[0] == labels[1]:
        raise ValueError(f"{regions[0]} and {regions[1]} would get the same label, {labels[0]}")
    return regions


DEFAULT_REGIONS = "us-east-1,us-east-2"
try:
    REGIONS, SETTINGS_ERROR = parse_regions(os.environ.get("REGIONS") or DEFAULT_REGIONS), None
except ValueError as exc:
    # The defaults keep this module importable, so a bad value ends in the one-line error main() prints
    # before it does anything, not in a traceback at import. (PROJECT, DOMAIN and APP_LABEL are only
    # pasted into names, so no value of theirs can raise here.)
    REGIONS, SETTINGS_ERROR = parse_regions(DEFAULT_REGIONS), f'REGIONS="{os.environ.get("REGIONS")}" cannot be used: {exc}'

FIRST = REGIONS[0]  # holds the data, plan and records stacks
REGION_LESS = f"{APP_LABEL}.{DOMAIN}"
REGIONAL = {r: f"{APP_LABEL}.{region_label(r)}.{DOMAIN}" for r in REGIONS}
APP_NAME = {r: f"{APP_LABEL}-app.{region_label(r)}.{DOMAIN}" for r in REGIONS}
ARC_NAMES = (REGION_LESS, *REGIONAL.values())
ALL_NAMES = (*ARC_NAMES, *APP_NAME.values())

TABLE = f"{PROJECT}-customers"
# Both are fixed by the stacks (lib/region-stack.ts names the probe, lib/names.ts holds the CIDRs; a test
# compares each), so no command has to ask CloudFormation for them, in either Region.
PROBE_FUNCTION = f"{PROJECT}-probe"
VPC_CIDRS = ("10.11.0.0/16", "10.12.0.0/16")  # the first and the second Region
STACK = {"data": f"{PROJECT}-data", "plan": f"{PROJECT}-plan", "records": f"{PROJECT}-records",
         **{r: f"{PROJECT}-region-{r}" for r in REGIONS}}

# cust-001 to cust-300: odd-numbered customers have their home in the first Region, even in the second.
CUSTOMERS = 300
SAMPLE_CUSTOMERS = ("cust-001", "cust-002")  # one per home Region, for status
REDIRECTS = (301, 302, 303, 307, 308)

DONE = ("completed", "completedWithExceptions", "completedMonitoringApplicationHealth",
        "failed", "canceled", "planExecutionTimedOut")
SUCCEEDED = ("completed", "completedMonitoringApplicationHealth")
PAUSED = ("pausedByFailedStep", "pausedByOperator", "pendingManualApproval")
# The fields UpdatePlan accepts, copied from GetPlan for a no-op update. serviceQuotaChecksEnabled is one of
# them: an update that leaves it out might reset the setting.
UPDATE_KEYS = ("arn", "description", "workflows", "executionRole", "recoveryTimeObjectiveMinutes",
               "associatedAlarms", "triggers", "reportConfiguration", "serviceQuotaChecksEnabled")
# The error codes worth another try. Anything else (AccessDenied, ResourceNotFound, ValidationException, an
# expired token) fails the same way next time.
TRANSIENT = ("ThrottlingException", "Throttling", "ThrottledException", "TooManyRequestsException", "RequestLimitExceeded",
             "InternalServerException", "InternalFailure", "ServiceUnavailable", "ServiceUnavailableException",
             "RequestTimeout", "RequestTimeoutException")


class AwsError(RuntimeError):
    def __init__(self, message: str, code: str = ""):
        super().__init__(message)
        self.code = code  # the error code the CLI printed, such as AccessDeniedException; "" when it printed none


def transient(error: AwsError) -> bool:
    """Throttling, a server-side error or a connection problem. The CLI prints a connection problem with no code."""
    return error.code in TRANSIENT or (not error.code and "endpoint URL" in str(error))


def say(message: str) -> None:
    """Progress lines go to stderr, so `health-checks --json` prints only JSON on stdout."""
    print(f"{time.strftime('%H:%M:%S')} {message}", file=sys.stderr, flush=True)


def die(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr, flush=True)
    sys.exit(1)


def other(region: str) -> str:
    return REGIONS[1] if region == REGIONS[0] else REGIONS[0]


def aws_cmd(region: str, *args: str) -> list:
    cmd = ["aws", "--region", region, "--no-cli-pager", *args]
    return cmd + ["--profile", PROFILE] if PROFILE else cmd


def aws(region: str, *args: str) -> dict:
    done = subprocess.run(aws_cmd(region, "--output", "json", *args), capture_output=True, text=True)
    if done.returncode:
        lines = done.stderr.strip().splitlines()
        code = re.search(r"An error occurred \((\w+)\)", done.stderr)
        raise AwsError(f"aws {' '.join(args[:2])} ({region}): {lines[-1] if lines else 'failed'}", code.group(1) if code else "")
    return json.loads(done.stdout) if done.stdout.strip() else {}


@contextmanager
def json_file(data):
    """A temporary JSON file for file:// arguments, removed afterwards."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(data, handle)
    try:
        yield handle.name
    finally:
        os.unlink(handle.name)


# ---- pure logic (unit tested) ------------------------------------------------------------


def pick_health_checks(health_checks: list) -> dict:
    """{(record name, Region): health check ID} for exactly the six checks the records need.

    Raises LookupError while any is missing (the plan may still be vending them) and ValueError
    if a record name and Region has more than one check, which nothing should paper over. ARC can
    list a check before it has an ID (healthCheckId is optional in its API); that one is not found yet."""
    wanted = [(name, region) for name in ARC_NAMES for region in REGIONS]
    found: dict = {}
    for hc in health_checks:
        if not hc.get("healthCheckId"):
            continue
        key = (hc.get("recordName", "").rstrip(".").lower(), hc.get("region"))
        found.setdefault(key, set()).add(hc["healthCheckId"])
    ambiguous = [f"{n} {r}: {sorted(ids)}" for (n, r), ids in found.items() if (n, r) in wanted and len(ids) > 1]
    if ambiguous:
        raise ValueError("more than one health check for " + "; ".join(ambiguous))
    missing = [f"{n} {r}" for n, r in wanted if (n, r) not in found]
    if missing:
        raise LookupError("no health check yet for " + ", ".join(missing))
    return {key: next(iter(found[key])) for key in wanted}


def health_check_context(ids: dict) -> dict:
    """{record name: {Region: ID}}, the shape the records stack reads from -c healthChecks."""
    out: dict = {}
    for (name, region), hc_id in ids.items():
        out.setdefault(name, {})[region] = hc_id
    return out


def binding_problems(record_sets: list, expected: dict) -> list:
    """Live records against the health checks they should carry. Each SetIdentifier is a Region."""
    live = {(r["Name"].rstrip(".").lower(), r.get("SetIdentifier")): r.get("HealthCheckId")
            for r in record_sets if r.get("SetIdentifier")}
    problems = []
    for (name, region), hc_id in expected.items():
        actual = live.get((name, region))
        if actual != hc_id:
            problems.append(f"{name} [{region}] carries {actual or 'no health check'}, expected {hc_id}")
    return problems


def record_roles(health: dict) -> dict:
    """{(record name, Region): (role, health check state, answering)} for the six ARC-bound records.

    The role is the record's place in its routing policy: weighted for the region-less name, and
    primary or standby (Route 53's SECONDARY) for a regional name. answering says whether Route 53
    returns that record for these health check states."""

    def healthy(name: str, region: str) -> bool:
        return health.get((name, region)) == "healthy"

    def state(name: str, region: str) -> str:
        return health.get((name, region), "unknown")

    # A weighted record answers while its check is healthy; with none healthy, all of them answer.
    eligible = [r for r in REGIONS if healthy(REGION_LESS, r)] or list(REGIONS)
    roles = {(REGION_LESS, r): ("weighted", state(REGION_LESS, r), r in eligible) for r in REGIONS}
    for primary in REGIONS:
        name, standby = REGIONAL[primary], other(primary)
        # The primary answers while its check is healthy, and also when both checks are unhealthy;
        # the standby answers only when it is healthy and the primary is not.
        takes_over = not healthy(name, primary) and healthy(name, standby)
        roles[(name, primary)] = ("primary", state(name, primary), not takes_over)
        roles[(name, standby)] = ("standby", state(name, standby), takes_over)
    return roles


def expected_regions(health: dict) -> dict:
    """The Region(s) Route 53 should answer with for each name, given ARC's health check states."""
    roles = record_roles(health)
    expected = {APP_NAME[r]: {r} for r in REGIONS}
    for name in REGIONAL.values():
        # Each regional record sends traffic to the Region named by its set identifier.
        expected[name] = {r for r in REGIONS if roles[(name, r)][2]}
    # Each region-less weighted record aliases the regional name of its own Region.
    eligible = [r for r in REGIONS if roles[(REGION_LESS, r)][2]]
    expected[REGION_LESS] = set().union(*(expected[REGIONAL[r]] for r in eligible))
    return expected


def plan_name(plan_arn: str) -> str:
    """regional-affinity from arn:aws:arc-region-switch::111122223333:plan/regional-affinity:abc123."""
    return plan_arn.split(":plan/", 1)[-1].split(":", 1)[0]


def region_summary(health: dict) -> str:
    """'us-east-1 drained, us-east-2 active' from ARC's health check states."""
    states = []
    for region in REGIONS:
        values = {health.get((name, region)) for name in ARC_NAMES}
        states.append(f"{region} {'active' if values == {'healthy'} else 'drained' if values == {'unhealthy'} else 'mixed'}")
    return ", ".join(states)


def answered_regions(addresses: list, cidrs: dict) -> set:
    """Map answer addresses to Regions by VPC CIDR; an address in neither VPC is shown as itself."""
    regions = set()
    for address in addresses:
        ip = ipaddress.ip_address(address)
        regions.add(next((r for r, net in cidrs.items() if ip in net), address))
    return regions


def summarize(samples: list, cidrs: dict) -> dict:
    counts, problems, ttls = Counter(), Counter(), []
    for sample in samples:
        if "error" in sample:
            problems[sample["error"]] += 1
        elif sample.get("rcode") != "NOERROR" or not sample.get("addresses"):
            problems[sample.get("rcode") if sample.get("rcode") != "NOERROR" else "no answer"] += 1
        else:
            for region in answered_regions(sample["addresses"], cidrs):
                counts[region] += 1
            ttls.append(sample["ttl"])
    return {"counts": counts, "problems": problems, "ttls": ttls}


def matches(name: str, seen: set, expected: set) -> bool:
    if not seen:
        return False
    # A weighted name answers one Region at a time and resolvers cache each answer for its
    # TTL, so a short sample of the region-less name can show only one eligible Region.
    return seen <= expected if name == REGION_LESS else seen == expected


def customer_id(n: int) -> str:
    return f"cust-{n:03d}"


def home_region_of(n: int) -> str:
    return REGIONS[(n - 1) % len(REGIONS)]


def profile_key(customer: str) -> dict:
    return {"customerId": {"S": customer}, "record": {"S": "profile"}}


def seed_batches(count: int = CUSTOMERS, size: int = 25) -> list:
    """BatchWriteItem request lists (at most 25 puts each) for every customer's profile item."""
    puts = [{"PutRequest": {"Item": {**profile_key(customer_id(n)), "homeRegion": {"S": home_region_of(n)}}}}
            for n in range(1, count + 1)]
    return [puts[i:i + size] for i in range(0, len(puts), size)]


def served_by(hop: dict) -> tuple:
    """('router', 'us-east-2') from the X-Served-By header the two functions set, else (None, None)."""
    parts = (hop.get("servedBy") or "").split()
    return (parts[0], parts[1]) if len(parts) == 2 else (None, None)


def trace_problem(hops: list, expected: dict) -> str | None:
    """Why a request did not end at the app in the Region DNS sends its customer's home Region name to.

    expected is expected_regions() for ARC's current health check states. None means it did: every
    redirect pointed at the customer's home Region name, and the app that answered runs in the
    Region that name resolves to."""
    if not hops:
        return "no response"
    errors = [hop["error"] for hop in hops if "error" in hop]
    if errors:
        return errors[0]
    last = hops[-1]
    role, region = served_by(last)
    if role != "app" or last.get("status") in REDIRECTS:
        return f"ended at {last.get('servedBy') or 'a responder without X-Served-By'} with {last.get('status')}"
    home = last.get("body", {}).get("homeRegion") if isinstance(last.get("body"), dict) else None
    if home not in REGIONAL:
        return f"the app reported no known home Region ({home})"
    for hop in hops[:-1]:
        target = urlsplit(hop.get("location") or "").hostname
        if target != REGIONAL[home]:
            return f"redirected to {target}, not {REGIONAL[home]}"
    want = expected[REGIONAL[home]]
    if region not in want:
        return f"served in {region}, expected {' or '.join(sorted(want))}"
    return None


def hop_note(hop: dict) -> str:
    """One line on what a response said."""
    if "error" in hop:
        return hop["error"]
    role, region = served_by(hop)
    body = hop.get("body") if isinstance(hop.get("body"), dict) else {}
    if hop.get("status") in REDIRECTS:
        target = urlsplit(hop.get("location") or "").hostname
        who = f"{role} in {region}" if role else "redirect"
        return f"{who}: {body.get('customerId', '?')} has home Region {body.get('homeRegion', '?')}, go to {target}"
    if role != "app":
        return f"{hop.get('servedBy') or 'no X-Served-By header'}: {body.get('error') or str(hop.get('body'))[:60]}"
    outside = "" if "key" not in body or body.get("homeRegion") == region else " (not its home Region)"
    if "error" in body:
        return f"app in {region}: {body['error']}{outside}"
    if "key" not in body:
        return f"app in {region}: {body.get('customerId')} has home Region {body.get('homeRegion')}"
    if "value" not in body:
        return f"app in {region}: wrote {body.get('key')}{outside}"
    return (f"app in {region}: read {body.get('key')}, written in {body.get('writtenIn')}"
            f" at {str(body.get('writtenAt'))[11:19]}{outside}")


def final_answer(hops: list) -> dict:
    """The JSON body of the last response of a trace, or {}."""
    body = hops[-1].get("body") if hops else None
    return body if isinstance(body, dict) else {}


# ---- AWS reads -----------------------------------------------------------------------------
#
# drain, restore, status, call and rehearse read only what the Regions they use can tell them, with data plane
# calls (the plan by name, the health checks, the probe by its fixed name) and no CloudFormation, so a drain does
# not depend on the Region it drains. seed, health-checks and verify run at deploy time and read CloudFormation
# outputs and ARC's control plane at the first Region.


def check_account(expected: str | None, region: str) -> None:
    """Print the account in use, and stop before any change if it is not the one pinned.

    region is the Region the command acts in (see acting_region), so the check needs no other Region."""
    who = aws(region, "sts", "get-caller-identity")
    if expected and who.get("Account") != expected:
        die(f"these credentials are for account {who.get('Account')}, not {expected}; nothing was changed")
    say(f"account {who.get('Account')} as {who.get('Arn')} (checked in {region})")


def stack_outputs(region: str, stack: str) -> dict:
    try:
        data = aws(region, "cloudformation", "describe-stacks", "--stack-name", stack)
    except AwsError as exc:
        die(f"cannot read stack {stack} in {region} ({exc}); run make deploy first")
    return {o["OutputKey"]: o["OutputValue"] for o in data["Stacks"][0].get("Outputs", [])}


def plan_arn(region: str) -> str:
    """The ARN of the Region switch plan, found by name (the plan is named PROJECT) at region's data plane endpoint."""
    plans = aws(region, "arc-region-switch", "list-plans-in-region").get("plans", [])
    arns = [plan["arn"] for plan in plans if plan.get("name") == PROJECT]
    if not arns:
        die(f"no Region switch plan named {PROJECT} at the {region} endpoint; run make deploy first")
    if len(arns) > 1:
        die(f"more than one Region switch plan is named {PROJECT} at the {region} endpoint: {', '.join(arns)}")
    return arns[0]


def plan_arn_from_stack() -> str:
    """The same ARN from the plan stack's output, for deploy time: CloudFormation has it the moment the plan exists."""
    return stack_outputs(FIRST, STACK["plan"])["PlanArn"]


def vpc_cidrs() -> dict:
    return {r: ipaddress.ip_network(cidr) for r, cidr in zip(REGIONS, VPC_CIDRS)}


def health_states(arn: str, region: str) -> dict:
    """{(record name, Region): healthy | unhealthy | unknown}, read at region's data plane endpoint and no other."""
    try:
        data = aws(region, "arc-region-switch", "list-route53-health-checks-in-region", "--arn", arn)
    except AwsError as exc:
        die(f"cannot read the ARC health checks: {exc}")
    return {(hc["recordName"].rstrip(".").lower(), hc["region"]): hc.get("status", "unknown")
            for hc in data.get("healthChecks", [])}


def invoke_probe(region: str, payload: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "probe.json"
        meta = aws(region, "lambda", "invoke", "--function-name", PROBE_FUNCTION,
                   "--cli-binary-format", "raw-in-base64-out", "--cli-read-timeout", "90",
                   "--payload", json.dumps(payload), str(out))
        body = json.loads(out.read_text() or "{}")
    if meta.get("FunctionError"):
        die(f"the probe in {region} failed: {body.get('errorMessage', body)}")
    return body


def run_probe(region: str, samples: int, interval: float) -> dict:
    return invoke_probe(region, {"names": list(ALL_NAMES), "samples": samples, "interval": interval})


def run_requests(region: str, requests: list) -> list:
    return invoke_probe(region, {"requests": [{"method": m, "url": u, "body": b} for m, u, b in requests]})["traces"]


# ---- output --------------------------------------------------------------------------------


def print_health(health: dict, endpoint: str) -> None:
    roles = record_roles(health)
    print(f"\nARC health checks, set by the Region switch plan (read at the {endpoint} endpoint)")
    print(f"  {'record name':<28} {REGIONS[0]:<32} {REGIONS[1]}")
    for name in ARC_NAMES:
        cells = []
        for region in REGIONS:
            role, state, answering = roles[(name, region)]
            cells.append(f"{role:<9} {state:<10} {'answering' if answering else ''}".rstrip())
        print(f"  {name:<28} {cells[0]:<32} {cells[1]}")
    print("  (standby: the SECONDARY record of a failover pair. answering: the record Route 53 returns"
          " for these health checks)")


def print_dns(probe: dict, expected: dict, cidrs: dict, samples: int, interval: float) -> bool:
    spacing = f", {interval:g}s apart" if samples > 1 else ""
    print(f"\nDNS answers from inside the {probe['region']} VPC (resolver {probe['resolver']}), "
          f"{samples} {'query' if samples == 1 else 'queries'} per name{spacing}")
    print(f"  {'name':<28} {'answered by':<30} {'ttl':<8} expected")
    all_ok, partial_weighted = True, False
    for name in ALL_NAMES:
        s = summarize(probe["results"].get(name, []), cidrs)
        seen = set(s["counts"])
        parts = [f"{r} x{n}" for r, n in sorted(s["counts"].items())] + [f"{p} x{n}" for p, n in s["problems"].items()]
        ttls = sorted(t for t in s["ttls"] if t is not None)
        ttl = "-" if not ttls else str(ttls[0]) if ttls[0] == ttls[-1] else f"{ttls[0]}-{ttls[-1]}"
        ok = matches(name, seen, expected[name]) and not s["problems"]
        all_ok = all_ok and ok
        partial_weighted = partial_weighted or (name == REGION_LESS and ok and seen != expected[name])
        print(f"  {name:<28} {', '.join(parts) or '-':<30} {ttl:<8} "
              f"{' + '.join(sorted(expected[name])):<22} {'ok' if ok else 'DIFFERS'}")
    if partial_weighted:
        print("  (the region-less name showed one Region: the VPC resolver caches each weighted answer for its"
              " TTL, so the split appears across clients and over time; use more samples spread wider)")
    if not all_ok:
        print("  (DIFFERS right after an execution is usually DNS caching; answers can lag by up to the TTL)")
    return all_ok


def print_trace(hops: list, cidrs: dict, expected: dict) -> str | None:
    for hop in hops:
        host = urlsplit(hop.get("url", "")).hostname or "?"
        address = hop.get("address", "-")
        alb = ", ".join(sorted(answered_regions([address], cidrs))) if "address" in hop else "-"
        print(f"    {host:<26} {address:<13} {alb:<10} {hop.get('status', '-')!s:<4} {hop_note(hop)}")
    problem = trace_problem(hops, expected)
    print(f"    {'ok' if problem is None else 'DIFFERS: ' + problem}")
    return problem


def send(observer: str, requests: list, expected: dict, cidrs: dict) -> tuple:
    """Send (method, URL, body) requests from inside observer's VPC, print them; (all ok, traces)."""
    traces = run_requests(observer, requests)
    print(f"\nRequests from inside the {observer} VPC, one line per response")
    print(f"    {'name':<26} {'address':<13} {'ALB in':<10} {'code':<4} answer")
    problems = []
    for (method, url, body), hops in zip(requests, traces):
        print(f"  {method} {url} {body or ''}".rstrip())
        problems.append(print_trace(hops, cidrs, expected))
    if any(p and p.startswith("served in") for p in problems):
        print("  (a Region that differs right after an execution is usually DNS caching; answers can lag by up to the TTL)")
    return len(problems) == len(requests) and not any(problems), traces


def body(customer: str, key: str | None = None, **extra) -> str:
    return json.dumps({"customerId": customer, **({"key": key} if key else {}), **extra})


def show(arn: str, observer: str, samples: int, interval: float, cidrs: dict) -> bool:
    health = health_states(arn, observer)
    print_health(health, observer)
    expected = expected_regions(health)
    dns_ok = print_dns(run_probe(observer, samples, interval), expected, cidrs, samples, interval)
    requests = [("POST", f"http://{REGION_LESS}/read", body(c)) for c in SAMPLE_CUSTOMERS]
    # The home-Region guard: the first sample customer sent straight to the other Region's name.
    first_home = home_region_of(1)
    requests.append(("POST", f"http://{REGIONAL[other(first_home)]}/read", body(SAMPLE_CUSTOMERS[0])))
    requests_ok, _ = send(observer, requests, expected, cidrs)
    return requests_ok and dns_ok


# ---- deploy steps --------------------------------------------------------------------------


def cmd_seed(_args) -> None:
    """Write every customer's profile item to one replica, then read the last one back from the other."""
    say(f"seeding {CUSTOMERS} customers in the {FIRST} replica of {TABLE}:"
        f" odd-numbered have their home in {REGIONS[0]}, even-numbered in {REGIONS[1]}")
    for batch in seed_batches():
        pending = {TABLE: batch}
        for attempt in range(6):
            with json_file(pending) as path:
                result = aws(FIRST, "dynamodb", "batch-write-item", "--request-items", f"file://{path}")
            pending = result.get("UnprocessedItems") or {}
            if not pending:
                break
            time.sleep(2 ** attempt)
        else:
            die("DynamoDB still left items unprocessed after six tries; run make seed again")
    last, replica = customer_id(CUSTOMERS), other(FIRST)
    for _ in range(30):
        found = aws(replica, "dynamodb", "get-item", "--table-name", TABLE, "--key", json.dumps(profile_key(last))).get("Item")
        if found:
            say(f"  {last} reads back from the {replica} replica, so the table replicates")
            return
        time.sleep(2)
    die(f"{last} has not reached the {replica} replica after a minute")


def vended_health_checks(arn: str, tries: int = 18) -> dict:
    last = ""
    for _ in range(tries):
        data = aws(FIRST, "arc-region-switch", "list-route53-health-checks", "--arn", arn)
        try:
            return pick_health_checks(data.get("healthChecks", []))
        except LookupError as exc:
            last = str(exc)
            time.sleep(10)
        except ValueError as exc:
            die(str(exc))
    die(f"the plan did not vend every health check the records need: {last}")


def cmd_health_checks(args) -> None:
    ids = vended_health_checks(plan_arn_from_stack())
    if args.json:
        print(json.dumps(health_check_context(ids), sort_keys=True))
        return
    say(f"ARC vended {len(ids)} health checks: one per Region for each of {len(ARC_NAMES)} record names")
    for (name, region), hc_id in ids.items():
        print(f"  {name:<28} {region:<12} {hc_id}")


def evaluation(region: str, arn: str) -> dict:
    return aws(region, "arc-region-switch", "get-plan-evaluation-status", "--plan-arn", arn)


EVALUATION_POLLS, EVALUATION_POLL_SECONDS = 16, 15  # how long to wait for each endpoint's new evaluation


def refresh_evaluation(arn: str) -> list:
    """Make ARC evaluate the plan now, at both endpoints, and report it. Returns what is wrong, one line each.

    Clean (an empty list) means each endpoint reports evaluationState passed and no active warning.

    The plan exists before its records do, so its first evaluation warns that the records are
    missing, and ARC keeps serving that result until its next scheduled evaluation. A no-op
    update-plan (same content, same ARN) makes it evaluate again now."""
    before = {r: evaluation(r, arn).get("lastEvaluationTime") for r in REGIONS}
    plan = aws(FIRST, "arc-region-switch", "get-plan", "--arn", arn)["plan"]
    with json_file({k: plan[k] for k in UPDATE_KEYS if k in plan}) as path:
        aws(FIRST, "arc-region-switch", "update-plan", "--cli-input-json", f"file://{path}")
    problems = []
    for region in REGIONS:
        status: dict = {}
        for _ in range(EVALUATION_POLLS):
            time.sleep(EVALUATION_POLL_SECONDS)
            status = evaluation(region, arn)
            # A new time with the state still pendingEvaluation means the warnings below may be the old ones.
            if status.get("lastEvaluationTime") != before[region] and status.get("evaluationState") != "pendingEvaluation":
                break
        else:
            minutes = EVALUATION_POLLS * EVALUATION_POLL_SECONDS // 60
            say(f"  evaluation at the {region} endpoint has not refreshed yet ({status.get('evaluationState')})")
            problems.append(f"the {region} endpoint did not refresh its evaluation within {minutes} minutes;"
                            " run make verify again")
            continue
        state = status.get("evaluationState")
        active = [w for w in status.get("warnings") or [] if w.get("warningStatus") == "active"]
        say(f"  evaluation at the {region} endpoint: {state}, {len(active)} active warning(s)")
        for w in active:
            print(f"    {w.get('stepName') or '-'}: {w.get('warningMessage')}", file=sys.stderr)
        if active:
            problems.append(f"the {region} endpoint reports {len(active)} active warning(s), listed above; clear them")
        elif state != "passed":
            problems.append(f"the {region} endpoint evaluates the plan as {state}, not passed")
    return problems


def cmd_verify(_args) -> None:
    """Every record carries the right ARC health check, and the plan evaluates as passed without warnings."""
    arn = plan_arn_from_stack()
    zone = stack_outputs(FIRST, STACK["plan"])["HostedZoneId"]
    ids = vended_health_checks(arn, tries=1)
    records = aws(FIRST, "route53", "list-resource-record-sets", "--hosted-zone-id", zone)["ResourceRecordSets"]
    problems = binding_problems(records, ids)
    if problems:
        die("records do not carry the expected ARC health checks:\n  " + "\n  ".join(problems))
    say("every record that sends traffic to a Region carries that Region's ARC health check")
    say("refreshing plan evaluation (takes a minute or two)")
    problems = refresh_evaluation(arn)
    if problems:
        die("the plan evaluation is not clean:\n  " + "\n  ".join(problems))
    say(f"plan {arn} evaluates clean at both endpoints")


# ---- demo commands -------------------------------------------------------------------------


def observer_of(args) -> str:
    """The Region whose VPC status and call query from: --from, else the second Region."""
    return args.from_region or REGIONS[1]


def cmd_status(args) -> None:
    observer = observer_of(args)
    if not show(plan_arn(observer), observer, args.samples, args.interval, vpc_cidrs()):
        die("status: a check above differs from what ARC's health checks predict (DNS answers can lag by up to the TTL)")


def cmd_call(args) -> None:
    """Read, write and read one item of one customer through the region-less name."""
    observer = observer_of(args)
    arn = plan_arn(observer)
    health = health_states(arn, observer)
    say(f"ARC: {region_summary(health)}")
    note = {"note": f"from the {observer} VPC at {time.strftime('%H:%M:%S')}"}
    requests = [("POST", f"http://{REGION_LESS}/read", body(args.customer, "demo")),
                ("POST", f"http://{REGION_LESS}/write", body(args.customer, "demo", value=note)),
                ("POST", f"http://{REGION_LESS}/read", body(args.customer, "demo"))]
    ok, _ = send(observer, requests, expected_regions(health), vpc_cidrs())
    if not ok:
        die("call: a request above did not end at the app in the Region DNS sends it to")


def wait_for_execution(endpoint: str, arn: str, execution: str, t0: float, limit: int = 15 * 60) -> str:
    last = None
    while time.time() - t0 < limit:
        try:
            data = aws(endpoint, "arc-region-switch", "get-plan-execution", "--plan-arn", arn, "--execution-id", execution)
        except AwsError as exc:
            if not transient(exc):
                die(f"cannot read plan execution {execution}: {exc};"
                    " it was started and may still be running, see the ARC console")
            say(f"  read failed, retrying: {exc}")
            time.sleep(10)
            continue
        state = data.get("executionState")
        steps = ", ".join(f"{s.get('name')}={s.get('status')}" for s in data.get("stepStates", []))
        if (state, steps) != last:
            say(f"  +{time.time() - t0:3.0f}s plan execution {state}  {steps}")
            last = (state, steps)
        if state in DONE:
            return state
        if state in PAUSED:
            die(f"plan execution {execution} is {state}; it is left as it is (resume, skip or cancel it in the ARC console)")
        time.sleep(10)
    die(f"plan execution {execution} is still running after {limit // 60} minutes; it is left running")


def wait_for_dns(arn: str, observer: str, cidrs: dict, t0: float, limit: int = 5 * 60) -> bool:
    say(f"waiting for DNS inside the {observer} VPC to follow the new health check states"
        f" (answers are cached up to their TTL)")
    deadline = time.time() + limit
    while True:
        expected = expected_regions(health_states(arn, observer))
        results = run_probe(observer, 1, 0)["results"]
        pending = [n for n in ALL_NAMES if not matches(n, set(summarize(results.get(n, []), cidrs)["counts"]), expected[n])]
        if not pending:
            say(f"DNS follows the plan execution, {time.time() - t0:.0f}s after it started")
            return True
        if time.time() > deadline:
            say(f"DNS still differs for {', '.join(pending)} after {limit // 60} minutes")
            return False
        time.sleep(10)


def shift(target: str, action: str, observer: str | None, samples: int, interval: float) -> bool:
    """Run the plan's deactivate (drain) or activate (restore) workflow for target; True if all checks pass.

    A deactivate is started at the endpoint of the Region that stays and an activate at the target's, and
    every read is made at the endpoint of the observer, which is the Region that stays unless asked
    otherwise. So a drain never calls the Region it drains."""
    survivor = other(target)
    endpoint = survivor if action == "deactivate" else target
    arn = plan_arn(endpoint)
    cidrs = vpc_cidrs()
    observer = observer or survivor
    if action == "deactivate":
        health = health_states(arn, survivor)
        if any(health.get((name, survivor)) != "healthy" for name in ARC_NAMES):
            die(f"{survivor} is not fully active, so draining {target} would leave no healthy Region;"
                f" restore {survivor} first (no plan execution was started)")
    where = "a deactivate runs in the Region that stays" if action == "deactivate" else "an activate runs in its target Region"
    say(f"starting ARC Region switch plan {plan_name(arn)}: {action} workflow, target {target}, graceful mode")
    started = aws(endpoint, "arc-region-switch", "start-plan-execution", "--plan-arn", arn,
                  "--target-region", target, "--action", action, "--mode", "graceful",
                  "--comment", f"{PROJECT}: {action} {target}")
    t0 = time.time()
    execution = started["executionId"]
    say(f"  plan execution {execution} started at the {endpoint} endpoint ({where})")
    state = wait_for_execution(endpoint, arn, execution, t0)
    if state not in SUCCEEDED:
        die(f"plan execution {execution} ended {state}; see the plan's executions in the ARC console")
    marked = "unhealthy" if action == "deactivate" else "healthy"
    health = health_states(arn, observer)
    done = sum(health.get((name, target)) == marked for name in ARC_NAMES)
    say(f"plan execution {state}: ARC marked {target}'s health checks {marked} at {done} of {len(ARC_NAMES)} record names")
    dns_ok = wait_for_dns(arn, observer, cidrs, t0)
    return show(arn, observer, samples, interval, cidrs) and dns_ok and done == len(ARC_NAMES)


def cmd_shift(args, action: str) -> None:
    if not shift(args.region, action, args.from_region, args.samples, args.interval):
        word = "drain" if action == "deactivate" else "restore"
        die(f"{word} {args.region}: the plan execution completed, but a check above failed;"
            " run make status to see whether DNS has caught up")


def rehearse_item(observer: str, customer: str, cidrs: dict, failures: list, write: dict | None = None) -> dict:
    """Read (or write) one customer's 'rehearse' item through the region-less name; the app's answer.

    A request that does not end at the app in the expected Region is added to failures (and {} is
    returned) rather than ending the run, so a drained Region still gets restored."""
    arn = plan_arn(observer)
    expected = expected_regions(health_states(arn, observer))
    path, extra = ("write", {"value": write}) if write is not None else ("read", {})
    ok, traces = send(observer, [("POST", f"http://{REGION_LESS}/{path}", body(customer, "rehearse", **extra))], expected, cidrs)
    answer = final_answer(traces[0]) if traces else {}
    if not ok or "servedBy" not in answer:
        failures.append(f"{path} for {customer} from the {observer} VPC did not end at the app in the expected Region")
        return {}
    return answer


def rehearse_region(n: int, target: str, cidrs: dict, failures: list, args) -> None:
    """One rehearsal: drain target and restore it, with a customer whose home it is.

    From the moment the drain starts to the end of the restore, a Region may be drained, so a failure anywhere
    in that stretch (an error, a failed die(), Ctrl-C) restores target on the way out."""
    survivor, customer = other(target), customer_id(n)  # cust-001's home is REGIONS[0], cust-002's REGIONS[1]
    say(f"==== rehearsal {n} of {len(REGIONS)}: drain and restore {target}, with {customer} (home {target})")
    before = {"phase": f"before draining {target}", "at": time.strftime("%H:%M:%S")}
    wrote = rehearse_item(survivor, customer, cidrs, failures, before)
    if wrote and wrote["servedBy"] != target:
        failures.append(f"{customer}'s write before the drain was served in {wrote['servedBy']}, not {target}")
    finished = False
    try:
        if not shift(target, "deactivate", None, args.samples, args.interval):
            failures.append(f"checks after draining {target} differ (see above)")
        during = rehearse_item(survivor, customer, cidrs, failures)
        if during and (during["servedBy"], during.get("value")) != (survivor, before):
            failures.append(f"during the drain {customer} read {during.get('value')} in {during['servedBy']},"
                            f" expected {before} in {survivor}")
        moved = {"phase": f"while {target} was drained", "at": time.strftime("%H:%M:%S")}
        wrote = rehearse_item(survivor, customer, cidrs, failures, moved)
        if wrote and wrote["servedBy"] != survivor:
            failures.append(f"{customer}'s write during the drain was served in {wrote['servedBy']}, not {survivor}")
        if not shift(target, "activate", None, args.samples, args.interval):
            failures.append(f"checks after restoring {target} differ (see above)")
        finished = True
    finally:
        if not finished:
            restore_after_failure(target, args.samples, args.interval)
    after = rehearse_item(survivor, customer, cidrs, failures)
    if after and (after["servedBy"], after.get("value")) != (target, moved):
        failures.append(f"after the restore {customer} read {after.get('value')} in {after['servedBy']},"
                        f" expected {moved} in {target}")


def restore_after_failure(target: str, samples: int, interval: float) -> None:
    """A rehearsal stopped while target may be drained: if ARC does not show it active, run its activate workflow once.

    It runs while the error that stopped the rehearsal is on its way out, so it never raises. If the restore
    fails too (die() is a SystemExit), or Ctrl-C stops it, it says how to restore by hand."""
    survivor = other(target)
    known = False  # whether ARC could be read
    try:
        try:
            health = health_states(plan_arn(survivor), survivor)
            known = True
        except (Exception, SystemExit):
            health = {}  # cannot tell, so assume the worst and try the restore
        if known and all(health.get((name, target)) == "healthy" for name in ARC_NAMES):
            return  # ARC shows it active, so the failure came before the drain or after the restore
        say(f"rehearse stopped while {target} may be drained: running its activate workflow once")
        shift(target, "activate", None, samples, interval)
    except (Exception, SystemExit, KeyboardInterrupt):
        how = f"run make restore REGION={target}"
        print(f"error: {target} is still drained: {how}" if known else
              f"error: {target} may still be drained (ARC could not be read to check): run make status, then {how} if it is",
              file=sys.stderr, flush=True)


def cmd_rehearse(args) -> None:
    """Drain and restore each Region in turn; assert DNS, where requests land, and the data each Region sees.

    For each Region: write an item for a customer whose home it is, drain the Region, read the item
    in the other Region (it has replicated) and write it there, restore the Region, and read the
    item back in it. If anything stops the run while the Region is drained, it is restored on the way
    out, once; if that fails too, the last line says how to do it by hand."""
    cidrs = vpc_cidrs()
    failures: list = []
    for n, target in enumerate(REGIONS, start=1):
        rehearse_region(n, target, cidrs, failures, args)
    if failures:
        die("rehearsal found problems:\n  " + "\n  ".join(failures))
    say("rehearsal passed: each Region drained and restored, every request served where DNS sent it, data intact")


def cmd_names(args) -> None:
    names = {"regionLess": REGION_LESS, "regional": REGIONAL, "app": APP_NAME}
    print(json.dumps(names, sort_keys=True) if args.json else "\n".join(ALL_NAMES))


def customer_arg(value: str) -> str:
    if not re.fullmatch(r"[a-z0-9-]{1,40}", value):
        raise argparse.ArgumentTypeError(f"{value!r} is not a customer ID such as {customer_id(1)}")
    return value


def acting_region(args) -> str:
    """The Region a command acts in, which is where its account check runs and its first call goes.

    drain acts in the Region that stays and restore in the Region it restores (an activate runs there), so
    neither needs the other. status and call act in the Region they query from. The deploy-time commands and
    rehearse, which needs both Regions up, start at the first."""
    if args.command == "drain":
        return other(args.region)
    if args.command == "restore":
        return args.region
    if args.command in ("status", "call"):
        return observer_of(args)
    return FIRST


def main(argv: list | None = None) -> None:
    if SETTINGS_ERROR:
        die(SETTINGS_ERROR)
    observe = argparse.ArgumentParser(add_help=False)
    observe.add_argument("--from", dest="from_region", choices=REGIONS,
                         help="VPC to query from (status: the second Region; drain/restore: the other Region)")
    observe.add_argument("--samples", type=int, default=20, help="DNS queries per name (default 20)")
    observe.add_argument("--interval", type=float, default=0.5, help="seconds between queries (default 0.5)")

    parser = argparse.ArgumentParser(description="Operate the regional-affinity sample")
    parser.add_argument("--account", default=os.environ.get("ACCOUNT") or None,
                        help="refuse to run against any other AWS account (or set ACCOUNT)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("seed", help="write every customer's profile item and check that the table replicates")
    p = sub.add_parser("health-checks", help="wait for the six ARC health checks and print their IDs")
    p.add_argument("--json", action="store_true", help="print {record name: {Region: ID}} for the records stack")
    sub.add_parser("verify", help="check the record bindings and refresh the plan evaluation")
    sub.add_parser("status", parents=[observe], help="ARC health checks, DNS answers and sample requests")
    p = sub.add_parser("call", help="read, write and read one customer's item via the region-less name")
    p.add_argument("customer", metavar="CUSTOMER_ID", type=customer_arg,
                   help=f"a sample customer, {customer_id(1)} to {customer_id(CUSTOMERS)} (odd: home {REGIONS[0]})")
    p.add_argument("--from", dest="from_region", choices=REGIONS,
                   help="VPC to send the requests from (default: the second Region)")
    for name, text in (("drain", "drain a Region: run the ARC Region switch plan's deactivate workflow"),
                       ("restore", "restore a Region: run the ARC Region switch plan's activate workflow")):
        p = sub.add_parser(name, parents=[observe], help=text)
        p.add_argument("region", choices=REGIONS)
    sub.add_parser("rehearse", parents=[observe], help="drain and restore each Region in turn and assert the outcome")
    p = sub.add_parser("names", help="print the record names")
    p.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    samples, interval = getattr(args, "samples", 1), getattr(args, "interval", 0.0)
    if not 1 <= samples <= 100 or interval < 0 or (samples - 1) * interval > 45:
        parser.error("keep --samples between 1 and 100 and (samples - 1) x interval within 45 seconds")
    if args.command == "names":
        cmd_names(args)
        return
    commands = {
        "seed": cmd_seed,
        "health-checks": cmd_health_checks,
        "verify": cmd_verify,
        "status": cmd_status,
        "call": cmd_call,
        "drain": lambda a: cmd_shift(a, "deactivate"),
        "restore": lambda a: cmd_shift(a, "activate"),
        "rehearse": cmd_rehearse,
    }
    try:
        check_account(args.account, acting_region(args))
        commands[args.command](args)
    except AwsError as exc:
        die(str(exc))


if __name__ == "__main__":
    main()
