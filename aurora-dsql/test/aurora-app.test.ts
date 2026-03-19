import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AuroraAppStack } from '../lib/aurora-app-stack';

function createStack() {
  const app = new cdk.App();
  return Template.fromStack(new AuroraAppStack(app, 'TestAuroraApp', {
    project: 'test',
    vpcImport: { vpcId: 'vpc-123', subnetIds: 'subnet-1,subnet-2', azs: 'us-east-1a,us-east-1b' },
    lambdaSgId: 'sg-lambda',
    albSgId: 'sg-alb',
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
