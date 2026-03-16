import json
import os
import time
import boto3
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

FAILOVER_CONTROL_REGIONS = ['us-east-1', 'us-west-2', 'ap-southeast-2', 'ap-northeast-1', 'eu-west-1']


def handler(event, context):
    """Handle ARC Region Switch Plan invocation.

    ARC invokes this Lambda in the activating region (RegionToRun: activatingRegion),
    so AWS_REGION tells us which region is becoming active.
    """
    logger.info(f'Event: {json.dumps(event)}')

    account_id = os.environ['ACCOUNT_ID']
    mrap_arn = os.environ['MRAP_ARN']
    primary_bucket = os.environ['PRIMARY_BUCKET']
    secondary_bucket = os.environ['SECONDARY_BUCKET']
    primary_region = os.environ['PRIMARY_REGION']
    secondary_region = os.environ['SECONDARY_REGION']

    # Fix 1: ARC invokes the Lambda in the activating region
    active_region = os.environ.get('AWS_REGION', primary_region)

    if active_region == primary_region:
        routes = [
            {'Bucket': primary_bucket, 'Region': primary_region, 'TrafficDialPercentage': 100},
            {'Bucket': secondary_bucket, 'Region': secondary_region, 'TrafficDialPercentage': 0},
        ]
    else:
        routes = [
            {'Bucket': primary_bucket, 'Region': primary_region, 'TrafficDialPercentage': 0},
            {'Bucket': secondary_bucket, 'Region': secondary_region, 'TrafficDialPercentage': 100},
        ]

    # Fix 2: Use local region as S3 Control endpoint, fall back to others
    local_region = os.environ.get('AWS_REGION', 'us-east-1')
    ctrl_regions = [local_region] + [r for r in FAILOVER_CONTROL_REGIONS if r != local_region]

    for attempt in range(3):
        ctrl_region = ctrl_regions[min(attempt, len(ctrl_regions) - 1)]
        try:
            s3control = boto3.client('s3control', region_name=ctrl_region)
            s3control.submit_multi_region_access_point_routes(
                AccountId=account_id,
                Mrap=mrap_arn,
                RouteUpdates=routes,
            )
            logger.info(f'MRAP routing updated: active={active_region} via {ctrl_region}')
            return {'statusCode': 200, 'activeRegion': active_region}
        except Exception as e:
            logger.warning(f'Attempt {attempt + 1} via {ctrl_region} failed: {e}')
            if attempt < 2:
                time.sleep(2 ** attempt)
            else:
                raise
