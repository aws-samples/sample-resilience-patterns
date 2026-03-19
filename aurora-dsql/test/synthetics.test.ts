import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SyntheticsStack } from '../lib/synthetics-stack';

function createStack() {
  const app = new cdk.App();
  return Template.fromStack(new SyntheticsStack(app, 'TestSynthetics', {
    project: 'test',
    vpcImport: { vpcId: 'vpc-123', subnetIds: 'subnet-1,subnet-2', azs: 'us-east-1a,us-east-1b' },
    syntheticsSgId: 'sg-synth',
    localAuroraAlbDns: 'aurora-local.elb.amazonaws.com',
    localDsqlAlbDns: 'dsql-local.elb.amazonaws.com',
    crossRegionAuroraUrl: 'aurora-app.demo.internal',
    crossRegionDsqlUrl: 'dsql-app.demo.internal',
    env: { account: '123456789012', region: 'us-east-1' },
  }));
}

describe('SyntheticsStack', () => {
  const template = createStack();

  test('creates 4 canaries (local + cross for each app)', () => {
    template.resourceCountIs('AWS::Synthetics::Canary', 4);
  });

  test('canaries run every 5 minutes', () => {
    template.hasResourceProperties('AWS::Synthetics::Canary', {
      Schedule: { Expression: 'rate(5 minutes)' },
    });
  });

  test('canaries are VPC-deployed', () => {
    template.hasResourceProperties('AWS::Synthetics::Canary', {
      VPCConfig: Match.objectLike({
        SubnetIds: Match.anyValue(),
        SecurityGroupIds: Match.anyValue(),
      }),
    });
  });

  test('creates KMS-encrypted artifact bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{
          ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' },
        }],
      },
    });
  });

  test('creates 4 alarms (one per canary)', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 4);
  });

  test('alarms check SuccessPercent < 100', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 100,
      ComparisonOperator: 'LessThanThreshold',
    });
  });
});
