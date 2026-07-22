import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';

export interface MonitoringStackProps extends cdk.StackProps {
  readonly project: string;
  readonly sourceBucketName: string;
  readonly destBucketName: string;
  readonly replicationRuleId: string;
  readonly sourceRegionLabel: string;
  readonly destRegionLabel: string;
  readonly reverseRuleId: string;
  readonly reverseSourceBucketName: string;
  readonly reverseDestBucketName: string;
  readonly primaryRegion: string;
  readonly secondaryRegion: string;
  readonly accountId: string;
  readonly mrapAlias: string;
  readonly encryptionKeyArn: string;
  readonly createDashboard?: boolean;
}

export class MonitoringStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    // SNS topic for alarm notifications
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${props.project}-replication-alarms-${props.destRegionLabel}`,
      enforceSSL: true,
      masterKey: kms.Key.fromKeyArn(this, 'SnsKey', props.encryptionKeyArn),
    });

    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.topicArn });

    const dimensions = {
      SourceBucket: props.sourceBucketName,
      DestinationBucket: props.destBucketName,
      RuleId: props.replicationRuleId,
    };

    const replicationLatency = new cloudwatch.Metric({
      namespace: 'AWS/S3',
      metricName: 'ReplicationLatency',
      dimensionsMap: dimensions,
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
    });

    const bytesPending = new cloudwatch.Metric({
      namespace: 'AWS/S3',
      metricName: 'BytesPendingReplication',
      dimensionsMap: dimensions,
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
    });

    const opsPending = new cloudwatch.Metric({
      namespace: 'AWS/S3',
      metricName: 'OperationsPendingReplication',
      dimensionsMap: dimensions,
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
    });

    const opsFailed = new cloudwatch.Metric({
      namespace: 'AWS/S3',
      metricName: 'OperationsFailedReplication',
      dimensionsMap: {
        SourceBucket: props.reverseSourceBucketName,
        DestinationBucket: props.reverseDestBucketName,
        RuleId: props.reverseRuleId,
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    // Alarms — all notify via SNS
    const snsAction = new cw_actions.SnsAction(alarmTopic);

    const latencyAlarm = new cloudwatch.Alarm(this, 'ReplicationLatencyAlarm', {
      alarmName: `${props.project}-repl-latency-${props.sourceRegionLabel}-to-${props.destRegionLabel}`,
      metric: replicationLatency,
      threshold: 900,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    latencyAlarm.addAlarmAction(snsAction);
    latencyAlarm.addOkAction(snsAction);

    const bytesPendingAlarm = new cloudwatch.Alarm(this, 'BytesPendingAlarm', {
      alarmName: `${props.project}-bytes-pending-${props.sourceRegionLabel}-to-${props.destRegionLabel}`,
      metric: bytesPending,
      threshold: 1_000_000_000,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    bytesPendingAlarm.addAlarmAction(snsAction);
    bytesPendingAlarm.addOkAction(snsAction);

    const opsFailedAlarm = new cloudwatch.Alarm(this, 'OpsFailedAlarm', {
      alarmName: `${props.project}-ops-failed-${props.sourceRegionLabel}-to-${props.destRegionLabel}`,
      metric: opsFailed,
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    opsFailedAlarm.addAlarmAction(snsAction);
    opsFailedAlarm.addOkAction(snsAction);

    const opsPendingAlarm = new cloudwatch.Alarm(this, 'OpsPendingAlarm', {
      alarmName: `${props.project}-ops-pending-${props.sourceRegionLabel}-to-${props.destRegionLabel}`,
      metric: opsPending,
      threshold: 1000,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    opsPendingAlarm.addAlarmAction(snsAction);
    opsPendingAlarm.addOkAction(snsAction);

    const customNamespace = `${props.project}`;

    const mrapDialPrimary = new cloudwatch.Metric({
      namespace: customNamespace,
      metricName: 'MrapTrafficDial',
      dimensionsMap: { Region: props.primaryRegion },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    const mrapDialSecondary = new cloudwatch.Metric({
      namespace: customNamespace,
      metricName: 'MrapTrafficDial',
      dimensionsMap: { Region: props.secondaryRegion },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    // Alarm on unexpected MRAP routing state: fires when the primary region is
    // not fully active (< 100%), which covers an unplanned failover, routing
    // drift, or a both-regions-at-0% state. Missing data is not breaching (the
    // monitor-errors alarm covers a dead monitor).
    const mrapDialDriftAlarm = new cloudwatch.Alarm(this, 'MrapDialDriftAlarm', {
      alarmName: `${props.project}-mrap-dial-drift-${props.destRegionLabel}`,
      metric: mrapDialPrimary,
      threshold: 100,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    });
    mrapDialDriftAlarm.addAlarmAction(snsAction);
    mrapDialDriftAlarm.addOkAction(snsAction);

    if (props.createDashboard !== false) {

    // --- Combined Dashboard (both replication directions) ---
    // Uses cross-region metric references for secondary region metrics

    const reverseReplicationLatency = new cloudwatch.Metric({
      namespace: 'AWS/S3',
      metricName: 'ReplicationLatency',
      dimensionsMap: {
        SourceBucket: props.reverseSourceBucketName,
        DestinationBucket: props.reverseDestBucketName,
        RuleId: props.reverseRuleId,
      },
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
      region: props.primaryRegion,
    });

    const reverseBytesPending = new cloudwatch.Metric({
      namespace: 'AWS/S3',
      metricName: 'BytesPendingReplication',
      dimensionsMap: {
        SourceBucket: props.reverseSourceBucketName,
        DestinationBucket: props.reverseDestBucketName,
        RuleId: props.reverseRuleId,
      },
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
      region: props.primaryRegion,
    });

    const reverseOpsPending = new cloudwatch.Metric({
      namespace: 'AWS/S3',
      metricName: 'OperationsPendingReplication',
      dimensionsMap: {
        SourceBucket: props.reverseSourceBucketName,
        DestinationBucket: props.reverseDestBucketName,
        RuleId: props.reverseRuleId,
      },
      statistic: 'Maximum',
      period: cdk.Duration.minutes(5),
      region: props.primaryRegion,
    });

    const reverseOpsFailed = new cloudwatch.Metric({
      namespace: 'AWS/S3',
      metricName: 'OperationsFailedReplication',
      dimensionsMap: {
        SourceBucket: props.reverseSourceBucketName,
        DestinationBucket: props.reverseDestBucketName,
        RuleId: props.reverseRuleId,
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      region: props.secondaryRegion,
    });

    // Dashboard
    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${props.project}-replication`,
      widgets: [
        [
          new cloudwatch.SingleValueWidget({
            title: 'MRAP Traffic Dial (%)',
            metrics: [mrapDialPrimary, mrapDialSecondary],
            width: 24,
          }),
        ],
        [
          new cloudwatch.TextWidget({
            markdown: `## ${props.sourceRegionLabel} → ${props.destRegionLabel}`,
            width: 24,
            height: 1,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: `Replication Latency`,
            left: [replicationLatency],
            width: 8,
          }),
          new cloudwatch.GraphWidget({
            title: `Bytes Pending`,
            left: [bytesPending],
            width: 8,
          }),
          new cloudwatch.GraphWidget({
            title: `Operations`,
            left: [opsPending],
            right: [opsFailed],
            width: 8,
          }),
        ],
        [
          new cloudwatch.TextWidget({
            markdown: `## ${props.destRegionLabel} → ${props.sourceRegionLabel}`,
            width: 24,
            height: 1,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: `Replication Latency`,
            left: [reverseReplicationLatency],
            width: 8,
          }),
          new cloudwatch.GraphWidget({
            title: `Bytes Pending`,
            left: [reverseBytesPending],
            width: 8,
          }),
          new cloudwatch.GraphWidget({
            title: `Operations`,
            left: [reverseOpsPending],
            right: [reverseOpsFailed],
            width: 8,
          }),
        ],
      ],
    });
    } // end createDashboard

    // MRAP Monitor Lambda — publishes traffic dial metric to this region
    const monitorFn = new lambda.Function(this, 'MrapMonitorFunction', {
      functionName: `${props.project}-mrap-monitor-${props.destRegionLabel}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'mrap-monitor')),
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environment: {
        ACCOUNT_ID: props.accountId,
        MRAP_ALIAS: props.mrapAlias,
        METRIC_NAMESPACE: props.project,
      },
    });

    monitorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetMultiRegionAccessPointRoutes'],
      resources: [`arn:aws:s3::${props.accountId}:accesspoint/*`],
    }));

    monitorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': props.project } },
    }));

    new events.Rule(this, 'MrapMonitorSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(monitorFn)],
    });

    // Detect a failing MRAP monitor (it now re-raises on error, so the Lambda
    // Errors metric increments and this alarm fires instead of silently going stale).
    const monitorErrorsAlarm = new cloudwatch.Alarm(this, 'MrapMonitorErrorsAlarm', {
      alarmName: `${props.project}-mrap-monitor-errors-${props.destRegionLabel}`,
      metric: monitorFn.metricErrors({ period: cdk.Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    monitorErrorsAlarm.addAlarmAction(snsAction);
    monitorErrorsAlarm.addOkAction(snsAction);
  }
}
