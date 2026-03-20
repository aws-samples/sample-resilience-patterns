import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SyntheticsStack } from '../lib/synthetics-stack';

describe('SyntheticsStack', () => {
  const app = new cdk.App();
  const template = Template.fromStack(new SyntheticsStack(app, 'TestSynthetics', {
    project: 'test',
    vpcImport: { vpcId: 'vpc-123', subnetIds: 'subnet-1,subnet-2', azs: 'us-east-1a,us-east-1b' },
    syntheticsSgId: 'sg-synth',
    localRecordName: 'aurora-app-use1.demo.internal',
    remoteRecordName: 'aurora-app-usw2.demo.internal',
    dnsRecordName: 'aurora-app.demo.internal',
    env: { account: '123456789012', region: 'us-east-1' },
  }));

  test('creates 3 canaries', () => { template.resourceCountIs('AWS::Synthetics::Canary', 3); });
  test('canaries run every 5 minutes', () => { template.hasResourceProperties('AWS::Synthetics::Canary', { Schedule: { Expression: 'rate(5 minutes)' } }); });
  test('canaries are VPC-deployed', () => { template.hasResourceProperties('AWS::Synthetics::Canary', { VPCConfig: Match.objectLike({ SubnetIds: Match.anyValue() }) }); });
  test('creates KMS-encrypted artifact bucket', () => { template.hasResourceProperties('AWS::S3::Bucket', { BucketEncryption: Match.anyValue() }); });
  test('creates 3 alarms', () => { template.resourceCountIs('AWS::CloudWatch::Alarm', 3); });
});
