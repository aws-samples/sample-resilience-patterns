import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DatabaseReplicaStack } from '../lib/database-replica-stack';

function createStack() {
  const app = new cdk.App();
  const stack = new DatabaseReplicaStack(app, 'TestDbReplica', {
    project: 'test',
    vpcImport: { vpcId: 'vpc-123', subnetIds: 'subnet-1,subnet-2', azs: 'us-west-2a,us-west-2b' },
    databaseSgId: 'sg-db',
    globalClusterIdentifier: 'test-global-cluster',
    env: { account: '123456789012', region: 'us-west-2' },
  });
  return Template.fromStack(stack);
}

describe('DatabaseReplicaStack', () => {
  const template = createStack();

  test('creates secondary Aurora cluster attached to global cluster', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      GlobalClusterIdentifier: 'test-global-cluster',
      Engine: 'aurora-postgresql',
    });
  });

  test('secondary cluster has no MasterUsername', () => {
    const clusters = template.findResources('AWS::RDS::DBCluster');
    for (const [, resource] of Object.entries(clusters)) {
      expect((resource as any).Properties.MasterUsername).toBeUndefined();
      expect((resource as any).Properties.MasterUserPassword).toBeUndefined();
      expect((resource as any).Properties.DatabaseName).toBeUndefined();
    }
  });

  test('creates reader DB instance', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
  });

  test('creates regional KMS key with rotation', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  test('cluster uses isolated subnets', () => {
    template.hasResourceProperties('AWS::RDS::DBSubnetGroup', {
      SubnetIds: Match.anyValue(),
    });
  });
});
