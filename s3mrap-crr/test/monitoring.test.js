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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvcmluZy50ZXN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibW9uaXRvcmluZy50ZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLHVEQUF5RDtBQUN6RCw4REFBMEQ7QUFFMUQsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7QUFDMUIsb0dBQW9HO0FBQ3BHLGtGQUFrRjtBQUNsRixNQUFNLEtBQUssR0FBRyxJQUFJLGtDQUFlLENBQUMsR0FBRyxFQUFFLGdCQUFnQixFQUFFO0lBQ3ZELE9BQU8sRUFBRSxRQUFRO0lBQ2pCLGdCQUFnQixFQUFFLCtCQUErQjtJQUNqRCxjQUFjLEVBQUUsK0JBQStCO0lBQy9DLGlCQUFpQixFQUFFLFlBQVk7SUFDL0IsaUJBQWlCLEVBQUUsS0FBSztJQUN4QixlQUFlLEVBQUUsS0FBSztJQUN0QixhQUFhLEVBQUUsY0FBYztJQUM3Qix1QkFBdUIsRUFBRSwrQkFBK0I7SUFDeEQscUJBQXFCLEVBQUUsK0JBQStCO0lBQ3RELGFBQWEsRUFBRSxXQUFXLEVBQUUsU0FBUyxFQUFFLGNBQWMsRUFBRSxTQUFTLEVBQUUsaUJBQWlCO0lBQ25GLGVBQWUsRUFBRSxXQUFXO0lBQzVCLEdBQUcsRUFBRSxFQUFFLE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxFQUFFLFdBQVcsRUFBRTtDQUN0RCxDQUFDLENBQUM7QUFDSCxNQUFNLFFBQVEsR0FBRyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUUzQyxJQUFJLENBQUMsNERBQTRELEVBQUUsR0FBRyxFQUFFO0lBQ3RFLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyx3QkFBd0IsRUFBRTtRQUN2RCxVQUFVLEVBQUUsb0JBQW9CO1FBQ2hDLFNBQVMsRUFBRSxRQUFRO1FBQ25CLFVBQVUsRUFBRTtZQUNWLEVBQUUsSUFBSSxF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ZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBUZW1wbGF0ZSwgTWF0Y2ggfSBmcm9tICdhd3MtY2RrLWxpYi9hc3NlcnRpb25zJztcbmltcG9ydCB7IE1vbml0b3JpbmdTdGFjayB9IGZyb20gJy4uL2xpYi9tb25pdG9yaW5nLXN0YWNrJztcblxuY29uc3QgYXBwID0gbmV3IGNkay5BcHAoKTtcbi8vIE1vbml0b3Jpbmcgc3RhY2sgaW4gdXMtZWFzdC0xIHNob3dzIHBkeOKGkmlhZCByZXBsaWNhdGlvbiAobWV0cmljcyBwdWJsaXNoZWQgaW4gZGVzdGluYXRpb24gcmVnaW9uKVxuLy8gT3BlcmF0aW9uc0ZhaWxlZFJlcGxpY2F0aW9uIHVzZXMgcmV2ZXJzZSBkaXJlY3Rpb24gKHB1Ymxpc2hlZCBpbiBzb3VyY2UgcmVnaW9uKVxuY29uc3Qgc3RhY2sgPSBuZXcgTW9uaXRvcmluZ1N0YWNrKGFwcCwgJ1Rlc3RNb25pdG9yaW5nJywge1xuICBwcm9qZWN0OiAnczNtcmFwJyxcbiAgc291cmNlQnVja2V0TmFtZTogJ3MzbXJhcC11cy13ZXN0LTItMTIzNDU2Nzg5MDEyJyxcbiAgZGVzdEJ1Y2tldE5hbWU6ICdzM21yYXAtdXMtZWFzdC0xLTEyMzQ1Njc4OTAxMicsXG4gIHJlcGxpY2F0aW9uUnVsZUlkOiAndG8tcHJpbWFyeScsXG4gIHNvdXJjZVJlZ2lvbkxhYmVsOiAncGR4JyxcbiAgZGVzdFJlZ2lvbkxhYmVsOiAnaWFkJyxcbiAgcmV2ZXJzZVJ1bGVJZDogJ3RvLXNlY29uZGFyeScsXG4gIHJldmVyc2VTb3VyY2VCdWNrZXROYW1lOiAnczNtcmFwLXVzLWVhc3QtMS0xMjM0NTY3ODkwMTInLFxuICByZXZlcnNlRGVzdEJ1Y2tldE5hbWU6ICdzM21yYXAtdXMtd2VzdC0yLTEyMzQ1Njc4OTAxMicsXG4gIHByaW1hcnlSZWdpb246ICd1cy1lYXN0LTEnLCBhY2NvdW50SWQ6ICcxMjM0NTY3ODkwMTInLCBtcmFwQWxpYXM6ICd0ZXN0LWFsaWFzLm1yYXAnLFxuICBzZWNvbmRhcnlSZWdpb246ICd1cy13ZXN0LTInLFxuICBlbnY6IHsgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsIHJlZ2lvbjogJ3VzLWVhc3QtMScgfSxcbn0pO1xuY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG50ZXN0KCdSZXBsaWNhdGlvbkxhdGVuY3kgYWxhcm0gaGFzIGRlc3RpbmF0aW9uLXJlZ2lvbiBkaW1lbnNpb25zJywgKCkgPT4ge1xuICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6Q2xvdWRXYXRjaDo6QWxhcm0nLCB7XG4gICAgTWV0cmljTmFtZTogJ1JlcGxpY2F0aW9uTGF0ZW5jeScsXG4gICAgTmFtZXNwYWNlOiAnQVdTL1MzJyxcbiAgICBEaW1lbnNpb25zOiBbXG4gICAgICB7IE5hbWU6ICdEZXN0aW5hdGlvbkJ1Y2tldCcsIFZhbHVlOiAnczNtcmFwLXVzLWVhc3QtMS0xMjM0NTY3ODkwMTInIH0sXG4gICAgICB7IE5hbWU6ICdSdWxlSWQnLCBWYWx1ZTogJ3RvLXByaW1hcnknIH0sXG4gICAgICB7IE5hbWU6ICdTb3VyY2VCdWNrZXQnLCBWYWx1ZTogJ3MzbXJhcC11cy13ZXN0LTItMTIzNDU2Nzg5MDEyJyB9LFxuICAgIF0sXG4gIH0pO1xufSk7XG5cbnRlc3QoJ0J5dGVzUGVuZGluZ1JlcGxpY2F0aW9uIGFsYXJtIGV4aXN0cycsICgpID0+IHtcbiAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkNsb3VkV2F0Y2g6OkFsYXJtJywge1xuICAgIE1ldHJpY05hbWU6ICdCeXRlc1BlbmRpbmdSZXBsaWNhdGlvbicsXG4gIH0pO1xufSk7XG5cbnRlc3QoJ09wZXJhdGlvbnNGYWlsZWRSZXBsaWNhdGlvbiBhbGFybSB1c2VzIHJldmVyc2UgZGlyZWN0aW9uIGRpbWVuc2lvbnMgKHNvdXJjZSByZWdpb24pJywgKCkgPT4ge1xuICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6Q2xvdWRXYXRjaDo6QWxhcm0nLCB7XG4gICAgTWV0cmljTmFtZTogJ09wZXJhdGlvbnNGYWlsZWRSZXBsaWNhdGlvbicsXG4gICAgRGltZW5zaW9uczogW1xuICAgICAgeyBOYW1lOiAnRGVzdGluYXRpb25CdWNrZXQnLCBWYWx1ZTogJ3MzbXJhcC11cy13ZXN0LTItMTIzNDU2Nzg5MDEyJyB9LFxuICAgICAgeyBOYW1lOiAnUnVsZUlkJywgVmFsdWU6ICd0by1zZWNvbmRhcnknIH0sXG4gICAgICB7IE5hbWU6ICdTb3VyY2VCdWNrZXQnLCBWYWx1ZTogJ3MzbXJhcC11cy1lYXN0LTEtMTIzNDU2Nzg5MDEyJyB9LFxuICAgIF0sXG4gIH0pO1xufSk7XG5cbnRlc3QoJ0Nsb3VkV2F0Y2ggZGFzaGJvYXJkIGV4aXN0cycsICgpID0+IHtcbiAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkNsb3VkV2F0Y2g6OkRhc2hib2FyZCcsIDEpO1xufSk7XG5cbnRlc3QoJ0FsbCBhbGFybXMgdHJlYXQgbWlzc2luZyBkYXRhIGFzIGlnbm9yZScsICgpID0+IHtcbiAgY29uc3QgYWxhcm1zID0gdGVtcGxhdGUuZmluZFJlc291cmNlcygnQVdTOjpDbG91ZFdhdGNoOjpBbGFybScpO1xuICBmb3IgKGNvbnN0IFssIGFsYXJtXSBvZiBPYmplY3QuZW50cmllcyhhbGFybXMpKSB7XG4gICAgZXhwZWN0KChhbGFybSBhcyBhbnkpLlByb3BlcnRpZXMuVHJlYXRNaXNzaW5nRGF0YSkudG9CZSgnaWdub3JlJyk7XG4gIH1cbn0pO1xuXG50ZXN0KCdTTlMgYWxhcm0gdG9waWMgZXhpc3RzJywgKCkgPT4ge1xuICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6U05TOjpUb3BpYycsIDEpO1xufSk7XG5cbnRlc3QoJ0FsbCBhbGFybXMgaGF2ZSBTTlMgYWxhcm0gYWN0aW9ucycsICgpID0+IHtcbiAgY29uc3QgYWxhcm1zID0gdGVtcGxhdGUuZmluZFJlc291cmNlcygnQVdTOjpDbG91ZFdhdGNoOjpBbGFybScpO1xuICBmb3IgKGNvbnN0IFtuYW1lLCBhbGFybV0gb2YgT2JqZWN0LmVudHJpZXMoYWxhcm1zKSkge1xuICAgIGV4cGVjdCgoYWxhcm0gYXMgYW55KS5Qcm9wZXJ0aWVzLkFsYXJtQWN0aW9ucykudG9CZURlZmluZWQoKTtcbiAgICBleHBlY3QoKGFsYXJtIGFzIGFueSkuUHJvcGVydGllcy5BbGFybUFjdGlvbnMubGVuZ3RoKS50b0JlR3JlYXRlclRoYW4oMCk7XG4gICAgZXhwZWN0KChhbGFybSBhcyBhbnkpLlByb3BlcnRpZXMuT0tBY3Rpb25zKS50b0JlRGVmaW5lZCgpO1xuICAgIGV4cGVjdCgoYWxhcm0gYXMgYW55KS5Qcm9wZXJ0aWVzLk9LQWN0aW9ucy5sZW5ndGgpLnRvQmVHcmVhdGVyVGhhbigwKTtcbiAgfVxufSk7XG5cbnRlc3QoJ09wZXJhdGlvbnNQZW5kaW5nUmVwbGljYXRpb24gYWxhcm0gZXhpc3RzJywgKCkgPT4ge1xuICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6Q2xvdWRXYXRjaDo6QWxhcm0nLCB7XG4gICAgTWV0cmljTmFtZTogJ09wZXJhdGlvbnNQZW5kaW5nUmVwbGljYXRpb24nLFxuICB9KTtcbn0pO1xuXG5cbiJdfQ==