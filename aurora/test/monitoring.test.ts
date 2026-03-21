import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MonitoringStack } from '../lib/monitoring-stack';

function createStack() {
  const app = new cdk.App();
  return Template.fromStack(new MonitoringStack(app, 'TestMonitoring', {
    project: 'test',
    primaryRegion: 'us-east-1',
    secondaryRegion: 'us-west-2',
    dbClusterIdentifier: 'test-cluster',
    remoteDbClusterIdentifier: 'test-remote-cluster',
    vpcImport: { vpcId: 'vpc-123', subnetIds: 'subnet-1,subnet-2', azs: 'us-east-1a,us-east-1b' },
    lambdaSgId: 'sg-lambda',
    secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-abc',
    encryptionKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/test-key',
    remoteSecretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:test-abc',
    remoteEncryptionKeyArn: 'arn:aws:kms:us-west-2:123456789012:key/test-key', remoteDbHost: 'remote-cluster.us-west-2.rds.amazonaws.com',
    globalClusterIdentifier: 'test-global-cluster',
    planArn: 'arn:aws:arc-region-switch::123:plan/test', recordName: 'aurora-app.demo.internal',
    env: { account: '123456789012', region: 'us-east-1' },
  }));
}

describe('MonitoringStack', () => {
  const template = createStack();

  test('creates Aurora alarms (ReplicaLag, ReplicaLagMax, CommitLatency)', () => {
    // 3 Aurora alarms + 2 RPO alarms + 1 engine version alarm + 1 writer region alarm = 7 total
    template.resourceCountIs('AWS::CloudWatch::Alarm', 7);
  });

  test('creates KMS-encrypted SNS topic', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'test-alarms-us-east-1',
      KmsMasterKeyId: Match.anyValue(),
    });
  });

  test('alarms use treat missing data as ignore', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      TreatMissingData: 'ignore',
    });
  });

  test('creates RPO monitor Lambda', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.12',
      ReservedConcurrentExecutions: 5,
    });
  });

  test('RPO monitor runs every 5 minutes', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(5 minutes)',
    });
  });

  test('creates CloudWatch dashboard', () => {
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });

  test('heartbeat alarm uses BREACHING for missing data', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'test-heartbeat-us-east-1',
      TreatMissingData: 'breaching',
    });
  });
});
