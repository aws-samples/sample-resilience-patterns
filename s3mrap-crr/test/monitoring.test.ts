import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MonitoringStack } from '../lib/monitoring-stack';

const app = new cdk.App();
// Monitoring stack in us-east-1 shows pdx→iad replication (metrics published in destination region)
// OperationsFailedReplication uses reverse direction (published in source region)
const stack = new MonitoringStack(app, 'TestMonitoring', {
  project: 's3mrap',
  sourceBucketName: 's3mrap-us-west-2-123456789012',
  destBucketName: 's3mrap-us-east-1-123456789012',
  replicationRuleId: 'to-primary',
  sourceRegionLabel: 'pdx',
  destRegionLabel: 'iad',
  reverseRuleId: 'to-secondary',
  reverseSourceBucketName: 's3mrap-us-east-1-123456789012',
  reverseDestBucketName: 's3mrap-us-west-2-123456789012',
  primaryRegion: 'us-east-1', accountId: '123456789012', mrapAlias: 'test-alias.mrap',
  secondaryRegion: 'us-west-2',
  env: { account: '123456789012', region: 'us-east-1' },
});
const template = Template.fromStack(stack);

test('ReplicationLatency alarm has destination-region dimensions', () => {
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'ReplicationLatency',
    Namespace: 'AWS/S3',
    Dimensions: [
      { Name: 'DestinationBucket', Value: 's3mrap-us-east-1-123456789012' },
      { Name: 'RuleId', Value: 'to-primary' },
      { Name: 'SourceBucket', Value: 's3mrap-us-west-2-123456789012' },
    ],
  });
});

test('BytesPendingReplication alarm exists', () => {
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'BytesPendingReplication',
  });
});

test('OperationsFailedReplication alarm uses reverse direction dimensions (source region)', () => {
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'OperationsFailedReplication',
    Dimensions: [
      { Name: 'DestinationBucket', Value: 's3mrap-us-west-2-123456789012' },
      { Name: 'RuleId', Value: 'to-secondary' },
      { Name: 'SourceBucket', Value: 's3mrap-us-east-1-123456789012' },
    ],
  });
});

test('CloudWatch dashboard exists', () => {
  template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
});

test('All alarms treat missing data as ignore', () => {
  const alarms = template.findResources('AWS::CloudWatch::Alarm');
  for (const [, alarm] of Object.entries(alarms)) {
    expect((alarm as any).Properties.TreatMissingData).toBe('ignore');
  }
});

test('SNS alarm topic exists', () => {
  template.resourceCountIs('AWS::SNS::Topic', 1);
});

test('All alarms have SNS alarm actions', () => {
  const alarms = template.findResources('AWS::CloudWatch::Alarm');
  for (const [name, alarm] of Object.entries(alarms)) {
    expect((alarm as any).Properties.AlarmActions).toBeDefined();
    expect((alarm as any).Properties.AlarmActions.length).toBeGreaterThan(0);
    expect((alarm as any).Properties.OKActions).toBeDefined();
    expect((alarm as any).Properties.OKActions.length).toBeGreaterThan(0);
  }
});

test('OperationsPendingReplication alarm exists', () => {
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'OperationsPendingReplication',
  });
});


