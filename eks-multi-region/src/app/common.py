"""Shared credential and connection helpers for the demo app.

Ported from aws-samples/sample-resilience-patterns@9091f42 (MIT-0),
`aurora/lambda/aurora-app/index.py`, with the Lambda handler replaced by a long-lived
process. The SQL contract (stored procedures, column names) is unchanged.

Two things here are deliberate and load-bearing for the demo, not incidental style.

1. EVERY network client has an EXPLICIT timeout, set at MODULE scope.

   botocore's defaults are 60s connect / 60s read with retries on top, which is far
   longer than any request budget this app has. The demo injects a NETWORK fault at the
   node, so the failure mode under test is precisely "the packet is slow or lost" — and
   with default timeouts a hanging call outlives the caller's own budget, so the
   `except` branch never runs. The failure then presents as a hang rather than an error,
   which is both harder to read on a dashboard and a different failure than the one we
   claim to be demonstrating.

2. `statement_timeout` is set on every connection.

   pg8000 has no query-level timeout parameter: its `timeout` argument covers the TCP
   connect only. Without a server-side statement timeout, a query that has already
   established its connection can block indefinitely. Setting it in-session bounds the
   query with the same budget as the connect.

3. The WRITE path is pooled; the READ path is not.

   A PostgreSQL connection to Aurora costs a TCP handshake, a TLS handshake and
   server-side session setup. Measured against the writer that is 40-60ms — most of a
   request whose actual work is one INSERT — and paying it per request put write latency
   an order of magnitude above read latency for no reason. Reads go to the LOCAL reader
   where the same handshake is single-digit milliseconds, so pooling them would add
   bookkeeping for no measurable gain. The asymmetry is intentional.

Both budgets are read from the environment so the injection band can be calibrated
against real numbers in step 6 without rebuilding the image.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import queue
import threading
import time
import urllib.request

import boto3
import pg8000.dbapi
from botocore.config import Config

LOG = logging.getLogger("app")

# ---- configuration ---------------------------------------------------------------

#: Region this pod runs in. Set explicitly in the Deployment manifest — a pod does NOT
#: inherit AWS_REGION from anywhere, and boto3 with no region raises NoRegionError.
REGION = os.environ["AWS_REGION"]

#: The availability zone of the NODE this pod is scheduled on, or ``""`` if unknown.
#:
#: WHY IMDS AND NOT AN ENV VAR. ``AWS_REGION`` above is baked into k8s/app.yaml by
#: render-manifest.py at render time, because the region is a property of the manifest's
#: TARGET CLUSTER and is therefore knowable then. An AZ is not: it is a property of
#: whichever node the scheduler happens to pick, unknown at render time and liable to change
#: on any rollout. Nor is it available as a downward-API ``fieldRef`` — the pod spec does not
#: carry its node's topology label. So the pod must ask the instance metadata service.
#: Do NOT "simplify" this into an env var: it would look correct and be wrong the first time
#: a pod moved.
#:
#: RESOLVED ONCE, AT IMPORT. A pod never migrates between nodes during its lifetime, so this
#: is immutable for the life of the process and one IMDS round trip is the whole cost.
#:
#: NEVER RAISES, AND NEVER BLOCKS FOR LONG. The build environment has no metadata service:
#: the Dockerfile smoke test runs ``python -c "import server, schema"``, and a blocking or
#: raising read at import scope would hang or break every container start (docs/lessons.md bug
#: class 14 — a green image build does not prove a startable image). An unknown AZ degrades
#: attribution to ``"unknown"``; it must not degrade availability.
#:
#: IMDSv2 (token-first) because the nodes require it. The hop limit is 2 on BOTH node types —
#: set on the managed node group's launch template and at karpenter-nodepool.yaml:65 — so a
#: non-host-network pod can reach IMDS at all. Without hop limit 2 this returns "" silently.
#: Bounded hard. Two sequential round trips against a link-local address that either answers
#: in single-digit milliseconds or is not there at all; there is no slow-but-working case to
#: wait for. Sized so the worst case (both calls time out) stays far inside any container
#: start budget.
_IMDS_TIMEOUT_SECONDS = 1.0


def _read_node_az() -> str:
    """The node's AZ name (e.g. ``us-east-2a``) from IMDSv2, or ``""`` on any failure."""
    try:
        token_req = urllib.request.Request(
            "http://169.254.169.254/latest/api/token",
            method="PUT",
            headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"},
        )
        with urllib.request.urlopen(token_req, timeout=_IMDS_TIMEOUT_SECONDS) as resp:
            token = resp.read().decode()
        az_req = urllib.request.Request(
            "http://169.254.169.254/latest/meta-data/placement/availability-zone",
            headers={"X-aws-ec2-metadata-token": token},
        )
        with urllib.request.urlopen(az_req, timeout=_IMDS_TIMEOUT_SECONDS) as resp:
            return resp.read().decode().strip()
    except Exception:  # noqa: BLE001 — see the contract above: this MUST NOT raise.
        return ""


