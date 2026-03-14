import json
import boto3
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client('s3')


def handler(event, context):
    request_type = event['RequestType']
    logger.info(f'Request type: {request_type}')

    if request_type == 'Delete':
        return {'PhysicalResourceId': event.get('PhysicalResourceId', 'crr-config')}

    primary_bucket = event['ResourceProperties'].get('PrimaryBucket') or __import__('os').environ['PRIMARY_BUCKET']
    secondary_bucket = event['ResourceProperties'].get('SecondaryBucket') or __import__('os').environ['SECONDARY_BUCKET']
    primary_region = event['ResourceProperties'].get('PrimaryRegion') or __import__('os').environ['PRIMARY_REGION']
    secondary_region = event['ResourceProperties'].get('SecondaryRegion') or __import__('os').environ['SECONDARY_REGION']
    role_arn = event['ResourceProperties'].get('ReplicationRoleArn') or __import__('os').environ['REPLICATION_ROLE_ARN']

    # Configure bidirectional replication
    _put_replication(primary_bucket, secondary_bucket, secondary_region, role_arn, 'to-secondary')
    _put_replication(secondary_bucket, primary_bucket, primary_region, role_arn, 'to-primary')

    return {'PhysicalResourceId': 'crr-config'}


def _put_replication(source_bucket, dest_bucket, dest_region, role_arn, rule_id):
    logger.info(f'Configuring replication: {source_bucket} -> {dest_bucket} ({dest_region})')

    s3_regional = boto3.client('s3', region_name=_bucket_region(source_bucket))
    s3_regional.put_bucket_replication(
        Bucket=source_bucket,
        ReplicationConfiguration={
            'Role': role_arn,
            'Rules': [{
                'ID': rule_id,
                'Status': 'Enabled',
                'Filter': {'Prefix': ''},
                'Destination': {
                    'Bucket': f'arn:aws:s3:::{dest_bucket}',
                    'Metrics': {
                        'Status': 'Enabled',
                        'EventThreshold': {'Minutes': 15},
                    },
                    'ReplicationTime': {
                        'Status': 'Enabled',
                        'Time': {'Minutes': 15},
                    },
                },
                'DeleteMarkerReplication': {'Status': 'Enabled'},
                'Priority': 1,
            }],
        },
    )


def _bucket_region(bucket_name):
    resp = s3.get_bucket_location(Bucket=bucket_name)
    loc = resp.get('LocationConstraint')
    return loc if loc else 'us-east-1'
