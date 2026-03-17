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
const kms = __importStar(require("aws-cdk-lib/aws-kms"));
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
            masterKey: kms.Alias.fromAliasName(this, 'SnsKey', 'alias/aws/sns'),
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
    }
}
exports.MonitoringStack = MonitoringStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvcmluZy1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1vbml0b3Jpbmctc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLHVFQUF5RDtBQUN6RCwrRUFBaUU7QUFDakUseURBQTJDO0FBQzNDLCtEQUFpRDtBQUNqRCx5REFBMkM7QUFDM0MseURBQTJDO0FBQzNDLCtEQUFpRDtBQUNqRCx3RUFBMEQ7QUFDMUQsMkNBQTZCO0FBa0I3QixNQUFhLGVBQWdCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDNUMsWUFBWSxLQUFjLEVBQUUsRUFBVSxFQUFFLEtBQTJCO1FBQ2pFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLG9DQUFvQztRQUNwQyxNQUFNLFVBQVUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNuRCxTQUFTLEVBQUUsR0FBRyxLQUFLLENBQUMsT0FBTyx1QkFBdUIsS0FBSyxDQUFDLGVBQWUsRUFBRTtZQUN6RSxVQUFVLEVBQUUsSUFBSTtZQUNoQixTQUFTLEVBQUUsR0FBRyxDQUFDLEtBQUssQ0FBQyxhQUFhLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRSxlQUFlLENBQUM7U0FDcEUsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxlQUFlLEVBQUUsRUFBRSxLQUFLLEVBQUUsVUFBVSxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7UUFFekUsTUFBTSxVQUFVLEdBQUc7WUFDakIsWUFBWSxFQUFFLEtBQUssQ0FBQyxnQkFBZ0I7WUFDcEMsaUJBQWlCLEVBQUUsS0FBSyxDQUFDLGNBQWM7WUFDdkMsTUFBTSxFQUFFLEtBQUssQ0FBQyxpQkFBaUI7U0FDaEMsQ0FBQztRQUVGLE1BQU0sa0JB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QU8sRUFBRSxDQUFDLG9DQUFvQyxDQUFDO1lBQy9DLFNBQVMsRUFBRSxDQUFDLGVBQWUsS0FBSyxDQUFDLFNBQVMsZ0JBQWdCLENBQUM7U0FDNUQsQ0FBQyxDQUFDLENBQUM7UUFFSixTQUFTLENBQUMsZUFBZSxDQUFDLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUNoRCxPQUFPLEVBQUUsQ0FBQywwQkFBMEIsQ0FBQztZQUNyQyxTQUFTLEVBQUUsQ0FBQyxHQUFHLENBQUM7WUFDaEIsVUFBVSxFQUFFLEVBQUUsWUFBWSxFQUFFLEVBQUUsc0JBQXNCLEVBQUUsS0FBSyxDQUFDLE9BQU8sRUFBRSxFQUFFO1NBQ3hFLENBQUMsQ0FBQyxDQUFDO1FBRUosSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxxQkFBcUIsRUFBRTtZQUMzQyxRQUFRLEVBQUUsTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDdkQsT0FBTyxFQUFFLENBQUMsSUFBSSxPQUFPLENBQUMsY0FBYyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1NBQ2pELENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQXpMRCwwQ0F5TEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgY2xvdWR3YXRjaCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2xvdWR3YXRjaCc7XG5pbXBvcnQgKiBhcyBjd19hY3Rpb25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoLWFjdGlvbnMnO1xuaW1wb3J0ICogYXMgc25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zbnMnO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMga21zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1rbXMnO1xuaW1wb3J0ICogYXMgZXZlbnRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1ldmVudHMnO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZXZlbnRzLXRhcmdldHMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcblxuZXhwb3J0IGludGVyZmFjZSBNb25pdG9yaW5nU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgcmVhZG9ubHkgcHJvamVjdDogc3RyaW5nO1xuICByZWFkb25seSBzb3VyY2VCdWNrZXROYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRlc3RCdWNrZXROYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJlcGxpY2F0aW9uUnVsZUlkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHNvdXJjZVJlZ2lvbkxhYmVsOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRlc3RSZWdpb25MYWJlbDogc3RyaW5nO1xuICByZWFkb25seSByZXZlcnNlUnVsZUlkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJldmVyc2VTb3VyY2VCdWNrZXROYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJldmVyc2VEZXN0QnVja2V0TmFtZTogc3RyaW5nO1xuICByZWFkb25seSBwcmltYXJ5UmVnaW9uOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHNlY29uZGFyeVJlZ2lvbjogc3RyaW5nO1xuICByZWFkb25seSBhY2NvdW50SWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgbXJhcEFsaWFzOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBNb25pdG9yaW5nU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogY2RrLkFwcCwgaWQ6IHN0cmluZywgcHJvcHM6IE1vbml0b3JpbmdTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyBTTlMgdG9waWMgZm9yIGFsYXJtIG5vdGlmaWNhdGlvbnNcbiAgICBjb25zdCBhbGFybVRvcGljID0gbmV3IHNucy5Ub3BpYyh0aGlzLCAnQWxhcm1Ub3BpYycsIHtcbiAgICAgIHRvcGljTmFtZTogYCR7cHJvcHMucHJvamVjdH0tcmVwbGljYXRpb24tYWxhcm1zLSR7cHJvcHMuZGVzdFJlZ2lvbkxhYmVsfWAsXG4gICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgbWFzdGVyS2V5OiBrbXMuQWxpYXMuZnJvbUFsaWFzTmFtZSh0aGlzLCAnU25zS2V5JywgJ2FsaWFzL2F3cy9zbnMnKSxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBbGFybVRvcGljQXJuJywgeyB2YWx1ZTogYWxhcm1Ub3BpYy50b3BpY0FybiB9KTtcblxuICAgIGNvbnN0IGRpbWVuc2lvbnMgPSB7XG4gICAgICBTb3VyY2VCdWNrZXQ6IHByb3BzLnNvdXJjZUJ1Y2tldE5hbWUsXG4gICAgICBEZXN0aW5hdGlvbkJ1Y2tldDogcHJvcHMuZGVzdEJ1Y2tldE5hbWUsXG4gICAgICBSdWxlSWQ6IHByb3BzLnJlcGxpY2F0aW9uUnVsZUlkLFxuICAgIH07XG5cbiAgICBjb25zdCByZXBsaWNhdGlvbkxhdGVuY3kgPSBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgbmFtZXNwYWNlOiAnQVdTL1MzJyxcbiAgICAgIG1ldHJpY05hbWU6ICdSZXBsaWNhdGlvbkxhdGVuY3knLFxuICAgICAgZGltZW5zaW9uc01hcDogZGltZW5zaW9ucyxcbiAgICAgIHN0YXRpc3RpYzogJ01heGltdW0nLFxuICAgICAgcGVyaW9kOiBjZGsuRHVyYXRpb24ubWludXRlcygxKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGJ5dGVzUGVuZGluZyA9IG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICBuYW1lc3BhY2U6ICdBV1MvUzMnLFxuICAgICAgbWV0cmljTmFtZTogJ0J5dGVzUGVuZGluZ1JlcGxpY2F0aW9uJyxcbiAgICAgIGRpbWVuc2lvbnNNYXA6IGRpbWVuc2lvbnMsXG4gICAgICBzdGF0aXN0aWM6ICdNYXhpbXVtJyxcbiAgICAgIHBlcmlvZDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBvcHNQZW5kaW5nID0gbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgIG5hbWVzcGFjZTogJ0FXUy9TMycsXG4gICAgICBtZXRyaWNOYW1lOiAnT3BlcmF0aW9uc1BlbmRpbmdSZXBsaWNhdGlvbicsXG4gICAgICBkaW1lbnNpb25zTWFwOiBkaW1lbnNpb25zLFxuICAgICAgc3RhdGlzdGljOiAnTWF4aW11bScsXG4gICAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5taW51dGVzKDEpLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgb3BzRmFpbGVkID0gbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgIG5hbWVzcGFjZTogJ0FXUy9TMycsXG4gICAgICBtZXRyaWNOYW1lOiAnT3BlcmF0aW9uc0ZhaWxlZFJlcGxpY2F0aW9uJyxcbiAgICAgIGRpbWVuc2lvbnNNYXA6IHtcbiAgICAgICAgU291cmNlQnVja2V0OiBwcm9wcy5yZXZlcnNlU291cmNlQnVja2V0TmFtZSxcbiAgICAgICAgRGVzdGluYXRpb25CdWNrZXQ6IHByb3BzLnJldmVyc2VEZXN0QnVja2V0TmFtZSxcbiAgICAgICAgUnVsZUlkOiBwcm9wcy5yZXZlcnNlUnVsZUlkLFxuICAgICAgfSxcbiAgICAgIHN0YXRpc3RpYzogJ1N1bScsXG4gICAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgIH0pO1xuXG4gICAgLy8gQWxhcm1zIOKAlCBhbGwgbm90aWZ5IHZpYSBTTlNcbiAgICBjb25zdCBzbnNBY3Rpb24gPSBuZXcgY3dfYWN0aW9ucy5TbnNBY3Rpb24oYWxhcm1Ub3BpYyk7XG5cbiAgICBjb25zdCBsYXRlbmN5QWxhcm0gPSBuZXcgY2xvdWR3YXRjaC5BbGFybSh0aGlzLCAnUmVwbGljYXRpb25MYXRlbmN5QWxhcm0nLCB7XG4gICAgICBhbGFybU5hbWU6IGAke3Byb3BzLnByb2plY3R9LXJlcGwtbGF0ZW5jeS0ke3Byb3BzLnNvdXJjZVJlZ2lvbkxhYmVsfS10by0ke3Byb3BzLmRlc3RSZWdpb25MYWJlbH1gLFxuICAgICAgbWV0cmljOiByZXBsaWNhdGlvbkxhdGVuY3ksXG4gICAgICB0aHJlc2hvbGQ6IDkwMCxcbiAgICAgIGV2YWx1YXRpb25QZXJpb2RzOiAzLFxuICAgICAgdHJlYXRNaXNzaW5nRGF0YTogY2xvdWR3YXRjaC5UcmVhdE1pc3NpbmdEYXRhLklHTk9SRSxcbiAgICAgIGNvbXBhcmlzb25PcGVyYXRvcjogY2xvdWR3YXRjaC5Db21wYXJpc29uT3BlcmF0b3IuR1JFQVRFUl9USEFOX1RIUkVTSE9MRCxcbiAgICB9KTtcbiAgICBsYXRlbmN5QWxhcm0uYWRkQWxhcm1BY3Rpb24oc25zQWN0aW9uKTtcbiAgICBsYXRlbmN5QWxhcm0uYWRkT2tBY3Rpb24oc25zQWN0aW9uKTtcblxuICAgIGNvbnN0IGJ5dGVzUGVuZGluZ0FsYXJtID0gbmV3IGNsb3Vkd2F0Y2guQWxhcm0odGhpcywgJ0J5dGVzUGVuZGluZ0FsYXJtJywge1xuICAgICAgYWxhcm1OYW1lOiBgJHtwcm9wcy5wcm9qZWN0fS1ieXRlcy1wZW5kaW5nLSR7cHJvcHMuc291cmNlUmVnaW9uTGFiZWx9LXRvLSR7cHJvcHMuZGVzdFJlZ2lvbkxhYmVsfWAsXG4gICAgICBtZXRyaWM6IGJ5dGVzUGVuZGluZyxcbiAgICAgIHRocmVzaG9sZDogMV8wMDBfMDAwXzAwMCxcbiAgICAgIGV2YWx1YXRpb25QZXJpb2RzOiAzLFxuICAgICAgdHJlYXRNaXNzaW5nRGF0YTogY2xvdWR3YXRjaC5UcmVhdE1pc3NpbmdEYXRhLklHTk9SRSxcbiAgICAgIGNvbXBhcmlzb25PcGVyYXRvcjogY2xvdWR3YXRjaC5Db21wYXJpc29uT3BlcmF0b3IuR1JFQVRFUl9USEFOX1RIUkVTSE9MRCxcbiAgICB9KTtcbiAgICBieXRlc1BlbmRpbmdBbGFybS5hZGRBbGFybUFjdGlvbihzbnNBY3Rpb24pO1xuICAgIGJ5dGVzUGVuZGluZ0FsYXJtLmFkZE9rQWN0aW9uKHNuc0FjdGlvbik7XG5cbiAgICBjb25zdCBvcHNGYWlsZWRBbGFybSA9IG5ldyBjbG91ZHdhdGNoLkFsYXJtKHRoaXMsICdPcHNGYWlsZWRBbGFybScsIHtcbiAgICAgIGFsYXJtTmFtZTogYCR7cHJvcHMucHJvamVjdH0tb3BzLWZhaWxlZC0ke3Byb3BzLnNvdXJjZVJlZ2lvbkxhYmVsfS10by0ke3Byb3BzLmRlc3RSZWdpb25MYWJlbH1gLFxuICAgICAgbWV0cmljOiBvcHNGYWlsZWQsXG4gICAgICB0aHJlc2hvbGQ6IDEsXG4gICAgICBldmFsdWF0aW9uUGVyaW9kczogMSxcbiAgICAgIHRyZWF0TWlzc2luZ0RhdGE6IGNsb3Vkd2F0Y2guVHJlYXRNaXNzaW5nRGF0YS5JR05PUkUsXG4gICAgICBjb21wYXJpc29uT3BlcmF0b3I6IGNsb3Vkd2F0Y2guQ29tcGFyaXNvbk9wZXJhdG9yLkdSRUFURVJfVEhBTl9PUl9FUVVBTF9UT19USFJFU0hPTEQsXG4gICAgfSk7XG4gICAgb3BzRmFpbGVkQWxhcm0uYWRkQWxhcm1BY3Rpb24oc25zQWN0aW9uKTtcbiAgICBvcHNGYWlsZWRBbGFybS5hZGRPa0FjdGlvbihzbnNBY3Rpb24pO1xuXG4gICAgY29uc3Qgb3BzUGVuZGluZ0FsYXJtID0gbmV3IGNsb3Vkd2F0Y2guQWxhcm0odGhpcywgJ09wc1BlbmRpbmdBbGFybScsIHtcbiAgICAgIGFsYXJtTmFtZTogYCR7cHJvcHMucHJvamVjdH0tb3BzLXBlbmRpbmctJHtwcm9wcy5zb3VyY2VSZWdpb25MYWJlbH0tdG8tJHtwcm9wcy5kZXN0UmVnaW9uTGFiZWx9YCxcbiAgICAgIG1ldHJpYzogb3BzUGVuZGluZyxcbiAgICAgIHRocmVzaG9sZDogMTAwMCxcbiAgICAgIGV2YWx1YXRpb25QZXJpb2RzOiAzLFxuICAgICAgdHJlYXRNaXNzaW5nRGF0YTogY2xvdWR3YXRjaC5UcmVhdE1pc3NpbmdEYXRhLklHTk9SRSxcbiAgICAgIGNvbXBhcmlzb25PcGVyYXRvcjogY2xvdWR3YXRjaC5Db21wYXJpc29uT3BlcmF0b3IuR1JFQVRFUl9USEFOX1RIUkVTSE9MRCxcbiAgICB9KTtcbiAgICBvcHNQZW5kaW5nQWxhcm0uYWRkQWxhcm1BY3Rpb24oc25zQWN0aW9uKTtcbiAgICBvcHNQZW5kaW5nQWxhcm0uYWRkT2tBY3Rpb24oc25zQWN0aW9uKTtcblxuICAgIGNvbnN0IGN1c3RvbU5hbWVzcGFjZSA9IGAke3Byb3BzLnByb2plY3R9YDtcblxuICAgIGNvbnN0IG1yYXBEaWFsUHJpbWFyeSA9IG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICBuYW1lc3BhY2U6IGN1c3RvbU5hbWVzcGFjZSxcbiAgICAgIG1ldHJpY05hbWU6ICdNcmFwVHJhZmZpY0RpYWwnLFxuICAgICAgZGltZW5zaW9uc01hcDogeyBSZWdpb246IHByb3BzLnByaW1hcnlSZWdpb24gfSxcbiAgICAgIHN0YXRpc3RpYzogJ0F2ZXJhZ2UnLFxuICAgICAgcGVyaW9kOiBjZGsuRHVyYXRpb24ubWludXRlcygxKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IG1yYXBEaWFsU2Vjb25kYXJ5ID0gbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgIG5hbWVzcGFjZTogY3VzdG9tTmFtZXNwYWNlLFxuICAgICAgbWV0cmljTmFtZTogJ01yYXBUcmFmZmljRGlhbCcsXG4gICAgICBkaW1lbnNpb25zTWFwOiB7IFJlZ2lvbjogcHJvcHMuc2Vjb25kYXJ5UmVnaW9uIH0sXG4gICAgICBzdGF0aXN0aWM6ICdBdmVyYWdlJyxcbiAgICAgIHBlcmlvZDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMSksXG4gICAgfSk7XG5cbiAgICAvLyBEYXNoYm9hcmRcbiAgICBuZXcgY2xvdWR3YXRjaC5EYXNoYm9hcmQodGhpcywgJ0Rhc2hib2FyZCcsIHtcbiAgICAgIGRhc2hib2FyZE5hbWU6IGAke3Byb3BzLnByb2plY3R9LXJlcGxpY2F0aW9uLSR7cHJvcHMuc291cmNlUmVnaW9uTGFiZWx9LXRvLSR7cHJvcHMuZGVzdFJlZ2lvbkxhYmVsfWAsXG4gICAgICB3aWRnZXRzOiBbXG4gICAgICAgIFtcbiAgICAgICAgICBuZXcgY2xvdWR3YXRjaC5TaW5nbGVWYWx1ZVdpZGdldCh7XG4gICAgICAgICAgICB0aXRsZTogJ01SQVAgVHJhZmZpYyBEaWFsICglKScsXG4gICAgICAgICAgICBtZXRyaWNzOiBbbXJhcERpYWxQcmltYXJ5LCBtcmFwRGlhbFNlY29uZGFyeV0sXG4gICAgICAgICAgICB3aWR0aDogMjQsXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICAgIFtcbiAgICAgICAgICBuZXcgY2xvdWR3YXRjaC5HcmFwaFdpZGdldCh7XG4gICAgICAgICAgICB0aXRsZTogYFJlcGxpY2F0aW9uIExhdGVuY3kgKCR7cHJvcHMuc291cmNlUmVnaW9uTGFiZWx9IOKGkiAke3Byb3BzLmRlc3RSZWdpb25MYWJlbH0pYCxcbiAgICAgICAgICAgIGxlZnQ6IFtyZXBsaWNhdGlvbkxhdGVuY3ldLFxuICAgICAgICAgICAgd2lkdGg6IDEyLFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIG5ldyBjbG91ZHdhdGNoLkdyYXBoV2lkZ2V0KHtcbiAgICAgICAgICAgIHRpdGxlOiBgQnl0ZXMgUGVuZGluZyBSZXBsaWNhdGlvbmAsXG4gICAgICAgICAgICBsZWZ0OiBbYnl0ZXNQZW5kaW5nXSxcbiAgICAgICAgICAgIHdpZHRoOiAxMixcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSxcbiAgICAgICAgW1xuICAgICAgICAgIG5ldyBjbG91ZHdhdGNoLkdyYXBoV2lkZ2V0KHtcbiAgICAgICAgICAgIHRpdGxlOiBgUmVwbGljYXRpb24gT3BlcmF0aW9uc2AsXG4gICAgICAgICAgICBsZWZ0OiBbb3BzUGVuZGluZ10sXG4gICAgICAgICAgICByaWdodDogW29wc0ZhaWxlZF0sXG4gICAgICAgICAgICB3aWR0aDogMjQsXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgLy8gTVJBUCBNb25pdG9yIExhbWJkYSDigJQgcHVibGlzaGVzIHRyYWZmaWMgZGlhbCBtZXRyaWMgdG8gdGhpcyByZWdpb25cbiAgICBjb25zdCBtb25pdG9yRm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdNcmFwTW9uaXRvckZ1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiBgJHtwcm9wcy5wcm9qZWN0fS1tcmFwLW1vbml0b3ItJHtwcm9wcy5kZXN0UmVnaW9uTGFiZWx9YCxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEyLFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICdsYW1iZGEnLCAnbXJhcC1tb25pdG9yJykpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgcmVzZXJ2ZWRDb25jdXJyZW50RXhlY3V0aW9uczogNSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIEFDQ09VTlRfSUQ6IHByb3BzLmFjY291bnRJZCxcbiAgICAgICAgTVJBUF9BTElBUzogcHJvcHMubXJhcEFsaWFzLFxuICAgICAgICBNRVRSSUNfTkFNRVNQQUNFOiBwcm9wcy5wcm9qZWN0LFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIG1vbml0b3JGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydzMzpHZXRNdWx0aVJlZ2lvbkFjY2Vzc1BvaW50Um91dGVzJ10sXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpzMzo6JHtwcm9wcy5hY2NvdW50SWR9OmFjY2Vzc3BvaW50LypgXSxcbiAgICB9KSk7XG5cbiAgICBtb25pdG9yRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnY2xvdWR3YXRjaDpQdXRNZXRyaWNEYXRhJ10sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgY29uZGl0aW9uczogeyBTdHJpbmdFcXVhbHM6IHsgJ2Nsb3Vkd2F0Y2g6bmFtZXNwYWNlJzogcHJvcHMucHJvamVjdCB9IH0sXG4gICAgfSkpO1xuXG4gICAgbmV3IGV2ZW50cy5SdWxlKHRoaXMsICdNcmFwTW9uaXRvclNjaGVkdWxlJywge1xuICAgICAgc2NoZWR1bGU6IGV2ZW50cy5TY2hlZHVsZS5yYXRlKGNkay5EdXJhdGlvbi5taW51dGVzKDEpKSxcbiAgICAgIHRhcmdldHM6IFtuZXcgdGFyZ2V0cy5MYW1iZGFGdW5jdGlvbihtb25pdG9yRm4pXSxcbiAgICB9KTtcbiAgfVxufVxuIl19