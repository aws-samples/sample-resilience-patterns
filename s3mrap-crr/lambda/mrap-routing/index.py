import json
import os
import time
import boto3
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handler(event, context):
    """Handle ARC Region Switch Plan invocation.

    ARC sends an event with 'activeRegion' indicating which region to route to.
    We set that region's traffic dial to 100% and the other to 0%.
    """
    logger.info(f'Event: {json.dumps(event)}')

    account_id = os.environ['ACCOUNT_ID']
    mrap_arn = os.environ['MRAP_ARN']
    primary_bucket = os.environ['PRIMARY_BUCKET']
    secondary_bucket = os.environ['SECONDARY_BUCKET']
    primary_region = os.environ['PRIMARY_REGION']
    secondary_region = os.environ['SECONDARY_REGION']

    # Determine active region from ARC event or explicit parameter
    active_region = event.get('activeRegion') or event.get('region') or primary_region

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

    # Use a failover control endpoint
    s3control = boto3.client('s3control', region_name='us-west-2')

    for attempt in range(3):
        try:
            s3control.submit_multi_region_access_point_routes(
                AccountId=account_id,
                Mrap=mrap_arn,
                RouteUpdates=routes,
            )
            logger.info(f'MRAP routing updated: active={active_region}')
            return {'statusCode': 200, 'activeRegion': active_region}
        except Exception as e:
            logger.warning(f'Attempt {attempt + 1} failed: {e}')
            if attempt < 2:
                time.sleep(2 ** attempt)
            else:
                raise
