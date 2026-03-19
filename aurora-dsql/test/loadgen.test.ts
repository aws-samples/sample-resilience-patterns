import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { LoadGenStack } from '../lib/loadgen-stack';

function createStack() {
  const app = new cdk.App();
  return Template.fromStack(new LoadGenStack(app, 'TestLoadGen', {
    project: 'test',
    vpcImport: { vpcId: 'vpc-123', subnetIds: 'subnet-1,subnet-2', azs: 'us-east-1a,us-east-1b' },
    lambdaSgId: 'sg-lambda',
    auroraAlbDns: 'aurora.elb.amazonaws.com',
    dsqlAlbDns: 'dsql.elb.amazonaws.com',
    env: { account: '123456789012', region: 'us-east-1' },
  }));
}

describe('LoadGenStack', () => {
  const template = createStack();

  test('creates load gen Lambda with correct config', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.12',
      Timeout: 900,
      MemorySize: 512,
      ReservedConcurrentExecutions: 10,
    });
  });

  test('Lambda has ALB DNS env vars', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          AURORA_ALB_DNS: 'aurora.elb.amazonaws.com',
          DSQL_ALB_DNS: 'dsql.elb.amazonaws.com',
        }),
      },
    });
  });

  test('creates SSM Automation Document', () => {
    template.resourceCountIs('AWS::SSM::Document', 1);
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

  test('Lambda has CloudWatch PutMetricData permission', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'cloudwatch:PutMetricData' }),
        ]),
      },
    });
  });
});
