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
exports.FailoverStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const ssm = __importStar(require("aws-cdk-lib/aws-ssm"));
const path = __importStar(require("path"));
class FailoverStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // --- Load Test Lambda ---
        const loadTestFn = new lambda.Function(this, 'LoadTestFunction', {
            functionName: `${props.project}-load-test`,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'load-test')),
            timeout: cdk.Duration.minutes(15),
            memorySize: 512,
            environment: {
                PRIMARY_BUCKET: props.primaryBucketName,
                SECONDARY_BUCKET: props.secondaryBucketName,
                PRIMARY_REGION: props.primaryRegion,
                SECONDARY_REGION: props.secondaryRegion,
            },
        });
        loadTestFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['s3:PutObject', 's3:GetObject', 's3:HeadObject', 's3:ListBucket'],
            resources: [
                `arn:aws:s3:::${props.primaryBucketName}`,
                `arn:aws:s3:::${props.primaryBucketName}/*`,
                `arn:aws:s3:::${props.secondaryBucketName}`,
                `arn:aws:s3:::${props.secondaryBucketName}/*`,
            ],
        }));
        // --- SSM Automation Document for Load Test ---
        new ssm.CfnDocument(this, 'LoadTestDocument', {
            name: `${props.project}-load-test`,
            documentType: 'Automation',
            content: {
                schemaVersion: '0.3',
                description: 'Run S3 CRR replication latency load test',
                parameters: {
                    SourceRegion: {
                        type: 'String',
                        default: props.primaryRegion,
                        allowedValues: [props.primaryRegion, props.secondaryRegion],
                        description: 'Region to upload objects to',
                    },
                    DestRegion: {
                        type: 'String',
                        default: props.secondaryRegion,
                        allowedValues: [props.primaryRegion, props.secondaryRegion],
                        description: 'Region to check replication in',
                    },
                    ObjectCount: {
                        type: 'String',
                        default: '100',
                        description: 'Number of objects to upload',
                    },
                    ObjectSizeKB: {
                        type: 'String',
                        default: '10',
                        description: 'Size of each object in KB',
                    },
                    TimeoutSeconds: {
                        type: 'String',
                        default: '300',
                        description: 'Max seconds to wait for replication per object',
                    },
                },
                mainSteps: [{
                        name: 'RunLoadTest',
                        action: 'aws:invokeLambdaFunction',
                        inputs: {
                            FunctionName: loadTestFn.functionName,
                            Payload: '{"sourceRegion":"{{SourceRegion}}","destRegion":"{{DestRegion}}","objectCount":{{ObjectCount}},"objectSizeKB":{{ObjectSizeKB}},"timeoutSeconds":{{TimeoutSeconds}}}',
                        },
                    }],
            },
        });
        // --- ARC Region Switch Plan ---
        const arcExecutionRole = new iam.Role(this, 'ArcExecutionRole', {
            assumedBy: new iam.ServicePrincipal('arc-region-switch.amazonaws.com'),
        });
        arcExecutionRole.addToPolicy(new iam.PolicyStatement({
            actions: ['lambda:InvokeFunction', 'lambda:GetFunction'],
            resources: [props.primaryRoutingLambdaArn, props.secondaryRoutingLambdaArn],
        }));
        new cdk.CfnResource(this, 'ArcRegionSwitchPlan', {
            type: 'AWS::ARCRegionSwitch::Plan',
            properties: {
                Name: `${props.project}-region-switch`,
                RecoveryApproach: 'activePassive',
                PrimaryRegion: props.primaryRegion,
                Regions: [props.primaryRegion, props.secondaryRegion],
                ExecutionRole: arcExecutionRole.roleArn,
                Workflows: [{
                        WorkflowTargetAction: 'activate',
                        WorkflowDescription: 'Update MRAP routing to send traffic to the activating region',
                        Steps: [{
                                Name: 'update-mrap-routing',
                                ExecutionBlockType: 'CustomActionLambda',
                                ExecutionBlockConfiguration: {
                                    CustomActionLambdaConfig: {
                                        RegionToRun: 'activatingRegion',
                                        TimeoutMinutes: 2,
                                        RetryIntervalMinutes: 1,
                                        Lambdas: [
                                            { Arn: props.primaryRoutingLambdaArn },
                                            { Arn: props.secondaryRoutingLambdaArn },
                                        ],
                                    },
                                },
                            }],
                    }],
            },
        });
        new cdk.CfnOutput(this, 'LoadTestFunctionArn', { value: loadTestFn.functionArn });
        new cdk.CfnOutput(this, 'LoadTestDocumentName', { value: `${props.project}-load-test` });
    }
}
exports.FailoverStack = FailoverStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZmFpbG92ZXItc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJmYWlsb3Zlci1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMsK0RBQWlEO0FBQ2pELHlEQUEyQztBQUMzQyx5REFBMkM7QUFDM0MsMkNBQTZCO0FBYzdCLE1BQWEsYUFBYyxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQzFDLFlBQVksS0FBYyxFQUFFLEVBQVUsRUFBRSxLQUF5QjtRQUMvRCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QiwyQkFBMkI7UUFDM0IsTUFBTSxVQUFVLEdBQUcsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtZQUMvRCxZQUFZLEVBQUUsR0FBRyxLQUFLLENBQUMsT0FBTyxZQUFZO1lBQzFDLE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDbkMsT0FBTyxFQUFFLGVBQWU7WUFDeEIsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsV0FBVyxDQUFDLENBQUM7WUFDOUUsT0FBTyxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUNqQyxVQUFVLEVBQUUsR0FBRztZQUNmLFdBQVcsRUFBRTtnQkFDWCxjQUFjLEVBQUUsS0FBSyxDQUFDLGlCQUFpQjtnQkFDdkMsZ0JBQWdCLEVBQUUsS0FBSyxDQUFDLG1CQUFtQjtnQkFDM0MsY0FBYyxFQUFFLEtBQUssQ0FBQyxhQUFhO2dCQUNuQyxnQkFBZ0IsRUFBRSxLQUFLLENBQUMsZUFBZTthQUN4QztTQUNGLENBQUMsQ0FBQztRQUVILFVBQVUsQ0FBQyxlQUFlLENB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Q0FBQyxhQUFhLEVBQUUsS0FBSyxDQUFDLGVBQWUsQ0FBQztnQkFDckQsYUFBYSxFQUFFLGdCQUFnQixDQUFDLE9BQU87Z0JBQ3ZDLFNBQVMsRUFBRSxDQUFDO3dCQUNWLG9CQUFvQixFQUFFLFVBQVU7d0JBQ2hDLG1CQUFtQixFQUFFLDhEQUE4RDt3QkFDbkYsS0FBSyxFQUFFLENBQUM7Z0NBQ04sSUFBSSxFQUFFLHFCQUFxQjtnQ0FDM0Isa0JBQWtCLEVBQUUsb0JBQW9CO2dDQUN4QywyQkFBMkIsRUFBRTtvQ0FDM0Isd0JBQXdCLEVBQUU7d0NBQ3hCLFdBQVcsRUFBRSxrQkFBa0I7d0NBQy9CLGNBQWMsRUFBRSxDQUFDO3dDQUNqQixvQkFBb0IsRUFBRSxDQUFDO3dDQUN2QixPQUFPLEVBQUU7NENBQ1AsRUFBRSxHQUFHLEVBQUUsS0FBSyxDQUFDLHVCQUF1QixFQUFFOzRDQUN0QyxFQUFFLEdBQUcsRUFBRSxLQUFLLENBQUMseUJBQXlCLEVBQUU7eUNBQ3pDO3FDQUNGO2lDQUNGOzZCQUNGLENBQUM7cUJBQ0gsQ0FBQzthQUNIO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxxQkFBcUIsRUFBRSxFQUFFLEtBQUssRUFBRSxVQUFVLENBQUMsV0FBVyxFQUFFLENBQUMsQ0FBQztRQUNsRixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHNCQUFzQixFQUFFLEVBQUUsS0FBSyxFQUFFLEdBQUcsS0FBSyxDQUFDLE9BQU8sWUFBWSxFQUFFLENBQUMsQ0FBQztJQUMzRixDQUFDO0NBQ0Y7QUF4SEQsc0NBd0hDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIHNzbSBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc3NtJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRmFpbG92ZXJTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICByZWFkb25seSBwcm9qZWN0OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHByaW1hcnlCdWNrZXROYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHNlY29uZGFyeUJ1Y2tldE5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgcHJpbWFyeVJlZ2lvbjogc3RyaW5nO1xuICByZWFkb25seSBzZWNvbmRhcnlSZWdpb246IHN0cmluZztcbiAgcmVhZG9ubHkgYWNjb3VudElkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG1yYXBOYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHByaW1hcnlSb3V0aW5nTGFtYmRhQXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHNlY29uZGFyeVJvdXRpbmdMYW1iZGFBcm46IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEZhaWxvdmVyU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogY2RrLkFwcCwgaWQ6IHN0cmluZywgcHJvcHM6IEZhaWxvdmVyU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gLS0tIExvYWQgVGVzdCBMYW1iZGEgLS0tXG4gICAgY29uc3QgbG9hZFRlc3RGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0xvYWRUZXN0RnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6IGAke3Byb3BzLnByb2plY3R9LWxvYWQtdGVzdGAsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4nLCAnbGFtYmRhJywgJ2xvYWQtdGVzdCcpKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDE1KSxcbiAgICAgIG1lbW9yeVNpemU6IDUxMixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFBSSU1BUllfQlVDS0VUOiBwcm9wcy5wcmltYXJ5QnVja2V0TmFtZSxcbiAgICAgICAgU0VDT05EQVJZX0JVQ0tFVDogcHJvcHMuc2Vjb25kYXJ5QnVja2V0TmFtZSxcbiAgICAgICAgUFJJTUFSWV9SRUdJT046IHByb3BzLnByaW1hcnlSZWdpb24sXG4gICAgICAgIFNFQ09OREFSWV9SRUdJT046IHByb3BzLnNlY29uZGFyeVJlZ2lvbixcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBsb2FkVGVzdEZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ3MzOlB1dE9iamVjdCcsICdzMzpHZXRPYmplY3QnLCAnczM6SGVhZE9iamVjdCcsICdzMzpMaXN0QnVja2V0J10sXG4gICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgYGFybjphd3M6czM6Ojoke3Byb3BzLnByaW1hcnlCdWNrZXROYW1lfWAsXG4gICAgICAgIGBhcm46YXdzOnMzOjo6JHtwcm9wcy5wcmltYXJ5QnVja2V0TmFtZX0vKmAsXG4gICAgICAgIGBhcm46YXdzOnMzOjo6JHtwcm9wcy5zZWNvbmRhcnlCdWNrZXROYW1lfWAsXG4gICAgICAgIGBhcm46YXdzOnMzOjo6JHtwcm9wcy5zZWNvbmRhcnlCdWNrZXROYW1lfS8qYCxcbiAgICAgIF0sXG4gICAgfSkpO1xuXG4gICAgLy8gLS0tIFNTTSBBdXRvbWF0aW9uIERvY3VtZW50IGZvciBMb2FkIFRlc3QgLS0tXG4gICAgbmV3IHNzbS5DZm5Eb2N1bWVudCh0aGlzLCAnTG9hZFRlc3REb2N1bWVudCcsIHtcbiAgICAgIG5hbWU6IGAke3Byb3BzLnByb2plY3R9LWxvYWQtdGVzdGAsXG4gICAgICBkb2N1bWVudFR5cGU6ICdBdXRvbWF0aW9uJyxcbiAgICAgIGNvbnRlbnQ6IHtcbiAgICAgICAgc2NoZW1hVmVyc2lvbjogJzAuMycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnUnVuIFMzIENSUiByZXBsaWNhdGlvbiBsYXRlbmN5IGxvYWQgdGVzdCcsXG4gICAgICAgIHBhcmFtZXRlcnM6IHtcbiAgICAgICAgICBTb3VyY2VSZWdpb246IHtcbiAgICAgICAgICAgIHR5cGU6ICdTdHJpbmcnLFxuICAgICAgICAgICAgZGVmYXVsdDogcHJvcHMucHJpbWFyeVJlZ2lvbixcbiAgICAgICAgICAgIGFsbG93ZWRWYWx1ZXM6IFtwcm9wcy5wcmltYXJ5UmVnaW9uLCBwcm9wcy5zZWNvbmRhcnlSZWdpb25dLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246ICdSZWdpb24gdG8gdXBsb2FkIG9iamVjdHMgdG8nLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgRGVzdFJlZ2lvbjoge1xuICAgICAgICAgICAgdHlwZTogJ1N0cmluZycsXG4gICAgICAgICAgICBkZWZhdWx0OiBwcm9wcy5zZWNvbmRhcnlSZWdpb24sXG4gICAgICAgICAgICBhbGxvd2VkVmFsdWVzOiBbcHJvcHMucHJpbWFyeVJlZ2lvbiwgcHJvcHMuc2Vjb25kYXJ5UmVnaW9uXSxcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAnUmVnaW9uIHRvIGNoZWNrIHJlcGxpY2F0aW9uIGluJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIE9iamVjdENvdW50OiB7XG4gICAgICAgICAgICB0eXBlOiAnU3RyaW5nJyxcbiAgICAgICAgICAgIGRlZmF1bHQ6ICcxMDAnLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246ICdOdW1iZXIgb2Ygb2JqZWN0cyB0byB1cGxvYWQnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgT2JqZWN0U2l6ZUtCOiB7XG4gICAgICAgICAgICB0eXBlOiAnU3RyaW5nJyxcbiAgICAgICAgICAgIGRlZmF1bHQ6ICcxMCcsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogJ1NpemUgb2YgZWFjaCBvYmplY3QgaW4gS0InLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgVGltZW91dFNlY29uZHM6IHtcbiAgICAgICAgICAgIHR5cGU6ICdTdHJpbmcnLFxuICAgICAgICAgICAgZGVmYXVsdDogJzMwMCcsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogJ01heCBzZWNvbmRzIHRvIHdhaXQgZm9yIHJlcGxpY2F0aW9uIHBlciBvYmplY3QnLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIG1haW5TdGVwczogW3tcbiAgICAgICAgICBuYW1lOiAnUnVuTG9hZFRlc3QnLFxuICAgICAgICAgIGFjdGlvbjogJ2F3czppbnZva2VMYW1iZGFGdW5jdGlvbicsXG4gICAgICAgICAgaW5wdXRzOiB7XG4gICAgICAgICAgICBGdW5jdGlvbk5hbWU6IGxvYWRUZXN0Rm4uZnVuY3Rpb25OYW1lLFxuICAgICAgICAgICAgUGF5bG9hZDogJ3tcInNvdXJjZVJlZ2lvblwiOlwie3tTb3VyY2VSZWdpb259fVwiLFwiZGVzdFJlZ2lvblwiOlwie3tEZXN0UmVnaW9ufX1cIixcIm9iamVjdENvdW50XCI6e3tPYmplY3RDb3VudH19LFwib2JqZWN0U2l6ZUtCXCI6e3tPYmplY3RTaXplS0J9fSxcInRpbWVvdXRTZWNvbmRzXCI6e3tUaW1lb3V0U2Vjb25kc319fScsXG4gICAgICAgICAgfSxcbiAgICAgICAgfV0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gLS0tIEFSQyBSZWdpb24gU3dpdGNoIFBsYW4gLS0tXG4gICAgY29uc3QgYXJjRXhlY3V0aW9uUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnQXJjRXhlY3V0aW9uUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdhcmMtcmVnaW9uLXN3aXRjaC5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG5cbiAgICBhcmNFeGVjdXRpb25Sb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnbGFtYmRhOkludm9rZUZ1bmN0aW9uJywgJ2xhbWJkYTpHZXRGdW5jdGlvbiddLFxuICAgICAgcmVzb3VyY2VzOiBbcHJvcHMucHJpbWFyeVJvdXRpbmdMYW1iZGFBcm4sIHByb3BzLnNlY29uZGFyeVJvdXRpbmdMYW1iZGFBcm5dLFxuICAgIH0pKTtcblxuICAgIG5ldyBjZGsuQ2ZuUmVzb3VyY2UodGhpcywgJ0FyY1JlZ2lvblN3aXRjaFBsYW4nLCB7XG4gICAgICB0eXBlOiAnQVdTOjpBUkNSZWdpb25Td2l0Y2g6OlBsYW4nLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBOYW1lOiBgJHtwcm9wcy5wcm9qZWN0fS1yZWdpb24tc3dpdGNoYCxcbiAgICAgICAgUmVjb3ZlcnlBcHByb2FjaDogJ2FjdGl2ZVBhc3NpdmUnLFxuICAgICAgICBQcmltYXJ5UmVnaW9uOiBwcm9wcy5wcmltYXJ5UmVnaW9uLFxuICAgICAgICBSZWdpb25zOiBbcHJvcHMucHJpbWFyeVJlZ2lvbiwgcHJvcHMuc2Vjb25kYXJ5UmVnaW9uXSxcbiAgICAgICAgRXhlY3V0aW9uUm9sZTogYXJjRXhlY3V0aW9uUm9sZS5yb2xlQXJuLFxuICAgICAgICBXb3JrZmxvd3M6IFt7XG4gICAgICAgICAgV29ya2Zsb3dUYXJnZXRBY3Rpb246ICdhY3RpdmF0ZScsXG4gICAgICAgICAgV29ya2Zsb3dEZXNjcmlwdGlvbjogJ1VwZGF0ZSBNUkFQIHJvdXRpbmcgdG8gc2VuZCB0cmFmZmljIHRvIHRoZSBhY3RpdmF0aW5nIHJlZ2lvbicsXG4gICAgICAgICAgU3RlcHM6IFt7XG4gICAgICAgICAgICBOYW1lOiAndXBkYXRlLW1yYXAtcm91dGluZycsXG4gICAgICAgICAgICBFeGVjdXRpb25CbG9ja1R5cGU6ICdDdXN0b21BY3Rpb25MYW1iZGEnLFxuICAgICAgICAgICAgRXhlY3V0aW9uQmxvY2tDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgICAgIEN1c3RvbUFjdGlvbkxhbWJkYUNvbmZpZzoge1xuICAgICAgICAgICAgICAgIFJlZ2lvblRvUnVuOiAnYWN0aXZhdGluZ1JlZ2lvbicsXG4gICAgICAgICAgICAgICAgVGltZW91dE1pbnV0ZXM6IDIsXG4gICAgICAgICAgICAgICAgUmV0cnlJbnRlcnZhbE1pbnV0ZXM6IDEsXG4gICAgICAgICAgICAgICAgTGFtYmRhczogW1xuICAgICAgICAgICAgICAgICAgeyBBcm46IHByb3BzLnByaW1hcnlSb3V0aW5nTGFtYmRhQXJuIH0sXG4gICAgICAgICAgICAgICAgICB7IEFybjogcHJvcHMuc2Vjb25kYXJ5Um91dGluZ0xhbWJkYUFybiB9LFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH1dLFxuICAgICAgICB9XSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTG9hZFRlc3RGdW5jdGlvbkFybicsIHsgdmFsdWU6IGxvYWRUZXN0Rm4uZnVuY3Rpb25Bcm4gfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvYWRUZXN0RG9jdW1lbnROYW1lJywgeyB2YWx1ZTogYCR7cHJvcHMucHJvamVjdH0tbG9hZC10ZXN0YCB9KTtcbiAgfVxufVxuIl19