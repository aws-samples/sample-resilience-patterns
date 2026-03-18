#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { BootstrapStack } from '../lib/bootstrap-stack';
import { VpcStack } from '../lib/vpc-stack';
import { VpcPeeringStack } from '../lib/vpc-peering-stack';
import { DatabaseStack } from '../lib/database-stack';
import { DatabaseReplicaStack } from '../lib/database-replica-stack';
import { DsqlStack } from '../lib/dsql-stack';
import { SchemaStack } from '../lib/schema-stack';
import { AuroraAppStack } from '../lib/aurora-app-stack';
import { DsqlAppStack } from '../lib/dsql-app-stack';
import { DnsStack } from '../lib/dns-stack';
import { FailoverPlanStack } from '../lib/failover-plan-stack';
import { SyntheticsStack } from '../lib/synthetics-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import { ReconciliationStack } from '../lib/reconciliation-stack';
import { LoadGenStack } from '../lib/loadgen-stack';
import { ChaosStack } from '../lib/chaos-stack';

const app = new cdk.App();

if (app.node.tryGetContext('nag') === 'true') {
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
}

const globalSuppressions = [
  { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is standard for Lambda functions' },
  { id: 'AwsSolutions-IAM5', reason: 'Wildcard permissions required for CDK framework constructs, FIS experiments, and cross-region operations' },
  { id: 'AwsSolutions-L1', reason: 'Python 3.13 is current. CDK Provider framework Lambda runtimes are not user-configurable.' },
  { id: 'AwsSolutions-RDS10', reason: 'Deletion protection disabled for demo teardown. Enable in production.' },
  { id: 'AwsSolutions-RDS11', reason: 'Default ports used for demo simplicity.' },
  { id: 'AwsSolutions-SMG4', reason: 'Non-credential secrets (ARNs, endpoints) do not require rotation.' },
];

const project = app.node.tryGetContext('project') || process.env.PROJECT || 'aurora-dsql';
const primaryRegion = app.node.tryGetContext('primaryRegion') || process.env.PRIMARY_REGION || 'us-east-1';
const secondaryRegion = app.node.tryGetContext('secondaryRegion') || process.env.SECONDARY_REGION || 'us-west-2';
const accountId = app.node.tryGetContext('accountId') || process.env.ACCOUNT_ID || process.env.CDK_DEFAULT_ACCOUNT || '000000000000';
const targetStack = app.node.tryGetContext('stack') || process.env.STACK || 'all';

const primaryCidr = '10.0.0.0/23';
const secondaryCidr = '10.0.2.0/23';
const globalClusterId = `${project}-global-cluster`;
const domainName = 'demo.internal';

function addSuppressions(stack: cdk.Stack, extra: { id: string; reason: string }[] = []) {
  NagSuppressions.addStackSuppressions(stack, [...globalSuppressions, ...extra], true);
}

function env(region: string) {
  return { account: accountId, region };
}

// Context values captured from prior stack deploys (passed via Makefile -c flags)
const ctx = (key: string, fallback = 'PLACEHOLDER') => app.node.tryGetContext(key) || fallback;

// Bootstrap
if (targetStack === 'bootstrap' || targetStack === 'all') {
  addSuppressions(new BootstrapStack(app, `${project}-bootstrap`, {
    project, primaryRegion, secondaryRegion, env: env(primaryRegion),
  }));
}

// VPC
if (targetStack === 'vpc-primary' || targetStack === 'all') {
  addSuppressions(new VpcStack(app, `${project}-vpc-primary`, {
    project, cidr: primaryCidr, peerCidr: secondaryCidr, env: env(primaryRegion),
  }));
}
if (targetStack === 'vpc-secondary' || targetStack === 'all') {
  addSuppressions(new VpcStack(app, `${project}-vpc-secondary`, {
    project, cidr: secondaryCidr, peerCidr: primaryCidr, env: env(secondaryRegion),
  }));
}

// VPC Peering
if (targetStack === 'vpc-peering' || targetStack === 'all') {
  addSuppressions(new VpcPeeringStack(app, `${project}-vpc-peering`, {
    project,
    primaryVpcId: ctx('primaryVpcId'),
    secondaryVpcId: ctx('secondaryVpcId'),
    primaryRegion, secondaryRegion, primaryCidr, secondaryCidr,
    env: env(primaryRegion),
  }));
}

// Database
if (targetStack === 'db-primary' || targetStack === 'all') {
  addSuppressions(new DatabaseStack(app, `${project}-db-primary`, {
    project,
    vpc: cdk.aws_ec2.Vpc.fromLookup(new cdk.Stack(app, 'DbPrimaryVpcLookup', { env: env(primaryRegion) }), 'Vpc', { vpcId: ctx('primaryVpcId'), region: primaryRegion }),
    databaseSg: cdk.aws_ec2.SecurityGroup.fromSecurityGroupId(new cdk.Stack(app, 'DbPrimarySgLookup', { env: env(primaryRegion) }), 'DbSg', ctx('primaryDbSgId')),
    globalClusterIdentifier: globalClusterId,
    env: env(primaryRegion),
  }));
}

if (targetStack === 'db-secondary' || targetStack === 'all') {
  addSuppressions(new DatabaseReplicaStack(app, `${project}-db-secondary`, {
    project,
    vpc: cdk.aws_ec2.Vpc.fromLookup(new cdk.Stack(app, 'DbSecondaryVpcLookup', { env: env(secondaryRegion) }), 'Vpc', { vpcId: ctx('secondaryVpcId'), region: secondaryRegion }),
    databaseSg: cdk.aws_ec2.SecurityGroup.fromSecurityGroupId(new cdk.Stack(app, 'DbSecondarySgLookup', { env: env(secondaryRegion) }), 'DbSg', ctx('secondaryDbSgId')),
    globalClusterIdentifier: globalClusterId,
    env: env(secondaryRegion),
  }));
}

// DSQL
if (targetStack === 'dsql-primary' || targetStack === 'all') {
  addSuppressions(new DsqlStack(app, `${project}-dsql-primary`, {
    project, peerClusterArns: ctx('dsqlPeerArns', '').split(',').filter(Boolean),
    env: env(primaryRegion),
  }));
}
if (targetStack === 'dsql-secondary' || targetStack === 'all') {
  addSuppressions(new DsqlStack(app, `${project}-dsql-secondary`, {
    project, peerClusterArns: ctx('dsqlPeerArns', '').split(',').filter(Boolean),
    env: env(secondaryRegion),
  }));
}

// Schema, App, DNS, Failover, Synthetics, Monitoring, Reconciliation, LoadGen, Chaos
// These stacks require runtime values from prior deploys — instantiated only when targeted via Makefile

app.synth();
