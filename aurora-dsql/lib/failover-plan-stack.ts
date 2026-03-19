import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface FailoverPlanStackProps extends cdk.StackProps {
  readonly project: string;
  readonly primaryRegion: string;
  readonly secondaryRegion: string;
  readonly globalClusterIdentifier: string;
  readonly primaryClusterArn: string;
  readonly secondaryClusterArn: string;
  readonly hostedZoneId: string;
  readonly auroraRecordName: string;
  readonly dsqlRecordName: string;
}

export class FailoverPlanStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: FailoverPlanStackProps) {
    super(scope, id, props);

    const executionRole = new iam.Role(this, 'RegionSwitchExecutionRole', {
      roleName: `${props.project}-region-switch-role`,
      assumedBy: new iam.ServicePrincipal('arc-region-switch.amazonaws.com'),
    });

    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['arc-region-switch:GetPlan', 'arc-region-switch:GetPlanExecution', 'arc-region-switch:ListPlanExecutions'],
      resources: ['*'],
    }));

    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['rds:DescribeGlobalClusters', 'rds:DescribeDBClusters'],
      resources: ['*'],
    }));

    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['rds:FailoverGlobalCluster', 'rds:SwitchoverGlobalCluster'],
      resources: [
        `arn:aws:rds::${this.account}:global-cluster:${props.globalClusterIdentifier}`,
        props.primaryClusterArn,
        props.secondaryClusterArn,
      ],
    }));

    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['route53:ChangeResourceRecordSets', 'route53:GetHostedZone', 'route53:ListResourceRecordSets'],
      resources: [`arn:aws:route53:::hostedzone/${props.hostedZoneId}`],
    }));

    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['route53:GetHealthCheck', 'route53:UpdateHealthCheck'],
      resources: ['arn:aws:route53:::healthcheck/*'],
    }));

    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:DescribeAlarms', 'cloudwatch:DescribeAlarmHistory', 'cloudwatch:GetMetricStatistics'],
      resources: ['*'],
    }));

    const plan = new cdk.CfnResource(this, 'RegionSwitchPlan', {
      type: 'AWS::ARCRegionSwitch::Plan',
      properties: {
        Name: `${props.project}-region-switch`,
        ExecutionRole: executionRole.roleArn,
        RecoveryApproach: 'activeActive',
        PrimaryRegion: props.primaryRegion,
        Regions: [props.primaryRegion, props.secondaryRegion],
        Workflows: [
          {
            WorkflowTargetAction: 'deactivate',
            WorkflowDescription: 'Failover Aurora Global DB and shift DNS away',
            Steps: [
              {
                Name: 'failover-aurora-db',
                ExecutionBlockType: 'AuroraGlobalDatabase',
                ExecutionBlockConfiguration: {
                  GlobalAuroraConfig: {
                    GlobalClusterIdentifier: props.globalClusterIdentifier,
                    DatabaseClusterArns: [props.primaryClusterArn, props.secondaryClusterArn],
                    Behavior: 'switchoverOnly',
                    Ungraceful: { Ungraceful: 'failover' },
                    TimeoutMinutes: 20,
                  },
                },
              },
              {
                Name: 'shift-dns-aurora',
                ExecutionBlockType: 'Route53HealthCheck',
                ExecutionBlockConfiguration: {
                  Route53HealthCheckConfig: {
                    HostedZoneId: props.hostedZoneId,
                    RecordName: props.auroraRecordName,
                    RecordSets: [
                      { RecordSetIdentifier: 'PrimaryRegion', Region: props.primaryRegion },
                      { RecordSetIdentifier: 'StandbyRegion', Region: props.secondaryRegion },
                    ],
                    TimeoutMinutes: 5,
                  },
                },
              },
              {
                Name: 'shift-dns-dsql',
                ExecutionBlockType: 'Route53HealthCheck',
                ExecutionBlockConfiguration: {
                  Route53HealthCheckConfig: {
                    HostedZoneId: props.hostedZoneId,
                    RecordName: props.dsqlRecordName,
                    RecordSets: [
                      { RecordSetIdentifier: 'PrimaryRegion', Region: props.primaryRegion },
                      { RecordSetIdentifier: 'StandbyRegion', Region: props.secondaryRegion },
                    ],
                    TimeoutMinutes: 5,
                  },
                },
              },
            ],
          },
          {
            WorkflowTargetAction: 'activate',
            WorkflowDescription: 'Restore DNS traffic to re-activated region',
            Steps: [
              {
                Name: 'restore-dns-aurora',
                ExecutionBlockType: 'Route53HealthCheck',
                ExecutionBlockConfiguration: {
                  Route53HealthCheckConfig: {
                    HostedZoneId: props.hostedZoneId,
                    RecordName: props.auroraRecordName,
                    RecordSets: [
                      { RecordSetIdentifier: 'PrimaryRegion', Region: props.primaryRegion },
                      { RecordSetIdentifier: 'StandbyRegion', Region: props.secondaryRegion },
                    ],
                    TimeoutMinutes: 5,
                  },
                },
              },
              {
                Name: 'restore-dns-dsql',
                ExecutionBlockType: 'Route53HealthCheck',
                ExecutionBlockConfiguration: {
                  Route53HealthCheckConfig: {
                    HostedZoneId: props.hostedZoneId,
                    RecordName: props.dsqlRecordName,
                    RecordSets: [
                      { RecordSetIdentifier: 'PrimaryRegion', Region: props.primaryRegion },
                      { RecordSetIdentifier: 'StandbyRegion', Region: props.secondaryRegion },
                    ],
                    TimeoutMinutes: 5,
                  },
                },
              },
            ],
          },
        ],
      },
    });

    new cdk.CfnOutput(this, 'PlanArn', { value: plan.ref });
    new cdk.CfnOutput(this, 'ExecutionRoleArn', { value: executionRole.roleArn });
  }
}
