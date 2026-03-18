import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FailoverPlanStack } from '../lib/failover-plan-stack';

function createStack() {
  const app = new cdk.App();
  return Template.fromStack(new FailoverPlanStack(app, 'TestFailover', {
    project: 'test',
    primaryRegion: 'us-east-1',
    secondaryRegion: 'us-west-2',
    globalClusterIdentifier: 'test-global-cluster',
    primaryClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:test-primary',
    secondaryClusterArn: 'arn:aws:rds:us-west-2:123456789012:cluster:test-secondary',
    hostedZoneId: 'Z12345',
    auroraRecordName: 'aurora-app.demo.internal',
    dsqlRecordName: 'dsql-app.demo.internal',
    env: { account: '123456789012', region: 'us-east-1' },
  }));
}

describe('FailoverPlanStack', () => {
  const template = createStack();

  test('creates ARC Region Switch Plan', () => {
    template.hasResourceProperties('AWS::ARCRegionSwitch::Plan', {
      RecoveryApproach: 'activePassive',
      PrimaryRegion: 'us-east-1',
      Regions: ['us-east-1', 'us-west-2'],
    });
  });

  test('plan has deactivate workflow with Aurora failover step', () => {
    template.hasResourceProperties('AWS::ARCRegionSwitch::Plan', {
      Workflows: Match.arrayWith([
        Match.objectLike({
          WorkflowTargetAction: 'deactivate',
          Steps: Match.arrayWith([
            Match.objectLike({
              Name: 'failover-aurora-db',
              ExecutionBlockType: 'AuroraGlobalDatabase',
            }),
          ]),
        }),
      ]),
    });
  });

  test('plan has deactivate workflow with Route53 DNS shift steps', () => {
    template.hasResourceProperties('AWS::ARCRegionSwitch::Plan', {
      Workflows: Match.arrayWith([
        Match.objectLike({
          WorkflowTargetAction: 'deactivate',
          Steps: Match.arrayWith([
            Match.objectLike({
              Name: 'shift-dns-aurora',
              ExecutionBlockType: 'Route53HealthCheck',
            }),
            Match.objectLike({
              Name: 'shift-dns-dsql',
              ExecutionBlockType: 'Route53HealthCheck',
            }),
          ]),
        }),
      ]),
    });
  });

  test('plan has activate workflow to restore DNS', () => {
    template.hasResourceProperties('AWS::ARCRegionSwitch::Plan', {
      Workflows: Match.arrayWith([
        Match.objectLike({
          WorkflowTargetAction: 'activate',
          Steps: Match.arrayWith([
            Match.objectLike({ Name: 'restore-dns-aurora' }),
            Match.objectLike({ Name: 'restore-dns-dsql' }),
          ]),
        }),
      ]),
    });
  });

  test('creates execution role for ARC', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'arc-region-switch.amazonaws.com' },
          }),
        ]),
      },
    });
  });

  test('execution role has RDS failover permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['rds:FailoverGlobalCluster', 'rds:SwitchoverGlobalCluster']),
          }),
        ]),
      },
    });
  });

  test('execution role has Route53 permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['route53:ChangeResourceRecordSets']),
          }),
        ]),
      },
    });
  });
});
