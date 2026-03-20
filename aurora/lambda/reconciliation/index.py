import json
import logging
import os
import boto3
import psycopg2

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def get_db_credentials():
    secret_id = os.environ['DB_SECRET_ARN']
    sm = boto3.client('secretsmanager')
    secret = json.loads(sm.get_secret_value(SecretId=secret_id)['SecretString'])
    return secret['username'], secret['password']


def get_order_ids(host, user, password, dbname='orders'):
    conn = psycopg2.connect(host=host, port=5432, user=user, password=password, dbname=dbname)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM orders ORDER BY id")
            return {str(row[0]) for row in cur.fetchall()}
    finally:
        conn.close()


def lambda_handler(event, context):
    source_endpoint = event['source_db_endpoint']
    target_endpoint = event['target_db_endpoint']
    user, password = get_db_credentials()

    logger.info(f'Comparing source={source_endpoint} vs target={target_endpoint}')

    source_ids = get_order_ids(source_endpoint, user, password)
    target_ids = get_order_ids(target_endpoint, user, password)

    missing_in_target = source_ids - target_ids
    missing_in_source = target_ids - source_ids

    report = {
        'source_count': len(source_ids),
        'target_count': len(target_ids),
        'missing_in_target': len(missing_in_target),
        'missing_in_source': len(missing_in_source),
        'missing_in_target_ids': sorted(list(missing_in_target))[:100],
        'missing_in_source_ids': sorted(list(missing_in_source))[:100],
    }

    logger.info(f'Reconciliation report: {json.dumps(report)}')
    return report
