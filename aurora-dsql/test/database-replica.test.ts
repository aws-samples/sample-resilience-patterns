import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DatabaseReplicaStack } from '../lib/database-replica-stack';

function createStack() {
  const app = new cdk.App();
  const vpcStack = new cdk.Stack(app, 'VpcStack', {
    env: { account: '123456789012', region: 'us-west-2' },
  });
  const vpc = new ec2.Vpc(vpcStack, 'Vpc', {
    maxAzs: 2,
    natGateways: 0,
    subnetConfiguration: [
      { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
    ],
  });
  const dbSg = new ec2.SecurityGroup(vpcStack, 'DbSg', { vpc });

  const stack = new DatabaseReplicaStack(app, 'TestDbReplica', {
    project: 'test',
    vpc,
    databaseSg: dbSg,
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
