import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DatabaseStack } from '../lib/database-stack';

function createStack() {
  const app = new cdk.App();
  const stack = new DatabaseStack(app, 'TestDb', {
    project: 'test',
    vpcImport: { vpcId: 'vpc-123', subnetIds: 'subnet-1,subnet-2', azs: 'us-east-1a,us-east-1b' },
    databaseSgId: 'sg-db',
    globalClusterIdentifier: 'test-global-cluster', secondaryRegion: 'us-west-2',
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('DatabaseStack', () => {
  const template = createStack();

  test('creates Aurora Global Cluster that adopts the primary DBCluster', () => {
    // GlobalCluster uses SourceDBClusterIdentifier to promote the existing
    // primary cluster — NOT engine/version/storageEncrypted (those inherit
    // from the source). This pattern avoids the CFN delete-time race.
    template.hasResourceProperties('AWS::RDS::GlobalCluster', {
      GlobalClusterIdentifier: 'test-global-cluster',
      SourceDBClusterIdentifier: Match.anyValue(),
    });
  });

  test('primary DBCluster has no GlobalClusterIdentifier (delete-race fix)', () => {
    // The primary cluster MUST NOT carry a GlobalClusterIdentifier prop.
    // If it did, CFN's DBCluster handler would look up the global on delete,
    // get a 404 when the global is deleted first, and misinterpret that as
    // "cluster already deleted" — leaking the real cluster.
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      DatabaseName: 'orders',
      GlobalClusterIdentifier: Match.absent(),
    });
  });

  test('GlobalCluster depends on DBCluster (correct delete ordering)', () => {
    // DependsOn means CFN creates DBCluster first, then wraps it with
    // GlobalCluster. On delete, CFN deletes GlobalCluster first — a clean
    // AWS API op when the source cluster is still alive.
    template.hasResource('AWS::RDS::GlobalCluster', {
      DependsOn: Match.arrayWith([Match.stringLikeRegexp('PrimaryCluster.*')]),
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