NODE_AZ = _read_node_az()

#: Secret looked up by NAME, not ARN, and read from THIS region.
#:
#: The credentials secret is created once by the primary Aurora member and REPLICATED to
#: the secondary region. A replica keeps the same name but has a different ARN (the
#: region differs), so a name lookup lets one image, one manifest and one IAM statement
#: shape work in both regions. It also keeps the standby region's credential read LOCAL:
#: reading the primary region's secret cross-region would make the failover target
#: depend on the region it is failing away from, which is exactly backwards for a pod
#: that starts up during that region's impairment.
SECRET_NAME = os.environ["DB_SECRET_NAME"]

#: Local, in-region reader endpoint. Reads never leave the region.
#:
#: EVENTUALLY CONSISTENT as of 2026-09-04. Each regional member now runs a writer plus
#: two readers (one per remaining AZ) so a single-AZ blackhole cannot take the database,
#: which means `cluster-ro-*` round-robins across REPLICAS rather than resolving to the
#: writer as it did with the single-instance cluster. In-region replica lag is normally
#: single-digit milliseconds, but a just-written order is no longer guaranteed to appear
#: in the next GET /orders. Nothing here asserts read-after-write, and the load generator
#: scores status codes rather than contents -- but a demo beat that writes and then points
#: at the list must not be narrated as a consistency guarantee.
READ_HOST = os.environ["DB_READ_HOST"]

#: Aurora Global Database WRITER endpoint — NOT a regional cluster endpoint.
#:
#: This is a Route 53 name that Aurora repoints at the current primary cluster on
#: switchover or failover, so both regions' pods can carry the identical value and
#: writes follow the primary automatically. A per-region writer endpoint would instead
#: pin writes to whichever region was primary at deploy time and keep accepting them
#: after a switchover — succeeding against a demoted cluster, with no error anywhere.
WRITE_HOST = os.environ["DB_WRITE_HOST"]

#: Seconds. Bounds BOTH the TCP connect and the server-side statement timeout.
DB_TIMEOUT_SECONDS = int(os.environ.get("DB_TIMEOUT_SECONDS", "4"))

_BOTO_CONFIG = Config(
    connect_timeout=3,
    read_timeout=5,
    retries={"max_attempts": 3, "mode": "standard"},
)

_SECRETS = boto3.client("secretsmanager", region_name=REGION, config=_BOTO_CONFIG)

# ---- credential cache ------------------------------------------------------------

_secret_lock = threading.Lock()
_secret_cache: dict | None = None


def get_credentials() -> dict:
    """Fetch and cache the database credentials.

    Cached for the pod's lifetime. These credentials are not rotated in the demo, and
    an uncached read would put a Secrets Manager call — over a VPC endpoint — on the
    critical path of every request, which would show up as application latency the
    moment the injected network fault touches that endpoint. A pod that cannot read the
    secret at all fails its requests; that is intentional and visible.
    """
    global _secret_cache
    if _secret_cache is None:
        with _secret_lock:
            if _secret_cache is None:  # re-check: another thread may have won
                LOG.info("fetching db credentials secret %s in %s", SECRET_NAME, REGION)
                raw = _SECRETS.get_secret_value(SecretId=SECRET_NAME)["SecretString"]
                _secret_cache = json.loads(raw)
    return _secret_cache


# ---- connections -----------------------------------------------------------------


def _connect(host: str):
    secret = get_credentials()
    conn = pg8000.dbapi.connect(
        host=host,
        port=int(secret["port"]),
        user=secret["username"],
        password=secret["password"],
        database=secret["dbname"],
        # TLS to the database. The source app does this too; keep it.
        ssl_context=True,
        # TCP connect budget only — see the module docstring.
        timeout=DB_TIMEOUT_SECONDS,
    )
    conn.autocommit = True
    cur = conn.cursor()
    try:
        # Server-side query budget. pg8000 cannot express this as a connect argument.
        cur.execute(f"SET statement_timeout = {DB_TIMEOUT_SECONDS * 1000}")
    finally:
        cur.close()
    return conn


def read_connection():
    """Connection to the LOCAL regional reader endpoint."""
    return _connect(READ_HOST)


#: Pooled writer connections.
#:
#: Sized small on purpose: the write path is one INSERT or UPDATE, the traffic mix is
#: read-heavy, and a handful of connections covers the write concurrency a
#: ThreadingHTTPServer actually reaches at demo load. Overridable so the pool can be
#: widened for a heavier run without rebuilding the image.
_WRITE_POOL_SIZE = int(os.environ.get("DB_WRITE_POOL_SIZE", "4"))

