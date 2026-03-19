import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ReconciliationStack } from '../lib/reconciliation-stack';

function createStack() {
  const app = new cdk.App();
  const vpcStack = new cdk.Stack(app, 'VpcStack', { env: { account: '123456789012', region: 'us-west-2' } });
  const vpc = new ec2.Vpc(vpcStack, 'Vpc', {
    maxAzs: 2, natGateways: 0,
    subnetConfiguration: [{ name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
  });
  const lambdaSg = new ec2.SecurityGroup(vpcStack, 'LambdaSg', { vpc });

  return Template.fromStack(new ReconciliationStack(app, 'TestRecon', {
    project: 'test',
    vpc,
    lambdaSg,
    secretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:test-abc',
    encryptionKeyArn: 'arn:aws:kms:us-west-2:123456789012:key/test-key',
    globalClusterIdentifier: 'test-global-cluster',
    primaryRegion: 'us-east-1',
    secondaryRegion: 'us-west-2',
    env: { account: '123456789012', region: 'us-west-2' },
  }));
}

describe('ReconciliationStack', () => {
  const template = createStack();

  test('creates reconciliation Lambda', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.12',
      Timeout: 600,
      ReservedConcurrentExecutions: 5,
    });
  });

  test('creates 2 SSM Automation Documents', () => {
    template.resourceCountIs('AWS::SSM::Document', 2);
  });

  test('creates SSM Automation role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'ssm.amazonaws.com' },
          }),
        ]),
      },
    });
  });

  test('automation role has RDS restore permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['rds:RestoreDBClusterFromSnapshot']),
          }),
        ]),
      },
    });
  });
});
