#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
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

const project = ctx('project', 'aurora-dsql');
const primaryRegion = ctx('primaryRegion', 'us-east-1');
const secondaryRegion = ctx('secondaryRegion', 'us-west-2');
const accountId = ctx('accountId', process.env.CDK_DEFAULT_ACCOUNT || '000000000000');
const targetStack = ctx('stack', 'all');
const globalClusterId = `${project}-global-cluster`;
const domainName = 'demo.internal';
const primaryCidr = '10.0.0.0/23';
const secondaryCidr = '10.0.2.0/23';

function ctx(key: string, fallback = 'PLACEHOLDER') {
  return app.node.tryGetContext(key) || process.env[key.replace(/([A-Z])/g, '_$1').toUpperCase()] || fallback;
}

function suppress(stack: cdk.Stack, extra: { id: string; reason: string }[] = []) {
  NagSuppressions.addStackSuppressions(stack, [...globalSuppressions, ...extra], true);
}

function env(region: string) { return { account: accountId, region }; }

// Helper: import VPC from lookup (for stacks that need VPC object from a prior deploy)
function importVpc(stack: cdk.Stack, vpcId: string, region: string) {
  return ec2.Vpc.fromLookup(stack, 'ImportedVpc', { vpcId, region });
}

function importSg(stack: cdk.Stack, id: string, sgId: string) {
  return ec2.SecurityGroup.fromSecurityGroupId(stack, id, sgId);
}

// ─── Bootstrap ───
if (targetStack === 'bootstrap') {
  suppress(new BootstrapStack(app, `${project}-bootstrap`, {
    project, primaryRegion, secondaryRegion, env: env(primaryRegion),
  }));
}

// ─── VPC ───
if (targetStack === 'vpc-primary') {
  suppress(new VpcStack(app, `${project}-vpc-primary`, {
    project, cidr: primaryCidr, peerCidr: secondaryCidr, env: env(primaryRegion),
  }));
}
if (targetStack === 'vpc-secondary') {
  suppress(new VpcStack(app, `${project}-vpc-secondary`, {
    project, cidr: secondaryCidr, peerCidr: primaryCidr, env: env(secondaryRegion),
  }));
}

// ─── VPC Peering ───
if (targetStack === 'vpc-peering') {
  suppress(new VpcPeeringStack(app, `${project}-vpc-peering`, {
    project,
    primaryVpcId: ctx('primaryVpcId'), secondaryVpcId: ctx('secondaryVpcId'),
    primaryRegion, secondaryRegion, primaryCidr, secondaryCidr,
    env: env(primaryRegion),
  }));
}

// ─── Database ───
if (targetStack === 'db-primary') {
  const s = new DatabaseStack(app, `${project}-db-primary`, {
    project,
    vpc: importVpc(new cdk.Stack(app, 'DbPVpcLookup', { env: env(primaryRegion) }), ctx('primaryVpcId'), primaryRegion),
    databaseSg: importSg(new cdk.Stack(app, 'DbPSgLookup', { env: env(primaryRegion) }), 'DbSg', ctx('primaryDbSgId')),
    globalClusterIdentifier: globalClusterId,
    env: env(primaryRegion),
  });
  suppress(s);
}
if (targetStack === 'db-secondary') {
  const s = new DatabaseReplicaStack(app, `${project}-db-secondary`, {
    project,
    vpc: importVpc(new cdk.Stack(app, 'DbSVpcLookup', { env: env(secondaryRegion) }), ctx('secondaryVpcId'), secondaryRegion),
    databaseSg: importSg(new cdk.Stack(app, 'DbSSgLookup', { env: env(secondaryRegion) }), 'DbSg', ctx('secondaryDbSgId')),
    globalClusterIdentifier: globalClusterId,
    env: env(secondaryRegion),
  });
  suppress(s);
}

// ─── DSQL ───
if (targetStack === 'dsql-primary') {
  suppress(new DsqlStack(app, `${project}-dsql-primary`, {
    project, peerClusterArns: ctx('dsqlPeerArns', '').split(',').filter(Boolean),
    env: env(primaryRegion),
  }));
}
if (targetStack === 'dsql-secondary') {
  suppress(new DsqlStack(app, `${project}-dsql-secondary`, {
    project, peerClusterArns: ctx('dsqlPeerArns', '').split(',').filter(Boolean),
    env: env(secondaryRegion),
  }));
}