#: A pooled connection older than this is closed and replaced at checkout, so no writer
#: connection outlives a failover indefinitely even if it happens to keep working.
DB_CONN_MAX_LIFETIME_SECONDS = int(os.environ.get("DB_CONN_MAX_LIFETIME_SECONDS", "300"))

#: A pooled connection that has sat idle longer than this is PINGED (SELECT 1) before it
#: is handed out. Idle connections are the ones that die silently: after the Aurora writer
#: moves to the other region, every socket in the pool still points at a host that is now
#: a reader (or gone), and the first write on each would fail. Pinging every checkout
#: would add a round trip to every write; pinging only after idle catches the failover
#: case at the cost of one extra round trip per connection per quiet period.
DB_CONN_VALIDATE_AFTER_IDLE_SECONDS = float(os.environ.get("DB_CONN_VALIDATE_AFTER_IDLE_SECONDS", "5"))

#: LIFO rather than FIFO so the pool hands back a recently-used connection and the
#: least-recently-used ones sit at the bottom instead of every connection being cycled.
#: Each entry is a _PooledConn wrapper, never a bare connection, so the pool always knows
#: how old and how idle the connection is.
_write_pool: queue.LifoQueue = queue.LifoQueue(maxsize=_WRITE_POOL_SIZE)


class _PooledConn:
    """A writer connection plus the two timestamps the pool's health rules read."""

    __slots__ = ("conn", "created_at", "last_used_at")

    def __init__(self, conn) -> None:
        self.conn = conn
        now = time.monotonic()
        self.created_at = now
        self.last_used_at = now


def _close_quietly(conn) -> None:
    try:
        conn.close()
    except Exception:  # noqa: BLE001 - a dead socket may raise on close; nothing to do
        pass


def _is_alive(conn) -> bool:
    """One round trip. False means the connection must be discarded, not returned."""
    try:
        cur = conn.cursor()
        try:
            cur.execute("SELECT 1")
            cur.fetchone()
        finally:
            cur.close()
        return True
    except Exception:  # noqa: BLE001 - any driver error here means "not usable"
        return False


def _checkout() -> _PooledConn:
    """Take a HEALTHY connection from the pool, opening a fresh one if none qualifies.

    Three rules, applied in order to each pooled entry:
      1. max lifetime  -- older than DB_CONN_MAX_LIFETIME_SECONDS: close, try the next.
      2. validate after idle -- idle longer than DB_CONN_VALIDATE_AFTER_IDLE_SECONDS and
         failing SELECT 1: close, try the next.
      3. otherwise hand it out.
    The pool can hold at most _WRITE_POOL_SIZE entries, so this loop is bounded.
    """
    now = time.monotonic()
    while True:
        try:
            entry = _write_pool.get_nowait()
        except queue.Empty:
            return _PooledConn(_connect(WRITE_HOST))
        if now - entry.created_at > DB_CONN_MAX_LIFETIME_SECONDS:
            _close_quietly(entry.conn)
            continue
        if now - entry.last_used_at > DB_CONN_VALIDATE_AFTER_IDLE_SECONDS and not _is_alive(entry.conn):
            _close_quietly(entry.conn)
            continue
        return entry


@contextlib.contextmanager
def write_connection():
    """Pooled connection to the GLOBAL writer endpoint (follows the primary region).

    See item 3 of the module docstring for why the write path is pooled and the read path
    is not. Used as a context manager:

        with write_connection() as conn:
            ...

    Pool hygiene, because a pool that returns dead connections is worse than no pool:

    * A connection is only RETURNED to the pool if the body completed without raising.
      If the body raised, the connection is closed and dropped -- the failure it just
      produced is the best available evidence that the socket is bad (after a writer
      failover, every pooled socket is), and putting it back would hand the same dead
      connection to the next request, forever.
    * At checkout, a connection past its max lifetime is retired, and one that has been
      idle is pinged first (see the two constants above).

    Together these mean a writer failover costs one failed write per pooled connection
    (at most _WRITE_POOL_SIZE), after which every subsequent write gets a fresh socket to
    the new writer -- with no restart and no external intervention. The pool starts empty
    and fills on demand, so a pod that never writes never opens a writer connection.
    """
    entry = _checkout()
    ok = False
    try:
        yield entry.conn
        ok = True
    finally:
        if not ok:
            _close_quietly(entry.conn)
        else:
            entry.last_used_at = time.monotonic()
            try:
                _write_pool.put_nowait(entry)
            except queue.Full:
                # More connections in flight than the pool can hold: close the surplus
                # rather than growing without bound.
                _close_quietly(entry.conn)
