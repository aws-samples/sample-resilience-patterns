"""The eks-mr-demo Locust workload (step 4c).

Replaces the generic single-target locustfile via the LoadGenerator construct's
``workloadDirectory`` overlay. Two differences from the stock file, both load-bearing:

1. METRIC NAMES. It emits through ``emf_helper.emit_request`` — ``ClientSuccess`` /
   ``ClientError`` / ``ClientLatency`` plus Region-dimensioned ``RegionSuccess`` /
   ``RegionError`` / ``RegionLatency``. The stock file emits ``Success`` / ``Error``,
   names NOTHING in this demo reads: the availability alarm would sit in
   INSUFFICIENT_DATA forever while every deploy stayed green.

   A third, Op-dimensioned family — ``OpSuccess`` / ``OpError`` / ``OpLatency`` with
   ``Op`` ∈ {``read``, ``write``} — separates the two paths in CloudWatch. NEW NAMES,
   deliberately: adding a dimension to the Client* line would change the metric
   identity the availability alarm reads, silently breaking it while everything
   deploys green. The write series is the one worth watching after a failover: a
   recovery where ``OpError{Op=write}`` stays pinned high while reads succeed is the
   runbook §6 "verify writes recover, not just reads" check, readable from CloudWatch.

2. TWO ENDPOINTS, region-attributed. GET /orders exercises the regional read path;
   POST /orders exercises the global write path — writes are the thing the failover
   moves. The app echoes which region served it (``region`` on reads,
   ``written_from_region`` on writes), so attribution comes from the RESPONSE, never
   from guessing. A request that fails without a body is attributed to ``unknown`` —
   honest, and it keeps the per-region graphs clean for the requests that DO answer.

The client resolves ``TARGET_URL`` (the Route 53 latency record) per connection, so
after the ARC plan flips the records these same users land in the other region — that
is the demo's recovery beat, visible as the Region dimension flipping while
ClientSuccess climbs back.

DO NOT add a /health task here. The availability signal must ride the same paths a
user rides; the app's /health deliberately makes no database call.
"""
import os
import time

from az_metrics import (
    AZ_DIMENSION,
    AZ_ERROR,
    AZ_FIELDS,
    AZ_LATENCY,
    AZ_SLO_SUCCESS,
    AZ_SUCCESS,
    slo_success,
)
from emf_helper import DEMO_METRIC_NAMESPACE, emit_emf, emit_request
from locust import HttpUser, between, task

REQUEST_TIMEOUT = float(os.environ.get("REQUEST_TIMEOUT", "5"))
MIN_WAIT = float(os.environ.get("MIN_WAIT", "0.5"))
MAX_WAIT = float(os.environ.get("MAX_WAIT", "1.0"))

#: Response fields naming the region that served the request, in the order the app's
#: routes use them: GET /orders echoes ``region``; POST /orders echoes
#: ``written_from_region``.
REGION_FIELDS = ("region", "written_from_region")


def region_of(resp) -> str:
    """The serving region, from the response body, else ``unknown``.

    Never raises: attribution must not turn a scored request into an exception.
    """
    try:
        body = resp.json()
        for field in REGION_FIELDS:
            value = body.get(field)
            if value:
                return str(value)
    except Exception:  # noqa: BLE001 — non-JSON error bodies are expected under injection
        pass
    return "unknown"


def az_of(resp) -> str:
    """The serving availability zone, from the response body, else ``unknown``.

    Never raises, for the same reason ``region_of`` does not: attribution must not turn a
    scored request into an exception.

    ONE SPELLING PER FIELD. ``AZ_FIELDS`` mirrors ``REGION_FIELDS`` exactly and comes from
    ``az_metrics``, the same module the metric names come from. It is tempting to list extra
    candidate spellings here "to be safe" — this function tolerates a miss by returning
    ``unknown``, so a wrong field name never crashes anything, it just draws an ``unknown``
    line forever. Tolerating a mismatch is how the mismatch survives. If the app and this
    file disagree, that is a bug to fix in one of them, not to absorb here.
    """
    try:
        body = resp.json()
        for field in AZ_FIELDS:
            value = body.get(field)
            if value:
                return str(value)
    except Exception:  # noqa: BLE001 — non-JSON error bodies are expected under injection
        pass
    return "unknown"


