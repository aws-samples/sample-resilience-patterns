import * as cdk from 'aws-cdk-lib';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { VpcImportProps, importVpc, importSg } from './imports';

export interface SyntheticsStackProps extends cdk.StackProps {
  readonly project: string;
  readonly vpcImport: VpcImportProps;
  readonly syntheticsSgId: string;
  readonly localRecordName: string;
  readonly remoteRecordName: string;
  readonly dnsRecordName: string;
}

function readOnlyCode(url: string): string {
  return `
import http.client
import urllib.parse
from aws_synthetics.selenium import synthetics_webdriver as syn_webdriver
from aws_synthetics.common import synthetics_logger as logger

def verify_request(method, url):
    parsed = urllib.parse.urlparse(url)
    conn = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=10)
    headers = {"User-Agent": str(syn_webdriver.get_canary_user_agent_string())}
    conn.request(method, parsed.path or "/", None, headers)
    resp = conn.getresponse()
    data = resp.read().decode()
    logger.info(f"{method} {url} -> {resp.status}: {data[:200]}")
    conn.close()
    if not (200 <= resp.status <= 299):
        raise Exception(f"Failed: {resp.status} {data[:200]}")

def handler(event, context):
    base = "http://${url}"
    verify_request("GET", f"{base}/health")
    verify_request("GET", f"{base}/orders")
    logger.info("Read-only checks passed")
`;
}

function writeCode(url: string): string {
  return `
import json, http.client
from aws_synthetics.selenium import synthetics_webdriver as syn_webdriver
from aws_synthetics.common import synthetics_logger as logger

def handler(event, context):
    ua = {"User-Agent": str(syn_webdriver.get_canary_user_agent_string())}
    body = json.dumps({"region": "canary-write", "status": "PENDING", "payload": {"canary": True}})
    conn = http.client.HTTPConnection("${url}", 80, timeout=10)
    conn.request("POST", "/orders", body, {**ua, "Content-Type": "application/json"})
    resp = conn.getresponse()
    data = resp.read().decode()
    if resp.status != 201:
        conn.close()
        raise Exception(f"Write failed: {resp.status} {data[:200]}")
    order_id = json.loads(data).get("id")
    conn.close()
    if order_id:
        conn2 = http.client.HTTPConnection("${url}", 80, timeout=10)
        conn2.request("DELETE", f"/orders/{order_id}", None, ua)
        conn2.getresponse().read()
        conn2.close()
    logger.info("Write canary passed")
`;
}


export class SyntheticsStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: SyntheticsStackProps) {
    super(scope, id, props);

    const vpc = importVpc(this, props.vpcImport);
    const syntheticsSg = importSg(this, 'SyntheticsSg', props.syntheticsSgId);

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

    const runtime = new synthetics.Runtime('syn-python-selenium-10.0', synthetics.RuntimeFamily.PYTHON);

    const regionCode = this.region === 'us-east-1' ? 'e1' : 'w2';
    const canaries: { suffix: string; code: string }[] = [
      { suffix: `rd-local-${regionCode}`, code: readOnlyCode(props.localRecordName) },
      { suffix: `rd-remote-${regionCode}`, code: readOnlyCode(props.remoteRecordName) },
      { suffix: `rd-global-${regionCode}`, code: readOnlyCode(props.dnsRecordName) },
      { suffix: `wr-local-${regionCode}`, code: writeCode(props.localRecordName) },
      { suffix: `wr-remote-${regionCode}`, code: writeCode(props.remoteRecordName) },
      { suffix: `wr-global-${regionCode}`, code: writeCode(props.dnsRecordName) },
    ];

    for (const { suffix, code } of canaries) {
      const canaryName = `${props.project}-${suffix}`.slice(0, 21);
      const canary = new synthetics.Canary(this, canaryName, {
        canaryName,
        runtime,
        test: synthetics.Test.custom({ code: synthetics.Code.fromInline(code), handler: 'index.handler' }),
        schedule: synthetics.Schedule.rate(cdk.Duration.minutes(5)),
        artifactsBucketLocation: { bucket: artifactBucket },
        startAfterCreation: true,
        vpc,
        vpcSubnets: { subnets: vpc.isolatedSubnets },
        securityGroups: [syntheticsSg],
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
