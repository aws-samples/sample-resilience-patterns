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
    namespace = os.environ.get('METRIC_NAMESPACE', f'{os.environ.get("PROJECT", "aurora")}/RPO')

    try:
        # Connect to local (reader) and remote (reader/writer) in single invocation
        local_host, local_port, local_user, local_pass, local_db = get_credentials(os.environ['LOCAL_SECRET_ARN'])
        remote_host, remote_port, remote_user, remote_pass, remote_db = get_credentials(
            os.environ['REMOTE_SECRET_ARN'])
        # Override remote host with the actual endpoint (secret may contain primary writer host)
        remote_host = os.environ.get('REMOTE_DB_HOST', remote_host)

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

    finally:
        # Engine version check (runs even if RPO check fails)
        try:
            _check_engine_versions(local_region, remote_region, namespace)
        except Exception as e:
            logger.error(f'Engine version check error: {e}')


def _check_engine_versions(local_region, remote_region, namespace):
    global_cluster_id = os.environ.get('GLOBAL_CLUSTER_ID')
    if not global_cluster_id:
        return

    rds = boto3.client('rds', region_name=local_region)
    resp = rds.describe_global_clusters(GlobalClusterIdentifier=global_cluster_id)
    members = resp['GlobalClusters'][0]['GlobalClusterMembers']
    versions = set()
    for m in members:
        # Each member has its own EngineVersion via the cluster ARN
        # But describe_global_clusters doesn't return per-member versions directly
        # Use the global cluster's EngineVersion and check if all members are writers/readers
        pass

    # Use describe_db_clusters locally — the local cluster is visible
    clusters = rds.describe_db_clusters()['DBClusters']
    local_ver = None
    for c in clusters:
        if c.get('GlobalClusterIdentifier') == global_cluster_id:
            local_ver = c['EngineVersion']
            break

    # Global cluster engine version (applies to all members)
    global_ver = resp['GlobalClusters'][0].get('EngineVersion')

    mismatch = 0 if (local_ver and global_ver and local_ver == global_ver) else 1

    logger.info(f'Engine versions — local: {local_ver}, global: {global_ver}, mismatch: {mismatch}')

    cloudwatch.put_metric_data(
        Namespace=namespace,
        MetricData=[{
            'MetricName': 'AuroraEngineVersionMismatch',
            'Value': mismatch,
            'Unit': 'Count',
        }],
    )
