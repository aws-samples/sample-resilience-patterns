#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BootstrapStack } from '../lib/bootstrap-stack';
import { RegionalBucketStack } from '../lib/regional-bucket-stack';
import { GlobalRoutingStack } from '../lib/global-routing-stack';
import { RoutingLambdaStack } from '../lib/routing-lambda-stack';
import { FailoverStack } from '../lib/failover-stack';
import { MonitoringStack } from '../lib/monitoring-stack';

const app = new cdk.App();

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

if (targetStack === 'bootstrap' || targetStack === 'all') {
  new BootstrapStack(app, `${project}-bootstrap`, {
    project, primaryRegion, secondaryRegion,
    env: { account: accountId, region: primaryRegion },
  });
}

if (targetStack === 'bucket-primary' || targetStack === 'all') {
  new RegionalBucketStack(app, `${project}-bucket-primary`, {
    project,
    env: { account: accountId, region: primaryRegion },
  });
}

if (targetStack === 'bucket-secondary' || targetStack === 'all') {
  new RegionalBucketStack(app, `${project}-bucket-secondary`, {
    project,
    env: { account: accountId, region: secondaryRegion },
  });
}

if (targetStack === 'global-routing' || targetStack === 'all') {
  new GlobalRoutingStack(app, `${project}-global-routing`, {
    project, primaryBucketName, secondaryBucketName,
    primaryRegion, secondaryRegion, accountId,
    env: { account: accountId, region: primaryRegion },
  });
}

if (targetStack === 'routing-primary' || targetStack === 'all') {
  new RoutingLambdaStack(app, `${project}-routing-primary`, {
    ...routingLambdaProps,
    env: { account: accountId, region: primaryRegion },
  });
}

if (targetStack === 'routing-secondary' || targetStack === 'all') {
  new RoutingLambdaStack(app, `${project}-routing-secondary`, {
    ...routingLambdaProps,
    env: { account: accountId, region: secondaryRegion },
  });
}

if (targetStack === 'failover' || targetStack === 'all') {
  new FailoverStack(app, `${project}-failover`, {
    project, primaryBucketName, secondaryBucketName,
    primaryRegion, secondaryRegion, accountId, mrapName,
    primaryRoutingLambdaArn, secondaryRoutingLambdaArn,
    env: { account: accountId, region: primaryRegion },
  });
}

if (targetStack === 'monitoring-primary' || targetStack === 'all') {
  new MonitoringStack(app, `${project}-monitoring-primary`, {
    project,
    sourceBucketName: secondaryBucketName, destBucketName: primaryBucketName,
    replicationRuleId: 'to-primary', sourceRegionLabel: 'pdx', destRegionLabel: 'iad',
    reverseRuleId: 'to-secondary', reverseSourceBucketName: primaryBucketName, reverseDestBucketName: secondaryBucketName,
    primaryRegion, secondaryRegion, accountId, mrapAlias,
    env: { account: accountId, region: primaryRegion },
  });
}

if (targetStack === 'monitoring-secondary' || targetStack === 'all') {
  new MonitoringStack(app, `${project}-monitoring-secondary`, {
    project,
    sourceBucketName: primaryBucketName, destBucketName: secondaryBucketName,
    replicationRuleId: 'to-secondary', sourceRegionLabel: 'iad', destRegionLabel: 'pdx',
    reverseRuleId: 'to-primary', reverseSourceBucketName: secondaryBucketName, reverseDestBucketName: primaryBucketName,
    primaryRegion, secondaryRegion, accountId, mrapAlias,
    env: { account: accountId, region: secondaryRegion },
  });
}
