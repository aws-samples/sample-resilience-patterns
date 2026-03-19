import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';

describe('VpcStack', () => {
  const app = new cdk.App();
  const stack = new VpcStack(app, 'TestVpc', {
    project: 'test',
    cidr: '10.0.0.0/23',
    peerCidr: '10.0.2.0/23',
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const template = Template.fromStack(stack);

  test('creates VPC with correct CIDR', () => {
    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/23',
    });
  });

  test('creates isolated subnets only (no public, no private with NAT)', () => {
    // No NAT Gateway
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    // No Internet Gateway
    template.resourceCountIs('AWS::EC2::InternetGateway', 0);
  });

  test('creates 2 subnets (1 per AZ)', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 2);
  });

  test('creates all 5 security groups', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 5);
  });

  test('ALB SG allows inbound port 80 from cross-region CIDR', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          CidrIp: '10.0.2.0/23',
          FromPort: 80,
          ToPort: 80,
          IpProtocol: 'tcp',
        }),
      ]),
    });
  });

  test('Database SG allows inbound port 5432', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
    });
  });

  test('creates S3 gateway endpoint', () => {
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: Match.objectLike({
        'Fn::Join': Match.anyValue(),
      }),
      VpcEndpointType: 'Gateway',
    });
  });

  test('creates interface endpoints with private DNS', () => {
    const endpoints = template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: {
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
      },
    });
    // CloudWatch Logs, CloudWatch Monitoring, Secrets Manager, STS, Lambda
    expect(Object.keys(endpoints).length).toBe(6);
  });
});
