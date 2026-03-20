import json
import logging
import os
import time
import random
import http.client
import uuid
import statistics
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

cloudwatch = boto3.client('cloudwatch')


def make_request(host, method, path, body=None):
    conn = http.client.HTTPConnection(host, 80, timeout=10)
    headers = {'Content-Type': 'application/json'}
    start = time.monotonic()
    try:
        conn.request(method, path, body, headers)
        resp = conn.getresponse()
        resp.read()
        latency = (time.monotonic() - start) * 1000
        return resp.status, latency
    except Exception as e:
        latency = (time.monotonic() - start) * 1000
        return 0, latency
    finally:
        conn.close()


def run_operation(host, op_type):
    if op_type == 'insert':
        body = json.dumps({'region': os.environ.get('AWS_REGION', 'us-east-1'), 'status': 'PENDING', 'payload': {'loadtest': True}})
        return make_request(host, 'POST', '/orders', body)
    elif op_type == 'query':
        return make_request(host, 'GET', '/orders?region=us-east-1')
    elif op_type == 'update':
        fake_id = str(uuid.uuid4())
        body = json.dumps({'status': 'COMPLETED'})
        return make_request(host, 'PUT', f'/orders/{fake_id}/status', body)
    elif op_type == 'delete':
        fake_id = str(uuid.uuid4())
        return make_request(host, 'DELETE', f'/orders/{fake_id}')
    return 0, 0


def handler(event, context):
    rps = int(event.get('rps', '10'))
    duration = int(event.get('duration', '300'))
    target = event.get('target', 'both')
    mix = [int(x) for x in event.get('mix', '50,20,10,20').split(',')]

    aurora_host = os.environ.get('AURORA_ALB_DNS', '')

    hosts = []
    if aurora_host:
        hosts.append(('aurora', aurora_host))

    ops = []
    for pct, op in zip(mix, ['insert', 'query', 'update', 'delete']):
        ops.extend([op] * pct)

    results = {'total': 0, 'errors': 0, 'latencies': []}
    end_time = time.monotonic() + duration
    interval = 1.0 / rps if rps > 0 else 1.0

    logger.info(f'Starting load test: {rps} RPS, {duration}s, targets={[h[0] for h in hosts]}')

    while time.monotonic() < end_time:
        batch_start = time.monotonic()
        for _ in range(rps):
            if time.monotonic() >= end_time:
                break
            app_name, host = random.choice(hosts)
            op = random.choice(ops)
            status, latency = run_operation(host, op)
            results['total'] += 1
            results['latencies'].append(latency)
            if status < 200 or status >= 300:
                results['errors'] += 1

        elapsed = time.monotonic() - batch_start
        if elapsed < 1.0:
            time.sleep(1.0 - elapsed)

    latencies = sorted(results['latencies']) if results['latencies'] else [0]
    summary = {
        'total_requests': results['total'],
        'errors': results['errors'],
        'error_rate': results['errors'] / max(results['total'], 1) * 100,
        'avg_latency_ms': statistics.mean(latencies),
        'p50_latency_ms': latencies[len(latencies) // 2],
        'p99_latency_ms': latencies[int(len(latencies) * 0.99)],
        'min_latency_ms': min(latencies),
        'max_latency_ms': max(latencies),
    }

    logger.info(f'Load test complete: {json.dumps(summary)}')

    namespace = f'{os.environ.get("PROJECT", "aurora")}/LoadTest'
    cloudwatch.put_metric_data(Namespace=namespace, MetricData=[
        {'MetricName': 'RequestsSent', 'Value': results['total'], 'Unit': 'Count'},
        {'MetricName': 'Errors', 'Value': results['errors'], 'Unit': 'Count'},
        {'MetricName': 'AvgLatency', 'Value': summary['avg_latency_ms'], 'Unit': 'Milliseconds'},
        {'MetricName': 'P99Latency', 'Value': summary['p99_latency_ms'], 'Unit': 'Milliseconds'},
    ])

    return summary