// ─── Schema ───
if (targetStack === 'schema') {
  const s = new SchemaStack(app, `${project}-schema`, {
    project,
    vpc: importVpc(new cdk.Stack(app, 'SchemaVpcLookup', { env: env(primaryRegion) }), ctx('primaryVpcId'), primaryRegion),
    lambdaSg: importSg(new cdk.Stack(app, 'SchemaSgLookup', { env: env(primaryRegion) }), 'LambdaSg', ctx('primaryLambdaSgId')),
    secretArn: ctx('secretArn'), encryptionKeyArn: ctx('encryptionKeyArn'),
    env: env(primaryRegion),
  });
  suppress(s);
}

// ─── Aurora App ───
for (const [suffix, region, vpcCtx, lambdaSgCtx, albSgCtx] of [
  ['primary', primaryRegion, 'primaryVpcId', 'primaryLambdaSgId', 'primaryAlbSgId'],
  ['secondary', secondaryRegion, 'secondaryVpcId', 'secondaryLambdaSgId', 'secondaryAlbSgId'],
] as const) {
  if (targetStack === `aurora-app-${suffix}`) {
    const s = new AuroraAppStack(app, `${project}-aurora-app-${suffix}`, {
      project,
      vpc: importVpc(new cdk.Stack(app, `AApp${suffix}VpcLookup`, { env: env(region) }), ctx(vpcCtx), region),
      lambdaSg: importSg(new cdk.Stack(app, `AApp${suffix}LSgLookup`, { env: env(region) }), 'LSg', ctx(lambdaSgCtx)),
      albSg: importSg(new cdk.Stack(app, `AApp${suffix}ASgLookup`, { env: env(region) }), 'ASg', ctx(albSgCtx)),
      secretArn: ctx('secretArn'), encryptionKeyArn: ctx('encryptionKeyArn'),
      env: env(region),
    });
    suppress(s);
  }
}

// ─── DSQL App ───
for (const [suffix, region, vpcCtx, lambdaSgCtx, albSgCtx] of [
  ['primary', primaryRegion, 'primaryVpcId', 'primaryLambdaSgId', 'primaryAlbSgId'],
  ['secondary', secondaryRegion, 'secondaryVpcId', 'secondaryLambdaSgId', 'secondaryAlbSgId'],
] as const) {
  if (targetStack === `dsql-app-${suffix}`) {
    const s = new DsqlAppStack(app, `${project}-dsql-app-${suffix}`, {
      project,
      vpc: importVpc(new cdk.Stack(app, `DApp${suffix}VpcLookup`, { env: env(region) }), ctx(vpcCtx), region),
      lambdaSg: importSg(new cdk.Stack(app, `DApp${suffix}LSgLookup`, { env: env(region) }), 'LSg', ctx(lambdaSgCtx)),
      albSg: importSg(new cdk.Stack(app, `DApp${suffix}ASgLookup`, { env: env(region) }), 'ASg', ctx(albSgCtx)),
      dsqlEndpoint: ctx('dsqlEndpoint'),
      env: env(region),
    });
    suppress(s);
  }
}

// ─── DNS ───
if (targetStack === 'dns') {
  suppress(new DnsStack(app, `${project}-dns`, {
    project, domainName,
    primaryVpcId: ctx('primaryVpcId'), secondaryVpcId: ctx('secondaryVpcId'),
    primaryRegion, secondaryRegion,
    primaryAuroraAlbDns: ctx('primaryAuroraAlbDns'), primaryAuroraAlbHostedZoneId: ctx('primaryAuroraAlbHostedZoneId'),
    secondaryAuroraAlbDns: ctx('secondaryAuroraAlbDns'), secondaryAuroraAlbHostedZoneId: ctx('secondaryAuroraAlbHostedZoneId'),
    primaryDsqlAlbDns: ctx('primaryDsqlAlbDns'), primaryDsqlAlbHostedZoneId: ctx('primaryDsqlAlbHostedZoneId'),
    secondaryDsqlAlbDns: ctx('secondaryDsqlAlbDns'), secondaryDsqlAlbHostedZoneId: ctx('secondaryDsqlAlbHostedZoneId'),
    primaryHealthCheckId: ctx('primaryHealthCheckId', ''),
    secondaryHealthCheckId: ctx('secondaryHealthCheckId', ''),
    env: env(primaryRegion),
  }));
}

// ─── Failover Plan ───
if (targetStack === 'failover-plan') {
  suppress(new FailoverPlanStack(app, `${project}-failover-plan`, {
    project, primaryRegion, secondaryRegion,
    globalClusterIdentifier: globalClusterId,
    primaryClusterArn: ctx('primaryClusterArn'), secondaryClusterArn: ctx('secondaryClusterArn'),
    hostedZoneId: ctx('hostedZoneId'),
    auroraRecordName: `aurora-app.${domainName}`, dsqlRecordName: `dsql-app.${domainName}`,
    env: env(primaryRegion),
  }));
}

