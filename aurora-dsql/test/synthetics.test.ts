import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SyntheticsStack } from '../lib/synthetics-stack';

function createStack() {
  const app = new cdk.App();
  const vpcStack = new cdk.Stack(app, 'VpcStack', { env: { account: '123456789012', region: 'us-east-1' } });
  const vpc = new ec2.Vpc(vpcStack, 'Vpc', {
    maxAzs: 2, natGateways: 0,
    subnetConfiguration: [{ name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
  });
  const syntheticsSg = new ec2.SecurityGroup(vpcStack, 'SyntheticsSg', { vpc });

  return Template.fromStack(new SyntheticsStack(app, 'TestSynthetics', {
    project: 'test',
    vpc,
    syntheticsSg,
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
