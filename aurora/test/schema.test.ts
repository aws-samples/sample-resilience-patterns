import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SchemaStack } from '../lib/schema-stack';

function createStack() {
  const app = new cdk.App();
  return Template.fromStack(new SchemaStack(app, 'TestSchema', {
    project: 'test',
    vpcImport: { vpcId: 'vpc-123', subnetIds: 'subnet-1,subnet-2', azs: 'us-east-1a,us-east-1b' },
    lambdaSgId: 'sg-lambda',
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
      Runtime: 'python3.12',
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
