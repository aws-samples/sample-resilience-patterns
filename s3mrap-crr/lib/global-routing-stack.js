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
exports.GlobalRoutingStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const cr = __importStar(require("aws-cdk-lib/custom-resources"));
const path = __importStar(require("path"));
class GlobalRoutingStack extends cdk.Stack {
    mrapAlias;
    constructor(scope, id, props) {
        super(scope, id, props);
        // S3 Multi-Region Access Point
        const mrap = new s3.CfnMultiRegionAccessPoint(this, 'MRAP', {
            name: `${props.project}-mrap`,
            regions: [
                { bucket: props.primaryBucketName },
                { bucket: props.secondaryBucketName },
            ],
            publicAccessBlockConfiguration: {
                blockPublicAcls: true,
                blockPublicPolicy: true,
                ignorePublicAcls: true,
                restrictPublicBuckets: true,
            },
        });
        // IAM role for S3 replication
        const replicationRole = new iam.Role(this, 'ReplicationRole', {
            assumedBy: new iam.ServicePrincipal('s3.amazonaws.com'),
        });
        replicationRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                's3:GetReplicationConfiguration',
                's3:ListBucket',
                's3:GetObjectVersionForReplication',
                's3:GetObjectVersionAcl',
                's3:GetObjectVersionTagging',
            ],
            resources: [
                `arn:aws:s3:::${props.primaryBucketName}`,
                `arn:aws:s3:::${props.primaryBucketName}/*`,
                `arn:aws:s3:::${props.secondaryBucketName}`,
                `arn:aws:s3:::${props.secondaryBucketName}/*`,
            ],
        }));
        replicationRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                's3:ReplicateObject',
                's3:ReplicateDelete',
                's3:ReplicateTags',
                's3:ObjectOwnerOverrideToBucketOwner',
            ],
            resources: [
                `arn:aws:s3:::${props.primaryBucketName}/*`,
                `arn:aws:s3:::${props.secondaryBucketName}/*`,
            ],
        }));
        // KMS permissions for CRR with KMS-encrypted buckets (aws/s3 managed keys)
        replicationRole.addToPolicy(new iam.PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: [`arn:aws:kms:${props.primaryRegion}:${props.accountId}:key/*`, `arn:aws:kms:${props.secondaryRegion}:${props.accountId}:key/*`],
            conditions: { StringLike: { 'kms:ViaService': [`s3.${props.primaryRegion}.amazonaws.com`, `s3.${props.secondaryRegion}.amazonaws.com`] } },
        }));
        replicationRole.addToPolicy(new iam.PolicyStatement({
            actions: ['kms:Encrypt'],
            resources: [`arn:aws:kms:${props.primaryRegion}:${props.accountId}:key/*`, `arn:aws:kms:${props.secondaryRegion}:${props.accountId}:key/*`],
            conditions: { StringLike: { 'kms:ViaService': [`s3.${props.primaryRegion}.amazonaws.com`, `s3.${props.secondaryRegion}.amazonaws.com`] } },
        }));
        // Custom resource Lambda for bidirectional CRR
        const crrFn = new lambda.Function(this, 'CrrFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'crr-custom-resource')),
            timeout: cdk.Duration.minutes(5),
            reservedConcurrentExecutions: 1,
            environment: {
                PRIMARY_BUCKET: props.primaryBucketName,
                SECONDARY_BUCKET: props.secondaryBucketName,
                PRIMARY_REGION: props.primaryRegion,
                SECONDARY_REGION: props.secondaryRegion,
                REPLICATION_ROLE_ARN: replicationRole.roleArn,
            },
        });
        crrFn.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                's3:PutReplicationConfiguration',
                's3:GetReplicationConfiguration',
                's3:PutBucketVersioning',
                's3:GetBucketVersioning',
                's3:GetBucketLocation',
            ],
            resources: [
                `arn:aws:s3:::${props.primaryBucketName}`,
                `arn:aws:s3:::${props.secondaryBucketName}`,
            ],
        }));
        crrFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['iam:PassRole'],
            resources: [replicationRole.roleArn],
            conditions: { StringEquals: { 'iam:PassedToService': 's3.amazonaws.com' } },
        }));
        const crrProvider = new cr.Provider(this, 'CrrProvider', {
            onEventHandler: crrFn,
        });
        const crrResource = new cdk.CustomResource(this, 'CrrConfig', {
            serviceToken: crrProvider.serviceToken,
        });
        crrResource.node.addDependency(mrap);
        // Set initial MRAP routing: primary=100%, secondary=0%
        const initialRouting = new cr.AwsCustomResource(this, 'InitialRouting', {
            installLatestAwsSdk: false,
            onCreate: {
                service: 'S3Control',
                action: 'submitMultiRegionAccessPointRoutes',
                parameters: {
                    AccountId: props.accountId,
                    Mrap: `arn:aws:s3::${props.accountId}:accesspoint/${mrap.attrAlias}`,
                    RouteUpdates: [
                        { Bucket: props.primaryBucketName, Region: props.primaryRegion, TrafficDialPercentage: 100 },
                        { Bucket: props.secondaryBucketName, Region: props.secondaryRegion, TrafficDialPercentage: 0 },
                    ],
                },
                physicalResourceId: cr.PhysicalResourceId.of('initial-mrap-routing'),
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    actions: ['s3:SubmitMultiRegionAccessPointRoutes'],
                    resources: [`arn:aws:s3::${props.accountId}:accesspoint/*`],
                }),
            ]),
        });
        initialRouting.node.addDependency(mrap);
        // Outputs
        new cdk.CfnOutput(this, 'MrapAlias', { value: mrap.attrAlias });
        new cdk.CfnOutput(this, 'MrapArn', {
            value: `arn:aws:s3::${props.accountId}:accesspoint/${mrap.attrAlias}`,
        });
        new cdk.CfnOutput(this, 'ReplicationRoleArn', { value: replicationRole.roleArn });
    }
}
exports.GlobalRoutingStack = GlobalRoutingStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2xvYmFsLXJvdXRpbmctc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJnbG9iYWwtcm91dGluZy1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMsdURBQXlDO0FBQ3pDLHlEQUEyQztBQUMzQywrREFBaUQ7QUFDakQsaUVBQW1EO0FBQ25ELDJDQUE2QjtBQVc3QixNQUFhLGtCQUFtQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQy9CLFNBQVMsQ0FBUztJQUVsQyxZQUFZLEtBQWMsRUFBRSxFQUFVLEVBQUUsS0FBOEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsK0JBQStCO1FBQy9CLE1BQU0sSUFBSSxHQUFHLElBQUksRUFBRSxDQUFDLHlCQUF5QixDQUFDLElBQUksRUFBRSxNQUFNLEVBQUU7WUFDMUQsSUFBSSxFQUFFLEdBQUcsS0FBSyxDQUFDLE9BQU8sT0FBTztZQUM3QixPQUFPLEVBQUU7Z0JBQ1AsRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDLGlCQUFpQixFQUFFO2dCQUNuQyxFQUFFLE1BQU0sRUFBRSxLQUFLLENBQUMsbUJBQW1CLEVBQUU7YUFDdEM7WUFDRCw4QkFBOEIsRUFBRTtnQkFDOUIsZUFBZSxFQUFFLElBQUk7Z0JBQ3JCLGlCQUFpQixFQUFFLElBQUk7Z0JBQ3ZCLGdCQUFnQixFQUFFLElBQUk7Z0JBQ3RCLHFCQUFxQixFQUFFLElBQUk7YUFDNUI7U0FDRixDQUFDLENBQUM7UUFFSCw4QkFBOEI7UUFDOUIsTUFBTSxlQUFlLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtZQUM1RCxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMsa0JBQWtCLENBQUM7U0FDeEQsQ0FBQyxDQUFDO1FBRUgsZUFB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RyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsb0JBQW9CLEVBQUUsRUFBRSxLQUFLLEVBQUUsZUFBZSxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7SUFDcEYsQ0FBQztDQUNGO0FBbEpELGdEQWtKQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgY3IgZnJvbSAnYXdzLWNkay1saWIvY3VzdG9tLXJlc291cmNlcyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEdsb2JhbFJvdXRpbmdTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICByZWFkb25seSBwcm9qZWN0OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHByaW1hcnlCdWNrZXROYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHNlY29uZGFyeUJ1Y2tldE5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgcHJpbWFyeVJlZ2lvbjogc3RyaW5nO1xuICByZWFkb25seSBzZWNvbmRhcnlSZWdpb246IHN0cmluZztcbiAgcmVhZG9ubHkgYWNjb3VudElkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBHbG9iYWxSb3V0aW5nU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgbXJhcEFsaWFzOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IGNkay5BcHAsIGlkOiBzdHJpbmcsIHByb3BzOiBHbG9iYWxSb3V0aW5nU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gUzMgTXVsdGktUmVnaW9uIEFjY2VzcyBQb2ludFxuICAgIGNvbnN0IG1yYXAgPSBuZXcgczMuQ2ZuTXVsdGlSZWdpb25BY2Nlc3NQb2ludCh0aGlzLCAnTVJBUCcsIHtcbiAgICAgIG5hbWU6IGAke3Byb3BzLnByb2plY3R9LW1yYXBgLFxuICAgICAgcmVnaW9uczogW1xuICAgICAgICB7IGJ1Y2tldDogcHJvcHMucHJpbWFyeUJ1Y2tldE5hbWUgfSxcbiAgICAgICAgeyBidWNrZXQ6IHByb3BzLnNlY29uZGFyeUJ1Y2tldE5hbWUgfSxcbiAgICAgIF0sXG4gICAgICBwdWJsaWNBY2Nlc3NCbG9ja0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgYmxvY2tQdWJsaWNBY2xzOiB0cnVlLFxuICAgICAgICBibG9ja1B1YmxpY1BvbGljeTogdHJ1ZSxcbiAgICAgICAgaWdub3JlUHVibGljQWNsczogdHJ1ZSxcbiAgICAgICAgcmVzdHJpY3RQdWJsaWNCdWNrZXRzOiB0cnVlLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIElBTSByb2xlIGZvciBTMyByZXBsaWNhdGlvblxuICAgIGNvbnN0IHJlcGxpY2F0aW9uUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnUmVwbGljYXRpb25Sb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ3MzLmFtYXpvbmF3cy5jb20nKSxcbiAgICB9KTtcblxuICAgIHJlcGxpY2F0aW9uUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdzMzpHZXRSZXBsaWNhdGlvbkNvbmZpZ3VyYXRpb24nLFxuICAgICAgICAnczM6TGlzdEJ1Y2tldCcsXG4gICAgICAgICdzMzpHZXRPYmplY3RWZXJzaW9uRm9yUmVwbGljYXRpb24nLFxuICAgICAgICAnczM6R2V0T2JqZWN0VmVyc2lvbkFjbCcsXG4gICAgICAgICdzMzpHZXRPYmplY3RWZXJzaW9uVGFnZ2luZycsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgIGBhcm46YXdzOnMzOjo6JHtwcm9wcy5wcmltYXJ5QnVja2V0TmFtZX1gLFxuICAgICAgICBgYXJuOmF3czpzMzo6OiR7cHJvcHMucHJpbWFyeUJ1Y2tldE5hbWV9LypgLFxuICAgICAgICBgYXJuOmF3czpzMzo6OiR7cHJvcHMuc2Vjb25kYXJ5QnVja2V0TmFtZX1gLFxuICAgICAgICBgYXJuOmF3czpzMzo6OiR7cHJvcHMuc2Vjb25kYXJ5QnVja2V0TmFtZX0vKmAsXG4gICAgICBdLFxuICAgIH0pKTtcblxuICAgIHJlcGxpY2F0aW9uUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdzMzpSZXBsaWNhdGVPYmplY3QnLFxuICAgICAgICAnczM6UmVwbGljYXRlRGVsZXRlJyxcbiAgICAgICAgJ3MzOlJlcGxpY2F0ZVRhZ3MnLFxuICAgICAgICAnczM6T2JqZWN0T3duZXJPdmVycmlkZVRvQnVja2V0T3duZXInLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBgYXJuOmF3czpzMzo6OiR7cHJvcHMucHJpbWFyeUJ1Y2tldE5hbWV9LypgLFxuICAgICAgICBgYXJuOmF3czpzMzo6OiR7cHJvcHMuc2Vjb25kYXJ5QnVja2V0TmFtZX0vKmAsXG4gICAgICBdLFxuICAgIH0pKTtcblxuICAgIC8vIEtNUyBwZXJtaXNzaW9ucyBmb3IgQ1JSIHdpdGggS01TLWVuY3J5cHRlZCBidWNrZXRzIChhd3MvczMgbWFuYWdlZCBrZXlzKVxuICAgIHJlcGxpY2F0aW9uUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ2ttczpEZWNyeXB0J10sXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czprbXM6JHtwcm9wcy5wcmltYXJ5UmVnaW9ufToke3Byb3BzLmFjY291bnRJZH06a2V5LypgLCBgYXJuOmF3czprbXM6JHtwcm9wcy5zZWNvbmRhcnlSZWdpb259OiR7cHJvcHMuYWNjb3VudElkfTprZXkvKmBdLFxuICAgICAgY29uZGl0aW9uczogeyBTdHJpbmdMaWtlOiB7ICdrbXM6VmlhU2VydmljZSc6IFtgczMuJHtwcm9wcy5wcmltYXJ5UmVnaW9ufS5hbWF6b25hd3MuY29tYCwgYHMzLiR7cHJvcHMuc2Vjb25kYXJ5UmVnaW9ufS5hbWF6b25hd3MuY29tYF0gfSB9LFxuICAgIH0pKTtcblxuICAgIHJlcGxpY2F0aW9uUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ2ttczpFbmNyeXB0J10sXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czprbXM6JHtwcm9wcy5wcmltYXJ5UmVnaW9ufToke3Byb3BzLmFjY291bnRJZH06a2V5LypgLCBgYXJuOmF3czprbXM6JHtwcm9wcy5zZWNvbmRhcnlSZWdpb259OiR7cHJvcHMuYWNjb3VudElkfTprZXkvKmBdLFxuICAgICAgY29uZGl0aW9uczogeyBTdHJpbmdMaWtlOiB7ICdrbXM6VmlhU2VydmljZSc6IFtgczMuJHtwcm9wcy5wcmltYXJ5UmVnaW9ufS5hbWF6b25hd3MuY29tYCwgYHMzLiR7cHJvcHMuc2Vjb25kYXJ5UmVnaW9ufS5hbWF6b25hd3MuY29tYF0gfSB9LFxuICAgIH0pKTtcblxuICAgIC8vIEN1c3RvbSByZXNvdXJjZSBMYW1iZGEgZm9yIGJpZGlyZWN0aW9uYWwgQ1JSXG4gICAgY29uc3QgY3JyRm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdDcnJGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEyLFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICdsYW1iZGEnLCAnY3JyLWN1c3RvbS1yZXNvdXJjZScpKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgcmVzZXJ2ZWRDb25jdXJyZW50RXhlY3V0aW9uczogMSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFBSSU1BUllfQlVDS0VUOiBwcm9wcy5wcmltYXJ5QnVja2V0TmFtZSxcbiAgICAgICAgU0VDT05EQVJZX0JVQ0tFVDogcHJvcHMuc2Vjb25kYXJ5QnVja2V0TmFtZSxcbiAgICAgICAgUFJJTUFSWV9SRUdJT046IHByb3BzLnByaW1hcnlSZWdpb24sXG4gICAgICAgIFNFQ09OREFSWV9SRUdJT046IHByb3BzLnNlY29uZGFyeVJlZ2lvbixcbiAgICAgICAgUkVQTElDQVRJT05fUk9MRV9BUk46IHJlcGxpY2F0aW9uUm9sZS5yb2xlQXJuLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNyckZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdzMzpQdXRSZXBsaWNhdGlvbkNvbmZpZ3VyYXRpb24nLFxuICAgICAgICAnczM6R2V0UmVwbGljYXRpb25Db25maWd1cmF0aW9uJyxcbiAgICAgICAgJ3MzOlB1dEJ1Y2tldFZlcnNpb25pbmcnLFxuICAgICAgICAnczM6R2V0QnVja2V0VmVyc2lvbmluZycsXG4gICAgICAgICdzMzpHZXRCdWNrZXRMb2NhdGlvbicsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgIGBhcm46YXdzOnMzOjo6JHtwcm9wcy5wcmltYXJ5QnVja2V0TmFtZX1gLFxuICAgICAgICBgYXJuOmF3czpzMzo6OiR7cHJvcHMuc2Vjb25kYXJ5QnVja2V0TmFtZX1gLFxuICAgICAgXSxcbiAgICB9KSk7XG5cbiAgICBjcnJGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydpYW06UGFzc1JvbGUnXSxcbiAgICAgIHJlc291cmNlczogW3JlcGxpY2F0aW9uUm9sZS5yb2xlQXJuXSxcbiAgICAgIGNvbmRpdGlvbnM6IHsgU3RyaW5nRXF1YWxzOiB7ICdpYW06UGFzc2VkVG9TZXJ2aWNlJzogJ3MzLmFtYXpvbmF3cy5jb20nIH0gfSxcbiAgICB9KSk7XG5cbiAgICBjb25zdCBjcnJQcm92aWRlciA9IG5ldyBjci5Qcm92aWRlcih0aGlzLCAnQ3JyUHJvdmlkZXInLCB7XG4gICAgICBvbkV2ZW50SGFuZGxlcjogY3JyRm4sXG4gICAgfSk7XG5cbiAgICBjb25zdCBjcnJSZXNvdXJjZSA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ0NyckNvbmZpZycsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogY3JyUHJvdmlkZXIuc2VydmljZVRva2VuLFxuICAgIH0pO1xuXG4gICAgY3JyUmVzb3VyY2Uubm9kZS5hZGREZXBlbmRlbmN5KG1yYXApO1xuXG4gICAgLy8gU2V0IGluaXRpYWwgTVJBUCByb3V0aW5nOiBwcmltYXJ5PTEwMCUsIHNlY29uZGFyeT0wJVxuICAgIGNvbnN0IGluaXRpYWxSb3V0aW5nID0gbmV3IGNyLkF3c0N1c3RvbVJlc291cmNlKHRoaXMsICdJbml0aWFsUm91dGluZycsIHtcbiAgICAgIGluc3RhbGxMYXRlc3RBd3NTZGs6IGZhbHNlLFxuICAgICAgb25DcmVhdGU6IHtcbiAgICAgICAgc2VydmljZTogJ1MzQ29udHJvbCcsXG4gICAgICAgIGFjdGlvbjogJ3N1Ym1pdE11bHRpUmVnaW9uQWNjZXNzUG9pbnRSb3V0ZXMnLFxuICAgICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgQWNjb3VudElkOiBwcm9wcy5hY2NvdW50SWQsXG4gICAgICAgICAgTXJhcDogYGFybjphd3M6czM6OiR7cHJvcHMuYWNjb3VudElkfTphY2Nlc3Nwb2ludC8ke21yYXAuYXR0ckFsaWFzfWAsXG4gICAgICAgICAgUm91dGVVcGRhdGVzOiBbXG4gICAgICAgICAgICB7IEJ1Y2tldDogcHJvcHMucHJpbWFyeUJ1Y2tldE5hbWUsIFJlZ2lvbjogcHJvcHMucHJpbWFyeVJlZ2lvbiwgVHJhZmZpY0RpYWxQZXJjZW50YWdlOiAxMDAgfSxcbiAgICAgICAgICAgIHsgQnVja2V0OiBwcm9wcy5zZWNvbmRhcnlCdWNrZXROYW1lLCBSZWdpb246IHByb3BzLnNlY29uZGFyeVJlZ2lvbiwgVHJhZmZpY0RpYWxQZXJjZW50YWdlOiAwIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoJ2luaXRpYWwtbXJhcC1yb3V0aW5nJyksXG4gICAgICB9LFxuICAgICAgcG9saWN5OiBjci5Bd3NDdXN0b21SZXNvdXJjZVBvbGljeS5mcm9tU3RhdGVtZW50cyhbXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBhY3Rpb25zOiBbJ3MzOlN1Ym1pdE11bHRpUmVnaW9uQWNjZXNzUG9pbnRSb3V0ZXMnXSxcbiAgICAgICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpzMzo6JHtwcm9wcy5hY2NvdW50SWR9OmFjY2Vzc3BvaW50LypgXSxcbiAgICAgICAgfSksXG4gICAgICBdKSxcbiAgICB9KTtcbiAgICBpbml0aWFsUm91dGluZy5ub2RlLmFkZERlcGVuZGVuY3kobXJhcCk7XG5cbiAgICAvLyBPdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ01yYXBBbGlhcycsIHsgdmFsdWU6IG1yYXAuYXR0ckFsaWFzIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdNcmFwQXJuJywge1xuICAgICAgdmFsdWU6IGBhcm46YXdzOnMzOjoke3Byb3BzLmFjY291bnRJZH06YWNjZXNzcG9pbnQvJHttcmFwLmF0dHJBbGlhc31gLFxuICAgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdSZXBsaWNhdGlvblJvbGVBcm4nLCB7IHZhbHVlOiByZXBsaWNhdGlvblJvbGUucm9sZUFybiB9KTtcbiAgfVxufVxuIl19