import json
import logging
import os
import boto3
import psycopg2

logger = logging.getLogger()
logger.setLevel(logging.INFO)

cloudwatch = boto3.client('cloudwatch')


def get_credentials(secret_arn, region=None):
    sm = boto3.client('secretsmanager', region_name=region) if region else boto3.client('secretsmanager')
    secret = json.loads(sm.get_secret_value(SecretId=secret_arn)['SecretString'])
    return secret['host'], secret['port'], secret['username'], secret['password'], secret['dbname']


def get_order_ids(host, port, user, password, dbname):
    conn = psycopg2.connect(host=host, port=port, user=user, password=password, dbname=dbname)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM orders WHERE deleted_at IS NULL ORDER BY id")
            return {str(row[0]) for row in cur.fetchall()}
    finally:
        conn.close()


def handler(event, context):
    local_region = os.environ.get('AWS_REGION', 'us-east-1')
    remote_region = os.environ['REMOTE_REGION']
    namespace = os.environ.get('METRIC_NAMESPACE', f'{os.environ.get("PROJECT", "aurora-dsql")}/RPO')

    try:
        # Connect to local (reader) and remote (reader/writer) in single invocation
        local_host, local_port, local_user, local_pass, local_db = get_credentials(os.environ['LOCAL_SECRET_ARN'])
        remote_host, remote_port, remote_user, remote_pass, remote_db = get_credentials(
            os.environ['REMOTE_SECRET_ARN'], remote_region)

        local_ids = get_order_ids(local_host, local_port, local_user, local_pass, local_db)
        remote_ids = get_order_ids(remote_host, remote_port, remote_user, remote_pass, remote_db)

        # Delta: rows the remote has that I don't
        missing = len(remote_ids - local_ids)

        logger.info(f'Local: {len(local_ids)} rows, Remote: {len(remote_ids)} rows, Missing: {missing}')

        # Publish metrics
        cloudwatch.put_metric_data(
            Namespace=namespace,
            MetricData=[
                {
                    'MetricName': 'CatalogMissingRows',
                    'Value': missing,
                    'Unit': 'Count',
                    'Dimensions': [{'Name': 'Region', 'Value': local_region}],
                },
                {
                    'MetricName': 'CatalogRPOHeartbeat',
                    'Value': 1,
                    'Unit': 'Count',
                    'Dimensions': [{'Name': 'Region', 'Value': local_region}],
                },
            ],
        )

        return {'missing_rows': missing, 'local_count': len(local_ids), 'remote_count': len(remote_ids)}

    except Exception as e:
        logger.error(f'RPO monitor error: {e}')
        raise
