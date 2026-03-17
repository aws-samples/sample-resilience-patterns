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
if (targetStack === 'bucket-primary' || targetStack === 'all') {
    addSuppressions(new regional_bucket_stack_1.RegionalBucketStack(app, `${project}-bucket-primary`, {
        project,
        env: { account: accountId, region: primaryRegion },
    }));
}
if (targetStack === 'bucket-secondary' || targetStack === 'all') {
    addSuppressions(new regional_bucket_stack_1.RegionalBucketStack(app, `${project}-bucket-secondary`, {
        project,
        env: { account: accountId, region: secondaryRegion },
    }));
}
if (targetStack === 'global-routing' || targetStack === 'all') {
    addSuppressions(new global_routing_stack_1.GlobalRoutingStack(app, `${project}-global-routing`, {
        project, primaryBucketName, secondaryBucketName,
        primaryRegion, secondaryRegion, accountId,
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
        env: { account: accountId, region: secondaryRegion },
    }));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBwLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUNBLGlEQUFtQztBQUNuQyxxQ0FBOEQ7QUFDOUQsNERBQXdEO0FBQ3hELHdFQUFtRTtBQUNuRSxzRUFBaUU7QUFDakUsc0VBQWlFO0FBQ2pFLDBEQUFzRDtBQUN0RCw4REFBMEQ7QUFFMUQsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7QUFFMUIsbUNBQW1DO0FBQ25DLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsS0FBSyxDQUFDLEtBQUssTUFBTSxFQUFFLENBQUM7SUFDN0MsR0FBRyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksNEJBQWtCLENBQUMsRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ3JFLENBQUM7QUFFRCxnRkFBZ0Y7QUFDaEYsTUFBTSxrQkFBa0IsR0FBRztJQUN6QixFQUFFLEVBQUUsRUFBRSxtQkFBbUIsRUFBRSxNQUFNLEVBQUUsOERBQThELEVBQUU7SUFDbkcsRUFBRSxFQUFFLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxFQUFFLG1JQUFtSSxFQUFFO0lBQ3hLLEVBQUUsRUFBRSxFQUFFLGlCQUFpQixFQUFFLE1BQU0sRUFBRSwrRkFBK0YsRUFBRTtDQUNuSSxDQUFDO0FBRUYsTUFBTSxPQUFPLEdBQUcsR0FBRyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDLElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxPQUFPLElBQUksUUFBUSxDQUFDO0FBQ3JGLE1BQU0sYUFBYSxHQUFHLEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLGVBQWUsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsY0FBYyxJ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QUcsT0FBTyx1QkFBdUIsRUFBRTtRQUMxRSxPQUFPO1FBQ1AsZ0JBQWdCLEVBQUUsaUJBQWlCLEVBQUUsY0FBYyxFQUFFLG1CQUFtQjtRQUN4RSxpQkFBaUIsRUFBRSxjQUFjLEVBQUUsaUJBQWlCLEVBQUUsS0FBSyxFQUFFLGVBQWUsRUFBRSxLQUFLO1FBQ25GLGFBQWEsRUFBRSxZQUFZLEVBQUUsdUJBQXVCLEVBQUUsbUJBQW1CLEVBQUUscUJBQXFCLEVBQUUsaUJBQWlCO1FBQ25ILGFBQWEsRUFBRSxlQUFlLEVBQUUsU0FBUyxFQUFFLFNBQVM7UUFDcEQsR0FBRyxFQUFFLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLEVBQUUsZUFBZSxFQUFFO0tBQ3JELENBQUMsQ0FBQyxDQUFDO0FBQ04sQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIiMhL3Vzci9iaW4vZW52IG5vZGVcbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBBd3NTb2x1dGlvbnNDaGVja3MsIE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gJ2Nkay1uYWcnO1xuaW1wb3J0IHsgQm9vdHN0cmFwU3RhY2sgfSBmcm9tICcuLi9saWIvYm9vdHN0cmFwLXN0YWNrJztcbmltcG9ydCB7IFJlZ2lvbmFsQnVja2V0U3RhY2sgfSBmcm9tICcuLi9saWIvcmVnaW9uYWwtYnVja2V0LXN0YWNrJztcbmltcG9ydCB7IEdsb2JhbFJvdXRpbmdTdGFjayB9IGZyb20gJy4uL2xpYi9nbG9iYWwtcm91dGluZy1zdGFjayc7XG5pbXBvcnQgeyBSb3V0aW5nTGFtYmRhU3RhY2sgfSBmcm9tICcuLi9saWIvcm91dGluZy1sYW1iZGEtc3RhY2snO1xuaW1wb3J0IHsgRmFpbG92ZXJTdGFjayB9IGZyb20gJy4uL2xpYi9mYWlsb3Zlci1zdGFjayc7XG5pbXBvcnQgeyBNb25pdG9yaW5nU3RhY2sgfSBmcm9tICcuLi9saWIvbW9uaXRvcmluZy1zdGFjayc7XG5cbmNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG5cbi8vIEVuYWJsZSBjZGstbmFnIHdpdGg6IC1jIG5hZz10cnVlXG5pZiAoYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgnbmFnJykgPT09ICd0cnVlJykge1xuICBjZGsuQXNwZWN0cy5vZihhcHApLmFkZChuZXcgQXdzU29sdXRpb25zQ2hlY2tzKHsgdmVyYm9zZTogdHJ1ZSB9KSk7XG59XG5cbi8vIEdsb2JhbCBuYWcgc3VwcHJlc3Npb25zIGZvciBDREsgZnJhbWV3b3JrIGludGVybmFscyBhbmQgaW50ZW50aW9uYWwgZGVjaXNpb25zXG5jb25zdCBnbG9iYWxTdXBwcmVzc2lvbnMgPSBbXG4gIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNCcsIHJlYXNvbjogJ0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZSBpcyBzdGFuZGFyZCBmb3IgTGFtYmRhIGZ1bmN0aW9ucycgfSxcbiAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JywgcmVhc29uOiAnV2lsZGNhcmQgcGVybWlzc2lvbnMgcmVxdWlyZWQ6IFMzIHJlcGxpY2F0aW9uIG5lZWRzIGJ1Y2tldC8qLCBNUkFQIGFsaWFzIHVua25vd24gYXQgc3ludGgsIENESyBmcmFtZXdvcmsgY29uc3RydWN0cyB1c2Ugd2lsZGNhcmRzJyB9LFxuICB7IGlkOiAnQXdzU29sdXRpb25zLUwxJywgcmVhc29uOiAnUHl0aG9uIDMuMTIgaXMgY3VycmVudCBMVFMuIENESyBQcm92aWRlciBmcmFtZXdvcmsgTGFtYmRhIHJ1bnRpbWVzIGFyZSBub3QgdXNlci1jb25maWd1cmFibGUuJyB9LFxuXTtcblxuY29uc3QgcHJvamVjdCA9IGFwcC5ub2RlLnRyeUdldENvbnRleHQoJ3Byb2plY3QnKSB8fCBwcm9jZXNzLmVudi5QUk9KRUNUIHx8ICdzM21yYXAnO1xuY29uc3QgcHJpbWFyeVJlZ2lvbiA9IGFwcC5ub2RlLnRyeUdldENvbnRleHQoJ3ByaW1hcnlSZWdpb24nKSB8fCBwcm9jZXNzLmVudi5QUklNQVJZX1JFR0lPTiB8fCAndXMtZWFzdC0xJztcbmNvbnN0IHNlY29uZGFyeVJlZ2lvbiA9IGFwcC5ub2RlLnRyeUdldENvbnRleHQoJ3NlY29uZGFyeVJlZ2lvbicpIHx8IHByb2Nlc3MuZW52LlNFQ09OREFSWV9SRUdJT04gfHwgJ3VzLXdlc3QtMic7XG5jb25zdCBhY2NvdW50SWQgPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdhY2NvdW50SWQnKSB8fCBwcm9jZXNzLmVudi5BQ0NPVU5UX0lEIHx8IHByb2Nlc3MuZW52LkNES19ERUZBVUxUX0FDQ09VTlQgfHwgJzAwMDAwMDAwMDAwMCc7XG5cbmNvbnN0IHRhcmdldFN0YWNrID0gYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgnc3RhY2snKSB8fCBwcm9jZXNzLmVudi5TVEFDSyB8fCAnYWxsJztcblxuY29uc3QgcHJpbWFyeUJ1Y2tldE5hbWUgPSBgJHtwcm9qZWN0fS0ke3ByaW1hcnlSZWdpb259LSR7YWNjb3VudElkfWA7XG5jb25zdCBzZWNvbmRhcnlCdWNrZXROYW1lID0gYCR7cHJvamVjdH0tJHtzZWNvbmRhcnlSZWdpb259LSR7YWNjb3VudElkfWA7XG5jb25zdCBtcmFwTmFtZSA9IGAke3Byb2plY3R9LW1yYXBgO1xuY29uc3QgbXJhcEFsaWFzID0gYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgnbXJhcEFsaWFzJykgfHwgJyc7XG5jb25zdCByb3V0aW5nRm5OYW1lID0gYCR7cHJvamVjdH0tbXJhcC1yb3V0aW5nYDtcbmNvbnN0IHByaW1hcnlSb3V0aW5nTGFtYmRhQXJuID0gYGFybjphd3M6bGFtYmRhOiR7cHJpbWFyeVJlZ2lvbn06JHthY2NvdW50SWR9OmZ1bmN0aW9uOiR7cm91dGluZ0ZuTmFtZX1gO1xuY29uc3Qgc2Vjb25kYXJ5Um91dGluZ0xhbWJkYUFybiA9IGBhcm46YXdzOmxhbWJkYToke3NlY29uZGFyeVJlZ2lvbn06JHthY2NvdW50SWR9OmZ1bmN0aW9uOiR7cm91dGluZ0ZuTmFtZX1gO1xuXG5jb25zdCByb3V0aW5nTGFtYmRhUHJvcHMgPSB7XG4gIHByb2plY3QsXG4gIHByaW1hcnlCdWNrZXROYW1lLFxuICBzZWNvbmRhcnlCdWNrZXROYW1lLFxuICBwcmltYXJ5UmVnaW9uLFxuICBzZWNvbmRhcnlSZWdpb24sXG4gIGFjY291bnRJZCxcbiAgbXJhcE5hbWUsXG4gIG1yYXBBbGlhcyxcbn07XG5cbmZ1bmN0aW9uIGFkZFN1cHByZXNzaW9ucyhzdGFjazogY2RrLlN0YWNrLCBleHRyYTogeyBpZDogc3RyaW5nOyByZWFzb246IHN0cmluZyB9W10gPSBbXSkge1xuICBOYWdTdXBwcmVzc2lvbnMuYWRkU3RhY2tTdXBwcmVzc2lvbnMoc3RhY2ssIFsuLi5nbG9iYWxTdXBwcmVzc2lvbnMsIC4uLmV4dHJhXSwgdHJ1ZSk7XG59XG5cbmlmICh0YXJnZXRTdGFjayA9PT0gJ2Jvb3RzdHJhcCcgfHwgdGFyZ2V0U3RhY2sgPT09ICdhbGwnKSB7XG4gIGNvbnN0IHMgPSBuZXcgQm9vdHN0cmFwU3RhY2soYXBwLCBgJHtwcm9qZWN0fS1ib290c3RyYXBgLCB7XG4gICAgcHJvamVjdCwgcHJpbWFyeVJlZ2lvbiwgc2Vjb25kYXJ5UmVnaW9uLFxuICAgIGVudjogeyBhY2NvdW50OiBhY2NvdW50SWQsIHJlZ2lvbjogcHJpbWFyeVJlZ2lvbiB9LFxuICB9KTtcbiAgYWRkU3VwcHJlc3Npb25zKHMsIFtcbiAgICB7IGlkOiAnQXdzU29sdXRpb25zLVMxJywgcmVhc29uOiAnQXJ0aWZhY3QgYnVja2V0IGlzIHRlbXBvcmFyeSBidWlsZCBzdG9yYWdlLCBhY2Nlc3MgbG9ncyBub3QgbmVlZGVkJyB9LFxuICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtQ0I0JywgcmVhc29uOiAnRGVtbyBwcm9qZWN0IOKAlCBLTVMgZW5jcnlwdGlvbiBmb3IgQ29kZUJ1aWxkIG5vdCByZXF1aXJlZCcgfSxcbiAgICB7IGlkOiAnQXdzU29sdXRpb25zLVNGMScsIHJlYXNvbjogJ0NESyBQcm92aWRlciB3YWl0ZXIgc3RhdGUgbWFjaGluZSDigJQgbm90IHVzZXItY29uZmlndXJhYmxlJyB9LFxuICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtU0YyJywgcmVhc29uOiAnQ0RLIFByb3ZpZGVyIHdhaXRlciBzdGF0ZSBtYWNoaW5lIOKAlCBub3QgdXNlci1jb25maWd1cmFibGUnIH0sXG4gIF0pO1xufVxuXG5pZiAodGFyZ2V0U3RhY2sgPT09ICdidWNrZXQtcHJpbWFyeScgfHwgdGFyZ2V0U3RhY2sgPT09ICdhbGwnKSB7XG4gIGFkZFN1cHByZXNzaW9ucyhuZXcgUmVnaW9uYWxCdWNrZXRTdGFjayhhcHAsIGAke3Byb2plY3R9LWJ1Y2tldC1wcmltYXJ5YCwge1xuICAgIHByb2plY3QsXG4gICAgZW52OiB7IGFjY291bnQ6IGFjY291bnRJZCwgcmVnaW9uOiBwcmltYXJ5UmVnaW9uIH0sXG4gIH0pKTtcbn1cblxuaWYgKHRhcmdldFN0YWNrID09PSAnYnVja2V0LXNlY29uZGFyeScgfHwgdGFyZ2V0U3RhY2sgPT09ICdhbGwnKSB7XG4gIGFkZFN1cHByZXNzaW9ucyhuZXcgUmVnaW9uYWxCdWNrZXRTdGFjayhhcHAsIGAke3Byb2plY3R9LWJ1Y2tldC1zZWNvbmRhcnlgLCB7XG4gICAgcHJvamVjdCxcbiAgICBlbnY6IHsgYWNjb3VudDogYWNjb3VudElkLCByZWdpb246IHNlY29uZGFyeVJlZ2lvbiB9LFxuICB9KSk7XG59XG5cbmlmICh0YXJnZXRTdGFjayA9PT0gJ2dsb2JhbC1yb3V0aW5nJyB8fCB0YXJnZXRTdGFjayA9PT0gJ2FsbCcpIHtcbiAgYWRkU3VwcHJlc3Npb25zKG5ldyBHbG9iYWxSb3V0aW5nU3RhY2soYXBwLCBgJHtwcm9qZWN0fS1nbG9iYWwtcm91dGluZ2AsIHtcbiAgICBwcm9qZWN0LCBwcmltYXJ5QnVja2V0TmFtZSwgc2Vjb25kYXJ5QnVja2V0TmFtZSxcbiAgICBwcmltYXJ5UmVnaW9uLCBzZWNvbmRhcnlSZWdpb24sIGFjY291bnRJZCxcbiAgICBlbnY6IHsgYWNjb3VudDogYWNjb3VudElkLCByZWdpb246IHByaW1hcnlSZWdpb24gfSxcbiAgfSkpO1xufVxuXG5pZiAodGFyZ2V0U3RhY2sgPT09ICdyb3V0aW5nLXByaW1hcnknIHx8IHRhcmdldFN0YWNrID09PSAnYWxsJykge1xuICBhZGRTdXBwcmVzc2lvbnMobmV3IFJvdXRpbmdMYW1iZGFTdGFjayhhcHAsIGAke3Byb2plY3R9LXJvdXRpbmctcHJpbWFyeWAsIHtcbiAgICAuLi5yb3V0aW5nTGFtYmRhUHJvcHMsXG4gICAgZW52OiB7IGFjY291bnQ6IGFjY291bnRJZCwgcmVnaW9uOiBwcmltYXJ5UmVnaW9uIH0sXG4gIH0pKTtcbn1cblxuaWYgKHRhcmdldFN0YWNrID09PSAncm91dGluZy1zZWNvbmRhcnknIHx8IHRhcmdldFN0YWNrID09PSAnYWxsJykge1xuICBhZGRTdXBwcmVzc2lvbnMobmV3IFJvdXRpbmdMYW1iZGFTdGFjayhhcHAsIGAke3Byb2plY3R9LXJvdXRpbmctc2Vjb25kYXJ5YCwge1xuICAgIC4uLnJvdXRpbmdMYW1iZGFQcm9wcyxcbiAgICBlbnY6IHsgYWNjb3VudDogYWNjb3VudElkLCByZWdpb246IHNlY29uZGFyeVJlZ2lvbiB9LFxuICB9KSk7XG59XG5cbmlmICh0YXJnZXRTdGFjayA9PT0gJ2ZhaWxvdmVyJyB8fCB0YXJnZXRTdGFjayA9PT0gJ2FsbCcpIHtcbiAgYWRkU3VwcHJlc3Npb25zKG5ldyBGYWlsb3ZlclN0YWNrKGFwcCwgYCR7cHJvamVjdH0tZmFpbG92ZXJgLCB7XG4gICAgcHJvamVjdCwgcHJpbWFyeUJ1Y2tldE5hbWUsIHNlY29uZGFyeUJ1Y2tldE5hbWUsXG4gICAgcHJpbWFyeVJlZ2lvbiwgc2Vjb25kYXJ5UmVnaW9uLCBhY2NvdW50SWQsIG1yYXBOYW1lLFxuICAgIHByaW1hcnlSb3V0aW5nTGFtYmRhQXJuLCBzZWNvbmRhcnlSb3V0aW5nTGFtYmRhQXJuLFxuICAgIGVudjogeyBhY2NvdW50OiBhY2NvdW50SWQsIHJlZ2lvbjogcHJpbWFyeVJlZ2lvbiB9LFxuICB9KSk7XG59XG5cbmlmICh0YXJnZXRTdGFjayA9PT0gJ21vbml0b3JpbmctcHJpbWFyeScgfHwgdGFyZ2V0U3RhY2sgPT09ICdhbGwnKSB7XG4gIGFkZFN1cHByZXNzaW9ucyhuZXcgTW9uaXRvcmluZ1N0YWNrKGFwcCwgYCR7cHJvamVjdH0tbW9uaXRvcmluZy1wcmltYXJ5YCwge1xuICAgIHByb2plY3QsXG4gICAgc291cmNlQnVja2V0TmFtZTogc2Vjb25kYXJ5QnVja2V0TmFtZSwgZGVzdEJ1Y2tldE5hbWU6IHByaW1hcnlCdWNrZXROYW1lLFxuICAgIHJlcGxpY2F0aW9uUnVsZUlkOiAndG8tcHJpbWFyeScsIHNvdXJjZVJlZ2lvbkxhYmVsOiAncGR4JywgZGVzdFJlZ2lvbkxhYmVsOiAnaWFkJyxcbiAgICByZXZlcnNlUnVsZUlkOiAndG8tc2Vjb25kYXJ5JywgcmV2ZXJzZVNvdXJjZUJ1Y2tldE5hbWU6IHByaW1hcnlCdWNrZXROYW1lLCByZXZlcnNlRGVzdEJ1Y2tldE5hbWU6IHNlY29uZGFyeUJ1Y2tldE5hbWUsXG4gICAgcHJpbWFyeVJlZ2lvbiwgc2Vjb25kYXJ5UmVnaW9uLCBhY2NvdW50SWQsIG1yYXBBbGlhcyxcbiAgICBlbnY6IHsgYWNjb3VudDogYWNjb3VudElkLCByZWdpb246IHByaW1hcnlSZWdpb24gfSxcbiAgfSkpO1xufVxuXG5pZiAodGFyZ2V0U3RhY2sgPT09ICdtb25pdG9yaW5nLXNlY29uZGFyeScgfHwgdGFyZ2V0U3RhY2sgPT09ICdhbGwnKSB7XG4gIGFkZFN1cHByZXNzaW9ucyhuZXcgTW9uaXRvcmluZ1N0YWNrKGFwcCwgYCR7cHJvamVjdH0tbW9uaXRvcmluZy1zZWNvbmRhcnlgLCB7XG4gICAgcHJvamVjdCxcbiAgICBzb3VyY2VCdWNrZXROYW1lOiBwcmltYXJ5QnVja2V0TmFtZSwgZGVzdEJ1Y2tldE5hbWU6IHNlY29uZGFyeUJ1Y2tldE5hbWUsXG4gICAgcmVwbGljYXRpb25SdWxlSWQ6ICd0by1zZWNvbmRhcnknLCBzb3VyY2VSZWdpb25MYWJlbDogJ2lhZCcsIGRlc3RSZWdpb25MYWJlbDogJ3BkeCcsXG4gICAgcmV2ZXJzZVJ1bGVJZDogJ3RvLXByaW1hcnknLCByZXZlcnNlU291cmNlQnVja2V0TmFtZTogc2Vjb25kYXJ5QnVja2V0TmFtZSwgcmV2ZXJzZURlc3RCdWNrZXROYW1lOiBwcmltYXJ5QnVja2V0TmFtZSxcbiAgICBwcmltYXJ5UmVnaW9uLCBzZWNvbmRhcnlSZWdpb24sIGFjY291bnRJZCwgbXJhcEFsaWFzLFxuICAgIGVudjogeyBhY2NvdW50OiBhY2NvdW50SWQsIHJlZ2lvbjogc2Vjb25kYXJ5UmVnaW9uIH0sXG4gIH0pKTtcbn1cbiJdfQ==