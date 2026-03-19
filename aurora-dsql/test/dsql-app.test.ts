import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DsqlAppStack } from '../lib/dsql-app-stack';

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

  return Template.fromStack(new DsqlAppStack(app, 'TestDsqlApp', {
    project: 'test',
    vpc,
    lambdaSg,
    albSg,
    dsqlEndpoint: 'test-cluster.dsql.us-east-1.on.aws',
    env: { account: '123456789012', region: 'us-east-1' },
  }));
}

describe('DsqlAppStack', () => {
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

  test('creates Lambda function with DSQL endpoint env var', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.12',
      Timeout: 60,
      ReservedConcurrentExecutions: 5,
      Environment: {
        Variables: Match.objectLike({
          DSQL_ENDPOINT: 'test-cluster.dsql.us-east-1.on.aws',
        }),
      },
    });
  });

  test('Lambda has DSQL IAM auth permission', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'dsql:DbConnectAdmin' }),
        ]),
      },
    });
  });

  test('Lambda has no Secrets Manager permission (uses IAM auth)', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    for (const [, policy] of Object.entries(policies)) {
      const statements = (policy as any).Properties?.PolicyDocument?.Statement || [];
      for (const stmt of statements) {
        if (typeof stmt.Action === 'string') {
          expect(stmt.Action).not.toBe('secretsmanager:GetSecretValue');
        }
      }
    }
  });
});
