import boto3, os, socket, logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
    cw = boto3.client('cloudwatch')
    namespace = os.environ['METRIC_NAMESPACE']
    record_name = os.environ['RECORD_NAME']
    primary_alb = os.environ.get('PRIMARY_ALB_DNS', '')
    secondary_alb = os.environ.get('SECONDARY_ALB_DNS', '')

    def resolve(hostname):
        try:
            results = socket.getaddrinfo(hostname, 80, socket.AF_INET, socket.SOCK_STREAM)
            ips = {r[4][0] for r in results}
            return ips
        except Exception as e:
            logger.error(f'Failed to resolve {hostname}: {e}')
            return set()

    dns_ips = resolve(record_name)
    primary_ips = resolve(primary_alb)
    secondary_ips = resolve(secondary_alb)

    primary_active = 1.0 if primary_ips and (primary_ips & dns_ips) else 0.0
    secondary_active = 1.0 if secondary_ips and (secondary_ips & dns_ips) else 0.0

    logger.info(f'DNS={record_name} -> {dns_ips}')
    logger.info(f'Primary ALB={primary_alb} -> {primary_ips}, active={primary_active}')
    logger.info(f'Secondary ALB={secondary_alb} -> {secondary_ips}, active={secondary_active}')

    cw.put_metric_data(
        Namespace=namespace,
        MetricData=[
            {'MetricName': 'RegionDNSActive', 'Dimensions': [{'Name': 'Region', 'Value': 'us-east-1'}], 'Value': primary_active, 'Unit': 'None'},
            {'MetricName': 'RegionDNSActive', 'Dimensions': [{'Name': 'Region', 'Value': 'us-west-2'}], 'Value': secondary_active, 'Unit': 'None'},
        ],
    )
