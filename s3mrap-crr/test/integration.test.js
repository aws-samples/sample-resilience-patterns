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
const bucketPrimary = new regional_bucket_stack_1.RegionalBucketStack(app, 'IntBucketPrimary', {
    project, env: { account: accountId, region: primaryRegion },
});
const bucketSecondary = new regional_bucket_stack_1.RegionalBucketStack(app, 'IntBucketSecondary', {
    project, env: { account: accountId, region: secondaryRegion },
});
const globalRouting = new global_routing_stack_1.GlobalRoutingStack(app, 'IntGlobalRouting', {
    project, primaryBucketName, secondaryBucketName,
    primaryRegion, secondaryRegion, accountId,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW50ZWdyYXRpb24udGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImludGVncmF0aW9uLnRlc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMsdURBQWtEO0FBQ2xELHdFQUFtRTtBQUNuRSxzRUFBaUU7QUFDakUsc0VBQWlFO0FBQ2pFLDBEQUFzRDtBQUN0RCw4REFBMEQ7QUFFMUQ7OztHQUdHO0FBRUgsTUFBTSxPQUFPLEdBQUcsUUFBUSxDQUFDO0FBQ3pCLE1BQU0sU0FBUyxHQUFHLGNBQWMsQ0FBQztBQUNqQyxNQUFNLGFBQWEsR0FBRyxXQUFXLENBQUM7QUFDbEMsTUFBTSxlQUFlLEdBQUcsV0FBVyxDQUFDO0FBRXBDLHdDQUF3QztBQUN4QyxNQUFNLGlCQUFpQixHQUFHLEdBQUcsT0FBTyxJQUFJLGFBQWEsSUFBSSxTQUFTLEVBQUUsQ0FBQztBQUNyRSxNQUFNLG1CQUFtQixHQUFHLEdBQUcsT0FBTyxJQUFJLGVBQWUsSUFBSSxTQUFTLEVBQUUsQ0FBQztBQUN6RSxNQUFNLFFBQVEsR0FBRyxHQUFHLE9BQU8sT0FBTyxDQUFDO0FBQ25DLE1BQU0sYUFBYSxHQUFHLEdBQUcsT0FBTyxlQUFlLENBQUM7QUFFaEQsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7QUFFMUIsTUFBTSxhQUFhLEdBQUcsSUFBSSwyQ0FBbUIsQ0FBQyxHQUFHLEVBQUUsa0JBQWtCLEVBQUU7SUFDckUsT0FBTyxFQUFFLEdBQUcsRUFBRSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSxFQUFFLGFBQWEsRUFBRTtDQUM1RCxDQUFDLENBQUM7QUFFSCxNQUFNLGVBQWUsR0FBRyxJQUFJLDJDQUFtQixDQUFDLEdBQUcsRUFBRSxvQkFBb0IsRUFBRTtJQUN6RSxPQUFPLEVBQUUsR0FBRyxFQUFFLEVBQUUsT0FBTyxFQUFFLFNBQVMs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SSxDQUFDLCtDQUErQyxFQUFFLEdBQUcsRUFBRTtJQUN6RCxNQUFNLFlBQVksR0FBRztRQUNuQixxQkFBUSxDQUFDLFNBQVMsQ0FBQyxhQUFhLENBQUM7UUFDakMscUJBQVEsQ0FBQyxTQUFTLENBQUMsYUFBYSxDQUFDO1FBQ2pDLHFCQUFRLENBQUMsU0FBUyxDQUFDLGNBQWMsQ0FBQztRQUNsQyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUM7S0FDN0IsQ0FBQztJQUNGLEtBQUssTUFBTSxDQUFDLElBQUksWUFBWSxFQUFFLENBQUM7UUFDN0IsTUFBTSxHQUFHLEdBQUcsQ0FBQyxDQUFDLGFBQWEsQ0FBQyx1QkFBdUIsQ0FBQyxDQUFDO1FBQ3JELEtBQUssTUFBTSxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDN0MsTUFBTSxJQUFJLEdBQUksRUFBVSxDQUFDLFVBQVUsRUFBRSxXQUFXLEVBQUUsU0FBUyxJQUFJLEVBQUUsQ0FBQztZQUNsRSxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLGNBQWMsQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUMvQyxDQUFDO0lBQ0gsQ0FBQztBQUNILENBQUMsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IFRlbXBsYXRlIH0gZnJvbSAnYXdzLWNkay1saWIvYXNzZXJ0aW9ucyc7XG5pbXBvcnQgeyBSZWdpb25hbEJ1Y2tldFN0YWNrIH0gZnJvbSAnLi4vbGliL3JlZ2lvbmFsLWJ1Y2tldC1zdGFjayc7XG5pbXBvcnQgeyBHbG9iYWxSb3V0aW5nU3RhY2sgfSBmcm9tICcuLi9saWIvZ2xvYmFsLXJvdXRpbmctc3RhY2snO1xuaW1wb3J0IHsgUm91dGluZ0xhbWJkYVN0YWNrIH0gZnJvbSAnLi4vbGliL3JvdXRpbmctbGFtYmRhLXN0YWNrJztcbmltcG9ydCB7IEZhaWxvdmVyU3RhY2sgfSBmcm9tICcuLi9saWIvZmFpbG92ZXItc3RhY2snO1xuaW1wb3J0IHsgTW9uaXRvcmluZ1N0YWNrIH0gZnJvbSAnLi4vbGliL21vbml0b3Jpbmctc3RhY2snO1xuXG4vKipcbiAqIEludGVncmF0aW9uIHRlc3RzIHRoYXQgdmVyaWZ5IGNyb3NzLXN0YWNrIGNvbnNpc3RlbmN5LlxuICogVGhlc2UgY2F0Y2ggYnVncyB3aGVyZSBvbmUgc3RhY2sgY29tcHV0ZXMgYSByZXNvdXJjZSBuYW1lIGRpZmZlcmVudGx5IHRoYW4gYW5vdGhlci5cbiAqL1xuXG5jb25zdCBwcm9qZWN0ID0gJ3MzbXJhcCc7XG5jb25zdCBhY2NvdW50SWQgPSAnMTIzNDU2Nzg5MDEyJztcbmNvbnN0IHByaW1hcnlSZWdpb24gPSAndXMtZWFzdC0xJztcbmNvbnN0IHNlY29uZGFyeVJlZ2lvbiA9ICd1cy13ZXN0LTInO1xuXG4vLyBUaGVzZSBtdXN0IG1hdGNoIHdoYXQgYXBwLnRzIGNvbXB1dGVzXG5jb25zdCBwcmltYXJ5QnVja2V0TmFtZSA9IGAke3Byb2plY3R9LSR7cHJpbWFyeVJlZ2lvbn0tJHthY2NvdW50SWR9YDtcbmNvbnN0IHNlY29uZGFyeUJ1Y2tldE5hbWUgPSBgJHtwcm9qZWN0fS0ke3NlY29uZGFyeVJlZ2lvbn0tJHthY2NvdW50SWR9YDtcbmNvbnN0IG1yYXBOYW1lID0gYCR7cHJvamVjdH0tbXJhcGA7XG5jb25zdCByb3V0aW5nRm5OYW1lID0gYCR7cHJvamVjdH0tbXJhcC1yb3V0aW5nYDtcblxuY29uc3QgYXBwID0gbmV3IGNkay5BcHAoKTtcblxuY29uc3QgYnVja2V0UHJpbWFyeSA9IG5ldyBSZWdpb25hbEJ1Y2tldFN0YWNrKGFwcCwgJ0ludEJ1Y2tldFByaW1hcnknLCB7XG4gIHByb2plY3QsIGVudjogeyBhY2NvdW50OiBhY2NvdW50SWQsIHJlZ2lvbjogcHJpbWFyeVJlZ2lvbiB9LFxufSk7XG5cbmNvbnN0IGJ1Y2tldFNlY29uZGFyeSA9IG5ldyBSZWdpb25hbEJ1Y2tldFN0YWNrKGFwcCwgJ0ludEJ1Y2tldFNlY29uZGFyeScsIHtcbiAgcHJvamVjdCwgZW52OiB7IGFjY291bnQ6IGFjY291bnRJZCwgcmVnaW9uOiBzZWNvbmRhcnlSZWdpb24gfSxcbn0pO1xuXG5jb25zdCBnbG9iYWxSb3V0aW5nID0gbmV3IEdsb2JhbFJvdXRpbmdTdGFjayhhcHAsICdJbnRHbG9iYWxSb3V0aW5nJywge1xuICBwcm9qZWN0LCBwcmltYXJ5QnVja2V0TmFtZSwgc2Vjb25kYXJ5QnVja2V0TmFtZSxcbiAgcHJpbWFyeVJlZ2lvbiwgc2Vjb25kYXJ5UmVnaW9uLCBhY2NvdW50SWQsXG4gIGVudjogeyBhY2NvdW50OiBhY2NvdW50SWQsIHJlZ2lvbjogcHJpbWFyeVJlZ2lvbiB9LFxufSk7XG5cbmNvbnN0IHJvdXRpbmdQcmltYXJ5ID0gbmV3IFJvdXRpbmdMYW1iZGFTdGFjayhhcHAsICdJbnRSb3V0aW5nUHJpbWFyeScsIHtcbiAgcHJvamVjdCwgcHJpbWFyeUJ1Y2tldE5hbWUsIHNlY29uZGFyeUJ1Y2tldE5hbWUsXG4gIHByaW1hcnlSZWdpb24sIHNlY29uZGFyeVJlZ2lvbiwgYWNjb3VudElkLCBtcmFwTmFtZSwgbXJhcEFsaWFzOiAndGVzdC1hbGlhcy5tcmFwJyxcbiAgZW52OiB7IGFjY291bnQ6IGFjY291bnRJZCwgcmVnaW9uOiBwcmltYXJ5UmVnaW9uIH0sXG59KTtcblxuY29uc3QgZmFpbG92ZXIgPSBuZXcgRmFpbG92ZXJTdGFjayhhcHAsICdJbnRGYWlsb3ZlcicsIHtcbiAgcHJvamVjdCwgcHJpbWFyeUJ1Y2tldE5hbWUsIHNlY29uZGFyeUJ1Y2tldE5hbWUsXG4gIHByaW1hcnlSZWdpb24sIHNlY29uZGFyeVJlZ2lvbiwgYWNjb3VudElkLCBtcmFwTmFtZSxcbiAgcHJpbWFyeVJvdXRpbmdMYW1iZGFBcm46IGBhcm46YXdzOmxhbWJkYToke3ByaW1hcnlSZWdpb259OiR7YWNjb3VudElkfTpmdW5jdGlvbjoke3JvdXRpbmdGbk5hbWV9YCxcbiAgc2Vjb25kYXJ5Um91dGluZ0xhbWJkYUFybjogYGFybjphd3M6bGFtYmRhOiR7c2Vjb25kYXJ5UmVnaW9ufToke2FjY291bnRJZH06ZnVuY3Rpb246JHtyb3V0aW5nRm5OYW1lfWAsXG4gIGVudjogeyBhY2NvdW50OiBhY2NvdW50SWQsIHJlZ2lvbjogcHJpbWFyeVJlZ2lvbiB9LFxufSk7XG5cbmNvbnN0IHRCdWNrZXRQcmltYXJ5ID0gVGVtcGxhdGUuZnJvbVN0YWNrKGJ1Y2tldFByaW1hcnkpO1xuY29uc3QgdEJ1Y2tldFNlY29uZGFyeSA9IFRlbXBsYXRlLmZyb21TdGFjayhidWNrZXRTZWNvbmRhcnkpO1xuY29uc3QgdEdsb2JhbFJvdXRpbmcgPSBUZW1wbGF0ZS5mcm9tU3RhY2soZ2xvYmFsUm91dGluZyk7XG5jb25zdCB0Um91dGluZ1ByaW1hcnkgPSBUZW1wbGF0ZS5mcm9tU3RhY2socm91dGluZ1ByaW1hcnkpO1xuY29uc3QgdEZhaWxvdmVyID0gVGVtcGxhdGUuZnJvbVN0YWNrKGZhaWxvdmVyKTtcblxuLy8gLS0tIEJ1Y2tldCBuYW1lIGNvbnNpc3RlbmN5IC0tLVxuXG50ZXN0KCdQcmltYXJ5IGJ1Y2tldCBuYW1lIG1hdGNoZXMgd2hhdCBnbG9iYWwtcm91dGluZyBleHBlY3RzJywgKCkgPT4ge1xuICB0QnVja2V0UHJpbWFyeS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6UzM6OkJ1Y2tldCcsIHtcbiAgICBCdWNrZXROYW1lOiBwcmltYXJ5QnVja2V0TmFtZSxcbiAgfSk7XG59KTtcblxudGVzdCgnU2Vjb25kYXJ5IGJ1Y2tldCBuYW1lIG1hdGNoZXMgd2hhdCBnbG9iYWwtcm91dGluZyBleHBlY3RzJywgKCkgPT4ge1xuICB0QnVja2V0U2Vjb25kYXJ5Lmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTMzo6QnVja2V0Jywge1xuICAgIEJ1Y2tldE5hbWU6IHNlY29uZGFyeUJ1Y2tldE5hbWUsXG4gIH0pO1xufSk7XG5cbnRlc3QoJ01SQVAgcmVmZXJlbmNlcyB0aGUgc2FtZSBidWNrZXQgbmFtZXMgYXMgdGhlIGJ1Y2tldCBzdGFja3MnLCAoKSA9PiB7XG4gIHRHbG9iYWxSb3V0aW5nLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTMzo6TXVsdGlSZWdpb25BY2Nlc3NQb2ludCcsIHtcbiAgICBSZWdpb25zOiBbXG4gICAgICB7IEJ1Y2tldDogcHJpbWFyeUJ1Y2tldE5hbWUgfSxcbiAgICAgIHsgQnVja2V0OiBzZWNvbmRhcnlCdWNrZXROYW1lIH0sXG4gICAgXSxcbiAgfSk7XG59KTtcblxuLy8gLS0tIExhbWJkYSBuYW1lIGNvbnNpc3RlbmN5IC0tLVxuXG50ZXN0KCdSb3V0aW5nIExhbWJkYSBuYW1lIG1hdGNoZXMgd2hhdCBmYWlsb3ZlciBzdGFjayByZWZlcmVuY2VzJywgKCkgPT4ge1xuICB0Um91dGluZ1ByaW1hcnkuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkxhbWJkYTo6RnVuY3Rpb24nLCB7XG4gICAgRnVuY3Rpb25OYW1lOiByb3V0aW5nRm5OYW1lLFxuICB9KTtcbn0pO1xuXG50ZXN0KCdGYWlsb3ZlciBBUkMgcGxhbiByZWZlcmVuY2VzIHJvdXRpbmcgTGFtYmRhIEFSTnMgd2l0aCBjb3JyZWN0IGZ1bmN0aW9uIG5hbWUnLCAoKSA9PiB7XG4gIGNvbnN0IHByaW1hcnlBcm4gPSBgYXJuOmF3czpsYW1iZGE6JHtwcmltYXJ5UmVnaW9ufToke2FjY291bnRJZH06ZnVuY3Rpb246JHtyb3V0aW5nRm5OYW1lfWA7XG4gIGNvbnN0IHNlY29uZGFyeUFybiA9IGBhcm46YXdzOmxhbWJkYToke3NlY29uZGFyeVJlZ2lvbn06JHthY2NvdW50SWR9OmZ1bmN0aW9uOiR7cm91dGluZ0ZuTmFtZX1gO1xuXG4gIGNvbnN0IHJlc291cmNlcyA9IHRGYWlsb3Zlci5maW5kUmVzb3VyY2VzKCdBV1M6OkFSQ1JlZ2lvblN3aXRjaDo6UGxhbicpO1xuICBjb25zdCBwbGFuID0gT2JqZWN0LnZhbHVlcyhyZXNvdXJjZXMpWzBdO1xuICBjb25zdCBsYW1iZGFzID0gKHBsYW4gYXMgYW55KS5Qcm9wZXJ0aWVzLldvcmtmbG93c1swXS5TdGVwc1swXVxuICAgIC5FeGVjdXRpb25CbG9ja0NvbmZpZ3VyYXRpb24uQ3VzdG9tQWN0aW9uTGFtYmRhQ29uZmlnLkxhbWJkYXM7XG5cbiAgZXhwZWN0KGxhbWJkYXMpLnRvRXF1YWwoW1xuICAgIHsgQXJuOiBwcmltYXJ5QXJuIH0sXG4gICAgeyBBcm46IHNlY29uZGFyeUFybiB9LFxuICBdKTtcbn0pO1xuXG4vLyAtLS0gTG9hZCB0ZXN0IExhbWJkYSBoYXMgYWNjZXNzIHRvIGNvcnJlY3QgYnVja2V0cyAtLS1cblxudGVzdCgnTG9hZCB0ZXN0IExhbWJkYSBlbnYgdmFycyByZWZlcmVuY2UgY29ycmVjdCBidWNrZXQgbmFtZXMnLCAoKSA9PiB7XG4gIHRGYWlsb3Zlci5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6TGFtYmRhOjpGdW5jdGlvbicsIHtcbiAgICBGdW5jdGlvbk5hbWU6IGAke3Byb2plY3R9LWxvYWQtdGVzdGAsXG4gICAgRW52aXJvbm1lbnQ6IHtcbiAgICAgIFZhcmlhYmxlczoge1xuICAgICAgICBQUklNQVJZX0JVQ0tFVDogcHJpbWFyeUJ1Y2tldE5hbWUsXG4gICAgICAgIFNFQ09OREFSWV9CVUNLRVQ6IHNlY29uZGFyeUJ1Y2tldE5hbWUsXG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xufSk7XG5cbi8vIC0tLSBNUkFQIG1vbml0b3IgdXNlcyBjb3JyZWN0IG5hbWVzcGFjZSAtLS1cblxudGVzdCgnTVJBUCBtb25pdG9yIG1ldHJpYyBuYW1lc3BhY2UgbWF0Y2hlcyBtb25pdG9yaW5nIGRhc2hib2FyZCBuYW1lc3BhY2UnLCAoKSA9PiB7XG4gIGNvbnN0IGFwcDIgPSBuZXcgY2RrLkFwcCgpO1xuICBjb25zdCB0TW9uaXRvcmluZyA9IFRlbXBsYXRlLmZyb21TdGFjayhcbiAgICBuZXcgTW9uaXRvcmluZ1N0YWNrKGFwcDIsICdJbnRNb25pdG9yaW5nQ2hlY2snLCB7XG4gICAgICBwcm9qZWN0LCBzb3VyY2VCdWNrZXROYW1lOiBzZWNvbmRhcnlCdWNrZXROYW1lLCBkZXN0QnVja2V0TmFtZTogcHJpbWFyeUJ1Y2tldE5hbWUsXG4gICAgICByZXBsaWNhdGlvblJ1bGVJZDogJ3RvLXByaW1hcnknLCBzb3VyY2VSZWdpb25MYWJlbDogJ3BkeCcsIGRlc3RSZWdpb25MYWJlbDogJ2lhZCcsXG4gICAgICByZXZlcnNlUnVsZUlkOiAndG8tc2Vjb25kYXJ5JywgcmV2ZXJzZVNvdXJjZUJ1Y2tldE5hbWU6IHByaW1hcnlCdWNrZXROYW1lLCByZXZlcnNlRGVzdEJ1Y2tldE5hbWU6IHNlY29uZGFyeUJ1Y2tldE5hbWUsXG4gICAgICBwcmltYXJ5UmVnaW9uLCBzZWNvbmRhcnlSZWdpb24sIGFjY291bnRJZCwgbXJhcEFsaWFzOiAndGVzdC5tcmFwJyxcbiAgICAgIGVudjogeyBhY2NvdW50OiBhY2NvdW50SWQsIHJlZ2lvbjogcHJpbWFyeVJlZ2lvbiB9LFxuICAgIH0pXG4gICk7XG4gIHRNb25pdG9yaW5nLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpMYW1iZGE6OkZ1bmN0aW9uJywge1xuICAgIEVudmlyb25tZW50OiB7XG4gICAgICBWYXJpYWJsZXM6IHtcbiAgICAgICAgTUVUUklDX05BTUVTUEFDRTogcHJvamVjdCxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSk7XG59KTtcblxuLy8gLS0tIE1SQVAgaWRlbnRpZmllciBmb3JtYXQ6IGFsbCBMYW1iZGFzIG11c3QgdXNlIEFSTiAod2l0aCBhbGlhcyksIG5ldmVyIHRoZSBuYW1lIC0tLVxuXG50ZXN0KCdSb3V0aW5nIExhbWJkYSB1c2VzIE1SQVAgQVJOIChub3QgbmFtZSkgaW4gZW52IHZhcnMnLCAoKSA9PiB7XG4gIGNvbnN0IHRSb3V0aW5nID0gVGVtcGxhdGUuZnJvbVN0YWNrKHJvdXRpbmdQcmltYXJ5KTtcbiAgY29uc3QgZm5zID0gdFJvdXRpbmcuZmluZFJlc291cmNlcygnQVdTOjpMYW1iZGE6OkZ1bmN0aW9uJyk7XG4gIGZvciAoY29uc3QgWywgZm5dIG9mIE9iamVjdC5lbnRyaWVzKGZucykpIHtcbiAgICBjb25zdCB2YXJzID0gKGZuIGFzIGFueSkuUHJvcGVydGllcz8uRW52aXJvbm1lbnQ/LlZhcmlhYmxlcyB8fCB7fTtcbiAgICAvLyBNdXN0IG5vdCBoYXZlIE1SQVBfTkFNRSDigJQgdGhhdCBjYXVzZXMgSW52YWxpZFJlcXVlc3QgZXJyb3JzXG4gICAgZXhwZWN0KHZhcnMpLm5vdC50b0hhdmVQcm9wZXJ0eSgnTVJBUF9OQU1FJyk7XG4gICAgLy8gSWYgaXQgaGFzIE1SQVBfQVJOLCBpdCBtdXN0IGJlIGFuIEFSTiBmb3JtYXRcbiAgICBpZiAodmFycy5NUkFQX0FSTikge1xuICAgICAgZXhwZWN0KHZhcnMuTVJBUF9BUk4pLnRvTWF0Y2goL15hcm46YXdzOnMzOjovKTtcbiAgICB9XG4gIH1cbn0pO1xuXG50ZXN0KCdNb25pdG9yIExhbWJkYSB1c2VzIE1SQVAgYWxpYXMgKG5vdCBuYW1lKSBpbiBlbnYgdmFycycsICgpID0+IHtcbiAgY29uc3QgYXBwMyA9IG5ldyBjZGsuQXBwKCk7XG4gIGNvbnN0IHRNb24gPSBUZW1wbGF0ZS5mcm9tU3RhY2soXG4gICAgbmV3IE1vbml0b3JpbmdTdGFjayhhcHAzLCAnSW50TW9uaXRvckFybkNoZWNrJywge1xuICAgICAgcHJvamVjdCwgc291cmNlQnVja2V0TmFtZTogc2Vjb25kYXJ5QnVja2V0TmFtZSwgZGVzdEJ1Y2tldE5hbWU6IHByaW1hcnlCdWNrZXROYW1lLFxuICAgICAgcmVwbGljYXRpb25SdWxlSWQ6ICd0by1wcmltYXJ5Jywgc291cmNlUmVnaW9uTGFiZWw6ICdwZHgnLCBkZXN0UmVnaW9uTGFiZWw6ICdpYWQnLFxuICAgICAgcmV2ZXJzZVJ1bGVJZDogJ3RvLXNlY29uZGFyeScsIHJldmVyc2VTb3VyY2VCdWNrZXROYW1lOiBwcmltYXJ5QnVja2V0TmFtZSwgcmV2ZXJzZURlc3RCdWNrZXROYW1lOiBzZWNvbmRhcnlCdWNrZXROYW1lLFxuICAgICAgcHJpbWFyeVJlZ2lvbiwgc2Vjb25kYXJ5UmVnaW9uLCBhY2NvdW50SWQsIG1yYXBBbGlhczogJ3Rlc3QubXJhcCcsXG4gICAgICBlbnY6IHsgYWNjb3VudDogYWNjb3VudElkLCByZWdpb246IHByaW1hcnlSZWdpb24gfSxcbiAgICB9KVxuICApO1xuICBjb25zdCBmbnMgPSB0TW9uLmZpbmRSZXNvdXJjZXMoJ0FXUzo6TGFtYmRhOjpGdW5jdGlvbicpO1xuICBmb3IgKGNvbnN0IFssIGZuXSBvZiBPYmplY3QuZW50cmllcyhmbnMpKSB7XG4gICAgY29uc3QgdmFycyA9IChmbiBhcyBhbnkpLlByb3BlcnRpZXM/LkVudmlyb25tZW50Py5WYXJpYWJsZXMgfHwge307XG4gICAgZXhwZWN0KHZhcnMpLm5vdC50b0hhdmVQcm9wZXJ0eSgnTVJBUF9OQU1FJyk7XG4gICAgaWYgKHZhcnMuTVJBUF9BTElBUykge1xuICAgICAgZXhwZWN0KHZhcnMuTVJBUF9BTElBUykubm90LnRvQmUobXJhcE5hbWUpO1xuICAgIH1cbiAgfVxufSk7XG5cbnRlc3QoJ1JvdXRpbmcgTGFtYmRhIElBTSBwb2xpY3kgcmVzb3VyY2UgbWF0Y2hlcyB0aGUgTVJBUCBhbGlhcyBBUk4gKG5vdCBuYW1lKScsICgpID0+IHtcbiAgY29uc3QgdFJvdXRpbmcgPSBUZW1wbGF0ZS5mcm9tU3RhY2socm91dGluZ1ByaW1hcnkpO1xuICBjb25zdCBwb2xpY2llcyA9IHRSb3V0aW5nLmZpbmRSZXNvdXJjZXMoJ0FXUzo6SUFNOjpQb2xpY3knKTtcbiAgZm9yIChjb25zdCBbLCBwb2xpY3ldIG9mIE9iamVjdC5lbnRyaWVzKHBvbGljaWVzKSkge1xuICAgIGNvbnN0IHN0YXRlbWVudHMgPSAocG9saWN5IGFzIGFueSkuUHJvcGVydGllcz8uUG9saWN5RG9jdW1lbnQ/LlN0YXRlbWVudCB8fCBbXTtcbiAgICBmb3IgKGNvbnN0IHN0bXQgb2Ygc3RhdGVtZW50cykge1xuICAgICAgY29uc3QgcmVzb3VyY2VzID0gQXJyYXkuaXNBcnJheShzdG10LlJlc291cmNlKSA/IHN0bXQuUmVzb3VyY2UgOiBbc3RtdC5SZXNvdXJjZV07XG4gICAgICBmb3IgKGNvbnN0IHIgb2YgcmVzb3VyY2VzKSB7XG4gICAgICAgIGlmICh0eXBlb2YgciA9PT0gJ3N0cmluZycgJiYgci5pbmNsdWRlcygnOmFjY2Vzc3BvaW50LycpKSB7XG4gICAgICAgICAgLy8gTXVzdCBub3QgY29udGFpbiB0aGUgTVJBUCBuYW1lIOKAlCBtdXN0IHVzZSBhbGlhcyBvciB3aWxkY2FyZFxuICAgICAgICAgIGV4cGVjdChyKS5ub3QudG9Db250YWluKGA6YWNjZXNzcG9pbnQvJHttcmFwTmFtZX1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxufSk7XG5cbnRlc3QoJ05vIExhbWJkYSBpbiBhbnkgc3RhY2sgdXNlcyBNUkFQX05BTUUgZW52IHZhcicsICgpID0+IHtcbiAgY29uc3QgYWxsVGVtcGxhdGVzID0gW1xuICAgIFRlbXBsYXRlLmZyb21TdGFjayhidWNrZXRQcmltYXJ5KSxcbiAgICBUZW1wbGF0ZS5mcm9tU3RhY2soZ2xvYmFsUm91dGluZyksXG4gICAgVGVtcGxhdGUuZnJvbVN0YWNrKHJvdXRpbmdQcmltYXJ5KSxcbiAgICBUZW1wbGF0ZS5mcm9tU3RhY2soZmFpbG92ZXIpLFxuICBdO1xuICBmb3IgKGNvbnN0IHQgb2YgYWxsVGVtcGxhdGVzKSB7XG4gICAgY29uc3QgZm5zID0gdC5maW5kUmVzb3VyY2VzKCdBV1M6OkxhbWJkYTo6RnVuY3Rpb24nKTtcbiAgICBmb3IgKGNvbnN0IFtuYW1lLCBmbl0gb2YgT2JqZWN0LmVudHJpZXMoZm5zKSkge1xuICAgICAgY29uc3QgdmFycyA9IChmbiBhcyBhbnkpLlByb3BlcnRpZXM/LkVudmlyb25tZW50Py5WYXJpYWJsZXMgfHwge307XG4gICAgICBleHBlY3QodmFycykubm90LnRvSGF2ZVByb3BlcnR5KCdNUkFQX05BTUUnKTtcbiAgICB9XG4gIH1cbn0pO1xuIl19