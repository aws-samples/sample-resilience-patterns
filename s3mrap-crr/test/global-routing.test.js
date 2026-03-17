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
const global_routing_stack_1 = require("../lib/global-routing-stack");
const app = new cdk.App();
const stack = new global_routing_stack_1.GlobalRoutingStack(app, 'TestRouting', {
    project: 's3mrap',
    primaryBucketName: 's3mrap-us-east-1-123456789012',
    secondaryBucketName: 's3mrap-us-west-2-123456789012',
    primaryRegion: 'us-east-1',
    secondaryRegion: 'us-west-2',
    accountId: '123456789012', encryptionKeyId: 'test-key-id',
    env: { account: '123456789012', region: 'us-east-1' },
});
const template = assertions_1.Template.fromStack(stack);
test('MRAP references both regional buckets', () => {
    template.hasResourceProperties('AWS::S3::MultiRegionAccessPoint', {
        Regions: assertions_1.Match.arrayWith([
            assertions_1.Match.objectLike({ Bucket: 's3mrap-us-east-1-123456789012' }),
            assertions_1.Match.objectLike({ Bucket: 's3mrap-us-west-2-123456789012' }),
        ]),
    });
});
test('MRAP blocks public access', () => {
    template.hasResourceProperties('AWS::S3::MultiRegionAccessPoint', {
        PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
        },
    });
});
test('CRR Lambda role includes GetBucketLocation', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
            Statement: assertions_1.Match.arrayWith([
                assertions_1.Match.objectLike({
                    Action: assertions_1.Match.arrayWith(['s3:GetBucketLocation']),
                }),
            ]),
        },
    });
});
test('Replication role is trusted by s3.amazonaws.com', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
            Statement: assertions_1.Match.arrayWith([
                assertions_1.Match.objectLike({
                    Principal: { Service: 's3.amazonaws.com' },
                }),
            ]),
        },
    });
});
test('Replication role has ReplicateObject permission', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
            Statement: assertions_1.Match.arrayWith([
                assertions_1.Match.objectLike({
                    Action: assertions_1.Match.arrayWith(['s3:ReplicateObject']),
                }),
            ]),
        },
    });
});
test('Stack outputs MRAP alias and ARN', () => {
    template.hasOutput('MrapAlias', {});
    template.hasOutput('MrapArn', {});
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2xvYmFsLXJvdXRpbmcudGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImdsb2JhbC1yb3V0aW5nLnRlc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMsdURBQXlEO0FBQ3pELHNFQUFpRTtBQUVqRSxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUMxQixNQUFNLEtBQUssR0FBRyxJQUFJLHlDQUFrQixDQUFDLEdBQUcsRUFBRSxhQUFhLEVBQUU7SUFDdkQsT0FBTyxFQUFFLFFBQVE7SUFDakIsaUJBQWlCLEVBQUUsK0JBQStCO0lBQ2xELG1CQUFtQixFQUFFLCtCQUErQjtJQUNwRCxhQUFhLEVBQUUsV0FBVztJQUMxQixlQUFlLEVBQUUsV0FBVztJQUM1QixTQUFTLEVBQUUsY0FBYyxFQUFFLGVBQWUsRUFBRSxhQUFhO0lBQ3pELEdBQUcsRUFBRSxFQUFFLE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxFQUFFLFdBQVcsRUFBRTtDQUN0RCxDQUFDLENBQUM7QUFDSCxNQUFNLFFBQVEsR0FBRyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUUzQyxJQUFJLENBQUMsdUNBQXVDLEVBQUUsR0FBRyxFQUFFO0lBQ2pELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxpQ0FBaUMsRUFBRTtRQUNoRSxPQUFPLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUM7WUFDdkIsa0JBQUssQ0FBQyxVQUFVLENBQUMsRUFBRSxNQUFNLEVBQUUsK0JBQStCLEVBQUUsQ0FBQztZQUM3RCxrQkFBSyxDQUFDLFVBQVUsQ0FBQyxFQUFFLE1BQU0sRUFBRSwrQkFBK0IsRUFBRSxDQUFDO1NBQzlELENBQUM7S0FDSCxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQztBQUVILElBQUksQ0FBQywyQkFBMkIsRUFBRSxHQUFHLEVBQUU7SUFDckMsUUFBUSxDQUFDLHFCQUFxQixDQUFDLGlDQUFpQyxFQUFFO1FBQ2hFLDhCQUE4QixFQUFFO1lBQzlCLGVBQWUsRUFBRSxJQUFJO1lBQ3JCLGlCQUFpQixFQUFFLElBQUk7WUFDdkIsZ0JBQWdCLEVBQUUsSUFBSTtZQUN0QixxQkFBcUIsRUFBRSxJQUFJO1NBQzVCO0tBQ0YsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUM7QUFFSCxJQUFJLENBQUMsNENBQTRDLEVBQUUsR0FBRyxFQUFFO0lBQ3RELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxrQkFBa0IsRUFBRTtRQUNqRCxjQUFjLEVBQUU7WUFDZCxTQUFTLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUM7Z0JBQ3pCLGtCQUFLLENBQUMsVUFBVSxDQUFDO29CQUNmLE1BQU0sRUFBRSxrQkFBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDLHNCQUFzQixDQUFDLENBQUM7aUJBQ2xELENBQUM7YUFDSCxDQUFDO1NBQ0g7S0FDRixDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQztBQUVILElBQUksQ0FBQyxpREFBaUQsRUFBRSxHQUFHLEVBQUU7SUFDM0QsUUFBUSxDQUFDLHFCQUFxQixDQUFDLGdCQUFnQixFQUFFO1FBQy9DLHdCQUF3QixFQUFFO1lBQ3hCLFNBQVMsRUFBRSxrQkFBSyxDQUFDLFNBQVMsQ0FBQztnQkFDekIsa0JBQUssQ0FBQyxVQUFVLENBQUM7b0JBQ2YsU0FBUyxFQUFFLEVBQUUsT0FBTyxFQUFFLGtCQUFrQixFQUFFO2lCQUMzQyxDQUFDO2FBQ0gsQ0FBQztTQUNIO0tBQ0YsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUM7QUFFSCxJQUFJLENBQUMsaURBQWlELEVBQUUsR0FBRyxFQUFFO0lBQzNELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxrQkFBa0IsRUFBRTtRQUNqRCxjQUFjLEVBQUU7WUFDZCxTQUFTLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUM7Z0JBQ3pCLGtCQUFLLENBQUMsVUFBVSxDQUFDO29CQUNmLE1BQU0sRUFBRSxrQkFBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDLG9CQUFvQixDQUFDLENBQUM7aUJBQ2hELENBQUM7YUFDSCxDQUFDO1NBQ0g7S0FDRixDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQztBQUVILElBQUksQ0FBQyxrQ0FBa0MsRUFBRSxHQUFHLEVBQUU7SUFDNUMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxXQUFXLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDcEMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxTQUFTLEVBQUUsRUFBRSxDQUFDLENBQUM7QUFDcEMsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgVGVtcGxhdGUsIE1hdGNoIH0gZnJvbSAnYXdzLWNkay1saWIvYXNzZXJ0aW9ucyc7XG5pbXBvcnQgeyBHbG9iYWxSb3V0aW5nU3RhY2sgfSBmcm9tICcuLi9saWIvZ2xvYmFsLXJvdXRpbmctc3RhY2snO1xuXG5jb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuY29uc3Qgc3RhY2sgPSBuZXcgR2xvYmFsUm91dGluZ1N0YWNrKGFwcCwgJ1Rlc3RSb3V0aW5nJywge1xuICBwcm9qZWN0OiAnczNtcmFwJyxcbiAgcHJpbWFyeUJ1Y2tldE5hbWU6ICdzM21yYXAtdXMtZWFzdC0xLTEyMzQ1Njc4OTAxMicsXG4gIHNlY29uZGFyeUJ1Y2tldE5hbWU6ICdzM21yYXAtdXMtd2VzdC0yLTEyMzQ1Njc4OTAxMicsXG4gIHByaW1hcnlSZWdpb246ICd1cy1lYXN0LTEnLFxuICBzZWNvbmRhcnlSZWdpb246ICd1cy13ZXN0LTInLFxuICBhY2NvdW50SWQ6ICcxMjM0NTY3ODkwMTInLCBlbmNyeXB0aW9uS2V5SWQ6ICd0ZXN0LWtleS1pZCcsXG4gIGVudjogeyBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJywgcmVnaW9uOiAndXMtZWFzdC0xJyB9LFxufSk7XG5jb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbnRlc3QoJ01SQVAgcmVmZXJlbmNlcyBib3RoIHJlZ2lvbmFsIGJ1Y2tldHMnLCAoKSA9PiB7XG4gIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTMzo6TXVsdGlSZWdpb25BY2Nlc3NQb2ludCcsIHtcbiAgICBSZWdpb25zOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7IEJ1Y2tldDogJ3MzbXJhcC11cy1lYXN0LTEtMTIzNDU2Nzg5MDEyJyB9KSxcbiAgICAgIE1hdGNoLm9iamVjdExpa2UoeyBCdWNrZXQ6ICdzM21yYXAtdXMtd2VzdC0yLTEyMzQ1Njc4OTAxMicgfSksXG4gICAgXSksXG4gIH0pO1xufSk7XG5cbnRlc3QoJ01SQVAgYmxvY2tzIHB1YmxpYyBhY2Nlc3MnLCAoKSA9PiB7XG4gIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTMzo6TXVsdGlSZWdpb25BY2Nlc3NQb2ludCcsIHtcbiAgICBQdWJsaWNBY2Nlc3NCbG9ja0NvbmZpZ3VyYXRpb246IHtcbiAgICAgIEJsb2NrUHVibGljQWNsczogdHJ1ZSxcbiAgICAgIEJsb2NrUHVibGljUG9saWN5OiB0cnVlLFxuICAgICAgSWdub3JlUHVibGljQWNsczogdHJ1ZSxcbiAgICAgIFJlc3RyaWN0UHVibGljQnVja2V0czogdHJ1ZSxcbiAgICB9LFxuICB9KTtcbn0pO1xuXG50ZXN0KCdDUlIgTGFtYmRhIHJvbGUgaW5jbHVkZXMgR2V0QnVja2V0TG9jYXRpb24nLCAoKSA9PiB7XG4gIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpJQU06OlBvbGljeScsIHtcbiAgICBQb2xpY3lEb2N1bWVudDoge1xuICAgICAgU3RhdGVtZW50OiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICBBY3Rpb246IE1hdGNoLmFycmF5V2l0aChbJ3MzOkdldEJ1Y2tldExvY2F0aW9uJ10pLFxuICAgICAgICB9KSxcbiAgICAgIF0pLFxuICAgIH0sXG4gIH0pO1xufSk7XG5cbnRlc3QoJ1JlcGxpY2F0aW9uIHJvbGUgaXMgdHJ1c3RlZCBieSBzMy5hbWF6b25hd3MuY29tJywgKCkgPT4ge1xuICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6SUFNOjpSb2xlJywge1xuICAgIEFzc3VtZVJvbGVQb2xpY3lEb2N1bWVudDoge1xuICAgICAgU3RhdGVtZW50OiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICBQcmluY2lwYWw6IHsgU2VydmljZTogJ3MzLmFtYXpvbmF3cy5jb20nIH0sXG4gICAgICAgIH0pLFxuICAgICAgXSksXG4gICAgfSxcbiAgfSk7XG59KTtcblxudGVzdCgnUmVwbGljYXRpb24gcm9sZSBoYXMgUmVwbGljYXRlT2JqZWN0IHBlcm1pc3Npb24nLCAoKSA9PiB7XG4gIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpJQU06OlBvbGljeScsIHtcbiAgICBQb2xpY3lEb2N1bWVudDoge1xuICAgICAgU3RhdGVtZW50OiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICBBY3Rpb246IE1hdGNoLmFycmF5V2l0aChbJ3MzOlJlcGxpY2F0ZU9iamVjdCddKSxcbiAgICAgICAgfSksXG4gICAgICBdKSxcbiAgICB9LFxuICB9KTtcbn0pO1xuXG50ZXN0KCdTdGFjayBvdXRwdXRzIE1SQVAgYWxpYXMgYW5kIEFSTicsICgpID0+IHtcbiAgdGVtcGxhdGUuaGFzT3V0cHV0KCdNcmFwQWxpYXMnLCB7fSk7XG4gIHRlbXBsYXRlLmhhc091dHB1dCgnTXJhcEFybicsIHt9KTtcbn0pO1xuIl19