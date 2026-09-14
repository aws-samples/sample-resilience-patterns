"""The demo application, as a long-lived HTTP server on EKS.

Ported from aws-samples/sample-resilience-patterns@9091f42 (MIT-0),
`aurora/lambda/aurora-app/index.py`. The routes and the SQL are the same; the API
Gateway event shape is replaced by a real request, and the Lambda handler by a threaded
stdlib server. No web framework: the stdlib server is enough for this traffic profile
and keeps the image to two pure-Python dependencies.

WHY THIS EXISTS AT ALL. The demo is a multi-region EKS demo whose premise is that
degrading EKS nodes degrades what clients see. The source application is a Lambda behind
a load balancer and never touches EKS, so injecting a node fault would have moved no
client-visible signal at all: availability flat at 100%, decision alarm silent, and
nothing for an operator to react to. This process is what puts the traffic path through
the cluster.

READ / WRITE SPLIT — the reason the demo has a story.

  GET  → local regional READER endpoint. Reads stay in-region.
  POST/PUT/DELETE → the Aurora Global Database WRITER endpoint, which Aurora repoints at
  the current primary on switchover.

Keeping them separate is what lets the failover show reads staying healthy locally while
writes are the thing that moves regions.

HEALTH PROBE — deliberately does NOT touch the database.

This looks like an oversight and is the opposite. The injected fault is a gray one:
partial packet loss and latency at the node, with the region still up. If the readiness
probe depended on the database, degraded pods would fail their probes, be pulled from
the Service endpoints, and the load balancer would return hard connection failures. That
converts the gray failure the demo is built to show into an outright outage with a
different signature. With a dependency-free probe, degradation surfaces the way it
should: slow and partially failing responses from pods that are still in rotation.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from common import NODE_AZ, READ_HOST, REGION, WRITE_HOST, read_connection, write_connection
from error_rate import should_fail

logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
LOG = logging.getLogger("app")

PORT = int(os.environ.get("PORT", "8080"))


def _rows(cur) -> list[dict]:
    cols = [d[0] for d in cur.description]
    return [
        {k: (str(v) if v is not None else None) for k, v in zip(cols, row)}
        for row in cur.fetchall()
    ]


class Handler(BaseHTTPRequestHandler):
    # Identify the app rather than leaking the Python version in Server:.
    server_version = "eks-mr-demo"
    sys_version = ""

    # ---- plumbing ----------------------------------------------------------------

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - stdlib signature
        # Default goes to stderr with its own format; route through logging so pod
        # logs are one consistent stream.
        LOG.info("%s - %s", self.address_string(), fmt % args)

    def _respond(self, status: int, body: dict) -> None:
        payload = json.dumps(body, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return {}

    # ---- routes ------------------------------------------------------------------

    def _injected(self) -> bool:
        """True when the L1 error-rate knob says to fail THIS request.

        THE KNOB IS INERT UNTIL SOMETHING READS IT. Creating the SSM parameter changes
        nothing on its own — this method is what turns an operator raising the knob into
        client-visible degradation, which is the whole point of the L1 injection.

        Deliberately NOT called from /health or /ready. Those make no database call by
        design (see the module docstring), and failing them would pull every pod out of
        the load balancer's target group — a hard outage where the demo needs a GRAY
        one: the region stays up, health checks stay green, and only the users notice.

        Reads through error_rate.py's 5s TTL cache, so expect roughly 5 seconds between
        turning the knob and seeing the full effect.
        """
        if not should_fail():
            return False
        # 503 rather than 500: this is deliberate, load-shedding-shaped failure, and the
        # load generator scores any non-expected status as an error either way. region is
        # echoed for the same reason the real 500s echo it — the workload attributes the
        # error to the degraded region instead of "unknown".
        self._respond(503, {"error": "injected failure", "region": REGION, "az": NODE_AZ})
        return True

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        parsed = urlparse(self.path)
        if parsed.path in ("/health", "/ready"):
            # No database call, and NO injection. See the module docstring — this is the
            # gray-failure fidelity decision, not a shortcut.
            self._respond(200, {"status": "ok", "region": REGION, "az": NODE_AZ})
            return
        if parsed.path == "/orders":
            if self._injected():
                return
            self._query_orders(parse_qs(parsed.query))
            return
        self._respond(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/orders":
            self._respond(404, {"error": "not found"})
            return
        if self._injected():
            return
        self._insert_order(self._body())

    def do_PUT(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if not path.startswith("/orders/") or not path.endswith("/status"):
            self._respond(404, {"error": "not found"})
            return
        if self._injected():
            return
        self._update_status(path.split("/")[2], self._body())

    def do_DELETE(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if not path.startswith("/orders/"):
            self._respond(404, {"error": "not found"})
            return
        if self._injected():
            return
        self._delete_order(path.split("/")[2])

    # ---- handlers ----------------------------------------------------------------

    def _query_orders(self, params: dict) -> None:
        def first(key: str):
            values = params.get(key)
            return values[0] if values else None

        try:
            conn = read_connection()
            try:
                cur = conn.cursor()
                try:
                    cur.execute(
                        "SELECT * FROM sp_query_orders(%s, %s, %s)",
                        (first("region"), first("status"), first("since")),
                    )
                    orders = _rows(cur)
                finally:
                    cur.close()
            finally:
                conn.close()
        except Exception as exc:  # noqa: BLE001 - surface as a 500, keep serving
            LOG.error("read failed: %s", exc)
            # region is echoed on FAILURES too: the load generator attributes errors to
            # the serving region, and a 500 without it lands in "unknown" - thinning the
            # degraded region's error series at exactly the moment it carries the story.
            self._respond(500, {"error": str(exc), "read_host": READ_HOST, "region": REGION, "az": NODE_AZ})
            return
        # read_host is echoed so a client can tell WHICH endpoint served it. After a
        # switchover this is what makes "reads stayed local" checkable rather than
        # asserted.
        self._respond(200, {"orders": orders, "read_host": READ_HOST, "region": REGION, "az": NODE_AZ})

    def _insert_order(self, body: dict) -> None:
        try:
            with write_connection() as conn:
                cur = conn.cursor()
                try:
                    cur.execute(
                        "SELECT sp_insert_order(%s, %s, %s) AS id",
                        (
                            body.get("region", REGION),
                            body.get("status", "PENDING"),
                            json.dumps(body.get("payload", {})),
                        ),
                    )
                    order_id = _rows(cur)[0]["id"]
                finally:
                    cur.close()
        except Exception as exc:  # noqa: BLE001
            LOG.error("write failed: %s", exc)
            self._respond(500, {"error": str(exc), "write_host": WRITE_HOST, "region": REGION, "az": NODE_AZ})
            return
        # write_host is echoed for the same reason, and it matters more here: a write
        # that silently lands in a demoted region is the failure this demo exists to
        # make visible, and it is invisible unless the response says where it went.
        self._respond(
            201,
            {"id": order_id, "write_host": WRITE_HOST, "written_from_region": REGION,
             "written_from_az": NODE_AZ},
        )

    def _update_status(self, order_id: str, body: dict) -> None:
        self._write_statement(
            "SELECT sp_update_order_status(%s, %s)",
            (order_id, body.get("status")),
            {"updated": order_id},
        )

    def _delete_order(self, order_id: str) -> None:
        self._write_statement(
            "SELECT sp_delete_order(%s)", (order_id,), {"deleted": order_id}
        )

    def _write_statement(self, sql: str, args: tuple, ok_body: dict) -> None:
        try:
            with write_connection() as conn:
                cur = conn.cursor()
                try:
                    cur.execute(sql, args)
                finally:
                    cur.close()
        except Exception as exc:  # noqa: BLE001
            LOG.error("write failed: %s", exc)
            self._respond(500, {"error": str(exc), "write_host": WRITE_HOST, "region": REGION, "az": NODE_AZ})
            return
        self._respond(200, {**ok_body, "write_host": WRITE_HOST, "region": REGION, "az": NODE_AZ})


def main() -> None:
    LOG.info(
        "starting on :%s region=%s read_host=%s write_host=%s",
        PORT,
        REGION,
        READ_HOST,
        WRITE_HOST,
    )
    # ThreadingHTTPServer, not HTTPServer: a single-threaded server would serialise
    # every client behind the slowest database call — which under the injected latency
    # fault would look like a total outage rather than degradation.
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
