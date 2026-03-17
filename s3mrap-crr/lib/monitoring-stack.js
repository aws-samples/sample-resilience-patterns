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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvcmluZy1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1vbml0b3Jpbmctc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLHVFQUF5RDtBQUN6RCwrRUFBaUU7QUFDakUseURBQTJDO0FBQzNDLCtEQUFpRDtBQUNqRCx5REFBMkM7QUFDM0MseURBQTJDO0FBQzNDLCtEQUFpRDtBQUNqRCx3RUFBMEQ7QUFDMUQsMkNBQTZCO0FBbUI3QixNQUFhLGVBQWdCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDNUMsWUFBWSxLQUFjLEVBQUUsRUFBVSxFQUFFLEtBQTJCO1FBQ2pFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLG9DQUFvQztRQUNwQyxNQUFNLFVBQVUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNuRCxTQUFTLEVBQUUsR0FBRyxLQUFLLENBQUMsT0FBTyx1QkFBdUIsS0FBSyxDQUFDLGVBQWUsRUFBRTtZQUN6RSxVQUFVLEVBQUUsSUFBSTtZQUNoQixTQUFTLEVBQUUsR0FBRyxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRSxLQUFLLENBQUMsZ0JBQWdCLENBQUM7U0FDdEUsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxlQUFlLEVBQUUsRUFBRSxLQUFLLEVBQUUsVUFBVSxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7UUFFekUsTUFBTSxVQUFVLEdBQUc7WUFDakIsWUFBWSxFQUFFLEtBQUssQ0FBQyxnQkFBZ0I7WUFDcEMsaUJBQWlCLEVBQUUsS0FBSyxDQUFDLGNBQWM7WUFDdkMsTUFBTSxFQUFFLEtBQUssQ0FBQyxpQkFBaUI7U0FDaEMsQ0FBQztR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QUFDO1lBQ2hELE9BQU8sRUFBRSxDQUFDLG9DQUFvQyxDQUFDO1lBQy9DLFNBQVMsRUFBRSxDQUFDLGVBQWUsS0FBSyxDQUFDLFNBQVMsZ0JBQWdCLENBQUM7U0FDNUQsQ0FBQyxDQUFDLENBQUM7UUFFSixTQUFTLENBQUMsZUFBZSxDQUFDLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUNoRCxPQUFPLEVBQUUsQ0FBQywwQkFBMEIsQ0FBQztZQUNyQyxTQUFTLEVBQUUsQ0FBQyxHQUFHLENBQUM7WUFDaEIsVUFBVSxFQUFFLEVBQUUsWUFBWSxFQUFFLEVBQUUsc0JBQXNCLEVBQUUsS0FBSyxDQUFDLE9BQU8sRUFBRSxFQUFFO1NBQ3hFLENBQUMsQ0FBQyxDQUFDO1FBRUosSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxxQkFBcUIsRUFBRTtZQUMzQyxRQUFRLEVBQUUsTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDdkQsT0FBTyxFQUFFLENBQUMsSUFBSSxPQUFPLENBQUMsY0FBYyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1NBQ2pELENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQXpMRCwwQ0F5TEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgY2xvdWR3YXRjaCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2xvdWR3YXRjaCc7XG5pbXBvcnQgKiBhcyBjd19hY3Rpb25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoLWFjdGlvbnMnO1xuaW1wb3J0ICogYXMgc25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zbnMnO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMga21zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1rbXMnO1xuaW1wb3J0ICogYXMgZXZlbnRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1ldmVudHMnO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZXZlbnRzLXRhcmdldHMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcblxuZXhwb3J0IGludGVyZmFjZSBNb25pdG9yaW5nU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgcmVhZG9ubHkgcHJvamVjdDogc3RyaW5nO1xuICByZWFkb25seSBzb3VyY2VCdWNrZXROYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRlc3RCdWNrZXROYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJlcGxpY2F0aW9uUnVsZUlkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHNvdXJjZVJlZ2lvbkxhYmVsOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRlc3RSZWdpb25MYWJlbDogc3RyaW5nO1xuICByZWFkb25seSByZXZlcnNlUnVsZUlkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJldmVyc2VTb3VyY2VCdWNrZXROYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJldmVyc2VEZXN0QnVja2V0TmFtZTogc3RyaW5nO1xuICByZWFkb25seSBwcmltYXJ5UmVnaW9uOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHNlY29uZGFyeVJlZ2lvbjogc3RyaW5nO1xuICByZWFkb25seSBhY2NvdW50SWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgbXJhcEFsaWFzOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGVuY3J5cHRpb25LZXlBcm46IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIE1vbml0b3JpbmdTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBjZGsuQXBwLCBpZDogc3RyaW5nLCBwcm9wczogTW9uaXRvcmluZ1N0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIFNOUyB0b3BpYyBmb3IgYWxhcm0gbm90aWZpY2F0aW9uc1xuICAgIGNvbnN0IGFsYXJtVG9waWMgPSBuZXcgc25zLlRvcGljKHRoaXMsICdBbGFybVRvcGljJywge1xuICAgICAgdG9waWNOYW1lOiBgJHtwcm9wcy5wcm9qZWN0fS1yZXBsaWNhdGlvbi1hbGFybXMtJHtwcm9wcy5kZXN0UmVnaW9uTGFiZWx9YCxcbiAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICBtYXN0ZXJLZXk6IGttcy5LZXkuZnJvbUtleUFybih0aGlzLCAnU25zS2V5JywgcHJvcHMuZW5jcnlwdGlvbktleUFybiksXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWxhcm1Ub3BpY0FybicsIHsgdmFsdWU6IGFsYXJtVG9waWMudG9waWNBcm4gfSk7XG5cbiAgICBjb25zdCBkaW1lbnNpb25zID0ge1xuICAgICAgU291cmNlQnVja2V0OiBwcm9wcy5zb3VyY2VCdWNrZXROYW1lLFxuICAgICAgRGVzdGluYXRpb25CdWNrZXQ6IHByb3BzLmRlc3RCdWNrZXROYW1lLFxuICAgICAgUnVsZUlkOiBwcm9wcy5yZXBsaWNhdGlvblJ1bGVJZCxcbiAgICB9O1xuXG4gICAgY29uc3QgcmVwbGljYXRpb25MYXRlbmN5ID0gbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgIG5hbWVzcGFjZTogJ0FXUy9TMycsXG4gICAgICBtZXRyaWNOYW1lOiAnUmVwbGljYXRpb25MYXRlbmN5JyxcbiAgICAgIGRpbWVuc2lvbnNNYXA6IGRpbWVuc2lvbnMsXG4gICAgICBzdGF0aXN0aWM6ICdNYXhpbXVtJyxcbiAgICAgIHBlcmlvZDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBieXRlc1BlbmRpbmcgPSBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgbmFtZXNwYWNlOiAnQVdTL1MzJyxcbiAgICAgIG1ldHJpY05hbWU6ICdCeXRlc1BlbmRpbmdSZXBsaWNhdGlvbicsXG4gICAgICBkaW1lbnNpb25zTWFwOiBkaW1lbnNpb25zLFxuICAgICAgc3RhdGlzdGljOiAnTWF4aW11bScsXG4gICAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5taW51dGVzKDEpLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgb3BzUGVuZGluZyA9IG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICBuYW1lc3BhY2U6ICdBV1MvUzMnLFxuICAgICAgbWV0cmljTmFtZTogJ09wZXJhdGlvbnNQZW5kaW5nUmVwbGljYXRpb24nLFxuICAgICAgZGltZW5zaW9uc01hcDogZGltZW5zaW9ucyxcbiAgICAgIHN0YXRpc3RpYzogJ01heGltdW0nLFxuICAgICAgcGVyaW9kOiBjZGsuRHVyYXRpb24ubWludXRlcygxKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IG9wc0ZhaWxlZCA9IG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICBuYW1lc3BhY2U6ICdBV1MvUzMnLFxuICAgICAgbWV0cmljTmFtZTogJ09wZXJhdGlvbnNGYWlsZWRSZXBsaWNhdGlvbicsXG4gICAgICBkaW1lbnNpb25zTWFwOiB7XG4gICAgICAgIFNvdXJjZUJ1Y2tldDogcHJvcHMucmV2ZXJzZVNvdXJjZUJ1Y2tldE5hbWUsXG4gICAgICAgIERlc3RpbmF0aW9uQnVja2V0OiBwcm9wcy5yZXZlcnNlRGVzdEJ1Y2tldE5hbWUsXG4gICAgICAgIFJ1bGVJZDogcHJvcHMucmV2ZXJzZVJ1bGVJZCxcbiAgICAgIH0sXG4gICAgICBzdGF0aXN0aWM6ICdTdW0nLFxuICAgICAgcGVyaW9kOiBjZGsuRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICB9KTtcblxuICAgIC8vIEFsYXJtcyDigJQgYWxsIG5vdGlmeSB2aWEgU05TXG4gICAgY29uc3Qgc25zQWN0aW9uID0gbmV3IGN3X2FjdGlvbnMuU25zQWN0aW9uKGFsYXJtVG9waWMpO1xuXG4gICAgY29uc3QgbGF0ZW5jeUFsYXJtID0gbmV3IGNsb3Vkd2F0Y2guQWxhcm0odGhpcywgJ1JlcGxpY2F0aW9uTGF0ZW5jeUFsYXJtJywge1xuICAgICAgYWxhcm1OYW1lOiBgJHtwcm9wcy5wcm9qZWN0fS1yZXBsLWxhdGVuY3ktJHtwcm9wcy5zb3VyY2VSZWdpb25MYWJlbH0tdG8tJHtwcm9wcy5kZXN0UmVnaW9uTGFiZWx9YCxcbiAgICAgIG1ldHJpYzogcmVwbGljYXRpb25MYXRlbmN5LFxuICAgICAgdGhyZXNob2xkOiA5MDAsXG4gICAgICBldmFsdWF0aW9uUGVyaW9kczogMyxcbiAgICAgIHRyZWF0TWlzc2luZ0RhdGE6IGNsb3Vkd2F0Y2guVHJlYXRNaXNzaW5nRGF0YS5JR05PUkUsXG4gICAgICBjb21wYXJpc29uT3BlcmF0b3I6IGNsb3Vkd2F0Y2guQ29tcGFyaXNvbk9wZXJhdG9yLkdSRUFURVJfVEhBTl9USFJFU0hPTEQsXG4gICAgfSk7XG4gICAgbGF0ZW5jeUFsYXJtLmFkZEFsYXJtQWN0aW9uKHNuc0FjdGlvbik7XG4gICAgbGF0ZW5jeUFsYXJtLmFkZE9rQWN0aW9uKHNuc0FjdGlvbik7XG5cbiAgICBjb25zdCBieXRlc1BlbmRpbmdBbGFybSA9IG5ldyBjbG91ZHdhdGNoLkFsYXJtKHRoaXMsICdCeXRlc1BlbmRpbmdBbGFybScsIHtcbiAgICAgIGFsYXJtTmFtZTogYCR7cHJvcHMucHJvamVjdH0tYnl0ZXMtcGVuZGluZy0ke3Byb3BzLnNvdXJjZVJlZ2lvbkxhYmVsfS10by0ke3Byb3BzLmRlc3RSZWdpb25MYWJlbH1gLFxuICAgICAgbWV0cmljOiBieXRlc1BlbmRpbmcsXG4gICAgICB0aHJlc2hvbGQ6IDFfMDAwXzAwMF8wMDAsXG4gICAgICBldmFsdWF0aW9uUGVyaW9kczogMyxcbiAgICAgIHRyZWF0TWlzc2luZ0RhdGE6IGNsb3Vkd2F0Y2guVHJlYXRNaXNzaW5nRGF0YS5JR05PUkUsXG4gICAgICBjb21wYXJpc29uT3BlcmF0b3I6IGNsb3Vkd2F0Y2guQ29tcGFyaXNvbk9wZXJhdG9yLkdSRUFURVJfVEhBTl9USFJFU0hPTEQsXG4gICAgfSk7XG4gICAgYnl0ZXNQZW5kaW5nQWxhcm0uYWRkQWxhcm1BY3Rpb24oc25zQWN0aW9uKTtcbiAgICBieXRlc1BlbmRpbmdBbGFybS5hZGRPa0FjdGlvbihzbnNBY3Rpb24pO1xuXG4gICAgY29uc3Qgb3BzRmFpbGVkQWxhcm0gPSBuZXcgY2xvdWR3YXRjaC5BbGFybSh0aGlzLCAnT3BzRmFpbGVkQWxhcm0nLCB7XG4gICAgICBhbGFybU5hbWU6IGAke3Byb3BzLnByb2plY3R9LW9wcy1mYWlsZWQtJHtwcm9wcy5zb3VyY2VSZWdpb25MYWJlbH0tdG8tJHtwcm9wcy5kZXN0UmVnaW9uTGFiZWx9YCxcbiAgICAgIG1ldHJpYzogb3BzRmFpbGVkLFxuICAgICAgdGhyZXNob2xkOiAxLFxuICAgICAgZXZhbHVhdGlvblBlcmlvZHM6IDEsXG4gICAgICB0cmVhdE1pc3NpbmdEYXRhOiBjbG91ZHdhdGNoLlRyZWF0TWlzc2luZ0RhdGEuSUdOT1JFLFxuICAgICAgY29tcGFyaXNvbk9wZXJhdG9yOiBjbG91ZHdhdGNoLkNvbXBhcmlzb25PcGVyYXRvci5HUkVBVEVSX1RIQU5fT1JfRVFVQUxfVE9fVEhSRVNIT0xELFxuICAgIH0pO1xuICAgIG9wc0ZhaWxlZEFsYXJtLmFkZEFsYXJtQWN0aW9uKHNuc0FjdGlvbik7XG4gICAgb3BzRmFpbGVkQWxhcm0uYWRkT2tBY3Rpb24oc25zQWN0aW9uKTtcblxuICAgIGNvbnN0IG9wc1BlbmRpbmdBbGFybSA9IG5ldyBjbG91ZHdhdGNoLkFsYXJtKHRoaXMsICdPcHNQZW5kaW5nQWxhcm0nLCB7XG4gICAgICBhbGFybU5hbWU6IGAke3Byb3BzLnByb2plY3R9LW9wcy1wZW5kaW5nLSR7cHJvcHMuc291cmNlUmVnaW9uTGFiZWx9LXRvLSR7cHJvcHMuZGVzdFJlZ2lvbkxhYmVsfWAsXG4gICAgICBtZXRyaWM6IG9wc1BlbmRpbmcsXG4gICAgICB0aHJlc2hvbGQ6IDEwMDAsXG4gICAgICBldmFsdWF0aW9uUGVyaW9kczogMyxcbiAgICAgIHRyZWF0TWlzc2luZ0RhdGE6IGNsb3Vkd2F0Y2guVHJlYXRNaXNzaW5nRGF0YS5JR05PUkUsXG4gICAgICBjb21wYXJpc29uT3BlcmF0b3I6IGNsb3Vkd2F0Y2guQ29tcGFyaXNvbk9wZXJhdG9yLkdSRUFURVJfVEhBTl9USFJFU0hPTEQsXG4gICAgfSk7XG4gICAgb3BzUGVuZGluZ0FsYXJtLmFkZEFsYXJtQWN0aW9uKHNuc0FjdGlvbik7XG4gICAgb3BzUGVuZGluZ0FsYXJtLmFkZE9rQWN0aW9uKHNuc0FjdGlvbik7XG5cbiAgICBjb25zdCBjdXN0b21OYW1lc3BhY2UgPSBgJHtwcm9wcy5wcm9qZWN0fWA7XG5cbiAgICBjb25zdCBtcmFwRGlhbFByaW1hcnkgPSBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgbmFtZXNwYWNlOiBjdXN0b21OYW1lc3BhY2UsXG4gICAgICBtZXRyaWNOYW1lOiAnTXJhcFRyYWZmaWNEaWFsJyxcbiAgICAgIGRpbWVuc2lvbnNNYXA6IHsgUmVnaW9uOiBwcm9wcy5wcmltYXJ5UmVnaW9uIH0sXG4gICAgICBzdGF0aXN0aWM6ICdBdmVyYWdlJyxcbiAgICAgIHBlcmlvZDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBtcmFwRGlhbFNlY29uZGFyeSA9IG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICBuYW1lc3BhY2U6IGN1c3RvbU5hbWVzcGFjZSxcbiAgICAgIG1ldHJpY05hbWU6ICdNcmFwVHJhZmZpY0RpYWwnLFxuICAgICAgZGltZW5zaW9uc01hcDogeyBSZWdpb246IHByb3BzLnNlY29uZGFyeVJlZ2lvbiB9LFxuICAgICAgc3RhdGlzdGljOiAnQXZlcmFnZScsXG4gICAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5taW51dGVzKDEpLFxuICAgIH0pO1xuXG4gICAgLy8gRGFzaGJvYXJkXG4gICAgbmV3IGNsb3Vkd2F0Y2guRGFzaGJvYXJkKHRoaXMsICdEYXNoYm9hcmQnLCB7XG4gICAgICBkYXNoYm9hcmROYW1lOiBgJHtwcm9wcy5wcm9qZWN0fS1yZXBsaWNhdGlvbi0ke3Byb3BzLnNvdXJjZVJlZ2lvbkxhYmVsfS10by0ke3Byb3BzLmRlc3RSZWdpb25MYWJlbH1gLFxuICAgICAgd2lkZ2V0czogW1xuICAgICAgICBbXG4gICAgICAgICAgbmV3IGNsb3Vkd2F0Y2guU2luZ2xlVmFsdWVXaWRnZXQoe1xuICAgICAgICAgICAgdGl0bGU6ICdNUkFQIFRyYWZmaWMgRGlhbCAoJSknLFxuICAgICAgICAgICAgbWV0cmljczogW21yYXBEaWFsUHJpbWFyeSwgbXJhcERpYWxTZWNvbmRhcnldLFxuICAgICAgICAgICAgd2lkdGg6IDI0LFxuICAgICAgICAgIH0pLFxuICAgICAgICBdLFxuICAgICAgICBbXG4gICAgICAgICAgbmV3IGNsb3Vkd2F0Y2guR3JhcGhXaWRnZXQoe1xuICAgICAgICAgICAgdGl0bGU6IGBSZXBsaWNhdGlvbiBMYXRlbmN5ICgke3Byb3BzLnNvdXJjZVJlZ2lvbkxhYmVsfSDihpIgJHtwcm9wcy5kZXN0UmVnaW9uTGFiZWx9KWAsXG4gICAgICAgICAgICBsZWZ0OiBbcmVwbGljYXRpb25MYXRlbmN5XSxcbiAgICAgICAgICAgIHdpZHRoOiAxMixcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBuZXcgY2xvdWR3YXRjaC5HcmFwaFdpZGdldCh7XG4gICAgICAgICAgICB0aXRsZTogYEJ5dGVzIFBlbmRpbmcgUmVwbGljYXRpb25gLFxuICAgICAgICAgICAgbGVmdDogW2J5dGVzUGVuZGluZ10sXG4gICAgICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICAgIFtcbiAgICAgICAgICBuZXcgY2xvdWR3YXRjaC5HcmFwaFdpZGdldCh7XG4gICAgICAgICAgICB0aXRsZTogYFJlcGxpY2F0aW9uIE9wZXJhdGlvbnNgLFxuICAgICAgICAgICAgbGVmdDogW29wc1BlbmRpbmddLFxuICAgICAgICAgICAgcmlnaHQ6IFtvcHNGYWlsZWRdLFxuICAgICAgICAgICAgd2lkdGg6IDI0LFxuICAgICAgICAgIH0pLFxuICAgICAgICBdLFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIC8vIE1SQVAgTW9uaXRvciBMYW1iZGEg4oCUIHB1Ymxpc2hlcyB0cmFmZmljIGRpYWwgbWV0cmljIHRvIHRoaXMgcmVnaW9uXG4gICAgY29uc3QgbW9uaXRvckZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnTXJhcE1vbml0b3JGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogYCR7cHJvcHMucHJvamVjdH0tbXJhcC1tb25pdG9yLSR7cHJvcHMuZGVzdFJlZ2lvbkxhYmVsfWAsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4nLCAnbGFtYmRhJywgJ21yYXAtbW9uaXRvcicpKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIHJlc2VydmVkQ29uY3VycmVudEV4ZWN1dGlvbnM6IDUsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBBQ0NPVU5UX0lEOiBwcm9wcy5hY2NvdW50SWQsXG4gICAgICAgIE1SQVBfQUxJQVM6IHByb3BzLm1yYXBBbGlhcyxcbiAgICAgICAgTUVUUklDX05BTUVTUEFDRTogcHJvcHMucHJvamVjdCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBtb25pdG9yRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnczM6R2V0TXVsdGlSZWdpb25BY2Nlc3NQb2ludFJvdXRlcyddLFxuICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6czM6OiR7cHJvcHMuYWNjb3VudElkfTphY2Nlc3Nwb2ludC8qYF0sXG4gICAgfSkpO1xuXG4gICAgbW9uaXRvckZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ2Nsb3Vkd2F0Y2g6UHV0TWV0cmljRGF0YSddLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgIGNvbmRpdGlvbnM6IHsgU3RyaW5nRXF1YWxzOiB7ICdjbG91ZHdhdGNoOm5hbWVzcGFjZSc6IHByb3BzLnByb2plY3QgfSB9LFxuICAgIH0pKTtcblxuICAgIG5ldyBldmVudHMuUnVsZSh0aGlzLCAnTXJhcE1vbml0b3JTY2hlZHVsZScsIHtcbiAgICAgIHNjaGVkdWxlOiBldmVudHMuU2NoZWR1bGUucmF0ZShjZGsuRHVyYXRpb24ubWludXRlcygxKSksXG4gICAgICB0YXJnZXRzOiBbbmV3IHRhcmdldHMuTGFtYmRhRnVuY3Rpb24obW9uaXRvckZuKV0sXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==