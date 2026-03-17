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
        // KMS permissions for CRR with MRK-encrypted buckets (same key ID in both regions)
        replicationRole.addToPolicy(new iam.PolicyStatement({
            actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'],
            resources: [
                `arn:aws:kms:${props.primaryRegion}:${props.accountId}:key/${props.encryptionKeyId}`,
                `arn:aws:kms:${props.secondaryRegion}:${props.accountId}:key/${props.encryptionKeyId}`,
            ],
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
                ENCRYPTION_KEY_ID: props.encryptionKeyId,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2xvYmFsLXJvdXRpbmctc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJnbG9iYWwtcm91dGluZy1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMsdURBQXlDO0FBQ3pDLHlEQUEyQztBQUMzQywrREFBaUQ7QUFDakQsaUVBQW1EO0FBQ25ELDJDQUE2QjtBQVk3QixNQUFhLGtCQUFtQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQy9CLFNBQVMsQ0FBUztJQUVsQyxZQUFZLEtBQWMsRUFBRSxFQUFVLEVBQUUsS0FBOEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsK0JBQStCO1FBQy9CLE1BQU0sSUFBSSxHQUFHLElBQUksRUFBRSxDQUFDLHlCQUF5QixDQUFDLElBQUksRUFBRSxNQUFNLEVBQUU7WUFDMUQsSUFBSSxFQUFFLEdBQUcsS0FBSyxDQUFDLE9BQU8sT0FBTztZQUM3QixPQUFPLEVBQUU7Z0JBQ1AsRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDLGlCQUFpQixFQUFFO2dCQUNuQyxFQUFFLE1BQU0sRUFBRSxLQUFLLENBQUMsbUJBQW1CLEVBQUU7YUFDdEM7WUFDRCw4QkFBOEIsRUFBRTtnQkFDOUIsZUFBZSxFQUFFLElBQUk7Z0JBQ3JCLGlCQUFpQixFQUFFLElBQUk7Z0JBQ3ZCLGdCQUFnQixFQUFFLElBQUk7Z0JBQ3RCLHFCQUFxQixFQUFFLElBQUk7YUFDNUI7U0FDRixDQUFDLENBQUM7UUFFSCw4QkFBOEI7UUFDOUIsTUFBTSxlQUFlLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtZQUM1RCxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMsa0JBQWtCLENBQUM7U0FDeEQsQ0FBQyxDQUFDO1FBRUgsZUFB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LHNCQUFzQixDQUFDO2FBQ3JFO1lBQ0QsTUFBTSxFQUFFLEVBQUUsQ0FBQyx1QkFBdUIsQ0FBQyxjQUFjLENBQUM7Z0JBQ2hELElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztvQkFDdEIsT0FBTyxFQUFFLENBQUMsdUNBQXVDLENBQUM7b0JBQ2xELFNBQVMsRUFBRSxDQUFDLGVBQWUsS0FBSyxDQUFDLFNBQVMsZ0JBQWdCLENBQUM7aUJBQzVELENBQUM7YUFDSCxDQUFDO1NBQ0gsQ0FBQyxDQUFDO1FBQ0gsY0FBYyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLENBQUM7UUFFeEMsVUFBVTtRQUNWLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsV0FBVyxFQUFFLEVBQUUsS0FBSyxFQUFFLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQyxDQUFDO1FBQ2hFLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFO1lBQ2pDLEtBQUssRUFBRSxlQUFlLEtBQUssQ0FBQyxTQUFTLGdCQUFnQixJQUFJLENBQUMsU0FBUyxFQUFFO1NBQ3RFLENBQUMsQ0FBQztRQUNILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsb0JBQW9CLEVBQUUsRUFBRSxLQUFLLEVBQUUsZUFBZSxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7SUFDcEYsQ0FBQztDQUNGO0FBL0lELGdEQStJQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgY3IgZnJvbSAnYXdzLWNkay1saWIvY3VzdG9tLXJlc291cmNlcyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEdsb2JhbFJvdXRpbmdTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICByZWFkb25seSBwcm9qZWN0OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHByaW1hcnlCdWNrZXROYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHNlY29uZGFyeUJ1Y2tldE5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgcHJpbWFyeVJlZ2lvbjogc3RyaW5nO1xuICByZWFkb25seSBzZWNvbmRhcnlSZWdpb246IHN0cmluZztcbiAgcmVhZG9ubHkgYWNjb3VudElkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGVuY3J5cHRpb25LZXlJZDogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgR2xvYmFsUm91dGluZ1N0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IG1yYXBBbGlhczogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBjZGsuQXBwLCBpZDogc3RyaW5nLCBwcm9wczogR2xvYmFsUm91dGluZ1N0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIFMzIE11bHRpLVJlZ2lvbiBBY2Nlc3MgUG9pbnRcbiAgICBjb25zdCBtcmFwID0gbmV3IHMzLkNmbk11bHRpUmVnaW9uQWNjZXNzUG9pbnQodGhpcywgJ01SQVAnLCB7XG4gICAgICBuYW1lOiBgJHtwcm9wcy5wcm9qZWN0fS1tcmFwYCxcbiAgICAgIHJlZ2lvbnM6IFtcbiAgICAgICAgeyBidWNrZXQ6IHByb3BzLnByaW1hcnlCdWNrZXROYW1lIH0sXG4gICAgICAgIHsgYnVja2V0OiBwcm9wcy5zZWNvbmRhcnlCdWNrZXROYW1lIH0sXG4gICAgICBdLFxuICAgICAgcHVibGljQWNjZXNzQmxvY2tDb25maWd1cmF0aW9uOiB7XG4gICAgICAgIGJsb2NrUHVibGljQWNsczogdHJ1ZSxcbiAgICAgICAgYmxvY2tQdWJsaWNQb2xpY3k6IHRydWUsXG4gICAgICAgIGlnbm9yZVB1YmxpY0FjbHM6IHRydWUsXG4gICAgICAgIHJlc3RyaWN0UHVibGljQnVja2V0czogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBJQU0gcm9sZSBmb3IgUzMgcmVwbGljYXRpb25cbiAgICBjb25zdCByZXBsaWNhdGlvblJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1JlcGxpY2F0aW9uUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdzMy5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG5cbiAgICByZXBsaWNhdGlvblJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnczM6R2V0UmVwbGljYXRpb25Db25maWd1cmF0aW9uJyxcbiAgICAgICAgJ3MzOkxpc3RCdWNrZXQnLFxuICAgICAgICAnczM6R2V0T2JqZWN0VmVyc2lvbkZvclJlcGxpY2F0aW9uJyxcbiAgICAgICAgJ3MzOkdldE9iamVjdFZlcnNpb25BY2wnLFxuICAgICAgICAnczM6R2V0T2JqZWN0VmVyc2lvblRhZ2dpbmcnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBgYXJuOmF3czpzMzo6OiR7cHJvcHMucHJpbWFyeUJ1Y2tldE5hbWV9YCxcbiAgICAgICAgYGFybjphd3M6czM6Ojoke3Byb3BzLnByaW1hcnlCdWNrZXROYW1lfS8qYCxcbiAgICAgICAgYGFybjphd3M6czM6Ojoke3Byb3BzLnNlY29uZGFyeUJ1Y2tldE5hbWV9YCxcbiAgICAgICAgYGFybjphd3M6czM6Ojoke3Byb3BzLnNlY29uZGFyeUJ1Y2tldE5hbWV9LypgLFxuICAgICAgXSxcbiAgICB9KSk7XG5cbiAgICByZXBsaWNhdGlvblJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnczM6UmVwbGljYXRlT2JqZWN0JyxcbiAgICAgICAgJ3MzOlJlcGxpY2F0ZURlbGV0ZScsXG4gICAgICAgICdzMzpSZXBsaWNhdGVUYWdzJyxcbiAgICAgICAgJ3MzOk9iamVjdE93bmVyT3ZlcnJpZGVUb0J1Y2tldE93bmVyJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgYGFybjphd3M6czM6Ojoke3Byb3BzLnByaW1hcnlCdWNrZXROYW1lfS8qYCxcbiAgICAgICAgYGFybjphd3M6czM6Ojoke3Byb3BzLnNlY29uZGFyeUJ1Y2tldE5hbWV9LypgLFxuICAgICAgXSxcbiAgICB9KSk7XG5cbiAgICAvLyBLTVMgcGVybWlzc2lvbnMgZm9yIENSUiB3aXRoIE1SSy1lbmNyeXB0ZWQgYnVja2V0cyAoc2FtZSBrZXkgSUQgaW4gYm90aCByZWdpb25zKVxuICAgIHJlcGxpY2F0aW9uUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ2ttczpEZWNyeXB0JywgJ2ttczpFbmNyeXB0JywgJ2ttczpHZW5lcmF0ZURhdGFLZXknXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBgYXJuOmF3czprbXM6JHtwcm9wcy5wcmltYXJ5UmVnaW9ufToke3Byb3BzLmFjY291bnRJZH06a2V5LyR7cHJvcHMuZW5jcnlwdGlvbktleUlkfWAsXG4gICAgICAgIGBhcm46YXdzOmttczoke3Byb3BzLnNlY29uZGFyeVJlZ2lvbn06JHtwcm9wcy5hY2NvdW50SWR9OmtleS8ke3Byb3BzLmVuY3J5cHRpb25LZXlJZH1gLFxuICAgICAgXSxcbiAgICB9KSk7XG5cbiAgICAvLyBDdXN0b20gcmVzb3VyY2UgTGFtYmRhIGZvciBiaWRpcmVjdGlvbmFsIENSUlxuICAgIGNvbnN0IGNyckZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnQ3JyRnVuY3Rpb24nLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4nLCAnbGFtYmRhJywgJ2Nyci1jdXN0b20tcmVzb3VyY2UnKSksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICAgIHJlc2VydmVkQ29uY3VycmVudEV4ZWN1dGlvbnM6IDEsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBQUklNQVJZX0JVQ0tFVDogcHJvcHMucHJpbWFyeUJ1Y2tldE5hbWUsXG4gICAgICAgIFNFQ09OREFSWV9CVUNLRVQ6IHByb3BzLnNlY29uZGFyeUJ1Y2tldE5hbWUsXG4gICAgICAgIFBSSU1BUllfUkVHSU9OOiBwcm9wcy5wcmltYXJ5UmVnaW9uLFxuICAgICAgICBTRUNPTkRBUllfUkVHSU9OOiBwcm9wcy5zZWNvbmRhcnlSZWdpb24sXG4gICAgICAgIFJFUExJQ0FUSU9OX1JPTEVfQVJOOiByZXBsaWNhdGlvblJvbGUucm9sZUFybixcbiAgICAgICAgRU5DUllQVElPTl9LRVlfSUQ6IHByb3BzLmVuY3J5cHRpb25LZXlJZCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjcnJGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnczM6UHV0UmVwbGljYXRpb25Db25maWd1cmF0aW9uJyxcbiAgICAgICAgJ3MzOkdldFJlcGxpY2F0aW9uQ29uZmlndXJhdGlvbicsXG4gICAgICAgICdzMzpQdXRCdWNrZXRWZXJzaW9uaW5nJyxcbiAgICAgICAgJ3MzOkdldEJ1Y2tldFZlcnNpb25pbmcnLFxuICAgICAgICAnczM6R2V0QnVja2V0TG9jYXRpb24nLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBgYXJuOmF3czpzMzo6OiR7cHJvcHMucHJpbWFyeUJ1Y2tldE5hbWV9YCxcbiAgICAgICAgYGFybjphd3M6czM6Ojoke3Byb3BzLnNlY29uZGFyeUJ1Y2tldE5hbWV9YCxcbiAgICAgIF0sXG4gICAgfSkpO1xuXG4gICAgY3JyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnaWFtOlBhc3NSb2xlJ10sXG4gICAgICByZXNvdXJjZXM6IFtyZXBsaWNhdGlvblJvbGUucm9sZUFybl0sXG4gICAgICBjb25kaXRpb25zOiB7IFN0cmluZ0VxdWFsczogeyAnaWFtOlBhc3NlZFRvU2VydmljZSc6ICdzMy5hbWF6b25hd3MuY29tJyB9IH0sXG4gICAgfSkpO1xuXG4gICAgY29uc3QgY3JyUHJvdmlkZXIgPSBuZXcgY3IuUHJvdmlkZXIodGhpcywgJ0NyclByb3ZpZGVyJywge1xuICAgICAgb25FdmVudEhhbmRsZXI6IGNyckZuLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY3JyUmVzb3VyY2UgPSBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdDcnJDb25maWcnLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IGNyclByb3ZpZGVyLnNlcnZpY2VUb2tlbixcbiAgICB9KTtcblxuICAgIGNyclJlc291cmNlLm5vZGUuYWRkRGVwZW5kZW5jeShtcmFwKTtcblxuICAgIC8vIFNldCBpbml0aWFsIE1SQVAgcm91dGluZzogcHJpbWFyeT0xMDAlLCBzZWNvbmRhcnk9MCVcbiAgICBjb25zdCBpbml0aWFsUm91dGluZyA9IG5ldyBjci5Bd3NDdXN0b21SZXNvdXJjZSh0aGlzLCAnSW5pdGlhbFJvdXRpbmcnLCB7XG4gICAgICBpbnN0YWxsTGF0ZXN0QXdzU2RrOiBmYWxzZSxcbiAgICAgIG9uQ3JlYXRlOiB7XG4gICAgICAgIHNlcnZpY2U6ICdTM0NvbnRyb2wnLFxuICAgICAgICBhY3Rpb246ICdzdWJtaXRNdWx0aVJlZ2lvbkFjY2Vzc1BvaW50Um91dGVzJyxcbiAgICAgICAgcGFyYW1ldGVyczoge1xuICAgICAgICAgIEFjY291bnRJZDogcHJvcHMuYWNjb3VudElkLFxuICAgICAgICAgIE1yYXA6IGBhcm46YXdzOnMzOjoke3Byb3BzLmFjY291bnRJZH06YWNjZXNzcG9pbnQvJHttcmFwLmF0dHJBbGlhc31gLFxuICAgICAgICAgIFJvdXRlVXBkYXRlczogW1xuICAgICAgICAgICAgeyBCdWNrZXQ6IHByb3BzLnByaW1hcnlCdWNrZXROYW1lLCBSZWdpb246IHByb3BzLnByaW1hcnlSZWdpb24sIFRyYWZmaWNEaWFsUGVyY2VudGFnZTogMTAwIH0sXG4gICAgICAgICAgICB7IEJ1Y2tldDogcHJvcHMuc2Vjb25kYXJ5QnVja2V0TmFtZSwgUmVnaW9uOiBwcm9wcy5zZWNvbmRhcnlSZWdpb24sIFRyYWZmaWNEaWFsUGVyY2VudGFnZTogMCB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICAgIHBoeXNpY2FsUmVzb3VyY2VJZDogY3IuUGh5c2ljYWxSZXNvdXJjZUlkLm9mKCdpbml0aWFsLW1yYXAtcm91dGluZycpLFxuICAgICAgfSxcbiAgICAgIHBvbGljeTogY3IuQXdzQ3VzdG9tUmVzb3VyY2VQb2xpY3kuZnJvbVN0YXRlbWVudHMoW1xuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgYWN0aW9uczogWydzMzpTdWJtaXRNdWx0aVJlZ2lvbkFjY2Vzc1BvaW50Um91dGVzJ10sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6czM6OiR7cHJvcHMuYWNjb3VudElkfTphY2Nlc3Nwb2ludC8qYF0sXG4gICAgICAgIH0pLFxuICAgICAgXSksXG4gICAgfSk7XG4gICAgaW5pdGlhbFJvdXRpbmcubm9kZS5hZGREZXBlbmRlbmN5KG1yYXApO1xuXG4gICAgLy8gT3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdNcmFwQWxpYXMnLCB7IHZhbHVlOiBtcmFwLmF0dHJBbGlhcyB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTXJhcEFybicsIHtcbiAgICAgIHZhbHVlOiBgYXJuOmF3czpzMzo6JHtwcm9wcy5hY2NvdW50SWR9OmFjY2Vzc3BvaW50LyR7bXJhcC5hdHRyQWxpYXN9YCxcbiAgICB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUmVwbGljYXRpb25Sb2xlQXJuJywgeyB2YWx1ZTogcmVwbGljYXRpb25Sb2xlLnJvbGVBcm4gfSk7XG4gIH1cbn1cbiJdfQ==