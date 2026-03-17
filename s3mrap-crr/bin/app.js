#!/usr/bin/env node
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
const cdk_nag_1 = require("cdk-nag");
const bootstrap_stack_1 = require("../lib/bootstrap-stack");
const regional_bucket_stack_1 = require("../lib/regional-bucket-stack");
const global_routing_stack_1 = require("../lib/global-routing-stack");
const routing_lambda_stack_1 = require("../lib/routing-lambda-stack");
const failover_stack_1 = require("../lib/failover-stack");
const monitoring_stack_1 = require("../lib/monitoring-stack");
const kms_stack_1 = require("../lib/kms-stack");
const app = new cdk.App();
// Enable cdk-nag with: -c nag=true
if (app.node.tryGetContext('nag') === 'true') {
    cdk.Aspects.of(app).add(new cdk_nag_1.AwsSolutionsChecks({ verbose: true }));
}
// Global nag suppressions for CDK framework internals and intentional decisions
const globalSuppressions = [
    { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is standard for Lambda functions' },
    { id: 'AwsSolutions-IAM5', reason: 'Wildcard permissions required: S3 replication needs bucket/*, MRAP alias unknown at synth, CDK framework constructs use wildcards' },
    { id: 'AwsSolutions-L1', reason: 'Python 3.12 is current LTS. CDK Provider framework Lambda runtimes are not user-configurable.' },
];
const project = app.node.tryGetContext('project') || process.env.PROJECT || 's3mrap';
const primaryRegion = app.node.tryGetContext('primaryRegion') || process.env.PRIMARY_REGION || 'us-east-1';
const secondaryRegion = app.node.tryGetContext('secondaryRegion') || process.env.SECONDARY_REGION || 'us-west-2';
const accountId = app.node.tryGetContext('accountId') || process.env.ACCOUNT_ID || process.env.CDK_DEFAULT_ACCOUNT || '000000000000';
const targetStack = app.node.tryGetContext('stack') || process.env.STACK || 'all';
const primaryBucketName = `${project}-${primaryRegion}-${accountId}`;
const secondaryBucketName = `${project}-${secondaryRegion}-${accountId}`;
const mrapName = `${project}-mrap`;
const mrapAlias = app.node.tryGetContext('mrapAlias') || '';
const routingFnName = `${project}-mrap-routing`;
const primaryRoutingLambdaArn = `arn:aws:lambda:${primaryRegion}:${accountId}:function:${routingFnName}`;
const secondaryRoutingLambdaArn = `arn:aws:lambda:${secondaryRegion}:${accountId}:function:${routingFnName}`;
// MRK key ARN/ID — resolved after kms stack deploys, passed via context for subsequent stacks
const encryptionKeyId = app.node.tryGetContext('encryptionKeyId') || 'PLACEHOLDER';
const encryptionKeyArnPrimary = `arn:aws:kms:${primaryRegion}:${accountId}:key/${encryptionKeyId}`;
const encryptionKeyArnSecondary = `arn:aws:kms:${secondaryRegion}:${accountId}:key/${encryptionKeyId}`;
const routingLambdaProps = {
    project,
    primaryBucketName,
    secondaryBucketName,
    primaryRegion,
    secondaryRegion,
    accountId,
    mrapName,
    mrapAlias,
};
function addSuppressions(stack, extra = []) {
    cdk_nag_1.NagSuppressions.addStackSuppressions(stack, [...globalSuppressions, ...extra], true);
}
if (targetStack === 'bootstrap' || targetStack === 'all') {
    const s = new bootstrap_stack_1.BootstrapStack(app, `${project}-bootstrap`, {
        project, primaryRegion, secondaryRegion,
        env: { account: accountId, region: primaryRegion },
    });
    addSuppressions(s, [
        { id: 'AwsSolutions-S1', reason: 'Artifact bucket is temporary build storage, access logs not needed' },
        { id: 'AwsSolutions-CB4', reason: 'Demo project — KMS encryption for CodeBuild not required' },
        { id: 'AwsSolutions-SF1', reason: 'CDK Provider waiter state machine — not user-configurable' },
        { id: 'AwsSolutions-SF2', reason: 'CDK Provider waiter state machine — not user-configurable' },
    ]);
}
if (targetStack === 'kms' || targetStack === 'all') {
    addSuppressions(new kms_stack_1.KmsStack(app, `${project}-kms`, {
        project,
        env: { account: accountId, region: primaryRegion },
    }));
}
if (targetStack === 'kms-replica' || targetStack === 'all') {
    addSuppressions(new kms_stack_1.KmsReplicaStack(app, `${project}-kms-replica`, {
        project, accountId,
        primaryKeyArn: encryptionKeyArnPrimary,
        env: { account: accountId, region: secondaryRegion },
    }));
}
if (targetStack === 'bucket-primary' || targetStack === 'all') {
    addSuppressions(new regional_bucket_stack_1.RegionalBucketStack(app, `${project}-bucket-primary`, {
        project,
        encryptionKeyArn: encryptionKeyArnPrimary,
        env: { account: accountId, region: primaryRegion },
    }));
}
if (targetStack === 'bucket-secondary' || targetStack === 'all') {
    addSuppressions(new regional_bucket_stack_1.RegionalBucketStack(app, `${project}-bucket-secondary`, {
        project,
        encryptionKeyArn: encryptionKeyArnSecondary,
        env: { account: accountId, region: secondaryRegion },
    }));
}
if (targetStack === 'global-routing' || targetStack === 'all') {
    addSuppressions(new global_routing_stack_1.GlobalRoutingStack(app, `${project}-global-routing`, {
        project, primaryBucketName, secondaryBucketName,
        primaryRegion, secondaryRegion, accountId,
        encryptionKeyId,
        env: { account: accountId, region: primaryRegion },
    }));
}
if (targetStack === 'routing-primary' || targetStack === 'all') {
    addSuppressions(new routing_lambda_stack_1.RoutingLambdaStack(app, `${project}-routing-primary`, {
        ...routingLambdaProps,
        env: { account: accountId, region: primaryRegion },
    }));
}
if (targetStack === 'routing-secondary' || targetStack === 'all') {
    addSuppressions(new routing_lambda_stack_1.RoutingLambdaStack(app, `${project}-routing-secondary`, {
        ...routingLambdaProps,
        env: { account: accountId, region: secondaryRegion },
    }));
}
if (targetStack === 'failover' || targetStack === 'all') {
    addSuppressions(new failover_stack_1.FailoverStack(app, `${project}-failover`, {
        project, primaryBucketName, secondaryBucketName,
        primaryRegion, secondaryRegion, accountId, mrapName,
        primaryRoutingLambdaArn, secondaryRoutingLambdaArn,
        env: { account: accountId, region: primaryRegion },
    }));
}
if (targetStack === 'monitoring-primary' || targetStack === 'all') {
    addSuppressions(new monitoring_stack_1.MonitoringStack(app, `${project}-monitoring-primary`, {
        project,
        sourceBucketName: secondaryBucketName, destBucketName: primaryBucketName,
        replicationRuleId: 'to-primary', sourceRegionLabel: 'pdx', destRegionLabel: 'iad',
        reverseRuleId: 'to-secondary', reverseSourceBucketName: primaryBucketName, reverseDestBucketName: secondaryBucketName,
        primaryRegion, secondaryRegion, accountId, mrapAlias,
        encryptionKeyArn: encryptionKeyArnPrimary,
        env: { account: accountId, region: primaryRegion },
    }));
}
if (targetStack === 'monitoring-secondary' || targetStack === 'all') {
    addSuppressions(new monitoring_stack_1.MonitoringStack(app, `${project}-monitoring-secondary`, {
        project,
        sourceBucketName: primaryBucketName, destBucketName: secondaryBucketName,
        replicationRuleId: 'to-secondary', sourceRegionLabel: 'iad', destRegionLabel: 'pdx',
        reverseRuleId: 'to-primary', reverseSourceBucketName: secondaryBucketName, reverseDestBucketName: primaryBucketName,
        primaryRegion, secondaryRegion, accountId, mrapAlias,
        encryptionKeyArn: encryptionKeyArnSecondary,
        env: { account: accountId, region: secondaryRegion },
    }));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBwLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUNBLGlEQUFtQztBQUNuQyxxQ0FBOEQ7QUFDOUQsNERBQXdEO0FBQ3hELHdFQUFtRTtBQUNuRSxzRUFBaUU7QUFDakUsc0VBQWlFO0FBQ2pFLDBEQUFzRDtBQUN0RCw4REFBMEQ7QUFDMUQsZ0RBQTZEO0FBRTdELE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO0FBRTFCLG1DQUFtQztBQUNuQyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLEtBQUssQ0FBQyxLQUFLLE1BQU0sRUFBRSxDQUFDO0lBQzdDLEdBQUcsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxJQUFJLDRCQUFrQixDQUFDLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQztBQUNyRSxDQUFDO0FBRUQsZ0ZBQWdGO0FBQ2hGLE1BQU0sa0JBQWtCLEdBQUc7SUFDekIsRUFBRSxFQUFFLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxFQUFFLDhEQUE4RCxFQUFFO0lBQ25HLEVBQUUsRUFBRSxFQUFFLG1CQUFtQixFQUFFLE1BQU0sRUFBRSxtSUFBbUksRUFBRTtJQUN4SyxFQUFFLEVBQUUsRUFBRSxpQkFBaUIsRUFBRSxNQUFNLEVBQUUsK0ZBQStGLEVBQUU7Q0FDbkksQ0FBQztBQUVGLE1BQU0sT0FBTyxHQUFHLEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLFNBQVMsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsT0FBTyxJQUFJLFFBQVEsQ0FBQztBQUNyRixNQUFNLGFBQWEsR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxlQUFlLENBQUMsSUFBSSxPQUFPLENBQUMsR0FB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QUFFLEtBQUssRUFBRSxlQUFlLEVBQUUsS0FBSztRQUNuRixhQUFhLEVBQUUsWUFBWSxFQUFFLHVCQUF1QixFQUFFLG1CQUFtQixFQUFFLHFCQUFxQixFQUFFLGlCQUFpQjtRQUNuSCxhQUFhLEVBQUUsZUFBZSxFQUFFLFNBQVMsRUFBRSxTQUFTO1FBQ3BELGdCQUFnQixFQUFFLHlCQUF5QjtRQUMzQyxHQUFHLEVBQUUsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sRUFBRSxlQUFlLEVBQUU7S0FDckQsQ0FBQyxDQUFDLENBQUM7QUFDTixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiIyEvdXNyL2Jpbi9lbnYgbm9kZVxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IEF3c1NvbHV0aW9uc0NoZWNrcywgTmFnU3VwcHJlc3Npb25zIH0gZnJvbSAnY2RrLW5hZyc7XG5pbXBvcnQgeyBCb290c3RyYXBTdGFjayB9IGZyb20gJy4uL2xpYi9ib290c3RyYXAtc3RhY2snO1xuaW1wb3J0IHsgUmVnaW9uYWxCdWNrZXRTdGFjayB9IGZyb20gJy4uL2xpYi9yZWdpb25hbC1idWNrZXQtc3RhY2snO1xuaW1wb3J0IHsgR2xvYmFsUm91dGluZ1N0YWNrIH0gZnJvbSAnLi4vbGliL2dsb2JhbC1yb3V0aW5nLXN0YWNrJztcbmltcG9ydCB7IFJvdXRpbmdMYW1iZGFTdGFjayB9IGZyb20gJy4uL2xpYi9yb3V0aW5nLWxhbWJkYS1zdGFjayc7XG5pbXBvcnQgeyBGYWlsb3ZlclN0YWNrIH0gZnJvbSAnLi4vbGliL2ZhaWxvdmVyLXN0YWNrJztcbmltcG9ydCB7IE1vbml0b3JpbmdTdGFjayB9IGZyb20gJy4uL2xpYi9tb25pdG9yaW5nLXN0YWNrJztcbmltcG9ydCB7IEttc1N0YWNrLCBLbXNSZXBsaWNhU3RhY2sgfSBmcm9tICcuLi9saWIva21zLXN0YWNrJztcblxuY29uc3QgYXBwID0gbmV3IGNkay5BcHAoKTtcblxuLy8gRW5hYmxlIGNkay1uYWcgd2l0aDogLWMgbmFnPXRydWVcbmlmIChhcHAubm9kZS50cnlHZXRDb250ZXh0KCduYWcnKSA9PT0gJ3RydWUnKSB7XG4gIGNkay5Bc3BlY3RzLm9mKGFwcCkuYWRkKG5ldyBBd3NTb2x1dGlvbnNDaGVja3MoeyB2ZXJib3NlOiB0cnVlIH0pKTtcbn1cblxuLy8gR2xvYmFsIG5hZyBzdXBwcmVzc2lvbnMgZm9yIENESyBmcmFtZXdvcmsgaW50ZXJuYWxzIGFuZCBpbnRlbnRpb25hbCBkZWNpc2lvbnNcbmNvbnN0IGdsb2JhbFN1cHByZXNzaW9ucyA9IFtcbiAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU00JywgcmVhc29uOiAnQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlIGlzIHN0YW5kYXJkIGZvciBMYW1iZGEgZnVuY3Rpb25zJyB9LFxuICB7IGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLCByZWFzb246ICdXaWxkY2FyZCBwZXJtaXNzaW9ucyByZXF1aXJlZDogUzMgcmVwbGljYXRpb24gbmVlZHMgYnVja2V0LyosIE1SQVAgYWxpYXMgdW5rbm93biBhdCBzeW50aCwgQ0RLIGZyYW1ld29yayBjb25zdHJ1Y3RzIHVzZSB3aWxkY2FyZHMnIH0sXG4gIHsgaWQ6ICdBd3NTb2x1dGlvbnMtTDEnLCByZWFzb246ICdQeXRob24gMy4xMiBpcyBjdXJyZW50IExUUy4gQ0RLIFByb3ZpZGVyIGZyYW1ld29yayBMYW1iZGEgcnVudGltZXMgYXJlIG5vdCB1c2VyLWNvbmZpZ3VyYWJsZS4nIH0sXG5dO1xuXG5jb25zdCBwcm9qZWN0ID0gYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgncHJvamVjdCcpIHx8IHByb2Nlc3MuZW52LlBST0pFQ1QgfHwgJ3MzbXJhcCc7XG5jb25zdCBwcmltYXJ5UmVnaW9uID0gYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgncHJpbWFyeVJlZ2lvbicpIHx8IHByb2Nlc3MuZW52LlBSSU1BUllfUkVHSU9OIHx8ICd1cy1lYXN0LTEnO1xuY29uc3Qgc2Vjb25kYXJ5UmVnaW9uID0gYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgnc2Vjb25kYXJ5UmVnaW9uJykgfHwgcHJvY2Vzcy5lbnYuU0VDT05EQVJZX1JFR0lPTiB8fCAndXMtd2VzdC0yJztcbmNvbnN0IGFjY291bnRJZCA9IGFwcC5ub2RlLnRyeUdldENvbnRleHQoJ2FjY291bnRJZCcpIHx8IHByb2Nlc3MuZW52LkFDQ09VTlRfSUQgfHwgcHJvY2Vzcy5lbnYuQ0RLX0RFRkFVTFRfQUNDT1VOVCB8fCAnMDAwMDAwMDAwMDAwJztcblxuY29uc3QgdGFyZ2V0U3RhY2sgPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdzdGFjaycpIHx8IHByb2Nlc3MuZW52LlNUQUNLIHx8ICdhbGwnO1xuXG5jb25zdCBwcmltYXJ5QnVja2V0TmFtZSA9IGAke3Byb2plY3R9LSR7cHJpbWFyeVJlZ2lvbn0tJHthY2NvdW50SWR9YDtcbmNvbnN0IHNlY29uZGFyeUJ1Y2tldE5hbWUgPSBgJHtwcm9qZWN0fS0ke3NlY29uZGFyeVJlZ2lvbn0tJHthY2NvdW50SWR9YDtcbmNvbnN0IG1yYXBOYW1lID0gYCR7cHJvamVjdH0tbXJhcGA7XG5jb25zdCBtcmFwQWxpYXMgPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdtcmFwQWxpYXMnKSB8fCAnJztcbmNvbnN0IHJvdXRpbmdGbk5hbWUgPSBgJHtwcm9qZWN0fS1tcmFwLXJvdXRpbmdgO1xuY29uc3QgcHJpbWFyeVJvdXRpbmdMYW1iZGFBcm4gPSBgYXJuOmF3czpsYW1iZGE6JHtwcmltYXJ5UmVnaW9ufToke2FjY291bnRJZH06ZnVuY3Rpb246JHtyb3V0aW5nRm5OYW1lfWA7XG5jb25zdCBzZWNvbmRhcnlSb3V0aW5nTGFtYmRhQXJuID0gYGFybjphd3M6bGFtYmRhOiR7c2Vjb25kYXJ5UmVnaW9ufToke2FjY291bnRJZH06ZnVuY3Rpb246JHtyb3V0aW5nRm5OYW1lfWA7XG5cbi8vIE1SSyBrZXkgQVJOL0lEIOKAlCByZXNvbHZlZCBhZnRlciBrbXMgc3RhY2sgZGVwbG95cywgcGFzc2VkIHZpYSBjb250ZXh0IGZvciBzdWJzZXF1ZW50IHN0YWNrc1xuY29uc3QgZW5jcnlwdGlvbktleUlkID0gYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgnZW5jcnlwdGlvbktleUlkJykgfHwgJ1BMQUNFSE9MREVSJztcbmNvbnN0IGVuY3J5cHRpb25LZXlBcm5QcmltYXJ5ID0gYGFybjphd3M6a21zOiR7cHJpbWFyeVJlZ2lvbn06JHthY2NvdW50SWR9OmtleS8ke2VuY3J5cHRpb25LZXlJZH1gO1xuY29uc3QgZW5jcnlwdGlvbktleUFyblNlY29uZGFyeSA9IGBhcm46YXdzOmttczoke3NlY29uZGFyeVJlZ2lvbn06JHthY2NvdW50SWR9OmtleS8ke2VuY3J5cHRpb25LZXlJZH1gO1xuXG5jb25zdCByb3V0aW5nTGFtYmRhUHJvcHMgPSB7XG4gIHByb2plY3QsXG4gIHByaW1hcnlCdWNrZXROYW1lLFxuICBzZWNvbmRhcnlCdWNrZXROYW1lLFxuICBwcmltYXJ5UmVnaW9uLFxuICBzZWNvbmRhcnlSZWdpb24sXG4gIGFjY291bnRJZCxcbiAgbXJhcE5hbWUsXG4gIG1yYXBBbGlhcyxcbn07XG5cbmZ1bmN0aW9uIGFkZFN1cHByZXNzaW9ucyhzdGFjazogY2RrLlN0YWNrLCBleHRyYTogeyBpZDogc3RyaW5nOyByZWFzb246IHN0cmluZyB9W10gPSBbXSkge1xuICBOYWdTdXBwcmVzc2lvbnMuYWRkU3RhY2tTdXBwcmVzc2lvbnMoc3RhY2ssIFsuLi5nbG9iYWxTdXBwcmVzc2lvbnMsIC4uLmV4dHJhXSwgdHJ1ZSk7XG59XG5cbmlmICh0YXJnZXRTdGFjayA9PT0gJ2Jvb3RzdHJhcCcgfHwgdGFyZ2V0U3RhY2sgPT09ICdhbGwnKSB7XG4gIGNvbnN0IHMgPSBuZXcgQm9vdHN0cmFwU3RhY2soYXBwLCBgJHtwcm9qZWN0fS1ib290c3RyYXBgLCB7XG4gICAgcHJvamVjdCwgcHJpbWFyeVJlZ2lvbiwgc2Vjb25kYXJ5UmVnaW9uLFxuICAgIGVudjogeyBhY2NvdW50OiBhY2NvdW50SWQsIHJlZ2lvbjogcHJpbWFyeVJlZ2lvbiB9LFxuICB9KTtcbiAgYWRkU3VwcHJlc3Npb25zKHMsIFtcbiAgICB7IGlkOiAnQXdzU29sdXRpb25zLVMxJywgcmVhc29uOiAnQXJ0aWZhY3QgYnVja2V0IGlzIHRlbXBvcmFyeSBidWlsZCBzdG9yYWdlLCBhY2Nlc3MgbG9ncyBub3QgbmVlZGVkJyB9LFxuICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtQ0I0JywgcmVhc29uOiAnRGVtbyBwcm9qZWN0IOKAlCBLTVMgZW5jcnlwdGlvbiBmb3IgQ29kZUJ1aWxkIG5vdCByZXF1aXJlZCcgfSxcbiAgICB7IGlkOiAnQXdzU29sdXRpb25zLVNGMScsIHJlYXNvbjogJ0NESyBQcm92aWRlciB3YWl0ZXIgc3RhdGUgbWFjaGluZSDigJQgbm90IHVzZXItY29uZmlndXJhYmxlJyB9LFxuICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtU0YyJywgcmVhc29uOiAnQ0RLIFByb3ZpZGVyIHdhaXRlciBzdGF0ZSBtYWNoaW5lIOKAlCBub3QgdXNlci1jb25maWd1cmFibGUnIH0sXG4gIF0pO1xufVxuXG5pZiAodGFyZ2V0U3RhY2sgPT09ICdrbXMnIHx8IHRhcmdldFN0YWNrID09PSAnYWxsJykge1xuICBhZGRTdXBwcmVzc2lvbnMobmV3IEttc1N0YWNrKGFwcCwgYCR7cHJvamVjdH0ta21zYCwge1xuICAgIHByb2plY3QsXG4gICAgZW52OiB7IGFjY291bnQ6IGFjY291bnRJZCwgcmVnaW9uOiBwcmltYXJ5UmVnaW9uIH0sXG4gIH0pKTtcbn1cblxuaWYgKHRhcmdldFN0YWNrID09PSAna21zLXJlcGxpY2EnIHx8IHRhcmdldFN0YWNrID09PSAnYWxsJykge1xuICBhZGRTdXBwcmVzc2lvbnMobmV3IEttc1JlcGxpY2FTdGFjayhhcHAsIGAke3Byb2plY3R9LWttcy1yZXBsaWNhYCwge1xuICAgIHByb2plY3QsIGFjY291bnRJZCxcbiAgICBwcmltYXJ5S2V5QXJuOiBlbmNyeXB0aW9uS2V5QXJuUHJpbWFyeSxcbiAgICBlbnY6IHsgYWNjb3VudDogYWNjb3VudElkLCByZWdpb246IHNlY29uZGFyeVJlZ2lvbiB9LFxuICB9KSk7XG59XG5cbmlmICh0YXJnZXRTdGFjayA9PT0gJ2J1Y2tldC1wcmltYXJ5JyB8fCB0YXJnZXRTdGFjayA9PT0gJ2FsbCcpIHtcbiAgYWRkU3VwcHJlc3Npb25zKG5ldyBSZWdpb25hbEJ1Y2tldFN0YWNrKGFwcCwgYCR7cHJvamVjdH0tYnVja2V0LXByaW1hcnlgLCB7XG4gICAgcHJvamVjdCxcbiAgICBlbmNyeXB0aW9uS2V5QXJuOiBlbmNyeXB0aW9uS2V5QXJuUHJpbWFyeSxcbiAgICBlbnY6IHsgYWNjb3VudDogYWNjb3VudElkLCByZWdpb246IHByaW1hcnlSZWdpb24gfSxcbiAgfSkpO1xufVxuXG5pZiAodGFyZ2V0U3RhY2sgPT09ICdidWNrZXQtc2Vjb25kYXJ5JyB8fCB0YXJnZXRTdGFjayA9PT0gJ2FsbCcpIHtcbiAgYWRkU3VwcHJlc3Npb25zKG5ldyBSZWdpb25hbEJ1Y2tldFN0YWNrKGFwcCwgYCR7cHJvamVjdH0tYnVja2V0LXNlY29uZGFyeWAsIHtcbiAgICBwcm9qZWN0LFxuICAgIGVuY3J5cHRpb25LZXlBcm46IGVuY3J5cHRpb25LZXlBcm5TZWNvbmRhcnksXG4gICAgZW52OiB7IGFjY291bnQ6IGFjY291bnRJZCwgcmVnaW9uOiBzZWNvbmRhcnlSZWdpb24gfSxcbiAgfSkpO1xufVxuXG5pZiAodGFyZ2V0U3RhY2sgPT09ICdnbG9iYWwtcm91dGluZycgfHwgdGFyZ2V0U3RhY2sgPT09ICdhbGwnKSB7XG4gIGFkZFN1cHByZXNzaW9ucyhuZXcgR2xvYmFsUm91dGluZ1N0YWNrKGFwcCwgYCR7cHJvamVjdH0tZ2xvYmFsLXJvdXRpbmdgLCB7XG4gICAgcHJvamVjdCwgcHJpbWFyeUJ1Y2tldE5hbWUsIHNlY29uZGFyeUJ1Y2tldE5hbWUsXG4gICAgcHJpbWFyeVJlZ2lvbiwgc2Vjb25kYXJ5UmVnaW9uLCBhY2NvdW50SWQsXG4gICAgZW5jcnlwdGlvbktleUlkLFxuICAgIGVudjogeyBhY2NvdW50OiBhY2NvdW50SWQsIHJlZ2lvbjogcHJpbWFyeVJlZ2lvbiB9LFxuICB9KSk7XG59XG5cbmlmICh0YXJnZXRTdGFjayA9PT0gJ3JvdXRpbmctcHJpbWFyeScgfHwgdGFyZ2V0U3RhY2sgPT09ICdhbGwnKSB7XG4gIGFkZFN1cHByZXNzaW9ucyhuZXcgUm91dGluZ0xhbWJkYVN0YWNrKGFwcCwgYCR7cHJvamVjdH0tcm91dGluZy1wcmltYXJ5YCwge1xuICAgIC4uLnJvdXRpbmdMYW1iZGFQcm9wcyxcbiAgICBlbnY6IHsgYWNjb3VudDogYWNjb3VudElkLCByZWdpb246IHByaW1hcnlSZWdpb24gfSxcbiAgfSkpO1xufVxuXG5pZiAodGFyZ2V0U3RhY2sgPT09ICdyb3V0aW5nLXNlY29uZGFyeScgfHwgdGFyZ2V0U3RhY2sgPT09ICdhbGwnKSB7XG4gIGFkZFN1cHByZXNzaW9ucyhuZXcgUm91dGluZ0xhbWJkYVN0YWNrKGFwcCwgYCR7cHJvamVjdH0tcm91dGluZy1zZWNvbmRhcnlgLCB7XG4gICAgLi4ucm91dGluZ0xhbWJkYVByb3BzLFxuICAgIGVudjogeyBhY2NvdW50OiBhY2NvdW50SWQsIHJlZ2lvbjogc2Vjb25kYXJ5UmVnaW9uIH0sXG4gIH0pKTtcbn1cblxuaWYgKHRhcmdldFN0YWNrID09PSAnZmFpbG92ZXInIHx8IHRhcmdldFN0YWNrID09PSAnYWxsJykge1xuICBhZGRTdXBwcmVzc2lvbnMobmV3IEZhaWxvdmVyU3RhY2soYXBwLCBgJHtwcm9qZWN0fS1mYWlsb3ZlcmAsIHtcbiAgICBwcm9qZWN0LCBwcmltYXJ5QnVja2V0TmFtZSwgc2Vjb25kYXJ5QnVja2V0TmFtZSxcbiAgICBwcmltYXJ5UmVnaW9uLCBzZWNvbmRhcnlSZWdpb24sIGFjY291bnRJZCwgbXJhcE5hbWUsXG4gICAgcHJpbWFyeVJvdXRpbmdMYW1iZGFBcm4sIHNlY29uZGFyeVJvdXRpbmdMYW1iZGFBcm4sXG4gICAgZW52OiB7IGFjY291bnQ6IGFjY291bnRJZCwgcmVnaW9uOiBwcmltYXJ5UmVnaW9uIH0sXG4gIH0pKTtcbn1cblxuaWYgKHRhcmdldFN0YWNrID09PSAnbW9uaXRvcmluZy1wcmltYXJ5JyB8fCB0YXJnZXRTdGFjayA9PT0gJ2FsbCcpIHtcbiAgYWRkU3VwcHJlc3Npb25zKG5ldyBNb25pdG9yaW5nU3RhY2soYXBwLCBgJHtwcm9qZWN0fS1tb25pdG9yaW5nLXByaW1hcnlgLCB7XG4gICAgcHJvamVjdCxcbiAgICBzb3VyY2VCdWNrZXROYW1lOiBzZWNvbmRhcnlCdWNrZXROYW1lLCBkZXN0QnVja2V0TmFtZTogcHJpbWFyeUJ1Y2tldE5hbWUsXG4gICAgcmVwbGljYXRpb25SdWxlSWQ6ICd0by1wcmltYXJ5Jywgc291cmNlUmVnaW9uTGFiZWw6ICdwZHgnLCBkZXN0UmVnaW9uTGFiZWw6ICdpYWQnLFxuICAgIHJldmVyc2VSdWxlSWQ6ICd0by1zZWNvbmRhcnknLCByZXZlcnNlU291cmNlQnVja2V0TmFtZTogcHJpbWFyeUJ1Y2tldE5hbWUsIHJldmVyc2VEZXN0QnVja2V0TmFtZTogc2Vjb25kYXJ5QnVja2V0TmFtZSxcbiAgICBwcmltYXJ5UmVnaW9uLCBzZWNvbmRhcnlSZWdpb24sIGFjY291bnRJZCwgbXJhcEFsaWFzLFxuICAgIGVuY3J5cHRpb25LZXlBcm46IGVuY3J5cHRpb25LZXlBcm5QcmltYXJ5LFxuICAgIGVudjogeyBhY2NvdW50OiBhY2NvdW50SWQsIHJlZ2lvbjogcHJpbWFyeVJlZ2lvbiB9LFxuICB9KSk7XG59XG5cbmlmICh0YXJnZXRTdGFjayA9PT0gJ21vbml0b3Jpbmctc2Vjb25kYXJ5JyB8fCB0YXJnZXRTdGFjayA9PT0gJ2FsbCcpIHtcbiAgYWRkU3VwcHJlc3Npb25zKG5ldyBNb25pdG9yaW5nU3RhY2soYXBwLCBgJHtwcm9qZWN0fS1tb25pdG9yaW5nLXNlY29uZGFyeWAsIHtcbiAgICBwcm9qZWN0LFxuICAgIHNvdXJjZUJ1Y2tldE5hbWU6IHByaW1hcnlCdWNrZXROYW1lLCBkZXN0QnVja2V0TmFtZTogc2Vjb25kYXJ5QnVja2V0TmFtZSxcbiAgICByZXBsaWNhdGlvblJ1bGVJZDogJ3RvLXNlY29uZGFyeScsIHNvdXJjZVJlZ2lvbkxhYmVsOiAnaWFkJywgZGVzdFJlZ2lvbkxhYmVsOiAncGR4JyxcbiAgICByZXZlcnNlUnVsZUlkOiAndG8tcHJpbWFyeScsIHJldmVyc2VTb3VyY2VCdWNrZXROYW1lOiBzZWNvbmRhcnlCdWNrZXROYW1lLCByZXZlcnNlRGVzdEJ1Y2tldE5hbWU6IHByaW1hcnlCdWNrZXROYW1lLFxuICAgIHByaW1hcnlSZWdpb24sIHNlY29uZGFyeVJlZ2lvbiwgYWNjb3VudElkLCBtcmFwQWxpYXMsXG4gICAgZW5jcnlwdGlvbktleUFybjogZW5jcnlwdGlvbktleUFyblNlY29uZGFyeSxcbiAgICBlbnY6IHsgYWNjb3VudDogYWNjb3VudElkLCByZWdpb246IHNlY29uZGFyeVJlZ2lvbiB9LFxuICB9KSk7XG59XG4iXX0=