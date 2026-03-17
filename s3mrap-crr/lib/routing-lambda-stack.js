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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicm91dGluZy1sYW1iZGEtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyb3V0aW5nLWxhbWJkYS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMsK0RBQWlEO0FBQ2pELHlEQUEyQztBQUMzQywyQ0FBNkI7QUFhN0IsTUFBYSxrQkFBbUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQUMvQixXQUFXLENBQVM7SUFFcEMsWUFBWSxLQUFjLEVBQUUsRUFBVSxFQUFFLEtBQThCO1FBQ3BFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxTQUFTO1lBQzdCLENBQUMsQ0FBQyxlQUFlLEtBQUssQ0FBQyxTQUFTLGdCQUFnQixLQUFLLENBQUMsU0FBUyxFQUFFO1lBQ2pFLENBQUMsQ0FBQyxlQUFlLEtBQUssQ0FBQyxTQUFTLGdCQUFnQixDQUFDO1FBRW5ELE1BQU0sU0FBUyxHQUFHLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUscUJBQXFCLEVBQUU7WUFDakUsWUFBWSxFQUFFLEdBQUcsS0FBSyxDQUFDLE9BQU8sZUFBZTtZQUM3QyxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQ25DLE9BQU8sRUFBRSxlQUFlO1lBQ3hCLElBQUksRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLGNBQWMsQ0FBQyxDQUFDO1lBQ2pGLE9BQU8sRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7WUFDaEMsV0FBVyxFQUFFO2dCQUNYLFVBQVUsRUFBRSxLQUFLLENBQUMsU0FBUztnQkFDM0IsUUFBUSxFQUFFLGVBQWUsS0FBSyxDQUFDLFNBQVMsZ0JBQWdCLEtBQUssQ0FBQyxTQUFTLEVBQUU7Z0JBQ3pFLGNBQWMsRUFBRSxLQUFLLENBQUMsaUJBQWlCO2dCQUN2QyxnQkFBZ0IsRUFBRSxLQUFLLENBQUMsbUJBQW1CO2dCQUMzQyxjQUFjLEVBQUUsS0FBSyxDQUFDLGFBQWE7Z0JBQ25DLGdCQUFnQixFQUFFLEtBQUssQ0FBQyxlQUFlO2FBQ3hDO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsU0FBUyxDQUFDLGVBQWUsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7WUFDaEQsT0FBTyxFQUFFO2dCQUNQLHVDQUF1QztnQkFDdkMsb0NBQW9DO2FBQ3JDO1lBQ0QsU0FBUyxFQUFFLENBQUMsT0FBTyxDQUFDO1NBQ3JCLENBQUMsQ0FBQyxDQUFDO1FBRUosU0FBUyxDQUFDLGFBQWEsQ0FBQyxXQUFXLEVBQUU7WUFDbkMsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLGlDQUFpQyxDQUFDO1lBQ3RFLE1BQU0sRUFBRSx1QkFBdUI7U0FDaEMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLFdBQVcsR0FBRyxTQUFTLENBQUMsV0FBVyxDQUFDO1FBRXpDLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsb0JBQW9CLEVBQUUsRUFBRSxLQUFLLEVBQUUsU0FBUyxDQUFDLFdBQVcsRUFBRSxDQUFDLENBQUM7SUFDbEYsQ0FBQztDQUNGO0FBM0NELGdEQTJDQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFJvdXRpbmdMYW1iZGFTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICByZWFkb25seSBwcm9qZWN0OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHByaW1hcnlCdWNrZXROYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHNlY29uZGFyeUJ1Y2tldE5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgcHJpbWFyeVJlZ2lvbjogc3RyaW5nO1xuICByZWFkb25seSBzZWNvbmRhcnlSZWdpb246IHN0cmluZztcbiAgcmVhZG9ubHkgYWNjb3VudElkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG1yYXBOYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG1yYXBBbGlhczogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgUm91dGluZ0xhbWJkYVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IGZ1bmN0aW9uQXJuOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IGNkay5BcHAsIGlkOiBzdHJpbmcsIHByb3BzOiBSb3V0aW5nTGFtYmRhU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgbXJhcEFybiA9IHByb3BzLm1yYXBBbGlhc1xuICAgICAgPyBgYXJuOmF3czpzMzo6JHtwcm9wcy5hY2NvdW50SWR9OmFjY2Vzc3BvaW50LyR7cHJvcHMubXJhcEFsaWFzfWBcbiAgICAgIDogYGFybjphd3M6czM6OiR7cHJvcHMuYWNjb3VudElkfTphY2Nlc3Nwb2ludC8qYDtcblxuICAgIGNvbnN0IHJvdXRpbmdGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ01yYXBSb3V0aW5nRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6IGAke3Byb3BzLnByb2plY3R9LW1yYXAtcm91dGluZ2AsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4nLCAnbGFtYmRhJywgJ21yYXAtcm91dGluZycpKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDIpLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQUNDT1VOVF9JRDogcHJvcHMuYWNjb3VudElkLFxuICAgICAgICBNUkFQX0FSTjogYGFybjphd3M6czM6OiR7cHJvcHMuYWNjb3VudElkfTphY2Nlc3Nwb2ludC8ke3Byb3BzLm1yYXBBbGlhc31gLFxuICAgICAgICBQUklNQVJZX0JVQ0tFVDogcHJvcHMucHJpbWFyeUJ1Y2tldE5hbWUsXG4gICAgICAgIFNFQ09OREFSWV9CVUNLRVQ6IHByb3BzLnNlY29uZGFyeUJ1Y2tldE5hbWUsXG4gICAgICAgIFBSSU1BUllfUkVHSU9OOiBwcm9wcy5wcmltYXJ5UmVnaW9uLFxuICAgICAgICBTRUNPTkRBUllfUkVHSU9OOiBwcm9wcy5zZWNvbmRhcnlSZWdpb24sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgcm91dGluZ0ZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdzMzpTdWJtaXRNdWx0aVJlZ2lvbkFjY2Vzc1BvaW50Um91dGVzJyxcbiAgICAgICAgJ3MzOkdldE11bHRpUmVnaW9uQWNjZXNzUG9pbnRSb3V0ZXMnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW21yYXBBcm5dLFxuICAgIH0pKTtcblxuICAgIHJvdXRpbmdGbi5hZGRQZXJtaXNzaW9uKCdBcmNJbnZva2UnLCB7XG4gICAgICBwcmluY2lwYWw6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnYXJjLXJlZ2lvbi1zd2l0Y2guYW1hem9uYXdzLmNvbScpLFxuICAgICAgYWN0aW9uOiAnbGFtYmRhOkludm9rZUZ1bmN0aW9uJyxcbiAgICB9KTtcblxuICAgIHRoaXMuZnVuY3Rpb25Bcm4gPSByb3V0aW5nRm4uZnVuY3Rpb25Bcm47XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUm91dGluZ0Z1bmN0aW9uQXJuJywgeyB2YWx1ZTogcm91dGluZ0ZuLmZ1bmN0aW9uQXJuIH0pO1xuICB9XG59XG4iXX0=