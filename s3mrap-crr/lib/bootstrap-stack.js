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
exports.BootstrapStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const codebuild = __importStar(require("aws-cdk-lib/aws-codebuild"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const s3deploy = __importStar(require("aws-cdk-lib/aws-s3-deployment"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const cr = __importStar(require("aws-cdk-lib/custom-resources"));
const path = __importStar(require("path"));
class BootstrapStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
            bucketName: `${props.project}-codebuild-${this.account}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        const sourceDeployment = new s3deploy.BucketDeployment(this, 'SourceUpload', {
            sources: [s3deploy.Source.asset(path.join(__dirname, '..'), {
                    exclude: ['.git', 'node_modules', 'cdk.out', 'dist', '.specs'],
                })],
            destinationBucket: artifactBucket,
            destinationKeyPrefix: 'source',
            extract: true,
        });
        const buildRole = new iam.Role(this, 'BuildRole', {
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
        });
        buildRole.addToPolicy(new iam.PolicyStatement({
            actions: ['sts:AssumeRole'],
            resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
        }));
        buildRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'cloudformation:*',
                's3:*',
                'lambda:*',
                'iam:*',
                'cloudwatch:*',
                'ssm:*',
                'logs:*',
                'arcregionswitch:*',
            ],
            resources: ['*'],
        }));
        const cbProject = new codebuild.Project(this, 'DeployProject', {
            projectName: `${props.project}-deploy`,
            source: codebuild.Source.s3({
                bucket: artifactBucket,
                path: 'source/',
            }),
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
                computeType: codebuild.ComputeType.SMALL,
            },
            environmentVariables: {
                PROJECT: { value: props.project },
                PRIMARY_REGION: { value: props.primaryRegion },
                SECONDARY_REGION: { value: props.secondaryRegion },
                ACCOUNT_ID: { value: this.account },
            },
            role: buildRole,
            buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
            timeout: cdk.Duration.minutes(30),
        });
        // Lambda-backed custom resource that starts build and waits for completion
        const triggerFn = new lambda.Function(this, 'BuildTriggerFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.on_event',
            code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'build-trigger')),
            timeout: cdk.Duration.minutes(1),
        });
        triggerFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
            resources: [cbProject.projectArn],
        }));
        const isCompleteFn = new lambda.Function(this, 'BuildIsCompleteFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.is_complete',
            code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'build-trigger')),
            timeout: cdk.Duration.seconds(30),
        });
        isCompleteFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['codebuild:BatchGetBuilds'],
            resources: [cbProject.projectArn],
        }));
        const buildProvider = new cr.Provider(this, 'BuildProvider', {
            onEventHandler: triggerFn,
            isCompleteHandler: isCompleteFn,
            queryInterval: cdk.Duration.seconds(30),
            totalTimeout: cdk.Duration.minutes(30),
        });
        const buildTrigger = new cdk.CustomResource(this, 'BuildTrigger', {
            serviceToken: buildProvider.serviceToken,
            properties: {
                ProjectName: cbProject.projectName,
                // Change this to force a new build on stack update
                Timestamp: Date.now().toString(),
            },
        });
        buildTrigger.node.addDependency(sourceDeployment);
        buildTrigger.node.addDependency(cbProject);
        new cdk.CfnOutput(this, 'ArtifactBucketName', { value: artifactBucket.bucketName });
        new cdk.CfnOutput(this, 'ProjectName', { value: cbProject.projectName });
    }
}
exports.BootstrapStack = BootstrapStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYm9vdHN0cmFwLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYm9vdHN0cmFwLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLGlEQUFtQztBQUNuQyxxRUFBdUQ7QUFDdkQsdURBQXlDO0FBQ3pDLHdFQUEwRDtBQUMxRCx5REFBMkM7QUFDM0MsK0RBQWlEO0FBQ2pELGlFQUFtRDtBQUNuRCwyQ0FBNkI7QUFRN0IsTUFBYSxjQUFlLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDM0MsWUFBWSxLQUFjLEVBQUUsRUFBVSxFQUFFLEtBQTBCO1FBQ2hFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sY0FBYyxHQUFHLElBQUksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7WUFDM0QsVUFBVSxFQUFFLEdBQUcsS0FBSyxDQUFDLE9BQU8sY0FBYyxJQUFJLENBQUMsT0FBTyxFQUFFO1lBQ3hELFVBQVUsRUFBRSxFQUFFLENBQUMsZ0JBQWdCLENBQUMsVUFBVTtZQUMxQyxpQkFBaUIsRUFBRSxFQUFFLENBQUMsaUJBQWlCLENBQUMsU0FBUztZQUNqRCxVQUFVLEVBQUUsSUFBSTtZQUNoQixhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGlCQUFpQixFQUFFLElBQUk7U0FDeEIsQ0FBQyxDQUFDO1FBRUgsTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLFFBQVEsQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO1lBQzNFLE9BQU8sRUFBRSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksQ0FBQyxFQUFFO29CQUMxRCxPQUFPLEVBQUUsQ0FBQyxNQUFNLEVBQUUsY0FBYyxFQUFF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RUFBRSxDQUFDLFFBQVEsRUFBRTthQUNqQztTQUNGLENBQUMsQ0FBQztRQUVILFlBQVksQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLGdCQUFnQixDQUFDLENBQUM7UUFDbEQsWUFBWSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDLENBQUM7UUFFM0MsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRSxFQUFFLEtBQUssRUFBRSxjQUFjLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQztRQUNwRixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRSxFQUFFLEtBQUssRUFBRSxTQUFTLENBQUMsV0FBVyxFQUFFLENBQUMsQ0FBQztJQUMzRSxDQUFDO0NBQ0Y7QUFqSEQsd0NBaUhDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGNvZGVidWlsZCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY29kZWJ1aWxkJztcbmltcG9ydCAqIGFzIHMzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMyc7XG5pbXBvcnQgKiBhcyBzM2RlcGxveSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMtZGVwbG95bWVudCc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyBjciBmcm9tICdhd3MtY2RrLWxpYi9jdXN0b20tcmVzb3VyY2VzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQm9vdHN0cmFwU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgcmVhZG9ubHkgcHJvamVjdDogc3RyaW5nO1xuICByZWFkb25seSBwcmltYXJ5UmVnaW9uOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHNlY29uZGFyeVJlZ2lvbjogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgQm9vdHN0cmFwU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogY2RrLkFwcCwgaWQ6IHN0cmluZywgcHJvcHM6IEJvb3RzdHJhcFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIGNvbnN0IGFydGlmYWN0QnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnQXJ0aWZhY3RCdWNrZXQnLCB7XG4gICAgICBidWNrZXROYW1lOiBgJHtwcm9wcy5wcm9qZWN0fS1jb2RlYnVpbGQtJHt0aGlzLmFjY291bnR9YCxcbiAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGF1dG9EZWxldGVPYmplY3RzOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc291cmNlRGVwbG95bWVudCA9IG5ldyBzM2RlcGxveS5CdWNrZXREZXBsb3ltZW50KHRoaXMsICdTb3VyY2VVcGxvYWQnLCB7XG4gICAgICBzb3VyY2VzOiBbczNkZXBsb3kuU291cmNlLmFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicpLCB7XG4gICAgICAgIGV4Y2x1ZGU6IFsnLmdpdCcsICdub2RlX21vZHVsZXMnLCAnY2RrLm91dCcsICdkaXN0JywgJy5zcGVjcyddLFxuICAgICAgfSldLFxuICAgICAgZGVzdGluYXRpb25CdWNrZXQ6IGFydGlmYWN0QnVja2V0LFxuICAgICAgZGVzdGluYXRpb25LZXlQcmVmaXg6ICdzb3VyY2UnLFxuICAgICAgZXh0cmFjdDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGJ1aWxkUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnQnVpbGRSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2NvZGVidWlsZC5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG5cbiAgICBidWlsZFJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydzdHM6QXNzdW1lUm9sZSddLFxuICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6aWFtOjoke3RoaXMuYWNjb3VudH06cm9sZS9jZGstKmBdLFxuICAgIH0pKTtcblxuICAgIGJ1aWxkUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdjbG91ZGZvcm1hdGlvbjoqJyxcbiAgICAgICAgJ3MzOionLFxuICAgICAgICAnbGFtYmRhOionLFxuICAgICAgICAnaWFtOionLFxuICAgICAgICAnY2xvdWR3YXRjaDoqJyxcbiAgICAgICAgJ3NzbToqJyxcbiAgICAgICAgJ2xvZ3M6KicsXG4gICAgICAgICdhcmNyZWdpb25zd2l0Y2g6KicsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICBjb25zdCBjYlByb2plY3QgPSBuZXcgY29kZWJ1aWxkLlByb2plY3QodGhpcywgJ0RlcGxveVByb2plY3QnLCB7XG4gICAgICBwcm9qZWN0TmFtZTogYCR7cHJvcHMucHJvamVjdH0tZGVwbG95YCxcbiAgICAgIHNvdXJjZTogY29kZWJ1aWxkLlNvdXJjZS5zMyh7XG4gICAgICAgIGJ1Y2tldDogYXJ0aWZhY3RCdWNrZXQsXG4gICAgICAgIHBhdGg6ICdzb3VyY2UvJyxcbiAgICAgIH0pLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgYnVpbGRJbWFnZTogY29kZWJ1aWxkLkxpbnV4QnVpbGRJbWFnZS5TVEFOREFSRF83XzAsXG4gICAgICAgIGNvbXB1dGVUeXBlOiBjb2RlYnVpbGQuQ29tcHV0ZVR5cGUuU01BTEwsXG4gICAgICB9LFxuICAgICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcbiAgICAgICAgUFJPSkVDVDogeyB2YWx1ZTogcHJvcHMucHJvamVjdCB9LFxuICAgICAgICBQUklNQVJZX1JFR0lPTjogeyB2YWx1ZTogcHJvcHMucHJpbWFyeVJlZ2lvbiB9LFxuICAgICAgICBTRUNPTkRBUllfUkVHSU9OOiB7IHZhbHVlOiBwcm9wcy5zZWNvbmRhcnlSZWdpb24gfSxcbiAgICAgICAgQUNDT1VOVF9JRDogeyB2YWx1ZTogdGhpcy5hY2NvdW50IH0sXG4gICAgICB9LFxuICAgICAgcm9sZTogYnVpbGRSb2xlLFxuICAgICAgYnVpbGRTcGVjOiBjb2RlYnVpbGQuQnVpbGRTcGVjLmZyb21Tb3VyY2VGaWxlbmFtZSgnYnVpbGRzcGVjLnltbCcpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMzApLFxuICAgIH0pO1xuXG4gICAgLy8gTGFtYmRhLWJhY2tlZCBjdXN0b20gcmVzb3VyY2UgdGhhdCBzdGFydHMgYnVpbGQgYW5kIHdhaXRzIGZvciBjb21wbGV0aW9uXG4gICAgY29uc3QgdHJpZ2dlckZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnQnVpbGRUcmlnZ2VyRnVuY3Rpb24nLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5vbl9ldmVudCcsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uJywgJ2xhbWJkYScsICdidWlsZC10cmlnZ2VyJykpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMSksXG4gICAgfSk7XG5cbiAgICB0cmlnZ2VyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnY29kZWJ1aWxkOlN0YXJ0QnVpbGQnLCAnY29kZWJ1aWxkOkJhdGNoR2V0QnVpbGRzJ10sXG4gICAgICByZXNvdXJjZXM6IFtjYlByb2plY3QucHJvamVjdEFybl0sXG4gICAgfSkpO1xuXG4gICAgY29uc3QgaXNDb21wbGV0ZUZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnQnVpbGRJc0NvbXBsZXRlRnVuY3Rpb24nLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5pc19jb21wbGV0ZScsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uJywgJ2xhbWJkYScsICdidWlsZC10cmlnZ2VyJykpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgIH0pO1xuXG4gICAgaXNDb21wbGV0ZUZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ2NvZGVidWlsZDpCYXRjaEdldEJ1aWxkcyddLFxuICAgICAgcmVzb3VyY2VzOiBbY2JQcm9qZWN0LnByb2plY3RBcm5dLFxuICAgIH0pKTtcblxuICAgIGNvbnN0IGJ1aWxkUHJvdmlkZXIgPSBuZXcgY3IuUHJvdmlkZXIodGhpcywgJ0J1aWxkUHJvdmlkZXInLCB7XG4gICAgICBvbkV2ZW50SGFuZGxlcjogdHJpZ2dlckZuLFxuICAgICAgaXNDb21wbGV0ZUhhbmRsZXI6IGlzQ29tcGxldGVGbixcbiAgICAgIHF1ZXJ5SW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIHRvdGFsVGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMzApLFxuICAgIH0pO1xuXG4gICAgY29uc3QgYnVpbGRUcmlnZ2VyID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnQnVpbGRUcmlnZ2VyJywge1xuICAgICAgc2VydmljZVRva2VuOiBidWlsZFByb3ZpZGVyLnNlcnZpY2VUb2tlbixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgUHJvamVjdE5hbWU6IGNiUHJvamVjdC5wcm9qZWN0TmFtZSxcbiAgICAgICAgLy8gQ2hhbmdlIHRoaXMgdG8gZm9yY2UgYSBuZXcgYnVpbGQgb24gc3RhY2sgdXBkYXRlXG4gICAgICAgIFRpbWVzdGFtcDogRGF0ZS5ub3coKS50b1N0cmluZygpLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGJ1aWxkVHJpZ2dlci5ub2RlLmFkZERlcGVuZGVuY3koc291cmNlRGVwbG95bWVudCk7XG4gICAgYnVpbGRUcmlnZ2VyLm5vZGUuYWRkRGVwZW5kZW5jeShjYlByb2plY3QpO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FydGlmYWN0QnVja2V0TmFtZScsIHsgdmFsdWU6IGFydGlmYWN0QnVja2V0LmJ1Y2tldE5hbWUgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1Byb2plY3ROYW1lJywgeyB2YWx1ZTogY2JQcm9qZWN0LnByb2plY3ROYW1lIH0pO1xuICB9XG59XG4iXX0=