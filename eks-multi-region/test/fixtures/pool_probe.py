"""Probe: the write pool must SELF-HEAL after a writer failover.

Driven by test/topology.test.ts as a subprocess (cwd = src/app, smoke env). Installs a
fake pg8000 whose connections can be killed en masse -- the exact shape of an Aurora
writer moving to the other region while the pods keep running -- then asserts the four
pool rules. Prints one JSON object; the Jest side asserts on it. Exit 0 always: the
assertions live in the JSON so a failing rule reports WHICH rule, not just "nonzero".

Run directly for a human-readable result:
    cd src/app && AWS_REGION=smoke DB_SECRET_NAME=smoke DB_READ_HOST=smoke \
      DB_WRITE_HOST=smoke ERROR_RATE_PARAM=smoke python3 ../../test/fixtures/pool_probe.py
"""
from __future__ import annotations

import json
import os
import sys
import types

# The probe is run with cwd = the app directory (src/app); make that importable, since
# sys.path[0] is the probe's own directory, not the cwd.
sys.path.insert(0, os.getcwd())

# ---- a fake pg8000.dbapi -------------------------------------------------------------
_OPENED = 0
_LIVE: list["_FakeConn"] = []


class _Dead(Exception):
    pass


class _FakeCursor:
    def __init__(self, conn: "_FakeConn") -> None:
        self._conn = conn

    def execute(self, sql: str) -> None:
        if self._conn.dead:
            raise _Dead("connection is closed")
        self._conn.executed.append(sql)

    def fetchone(self):
        return (1,)

    def close(self) -> None:
        pass


class _FakeConn:
    def __init__(self) -> None:
        global _OPENED
        _OPENED += 1
        self.id = _OPENED
        self.dead = False
        self.closed = False
        self.autocommit = False
        self.executed: list[str] = []
        _LIVE.append(self)

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self)

    def close(self) -> None:
        self.closed = True


def _fake_connect(**_kw) -> _FakeConn:
    return _FakeConn()


fake_dbapi = types.ModuleType("pg8000.dbapi")
fake_dbapi.connect = _fake_connect  # type: ignore[attr-defined]
fake_pg = types.ModuleType("pg8000")
fake_pg.dbapi = fake_dbapi  # type: ignore[attr-defined]
sys.modules["pg8000"] = fake_pg
sys.modules["pg8000.dbapi"] = fake_dbapi

# boto3 is imported at module scope by common.py; stub it so no network is touched.
fake_boto3 = types.ModuleType("boto3")
fake_boto3.client = lambda *a, **k: None  # type: ignore[attr-defined]
sys.modules["boto3"] = fake_boto3
fake_botocore = types.ModuleType("botocore")
fake_botocore_config = types.ModuleType("botocore.config")
fake_botocore_config.Config = lambda **k: None  # type: ignore[attr-defined]
sys.modules["botocore"] = fake_botocore
sys.modules["botocore.config"] = fake_botocore_config

import common  # noqa: E402  (after the stubs, deliberately)

# Credentials are fetched lazily from Secrets Manager; stub that too.
common.get_credentials = lambda: {"port": 5432, "username": "u", "password": "p", "dbname": "d"}

result: dict = {}


def write_once() -> bool:
    """One request's worth of write; True on success, False if the body raised."""
    try:
        with common.write_connection() as conn:
            cur = conn.cursor()
            cur.execute("INSERT")
        return True
    except _Dead:
        return False


# ---- 1. steady state: the pool is reused, not re-opened per request -----------------
for _ in range(10):
    assert write_once()
result["steady_state_opened"] = _OPENED  # expect 1: one connection, reused ten times

# ---- 2. FAILOVER: every socket the pool holds dies at once --------------------------
for c in _LIVE:
    c.dead = True
opened_before = _OPENED
outcomes = [write_once() for _ in range(10)]
result["failover_first_outcome"] = outcomes[0]           # the dead pooled socket fails once
result["failover_outcomes"] = outcomes                    # then every later write succeeds
result["failover_recovered_within"] = next((i for i, ok in enumerate(outcomes) if ok), None)
result["failover_new_connections"] = _OPENED - opened_before  # expect 1: one replacement
result["dead_conn_closed"] = all(c.closed for c in _LIVE if c.dead)  # discard-on-error closes it

# ---- 3. validate-after-idle: an idle pooled socket that died is caught BEFORE use ----
# Make the pooled connection look idle past the validation threshold, then kill it.
# A correct pool pings it at checkout, sees it dead, replaces it, and the write SUCCEEDS
# on the first try -- the caller never sees the failure.
entry = common._write_pool.get_nowait()
entry.last_used_at -= common.DB_CONN_VALIDATE_AFTER_IDLE_SECONDS + 1
entry.conn.dead = True
common._write_pool.put_nowait(entry)
result["idle_dead_write_succeeds_first_try"] = write_once()

# ---- 4. max lifetime: an old connection is retired at checkout even if healthy -------
entry = common._write_pool.get_nowait()
old_conn = entry.conn
entry.created_at -= common.DB_CONN_MAX_LIFETIME_SECONDS + 1
common._write_pool.put_nowait(entry)
assert write_once()
result["expired_conn_closed"] = old_conn.closed
result["expired_conn_replaced"] = common._write_pool.get_nowait().conn is not old_conn

print(json.dumps(result))
