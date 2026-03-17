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
exports.KmsReplicaStack = exports.KmsStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const kms = __importStar(require("aws-cdk-lib/aws-kms"));
class KmsStack extends cdk.Stack {
    key;
    constructor(scope, id, props) {
        super(scope, id, props);
        this.key = new kms.Key(this, 'MrKey', {
            alias: `${props.project}-mrk`,
            description: `Multi-region key for ${props.project}`,
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        const cfnKey = this.key.node.defaultChild;
        cfnKey.addPropertyOverride('MultiRegion', true);
        new cdk.CfnOutput(this, 'KeyArn', { value: this.key.keyArn });
        new cdk.CfnOutput(this, 'KeyId', { value: this.key.keyId });
    }
}
exports.KmsStack = KmsStack;
class KmsReplicaStack extends cdk.Stack {
    replicaKeyArn;
    constructor(scope, id, props) {
        super(scope, id, props);
        const replica = new kms.CfnReplicaKey(this, 'MrKeyReplica', {
            primaryKeyArn: props.primaryKeyArn,
            keyPolicy: {
                Version: '2012-10-17',
                Statement: [{
                        Sid: 'EnableIAMPolicies',
                        Effect: 'Allow',
                        Principal: { AWS: `arn:aws:iam::${props.accountId}:root` },
                        Action: 'kms:*',
                        Resource: '*',
                    }],
            },
            description: `Multi-region replica key for ${props.project}`,
        });
        new kms.CfnAlias(this, 'MrKeyReplicaAlias', {
            aliasName: `alias/${props.project}-mrk`,
            targetKeyId: replica.attrKeyId,
        });
        this.replicaKeyArn = replica.attrArn;
        new cdk.CfnOutput(this, 'ReplicaKeyArn', { value: replica.attrArn });
    }
}
exports.KmsReplicaStack = KmsReplicaStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoia21zLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsia21zLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLGlEQUFtQztBQUNuQyx5REFBMkM7QUFNM0MsTUFBYSxRQUFTLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDckIsR0FBRyxDQUFVO0lBRTdCLFlBQVksS0FBYyxFQUFFLEVBQVUsRUFBRSxLQUFvQjtRQUMxRCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixJQUFJLENBQUMsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFO1lBQ3BDLEtBQUssRUFBRSxHQUFHLEtBQUssQ0FBQyxPQUFPLE1BQU07WUFDN0IsV0FBVyxFQUFFLHdCQUF3QixLQUFLLENBQUMsT0FBTyxFQUFFO1lBQ3BELGlCQUFpQixFQUFFLElBQUk7WUFDdkIsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztTQUN6QyxDQUFDLENBQUM7UUFFSCxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxZQUEwQixDQUFDO1FBQ3hELE1BQU0sQ0FBQyxtQkFBbUIsQ0FBQyxhQUFhLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFFaEQsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUUsRUFBRSxLQUFLLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO1FBQzlELElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFLEVBQUUsS0FBSyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQztJQUM5RCxDQUFDO0NBQ0Y7QUFuQkQsNEJBbUJDO0FBUUQsTUFBYSxlQUFnQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQzVCLGFBQWEsQ0FBUztJQUV0QyxZQUFZLEtBQWMsRUFBRSxFQUFVLEVBQUUsS0FBMkI7UUFDakUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFHLENBQUMsYUFBYSxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDMUQsYUFBYSxFQUFFLEtBQUssQ0FBQyxhQUFhO1lBQ2xDLFNBQVMsRUFBRTtnQkFDVCxPQUFPLEVBQUUsWUFBWTtnQkFDckIsU0FBUyxFQUFFLENBQUM7d0JBQ1YsR0FBRyxFQUFFLG1CQUFtQjt3QkFDeEIsTUFBTSxFQUFFLE9BQU87d0JBQ2YsU0FBUyxFQUFFLEVBQUUsR0FBRyxFQUFFLGdCQUFnQixLQUFLLENBQUMsU0FBUyxPQUFPLEVBQUU7d0JBQzFELE1BQU0sRUFBRSxPQUFPO3dCQUNmLFFBQVEsRUFBRSxHQUFHO3FCQUNkLENBQUM7YUFDSDtZQUNELFdBQVcsRUFBRSxnQ0FBZ0MsS0FBSyxDQUFDLE9BQU8sRUFBRTtTQUM3RCxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO1lBQzFDLFNBQVMsRUFBRSxTQUFTLEtBQUssQ0FBQyxPQUFPLE1BQU07WUFDdkMsV0FBVyxFQUFFLE9BQU8sQ0FBQyxTQUFTO1NBQy9CLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxhQUFhLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQztRQUVyQyxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGVBQWUsRUFBRSxFQUFFLEtBQUssRUFBRSxPQUFPLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQztJQUN2RSxDQUFDO0NBQ0Y7QUE5QkQsMENBOEJDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGttcyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mta21zJztcblxuZXhwb3J0IGludGVyZmFjZSBLbXNTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICByZWFkb25seSBwcm9qZWN0OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBLbXNTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSBrZXk6IGttcy5LZXk7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IGNkay5BcHAsIGlkOiBzdHJpbmcsIHByb3BzOiBLbXNTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICB0aGlzLmtleSA9IG5ldyBrbXMuS2V5KHRoaXMsICdNcktleScsIHtcbiAgICAgIGFsaWFzOiBgJHtwcm9wcy5wcm9qZWN0fS1tcmtgLFxuICAgICAgZGVzY3JpcHRpb246IGBNdWx0aS1yZWdpb24ga2V5IGZvciAke3Byb3BzLnByb2plY3R9YCxcbiAgICAgIGVuYWJsZUtleVJvdGF0aW9uOiB0cnVlLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGNmbktleSA9IHRoaXMua2V5Lm5vZGUuZGVmYXVsdENoaWxkIGFzIGttcy5DZm5LZXk7XG4gICAgY2ZuS2V5LmFkZFByb3BlcnR5T3ZlcnJpZGUoJ011bHRpUmVnaW9uJywgdHJ1ZSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnS2V5QXJuJywgeyB2YWx1ZTogdGhpcy5rZXkua2V5QXJuIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdLZXlJZCcsIHsgdmFsdWU6IHRoaXMua2V5LmtleUlkIH0pO1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgS21zUmVwbGljYVN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIHJlYWRvbmx5IHByb2plY3Q6IHN0cmluZztcbiAgcmVhZG9ubHkgcHJpbWFyeUtleUFybjogc3RyaW5nO1xuICByZWFkb25seSBhY2NvdW50SWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEttc1JlcGxpY2FTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSByZXBsaWNhS2V5QXJuOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IGNkay5BcHAsIGlkOiBzdHJpbmcsIHByb3BzOiBLbXNSZXBsaWNhU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgcmVwbGljYSA9IG5ldyBrbXMuQ2ZuUmVwbGljYUtleSh0aGlzLCAnTXJLZXlSZXBsaWNhJywge1xuICAgICAgcHJpbWFyeUtleUFybjogcHJvcHMucHJpbWFyeUtleUFybixcbiAgICAgIGtleVBvbGljeToge1xuICAgICAgICBWZXJzaW9uOiAnMjAxMi0xMC0xNycsXG4gICAgICAgIFN0YXRlbWVudDogW3tcbiAgICAgICAgICBTaWQ6ICdFbmFibGVJQU1Qb2xpY2llcycsXG4gICAgICAgICAgRWZmZWN0OiAnQWxsb3cnLFxuICAgICAgICAgIFByaW5jaXBhbDogeyBBV1M6IGBhcm46YXdzOmlhbTo6JHtwcm9wcy5hY2NvdW50SWR9OnJvb3RgIH0sXG4gICAgICAgICAgQWN0aW9uOiAna21zOionLFxuICAgICAgICAgIFJlc291cmNlOiAnKicsXG4gICAgICAgIH1dLFxuICAgICAgfSxcbiAgICAgIGRlc2NyaXB0aW9uOiBgTXVsdGktcmVnaW9uIHJlcGxpY2Ega2V5IGZvciAke3Byb3BzLnByb2plY3R9YCxcbiAgICB9KTtcblxuICAgIG5ldyBrbXMuQ2ZuQWxpYXModGhpcywgJ01yS2V5UmVwbGljYUFsaWFzJywge1xuICAgICAgYWxpYXNOYW1lOiBgYWxpYXMvJHtwcm9wcy5wcm9qZWN0fS1tcmtgLFxuICAgICAgdGFyZ2V0S2V5SWQ6IHJlcGxpY2EuYXR0cktleUlkLFxuICAgIH0pO1xuXG4gICAgdGhpcy5yZXBsaWNhS2V5QXJuID0gcmVwbGljYS5hdHRyQXJuO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1JlcGxpY2FLZXlBcm4nLCB7IHZhbHVlOiByZXBsaWNhLmF0dHJBcm4gfSk7XG4gIH1cbn1cbiJdfQ==