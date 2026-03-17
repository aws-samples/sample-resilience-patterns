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
const cdk = __importStar(require("aws-cdk-lib"));
const assertions_1 = require("aws-cdk-lib/assertions");
const monitoring_stack_1 = require("../lib/monitoring-stack");
const app = new cdk.App();
// Monitoring stack in us-east-1 shows pdx→iad replication (metrics published in destination region)
// OperationsFailedReplication uses reverse direction (published in source region)
const stack = new monitoring_stack_1.MonitoringStack(app, 'TestMonitoring', {
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
    encryptionKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/test-key-id',
    secondaryRegion: 'us-west-2',
    env: { account: '123456789012', region: 'us-east-1' },
});
const template = assertions_1.Template.fromStack(stack);
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
        expect(alarm.Properties.TreatMissingData).toBe('ignore');
    }
});
test('SNS alarm topic exists', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
});
test('All alarms have SNS alarm actions', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    for (const [name, alarm] of Object.entries(alarms)) {
        expect(alarm.Properties.AlarmActions).toBeDefined();
        expect(alarm.Properties.AlarmActions.length).toBeGreaterThan(0);
        expect(alarm.Properties.OKActions).toBeDefined();
        expect(alarm.Properties.OKActions.length).toBeGreaterThan(0);
    }
});
test('OperationsPendingReplication alarm exists', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'OperationsPendingReplication',
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvcmluZy50ZXN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibW9uaXRvcmluZy50ZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLHVEQUF5RDtBQUN6RCw4REFBMEQ7QUFFMUQsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7QUFDMUIsb0dBQW9HO0FBQ3BHLGtGQUFrRjtBQUNsRixNQUFNLEtBQUssR0FBRyxJQUFJLGtDQUFlLENBQUMsR0FBRyxFQUFFLGdCQUFnQixFQUFFO0lBQ3ZELE9BQU8sRUFBRSxRQUFRO0lBQ2pCLGdCQUFnQixFQUFFLCtCQUErQjtJQUNqRCxjQUFjLEVBQUUsK0JBQStCO0lBQy9DLGlCQUFpQixFQUFFLFlBQVk7SUFDL0IsaUJBQWlCLEVBQUUsS0FBSztJQUN4QixlQUFlLEVBQUUsS0FBSztJQUN0QixhQUFhLEVBQUUsY0FBYztJQUM3Qix1QkFBdUIsRUFBRSwrQkFBK0I7SUFDeEQscUJBQXFCLEVBQUUsK0JBQStCO0lBQ3RELGFBQWEsRUFBRSxXQUFXLEVBQUUsU0FBUyxFQUFFLGNBQWMsRUFBRSxTQUFTLEVBQUUsaUJBQWlCO0lBQ25GLGdCQUFnQixFQUFFLG9EQUFvRDtJQUN0RSxlQUFlLEVBQUUsV0FBVztJQUM1QixHQUFHLEVBQUUsRUFBRSxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0sRUFBRSxXQUFXLEVBQUU7Q0FDdEQsQ0FBQyxDQUFDO0FBQ0gsTUFBTSxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7QUFFM0MsSUFBSSxDQUFDLDREQUE0RCxFQUFFLEdBQUcsRUFBRTtJQUN0RSxRQUFRLENBQUMscUJBQXFCLENBQUMsd0JBQXdCLEVBQUU7UUFDdkQsVUFBVSxFQUFFLG9CQUFvQjtRQUNoQyxTQUFTLEVBQUUsUUFBUTtRQUNuQixV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Q0wsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgVGVtcGxhdGUsIE1hdGNoIH0gZnJvbSAnYXdzLWNkay1saWIvYXNzZXJ0aW9ucyc7XG5pbXBvcnQgeyBNb25pdG9yaW5nU3RhY2sgfSBmcm9tICcuLi9saWIvbW9uaXRvcmluZy1zdGFjayc7XG5cbmNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4vLyBNb25pdG9yaW5nIHN0YWNrIGluIHVzLWVhc3QtMSBzaG93cyBwZHjihpJpYWQgcmVwbGljYXRpb24gKG1ldHJpY3MgcHVibGlzaGVkIGluIGRlc3RpbmF0aW9uIHJlZ2lvbilcbi8vIE9wZXJhdGlvbnNGYWlsZWRSZXBsaWNhdGlvbiB1c2VzIHJldmVyc2UgZGlyZWN0aW9uIChwdWJsaXNoZWQgaW4gc291cmNlIHJlZ2lvbilcbmNvbnN0IHN0YWNrID0gbmV3IE1vbml0b3JpbmdTdGFjayhhcHAsICdUZXN0TW9uaXRvcmluZycsIHtcbiAgcHJvamVjdDogJ3MzbXJhcCcsXG4gIHNvdXJjZUJ1Y2tldE5hbWU6ICdzM21yYXAtdXMtd2VzdC0yLTEyMzQ1Njc4OTAxMicsXG4gIGRlc3RCdWNrZXROYW1lOiAnczNtcmFwLXVzLWVhc3QtMS0xMjM0NTY3ODkwMTInLFxuICByZXBsaWNhdGlvblJ1bGVJZDogJ3RvLXByaW1hcnknLFxuICBzb3VyY2VSZWdpb25MYWJlbDogJ3BkeCcsXG4gIGRlc3RSZWdpb25MYWJlbDogJ2lhZCcsXG4gIHJldmVyc2VSdWxlSWQ6ICd0by1zZWNvbmRhcnknLFxuICByZXZlcnNlU291cmNlQnVja2V0TmFtZTogJ3MzbXJhcC11cy1lYXN0LTEtMTIzNDU2Nzg5MDEyJyxcbiAgcmV2ZXJzZURlc3RCdWNrZXROYW1lOiAnczNtcmFwLXVzLXdlc3QtMi0xMjM0NTY3ODkwMTInLFxuICBwcmltYXJ5UmVnaW9uOiAndXMtZWFzdC0xJywgYWNjb3VudElkOiAnMTIzNDU2Nzg5MDEyJywgbXJhcEFsaWFzOiAndGVzdC1hbGlhcy5tcmFwJyxcbiAgZW5jcnlwdGlvbktleUFybjogJ2Fybjphd3M6a21zOnVzLWVhc3QtMToxMjM0NTY3ODkwMTI6a2V5L3Rlc3Qta2V5LWlkJyxcbiAgc2Vjb25kYXJ5UmVnaW9uOiAndXMtd2VzdC0yJyxcbiAgZW52OiB7IGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLCByZWdpb246ICd1cy1lYXN0LTEnIH0sXG59KTtcbmNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxudGVzdCgnUmVwbGljYXRpb25MYXRlbmN5IGFsYXJtIGhhcyBkZXN0aW5hdGlvbi1yZWdpb24gZGltZW5zaW9ucycsICgpID0+IHtcbiAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkNsb3VkV2F0Y2g6OkFsYXJtJywge1xuICAgIE1ldHJpY05hbWU6ICdSZXBsaWNhdGlvbkxhdGVuY3knLFxuICAgIE5hbWVzcGFjZTogJ0FXUy9TMycsXG4gICAgRGltZW5zaW9uczogW1xuICAgICAgeyBOYW1lOiAnRGVzdGluYXRpb25CdWNrZXQnLCBWYWx1ZTogJ3MzbXJhcC11cy1lYXN0LTEtMTIzNDU2Nzg5MDEyJyB9LFxuICAgICAgeyBOYW1lOiAnUnVsZUlkJywgVmFsdWU6ICd0by1wcmltYXJ5JyB9LFxuICAgICAgeyBOYW1lOiAnU291cmNlQnVja2V0JywgVmFsdWU6ICdzM21yYXAtdXMtd2VzdC0yLTEyMzQ1Njc4OTAxMicgfSxcbiAgICBdLFxuICB9KTtcbn0pO1xuXG50ZXN0KCdCeXRlc1BlbmRpbmdSZXBsaWNhdGlvbiBhbGFybSBleGlzdHMnLCAoKSA9PiB7XG4gIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpDbG91ZFdhdGNoOjpBbGFybScsIHtcbiAgICBNZXRyaWNOYW1lOiAnQnl0ZXNQZW5kaW5nUmVwbGljYXRpb24nLFxuICB9KTtcbn0pO1xuXG50ZXN0KCdPcGVyYXRpb25zRmFpbGVkUmVwbGljYXRpb24gYWxhcm0gdXNlcyByZXZlcnNlIGRpcmVjdGlvbiBkaW1lbnNpb25zIChzb3VyY2UgcmVnaW9uKScsICgpID0+IHtcbiAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkNsb3VkV2F0Y2g6OkFsYXJtJywge1xuICAgIE1ldHJpY05hbWU6ICdPcGVyYXRpb25zRmFpbGVkUmVwbGljYXRpb24nLFxuICAgIERpbWVuc2lvbnM6IFtcbiAgICAgIHsgTmFtZTogJ0Rlc3RpbmF0aW9uQnVja2V0JywgVmFsdWU6ICdzM21yYXAtdXMtd2VzdC0yLTEyMzQ1Njc4OTAxMicgfSxcbiAgICAgIHsgTmFtZTogJ1J1bGVJZCcsIFZhbHVlOiAndG8tc2Vjb25kYXJ5JyB9LFxuICAgICAgeyBOYW1lOiAnU291cmNlQnVja2V0JywgVmFsdWU6ICdzM21yYXAtdXMtZWFzdC0xLTEyMzQ1Njc4OTAxMicgfSxcbiAgICBdLFxuICB9KTtcbn0pO1xuXG50ZXN0KCdDbG91ZFdhdGNoIGRhc2hib2FyZCBleGlzdHMnLCAoKSA9PiB7XG4gIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpDbG91ZFdhdGNoOjpEYXNoYm9hcmQnLCAxKTtcbn0pO1xuXG50ZXN0KCdBbGwgYWxhcm1zIHRyZWF0IG1pc3NpbmcgZGF0YSBhcyBpZ25vcmUnLCAoKSA9PiB7XG4gIGNvbnN0IGFsYXJtcyA9IHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoJ0FXUzo6Q2xvdWRXYXRjaDo6QWxhcm0nKTtcbiAgZm9yIChjb25zdCBbLCBhbGFybV0gb2YgT2JqZWN0LmVudHJpZXMoYWxhcm1zKSkge1xuICAgIGV4cGVjdCgoYWxhcm0gYXMgYW55KS5Qcm9wZXJ0aWVzLlRyZWF0TWlzc2luZ0RhdGEpLnRvQmUoJ2lnbm9yZScpO1xuICB9XG59KTtcblxudGVzdCgnU05TIGFsYXJtIHRvcGljIGV4aXN0cycsICgpID0+IHtcbiAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OlNOUzo6VG9waWMnLCAxKTtcbn0pO1xuXG50ZXN0KCdBbGwgYWxhcm1zIGhhdmUgU05TIGFsYXJtIGFjdGlvbnMnLCAoKSA9PiB7XG4gIGNvbnN0IGFsYXJtcyA9IHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoJ0FXUzo6Q2xvdWRXYXRjaDo6QWxhcm0nKTtcbiAgZm9yIChjb25zdCBbbmFtZSwgYWxhcm1dIG9mIE9iamVjdC5lbnRyaWVzKGFsYXJtcykpIHtcbiAgICBleHBlY3QoKGFsYXJtIGFzIGFueSkuUHJvcGVydGllcy5BbGFybUFjdGlvbnMpLnRvQmVEZWZpbmVkKCk7XG4gICAgZXhwZWN0KChhbGFybSBhcyBhbnkpLlByb3BlcnRpZXMuQWxhcm1BY3Rpb25zLmxlbmd0aCkudG9CZUdyZWF0ZXJUaGFuKDApO1xuICAgIGV4cGVjdCgoYWxhcm0gYXMgYW55KS5Qcm9wZXJ0aWVzLk9LQWN0aW9ucykudG9CZURlZmluZWQoKTtcbiAgICBleHBlY3QoKGFsYXJtIGFzIGFueSkuUHJvcGVydGllcy5PS0FjdGlvbnMubGVuZ3RoKS50b0JlR3JlYXRlclRoYW4oMCk7XG4gIH1cbn0pO1xuXG50ZXN0KCdPcGVyYXRpb25zUGVuZGluZ1JlcGxpY2F0aW9uIGFsYXJtIGV4aXN0cycsICgpID0+IHtcbiAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkNsb3VkV2F0Y2g6OkFsYXJtJywge1xuICAgIE1ldHJpY05hbWU6ICdPcGVyYXRpb25zUGVuZGluZ1JlcGxpY2F0aW9uJyxcbiAgfSk7XG59KTtcblxuXG4iXX0=