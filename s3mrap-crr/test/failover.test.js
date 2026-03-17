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
const failover_stack_1 = require("../lib/failover-stack");
const app = new cdk.App();
const stack = new failover_stack_1.FailoverStack(app, 'TestFailover', {
    project: 's3mrap',
    primaryBucketName: 's3mrap-us-east-1-123456789012',
    secondaryBucketName: 's3mrap-us-west-2-123456789012',
    primaryRegion: 'us-east-1',
    secondaryRegion: 'us-west-2',
    accountId: '123456789012',
    mrapName: 's3mrap-mrap',
    primaryRoutingLambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:s3mrap-mrap-routing',
    secondaryRoutingLambdaArn: 'arn:aws:lambda:us-west-2:123456789012:function:s3mrap-mrap-routing',
    env: { account: '123456789012', region: 'us-east-1' },
});
const template = assertions_1.Template.fromStack(stack);
test('ARC plan uses Name property (not PlanName)', () => {
    template.hasResourceProperties('AWS::ARCRegionSwitch::Plan', {
        Name: 's3mrap-region-switch',
    });
});
test('ARC plan Regions is a string array', () => {
    template.hasResourceProperties('AWS::ARCRegionSwitch::Plan', {
        Regions: ['us-east-1', 'us-west-2'],
    });
});
test('ARC plan has PrimaryRegion', () => {
    template.hasResourceProperties('AWS::ARCRegionSwitch::Plan', {
        PrimaryRegion: 'us-east-1',
    });
});
test('ARC plan has ExecutionRole', () => {
    template.hasResourceProperties('AWS::ARCRegionSwitch::Plan', {
        ExecutionRole: assertions_1.Match.anyValue(),
    });
});
test('ARC plan lists Lambda ARNs for both regions', () => {
    template.hasResourceProperties('AWS::ARCRegionSwitch::Plan', {
        Workflows: assertions_1.Match.arrayWith([
            assertions_1.Match.objectLike({
                Steps: assertions_1.Match.arrayWith([
                    assertions_1.Match.objectLike({
                        ExecutionBlockConfiguration: {
                            CustomActionLambdaConfig: assertions_1.Match.objectLike({
                                Lambdas: [
                                    { Arn: 'arn:aws:lambda:us-east-1:123456789012:function:s3mrap-mrap-routing' },
                                    { Arn: 'arn:aws:lambda:us-west-2:123456789012:function:s3mrap-mrap-routing' },
                                ],
                            }),
                        },
                    }),
                ]),
            }),
        ]),
    });
});
test('ARC execution role trusts arc-region-switch.amazonaws.com', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
            Statement: assertions_1.Match.arrayWith([
                assertions_1.Match.objectLike({
                    Principal: { Service: 'arc-region-switch.amazonaws.com' },
                }),
            ]),
        },
    });
});
test('ARC execution role has invoke permission for both Lambda ARNs', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
            Statement: assertions_1.Match.arrayWith([
                assertions_1.Match.objectLike({
                    Action: assertions_1.Match.arrayWith(['lambda:InvokeFunction']),
                    Resource: [
                        'arn:aws:lambda:us-east-1:123456789012:function:s3mrap-mrap-routing',
                        'arn:aws:lambda:us-west-2:123456789012:function:s3mrap-mrap-routing',
                    ],
                }),
            ]),
        },
    });
});
test('Load test Lambda has 15 minute timeout', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 's3mrap-load-test',
        Timeout: 900,
    });
});
test('SSM Automation Document exists with correct parameters', () => {
    template.hasResourceProperties('AWS::SSM::Document', {
        DocumentType: 'Automation',
        Name: 's3mrap-load-test',
    });
});
test('SSM Document parameters are all String type (not Integer)', () => {
    const docs = template.findResources('AWS::SSM::Document');
    for (const [, doc] of Object.entries(docs)) {
        const params = doc.Properties.Content.parameters;
        for (const [name, param] of Object.entries(params)) {
            expect(param.type).toBe('String');
        }
    }
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZmFpbG92ZXIudGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImZhaWxvdmVyLnRlc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMsdURBQXlEO0FBQ3pELDBEQUFzRDtBQUV0RCxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUMxQixNQUFNLEtBQUssR0FBRyxJQUFJLDhCQUFhLENBQUMsR0FBRyxFQUFFLGNBQWMsRUFBRTtJQUNuRCxPQUFPLEVBQUUsUUFBUTtJQUNqQixpQkFBaUIsRUFBRSwrQkFBK0I7SUFDbEQsbUJBQW1CLEVBQUUsK0JBQStCO0lBQ3BELGFBQWEsRUFBRSxXQUFXO0lBQzFCLGVBQWUsRUFBRSxXQUFXO0lBQzVCLFNBQVMsRUFBRSxjQUFjO0lBQ3pCLFFBQVEsRUFBRSxhQUFhO0lBQ3ZCLHVCQUF1QixFQUFFLG9FQUFvRTtJQUM3Rix5QkFBeUIsRUFBRSxvRUFBb0U7SUFDL0YsR0FBRyxFQUFFLEVBQUUsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLEVBQUUsV0FBVyxFQUFFO0NBQ3RELENBQUMsQ0FBQztBQUNILE1BQU0sUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBRTNDLElBQUksQ0FBQyw0Q0FBNEMsRUFBRSxHQUFHLEVBQUU7SUFDdEQsUUFBUSxDQUFDLHFCQUFxQixDQUFDLDRCQUE0QixFQUFFO1FBQzNELElBQUksRUFBRSxzQkFBc0I7S0FDN0IsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUM7QUFFSCxJQUFJLENBQUMsb0NBQW9DLEVBQUUsR0FBRyxFQUFFO0lBQzlDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyw0QkFBNEIsRUFBRTtRQUMzRCxPQUFPLEVBQUUsQ0FBQyxXQUFXLEVBQUUsV0FBVyxDQUFDO0tBQ3BDLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDO0FBRUgsSUFBSSxDQUFDLDRCQUE0QixFQUFFLEdBQUcsRUFBRTtJQUN0QyxRQUFRLENBQUMscUJBQXFCLENBQUMsNEJBQTRCLEVBQUU7UUFDM0QsYUFBYSxFQUFFLFdBQVc7S0FDM0IsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUM7QUFFSCxJQUFJLENBQUMsNEJBQTRCLEVBQUUsR0FBRyxFQUFFO0lBQ3RDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyw0QkFBNEIsRUFBRTtRQUMzRCxhQUFhLEVBQUUsa0JBQUssQ0FBQyxRQUFRLEVBQUU7S0FDaEMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUM7QUFFSCxJQUFJLENBQUMsNkNBQTZDLEVBQUUsR0FBRyxFQUFFO0lBQ3ZELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyw0QkFBNEIsRUFBRTtRQUMzRCxTQUFTLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUM7WUFDekIsa0JBQUssQ0FBQyxVQUFVLENBQUM7Z0JBQ2YsS0FBSyxFQUFFLGtCQUFLLENBQUMsU0FBUyxDQUFDO29CQUNyQixrQkFBSyxDQUFDLFVBQVUsQ0FBQzt3QkFDZiwyQkFBMkIsRUFBRTs0QkFDM0Isd0JBQXdCLEVBQUUsa0JBQUssQ0FBQyxVQUFVLENBQUM7Z0NBQ3pDLE9BQU8sRUFBRTtvQ0FDUCxFQUFFLEdBQUcsRUFBRSxvRUFBb0UsRUFBRTtvQ0FDN0UsRUFBRSxHQUFHLEVBQUUsb0VBQW9FLEVBQUU7aUNBQzlFOzZCQUNGLENBQUM7eUJBQ0g7cUJBQ0YsQ0FBQztpQkFDSCxDQUFDO2FBQ0gsQ0FBQztTQUNILENBQUM7S0FDSCxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQztBQUVILElBQUksQ0FBQywyREFBMkQsRUFBRSxHQUFHLEVBQUU7SUFDckUsUUFBUSxDQUFDLHFCQUFxQixDQUFDLGdCQUFnQixFQUFFO1FBQy9DLHdCQUF3QixFQUFFO1lBQ3hCLFNBQVMsRUFBRSxrQkFBSyxDQUFDLFNBQVMsQ0FBQztnQkFDekIsa0JBQUssQ0FBQyxVQUFVLENBQUM7b0JBQ2YsU0FBUyxFQUFFLEVBQUUsT0FBTyxFQUFFLGlDQUFpQyxFQUFFO2lCQUMxRCxDQUFDO2FBQ0gsQ0FBQztTQUNIO0tBQ0YsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUM7QUFFSCxJQUFJLENBQUMsK0RBQStELEVBQUUsR0FBRyxFQUFFO0lBQ3pFLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxrQkFBa0IsRUFBRTtRQUNqRCxjQUFjLEVBQUU7WUFDZCxTQUFTLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUM7Z0JBQ3pCLGtCQUFLLENBQUMsVUFBVSxDQUFDO29CQUNmLE1BQU0sRUFBRSxrQkFBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDLHVCQUF1QixDQUFDLENBQUM7b0JBQ2xELFFBQVEsRUFBRTt3QkFDUixvRUFBb0U7d0JBQ3BFLG9FQUFvRTtxQkFDckU7aUJBQ0YsQ0FBQzthQUNILENBQUM7U0FDSDtLQUNGLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDO0FBRUgsSUFBSSxDQUFDLHdDQUF3QyxFQUFFLEdBQUcsRUFBRTtJQUNsRCxRQUFRLENBQUMscUJBQXFCLENBQUMsdUJBQXVCLEVBQUU7UUFDdEQsWUFBWSxFQUFFLGtCQUFrQjtRQUNoQyxPQUFPLEVBQUUsR0FBRztLQUNiLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDO0FBRUgsSUFBSSxDQUFDLHdEQUF3RCxFQUFFLEdBQUcsRUFBRTtJQUNsRSxRQUFRLENBQUMscUJBQXFCLENBQUMsb0JBQW9CLEVBQUU7UUFDbkQsWUFBWSxFQUFFLFlBQVk7UUFDMUIsSUFBSSxFQUFFLGtCQUFrQjtLQUN6QixDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQztBQUVILElBQUksQ0FBQywyREFBMkQsRUFBRSxHQUFHLEVBQUU7SUFDckUsTUFBTSxJQUFJLEdBQUcsUUFBUSxDQUFDLGFBQWEsQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO0lBQzFELEtBQUssTUFBTSxDQUFDLEVBQUUsR0FBRyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQzNDLE1BQU0sTUFBTSxHQUFJLEdBQVcsQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQztRQUMxRCxLQUFLLE1BQU0sQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1lBQ25ELE1BQU0sQ0FBRSxLQUFhLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQzdDLENBQUM7SUFDSCxDQUFDO0FBQ0gsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgVGVtcGxhdGUsIE1hdGNoIH0gZnJvbSAnYXdzLWNkay1saWIvYXNzZXJ0aW9ucyc7XG5pbXBvcnQgeyBGYWlsb3ZlclN0YWNrIH0gZnJvbSAnLi4vbGliL2ZhaWxvdmVyLXN0YWNrJztcblxuY29uc3QgYXBwID0gbmV3IGNkay5BcHAoKTtcbmNvbnN0IHN0YWNrID0gbmV3IEZhaWxvdmVyU3RhY2soYXBwLCAnVGVzdEZhaWxvdmVyJywge1xuICBwcm9qZWN0OiAnczNtcmFwJyxcbiAgcHJpbWFyeUJ1Y2tldE5hbWU6ICdzM21yYXAtdXMtZWFzdC0xLTEyMzQ1Njc4OTAxMicsXG4gIHNlY29uZGFyeUJ1Y2tldE5hbWU6ICdzM21yYXAtdXMtd2VzdC0yLTEyMzQ1Njc4OTAxMicsXG4gIHByaW1hcnlSZWdpb246ICd1cy1lYXN0LTEnLFxuICBzZWNvbmRhcnlSZWdpb246ICd1cy13ZXN0LTInLFxuICBhY2NvdW50SWQ6ICcxMjM0NTY3ODkwMTInLFxuICBtcmFwTmFtZTogJ3MzbXJhcC1tcmFwJyxcbiAgcHJpbWFyeVJvdXRpbmdMYW1iZGFBcm46ICdhcm46YXdzOmxhbWJkYTp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOmZ1bmN0aW9uOnMzbXJhcC1tcmFwLXJvdXRpbmcnLFxuICBzZWNvbmRhcnlSb3V0aW5nTGFtYmRhQXJuOiAnYXJuOmF3czpsYW1iZGE6dXMtd2VzdC0yOjEyMzQ1Njc4OTAxMjpmdW5jdGlvbjpzM21yYXAtbXJhcC1yb3V0aW5nJyxcbiAgZW52OiB7IGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLCByZWdpb246ICd1cy1lYXN0LTEnIH0sXG59KTtcbmNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxudGVzdCgnQVJDIHBsYW4gdXNlcyBOYW1lIHByb3BlcnR5IChub3QgUGxhbk5hbWUpJywgKCkgPT4ge1xuICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QVJDUmVnaW9uU3dpdGNoOjpQbGFuJywge1xuICAgIE5hbWU6ICdzM21yYXAtcmVnaW9uLXN3aXRjaCcsXG4gIH0pO1xufSk7XG5cbnRlc3QoJ0FSQyBwbGFuIFJlZ2lvbnMgaXMgYSBzdHJpbmcgYXJyYXknLCAoKSA9PiB7XG4gIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpBUkNSZWdpb25Td2l0Y2g6OlBsYW4nLCB7XG4gICAgUmVnaW9uczogWyd1cy1lYXN0LTEnLCAndXMtd2VzdC0yJ10sXG4gIH0pO1xufSk7XG5cbnRlc3QoJ0FSQyBwbGFuIGhhcyBQcmltYXJ5UmVnaW9uJywgKCkgPT4ge1xuICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QVJDUmVnaW9uU3dpdGNoOjpQbGFuJywge1xuICAgIFByaW1hcnlSZWdpb246ICd1cy1lYXN0LTEnLFxuICB9KTtcbn0pO1xuXG50ZXN0KCdBUkMgcGxhbiBoYXMgRXhlY3V0aW9uUm9sZScsICgpID0+IHtcbiAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFSQ1JlZ2lvblN3aXRjaDo6UGxhbicsIHtcbiAgICBFeGVjdXRpb25Sb2xlOiBNYXRjaC5hbnlWYWx1ZSgpLFxuICB9KTtcbn0pO1xuXG50ZXN0KCdBUkMgcGxhbiBsaXN0cyBMYW1iZGEgQVJOcyBmb3IgYm90aCByZWdpb25zJywgKCkgPT4ge1xuICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QVJDUmVnaW9uU3dpdGNoOjpQbGFuJywge1xuICAgIFdvcmtmbG93czogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICBTdGVwczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICAgIEV4ZWN1dGlvbkJsb2NrQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgICAgICBDdXN0b21BY3Rpb25MYW1iZGFDb25maWc6IE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgICAgICAgIExhbWJkYXM6IFtcbiAgICAgICAgICAgICAgICAgIHsgQXJuOiAnYXJuOmF3czpsYW1iZGE6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjpmdW5jdGlvbjpzM21yYXAtbXJhcC1yb3V0aW5nJyB9LFxuICAgICAgICAgICAgICAgICAgeyBBcm46ICdhcm46YXdzOmxhbWJkYTp1cy13ZXN0LTI6MTIzNDU2Nzg5MDEyOmZ1bmN0aW9uOnMzbXJhcC1tcmFwLXJvdXRpbmcnIH0sXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pLFxuICAgICAgICBdKSxcbiAgICAgIH0pLFxuICAgIF0pLFxuICB9KTtcbn0pO1xuXG50ZXN0KCdBUkMgZXhlY3V0aW9uIHJvbGUgdHJ1c3RzIGFyYy1yZWdpb24tc3dpdGNoLmFtYXpvbmF3cy5jb20nLCAoKSA9PiB7XG4gIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpJQU06OlJvbGUnLCB7XG4gICAgQXNzdW1lUm9sZVBvbGljeURvY3VtZW50OiB7XG4gICAgICBTdGF0ZW1lbnQ6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgIFByaW5jaXBhbDogeyBTZXJ2aWNlOiAnYXJjLXJlZ2lvbi1zd2l0Y2guYW1hem9uYXdzLmNvbScgfSxcbiAgICAgICAgfSksXG4gICAgICBdKSxcbiAgICB9LFxuICB9KTtcbn0pO1xuXG50ZXN0KCdBUkMgZXhlY3V0aW9uIHJvbGUgaGFzIGludm9rZSBwZXJtaXNzaW9uIGZvciBib3RoIExhbWJkYSBBUk5zJywgKCkgPT4ge1xuICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6SUFNOjpQb2xpY3knLCB7XG4gICAgUG9saWN5RG9jdW1lbnQ6IHtcbiAgICAgIFN0YXRlbWVudDogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgQWN0aW9uOiBNYXRjaC5hcnJheVdpdGgoWydsYW1iZGE6SW52b2tlRnVuY3Rpb24nXSksXG4gICAgICAgICAgUmVzb3VyY2U6IFtcbiAgICAgICAgICAgICdhcm46YXdzOmxhbWJkYTp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOmZ1bmN0aW9uOnMzbXJhcC1tcmFwLXJvdXRpbmcnLFxuICAgICAgICAgICAgJ2Fybjphd3M6bGFtYmRhOnVzLXdlc3QtMjoxMjM0NTY3ODkwMTI6ZnVuY3Rpb246czNtcmFwLW1yYXAtcm91dGluZycsXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICBdKSxcbiAgICB9LFxuICB9KTtcbn0pO1xuXG50ZXN0KCdMb2FkIHRlc3QgTGFtYmRhIGhhcyAxNSBtaW51dGUgdGltZW91dCcsICgpID0+IHtcbiAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkxhbWJkYTo6RnVuY3Rpb24nLCB7XG4gICAgRnVuY3Rpb25OYW1lOiAnczNtcmFwLWxvYWQtdGVzdCcsXG4gICAgVGltZW91dDogOTAwLFxuICB9KTtcbn0pO1xuXG50ZXN0KCdTU00gQXV0b21hdGlvbiBEb2N1bWVudCBleGlzdHMgd2l0aCBjb3JyZWN0IHBhcmFtZXRlcnMnLCAoKSA9PiB7XG4gIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTU006OkRvY3VtZW50Jywge1xuICAgIERvY3VtZW50VHlwZTogJ0F1dG9tYXRpb24nLFxuICAgIE5hbWU6ICdzM21yYXAtbG9hZC10ZXN0JyxcbiAgfSk7XG59KTtcblxudGVzdCgnU1NNIERvY3VtZW50IHBhcmFtZXRlcnMgYXJlIGFsbCBTdHJpbmcgdHlwZSAobm90IEludGVnZXIpJywgKCkgPT4ge1xuICBjb25zdCBkb2NzID0gdGVtcGxhdGUuZmluZFJlc291cmNlcygnQVdTOjpTU006OkRvY3VtZW50Jyk7XG4gIGZvciAoY29uc3QgWywgZG9jXSBvZiBPYmplY3QuZW50cmllcyhkb2NzKSkge1xuICAgIGNvbnN0IHBhcmFtcyA9IChkb2MgYXMgYW55KS5Qcm9wZXJ0aWVzLkNvbnRlbnQucGFyYW1ldGVycztcbiAgICBmb3IgKGNvbnN0IFtuYW1lLCBwYXJhbV0gb2YgT2JqZWN0LmVudHJpZXMocGFyYW1zKSkge1xuICAgICAgZXhwZWN0KChwYXJhbSBhcyBhbnkpLnR5cGUpLnRvQmUoJ1N0cmluZycpO1xuICAgIH1cbiAgfVxufSk7XG4iXX0=