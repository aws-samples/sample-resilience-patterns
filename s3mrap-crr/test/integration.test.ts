import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { RegionalBucketStack } from '../lib/regional-bucket-stack';
import { GlobalRoutingStack } from '../lib/global-routing-stack';
import { RoutingLambdaStack } from '../lib/routing-lambda-stack';
import { FailoverStack } from '../lib/failover-stack';
import { MonitoringStack } from '../lib/monitoring-stack';

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

const bucketPrimary = new RegionalBucketStack(app, 'IntBucketPrimary', {
  project, env: { account: accountId, region: primaryRegion },
});

const bucketSecondary = new RegionalBucketStack(app, 'IntBucketSecondary', {
  project, env: { account: accountId, region: secondaryRegion },
});

const globalRouting = new GlobalRoutingStack(app, 'IntGlobalRouting', {
  project, primaryBucketName, secondaryBucketName,
  primaryRegion, secondaryRegion, accountId,
  env: { account: accountId, region: primaryRegion },
});

const routingPrimary = new RoutingLambdaStack(app, 'IntRoutingPrimary', {
  project, primaryBucketName, secondaryBucketName,
  primaryRegion, secondaryRegion, accountId, mrapName, mrapAlias: 'test-alias.mrap',
  env: { account: accountId, region: primaryRegion },
});

const failover = new FailoverStack(app, 'IntFailover', {
  project, primaryBucketName, secondaryBucketName,
  primaryRegion, secondaryRegion, accountId, mrapName,
  primaryRoutingLambdaArn: `arn:aws:lambda:${primaryRegion}:${accountId}:function:${routingFnName}`,
  secondaryRoutingLambdaArn: `arn:aws:lambda:${secondaryRegion}:${accountId}:function:${routingFnName}`,
  env: { account: accountId, region: primaryRegion },
});

const tBucketPrimary = Template.fromStack(bucketPrimary);
const tBucketSecondary = Template.fromStack(bucketSecondary);
const tGlobalRouting = Template.fromStack(globalRouting);
const tRoutingPrimary = Template.fromStack(routingPrimary);
const tFailover = Template.fromStack(failover);

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
  const lambdas = (plan as any).Properties.Workflows[0].Steps[0]
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
  const tMonitoring = Template.fromStack(
    new MonitoringStack(app2, 'IntMonitoringCheck', {
      project, sourceBucketName: secondaryBucketName, destBucketName: primaryBucketName,
      replicationRuleId: 'to-primary', sourceRegionLabel: 'pdx', destRegionLabel: 'iad',
      reverseRuleId: 'to-secondary', reverseSourceBucketName: primaryBucketName, reverseDestBucketName: secondaryBucketName,
      primaryRegion, secondaryRegion, accountId, mrapAlias: 'test.mrap',
      env: { account: accountId, region: primaryRegion },
    })
  );
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
  const tRouting = Template.fromStack(routingPrimary);
  const fns = tRouting.findResources('AWS::Lambda::Function');
  for (const [, fn] of Object.entries(fns)) {
    const vars = (fn as any).Properties?.Environment?.Variables || {};
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
  const tMon = Template.fromStack(
    new MonitoringStack(app3, 'IntMonitorArnCheck', {
      project, sourceBucketName: secondaryBucketName, destBucketName: primaryBucketName,
      replicationRuleId: 'to-primary', sourceRegionLabel: 'pdx', destRegionLabel: 'iad',
      reverseRuleId: 'to-secondary', reverseSourceBucketName: primaryBucketName, reverseDestBucketName: secondaryBucketName,
      primaryRegion, secondaryRegion, accountId, mrapAlias: 'test.mrap',
      env: { account: accountId, region: primaryRegion },
    })
  );
  const fns = tMon.findResources('AWS::Lambda::Function');
  for (const [, fn] of Object.entries(fns)) {
    const vars = (fn as any).Properties?.Environment?.Variables || {};
    expect(vars).not.toHaveProperty('MRAP_NAME');
    if (vars.MRAP_ALIAS) {
      expect(vars.MRAP_ALIAS).not.toBe(mrapName);
    }
  }
});

test('Routing Lambda IAM policy resource matches the MRAP alias ARN (not name)', () => {
  const tRouting = Template.fromStack(routingPrimary);
  const policies = tRouting.findResources('AWS::IAM::Policy');
  for (const [, policy] of Object.entries(policies)) {
    const statements = (policy as any).Properties?.PolicyDocument?.Statement || [];
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
    Template.fromStack(bucketPrimary),
    Template.fromStack(globalRouting),
    Template.fromStack(routingPrimary),
    Template.fromStack(failover),
  ];
  for (const t of allTemplates) {
    const fns = t.findResources('AWS::Lambda::Function');
    for (const [name, fn] of Object.entries(fns)) {
      const vars = (fn as any).Properties?.Environment?.Variables || {};
      expect(vars).not.toHaveProperty('MRAP_NAME');
    }
  }
});
