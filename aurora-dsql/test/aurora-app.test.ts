import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AuroraAppStack } from '../lib/aurora-app-stack';

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
  const albSg = new ec2.SecurityGroup(vpcStack, 'AlbSg', { vpc });

  return Template.fromStack(new AuroraAppStack(app, 'TestAuroraApp', {
    project: 'test',
    vpc,
    lambdaSg,
    albSg,
    secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test/db-credentials-abc123',
    encryptionKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/test-key-id',
    env: { account: '123456789012', region: 'us-east-1' },
  }));
}

describe('AuroraAppStack', () => {
  const template = createStack();

  test('creates internal ALB', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
      Type: 'application',
    });
  });

  test('creates HTTP listener on port 80', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
    });
  });

  test('creates Lambda target group with health check', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      TargetType: 'lambda',
      HealthCheckEnabled: true,
      HealthCheckPath: '/health',
    });
  });

  test('creates Lambda function with correct config', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.12',
      Timeout: 60,
      ReservedConcurrentExecutions: 5,
    });
  });

  test('Lambda is VPC-deployed', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      VpcConfig: Match.objectLike({
        SubnetIds: Match.anyValue(),
      }),
    });
  });

  test('Lambda has Secrets Manager and KMS permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'secretsmanager:GetSecretValue' }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'kms:Decrypt' }),
        ]),
      },
    });
  });
});
