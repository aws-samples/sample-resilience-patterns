#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { BootstrapStack } from '../lib/bootstrap-stack';
import { VpcStack } from '../lib/vpc-stack';
import { VpcPeeringStack } from '../lib/vpc-peering-stack';
const app = new cdk.App();

if (app.node.tryGetContext('nag') === 'true') {
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
}

const globalSuppressions = [
  { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is standard for Lambda functions' },
  { id: 'AwsSolutions-IAM5', reason: 'Wildcard permissions required for CDK framework constructs and cross-region operations' },
  { id: 'AwsSolutions-L1', reason: 'Python 3.13 is current. CDK Provider framework Lambda runtimes are not user-configurable.' },
];

const project = app.node.tryGetContext('project') || process.env.PROJECT || 'aurora-dsql';
const primaryRegion = app.node.tryGetContext('primaryRegion') || process.env.PRIMARY_REGION || 'us-east-1';
const secondaryRegion = app.node.tryGetContext('secondaryRegion') || process.env.SECONDARY_REGION || 'us-west-2';
const accountId = app.node.tryGetContext('accountId') || process.env.ACCOUNT_ID || process.env.CDK_DEFAULT_ACCOUNT || '000000000000';

const targetStack = app.node.tryGetContext('stack') || process.env.STACK || 'all';

const primaryCidr = '10.0.0.0/23';
const secondaryCidr = '10.0.2.0/23';

function addSuppressions(stack: cdk.Stack, extra: { id: string; reason: string }[] = []) {
  NagSuppressions.addStackSuppressions(stack, [...globalSuppressions, ...extra], true);
}

// Phase 2: Bootstrap (deployed locally, triggers CodeBuild for everything else)
if (targetStack === 'bootstrap' || targetStack === 'all') {
  const s = new BootstrapStack(app, `${project}-bootstrap`, {
    project, primaryRegion, secondaryRegion,
    env: { account: accountId, region: primaryRegion },
  });
  addSuppressions(s);
}

// Phase 3: VPC (per region)
if (targetStack === 'vpc-primary' || targetStack === 'all') {
  const s = new VpcStack(app, `${project}-vpc-primary`, {
    project, cidr: primaryCidr, peerCidr: secondaryCidr,
    env: { account: accountId, region: primaryRegion },
  });
  addSuppressions(s);
}

if (targetStack === 'vpc-secondary' || targetStack === 'all') {
  const s = new VpcStack(app, `${project}-vpc-secondary`, {
    project, cidr: secondaryCidr, peerCidr: primaryCidr,
    env: { account: accountId, region: secondaryRegion },
  });
  addSuppressions(s);
}

// Phase 3a: VPC Peering
if (targetStack === 'vpc-peering' || targetStack === 'all') {
  const primaryVpcId = app.node.tryGetContext('primaryVpcId') || 'PLACEHOLDER';
  const secondaryVpcId = app.node.tryGetContext('secondaryVpcId') || 'PLACEHOLDER';

  const s = new VpcPeeringStack(app, `${project}-vpc-peering`, {
    project,
    primaryVpcId,
    secondaryVpcId,
    primaryRegion,
    secondaryRegion,
    primaryCidr,
    secondaryCidr,
    env: { account: accountId, region: primaryRegion },
  });
  addSuppressions(s);
}

// Placeholder for remaining stacks — will be added as phases are implemented

app.synth();
