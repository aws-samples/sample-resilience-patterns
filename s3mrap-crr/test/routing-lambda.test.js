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
const routing_lambda_stack_1 = require("../lib/routing-lambda-stack");
const app = new cdk.App();
const stack = new routing_lambda_stack_1.RoutingLambdaStack(app, 'TestRouting', {
    project: 's3mrap',
    primaryBucketName: 's3mrap-us-east-1-123456789012',
    secondaryBucketName: 's3mrap-us-west-2-123456789012',
    primaryRegion: 'us-east-1',
    secondaryRegion: 'us-west-2',
    accountId: '123456789012',
    mrapName: 's3mrap-mrap',
    mrapAlias: 'test-alias.mrap',
    env: { account: '123456789012', region: 'us-east-1' },
});
const template = assertions_1.Template.fromStack(stack);
test('Routing Lambda exists with correct name', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 's3mrap-mrap-routing',
        Runtime: 'python3.12',
    });
});
test('Routing Lambda has SubmitMultiRegionAccessPointRoutes permission', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
            Statement: assertions_1.Match.arrayWith([
                assertions_1.Match.objectLike({
                    Action: assertions_1.Match.arrayWith(['s3:SubmitMultiRegionAccessPointRoutes']),
                }),
            ]),
        },
    });
});
test('Routing Lambda grants ARC invoke permission', () => {
    template.hasResourceProperties('AWS::Lambda::Permission', {
        Action: 'lambda:InvokeFunction',
        Principal: 'arc-region-switch.amazonaws.com',
    });
});
test('Stack outputs routing function ARN', () => {
    template.hasOutput('RoutingFunctionArn', {});
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicm91dGluZy1sYW1iZGEudGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInJvdXRpbmctbGFtYmRhLnRlc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMsdURBQXlEO0FBQ3pELHNFQUFpRTtBQUVqRSxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUMxQixNQUFNLEtBQUssR0FBRyxJQUFJLHlDQUFrQixDQUFDLEdBQUcsRUFBRSxhQUFhLEVBQUU7SUFDdkQsT0FBTyxFQUFFLFFBQVE7SUFDakIsaUJBQWlCLEVBQUUsK0JBQStCO0lBQ2xELG1CQUFtQixFQUFFLCtCQUErQjtJQUNwRCxhQUFhLEVBQUUsV0FBVztJQUMxQixlQUFlLEVBQUUsV0FBVztJQUM1QixTQUFTLEVBQUUsY0FBYztJQUN6QixRQUFRLEVBQUUsYUFBYTtJQUN2QixTQUFTLEVBQUUsaUJBQWlCO0lBQzVCLEdBQUcsRUFBRSxFQUFFLE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxFQUFFLFdBQVcsRUFBRTtDQUN0RCxDQUFDLENBQUM7QUFDSCxNQUFNLFFBQVEsR0FBRyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUUzQyxJQUFJLENBQUMseUNBQXlDLEVBQUUsR0FBRyxFQUFFO0lBQ25ELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyx1QkFBdUIsRUFBRTtRQUN0RCxZQUFZLEVBQUUscUJBQXFCO1FBQ25DLE9BQU8sRUFBRSxZQUFZO0tBQ3RCLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDO0FBRUgsSUFBSSxDQUFDLGtFQUFrRSxFQUFFLEdBQUcsRUFBRTtJQUM1RSxRQUFRLENBQUMscUJBQXFCLENBQUMsa0JBQWtCLEVBQUU7UUFDakQsY0FBYyxFQUFFO1lBQ2QsU0FBUyxFQUFFLGtCQUFLLENBQUMsU0FBUyxDQUFDO2dCQUN6QixrQkFBSyxDQUFDLFVBQVUsQ0FBQztvQkFDZixNQUFNLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQyx1Q0FBdUMsQ0FBQyxDQUFDO2lCQUNuRSxDQUFDO2FBQ0gsQ0FBQztTQUNIO0tBQ0YsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUM7QUFFSCxJQUFJLENBQUMsNkNBQTZDLEVBQUUsR0FBRyxFQUFFO0lBQ3ZELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyx5QkFBeUIsRUFBRTtRQUN4RCxNQUFNLEVBQUUsdUJBQXVCO1FBQy9CLFNBQVMsRUFBRSxpQ0FBaUM7S0FDN0MsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUM7QUFFSCxJQUFJLENBQUMsb0NBQW9DLEVBQUUsR0FBRyxFQUFFO0lBQzlDLFFBQVEsQ0FBQyxTQUFTLENBQUMsb0JBQW9CLEVBQUUsRUFBRSxDQUFDLENBQUM7QUFDL0MsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgVGVtcGxhdGUsIE1hdGNoIH0gZnJvbSAnYXdzLWNkay1saWIvYXNzZXJ0aW9ucyc7XG5pbXBvcnQgeyBSb3V0aW5nTGFtYmRhU3RhY2sgfSBmcm9tICcuLi9saWIvcm91dGluZy1sYW1iZGEtc3RhY2snO1xuXG5jb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuY29uc3Qgc3RhY2sgPSBuZXcgUm91dGluZ0xhbWJkYVN0YWNrKGFwcCwgJ1Rlc3RSb3V0aW5nJywge1xuICBwcm9qZWN0OiAnczNtcmFwJyxcbiAgcHJpbWFyeUJ1Y2tldE5hbWU6ICdzM21yYXAtdXMtZWFzdC0xLTEyMzQ1Njc4OTAxMicsXG4gIHNlY29uZGFyeUJ1Y2tldE5hbWU6ICdzM21yYXAtdXMtd2VzdC0yLTEyMzQ1Njc4OTAxMicsXG4gIHByaW1hcnlSZWdpb246ICd1cy1lYXN0LTEnLFxuICBzZWNvbmRhcnlSZWdpb246ICd1cy13ZXN0LTInLFxuICBhY2NvdW50SWQ6ICcxMjM0NTY3ODkwMTInLFxuICBtcmFwTmFtZTogJ3MzbXJhcC1tcmFwJyxcbiAgbXJhcEFsaWFzOiAndGVzdC1hbGlhcy5tcmFwJyxcbiAgZW52OiB7IGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLCByZWdpb246ICd1cy1lYXN0LTEnIH0sXG59KTtcbmNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxudGVzdCgnUm91dGluZyBMYW1iZGEgZXhpc3RzIHdpdGggY29ycmVjdCBuYW1lJywgKCkgPT4ge1xuICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6TGFtYmRhOjpGdW5jdGlvbicsIHtcbiAgICBGdW5jdGlvbk5hbWU6ICdzM21yYXAtbXJhcC1yb3V0aW5nJyxcbiAgICBSdW50aW1lOiAncHl0aG9uMy4xMicsXG4gIH0pO1xufSk7XG5cbnRlc3QoJ1JvdXRpbmcgTGFtYmRhIGhhcyBTdWJtaXRNdWx0aVJlZ2lvbkFjY2Vzc1BvaW50Um91dGVzIHBlcm1pc3Npb24nLCAoKSA9PiB7XG4gIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpJQU06OlBvbGljeScsIHtcbiAgICBQb2xpY3lEb2N1bWVudDoge1xuICAgICAgU3RhdGVtZW50OiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICBBY3Rpb246IE1hdGNoLmFycmF5V2l0aChbJ3MzOlN1Ym1pdE11bHRpUmVnaW9uQWNjZXNzUG9pbnRSb3V0ZXMnXSksXG4gICAgICAgIH0pLFxuICAgICAgXSksXG4gICAgfSxcbiAgfSk7XG59KTtcblxudGVzdCgnUm91dGluZyBMYW1iZGEgZ3JhbnRzIEFSQyBpbnZva2UgcGVybWlzc2lvbicsICgpID0+IHtcbiAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkxhbWJkYTo6UGVybWlzc2lvbicsIHtcbiAgICBBY3Rpb246ICdsYW1iZGE6SW52b2tlRnVuY3Rpb24nLFxuICAgIFByaW5jaXBhbDogJ2FyYy1yZWdpb24tc3dpdGNoLmFtYXpvbmF3cy5jb20nLFxuICB9KTtcbn0pO1xuXG50ZXN0KCdTdGFjayBvdXRwdXRzIHJvdXRpbmcgZnVuY3Rpb24gQVJOJywgKCkgPT4ge1xuICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1JvdXRpbmdGdW5jdGlvbkFybicsIHt9KTtcbn0pO1xuIl19