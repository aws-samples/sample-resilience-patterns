"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MonitoringStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const cloudwatch = __importStar(require("aws-cdk-lib/aws-cloudwatch"));
const cw_actions = __importStar(require("aws-cdk-lib/aws-cloudwatch-actions"));
const sns = __importStar(require("aws-cdk-lib/aws-sns"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const events = __importStar(require("aws-cdk-lib/aws-events"));
const targets = __importStar(require("aws-cdk-lib/aws-events-targets"));
const path = __importStar(require("path"));
class MonitoringStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // SNS topic for alarm notifications
        const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
            topicName: `${props.project}-replication-alarms-${props.destRegionLabel}`,
            enforceSSL: true,
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
        // Dashboard
        new cloudwatch.Dashboard(this, 'Dashboard', {
            dashboardName: `${props.project}-replication-${props.sourceRegionLabel}-to-${props.destRegionLabel}`,
            widgets: [
                [
                    new cloudwatch.SingleValueWidget({
                        title: 'MRAP Traffic Dial (%)',
                        metrics: [mrapDialPrimary, mrapDialSecondary],
                        width: 24,
                    }),
                ],
                [
                    new cloudwatch.GraphWidget({
                        title: `Replication Latency (${props.sourceRegionLabel} → ${props.destRegionLabel})`,
                        left: [replicationLatency],
                        width: 12,
                    }),
                    new cloudwatch.GraphWidget({
                        title: `Bytes Pending Replication`,
                        left: [bytesPending],
                        width: 12,
                    }),
                ],
                [
                    new cloudwatch.GraphWidget({
                        title: `Replication Operations`,
                        left: [opsPending],
                        right: [opsFailed],
                        width: 24,
                    }),
                ],
            ],
        });
        // MRAP Monitor Lambda — publishes traffic dial metric to this region
        const monitorFn = new lambda.Function(this, 'MrapMonitorFunction', {
            functionName: `${props.project}-mrap-monitor-${props.destRegionLabel}`,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'mrap-monitor')),
            timeout: cdk.Duration.seconds(30),
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
    }
}
exports.MonitoringStack = MonitoringStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvcmluZy1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1vbml0b3Jpbmctc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLHVFQUF5RDtBQUN6RCwrRUFBaUU7QUFDakUseURBQTJDO0FBQzNDLCtEQUFpRDtBQUNqRCx5REFBMkM7QUFDM0MsK0RBQWlEO0FBQ2pELHdFQUEwRDtBQUMxRCwyQ0FBNkI7QUFrQjdCLE1BQWEsZUFBZ0IsU0FBUSxHQUFHLENBQUMsS0FBSztJQUM1QyxZQUFZLEtBQWMsRUFBRSxFQUFVLEVBQUUsS0FBMkI7UUFDakUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsb0NBQW9DO1FBQ3BDLE1BQU0sVUFBVSxHQUFHLElBQUksR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ25ELFNBQVMsRUFBRSxHQUFHLEtBQUssQ0FBQyxPQUFPLHVCQUF1QixLQUFLLENBQUMsZUFBZSxFQUFFO1lBQ3pFLFVBQVUsRUFBRSxJQUFJO1NBQ2pCLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsZUFBZSxFQUFFLEVBQUUsS0FBSyxFQUFFLFVBQVUsQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDO1FBRXpFLE1BQU0sVUFBVSxHQUFHO1lBQ2pCLFlBQVksRUFBRSxLQUFLLENBQUMsZ0JBQWdCO1lBQ3BDLGlCQUFpQixFQUFFLEtBQUssQ0FBQyxjQUFjO1lBQ3ZDLE1BQU0sRUFBRSxLQUFLLENBQUMsaUJBQWlCO1NBQ2hDLENBQUM7UUFFRixNQUFNLGtCQUFrQixHQUFHLElBQUksVUFBVSxDQUFDLE1BQU0sQ0FBQztZQUMvQyxTQUFTLEVBQUUsUUFBUTtZQUNuQixVQUFVLEVBQUUsb0JBQW9CO1lBQ2hDLGFBQWEs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QyxlQUFlLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQ2hELE9BQU8sRUFBRSxDQUFDLDBCQUEwQixDQUFDO1lBQ3JDLFNBQVMsRUFBRSxDQUFDLEdBQUcsQ0FBQztZQUNoQixVQUFVLEVBQUUsRUFBRSxZQUFZLEVBQUUsRUFBRSxzQkFBc0IsRUFBRSxLQUFLLENBQUMsT0FBTyxFQUFFLEVBQUU7U0FDeEUsQ0FBQyxDQUFDLENBQUM7UUFFSixJQUFJLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLHFCQUFxQixFQUFFO1lBQzNDLFFBQVEsRUFBRSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUN2RCxPQUFPLEVBQUUsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxjQUFjLENBQUMsU0FBUyxDQUFDLENBQUM7U0FDakQsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBdkxELDBDQXVMQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBjbG91ZHdhdGNoIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoJztcbmltcG9ydCAqIGFzIGN3X2FjdGlvbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWNsb3Vkd2F0Y2gtYWN0aW9ucyc7XG5pbXBvcnQgKiBhcyBzbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNucyc7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBldmVudHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWV2ZW50cyc7XG5pbXBvcnQgKiBhcyB0YXJnZXRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1ldmVudHMtdGFyZ2V0cyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5leHBvcnQgaW50ZXJmYWNlIE1vbml0b3JpbmdTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICByZWFkb25seSBwcm9qZWN0OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHNvdXJjZUJ1Y2tldE5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgZGVzdEJ1Y2tldE5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgcmVwbGljYXRpb25SdWxlSWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgc291cmNlUmVnaW9uTGFiZWw6IHN0cmluZztcbiAgcmVhZG9ubHkgZGVzdFJlZ2lvbkxhYmVsOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJldmVyc2VSdWxlSWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgcmV2ZXJzZVNvdXJjZUJ1Y2tldE5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgcmV2ZXJzZURlc3RCdWNrZXROYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHByaW1hcnlSZWdpb246IHN0cmluZztcbiAgcmVhZG9ubHkgc2Vjb25kYXJ5UmVnaW9uOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFjY291bnRJZDogc3RyaW5nO1xuICByZWFkb25seSBtcmFwQWxpYXM6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIE1vbml0b3JpbmdTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBjZGsuQXBwLCBpZDogc3RyaW5nLCBwcm9wczogTW9uaXRvcmluZ1N0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIFNOUyB0b3BpYyBmb3IgYWxhcm0gbm90aWZpY2F0aW9uc1xuICAgIGNvbnN0IGFsYXJtVG9waWMgPSBuZXcgc25zLlRvcGljKHRoaXMsICdBbGFybVRvcGljJywge1xuICAgICAgdG9waWNOYW1lOiBgJHtwcm9wcy5wcm9qZWN0fS1yZXBsaWNhdGlvbi1hbGFybXMtJHtwcm9wcy5kZXN0UmVnaW9uTGFiZWx9YCxcbiAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWxhcm1Ub3BpY0FybicsIHsgdmFsdWU6IGFsYXJtVG9waWMudG9waWNBcm4gfSk7XG5cbiAgICBjb25zdCBkaW1lbnNpb25zID0ge1xuICAgICAgU291cmNlQnVja2V0OiBwcm9wcy5zb3VyY2VCdWNrZXROYW1lLFxuICAgICAgRGVzdGluYXRpb25CdWNrZXQ6IHByb3BzLmRlc3RCdWNrZXROYW1lLFxuICAgICAgUnVsZUlkOiBwcm9wcy5yZXBsaWNhdGlvblJ1bGVJZCxcbiAgICB9O1xuXG4gICAgY29uc3QgcmVwbGljYXRpb25MYXRlbmN5ID0gbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgIG5hbWVzcGFjZTogJ0FXUy9TMycsXG4gICAgICBtZXRyaWNOYW1lOiAnUmVwbGljYXRpb25MYXRlbmN5JyxcbiAgICAgIGRpbWVuc2lvbnNNYXA6IGRpbWVuc2lvbnMsXG4gICAgICBzdGF0aXN0aWM6ICdNYXhpbXVtJyxcbiAgICAgIHBlcmlvZDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBieXRlc1BlbmRpbmcgPSBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgbmFtZXNwYWNlOiAnQVdTL1MzJyxcbiAgICAgIG1ldHJpY05hbWU6ICdCeXRlc1BlbmRpbmdSZXBsaWNhdGlvbicsXG4gICAgICBkaW1lbnNpb25zTWFwOiBkaW1lbnNpb25zLFxuICAgICAgc3RhdGlzdGljOiAnTWF4aW11bScsXG4gICAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5taW51dGVzKDEpLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgb3BzUGVuZGluZyA9IG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICBuYW1lc3BhY2U6ICdBV1MvUzMnLFxuICAgICAgbWV0cmljTmFtZTogJ09wZXJhdGlvbnNQZW5kaW5nUmVwbGljYXRpb24nLFxuICAgICAgZGltZW5zaW9uc01hcDogZGltZW5zaW9ucyxcbiAgICAgIHN0YXRpc3RpYzogJ01heGltdW0nLFxuICAgICAgcGVyaW9kOiBjZGsuRHVyYXRpb24ubWludXRlcygxKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IG9wc0ZhaWxlZCA9IG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICBuYW1lc3BhY2U6ICdBV1MvUzMnLFxuICAgICAgbWV0cmljTmFtZTogJ09wZXJhdGlvbnNGYWlsZWRSZXBsaWNhdGlvbicsXG4gICAgICBkaW1lbnNpb25zTWFwOiB7XG4gICAgICAgIFNvdXJjZUJ1Y2tldDogcHJvcHMucmV2ZXJzZVNvdXJjZUJ1Y2tldE5hbWUsXG4gICAgICAgIERlc3RpbmF0aW9uQnVja2V0OiBwcm9wcy5yZXZlcnNlRGVzdEJ1Y2tldE5hbWUsXG4gICAgICAgIFJ1bGVJZDogcHJvcHMucmV2ZXJzZVJ1bGVJZCxcbiAgICAgIH0sXG4gICAgICBzdGF0aXN0aWM6ICdTdW0nLFxuICAgICAgcGVyaW9kOiBjZGsuRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICB9KTtcblxuICAgIC8vIEFsYXJtcyDigJQgYWxsIG5vdGlmeSB2aWEgU05TXG4gICAgY29uc3Qgc25zQWN0aW9uID0gbmV3IGN3X2FjdGlvbnMuU25zQWN0aW9uKGFsYXJtVG9waWMpO1xuXG4gICAgY29uc3QgbGF0ZW5jeUFsYXJtID0gbmV3IGNsb3Vkd2F0Y2guQWxhcm0odGhpcywgJ1JlcGxpY2F0aW9uTGF0ZW5jeUFsYXJtJywge1xuICAgICAgYWxhcm1OYW1lOiBgJHtwcm9wcy5wcm9qZWN0fS1yZXBsLWxhdGVuY3ktJHtwcm9wcy5zb3VyY2VSZWdpb25MYWJlbH0tdG8tJHtwcm9wcy5kZXN0UmVnaW9uTGFiZWx9YCxcbiAgICAgIG1ldHJpYzogcmVwbGljYXRpb25MYXRlbmN5LFxuICAgICAgdGhyZXNob2xkOiA5MDAsXG4gICAgICBldmFsdWF0aW9uUGVyaW9kczogMyxcbiAgICAgIHRyZWF0TWlzc2luZ0RhdGE6IGNsb3Vkd2F0Y2guVHJlYXRNaXNzaW5nRGF0YS5JR05PUkUsXG4gICAgICBjb21wYXJpc29uT3BlcmF0b3I6IGNsb3Vkd2F0Y2guQ29tcGFyaXNvbk9wZXJhdG9yLkdSRUFURVJfVEhBTl9USFJFU0hPTEQsXG4gICAgfSk7XG4gICAgbGF0ZW5jeUFsYXJtLmFkZEFsYXJtQWN0aW9uKHNuc0FjdGlvbik7XG4gICAgbGF0ZW5jeUFsYXJtLmFkZE9rQWN0aW9uKHNuc0FjdGlvbik7XG5cbiAgICBjb25zdCBieXRlc1BlbmRpbmdBbGFybSA9IG5ldyBjbG91ZHdhdGNoLkFsYXJtKHRoaXMsICdCeXRlc1BlbmRpbmdBbGFybScsIHtcbiAgICAgIGFsYXJtTmFtZTogYCR7cHJvcHMucHJvamVjdH0tYnl0ZXMtcGVuZGluZy0ke3Byb3BzLnNvdXJjZVJlZ2lvbkxhYmVsfS10by0ke3Byb3BzLmRlc3RSZWdpb25MYWJlbH1gLFxuICAgICAgbWV0cmljOiBieXRlc1BlbmRpbmcsXG4gICAgICB0aHJlc2hvbGQ6IDFfMDAwXzAwMF8wMDAsXG4gICAgICBldmFsdWF0aW9uUGVyaW9kczogMyxcbiAgICAgIHRyZWF0TWlzc2luZ0RhdGE6IGNsb3Vkd2F0Y2guVHJlYXRNaXNzaW5nRGF0YS5JR05PUkUsXG4gICAgICBjb21wYXJpc29uT3BlcmF0b3I6IGNsb3Vkd2F0Y2guQ29tcGFyaXNvbk9wZXJhdG9yLkdSRUFURVJfVEhBTl9USFJFU0hPTEQsXG4gICAgfSk7XG4gICAgYnl0ZXNQZW5kaW5nQWxhcm0uYWRkQWxhcm1BY3Rpb24oc25zQWN0aW9uKTtcbiAgICBieXRlc1BlbmRpbmdBbGFybS5hZGRPa0FjdGlvbihzbnNBY3Rpb24pO1xuXG4gICAgY29uc3Qgb3BzRmFpbGVkQWxhcm0gPSBuZXcgY2xvdWR3YXRjaC5BbGFybSh0aGlzLCAnT3BzRmFpbGVkQWxhcm0nLCB7XG4gICAgICBhbGFybU5hbWU6IGAke3Byb3BzLnByb2plY3R9LW9wcy1mYWlsZWQtJHtwcm9wcy5zb3VyY2VSZWdpb25MYWJlbH0tdG8tJHtwcm9wcy5kZXN0UmVnaW9uTGFiZWx9YCxcbiAgICAgIG1ldHJpYzogb3BzRmFpbGVkLFxuICAgICAgdGhyZXNob2xkOiAxLFxuICAgICAgZXZhbHVhdGlvblBlcmlvZHM6IDEsXG4gICAgICB0cmVhdE1pc3NpbmdEYXRhOiBjbG91ZHdhdGNoLlRyZWF0TWlzc2luZ0RhdGEuSUdOT1JFLFxuICAgICAgY29tcGFyaXNvbk9wZXJhdG9yOiBjbG91ZHdhdGNoLkNvbXBhcmlzb25PcGVyYXRvci5HUkVBVEVSX1RIQU5fT1JfRVFVQUxfVE9fVEhSRVNIT0xELFxuICAgIH0pO1xuICAgIG9wc0ZhaWxlZEFsYXJtLmFkZEFsYXJtQWN0aW9uKHNuc0FjdGlvbik7XG4gICAgb3BzRmFpbGVkQWxhcm0uYWRkT2tBY3Rpb24oc25zQWN0aW9uKTtcblxuICAgIGNvbnN0IG9wc1BlbmRpbmdBbGFybSA9IG5ldyBjbG91ZHdhdGNoLkFsYXJtKHRoaXMsICdPcHNQZW5kaW5nQWxhcm0nLCB7XG4gICAgICBhbGFybU5hbWU6IGAke3Byb3BzLnByb2plY3R9LW9wcy1wZW5kaW5nLSR7cHJvcHMuc291cmNlUmVnaW9uTGFiZWx9LXRvLSR7cHJvcHMuZGVzdFJlZ2lvbkxhYmVsfWAsXG4gICAgICBtZXRyaWM6IG9wc1BlbmRpbmcsXG4gICAgICB0aHJlc2hvbGQ6IDEwMDAsXG4gICAgICBldmFsdWF0aW9uUGVyaW9kczogMyxcbiAgICAgIHRyZWF0TWlzc2luZ0RhdGE6IGNsb3Vkd2F0Y2guVHJlYXRNaXNzaW5nRGF0YS5JR05PUkUsXG4gICAgICBjb21wYXJpc29uT3BlcmF0b3I6IGNsb3Vkd2F0Y2guQ29tcGFyaXNvbk9wZXJhdG9yLkdSRUFURVJfVEhBTl9USFJFU0hPTEQsXG4gICAgfSk7XG4gICAgb3BzUGVuZGluZ0FsYXJtLmFkZEFsYXJtQWN0aW9uKHNuc0FjdGlvbik7XG4gICAgb3BzUGVuZGluZ0FsYXJtLmFkZE9rQWN0aW9uKHNuc0FjdGlvbik7XG5cbiAgICBjb25zdCBjdXN0b21OYW1lc3BhY2UgPSBgJHtwcm9wcy5wcm9qZWN0fWA7XG5cbiAgICBjb25zdCBtcmFwRGlhbFByaW1hcnkgPSBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgbmFtZXNwYWNlOiBjdXN0b21OYW1lc3BhY2UsXG4gICAgICBtZXRyaWNOYW1lOiAnTXJhcFRyYWZmaWNEaWFsJyxcbiAgICAgIGRpbWVuc2lvbnNNYXA6IHsgUmVnaW9uOiBwcm9wcy5wcmltYXJ5UmVnaW9uIH0sXG4gICAgICBzdGF0aXN0aWM6ICdBdmVyYWdlJyxcbiAgICAgIHBlcmlvZDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBtcmFwRGlhbFNlY29uZGFyeSA9IG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICBuYW1lc3BhY2U6IGN1c3RvbU5hbWVzcGFjZSxcbiAgICAgIG1ldHJpY05hbWU6ICdNcmFwVHJhZmZpY0RpYWwnLFxuICAgICAgZGltZW5zaW9uc01hcDogeyBSZWdpb246IHByb3BzLnNlY29uZGFyeVJlZ2lvbiB9LFxuICAgICAgc3RhdGlzdGljOiAnQXZlcmFnZScsXG4gICAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5taW51dGVzKDEpLFxuICAgIH0pO1xuXG4gICAgLy8gRGFzaGJvYXJkXG4gICAgbmV3IGNsb3Vkd2F0Y2guRGFzaGJvYXJkKHRoaXMsICdEYXNoYm9hcmQnLCB7XG4gICAgICBkYXNoYm9hcmROYW1lOiBgJHtwcm9wcy5wcm9qZWN0fS1yZXBsaWNhdGlvbi0ke3Byb3BzLnNvdXJjZVJlZ2lvbkxhYmVsfS10by0ke3Byb3BzLmRlc3RSZWdpb25MYWJlbH1gLFxuICAgICAgd2lkZ2V0czogW1xuICAgICAgICBbXG4gICAgICAgICAgbmV3IGNsb3Vkd2F0Y2guU2luZ2xlVmFsdWVXaWRnZXQoe1xuICAgICAgICAgICAgdGl0bGU6ICdNUkFQIFRyYWZmaWMgRGlhbCAoJSknLFxuICAgICAgICAgICAgbWV0cmljczogW21yYXBEaWFsUHJpbWFyeSwgbXJhcERpYWxTZWNvbmRhcnldLFxuICAgICAgICAgICAgd2lkdGg6IDI0LFxuICAgICAgICAgIH0pLFxuICAgICAgICBdLFxuICAgICAgICBbXG4gICAgICAgICAgbmV3IGNsb3Vkd2F0Y2guR3JhcGhXaWRnZXQoe1xuICAgICAgICAgICAgdGl0bGU6IGBSZXBsaWNhdGlvbiBMYXRlbmN5ICgke3Byb3BzLnNvdXJjZVJlZ2lvbkxhYmVsfSDihpIgJHtwcm9wcy5kZXN0UmVnaW9uTGFiZWx9KWAsXG4gICAgICAgICAgICBsZWZ0OiBbcmVwbGljYXRpb25MYXRlbmN5XSxcbiAgICAgICAgICAgIHdpZHRoOiAxMixcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBuZXcgY2xvdWR3YXRjaC5HcmFwaFdpZGdldCh7XG4gICAgICAgICAgICB0aXRsZTogYEJ5dGVzIFBlbmRpbmcgUmVwbGljYXRpb25gLFxuICAgICAgICAgICAgbGVmdDogW2J5dGVzUGVuZGluZ10sXG4gICAgICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICAgIFtcbiAgICAgICAgICBuZXcgY2xvdWR3YXRjaC5HcmFwaFdpZGdldCh7XG4gICAgICAgICAgICB0aXRsZTogYFJlcGxpY2F0aW9uIE9wZXJhdGlvbnNgLFxuICAgICAgICAgICAgbGVmdDogW29wc1BlbmRpbmddLFxuICAgICAgICAgICAgcmlnaHQ6IFtvcHNGYWlsZWRdLFxuICAgICAgICAgICAgd2lkdGg6IDI0LFxuICAgICAgICAgIH0pLFxuICAgICAgICBdLFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIC8vIE1SQVAgTW9uaXRvciBMYW1iZGEg4oCUIHB1Ymxpc2hlcyB0cmFmZmljIGRpYWwgbWV0cmljIHRvIHRoaXMgcmVnaW9uXG4gICAgY29uc3QgbW9uaXRvckZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnTXJhcE1vbml0b3JGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogYCR7cHJvcHMucHJvamVjdH0tbXJhcC1tb25pdG9yLSR7cHJvcHMuZGVzdFJlZ2lvbkxhYmVsfWAsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4nLCAnbGFtYmRhJywgJ21yYXAtbW9uaXRvcicpKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIEFDQ09VTlRfSUQ6IHByb3BzLmFjY291bnRJZCxcbiAgICAgICAgTVJBUF9BTElBUzogcHJvcHMubXJhcEFsaWFzLFxuICAgICAgICBNRVRSSUNfTkFNRVNQQUNFOiBwcm9wcy5wcm9qZWN0LFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIG1vbml0b3JGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydzMzpHZXRNdWx0aVJlZ2lvbkFjY2Vzc1BvaW50Um91dGVzJ10sXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpzMzo6JHtwcm9wcy5hY2NvdW50SWR9OmFjY2Vzc3BvaW50LypgXSxcbiAgICB9KSk7XG5cbiAgICBtb25pdG9yRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnY2xvdWR3YXRjaDpQdXRNZXRyaWNEYXRhJ10sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgY29uZGl0aW9uczogeyBTdHJpbmdFcXVhbHM6IHsgJ2Nsb3Vkd2F0Y2g6bmFtZXNwYWNlJzogcHJvcHMucHJvamVjdCB9IH0sXG4gICAgfSkpO1xuXG4gICAgbmV3IGV2ZW50cy5SdWxlKHRoaXMsICdNcmFwTW9uaXRvclNjaGVkdWxlJywge1xuICAgICAgc2NoZWR1bGU6IGV2ZW50cy5TY2hlZHVsZS5yYXRlKGNkay5EdXJhdGlvbi5taW51dGVzKDEpKSxcbiAgICAgIHRhcmdldHM6IFtuZXcgdGFyZ2V0cy5MYW1iZGFGdW5jdGlvbihtb25pdG9yRm4pXSxcbiAgICB9KTtcbiAgfVxufVxuIl19