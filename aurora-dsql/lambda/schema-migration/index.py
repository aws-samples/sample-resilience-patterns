import json
import logging
import os
import boto3
import psycopg2

logger = logging.getLogger()
logger.setLevel(logging.INFO)

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
    RETURN QUERY
    SELECT * FROM orders
    WHERE deleted_at IS NULL
      AND (p_region IS NULL OR region = p_region)
      AND (p_status IS NULL OR status = p_status)
      AND (p_since IS NULL OR created_at >= p_since);
END;
$$ LANGUAGE plpgsql;
"""


def get_db_credentials():
    secret_id = os.environ['DB_SECRET_ARN']
    sm = boto3.client('secretsmanager')
    secret = json.loads(sm.get_secret_value(SecretId=secret_id)['SecretString'])
    return secret['host'], secret['port'], secret['username'], secret['password'], secret['dbname']


def on_event(event, context):
    logger.info(f'Event: {json.dumps(event)}')
    request_type = event['RequestType']

    if request_type == 'Delete':
        logger.info('Delete — nothing to do')
        return {'PhysicalResourceId': 'schema-migration'}

    host, port, user, password, dbname = get_db_credentials()
    conn = psycopg2.connect(host=host, port=port, user=user, password=password, dbname=dbname)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(SCHEMA_SQL)
        logger.info('Schema migration completed successfully')
    finally:
        conn.close()

    return {'PhysicalResourceId': 'schema-migration'}