// ─── Synthetics ───
for (const [suffix, region, vpcCtx, sgCtx] of [
  ['primary', primaryRegion, 'primaryVpcId', 'syntheticsSgId'],
  ['secondary', secondaryRegion, 'secondaryVpcId', 'syntheticsSgId'],
] as const) {
  if (targetStack === `synthetics-${suffix}`) {
    const s = new SyntheticsStack(app, `${project}-synthetics-${suffix}`, {
      project,
      vpc: importVpc(new cdk.Stack(app, `Synth${suffix}VpcLookup`, { env: env(region) }), ctx(vpcCtx), region),
      syntheticsSg: importSg(new cdk.Stack(app, `Synth${suffix}SgLookup`, { env: env(region) }), 'SynthSg', ctx(sgCtx)),
      localAuroraAlbDns: ctx('localAuroraAlbDns'), localDsqlAlbDns: ctx('localDsqlAlbDns'),
      crossRegionAuroraUrl: ctx('crossRegionAuroraUrl', `aurora-app.${domainName}`),
      crossRegionDsqlUrl: ctx('crossRegionDsqlUrl', `dsql-app.${domainName}`),
      env: env(region),
    });
    suppress(s);
  }
}

// ─── Monitoring ───
for (const [suffix, region, vpcCtx, lambdaSgCtx] of [
  ['primary', primaryRegion, 'primaryVpcId', 'primaryLambdaSgId'],
  ['secondary', secondaryRegion, 'secondaryVpcId', 'secondaryLambdaSgId'],
] as const) {
  if (targetStack === `monitoring-${suffix}`) {
    const s = new MonitoringStack(app, `${project}-monitoring-${suffix}`, {
      project, primaryRegion, secondaryRegion,
      dbClusterIdentifier: ctx('dbClusterIdentifier'),
      vpc: importVpc(new cdk.Stack(app, `Mon${suffix}VpcLookup`, { env: env(region) }), ctx(vpcCtx), region),
      lambdaSg: importSg(new cdk.Stack(app, `Mon${suffix}SgLookup`, { env: env(region) }), 'LSg', ctx(lambdaSgCtx)),
      secretArn: ctx('secretArn'), encryptionKeyArn: ctx('encryptionKeyArn'),
      remoteSecretArn: ctx('remoteSecretArn'), remoteEncryptionKeyArn: ctx('remoteEncryptionKeyArn'),
      env: env(region),
    });
    suppress(s);
  }
}

// ─── Reconciliation ───
for (const [suffix, region, vpcCtx, lambdaSgCtx] of [
  ['primary', primaryRegion, 'primaryVpcId', 'primaryLambdaSgId'],
  ['secondary', secondaryRegion, 'secondaryVpcId', 'secondaryLambdaSgId'],
] as const) {
  if (targetStack === `reconciliation-${suffix}`) {
    const s = new ReconciliationStack(app, `${project}-reconciliation-${suffix}`, {
      project,
      vpc: importVpc(new cdk.Stack(app, `Recon${suffix}VpcLookup`, { env: env(region) }), ctx(vpcCtx), region),
      lambdaSg: importSg(new cdk.Stack(app, `Recon${suffix}SgLookup`, { env: env(region) }), 'LSg', ctx(lambdaSgCtx)),
      secretArn: ctx('secretArn'), encryptionKeyArn: ctx('encryptionKeyArn'),
      globalClusterIdentifier: globalClusterId, primaryRegion, secondaryRegion,
      env: env(region),
    });
    suppress(s);
  }
}

// ─── Load Gen ───
if (targetStack === 'loadgen') {
  const s = new LoadGenStack(app, `${project}-loadgen`, {
    project,
    vpc: importVpc(new cdk.Stack(app, 'LoadGenVpcLookup', { env: env(primaryRegion) }), ctx('primaryVpcId'), primaryRegion),
    lambdaSg: importSg(new cdk.Stack(app, 'LoadGenSgLookup', { env: env(primaryRegion) }), 'LSg', ctx('primaryLambdaSgId')),
    auroraAlbDns: ctx('auroraAlbDns'), dsqlAlbDns: ctx('dsqlAlbDns'),
    env: env(primaryRegion),
  });
  suppress(s);
}

// ─── Chaos ───
for (const [suffix, region, targetRegion] of [
  ['primary', primaryRegion, secondaryRegion],
  ['secondary', secondaryRegion, primaryRegion],
] as const) {
  if (targetStack === `chaos-${suffix}`) {
    suppress(new ChaosStack(app, `${project}-chaos-${suffix}`, {
      project, targetRegion,
      env: env(region),
    }));
  }
}

app.synth();
