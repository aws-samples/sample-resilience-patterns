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
exports.RoutingLambdaStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const path = __importStar(require("path"));
class RoutingLambdaStack extends cdk.Stack {
    functionArn;
    constructor(scope, id, props) {
        super(scope, id, props);
        const mrapArn = props.mrapAlias
            ? `arn:aws:s3::${props.accountId}:accesspoint/${props.mrapAlias}`
            : `arn:aws:s3::${props.accountId}:accesspoint/*`;
        const routingFn = new lambda.Function(this, 'MrapRoutingFunction', {
            functionName: `${props.project}-mrap-routing`,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'mrap-routing')),
            timeout: cdk.Duration.minutes(2),
            reservedConcurrentExecutions: 5,
            environment: {
                ACCOUNT_ID: props.accountId,
                MRAP_ARN: `arn:aws:s3::${props.accountId}:accesspoint/${props.mrapAlias}`,
                PRIMARY_BUCKET: props.primaryBucketName,
                SECONDARY_BUCKET: props.secondaryBucketName,
                PRIMARY_REGION: props.primaryRegion,
                SECONDARY_REGION: props.secondaryRegion,
            },
        });
        routingFn.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                's3:SubmitMultiRegionAccessPointRoutes',
                's3:GetMultiRegionAccessPointRoutes',
            ],
            resources: [mrapArn],
        }));
        routingFn.addPermission('ArcInvoke', {
            principal: new iam.ServicePrincipal('arc-region-switch.amazonaws.com'),
            action: 'lambda:InvokeFunction',
        });
        this.functionArn = routingFn.functionArn;
        new cdk.CfnOutput(this, 'RoutingFunctionArn', { value: routingFn.functionArn });
    }
}
exports.RoutingLambdaStack = RoutingLambdaStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicm91dGluZy1sYW1iZGEtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyb3V0aW5nLWxhbWJkYS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMsK0RBQWlEO0FBQ2pELHlEQUEyQztBQUMzQywyQ0FBNkI7QUFhN0IsTUFBYSxrQkFBbUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQUMvQixXQUFXLENBQVM7SUFFcEMsWUFBWSxLQUFjLEVBQUUsRUFBVSxFQUFFLEtBQThCO1FBQ3BFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxTQUFTO1lBQzdCLENBQUMsQ0FBQyxlQUFlLEtBQUssQ0FBQyxTQUFTLGdCQUFnQixLQUFLLENBQUMsU0FBUyxFQUFFO1lBQ2pFLENBQUMsQ0FBQyxlQUFlLEtBQUssQ0FBQyxTQUFTLGdCQUFnQixDQUFDO1FBRW5ELE1BQU0sU0FBUyxHQUFHLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUscUJBQXFCLEVBQUU7WUFDakUsWUFBWSxFQUFFLEdBQUcsS0FBSyxDQUFDLE9BQU8sZUFBZTtZQUM3QyxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQ25DLE9BQU8sRUFBRSxlQUFlO1lBQ3hCLElBQUksRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLGNBQWMsQ0FBQyxDQUFDO1lBQ2pGLE9BQU8sRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7WUFDaEMsNEJBQTRCLEVBQUUsQ0FBQztZQUMvQixXQUFXLEVBQUU7Z0JBQ1gsVUFBVSxFQUFFLEtBQUssQ0FBQyxTQUFTO2dCQUMzQixRQUFRLEVBQUUsZUFBZSxLQUFLLENBQUMsU0FBUyxnQkFBZ0IsS0FBSyxDQUFDLFNBQVMsRUFBRTtnQkFDekUsY0FBYyxFQUFFLEtBQUssQ0FBQyxpQkFBaUI7Z0JBQ3ZDLGdCQUFnQixFQUFFLEtBQUssQ0FBQyxtQkFBbUI7Z0JBQzNDLGNBQWMsRUFBRSxLQUFLLENBQUMsYUFBYTtnQkFDbkMsZ0JBQWdCLEVBQUUsS0FBSyxDQUFDLGVBQWU7YUFDeEM7U0FDRixDQUFDLENBQUM7UUFFSCxTQUFTLENBQUMsZUFBZSxDQUFDLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUNoRCxPQUFPLEVBQUU7Z0JBQ1AsdUNBQXVDO2dCQUN2QyxvQ0FBb0M7YUFDckM7WUFDRCxTQUFTLEVBQUUsQ0FBQyxPQUFPLENBQUM7U0FDckIsQ0FBQyxDQUFDLENBQUM7UUFFSixTQUFTLENBQUMsYUFBYSxDQUFDLFdBQVcsRUFBRTtZQUNuQyxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMsaUNBQWlDLENBQUM7WUFDdEUsTUFBTSxFQUFFLHVCQUF1QjtTQUNoQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsV0FBVyxHQUFHLFNBQVMsQ0FBQyxXQUFXLENBQUM7UUFFekMsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRSxFQUFFLEtBQUssRUFBRSxTQUFTLENBQUMsV0FBVyxFQUFFLENBQUMsQ0FBQztJQUNsRixDQUFDO0NBQ0Y7QUE1Q0QsZ0RBNENDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUm91dGluZ0xhbWJkYVN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIHJlYWRvbmx5IHByb2plY3Q6IHN0cmluZztcbiAgcmVhZG9ubHkgcHJpbWFyeUJ1Y2tldE5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgc2Vjb25kYXJ5QnVja2V0TmFtZTogc3RyaW5nO1xuICByZWFkb25seSBwcmltYXJ5UmVnaW9uOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHNlY29uZGFyeVJlZ2lvbjogc3RyaW5nO1xuICByZWFkb25seSBhY2NvdW50SWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgbXJhcE5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgbXJhcEFsaWFzOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBSb3V0aW5nTGFtYmRhU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgZnVuY3Rpb25Bcm46IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogY2RrLkFwcCwgaWQ6IHN0cmluZywgcHJvcHM6IFJvdXRpbmdMYW1iZGFTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCBtcmFwQXJuID0gcHJvcHMubXJhcEFsaWFzXG4gICAgICA/IGBhcm46YXdzOnMzOjoke3Byb3BzLmFjY291bnRJZH06YWNjZXNzcG9pbnQvJHtwcm9wcy5tcmFwQWxpYXN9YFxuICAgICAgOiBgYXJuOmF3czpzMzo6JHtwcm9wcy5hY2NvdW50SWR9OmFjY2Vzc3BvaW50LypgO1xuXG4gICAgY29uc3Qgcm91dGluZ0ZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnTXJhcFJvdXRpbmdGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogYCR7cHJvcHMucHJvamVjdH0tbXJhcC1yb3V0aW5nYCxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEyLFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICdsYW1iZGEnLCAnbXJhcC1yb3V0aW5nJykpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMiksXG4gICAgICByZXNlcnZlZENvbmN1cnJlbnRFeGVjdXRpb25zOiA1LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQUNDT1VOVF9JRDogcHJvcHMuYWNjb3VudElkLFxuICAgICAgICBNUkFQX0FSTjogYGFybjphd3M6czM6OiR7cHJvcHMuYWNjb3VudElkfTphY2Nlc3Nwb2ludC8ke3Byb3BzLm1yYXBBbGlhc31gLFxuICAgICAgICBQUklNQVJZX0JVQ0tFVDogcHJvcHMucHJpbWFyeUJ1Y2tldE5hbWUsXG4gICAgICAgIFNFQ09OREFSWV9CVUNLRVQ6IHByb3BzLnNlY29uZGFyeUJ1Y2tldE5hbWUsXG4gICAgICAgIFBSSU1BUllfUkVHSU9OOiBwcm9wcy5wcmltYXJ5UmVnaW9uLFxuICAgICAgICBTRUNPTkRBUllfUkVHSU9OOiBwcm9wcy5zZWNvbmRhcnlSZWdpb24sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgcm91dGluZ0ZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdzMzpTdWJtaXRNdWx0aVJlZ2lvbkFjY2Vzc1BvaW50Um91dGVzJyxcbiAgICAgICAgJ3MzOkdldE11bHRpUmVnaW9uQWNjZXNzUG9pbnRSb3V0ZXMnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW21yYXBBcm5dLFxuICAgIH0pKTtcblxuICAgIHJvdXRpbmdGbi5hZGRQZXJtaXNzaW9uKCdBcmNJbnZva2UnLCB7XG4gICAgICBwcmluY2lwYWw6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnYXJjLXJlZ2lvbi1zd2l0Y2guYW1hem9uYXdzLmNvbScpLFxuICAgICAgYWN0aW9uOiAnbGFtYmRhOkludm9rZUZ1bmN0aW9uJyxcbiAgICB9KTtcblxuICAgIHRoaXMuZnVuY3Rpb25Bcm4gPSByb3V0aW5nRm4uZnVuY3Rpb25Bcm47XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUm91dGluZ0Z1bmN0aW9uQXJuJywgeyB2YWx1ZTogcm91dGluZ0ZuLmZ1bmN0aW9uQXJuIH0pO1xuICB9XG59XG4iXX0=