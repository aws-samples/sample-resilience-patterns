import boto3, os

def handler(event, context):
    arc = boto3.client('arc-region-switch')
    cw = boto3.client('cloudwatch')
    namespace = os.environ['METRIC_NAMESPACE']
    resp = arc.list_route53_health_checks(arn=os.environ['PLAN_ARN'])
    metrics = []
    for hc in resp.get('healthChecks', []):
        metrics.append({
            'MetricName': 'RegionDNSActive',
            'Dimensions': [{'Name': 'Region', 'Value': hc['region']}],
            'Value': 1.0 if hc.get('status') == 'healthy' else 0.0,
            'Unit': 'None',
        })
    if metrics:
        cw.put_metric_data(Namespace=namespace, MetricData=metrics)
