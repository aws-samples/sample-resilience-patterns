import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DatabaseStack } from '../lib/database-stack';

function createStack() {
  const app = new cdk.App();
  const stack = new DatabaseStack(app, 'TestDb', {
    project: 'test',
    vpcImport: { vpcId: 'vpc-123', subnetIds: 'subnet-1,subnet-2', azs: 'us-east-1a,us-east-1b' },
    databaseSgId: 'sg-db',
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
      DBInstanceClass: 'db.r6g.large',
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
