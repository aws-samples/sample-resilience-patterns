import * as cdk from 'aws-cdk-lib';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

export interface SyntheticsStackProps extends cdk.StackProps {
  readonly project: string;
  readonly vpc: ec2.IVpc;
  readonly syntheticsSg: ec2.ISecurityGroup;
  readonly localAuroraAlbDns: string;
  readonly localDsqlAlbDns: string;
  readonly crossRegionAuroraUrl: string;
  readonly crossRegionDsqlUrl: string;
}

export class SyntheticsStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: SyntheticsStackProps) {
    super(scope, id, props);

    const encryptionKey = new kms.Key(this, 'CanaryArtifactKey', {
      alias: `${props.project}-canary-${this.region}`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const artifactBucket = new s3.Bucket(this, 'CanaryArtifactBucket', {
      bucketName: `${props.project}-canary-${this.region}-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const canaryCode = (albUrl: string) => synthetics.Code.fromInline(`
import http.client
import json
import urllib.parse
from aws_synthetics.selenium import synthetics_webdriver as syn_webdriver
from aws_synthetics.common import synthetics_logger as logger

ALB_URL = "${albUrl}"

def verify_request(method, url, body=None, expected_status=None):
    parsed = urllib.parse.urlparse(url)
    conn = http.client.HTTPConnection(parsed.hostname, parsed.port or 80)
    headers = {"Content-Type": "application/json", "User-Agent": str(syn_webdriver.get_canary_user_agent_string())}
    conn.request(method, parsed.path or "/", body, headers)
    resp = conn.getresponse()
    data = resp.read().decode()
    logger.info(f"{method} {url} -> {resp.status}: {data}")
    ok = resp.status == expected_status if expected_status else 200 <= resp.status <= 299
    conn.close()
    if not ok:
        raise Exception(f"Failed: {resp.status} {data}")
    return json.loads(data) if data else {}

def handler(event, context):
    base = f"http://{ALB_URL}"
    # Health check
    verify_request("GET", f"{base}/health")
    # Insert
    result = verify_request("POST", f"{base}/orders", json.dumps({"region": "canary-test", "status": "PENDING", "payload": {"test": True}}), 201)
    order_id = result.get("id")
    # Query
    verify_request("GET", f"{base}/orders?region=canary-test")
    # Update
    if order_id:
        verify_request("PUT", f"{base}/orders/{order_id}/status", json.dumps({"status": "COMPLETED"}))
    # Delete
    if order_id:
        verify_request("DELETE", f"{base}/orders/{order_id}")
    logger.info("All CRUD operations passed")
`);

    const vpcConfig: synthetics.CfnCanary.VPCConfigProperty = {
      vpcId: props.vpc.vpcId,
      subnetIds: props.vpc.isolatedSubnets.map(s => s.subnetId),
      securityGroupIds: [props.syntheticsSg.securityGroupId],
    };

    const canaryConfigs: [string, string][] = [
      [`${props.project}-al-${this.region.replace(/-/g, '').slice(-4)}`, props.localAuroraAlbDns],
      [`${props.project}-ax-${this.region.replace(/-/g, '').slice(-4)}`, props.crossRegionAuroraUrl],
      [`${props.project}-dl-${this.region.replace(/-/g, '').slice(-4)}`, props.localDsqlAlbDns],
      [`${props.project}-dx-${this.region.replace(/-/g, '').slice(-4)}`, props.crossRegionDsqlUrl],
    ];

    for (const [name, url] of canaryConfigs) {
      // Canary names max 21 chars
      const canaryName = name.slice(0, 21);
      const canary = new synthetics.Canary(this, canaryName, {
        canaryName,
        runtime: synthetics.Runtime.SYNTHETICS_PYTHON_SELENIUM_4_1,
        test: synthetics.Test.custom({ code: canaryCode(url), handler: 'index.handler' }),
        schedule: synthetics.Schedule.rate(cdk.Duration.minutes(5)),
        artifactsBucketLocation: { bucket: artifactBucket },
        startAfterCreation: true,
        vpc: props.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [props.syntheticsSg],
      });

      new cloudwatch.Alarm(this, `${canaryName}-alarm`, {
        alarmName: `${canaryName}-success`,
        metric: canary.metricSuccessPercent({ period: cdk.Duration.minutes(5) }),
        threshold: 100,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.IGNORE,
      });
    }
  }
}
