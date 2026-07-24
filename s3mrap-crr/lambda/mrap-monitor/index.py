import os
import boto3
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

FAILOVER_CONTROL_REGIONS = ['us-east-1', 'us-west-2', 'ap-southeast-2', 'ap-northeast-1', 'eu-west-1']


def handler(event, context):
    account_id = os.environ['ACCOUNT_ID']
    mrap_alias = os.environ['MRAP_ALIAS']
    namespace = os.environ.get('METRIC_NAMESPACE', 'S3MRAP')

    region = os.environ.get('AWS_REGION', 'us-east-1')
    ctrl_region = region if region in FAILOVER_CONTROL_REGIONS else 'us-east-1'

    s3control = boto3.client('s3control', region_name=ctrl_region)
    cw = boto3.client('cloudwatch')

    mrap_arn = f'arn:aws:s3::{account_id}:accesspoint/{mrap_alias}'

    try:
        resp = s3control.get_multi_region_access_point_routes(
            AccountId=account_id, Mrap=mrap_arn,
        )
    except Exception as e:
        logger.error(f'Failed to get MRAP routes: {e}')
        raise

    metric_data = []
    for route in resp.get('Routes', []):
        r = route.get('Region', '')
        dial = route.get('TrafficDialPercentage', 0)
        logger.info(f'MRAP route: {r} = {dial}%')
        metric_data.append({
            'MetricName': 'MrapTrafficDial',
            'Dimensions': [{'Name': 'Region', 'Value': r}],
            'Value': float(dial),
            'Unit': 'Percent',
        })

    if metric_data:
        cw.put_metric_data(Namespace=namespace, MetricData=metric_data)

    return {'statusCode': 200, 'routes': resp.get('Routes', [])}
