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
exports.RegionalBucketStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const sns = __importStar(require("aws-cdk-lib/aws-sns"));
const kms = __importStar(require("aws-cdk-lib/aws-kms"));
const s3n = __importStar(require("aws-cdk-lib/aws-s3-notifications"));
class RegionalBucketStack extends cdk.Stack {
    bucket;
    constructor(scope, id, props) {
        super(scope, id, props);
        const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        this.bucket = new s3.Bucket(this, 'Bucket', {
            bucketName: `${props.project}-${this.region}-${this.account}`,
            versioned: true,
            encryption: s3.BucketEncryption.KMS_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            serverAccessLogsBucket: accessLogsBucket,
            serverAccessLogsPrefix: 'access-logs/',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        // SNS topic for replication failure events
        const replFailTopic = new sns.Topic(this, 'ReplicationFailureTopic', {
            topicName: `${props.project}-repl-failures-${this.region}`,
            enforceSSL: true,
            masterKey: kms.Alias.fromAliasName(this, 'SnsKey', 'alias/aws/sns'),
        });
        this.bucket.addEventNotification(s3.EventType.REPLICATION_OPERATION_FAILED_REPLICATION, new s3n.SnsDestination(replFailTopic));
        new cdk.CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
        new cdk.CfnOutput(this, 'BucketArn', { value: this.bucket.bucketArn });
        new cdk.CfnOutput(this, 'ReplicationFailureTopicArn', { value: replFailTopic.topicArn });
    }
}
exports.RegionalBucketStack = RegionalBucketStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVnaW9uYWwtYnVja2V0LXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicmVnaW9uYWwtYnVja2V0LXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLGlEQUFtQztBQUNuQyx1REFBeUM7QUFDekMseURBQTJDO0FBRTNDLHlEQUEyQztBQUMzQyxzRUFBd0Q7QUFNeEQsTUFBYSxtQkFBb0IsU0FBUSxHQUFHLENBQUMsS0FBSztJQUNoQyxNQUFNLENBQVk7SUFFbEMsWUFBWSxLQUFjLEVBQUUsRUFBVSxFQUFFLEtBQStCO1FBQ3JFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sZ0JBQWdCLEdBQUcsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtZQUMvRCxVQUFVLEVBQUUsRUFBRSxDQUFDLGdCQUFnQixDQUFDLFVBQVU7WUFDMUMsaUJBQWlCLEVBQUUsRUFBRSxDQUFDLGlCQUFpQixDQUFDLFNBQVM7WUFDakQsVUFBVSxFQUFFLElBQUk7WUFDaEIsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztZQUN4QyxpQkFBaUIsRUFBRSxJQUFJO1NBQ3hCLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUU7WUFDMUMsVUFBVSxFQUFFLEdBQUcsS0FBSyxDQUFDLE9BQU8sSUFBSSxJQUFJLENBQUMsTUFBTSxJQUFJLElBQUksQ0FBQyxPQUFPLEVBQUU7WUFDN0QsU0FBUyxFQUFFLElBQUk7WUFDZixVQUFVLEVBQUUsRUFBRSxDQUFDLGdCQUFnQixDQUFDLFdBQVc7WUFDM0MsaUJBQWlCLEVBQUUsRUFBRSxDQUFDLGlCQUFpQixDQUFDLFNBQVM7WUFDakQsVUFBVSxFQUFFLElBQUk7WUFDaEIsc0JBQXNCLEVBQUUsZ0JBQWdCO1lBQ3hDLHNCQUFzQixFQUFFLGNBQWM7WUFDdEMsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztZQUN4QyxpQkFBaUIsRUFBRSxJQUFJO1NBQ3hCLENBQUMsQ0FBQztRQUVILDJDQUEyQztRQUMzQyxNQUFNLGFBQWEsR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLHlCQUF5QixFQUFFO1lBQ25FLFNBQVMsRUFBRSxHQUFHLEtBQUssQ0FBQyxPQUFPLGtCQUFrQixJQUFJLENBQUMsTUFBTSxFQUFFO1lBQzFELFVBQVUsRUFBRSxJQUFJO1lBQ2hCLFNBQVMsRUFBRSxHQUFHLENBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFLGVBQWUsQ0FBQztTQUNwRSxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsTUFBTSxDQUFDLG9CQUFvQixDQUM5QixFQUFFLENBQUMsU0FBUyxDQUFDLHdDQUF3QyxFQUNyRCxJQUFJLEdBQUcsQ0FBQyxjQUFjLENBQUMsYUFBYSxDQUFDLENBQ3RDLENBQUM7UUFFRixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRSxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDLFVBQVUsRUFBRSxDQUFDLENBQUM7UUFDekUsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxXQUFXLEVBQUUsRUFBRSxLQUFLLEVBQUUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxTQUFTLEVBQUUsQ0FBQyxDQUFDO1FBQ3ZFLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsNEJBQTRCLEVBQUUsRUFBRSxLQUFLLEVBQUUsYUFBYSxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7SUFDM0YsQ0FBQztDQUNGO0FBMUNELGtEQTBDQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0ICogYXMgc25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zbnMnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMga21zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1rbXMnO1xuaW1wb3J0ICogYXMgczNuIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMy1ub3RpZmljYXRpb25zJztcblxuZXhwb3J0IGludGVyZmFjZSBSZWdpb25hbEJ1Y2tldFN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIHJlYWRvbmx5IHByb2plY3Q6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIFJlZ2lvbmFsQnVja2V0U3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgYnVja2V0OiBzMy5CdWNrZXQ7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IGNkay5BcHAsIGlkOiBzdHJpbmcsIHByb3BzOiBSZWdpb25hbEJ1Y2tldFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIGNvbnN0IGFjY2Vzc0xvZ3NCdWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdBY2Nlc3NMb2dzQnVja2V0Jywge1xuICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWUsXG4gICAgfSk7XG5cbiAgICB0aGlzLmJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ0J1Y2tldCcsIHtcbiAgICAgIGJ1Y2tldE5hbWU6IGAke3Byb3BzLnByb2plY3R9LSR7dGhpcy5yZWdpb259LSR7dGhpcy5hY2NvdW50fWAsXG4gICAgICB2ZXJzaW9uZWQ6IHRydWUsXG4gICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLktNU19NQU5BR0VELFxuICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICBzZXJ2ZXJBY2Nlc3NMb2dzQnVja2V0OiBhY2Nlc3NMb2dzQnVja2V0LFxuICAgICAgc2VydmVyQWNjZXNzTG9nc1ByZWZpeDogJ2FjY2Vzcy1sb2dzLycsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBTTlMgdG9waWMgZm9yIHJlcGxpY2F0aW9uIGZhaWx1cmUgZXZlbnRzXG4gICAgY29uc3QgcmVwbEZhaWxUb3BpYyA9IG5ldyBzbnMuVG9waWModGhpcywgJ1JlcGxpY2F0aW9uRmFpbHVyZVRvcGljJywge1xuICAgICAgdG9waWNOYW1lOiBgJHtwcm9wcy5wcm9qZWN0fS1yZXBsLWZhaWx1cmVzLSR7dGhpcy5yZWdpb259YCxcbiAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICBtYXN0ZXJLZXk6IGttcy5BbGlhcy5mcm9tQWxpYXNOYW1lKHRoaXMsICdTbnNLZXknLCAnYWxpYXMvYXdzL3NucycpLFxuICAgIH0pO1xuXG4gICAgdGhpcy5idWNrZXQuYWRkRXZlbnROb3RpZmljYXRpb24oXG4gICAgICBzMy5FdmVudFR5cGUuUkVQTElDQVRJT05fT1BFUkFUSU9OX0ZBSUxFRF9SRVBMSUNBVElPTixcbiAgICAgIG5ldyBzM24uU25zRGVzdGluYXRpb24ocmVwbEZhaWxUb3BpYyksXG4gICAgKTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdCdWNrZXROYW1lJywgeyB2YWx1ZTogdGhpcy5idWNrZXQuYnVja2V0TmFtZSB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQnVja2V0QXJuJywgeyB2YWx1ZTogdGhpcy5idWNrZXQuYnVja2V0QXJuIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdSZXBsaWNhdGlvbkZhaWx1cmVUb3BpY0FybicsIHsgdmFsdWU6IHJlcGxGYWlsVG9waWMudG9waWNBcm4gfSk7XG4gIH1cbn1cbiJdfQ==