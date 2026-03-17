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
const regional_bucket_stack_1 = require("../lib/regional-bucket-stack");
const app = new cdk.App();
const stack = new regional_bucket_stack_1.RegionalBucketStack(app, 'TestBucket', {
    project: 's3mrap',
    env: { account: '123456789012', region: 'us-east-1' },
});
const template = assertions_1.Template.fromStack(stack);
test('S3 bucket has versioning enabled', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
        VersioningConfiguration: { Status: 'Enabled' },
    });
});
test('S3 bucket has encryption enabled', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
            ServerSideEncryptionConfiguration: [
                { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
            ],
        },
    });
});
test('S3 bucket blocks public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
        },
    });
});
test('Stack outputs bucket name and ARN', () => {
    template.hasOutput('BucketName', {});
    template.hasOutput('BucketArn', {});
});
test('Replication failure SNS topic exists', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 's3mrap-repl-failures-us-east-1',
    });
});
test('S3 bucket has replication failure event notification', () => {
    template.resourceCountIs('Custom::S3BucketNotifications', 1);
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVnaW9uYWwtYnVja2V0LnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyZWdpb25hbC1idWNrZXQudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLGlEQUFtQztBQUNuQyx1REFBa0Q7QUFDbEQsd0VBQW1FO0FBRW5FLE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO0FBQzFCLE1BQU0sS0FBSyxHQUFHLElBQUksMkNBQW1CLENBQUMsR0FBRyxFQUFFLFlBQVksRUFBRTtJQUN2RCxPQUFPLEVBQUUsUUFBUTtJQUNqQixHQUFHLEVBQUUsRUFBRSxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0sRUFBRSxXQUFXLEVBQUU7Q0FDdEQsQ0FBQyxDQUFDO0FBQ0gsTUFBTSxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7QUFFM0MsSUFBSSxDQUFDLGtDQUFrQyxFQUFFLEdBQUcsRUFBRTtJQUM1QyxRQUFRLENBQUMscUJBQXFCLENBQUMsaUJBQWlCLEVBQUU7UUFDaEQsdUJBQXVCLEVBQUUsRUFBRSxNQUFNLEVBQUUsU0FBUyxFQUFFO0tBQy9DLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDO0FBRUgsSUFBSSxDQUFDLGtDQUFrQyxFQUFFLEdBQUcsRUFBRTtJQUM1QyxRQUFRLENBQUMscUJBQXFCLENBQUMsaUJBQWlCLEVBQUU7UUFDaEQsZ0JBQWdCLEVBQUU7WUFDaEIsaUNBQWlDLEVBQUU7Z0JBQ2pDLEVBQUUsNkJBQTZCLEVBQUUsRUFBRSxZQUFZLEVBQUUsUUFBUSxFQUFFLEVBQUU7YUFDOUQ7U0FDRjtLQUNGLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDO0FBRUgsSUFBSSxDQUFDLGdDQUFnQyxFQUFFLEdBQUcsRUFBRTtJQUMxQyxRQUFRLENBQUMscUJBQXFCLENBQUMsaUJBQWlCLEVBQUU7UUFDaEQsOEJBQThCLEVBQUU7WUFDOUIsZUFBZSxFQUFFLElBQUk7WUFDckIsaUJBQWlCLEVBQUUsSUFBSTtZQUN2QixnQkFBZ0IsRUFBRSxJQUFJO1lBQ3RCLHFCQUFxQixFQUFFLElBQUk7U0FDNUI7S0FDRixDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQztBQUVILElBQUksQ0FBQyxtQ0FBbUMsRUFBRSxHQUFHLEVBQUU7SUFDN0MsUUFBUSxDQUFDLFNBQVMsQ0FBQyxZQUFZLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDckMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxXQUFXLEVBQUUsRUFBRSxDQUFDLENBQUM7QUFDdEMsQ0FBQyxDQUFDLENBQUM7QUFFSCxJQUFJLENBQUMsc0NBQXNDLEVBQUUsR0FBRyxFQUFFO0lBQ2hELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxpQkFBaUIsRUFBRTtRQUNoRCxTQUFTLEVBQUUsZ0NBQWdDO0tBQzVDLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDO0FBRUgsSUFBSSxDQUFDLHNEQUFzRCxFQUFFLEdBQUcsRUFBRTtJQUNoRSxRQUFRLENBQUMsZUFBZSxDQUFDLCtCQUErQixFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQy9ELENBQUMsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IFRlbXBsYXRlIH0gZnJvbSAnYXdzLWNkay1saWIvYXNzZXJ0aW9ucyc7XG5pbXBvcnQgeyBSZWdpb25hbEJ1Y2tldFN0YWNrIH0gZnJvbSAnLi4vbGliL3JlZ2lvbmFsLWJ1Y2tldC1zdGFjayc7XG5cbmNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG5jb25zdCBzdGFjayA9IG5ldyBSZWdpb25hbEJ1Y2tldFN0YWNrKGFwcCwgJ1Rlc3RCdWNrZXQnLCB7XG4gIHByb2plY3Q6ICdzM21yYXAnLFxuICBlbnY6IHsgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsIHJlZ2lvbjogJ3VzLWVhc3QtMScgfSxcbn0pO1xuY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG50ZXN0KCdTMyBidWNrZXQgaGFzIHZlcnNpb25pbmcgZW5hYmxlZCcsICgpID0+IHtcbiAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlMzOjpCdWNrZXQnLCB7XG4gICAgVmVyc2lvbmluZ0NvbmZpZ3VyYXRpb246IHsgU3RhdHVzOiAnRW5hYmxlZCcgfSxcbiAgfSk7XG59KTtcblxudGVzdCgnUzMgYnVja2V0IGhhcyBlbmNyeXB0aW9uIGVuYWJsZWQnLCAoKSA9PiB7XG4gIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTMzo6QnVja2V0Jywge1xuICAgIEJ1Y2tldEVuY3J5cHRpb246IHtcbiAgICAgIFNlcnZlclNpZGVFbmNyeXB0aW9uQ29uZmlndXJhdGlvbjogW1xuICAgICAgICB7IFNlcnZlclNpZGVFbmNyeXB0aW9uQnlEZWZhdWx0OiB7IFNTRUFsZ29yaXRobTogJ0FFUzI1NicgfSB9LFxuICAgICAgXSxcbiAgICB9LFxuICB9KTtcbn0pO1xuXG50ZXN0KCdTMyBidWNrZXQgYmxvY2tzIHB1YmxpYyBhY2Nlc3MnLCAoKSA9PiB7XG4gIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTMzo6QnVja2V0Jywge1xuICAgIFB1YmxpY0FjY2Vzc0Jsb2NrQ29uZmlndXJhdGlvbjoge1xuICAgICAgQmxvY2tQdWJsaWNBY2xzOiB0cnVlLFxuICAgICAgQmxvY2tQdWJsaWNQb2xpY3k6IHRydWUsXG4gICAgICBJZ25vcmVQdWJsaWNBY2xzOiB0cnVlLFxuICAgICAgUmVzdHJpY3RQdWJsaWNCdWNrZXRzOiB0cnVlLFxuICAgIH0sXG4gIH0pO1xufSk7XG5cbnRlc3QoJ1N0YWNrIG91dHB1dHMgYnVja2V0IG5hbWUgYW5kIEFSTicsICgpID0+IHtcbiAgdGVtcGxhdGUuaGFzT3V0cHV0KCdCdWNrZXROYW1lJywge30pO1xuICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0J1Y2tldEFybicsIHt9KTtcbn0pO1xuXG50ZXN0KCdSZXBsaWNhdGlvbiBmYWlsdXJlIFNOUyB0b3BpYyBleGlzdHMnLCAoKSA9PiB7XG4gIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTTlM6OlRvcGljJywge1xuICAgIFRvcGljTmFtZTogJ3MzbXJhcC1yZXBsLWZhaWx1cmVzLXVzLWVhc3QtMScsXG4gIH0pO1xufSk7XG5cbnRlc3QoJ1MzIGJ1Y2tldCBoYXMgcmVwbGljYXRpb24gZmFpbHVyZSBldmVudCBub3RpZmljYXRpb24nLCAoKSA9PiB7XG4gIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQ3VzdG9tOjpTM0J1Y2tldE5vdGlmaWNhdGlvbnMnLCAxKTtcbn0pO1xuIl19