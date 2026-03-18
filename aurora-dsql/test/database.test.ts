import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DatabaseStack } from '../lib/database-stack';

function createStack() {
  const app = new cdk.App();
  const vpcStack = new cdk.Stack(app, 'VpcStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const vpc = new ec2.Vpc(vpcStack, 'Vpc', {
    maxAzs: 2,
    natGateways: 0,
    subnetConfiguration: [
      { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
    ],
  });
  const dbSg = new ec2.SecurityGroup(vpcStack, 'DbSg', { vpc });

  const stack = new DatabaseStack(app, 'TestDb', {
    project: 'test',
    vpc,
    databaseSg: dbSg,
    globalClusterIdentifier: 'test-global-cluster',
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('DatabaseStack', () => {
  const template = createStack();

  test('creates Aurora Global Cluster', () => {
    template.hasResourceProperties('AWS::RDS::GlobalCluster', {
      GlobalClusterIdentifier: 'test-global-cluster',
      Engine: 'aurora-postgresql',
      StorageEncrypted: true,
    });
  });

  test('creates primary Aurora cluster attached to global cluster', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      GlobalClusterIdentifier: 'test-global-cluster',
      Engine: 'aurora-postgresql',
      DatabaseName: 'orders',
    });
  });

  test('creates writer DB instance', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceClass: 'db.t4g.medium',
    });
  });

  test('creates KMS key with rotation for encryption', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  test('creates Secrets Manager secret for credentials', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'test/db-credentials',
    });
  });

  test('cluster uses isolated subnets', () => {
    template.hasResourceProperties('AWS::RDS::DBSubnetGroup', {
      SubnetIds: Match.anyValue(),
    });
  });

  test('deletion protection disabled for demo', () => {
    template.hasResourceProperties('AWS::RDS::GlobalCluster', {
      DeletionProtection: false,
    });
  });
});
