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
  readonly remoteDbClusterIdentifier: string;
  readonly vpcImport: VpcImportProps;
  readonly lambdaSgId: string;
  readonly secretArn: string;
  readonly encryptionKeyArn: string;
  readonly remoteSecretArn: string;
  readonly remoteEncryptionKeyArn: string;
  readonly remoteDbHost: string;
  readonly globalClusterIdentifier: string;
  readonly planArn: string;
  readonly recordName: string;
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
      ['CommitLatency', 'CommitLatency', 100, 'Average', 3],
    ];

    for (const [name, metricName, threshold, stat, periods] of alarms) {
      const alarm = new cloudwatch.Alarm(this, `${name}Alarm`, {
        alarmName: `${props.project}-${name}-${this.region}`,
        metric: new cloudwatch.Metric({ namespace, metricName, dimensionsMap: dimensions, statistic: stat as string, period: cdk.Duration.minutes(1) }),
        threshold: threshold as number,
        evaluationPeriods: periods as number,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
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
        PROJECT: props.project,
        LOCAL_SECRET_ARN: `${props.project}/db-credentials`,
        REMOTE_SECRET_ARN: `${props.project}/db-credentials`,
        REMOTE_REGION: this.region === props.primaryRegion ? props.secondaryRegion : props.primaryRegion,
        REMOTE_DB_HOST: props.remoteDbHost,
        GLOBAL_CLUSTER_ID: props.globalClusterIdentifier,
      },
    });

    rpoMonitorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${props.project}/db-credentials-*`],
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
      actions: ['rds:DescribeDBClusters', 'rds:DescribeGlobalClusters'],
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

    new cloudwatch.Alarm(this, 'WriterRegionAlarm', {
      alarmName: `${props.project}-writer-region-${this.region}`,
      metric: new cloudwatch.Metric({ namespace: rpoNamespace, metricName: 'AuroraWriterActive', dimensionsMap: { Region: props.primaryRegion }, statistic: 'Maximum', period: cdk.Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
    });

    // Combined Dashboard (primary region only)
    if (this.region === props.primaryRegion) {

    // DNS Status Lambda (not VPC-deployed — ARC API has no VPC endpoint)
    const dnsStatusFn = new lambda.Function(this, 'DnsStatusFunction', {
      functionName: `${props.project}-dns-status-${this.region}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'dns-status')),
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 1,
      environment: {
        PLAN_ARN: props.planArn,
        METRIC_NAMESPACE: rpoNamespace,
      },
    });

    dnsStatusFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['arc-region-switch:ListRoute53HealthChecks'],
      resources: [props.planArn],
    }));

    dnsStatusFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    new events.Rule(this, 'DnsStatusSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(dnsStatusFn)],
    });

    const primaryDims = { DBClusterIdentifier: props.dbClusterIdentifier };
    const remoteDims = { DBClusterIdentifier: props.remoteDbClusterIdentifier };
    const rdsMetric = (metricName: string, stat: string, region: string, dims: Record<string, string>) =>
      new cloudwatch.Metric({ namespace, metricName, dimensionsMap: dims, statistic: stat, region });
    const rpoMetric = (metricName: string, stat: string, dimRegion: string) =>
      new cloudwatch.Metric({ namespace: rpoNamespace, metricName, dimensionsMap: { Region: dimRegion }, statistic: stat });

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${props.project}-combined`,
    });

    // Row 0: Writer + DNS status
    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Aurora Writer Region (1 = Writer)',
        metrics: [rpoMetric('AuroraWriterActive', 'Maximum', props.primaryRegion), rpoMetric('AuroraWriterActive', 'Maximum', props.secondaryRegion)],
        width: 12, height: 3,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'DNS Active Region (1 = Active, 0 = Removed)',
        metrics: [rpoMetric('RegionDNSActive', 'Maximum', props.primaryRegion), rpoMetric('RegionDNSActive', 'Maximum', props.secondaryRegion)],
        width: 12, height: 3,
      }),
    );

    // Row 1: Replication health
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Aurora Replica Lag (ms)',
        left: [
          rdsMetric('AuroraReplicaLag', 'Maximum', props.primaryRegion, primaryDims),
          rdsMetric('AuroraReplicaLag', 'Maximum', props.secondaryRegion, remoteDims),
        ],
        width: 12, height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'RPO: Missing Rows',
        left: [rpoMetric('CatalogMissingRows', 'Maximum', props.primaryRegion), rpoMetric('CatalogMissingRows', 'Maximum', props.secondaryRegion)],
        width: 12, height: 6,
      }),
    );

    // Row 2: Commit Latency (full-width)
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Commit Latency (ms)',
        left: [
          rdsMetric('CommitLatency', 'Average', props.primaryRegion, primaryDims),
          rdsMetric('CommitLatency', 'Average', props.secondaryRegion, remoteDims),
        ],
        width: 24, height: 6,
      }),
    );

    // Row 3: Engine Version Alignment (full-width)
    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Aurora Engine Version Alignment (0 = match, 1 = MISMATCH — blocks failover)',
        metrics: [rpoMetric('AuroraEngineVersionMismatch', 'Maximum', props.primaryRegion), rpoMetric('AuroraEngineVersionMismatch', 'Maximum', props.secondaryRegion)],
        width: 24, height: 3,
      }),
    );

    // Row 4: Heartbeat
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'RPO: Heartbeat (gaps = monitor stopped, RPO data is stale)',
        left: [rpoMetric('CatalogRPOHeartbeat', 'Sum', props.primaryRegion), rpoMetric('CatalogRPOHeartbeat', 'Sum', props.secondaryRegion)],
        width: 24, height: 5,
      }),
    );
    } // end primary region dashboard
  }
}
