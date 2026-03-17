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
const assertions_1 = require("aws-cdk-lib/assertions");
const regional_bucket_stack_1 = require("../lib/regional-bucket-stack");
const global_routing_stack_1 = require("../lib/global-routing-stack");
const routing_lambda_stack_1 = require("../lib/routing-lambda-stack");
const failover_stack_1 = require("../lib/failover-stack");
const monitoring_stack_1 = require("../lib/monitoring-stack");
/**
 * Integration tests that verify cross-stack consistency.
 * These catch bugs where one stack computes a resource name differently than another.
 */
const project = 's3mrap';
const accountId = '123456789012';
const primaryRegion = 'us-east-1';
const secondaryRegion = 'us-west-2';
// These must match what app.ts computes
const primaryBucketName = `${project}-${primaryRegion}-${accountId}`;
const secondaryBucketName = `${project}-${secondaryRegion}-${accountId}`;
const mrapName = `${project}-mrap`;
const routingFnName = `${project}-mrap-routing`;
const app = new cdk.App();
const testKeyArn = `arn:aws:kms:${primaryRegion}:${accountId}:key/test-key-id`;
const bucketPrimary = new regional_bucket_stack_1.RegionalBucketStack(app, 'IntBucketPrimary', {
    project, encryptionKeyArn: testKeyArn, env: { account: accountId, region: primaryRegion },
});
const bucketSecondary = new regional_bucket_stack_1.RegionalBucketStack(app, 'IntBucketSecondary', {
    project, encryptionKeyArn: testKeyArn, env: { account: accountId, region: secondaryRegion },
});
const globalRouting = new global_routing_stack_1.GlobalRoutingStack(app, 'IntGlobalRouting', {
    project, primaryBucketName, secondaryBucketName,
    primaryRegion, secondaryRegion, accountId, encryptionKeyId: 'test-key-id',
    env: { account: accountId, region: primaryRegion },
});
const routingPrimary = new routing_lambda_stack_1.RoutingLambdaStack(app, 'IntRoutingPrimary', {
    project, primaryBucketName, secondaryBucketName,
    primaryRegion, secondaryRegion, accountId, mrapName, mrapAlias: 'test-alias.mrap',
    env: { account: accountId, region: primaryRegion },
});
const failover = new failover_stack_1.FailoverStack(app, 'IntFailover', {
    project, primaryBucketName, secondaryBucketName,
    primaryRegion, secondaryRegion, accountId, mrapName,
    primaryRoutingLambdaArn: `arn:aws:lambda:${primaryRegion}:${accountId}:function:${routingFnName}`,
    secondaryRoutingLambdaArn: `arn:aws:lambda:${secondaryRegion}:${accountId}:function:${routingFnName}`,
    env: { account: accountId, region: primaryRegion },
});
const tBucketPrimary = assertions_1.Template.fromStack(bucketPrimary);
const tBucketSecondary = assertions_1.Template.fromStack(bucketSecondary);
const tGlobalRouting = assertions_1.Template.fromStack(globalRouting);
const tRoutingPrimary = assertions_1.Template.fromStack(routingPrimary);
const tFailover = assertions_1.Template.fromStack(failover);
// --- Bucket name consistency ---
test('Primary bucket name matches what global-routing expects', () => {
    tBucketPrimary.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: primaryBucketName,
    });
});
test('Secondary bucket name matches what global-routing expects', () => {
    tBucketSecondary.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: secondaryBucketName,
    });
});
test('MRAP references the same bucket names as the bucket stacks', () => {
    tGlobalRouting.hasResourceProperties('AWS::S3::MultiRegionAccessPoint', {
        Regions: [
            { Bucket: primaryBucketName },
            { Bucket: secondaryBucketName },
        ],
    });
});
// --- Lambda name consistency ---
test('Routing Lambda name matches what failover stack references', () => {
    tRoutingPrimary.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: routingFnName,
    });
});
test('Failover ARC plan references routing Lambda ARNs with correct function name', () => {
    const primaryArn = `arn:aws:lambda:${primaryRegion}:${accountId}:function:${routingFnName}`;
    const secondaryArn = `arn:aws:lambda:${secondaryRegion}:${accountId}:function:${routingFnName}`;
    const resources = tFailover.findResources('AWS::ARCRegionSwitch::Plan');
    const plan = Object.values(resources)[0];
    const lambdas = plan.Properties.Workflows[0].Steps[0]
        .ExecutionBlockConfiguration.CustomActionLambdaConfig.Lambdas;
    expect(lambdas).toEqual([
        { Arn: primaryArn },
        { Arn: secondaryArn },
    ]);
});
// --- Load test Lambda has access to correct buckets ---
test('Load test Lambda env vars reference correct bucket names', () => {
    tFailover.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: `${project}-load-test`,
        Environment: {
            Variables: {
                PRIMARY_BUCKET: primaryBucketName,
                SECONDARY_BUCKET: secondaryBucketName,
            },
        },
    });
});
// --- MRAP monitor uses correct namespace ---
test('MRAP monitor metric namespace matches monitoring dashboard namespace', () => {
    const app2 = new cdk.App();
    const tMonitoring = assertions_1.Template.fromStack(new monitoring_stack_1.MonitoringStack(app2, 'IntMonitoringCheck', {
        project, sourceBucketName: secondaryBucketName, destBucketName: primaryBucketName,
        replicationRuleId: 'to-primary', sourceRegionLabel: 'pdx', destRegionLabel: 'iad',
        reverseRuleId: 'to-secondary', reverseSourceBucketName: primaryBucketName, reverseDestBucketName: secondaryBucketName,
        primaryRegion, secondaryRegion, accountId, mrapAlias: 'test.mrap',
        encryptionKeyArn: testKeyArn,
        env: { account: accountId, region: primaryRegion },
    }));
    tMonitoring.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
            Variables: {
                METRIC_NAMESPACE: project,
            },
        },
    });
});
// --- MRAP identifier format: all Lambdas must use ARN (with alias), never the name ---
test('Routing Lambda uses MRAP ARN (not name) in env vars', () => {
    const tRouting = assertions_1.Template.fromStack(routingPrimary);
    const fns = tRouting.findResources('AWS::Lambda::Function');
    for (const [, fn] of Object.entries(fns)) {
        const vars = fn.Properties?.Environment?.Variables || {};
        // Must not have MRAP_NAME — that causes InvalidRequest errors
        expect(vars).not.toHaveProperty('MRAP_NAME');
        // If it has MRAP_ARN, it must be an ARN format
        if (vars.MRAP_ARN) {
            expect(vars.MRAP_ARN).toMatch(/^arn:aws:s3::/);
        }
    }
});
test('Monitor Lambda uses MRAP alias (not name) in env vars', () => {
    const app3 = new cdk.App();
    const tMon = assertions_1.Template.fromStack(new monitoring_stack_1.MonitoringStack(app3, 'IntMonitorArnCheck', {
        project, sourceBucketName: secondaryBucketName, destBucketName: primaryBucketName,
        replicationRuleId: 'to-primary', sourceRegionLabel: 'pdx', destRegionLabel: 'iad',
        reverseRuleId: 'to-secondary', reverseSourceBucketName: primaryBucketName, reverseDestBucketName: secondaryBucketName,
        primaryRegion, secondaryRegion, accountId, mrapAlias: 'test.mrap',
        encryptionKeyArn: testKeyArn,
        env: { account: accountId, region: primaryRegion },
    }));
    const fns = tMon.findResources('AWS::Lambda::Function');
    for (const [, fn] of Object.entries(fns)) {
        const vars = fn.Properties?.Environment?.Variables || {};
        expect(vars).not.toHaveProperty('MRAP_NAME');
        if (vars.MRAP_ALIAS) {
            expect(vars.MRAP_ALIAS).not.toBe(mrapName);
        }
    }
});
test('Routing Lambda IAM policy resource matches the MRAP alias ARN (not name)', () => {
    const tRouting = assertions_1.Template.fromStack(routingPrimary);
    const policies = tRouting.findResources('AWS::IAM::Policy');
    for (const [, policy] of Object.entries(policies)) {
        const statements = policy.Properties?.PolicyDocument?.Statement || [];
        for (const stmt of statements) {
            const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
            for (const r of resources) {
                if (typeof r === 'string' && r.includes(':accesspoint/')) {
                    // Must not contain the MRAP name — must use alias or wildcard
                    expect(r).not.toContain(`:accesspoint/${mrapName}`);
                }
            }
        }
    }
});
test('No Lambda in any stack uses MRAP_NAME env var', () => {
    const allTemplates = [
        assertions_1.Template.fromStack(bucketPrimary),
        assertions_1.Template.fromStack(globalRouting),
        assertions_1.Template.fromStack(routingPrimary),
        assertions_1.Template.fromStack(failover),
    ];
    for (const t of allTemplates) {
        const fns = t.findResources('AWS::Lambda::Function');
        for (const [name, fn] of Object.entries(fns)) {
            const vars = fn.Properties?.Environment?.Variables || {};
            expect(vars).not.toHaveProperty('MRAP_NAME');
        }
    }
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW50ZWdyYXRpb24udGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImludGVncmF0aW9uLnRlc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMsdURBQWtEO0FBQ2xELHdFQUFtRTtBQUNuRSxzRUFBaUU7QUFDakUsc0VBQWlFO0FBQ2pFLDBEQUFzRDtBQUN0RCw4REFBMEQ7QUFFMUQ7OztHQUdHO0FBRUgsTUFBTSxPQUFPLEdBQUcsUUFBUSxDQUFDO0FBQ3pCLE1BQU0sU0FBUyxHQUFHLGNBQWMsQ0FBQztBQUNqQyxNQUFNLGFBQWEsR0FBRyxXQUFXLENBQUM7QUFDbEMsTUFBTSxlQUFlLEdBQUcsV0FBVyxDQUFDO0FBRXBDLHdDQUF3QztBQUN4QyxNQUFNLGlCQUFpQixHQUFHLEdBQUcsT0FBTyxJQUFJLGFBQWEsSUFBSSxTQUFTLEVBQUUsQ0FBQztBQUNyRSxNQUFNLG1CQUFtQixHQUFHLEdBQUcsT0FBTyxJQUFJLGVBQWUsSUFBSSxTQUFTLEVBQUUsQ0FBQztBQUN6RSxNQUFNLFFBQVEsR0FBRyxHQUFHLE9BQU8sT0FBTyxDQUFDO0FBQ25DLE1BQU0sYUFBYSxHQUFHLEdBQUcsT0FBTyxlQUFlLENBQUM7QUFFaEQsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7QUFFMUIsTUFBTSxVQUFVLEdBQUcsZUFBZSxhQUFhLElBQUksU0FBUyxrQkFBa0IsQ0FBQztBQUUvRSxNQUFNLGFBQWEsR0FBRyxJQUFJLDJDQUFtQixDQUFDLEdBQUcsRUFBRSxrQkFBa0IsRUFBRTtJQUNyRSxPQUFPLEVBQUUsZ0JBQWdCLEVBQUUsVUFBVSxFQUFFLEdBQUcsRUFBRSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSxFQUFFLGFBQWEsRUFBRTtDQUMxRixDQUFDLENBQUM7QUFFSCxNQUFNLGVBQWUsR0FBRyxJQUFJLDJDQUFt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b0JBQ3pELDhEQUE4RDtvQkFDOUQsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsZ0JBQWdCLFFBQVEsRUFBRSxDQUFDLENBQUM7Z0JBQ3RELENBQUM7WUFDSCxDQUFDO1FBQ0gsQ0FBQztJQUNILENBQUM7QUFDSCxDQUFDLENBQUMsQ0FBQztBQUVILElBQUksQ0FBQywrQ0FBK0MsRUFBRSxHQUFHLEVBQUU7SUFDekQsTUFBTSxZQUFZLEdBQUc7UUFDbkIscUJBQVEsQ0FBQyxTQUFTLENBQUMsYUFBYSxDQUFDO1FBQ2pDLHFCQUFRLENBQUMsU0FBUyxDQUFDLGFBQWEsQ0FBQztRQUNqQyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUM7UUFDbEMscUJBQVEsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDO0tBQzdCLENBQUM7SUFDRixLQUFLLE1BQU0sQ0FBQyxJQUFJLFlBQVksRUFBRSxDQUFDO1FBQzdCLE1BQU0sR0FBRyxHQUFHLENBQUMsQ0FBQyxhQUFhLENBQUMsdUJBQXVCLENBQUMsQ0FBQztRQUNyRCxLQUFLLE1BQU0sQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQzdDLE1BQU0sSUFBSSxHQUFJLEVBQVUsQ0FBQyxVQUFVLEVBQUUsV0FBVyxFQUFFLFNBQVMsSUFBSSxFQUFFLENBQUM7WUFDbEUsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxjQUFjLENBQUMsV0FBVyxDQUFDLENBQUM7UUFDL0MsQ0FBQztJQUNILENBQUM7QUFDSCxDQUFDLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBUZW1wbGF0ZSB9IGZyb20gJ2F3cy1jZGstbGliL2Fzc2VydGlvbnMnO1xuaW1wb3J0IHsgUmVnaW9uYWxCdWNrZXRTdGFjayB9IGZyb20gJy4uL2xpYi9yZWdpb25hbC1idWNrZXQtc3RhY2snO1xuaW1wb3J0IHsgR2xvYmFsUm91dGluZ1N0YWNrIH0gZnJvbSAnLi4vbGliL2dsb2JhbC1yb3V0aW5nLXN0YWNrJztcbmltcG9ydCB7IFJvdXRpbmdMYW1iZGFTdGFjayB9IGZyb20gJy4uL2xpYi9yb3V0aW5nLWxhbWJkYS1zdGFjayc7XG5pbXBvcnQgeyBGYWlsb3ZlclN0YWNrIH0gZnJvbSAnLi4vbGliL2ZhaWxvdmVyLXN0YWNrJztcbmltcG9ydCB7IE1vbml0b3JpbmdTdGFjayB9IGZyb20gJy4uL2xpYi9tb25pdG9yaW5nLXN0YWNrJztcblxuLyoqXG4gKiBJbnRlZ3JhdGlvbiB0ZXN0cyB0aGF0IHZlcmlmeSBjcm9zcy1zdGFjayBjb25zaXN0ZW5jeS5cbiAqIFRoZXNlIGNhdGNoIGJ1Z3Mgd2hlcmUgb25lIHN0YWNrIGNvbXB1dGVzIGEgcmVzb3VyY2UgbmFtZSBkaWZmZXJlbnRseSB0aGFuIGFub3RoZXIuXG4gKi9cblxuY29uc3QgcHJvamVjdCA9ICdzM21yYXAnO1xuY29uc3QgYWNjb3VudElkID0gJzEyMzQ1Njc4OTAxMic7XG5jb25zdCBwcmltYXJ5UmVnaW9uID0gJ3VzLWVhc3QtMSc7XG5jb25zdCBzZWNvbmRhcnlSZWdpb24gPSAndXMtd2VzdC0yJztcblxuLy8gVGhlc2UgbXVzdCBtYXRjaCB3aGF0IGFwcC50cyBjb21wdXRlc1xuY29uc3QgcHJpbWFyeUJ1Y2tldE5hbWUgPSBgJHtwcm9qZWN0fS0ke3ByaW1hcnlSZWdpb259LSR7YWNjb3VudElkfWA7XG5jb25zdCBzZWNvbmRhcnlCdWNrZXROYW1lID0gYCR7cHJvamVjdH0tJHtzZWNvbmRhcnlSZWdpb259LSR7YWNjb3VudElkfWA7XG5jb25zdCBtcmFwTmFtZSA9IGAke3Byb2plY3R9LW1yYXBgO1xuY29uc3Qgcm91dGluZ0ZuTmFtZSA9IGAke3Byb2plY3R9LW1yYXAtcm91dGluZ2A7XG5cbmNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG5cbmNvbnN0IHRlc3RLZXlBcm4gPSBgYXJuOmF3czprbXM6JHtwcmltYXJ5UmVnaW9ufToke2FjY291bnRJZH06a2V5L3Rlc3Qta2V5LWlkYDtcblxuY29uc3QgYnVja2V0UHJpbWFyeSA9IG5ldyBSZWdpb25hbEJ1Y2tldFN0YWNrKGFwcCwgJ0ludEJ1Y2tldFByaW1hcnknLCB7XG4gIHByb2plY3QsIGVuY3J5cHRpb25LZXlBcm46IHRlc3RLZXlBcm4sIGVudjogeyBhY2NvdW50OiBhY2NvdW50SWQsIHJlZ2lvbjogcHJpbWFyeVJlZ2lvbiB9LFxufSk7XG5cbmNvbnN0IGJ1Y2tldFNlY29uZGFyeSA9IG5ldyBSZWdpb25hbEJ1Y2tldFN0YWNrKGFwcCwgJ0ludEJ1Y2tldFNlY29uZGFyeScsIHtcbiAgcHJvamVjdCwgZW5jcnlwdGlvbktleUFybjogdGVzdEtleUFybiwgZW52OiB7IGFjY291bnQ6IGFjY291bnRJZCwgcmVnaW9uOiBzZWNvbmRhcnlSZWdpb24gfSxcbn0pO1xuXG5jb25zdCBnbG9iYWxSb3V0aW5nID0gbmV3IEdsb2JhbFJvdXRpbmdTdGFjayhhcHAsICdJbnRHbG9iYWxSb3V0aW5nJywge1xuICBwcm9qZWN0LCBwcmltYXJ5QnVja2V0TmFtZSwgc2Vjb25kYXJ5QnVja2V0TmFtZSxcbiAgcHJpbWFyeVJlZ2lvbiwgc2Vjb25kYXJ5UmVnaW9uLCBhY2NvdW50SWQsIGVuY3J5cHRpb25LZXlJZDogJ3Rlc3Qta2V5LWlkJyxcbiAgZW52OiB7IGFjY291bnQ6IGFjY291bnRJZCwgcmVnaW9uOiBwcmltYXJ5UmVnaW9uIH0sXG59KTtcblxuY29uc3Qgcm91dGluZ1ByaW1hcnkgPSBuZXcgUm91dGluZ0xhbWJkYVN0YWNrKGFwcCwgJ0ludFJvdXRpbmdQcmltYXJ5Jywge1xuICBwcm9qZWN0LCBwcmltYXJ5QnVja2V0TmFtZSwgc2Vjb25kYXJ5QnVja2V0TmFtZSxcbiAgcHJpbWFyeVJlZ2lvbiwgc2Vjb25kYXJ5UmVnaW9uLCBhY2NvdW50SWQsIG1yYXBOYW1lLCBtcmFwQWxpYXM6ICd0ZXN0LWFsaWFzLm1yYXAnLFxuICBlbnY6IHsgYWNjb3VudDogYWNjb3VudElkLCByZWdpb246IHByaW1hcnlSZWdpb24gfSxcbn0pO1xuXG5jb25zdCBmYWlsb3ZlciA9IG5ldyBGYWlsb3ZlclN0YWNrKGFwcCwgJ0ludEZhaWxvdmVyJywge1xuICBwcm9qZWN0LCBwcmltYXJ5QnVja2V0TmFtZSwgc2Vjb25kYXJ5QnVja2V0TmFtZSxcbiAgcHJpbWFyeVJlZ2lvbiwgc2Vjb25kYXJ5UmVnaW9uLCBhY2NvdW50SWQsIG1yYXBOYW1lLFxuICBwcmltYXJ5Um91dGluZ0xhbWJkYUFybjogYGFybjphd3M6bGFtYmRhOiR7cHJpbWFyeVJlZ2lvbn06JHthY2NvdW50SWR9OmZ1bmN0aW9uOiR7cm91dGluZ0ZuTmFtZX1gLFxuICBzZWNvbmRhcnlSb3V0aW5nTGFtYmRhQXJuOiBgYXJuOmF3czpsYW1iZGE6JHtzZWNvbmRhcnlSZWdpb259OiR7YWNjb3VudElkfTpmdW5jdGlvbjoke3JvdXRpbmdGbk5hbWV9YCxcbiAgZW52OiB7IGFjY291bnQ6IGFjY291bnRJZCwgcmVnaW9uOiBwcmltYXJ5UmVnaW9uIH0sXG59KTtcblxuY29uc3QgdEJ1Y2tldFByaW1hcnkgPSBUZW1wbGF0ZS5mcm9tU3RhY2soYnVja2V0UHJpbWFyeSk7XG5jb25zdCB0QnVja2V0U2Vjb25kYXJ5ID0gVGVtcGxhdGUuZnJvbVN0YWNrKGJ1Y2tldFNlY29uZGFyeSk7XG5jb25zdCB0R2xvYmFsUm91dGluZyA9IFRlbXBsYXRlLmZyb21TdGFjayhnbG9iYWxSb3V0aW5nKTtcbmNvbnN0IHRSb3V0aW5nUHJpbWFyeSA9IFRlbXBsYXRlLmZyb21TdGFjayhyb3V0aW5nUHJpbWFyeSk7XG5jb25zdCB0RmFpbG92ZXIgPSBUZW1wbGF0ZS5mcm9tU3RhY2soZmFpbG92ZXIpO1xuXG4vLyAtLS0gQnVja2V0IG5hbWUgY29uc2lzdGVuY3kgLS0tXG5cbnRlc3QoJ1ByaW1hcnkgYnVja2V0IG5hbWUgbWF0Y2hlcyB3aGF0IGdsb2JhbC1yb3V0aW5nIGV4cGVjdHMnLCAoKSA9PiB7XG4gIHRCdWNrZXRQcmltYXJ5Lmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTMzo6QnVja2V0Jywge1xuICAgIEJ1Y2tldE5hbWU6IHByaW1hcnlCdWNrZXROYW1lLFxuICB9KTtcbn0pO1xuXG50ZXN0KCdTZWNvbmRhcnkgYnVja2V0IG5hbWUgbWF0Y2hlcyB3aGF0IGdsb2JhbC1yb3V0aW5nIGV4cGVjdHMnLCAoKSA9PiB7XG4gIHRCdWNrZXRTZWNvbmRhcnkuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlMzOjpCdWNrZXQnLCB7XG4gICAgQnVja2V0TmFtZTogc2Vjb25kYXJ5QnVja2V0TmFtZSxcbiAgfSk7XG59KTtcblxudGVzdCgnTVJBUCByZWZlcmVuY2VzIHRoZSBzYW1lIGJ1Y2tldCBuYW1lcyBhcyB0aGUgYnVja2V0IHN0YWNrcycsICgpID0+IHtcbiAgdEdsb2JhbFJvdXRpbmcuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlMzOjpNdWx0aVJlZ2lvbkFjY2Vzc1BvaW50Jywge1xuICAgIFJlZ2lvbnM6IFtcbiAgICAgIHsgQnVja2V0OiBwcmltYXJ5QnVja2V0TmFtZSB9LFxuICAgICAgeyBCdWNrZXQ6IHNlY29uZGFyeUJ1Y2tldE5hbWUgfSxcbiAgICBdLFxuICB9KTtcbn0pO1xuXG4vLyAtLS0gTGFtYmRhIG5hbWUgY29uc2lzdGVuY3kgLS0tXG5cbnRlc3QoJ1JvdXRpbmcgTGFtYmRhIG5hbWUgbWF0Y2hlcyB3aGF0IGZhaWxvdmVyIHN0YWNrIHJlZmVyZW5jZXMnLCAoKSA9PiB7XG4gIHRSb3V0aW5nUHJpbWFyeS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6TGFtYmRhOjpGdW5jdGlvbicsIHtcbiAgICBGdW5jdGlvbk5hbWU6IHJvdXRpbmdGbk5hbWUsXG4gIH0pO1xufSk7XG5cbnRlc3QoJ0ZhaWxvdmVyIEFSQyBwbGFuIHJlZmVyZW5jZXMgcm91dGluZyBMYW1iZGEgQVJOcyB3aXRoIGNvcnJlY3QgZnVuY3Rpb24gbmFtZScsICgpID0+IHtcbiAgY29uc3QgcHJpbWFyeUFybiA9IGBhcm46YXdzOmxhbWJkYToke3ByaW1hcnlSZWdpb259OiR7YWNjb3VudElkfTpmdW5jdGlvbjoke3JvdXRpbmdGbk5hbWV9YDtcbiAgY29uc3Qgc2Vjb25kYXJ5QXJuID0gYGFybjphd3M6bGFtYmRhOiR7c2Vjb25kYXJ5UmVnaW9ufToke2FjY291bnRJZH06ZnVuY3Rpb246JHtyb3V0aW5nRm5OYW1lfWA7XG5cbiAgY29uc3QgcmVzb3VyY2VzID0gdEZhaWxvdmVyLmZpbmRSZXNvdXJjZXMoJ0FXUzo6QVJDUmVnaW9uU3dpdGNoOjpQbGFuJyk7XG4gIGNvbnN0IHBsYW4gPSBPYmplY3QudmFsdWVzKHJlc291cmNlcylbMF07XG4gIGNvbnN0IGxhbWJkYXMgPSAocGxhbiBhcyBhbnkpLlByb3BlcnRpZXMuV29ya2Zsb3dzWzBdLlN0ZXBzWzBdXG4gICAgLkV4ZWN1dGlvbkJsb2NrQ29uZmlndXJhdGlvbi5DdXN0b21BY3Rpb25MYW1iZGFDb25maWcuTGFtYmRhcztcblxuICBleHBlY3QobGFtYmRhcykudG9FcXVhbChbXG4gICAgeyBBcm46IHByaW1hcnlBcm4gfSxcbiAgICB7IEFybjogc2Vjb25kYXJ5QXJuIH0sXG4gIF0pO1xufSk7XG5cbi8vIC0tLSBMb2FkIHRlc3QgTGFtYmRhIGhhcyBhY2Nlc3MgdG8gY29ycmVjdCBidWNrZXRzIC0tLVxuXG50ZXN0KCdMb2FkIHRlc3QgTGFtYmRhIGVudiB2YXJzIHJlZmVyZW5jZSBjb3JyZWN0IGJ1Y2tldCBuYW1lcycsICgpID0+IHtcbiAgdEZhaWxvdmVyLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpMYW1iZGE6OkZ1bmN0aW9uJywge1xuICAgIEZ1bmN0aW9uTmFtZTogYCR7cHJvamVjdH0tbG9hZC10ZXN0YCxcbiAgICBFbnZpcm9ubWVudDoge1xuICAgICAgVmFyaWFibGVzOiB7XG4gICAgICAgIFBSSU1BUllfQlVDS0VUOiBwcmltYXJ5QnVja2V0TmFtZSxcbiAgICAgICAgU0VDT05EQVJZX0JVQ0tFVDogc2Vjb25kYXJ5QnVja2V0TmFtZSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSk7XG59KTtcblxuLy8gLS0tIE1SQVAgbW9uaXRvciB1c2VzIGNvcnJlY3QgbmFtZXNwYWNlIC0tLVxuXG50ZXN0KCdNUkFQIG1vbml0b3IgbWV0cmljIG5hbWVzcGFjZSBtYXRjaGVzIG1vbml0b3JpbmcgZGFzaGJvYXJkIG5hbWVzcGFjZScsICgpID0+IHtcbiAgY29uc3QgYXBwMiA9IG5ldyBjZGsuQXBwKCk7XG4gIGNvbnN0IHRNb25pdG9yaW5nID0gVGVtcGxhdGUuZnJvbVN0YWNrKFxuICAgIG5ldyBNb25pdG9yaW5nU3RhY2soYXBwMiwgJ0ludE1vbml0b3JpbmdDaGVjaycsIHtcbiAgICAgIHByb2plY3QsIHNvdXJjZUJ1Y2tldE5hbWU6IHNlY29uZGFyeUJ1Y2tldE5hbWUsIGRlc3RCdWNrZXROYW1lOiBwcmltYXJ5QnVja2V0TmFtZSxcbiAgICAgIHJlcGxpY2F0aW9uUnVsZUlkOiAndG8tcHJpbWFyeScsIHNvdXJjZVJlZ2lvbkxhYmVsOiAncGR4JywgZGVzdFJlZ2lvbkxhYmVsOiAnaWFkJyxcbiAgICAgIHJldmVyc2VSdWxlSWQ6ICd0by1zZWNvbmRhcnknLCByZXZlcnNlU291cmNlQnVja2V0TmFtZTogcHJpbWFyeUJ1Y2tldE5hbWUsIHJldmVyc2VEZXN0QnVja2V0TmFtZTogc2Vjb25kYXJ5QnVja2V0TmFtZSxcbiAgICAgIHByaW1hcnlSZWdpb24sIHNlY29uZGFyeVJlZ2lvbiwgYWNjb3VudElkLCBtcmFwQWxpYXM6ICd0ZXN0Lm1yYXAnLFxuICAgICAgZW5jcnlwdGlvbktleUFybjogdGVzdEtleUFybixcbiAgICAgIGVudjogeyBhY2NvdW50OiBhY2NvdW50SWQsIHJlZ2lvbjogcHJpbWFyeVJlZ2lvbiB9LFxuICAgIH0pXG4gICk7XG4gIHRNb25pdG9yaW5nLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpMYW1iZGE6OkZ1bmN0aW9uJywge1xuICAgIEVudmlyb25tZW50OiB7XG4gICAgICBWYXJpYWJsZXM6IHtcbiAgICAgICAgTUVUUklDX05BTUVTUEFDRTogcHJvamVjdCxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSk7XG59KTtcblxuLy8gLS0tIE1SQVAgaWRlbnRpZmllciBmb3JtYXQ6IGFsbCBMYW1iZGFzIG11c3QgdXNlIEFSTiAod2l0aCBhbGlhcyksIG5ldmVyIHRoZSBuYW1lIC0tLVxuXG50ZXN0KCdSb3V0aW5nIExhbWJkYSB1c2VzIE1SQVAgQVJOIChub3QgbmFtZSkgaW4gZW52IHZhcnMnLCAoKSA9PiB7XG4gIGNvbnN0IHRSb3V0aW5nID0gVGVtcGxhdGUuZnJvbVN0YWNrKHJvdXRpbmdQcmltYXJ5KTtcbiAgY29uc3QgZm5zID0gdFJvdXRpbmcuZmluZFJlc291cmNlcygnQVdTOjpMYW1iZGE6OkZ1bmN0aW9uJyk7XG4gIGZvciAoY29uc3QgWywgZm5dIG9mIE9iamVjdC5lbnRyaWVzKGZucykpIHtcbiAgICBjb25zdCB2YXJzID0gKGZuIGFzIGFueSkuUHJvcGVydGllcz8uRW52aXJvbm1lbnQ/LlZhcmlhYmxlcyB8fCB7fTtcbiAgICAvLyBNdXN0IG5vdCBoYXZlIE1SQVBfTkFNRSDigJQgdGhhdCBjYXVzZXMgSW52YWxpZFJlcXVlc3QgZXJyb3JzXG4gICAgZXhwZWN0KHZhcnMpLm5vdC50b0hhdmVQcm9wZXJ0eSgnTVJBUF9OQU1FJyk7XG4gICAgLy8gSWYgaXQgaGFzIE1SQVBfQVJOLCBpdCBtdXN0IGJlIGFuIEFSTiBmb3JtYXRcbiAgICBpZiAodmFycy5NUkFQX0FSTikge1xuICAgICAgZXhwZWN0KHZhcnMuTVJBUF9BUk4pLnRvTWF0Y2goL15hcm46YXdzOnMzOjovKTtcbiAgICB9XG4gIH1cbn0pO1xuXG50ZXN0KCdNb25pdG9yIExhbWJkYSB1c2VzIE1SQVAgYWxpYXMgKG5vdCBuYW1lKSBpbiBlbnYgdmFycycsICgpID0+IHtcbiAgY29uc3QgYXBwMyA9IG5ldyBjZGsuQXBwKCk7XG4gIGNvbnN0IHRNb24gPSBUZW1wbGF0ZS5mcm9tU3RhY2soXG4gICAgbmV3IE1vbml0b3JpbmdTdGFjayhhcHAzLCAnSW50TW9uaXRvckFybkNoZWNrJywge1xuICAgICAgcHJvamVjdCwgc291cmNlQnVja2V0TmFtZTogc2Vjb25kYXJ5QnVja2V0TmFtZSwgZGVzdEJ1Y2tldE5hbWU6IHByaW1hcnlCdWNrZXROYW1lLFxuICAgICAgcmVwbGljYXRpb25SdWxlSWQ6ICd0by1wcmltYXJ5Jywgc291cmNlUmVnaW9uTGFiZWw6ICdwZHgnLCBkZXN0UmVnaW9uTGFiZWw6ICdpYWQnLFxuICAgICAgcmV2ZXJzZVJ1bGVJZDogJ3RvLXNlY29uZGFyeScsIHJldmVyc2VTb3VyY2VCdWNrZXROYW1lOiBwcmltYXJ5QnVja2V0TmFtZSwgcmV2ZXJzZURlc3RCdWNrZXROYW1lOiBzZWNvbmRhcnlCdWNrZXROYW1lLFxuICAgICAgcHJpbWFyeVJlZ2lvbiwgc2Vjb25kYXJ5UmVnaW9uLCBhY2NvdW50SWQsIG1yYXBBbGlhczogJ3Rlc3QubXJhcCcsXG4gICAgICBlbmNyeXB0aW9uS2V5QXJuOiB0ZXN0S2V5QXJuLFxuICAgICAgZW52OiB7IGFjY291bnQ6IGFjY291bnRJZCwgcmVnaW9uOiBwcmltYXJ5UmVnaW9uIH0sXG4gICAgfSlcbiAgKTtcbiAgY29uc3QgZm5zID0gdE1vbi5maW5kUmVzb3VyY2VzKCdBV1M6OkxhbWJkYTo6RnVuY3Rpb24nKTtcbiAgZm9yIChjb25zdCBbLCBmbl0gb2YgT2JqZWN0LmVudHJpZXMoZm5zKSkge1xuICAgIGNvbnN0IHZhcnMgPSAoZm4gYXMgYW55KS5Qcm9wZXJ0aWVzPy5FbnZpcm9ubWVudD8uVmFyaWFibGVzIHx8IHt9O1xuICAgIGV4cGVjdCh2YXJzKS5ub3QudG9IYXZlUHJvcGVydHkoJ01SQVBfTkFNRScpO1xuICAgIGlmICh2YXJzLk1SQVBfQUxJQVMpIHtcbiAgICAgIGV4cGVjdCh2YXJzLk1SQVBfQUxJQVMpLm5vdC50b0JlKG1yYXBOYW1lKTtcbiAgICB9XG4gIH1cbn0pO1xuXG50ZXN0KCdSb3V0aW5nIExhbWJkYSBJQU0gcG9saWN5IHJlc291cmNlIG1hdGNoZXMgdGhlIE1SQVAgYWxpYXMgQVJOIChub3QgbmFtZSknLCAoKSA9PiB7XG4gIGNvbnN0IHRSb3V0aW5nID0gVGVtcGxhdGUuZnJvbVN0YWNrKHJvdXRpbmdQcmltYXJ5KTtcbiAgY29uc3QgcG9saWNpZXMgPSB0Um91dGluZy5maW5kUmVzb3VyY2VzKCdBV1M6OklBTTo6UG9saWN5Jyk7XG4gIGZvciAoY29uc3QgWywgcG9saWN5XSBvZiBPYmplY3QuZW50cmllcyhwb2xpY2llcykpIHtcbiAgICBjb25zdCBzdGF0ZW1lbnRzID0gKHBvbGljeSBhcyBhbnkpLlByb3BlcnRpZXM/LlBvbGljeURvY3VtZW50Py5TdGF0ZW1lbnQgfHwgW107XG4gICAgZm9yIChjb25zdCBzdG10IG9mIHN0YXRlbWVudHMpIHtcbiAgICAgIGNvbnN0IHJlc291cmNlcyA9IEFycmF5LmlzQXJyYXkoc3RtdC5SZXNvdXJjZSkgPyBzdG10LlJlc291cmNlIDogW3N0bXQuUmVzb3VyY2VdO1xuICAgICAgZm9yIChjb25zdCByIG9mIHJlc291cmNlcykge1xuICAgICAgICBpZiAodHlwZW9mIHIgPT09ICdzdHJpbmcnICYmIHIuaW5jbHVkZXMoJzphY2Nlc3Nwb2ludC8nKSkge1xuICAgICAgICAgIC8vIE11c3Qgbm90IGNvbnRhaW4gdGhlIE1SQVAgbmFtZSDigJQgbXVzdCB1c2UgYWxpYXMgb3Igd2lsZGNhcmRcbiAgICAgICAgICBleHBlY3Qocikubm90LnRvQ29udGFpbihgOmFjY2Vzc3BvaW50LyR7bXJhcE5hbWV9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbn0pO1xuXG50ZXN0KCdObyBMYW1iZGEgaW4gYW55IHN0YWNrIHVzZXMgTVJBUF9OQU1FIGVudiB2YXInLCAoKSA9PiB7XG4gIGNvbnN0IGFsbFRlbXBsYXRlcyA9IFtcbiAgICBUZW1wbGF0ZS5mcm9tU3RhY2soYnVja2V0UHJpbWFyeSksXG4gICAgVGVtcGxhdGUuZnJvbVN0YWNrKGdsb2JhbFJvdXRpbmcpLFxuICAgIFRlbXBsYXRlLmZyb21TdGFjayhyb3V0aW5nUHJpbWFyeSksXG4gICAgVGVtcGxhdGUuZnJvbVN0YWNrKGZhaWxvdmVyKSxcbiAgXTtcbiAgZm9yIChjb25zdCB0IG9mIGFsbFRlbXBsYXRlcykge1xuICAgIGNvbnN0IGZucyA9IHQuZmluZFJlc291cmNlcygnQVdTOjpMYW1iZGE6OkZ1bmN0aW9uJyk7XG4gICAgZm9yIChjb25zdCBbbmFtZSwgZm5dIG9mIE9iamVjdC5lbnRyaWVzKGZucykpIHtcbiAgICAgIGNvbnN0IHZhcnMgPSAoZm4gYXMgYW55KS5Qcm9wZXJ0aWVzPy5FbnZpcm9ubWVudD8uVmFyaWFibGVzIHx8IHt9O1xuICAgICAgZXhwZWN0KHZhcnMpLm5vdC50b0hhdmVQcm9wZXJ0eSgnTVJBUF9OQU1FJyk7XG4gICAgfVxuICB9XG59KTtcbiJdfQ==