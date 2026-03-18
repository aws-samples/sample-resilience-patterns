import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { LoadGenStack } from '../lib/loadgen-stack';

function createStack() {
  const app = new cdk.App();
  const vpcStack = new cdk.Stack(app, 'VpcStack', { env: { account: '123456789012', region: 'us-east-1' } });
  const vpc = new ec2.Vpc(vpcStack, 'Vpc', {
    maxAzs: 2, natGateways: 0,
    subnetConfiguration: [{ name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
  });
  const lambdaSg = new ec2.SecurityGroup(vpcStack, 'LambdaSg', { vpc });

  return Template.fromStack(new LoadGenStack(app, 'TestLoadGen', {
    project: 'test',
    vpc,
    lambdaSg,
    auroraAlbDns: 'aurora.elb.amazonaws.com',
    dsqlAlbDns: 'dsql.elb.amazonaws.com',
    env: { account: '123456789012', region: 'us-east-1' },
  }));
}

describe('LoadGenStack', () => {
  const template = createStack();

  test('creates load gen Lambda with correct config', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.13',
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
