import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';

import { importVpc, importSg, VpcImportProps } from './imports';

export interface MonitoringStackProps extends cdk.StackProps {
  readonly project: string;
  readonly primaryRegion: string;
  readonly secondaryRegion: string;
  readonly dbClusterIdentifier: string;
  readonly vpcImport: VpcImportProps;
  readonly lambdaSgId: string;
  readonly secretArn: string;
  readonly encryptionKeyArn: string;
  readonly remoteSecretArn: string;
  readonly remoteEncryptionKeyArn: string;
  readonly globalClusterIdentifier: string;
}

export class MonitoringStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const vpc = importVpc(this, props.vpcImport);
    const lambdaSg = importSg(this, 'LambdaSg', props.lambdaSgId);

    const snsKey = new kms.Key(this, 'SnsKey', {
      alias: `${props.project}-alarm-${this.region}`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${props.project}-alarms-${this.region}`,
      masterKey: snsKey,
    });

    const alarmAction = new cw_actions.SnsAction(alarmTopic);
    const namespace = 'AWS/RDS';
    const dimensions = { DBClusterIdentifier: props.dbClusterIdentifier };

    const alarms: [string, string, number, string, number][] = [
      ['ReplicaLag', 'AuroraReplicaLag', 1000, 'Maximum', 1],
      ['ReplicaLagMax', 'AuroraReplicaLagMaximum', 2000, 'Maximum', 1],
      ['CPU', 'CPUUtilization', 80, 'Average', 3],
      ['FreeMemory', 'FreeableMemory', 256 * 1024 * 1024, 'Average', 3],
      ['CommitLatency', 'CommitLatency', 100, 'Average', 3],
    ];

    for (const [name, metricName, threshold, stat, periods] of alarms) {
      const alarm = new cloudwatch.Alarm(this, `${name}Alarm`, {
        alarmName: `${props.project}-${name}-${this.region}`,
        metric: new cloudwatch.Metric({ namespace, metricName, dimensionsMap: dimensions, statistic: stat as string, period: cdk.Duration.minutes(1) }),
        threshold: threshold as number,
        evaluationPeriods: periods as number,
        comparisonOperator: name === 'FreeMemory'
          ? cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD
          : cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.IGNORE,
      });
      alarm.addAlarmAction(alarmAction);
      alarm.addOkAction(alarmAction);
    }

    // RPO Monitor Lambda
    const rpoMonitorFn = new lambda.Function(this, 'RpoMonitorFunction', {
      functionName: `${props.project}-rpo-monitor-${this.region}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'rpo-monitor')),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      timeout: cdk.Duration.minutes(2),
      reservedConcurrentExecutions: 5,
      environment: {
        LOCAL_SECRET_ARN: props.secretArn,
        REMOTE_SECRET_ARN: props.remoteSecretArn,
        REMOTE_REGION: this.region === props.primaryRegion ? props.secondaryRegion : props.primaryRegion,
        GLOBAL_CLUSTER_ID: props.globalClusterIdentifier,
      },
    });

    rpoMonitorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.secretArn, props.remoteSecretArn],
    }));

    rpoMonitorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [props.encryptionKeyArn, props.remoteEncryptionKeyArn],
    }));

    rpoMonitorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    rpoMonitorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['rds:DescribeDBClusters'],
      resources: ['*'],
    }));

    new events.Rule(this, 'RpoSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventsTargets.LambdaFunction(rpoMonitorFn)],
    });

    // RPO alarms
    const rpoNamespace = `${props.project}/RPO`;

    new cloudwatch.Alarm(this, 'CatalogMissingRowsAlarm', {
      alarmName: `${props.project}-missing-rows-${this.region}`,
      metric: new cloudwatch.Metric({ namespace: rpoNamespace, metricName: 'CatalogMissingRows', statistic: 'Maximum', period: cdk.Duration.minutes(5) }),
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
    });

    new cloudwatch.Alarm(this, 'HeartbeatAlarm', {
      alarmName: `${props.project}-heartbeat-${this.region}`,
      metric: new cloudwatch.Metric({ namespace: rpoNamespace, metricName: 'CatalogRPOHeartbeat', statistic: 'Sum', period: cdk.Duration.minutes(10) }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    new cloudwatch.Alarm(this, 'EngineVersionMismatchAlarm', {
      alarmName: `${props.project}-engine-version-mismatch-${this.region}`,
      metric: new cloudwatch.Metric({ namespace: rpoNamespace, metricName: 'AuroraEngineVersionMismatch', statistic: 'Maximum', period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
    });

    // Dashboard
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${props.project}-${this.region}`,
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Aurora Replica Lag (ms)',
        left: [new cloudwatch.Metric({ namespace, metricName: 'AuroraReplicaLag', dimensionsMap: dimensions, statistic: 'Maximum' })],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'RPO: Missing Rows',
        left: [
          new cloudwatch.Metric({ namespace: rpoNamespace, metricName: 'CatalogMissingRows', dimensionsMap: { Region: props.primaryRegion }, statistic: 'Maximum' }),
          new cloudwatch.Metric({ namespace: rpoNamespace, metricName: 'CatalogMissingRows', dimensionsMap: { Region: props.secondaryRegion }, statistic: 'Maximum' }),
        ],
        width: 12,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'RPO: Current Missing Rows',
        metrics: [
          new cloudwatch.Metric({ namespace: rpoNamespace, metricName: 'CatalogMissingRows', dimensionsMap: { Region: props.primaryRegion }, statistic: 'Maximum' }),
          new cloudwatch.Metric({ namespace: rpoNamespace, metricName: 'CatalogMissingRows', dimensionsMap: { Region: props.secondaryRegion }, statistic: 'Maximum' }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'RPO: Heartbeat',
        left: [
          new cloudwatch.Metric({ namespace: rpoNamespace, metricName: 'CatalogRPOHeartbeat', dimensionsMap: { Region: props.primaryRegion }, statistic: 'Sum' }),
          new cloudwatch.Metric({ namespace: rpoNamespace, metricName: 'CatalogRPOHeartbeat', dimensionsMap: { Region: props.secondaryRegion }, statistic: 'Sum' }),
        ],
        width: 12,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'CPU Utilization (%)',
        left: [new cloudwatch.Metric({ namespace, metricName: 'CPUUtilization', dimensionsMap: dimensions, statistic: 'Average' })],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Commit Latency (ms)',
        left: [
          new cloudwatch.Metric({ namespace, metricName: 'CommitLatency', dimensionsMap: dimensions, statistic: 'Average' }),
          new cloudwatch.Metric({ namespace, metricName: 'CommitLatency', dimensionsMap: dimensions, statistic: 'p99' }),
        ],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Freeable Memory (bytes)',
        left: [new cloudwatch.Metric({ namespace, metricName: 'FreeableMemory', dimensionsMap: dimensions, statistic: 'Average' })],
        width: 8,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Aurora Engine Version Alignment',
        metrics: [new cloudwatch.Metric({ namespace: rpoNamespace, metricName: 'AuroraEngineVersionMismatch', statistic: 'Maximum' })],
        width: 6,
      }),
    );
  }
}