def emit_az(az: str, success: bool, latency_ms: float) -> None:
    """Emit the Az-dimensioned line for one request, via the SAME helper primitive.

    Modelled on ``emit_op``: every call, dimensioned, routed through ``emf_helper.emit_emf``
    so the EMF envelope shape keeps one owner. Lives here, not in ``emf_helper``, for the
    same reason ``emit_op`` does — that file is vendored byte-identical from the
    observability construct and a drift test pins the copies.

    CARRIES NO ``Client*`` METRIC, AND NEVER TOUCHES THE ``is_first`` BRANCH. The client
    aggregate is emitted on exactly one line per logical request and the availability alarm
    reads it; adding a second client-level line would double-count it. This function cannot
    do that, because it emits no client metric at all — the footgun is honoured by not
    touching the risky path rather than by carefully touching it.

    Metric NAMES are imported, not typed: nothing type-checks a CloudWatch metric string, and
    a case flip here would deploy green and draw nothing (D1/D7).
    """
    emit_emf(
        namespace=DEMO_METRIC_NAMESPACE,
        dimension_keys=[AZ_DIMENSION],
        values={
            AZ_DIMENSION: az,
            AZ_LATENCY: latency_ms,
            AZ_SUCCESS: 1 if success else 0,
            AZ_ERROR: 0 if success else 1,
            # Non-error AND within the bar (2026-09-03). Classified by the imported helper
            # rather than inline, so the boundary case is reachable by a real test.
            AZ_SLO_SUCCESS: slo_success(success, latency_ms),
        },
        units={
            AZ_LATENCY: "Milliseconds",
            AZ_SUCCESS: "Count",
            AZ_ERROR: "Count",
            AZ_SLO_SUCCESS: "Count",
        },
    )


def emit_op(op: str, success: bool, latency_ms: float) -> None:
    """Emit the Op-dimensioned line for one request, via the SAME helper primitive.

    Routed through ``emf_helper.emit_emf`` rather than hand-rolled JSON so the EMF
    envelope shape has one owner. Lives here, not in emf_helper: that file is vendored
    byte-identical from the observability construct and a drift test pins the copies.
    """
    emit_emf(
        namespace=DEMO_METRIC_NAMESPACE,
        dimension_keys=["Op"],
        values={
            "Op": op,
            "OpLatency": latency_ms,
            "OpSuccess": 1 if success else 0,
            "OpError": 0 if success else 1,
        },
        units={
            "OpLatency": "Milliseconds",
            "OpSuccess": "Count",
            "OpError": "Count",
        },
    )


class OrdersUser(HttpUser):
    """One synthetic user issuing reads and writes against the orders API."""

    wait_time = between(MIN_WAIT, MAX_WAIT)

    def _scored_request(self, method: str, expect_status: int, op: str, **kwargs) -> None:
        """Issue one request and emit EXACTLY ONE client-level metric line for it.

        Every path — good status, bad status, timeout, connection error — lands on one
        ``emit_request`` call. Locust's own failure bookkeeping is kept in sync via
        catch_response, but the METRICS the alarm reads come from here.
        """
        start = time.monotonic()
        try:
            with self.client.request(
                method,
                "/orders",
                timeout=REQUEST_TIMEOUT,
                catch_response=True,
                **kwargs,
            ) as resp:
                latency_ms = (time.monotonic() - start) * 1000
                ok = resp.status_code == expect_status
                emit_request(region=region_of(resp), success=ok, latency_ms=latency_ms)
                emit_op(op=op, success=ok, latency_ms=latency_ms)
                emit_az(az=az_of(resp), success=ok, latency_ms=latency_ms)
                if ok:
                    resp.success()
                else:
                    resp.failure(f"status {resp.status_code}")
        except Exception:  # noqa: BLE001 — timeouts/DNS/conn-reset under injection
            latency_ms = (time.monotonic() - start) * 1000
            emit_request(region="unknown", success=False, latency_ms=latency_ms)
            # The exception path MUST emit the Op line too — a timed-out write is
            # precisely the event the write series exists to count.
            emit_op(op=op, success=False, latency_ms=latency_ms)
            # No response object on this path, so no AZ to attribute to. Emitted anyway with
            # "unknown" so the Az series counts the same total as the Op series — a silently
            # shorter series would read as "that AZ was fine" rather than "we could not tell".
            emit_az(az="unknown", success=False, latency_ms=latency_ms)

    @task(3)
    def read_orders(self) -> None:
        """Regional read path: served by the lowest-latency healthy region's READER."""
        self._scored_request("GET", 200, op="read")

    @task(1)
    def write_order(self) -> None:
        """Global write path: every region's pods write to the ONE global writer.

        This is the request class the failover exists for — after the Aurora switchover
        the ``written_from_region`` attribution shows writes landing in the new region.
        """
        self._scored_request(
            "POST",
            201,
            op="write",
            json={"status": "PENDING", "payload": {"source": "loadgen"}},
        )
