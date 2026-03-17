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
const kms = __importStar(require("aws-cdk-lib/aws-kms"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const cr = __importStar(require("aws-cdk-lib/custom-resources"));
const path = __importStar(require("path"));
class BootstrapStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const encryptionKey = new kms.Key(this, 'ArtifactKey', {
            alias: `${props.project}-artifacts`,
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
            bucketName: `${props.project}-codebuild-${this.account}`,
            encryption: s3.BucketEncryption.KMS,
            encryptionKey,
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
            actions: ['cloudformation:DescribeStacks'],
            resources: [`arn:aws:cloudformation:*:${this.account}:stack/${props.project}-*/*`],
        }));
        buildRole.addToPolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter'],
            resources: [`arn:aws:ssm:*:${this.account}:parameter/cdk-bootstrap/*`],
        }));
        artifactBucket.grantRead(buildRole);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYm9vdHN0cmFwLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYm9vdHN0cmFwLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLGlEQUFtQztBQUNuQyxxRUFBdUQ7QUFDdkQsdURBQXlDO0FBQ3pDLHdFQUEwRDtBQUMxRCx5REFBMkM7QUFDM0MseURBQTJDO0FBQzNDLCtEQUFpRDtBQUNqRCxpRUFBbUQ7QUFDbkQsMkNBQTZCO0FBUTdCLE1BQWEsY0FBZSxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQzNDLFlBQVksS0FBYyxFQUFFLEVBQVUsRUFBRSxLQUEwQjtRQUNoRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLGFBQWEsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRTtZQUNyRCxLQUFLLEVBQUUsR0FBRyxLQUFLLENBQUMsT0FBTyxZQUFZO1lBQ25DLGlCQUFpQixFQUFFLElBQUk7WUFDdkIsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztTQUN6QyxDQUFDLENBQUM7UUFFSCxNQUFNLGNBQWMsR0FBRyxJQUFJLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQzNELFVBQVUsRUFBRSxHQUFHLEtBQUssQ0FBQyxPQUFPLGNBQWMsSUFBSSxDQUFDLE9BQU8sRUFBRTtZQUN4RCxVQUFVLEVBQUUsRUFBRSxDQUFDLGdCQUFnQixDQUFDLEdBQUc7WUFDbkMsYUFBYTtZQUNiLGlCQUFpQixFQUFFLEVBQUUsQ0FBQyxpQkFBaUIsQ0FBQyxTQUFTO1lBQ2pELFVBQVUsRUFBRSxJQUFJO1lBQ2hCLGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU87WUFDeEMsaUJBQWlCLEVBQUUsSUFBSTtTQUN4QixDQUFDLENB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QUFlLEVBQUU7WUFDM0QsY0FBYyxFQUFFLFNBQVM7WUFDekIsaUJBQWlCLEVBQUUsWUFBWTtZQUMvQixhQUFhLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQ3ZDLFlBQVksRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7U0FDdkMsQ0FBQyxDQUFDO1FBRUgsTUFBTSxZQUFZLEdBQUcsSUFBSSxHQUFHLENBQUMsY0FBYyxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDaEUsWUFBWSxFQUFFLGFBQWEsQ0FBQyxZQUFZO1lBQ3hDLFVBQVUsRUFBRTtnQkFDVixXQUFXLEVBQUUsU0FBUyxDQUFDLFdBQVc7Z0JBQ2xDLG1EQUFtRDtnQkFDbkQsU0FBUyxFQUFFLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQyxRQUFRLEVBQUU7YUFDakM7U0FDRixDQUFDLENBQUM7UUFFSCxZQUFZLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO1FBQ2xELFlBQVksQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBRTNDLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsb0JBQW9CLEVBQUUsRUFBRSxLQUFLLEVBQUUsY0FBYyxDQUFDLFVBQVUsRUFBRSxDQUFDLENBQUM7UUFDcEYsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUUsRUFBRSxLQUFLLEVBQUUsU0FBUyxDQUFDLFdBQVcsRUFBRSxDQUFDLENBQUM7SUFDM0UsQ0FBQztDQUNGO0FBdEhELHdDQXNIQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBjb2RlYnVpbGQgZnJvbSAnYXdzLWNkay1saWIvYXdzLWNvZGVidWlsZCc7XG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0ICogYXMgczNkZXBsb3kgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzLWRlcGxveW1lbnQnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMga21zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1rbXMnO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgY3IgZnJvbSAnYXdzLWNkay1saWIvY3VzdG9tLXJlc291cmNlcyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEJvb3RzdHJhcFN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIHJlYWRvbmx5IHByb2plY3Q6IHN0cmluZztcbiAgcmVhZG9ubHkgcHJpbWFyeVJlZ2lvbjogc3RyaW5nO1xuICByZWFkb25seSBzZWNvbmRhcnlSZWdpb246IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEJvb3RzdHJhcFN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IGNkay5BcHAsIGlkOiBzdHJpbmcsIHByb3BzOiBCb290c3RyYXBTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCBlbmNyeXB0aW9uS2V5ID0gbmV3IGttcy5LZXkodGhpcywgJ0FydGlmYWN0S2V5Jywge1xuICAgICAgYWxpYXM6IGAke3Byb3BzLnByb2plY3R9LWFydGlmYWN0c2AsXG4gICAgICBlbmFibGVLZXlSb3RhdGlvbjogdHJ1ZSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICBjb25zdCBhcnRpZmFjdEJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ0FydGlmYWN0QnVja2V0Jywge1xuICAgICAgYnVja2V0TmFtZTogYCR7cHJvcHMucHJvamVjdH0tY29kZWJ1aWxkLSR7dGhpcy5hY2NvdW50fWAsXG4gICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLktNUyxcbiAgICAgIGVuY3J5cHRpb25LZXksXG4gICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBhdXRvRGVsZXRlT2JqZWN0czogdHJ1ZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHNvdXJjZURlcGxveW1lbnQgPSBuZXcgczNkZXBsb3kuQnVja2V0RGVwbG95bWVudCh0aGlzLCAnU291cmNlVXBsb2FkJywge1xuICAgICAgc291cmNlczogW3MzZGVwbG95LlNvdXJjZS5hc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4nKSwge1xuICAgICAgICBleGNsdWRlOiBbJy5naXQnLCAnbm9kZV9tb2R1bGVzJywgJ2Nkay5vdXQnLCAnZGlzdCcsICcuc3BlY3MnXSxcbiAgICAgIH0pXSxcbiAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiBhcnRpZmFjdEJ1Y2tldCxcbiAgICAgIGRlc3RpbmF0aW9uS2V5UHJlZml4OiAnc291cmNlJyxcbiAgICAgIGV4dHJhY3Q6IHRydWUsXG4gICAgfSk7XG5cbiAgICBjb25zdCBidWlsZFJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ0J1aWxkUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdjb2RlYnVpbGQuYW1hem9uYXdzLmNvbScpLFxuICAgIH0pO1xuXG4gICAgYnVpbGRSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnc3RzOkFzc3VtZVJvbGUnXSxcbiAgICAgIHJlc291cmNlczogW2Bhcm46YXdzOmlhbTo6JHt0aGlzLmFjY291bnR9OnJvbGUvY2RrLSpgXSxcbiAgICB9KSk7XG5cbiAgICBidWlsZFJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydjbG91ZGZvcm1hdGlvbjpEZXNjcmliZVN0YWNrcyddLFxuICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6Y2xvdWRmb3JtYXRpb246Kjoke3RoaXMuYWNjb3VudH06c3RhY2svJHtwcm9wcy5wcm9qZWN0fS0qLypgXSxcbiAgICB9KSk7XG5cbiAgICBidWlsZFJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydzc206R2V0UGFyYW1ldGVyJ10sXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpzc206Kjoke3RoaXMuYWNjb3VudH06cGFyYW1ldGVyL2Nkay1ib290c3RyYXAvKmBdLFxuICAgIH0pKTtcblxuICAgIGFydGlmYWN0QnVja2V0LmdyYW50UmVhZChidWlsZFJvbGUpO1xuXG4gICAgY29uc3QgY2JQcm9qZWN0ID0gbmV3IGNvZGVidWlsZC5Qcm9qZWN0KHRoaXMsICdEZXBsb3lQcm9qZWN0Jywge1xuICAgICAgcHJvamVjdE5hbWU6IGAke3Byb3BzLnByb2plY3R9LWRlcGxveWAsXG4gICAgICBzb3VyY2U6IGNvZGVidWlsZC5Tb3VyY2UuczMoe1xuICAgICAgICBidWNrZXQ6IGFydGlmYWN0QnVja2V0LFxuICAgICAgICBwYXRoOiAnc291cmNlLycsXG4gICAgICB9KSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIGJ1aWxkSW1hZ2U6IGNvZGVidWlsZC5MaW51eEJ1aWxkSW1hZ2UuU1RBTkRBUkRfN18wLFxuICAgICAgICBjb21wdXRlVHlwZTogY29kZWJ1aWxkLkNvbXB1dGVUeXBlLlNNQUxMLFxuICAgICAgfSxcbiAgICAgIGVudmlyb25tZW50VmFyaWFibGVzOiB7XG4gICAgICAgIFBST0pFQ1Q6IHsgdmFsdWU6IHByb3BzLnByb2plY3QgfSxcbiAgICAgICAgUFJJTUFSWV9SRUdJT046IHsgdmFsdWU6IHByb3BzLnByaW1hcnlSZWdpb24gfSxcbiAgICAgICAgU0VDT05EQVJZX1JFR0lPTjogeyB2YWx1ZTogcHJvcHMuc2Vjb25kYXJ5UmVnaW9uIH0sXG4gICAgICAgIEFDQ09VTlRfSUQ6IHsgdmFsdWU6IHRoaXMuYWNjb3VudCB9LFxuICAgICAgfSxcbiAgICAgIHJvbGU6IGJ1aWxkUm9sZSxcbiAgICAgIGJ1aWxkU3BlYzogY29kZWJ1aWxkLkJ1aWxkU3BlYy5mcm9tU291cmNlRmlsZW5hbWUoJ2J1aWxkc3BlYy55bWwnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDMwKSxcbiAgICB9KTtcblxuICAgIC8vIExhbWJkYS1iYWNrZWQgY3VzdG9tIHJlc291cmNlIHRoYXQgc3RhcnRzIGJ1aWxkIGFuZCB3YWl0cyBmb3IgY29tcGxldGlvblxuICAgIGNvbnN0IHRyaWdnZXJGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0J1aWxkVHJpZ2dlckZ1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTIsXG4gICAgICBoYW5kbGVyOiAnaW5kZXgub25fZXZlbnQnLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICdsYW1iZGEnLCAnYnVpbGQtdHJpZ2dlcicpKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDEpLFxuICAgIH0pO1xuXG4gICAgdHJpZ2dlckZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ2NvZGVidWlsZDpTdGFydEJ1aWxkJywgJ2NvZGVidWlsZDpCYXRjaEdldEJ1aWxkcyddLFxuICAgICAgcmVzb3VyY2VzOiBbY2JQcm9qZWN0LnByb2plY3RBcm5dLFxuICAgIH0pKTtcblxuICAgIGNvbnN0IGlzQ29tcGxldGVGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0J1aWxkSXNDb21wbGV0ZUZ1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTIsXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaXNfY29tcGxldGUnLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICdsYW1iZGEnLCAnYnVpbGQtdHJpZ2dlcicpKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICB9KTtcblxuICAgIGlzQ29tcGxldGVGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydjb2RlYnVpbGQ6QmF0Y2hHZXRCdWlsZHMnXSxcbiAgICAgIHJlc291cmNlczogW2NiUHJvamVjdC5wcm9qZWN0QXJuXSxcbiAgICB9KSk7XG5cbiAgICBjb25zdCBidWlsZFByb3ZpZGVyID0gbmV3IGNyLlByb3ZpZGVyKHRoaXMsICdCdWlsZFByb3ZpZGVyJywge1xuICAgICAgb25FdmVudEhhbmRsZXI6IHRyaWdnZXJGbixcbiAgICAgIGlzQ29tcGxldGVIYW5kbGVyOiBpc0NvbXBsZXRlRm4sXG4gICAgICBxdWVyeUludGVydmFsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICB0b3RhbFRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDMwKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGJ1aWxkVHJpZ2dlciA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ0J1aWxkVHJpZ2dlcicsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogYnVpbGRQcm92aWRlci5zZXJ2aWNlVG9rZW4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIFByb2plY3ROYW1lOiBjYlByb2plY3QucHJvamVjdE5hbWUsXG4gICAgICAgIC8vIENoYW5nZSB0aGlzIHRvIGZvcmNlIGEgbmV3IGJ1aWxkIG9uIHN0YWNrIHVwZGF0ZVxuICAgICAgICBUaW1lc3RhbXA6IERhdGUubm93KCkudG9TdHJpbmcoKSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBidWlsZFRyaWdnZXIubm9kZS5hZGREZXBlbmRlbmN5KHNvdXJjZURlcGxveW1lbnQpO1xuICAgIGJ1aWxkVHJpZ2dlci5ub2RlLmFkZERlcGVuZGVuY3koY2JQcm9qZWN0KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcnRpZmFjdEJ1Y2tldE5hbWUnLCB7IHZhbHVlOiBhcnRpZmFjdEJ1Y2tldC5idWNrZXROYW1lIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdQcm9qZWN0TmFtZScsIHsgdmFsdWU6IGNiUHJvamVjdC5wcm9qZWN0TmFtZSB9KTtcbiAgfVxufVxuIl19