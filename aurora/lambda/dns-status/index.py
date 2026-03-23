import boto3, os, socket

def handler(event, context):
    cw = boto3.client('cloudwatch')
    namespace = os.environ['METRIC_NAMESPACE']
    record_name = os.environ['RECORD_NAME']
    primary_alb = os.environ.get('PRIMARY_ALB_DNS', '')
    secondary_alb = os.environ.get('SECONDARY_ALB_DNS', '')

    # Resolve the ARC-managed DNS record to see which ALB it points to
    # Then resolve each ALB to compare IPs
    try:
        dns_ips = set(socket.getaddrinfo(record_name, 80, socket.AF_INET))
        dns_ips = {addr[4][0] for addr in dns_ips}
    except Exception:
        dns_ips = set()

    metrics = []
    for region, alb_dns in [('us-east-1', primary_alb), ('us-west-2', secondary_alb)]:
        try:
            alb_ips = {addr[4][0] for addr in socket.getaddrinfo(alb_dns, 80, socket.AF_INET)}
            active = 1.0 if alb_ips & dns_ips else 0.0
        except Exception:
            active = 0.0
        metrics.append({
            'MetricName': 'RegionDNSActive',
            'Dimensions': [{'Name': 'Region', 'Value': region}],
            'Value': active,
            'Unit': 'None',
        })

    if metrics:
        cw.put_metric_data(Namespace=namespace, MetricData=metrics)
