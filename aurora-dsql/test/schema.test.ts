import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SchemaStack } from '../lib/schema-stack';

function createStack() {
  const app = new cdk.App();
  const vpcStack = new cdk.Stack(app, 'VpcStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const vpc = new ec2.Vpc(vpcStack, 'Vpc', {
    maxAzs: 2, natGateways: 0,
    subnetConfiguration: [{ name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
  });
  const lambdaSg = new ec2.SecurityGroup(vpcStack, 'LambdaSg', { vpc });

  return Template.fromStack(new SchemaStack(app, 'TestSchema', {
    project: 'test',
    vpc,
    lambdaSg,
    secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test/db-credentials-abc123',
    encryptionKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/test-key-id',
    env: { account: '123456789012', region: 'us-east-1' },
  }));
}

describe('SchemaStack', () => {
  const template = createStack();

  test('creates migration Lambda function', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.on_event',
      Runtime: 'python3.13',
      Timeout: 300,
      ReservedConcurrentExecutions: 1,
    });
  });

  test('Lambda is VPC-deployed', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      VpcConfig: Match.objectLike({
        SubnetIds: Match.anyValue(),
        SecurityGroupIds: Match.anyValue(),
      }),
    });
  });

  test('Lambda has Secrets Manager access', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'secretsmanager:GetSecretValue',
          }),
        ]),
      },
    });
  });

  test('creates custom resource for migration', () => {
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
  });
});
