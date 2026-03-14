import json
import os
import time
import statistics
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handler(event, context):
    source_region = event.get('sourceRegion', os.environ.get('PRIMARY_REGION', 'us-east-1'))
    dest_region = event.get('destRegion', os.environ.get('SECONDARY_REGION', 'us-west-2'))
    object_count = int(event.get('objectCount', 100))
    object_size_kb = int(event.get('objectSizeKB', 10))
    timeout_seconds = int(event.get('timeoutSeconds', 300))

    primary_bucket = os.environ['PRIMARY_BUCKET']
    secondary_bucket = os.environ['SECONDARY_BUCKET']
    primary_region = os.environ['PRIMARY_REGION']

    source_bucket = primary_bucket if source_region == primary_region else secondary_bucket
    dest_bucket = secondary_bucket if source_region == primary_region else primary_bucket

    s3_source = boto3.client('s3', region_name=source_region)
    s3_dest = boto3.client('s3', region_name=dest_region)

    ts = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')
    prefix = f'load-test/{ts}'
    payload = b'x' * (object_size_kb * 1024)

    # Upload objects
    upload_times = {}
    logger.info(f'Uploading {object_count} objects ({object_size_kb}KB each) to {source_bucket} in {source_region}')

    def upload(i):
        key = f'{prefix}/{i}.dat'
        s3_source.put_object(Bucket=source_bucket, Key=key, Body=payload)
        return key, time.monotonic()

    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = [pool.submit(upload, i) for i in range(object_count)]
        for f in as_completed(futures):
            key, t = f.result()
            upload_times[key] = t

    # Poll for replication
    logger.info(f'Polling {dest_bucket} in {dest_region} for replication...')
    latencies = []
    failures = 0

    def poll(key):
        start = upload_times[key]
        deadline = start + timeout_seconds
        while time.monotonic() < deadline:
            try:
                s3_dest.head_object(Bucket=dest_bucket, Key=key)
                return time.monotonic() - start
            except s3_dest.exceptions.ClientError:
                time.sleep(2)
        return None

    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(poll, k): k for k in upload_times}
        for f in as_completed(futures):
            result = f.result()
            if result is not None:
                latencies.append(result)
            else:
                failures += 1

    # Calculate statistics
    result = {
        'objectsUploaded': object_count,
        'objectsReplicated': len(latencies),
        'replicationFailures': failures,
        'sourceRegion': source_region,
        'destRegion': dest_region,
        'latency': {},
    }

    if latencies:
        latencies.sort()
        result['latency'] = {
            'minSeconds': round(latencies[0], 2),
            'maxSeconds': round(latencies[-1], 2),
            'avgSeconds': round(statistics.mean(latencies), 2),
            'p50Seconds': round(latencies[len(latencies) // 2], 2),
            'p99Seconds': round(latencies[int(len(latencies) * 0.99)], 2),
        }

    logger.info(f'Results: {json.dumps(result)}')
    return result
