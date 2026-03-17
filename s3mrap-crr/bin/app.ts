#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { BootstrapStack } from '../lib/bootstrap-stack';
import { RegionalBucketStack } from '../lib/regional-bucket-stack';
import { GlobalRoutingStack } from '../lib/global-routing-stack';
import { RoutingLambdaStack } from '../lib/routing-lambda-stack';
import { FailoverStack } from '../lib/failover-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import { KmsStack, KmsReplicaStack } from '../lib/kms-stack';

const app = new cdk.App();

// Enable cdk-nag with: -c nag=true
if (app.node.tryGetContext('nag') === 'true') {
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
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

function addSuppressions(stack: cdk.Stack, extra: { id: string; reason: string }[] = []) {
  NagSuppressions.addStackSuppressions(stack, [...globalSuppressions, ...extra], true);
}

if (targetStack === 'bootstrap' || targetStack === 'all') {
  const s = new BootstrapStack(app, `${project}-bootstrap`, {
    project, primaryRegion, secondaryRegion,
    encryptionKeyArn: encryptionKeyArnPrimary,
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
  addSuppressions(new KmsStack(app, `${project}-kms`, {
    project,
    env: { account: accountId, region: primaryRegion },
  }));
}

if (targetStack === 'kms-replica' || targetStack === 'all') {
  addSuppressions(new KmsReplicaStack(app, `${project}-kms-replica`, {
    project, accountId,
    primaryKeyArn: encryptionKeyArnPrimary,
    env: { account: accountId, region: secondaryRegion },
  }));
}

if (targetStack === 'bucket-primary' || targetStack === 'all') {
  addSuppressions(new RegionalBucketStack(app, `${project}-bucket-primary`, {
    project,
    encryptionKeyArn: encryptionKeyArnPrimary,
    env: { account: accountId, region: primaryRegion },
  }));
}

if (targetStack === 'bucket-secondary' || targetStack === 'all') {
  addSuppressions(new RegionalBucketStack(app, `${project}-bucket-secondary`, {
    project,
    encryptionKeyArn: encryptionKeyArnSecondary,
    env: { account: accountId, region: secondaryRegion },
  }));
}

if (targetStack === 'global-routing' || targetStack === 'all') {
  addSuppressions(new GlobalRoutingStack(app, `${project}-global-routing`, {
    project, primaryBucketName, secondaryBucketName,
    primaryRegion, secondaryRegion, accountId,
    encryptionKeyId,
    env: { account: accountId, region: primaryRegion },
  }));
}

if (targetStack === 'routing-primary' || targetStack === 'all') {
  addSuppressions(new RoutingLambdaStack(app, `${project}-routing-primary`, {
    ...routingLambdaProps,
    env: { account: accountId, region: primaryRegion },
  }));
}

if (targetStack === 'routing-secondary' || targetStack === 'all') {
  addSuppressions(new RoutingLambdaStack(app, `${project}-routing-secondary`, {
    ...routingLambdaProps,
    env: { account: accountId, region: secondaryRegion },
  }));
}

if (targetStack === 'failover' || targetStack === 'all') {
  addSuppressions(new FailoverStack(app, `${project}-failover`, {
    project, primaryBucketName, secondaryBucketName,
    primaryRegion, secondaryRegion, accountId, mrapName,
    primaryRoutingLambdaArn, secondaryRoutingLambdaArn,
    env: { account: accountId, region: primaryRegion },
  }));
}

if (targetStack === 'monitoring-primary' || targetStack === 'all') {
  addSuppressions(new MonitoringStack(app, `${project}-monitoring-primary`, {
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
  addSuppressions(new MonitoringStack(app, `${project}-monitoring-secondary`, {
    project,
    sourceBucketName: primaryBucketName, destBucketName: secondaryBucketName,
    replicationRuleId: 'to-secondary', sourceRegionLabel: 'iad', destRegionLabel: 'pdx',
    reverseRuleId: 'to-primary', reverseSourceBucketName: secondaryBucketName, reverseDestBucketName: primaryBucketName,
    primaryRegion, secondaryRegion, accountId, mrapAlias,
    encryptionKeyArn: encryptionKeyArnSecondary,
    env: { account: accountId, region: secondaryRegion },
  }));
}
