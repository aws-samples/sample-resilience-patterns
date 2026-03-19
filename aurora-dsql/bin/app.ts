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
import { VpcImportProps } from '../lib/imports';

const app = new cdk.App();

if (app.node.tryGetContext('nag') === 'true') {
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
}

const globalSuppressions = [
  { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is standard for Lambda functions' },
  { id: 'AwsSolutions-IAM5', reason: 'Wildcard permissions for CDK framework, FIS, cross-region ops' },
  { id: 'AwsSolutions-L1', reason: 'Python 3.12 stable. CDK Provider runtimes not configurable.' },
  { id: 'AwsSolutions-RDS10', reason: 'Deletion protection disabled for demo.' },
  { id: 'AwsSolutions-RDS11', reason: 'Default ports for demo.' },
  { id: 'AwsSolutions-SMG4', reason: 'Non-credential secrets need no rotation.' },
];

function c(key: string, fallback = 'PLACEHOLDER') { return app.node.tryGetContext(key) || fallback; }
function suppress(s: cdk.Stack) { NagSuppressions.addStackSuppressions(s, globalSuppressions, true); }

const project = c('project', 'aurora-dsql');
const primaryRegion = c('primaryRegion', 'us-east-1');
const secondaryRegion = c('secondaryRegion', 'us-west-2');
const accountId = c('accountId', process.env.CDK_DEFAULT_ACCOUNT || '000000000000');
const target = c('stack', 'none');
const globalClusterId = `${project}-global-cluster`;
const domain = 'demo.internal';

function env(region: string) { return { account: accountId, region }; }

/** VPC import props from CDK context — no API calls at synth time. */
function vpcImport(): VpcImportProps {
  return { vpcId: c('vpcId'), subnetIds: c('subnetIds'), azs: c('azs') };
}

// ─── Bootstrap ───
if (target === 'bootstrap') {
  suppress(new BootstrapStack(app, `${project}-bootstrap`, { project, primaryRegion, secondaryRegion, env: env(primaryRegion) }));
}

// ─── VPC ───
if (target === 'vpc-primary') suppress(new VpcStack(app, `${project}-vpc-primary`, { project, cidr: '10.0.0.0/23', peerCidr: '10.0.2.0/23', env: env(primaryRegion) }));
if (target === 'vpc-secondary') suppress(new VpcStack(app, `${project}-vpc-secondary`, { project, cidr: '10.0.2.0/23', peerCidr: '10.0.0.0/23', env: env(secondaryRegion) }));

// ─── VPC Peering ───
if (target === 'vpc-peering') {
  suppress(new VpcPeeringStack(app, `${project}-vpc-peering`, {
    project, primaryVpcId: c('primaryVpcId'), secondaryVpcId: c('secondaryVpcId'),
    primaryRegion, secondaryRegion, primaryCidr: '10.0.0.0/23', secondaryCidr: '10.0.2.0/23', env: env(primaryRegion),
  }));
}

// ─── Database ───
if (target === 'db-primary') {
  suppress(new DatabaseStack(app, `${project}-db-primary`, {
    project, vpcImport: vpcImport(), databaseSgId: c('dbSgId'), globalClusterIdentifier: globalClusterId, env: env(primaryRegion),
  }));
}

app.synth();
