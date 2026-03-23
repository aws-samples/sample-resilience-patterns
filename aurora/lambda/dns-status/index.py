import boto3, os, logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
    arc = boto3.client('arc-region-switch')
    cw = boto3.client('cloudwatch')
    namespace = os.environ['METRIC_NAMESPACE']

    resp = arc.list_route53_health_checks(
        arn=os.environ['PLAN_ARN'],
        hostedZoneId=os.environ['HOSTED_ZONE_ID'],
        recordName=os.environ['RECORD_NAME']
    )

    metrics = []
    for hc in resp.get('healthChecks', []):
        status = hc.get('status', 'healthy')
        value = 1.0 if status == 'healthy' else 0.0
        logger.info(f"Region={hc['region']} status={status} value={value}")
        metrics.append({
            'MetricName': 'RegionDNSActive',
            'Dimensions': [{'Name': 'Region', 'Value': hc['region']}],
            'Value': value,
            'Unit': 'None',
        })

    if metrics:
        cw.put_metric_data(Namespace=namespace, MetricData=metrics)
    return {'metrics': metrics}
