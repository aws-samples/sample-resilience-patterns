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
    accountId: '123456789012',
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2xvYmFsLXJvdXRpbmcudGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImdsb2JhbC1yb3V0aW5nLnRlc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMsdURBQXlEO0FBQ3pELHNFQUFpRTtBQUVqRSxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUMxQixNQUFNLEtBQUssR0FBRyxJQUFJLHlDQUFrQixDQUFDLEdBQUcsRUFBRSxhQUFhLEVBQUU7SUFDdkQsT0FBTyxFQUFFLFFBQVE7SUFDakIsaUJBQWlCLEVBQUUsK0JBQStCO0lBQ2xELG1CQUFtQixFQUFFLCtCQUErQjtJQUNwRCxhQUFhLEVBQUUsV0FBVztJQUMxQixlQUFlLEVBQUUsV0FBVztJQUM1QixTQUFTLEVBQUUsY0FBYztJQUN6QixHQUFHLEVBQUUsRUFBRSxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0sRUFBRSxXQUFXLEVBQUU7Q0FDdEQsQ0FBQyxDQUFDO0FBQ0gsTUFBTSxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7QUFFM0MsSUFBSSxDQUFDLHVDQUF1QyxFQUFFLEdBQUcsRUFBRTtJQUNqRCxRQUFRLENBQUMscUJBQXFCLENBQUMsaUNBQWlDLEVBQUU7UUFDaEUsT0FBTyxFQUFFLGtCQUFLLENBQUMsU0FBUyxDQUFDO1lBQ3ZCLGtCQUFLLENBQUMsVUFBVSxDQUFDLEVBQUUsTUFBTSxFQUFFLCtCQUErQixFQUFFLENBQUM7WUFDN0Qsa0JBQUssQ0FBQyxVQUFVLENBQUMsRUFBRSxNQUFNLEVBQUUsK0JBQStCLEVBQUUsQ0FBQztTQUM5RCxDQUFDO0tBQ0gsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUM7QUFFSCxJQUFJLENBQUMsMkJBQTJCLEVBQUUsR0FBRyxFQUFFO0lBQ3JDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxpQ0FBaUMsRUFBRTtRQUNoRSw4QkFBOEIsRUFBRTtZQUM5QixlQUFlLEVBQUUsSUFBSTtZQUNyQixpQkFBaUIsRUFBRSxJQUFJO1lBQ3ZCLGdCQUFnQixFQUFFLElBQUk7WUFDdEIscUJBQXFCLEVBQUUsSUFBSTtTQUM1QjtLQUNGLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDO0FBRUgsSUFBSSxDQUFDLDRDQUE0QyxFQUFFLEdBQUcsRUFBRTtJQUN0RCxRQUFRLENBQUMscUJBQXFCLENBQUMsa0JBQWtCLEVBQUU7UUFDakQsY0FBYyxFQUFFO1lBQ2QsU0FBUyxFQUFFLGtCQUFLLENBQUMsU0FBUyxDQUFDO2dCQUN6QixrQkFBSyxDQUFDLFVBQVUsQ0FBQztvQkFDZixNQUFNLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQyxzQkFBc0IsQ0FBQyxDQUFDO2lCQUNsRCxDQUFDO2FBQ0gsQ0FBQztTQUNIO0tBQ0YsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUM7QUFFSCxJQUFJLENBQUMsaURBQWlELEVBQUUsR0FBRyxFQUFFO0lBQzNELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxnQkFBZ0IsRUFBRTtRQUMvQyx3QkFBd0IsRUFBRTtZQUN4QixTQUFTLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUM7Z0JBQ3pCLGtCQUFLLENBQUMsVUFBVSxDQUFDO29CQUNmLFNBQVMsRUFBRSxFQUFFLE9BQU8sRUFBRSxrQkFBa0IsRUFBRTtpQkFDM0MsQ0FBQzthQUNILENBQUM7U0FDSDtLQUNGLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDO0FBRUgsSUFBSSxDQUFDLGlEQUFpRCxFQUFFLEdBQUcsRUFBRTtJQUMzRCxRQUFRLENBQUMscUJBQXFCLENBQUMsa0JBQWtCLEVBQUU7UUFDakQsY0FBYyxFQUFFO1lBQ2QsU0FBUyxFQUFFLGtCQUFLLENBQUMsU0FBUyxDQUFDO2dCQUN6QixrQkFBSyxDQUFDLFVBQVUsQ0FBQztvQkFDZixNQUFNLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO2lCQUNoRCxDQUFDO2FBQ0gsQ0FBQztTQUNIO0tBQ0YsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUM7QUFFSCxJQUFJLENBQUMsa0NBQWtDLEVBQUUsR0FBRyxFQUFFO0lBQzVDLFFBQVEsQ0FBQyxTQUFTLENBQUMsV0FBVyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ3BDLFFBQVEsQ0FBQyxTQUFTLENBQUMsU0FBUyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQ3BDLENBQUMsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IFRlbXBsYXRlLCBNYXRjaCB9IGZyb20gJ2F3cy1jZGstbGliL2Fzc2VydGlvbnMnO1xuaW1wb3J0IHsgR2xvYmFsUm91dGluZ1N0YWNrIH0gZnJvbSAnLi4vbGliL2dsb2JhbC1yb3V0aW5nLXN0YWNrJztcblxuY29uc3QgYXBwID0gbmV3IGNkay5BcHAoKTtcbmNvbnN0IHN0YWNrID0gbmV3IEdsb2JhbFJvdXRpbmdTdGFjayhhcHAsICdUZXN0Um91dGluZycsIHtcbiAgcHJvamVjdDogJ3MzbXJhcCcsXG4gIHByaW1hcnlCdWNrZXROYW1lOiAnczNtcmFwLXVzLWVhc3QtMS0xMjM0NTY3ODkwMTInLFxuICBzZWNvbmRhcnlCdWNrZXROYW1lOiAnczNtcmFwLXVzLXdlc3QtMi0xMjM0NTY3ODkwMTInLFxuICBwcmltYXJ5UmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgc2Vjb25kYXJ5UmVnaW9uOiAndXMtd2VzdC0yJyxcbiAgYWNjb3VudElkOiAnMTIzNDU2Nzg5MDEyJyxcbiAgZW52OiB7IGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLCByZWdpb246ICd1cy1lYXN0LTEnIH0sXG59KTtcbmNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxudGVzdCgnTVJBUCByZWZlcmVuY2VzIGJvdGggcmVnaW9uYWwgYnVja2V0cycsICgpID0+IHtcbiAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlMzOjpNdWx0aVJlZ2lvbkFjY2Vzc1BvaW50Jywge1xuICAgIFJlZ2lvbnM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICBNYXRjaC5vYmplY3RMaWtlKHsgQnVja2V0OiAnczNtcmFwLXVzLWVhc3QtMS0xMjM0NTY3ODkwMTInIH0pLFxuICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7IEJ1Y2tldDogJ3MzbXJhcC11cy13ZXN0LTItMTIzNDU2Nzg5MDEyJyB9KSxcbiAgICBdKSxcbiAgfSk7XG59KTtcblxudGVzdCgnTVJBUCBibG9ja3MgcHVibGljIGFjY2VzcycsICgpID0+IHtcbiAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlMzOjpNdWx0aVJlZ2lvbkFjY2Vzc1BvaW50Jywge1xuICAgIFB1YmxpY0FjY2Vzc0Jsb2NrQ29uZmlndXJhdGlvbjoge1xuICAgICAgQmxvY2tQdWJsaWNBY2xzOiB0cnVlLFxuICAgICAgQmxvY2tQdWJsaWNQb2xpY3k6IHRydWUsXG4gICAgICBJZ25vcmVQdWJsaWNBY2xzOiB0cnVlLFxuICAgICAgUmVzdHJpY3RQdWJsaWNCdWNrZXRzOiB0cnVlLFxuICAgIH0sXG4gIH0pO1xufSk7XG5cbnRlc3QoJ0NSUiBMYW1iZGEgcm9sZSBpbmNsdWRlcyBHZXRCdWNrZXRMb2NhdGlvbicsICgpID0+IHtcbiAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OklBTTo6UG9saWN5Jywge1xuICAgIFBvbGljeURvY3VtZW50OiB7XG4gICAgICBTdGF0ZW1lbnQ6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgIEFjdGlvbjogTWF0Y2guYXJyYXlXaXRoKFsnczM6R2V0QnVja2V0TG9jYXRpb24nXSksXG4gICAgICAgIH0pLFxuICAgICAgXSksXG4gICAgfSxcbiAgfSk7XG59KTtcblxudGVzdCgnUmVwbGljYXRpb24gcm9sZSBpcyB0cnVzdGVkIGJ5IHMzLmFtYXpvbmF3cy5jb20nLCAoKSA9PiB7XG4gIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpJQU06OlJvbGUnLCB7XG4gICAgQXNzdW1lUm9sZVBvbGljeURvY3VtZW50OiB7XG4gICAgICBTdGF0ZW1lbnQ6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgIFByaW5jaXBhbDogeyBTZXJ2aWNlOiAnczMuYW1hem9uYXdzLmNvbScgfSxcbiAgICAgICAgfSksXG4gICAgICBdKSxcbiAgICB9LFxuICB9KTtcbn0pO1xuXG50ZXN0KCdSZXBsaWNhdGlvbiByb2xlIGhhcyBSZXBsaWNhdGVPYmplY3QgcGVybWlzc2lvbicsICgpID0+IHtcbiAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OklBTTo6UG9saWN5Jywge1xuICAgIFBvbGljeURvY3VtZW50OiB7XG4gICAgICBTdGF0ZW1lbnQ6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgIEFjdGlvbjogTWF0Y2guYXJyYXlXaXRoKFsnczM6UmVwbGljYXRlT2JqZWN0J10pLFxuICAgICAgICB9KSxcbiAgICAgIF0pLFxuICAgIH0sXG4gIH0pO1xufSk7XG5cbnRlc3QoJ1N0YWNrIG91dHB1dHMgTVJBUCBhbGlhcyBhbmQgQVJOJywgKCkgPT4ge1xuICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ01yYXBBbGlhcycsIHt9KTtcbiAgdGVtcGxhdGUuaGFzT3V0cHV0KCdNcmFwQXJuJywge30pO1xufSk7XG4iXX0=