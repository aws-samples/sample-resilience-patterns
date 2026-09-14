"""Create the demo schema and stored procedures. Runs as a Kubernetes Job.

SQL carried verbatim from aws-samples/sample-resilience-patterns@9091f42 (MIT-0),
`aurora/lambda/schema-migration/index.py`. In the source repo this is a CloudFormation
custom resource; here it is a Job in the primary region's cluster, which needs no Lambda,
no VPC-attached custom resource and no kubectl provider — it reuses the app image and the
app's own database path, so if the Job can reach the database the app can too.

WHY THIS IS NOT OPTIONAL. Every route except /health calls a stored procedure. Without
this Job the app deploys, the pods pass their health probes, the load balancer reports
healthy targets, and every single request returns 500. The demo would have no steady
state to depart from.

WHY IT RUNS IN THE PRIMARY REGION ONLY. It connects to the global WRITER endpoint, and
only the primary cluster accepts writes. Running it in the secondary region would fail
against a read-only replica. Every statement is CREATE ... IF NOT EXISTS or
CREATE OR REPLACE, so a re-run on every deploy is safe and idempotent.
"""

from __future__ import annotations

import logging
import sys

from common import WRITE_HOST, write_connection

logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
LOG = logging.getLogger("schema")

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    region VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orders_region ON orders(region);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
-- Serves sp_query_orders' bounded newest-first scan without touching soft-deleted rows.
-- Partial on live rows: the table only ever GROWS (deletes are soft), so an index the
-- query can walk newest-first and stop after LIMIT is what keeps reads O(limit) forever.
CREATE INDEX IF NOT EXISTS idx_orders_active_created
    ON orders (created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS replication_tracking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_region VARCHAR(20) NOT NULL,
    txn_id BIGINT NOT NULL,
    committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    replicated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_repl_tracking_source ON replication_tracking(source_region);
CREATE INDEX IF NOT EXISTS idx_repl_tracking_committed ON replication_tracking(committed_at);

CREATE OR REPLACE FUNCTION sp_insert_order(
    p_region VARCHAR,
    p_status VARCHAR DEFAULT 'PENDING',
    p_payload JSONB DEFAULT '{}'
) RETURNS UUID AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO orders (region, status, payload)
    VALUES (p_region, p_status, p_payload)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sp_update_order_status(
    p_id UUID,
    p_status VARCHAR
) RETURNS VOID AS $$
BEGIN
    UPDATE orders SET status = p_status, updated_at = NOW()
    WHERE id = p_id AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sp_delete_order(
    p_id UUID
) RETURNS VOID AS $$
BEGIN
    UPDATE orders SET deleted_at = NOW(), updated_at = NOW()
    WHERE id = p_id AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sp_query_orders(
    p_region VARCHAR DEFAULT NULL,
    p_status VARCHAR DEFAULT NULL,
    p_since TIMESTAMPTZ DEFAULT NULL
) RETURNS SETOF orders AS $$
BEGIN
    -- BOUNDED, newest first. The unbounded original returned the ENTIRE live table on
    -- every call; under a continuously-inserting load generator with soft deletes the
    -- table only grows, so read latency grew linearly until it crossed the client's 5s
    -- timeout (live 2026-08-28: p90 1.7s -> 5.15s over 14h, reads failing at 3,133/hr).
    -- LIMIT is what makes read cost independent of uptime — a demo whose baseline rots
    -- by the hour has no steady state to depart from.
    RETURN QUERY
    SELECT * FROM orders
    WHERE deleted_at IS NULL
      AND (p_region IS NULL OR region = p_region)
      AND (p_status IS NULL OR status = p_status)
      AND (p_since IS NULL OR created_at >= p_since)
    ORDER BY created_at DESC
    LIMIT 100;
END;
$$ LANGUAGE plpgsql;
"""


def main() -> int:
    LOG.info("applying schema via write host %s", WRITE_HOST)
    with write_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute(SCHEMA_SQL)
        finally:
            cur.close()
    LOG.info("schema applied")
    return 0


if __name__ == "__main__":
    # Let the exception escape on failure: a non-zero exit is what marks the Job failed
    # and stops the deploy from reporting success over a database the app cannot use.
    sys.exit(main())
