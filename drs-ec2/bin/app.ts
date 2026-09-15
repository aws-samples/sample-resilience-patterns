#!/usr/bin/env node
/**
 * drs-ec2 -- DRS-replicated EC2 + Aurora Global + ARC Region Switch, three regions.
 *
 * Wiring follows the repo idiom (see aurora/): the Makefile deploys stacks in dependency order and
 * feeds each stack's outputs to the next as `-c key=value` context, so synth makes no API calls.
 * `-c stack=<name>` selects which stack(s) to synthesize; `cdk synth --all` (CI build) synthesizes
 * everything with placeholder context.
 *
 * Stacks and the context each consumes (beyond project/regions/accountId):
 *   net-primary        [secondaryVpcId, observerCidr, observerPeeringId]   -- second/third pass adds routes
 *   net-secondary      [primaryVpcId, peeringConnectionId, observerCidr, observerPeeringId]
 *   iam                (none)
 *   db-primary         primaryVpcId, primaryPrivateSubnetIds
 *   db-secondary       secondaryVpcId, secondaryPrivateSubnetIds, globalClusterId, kmsKeyId
 *   app-primary        primaryVpcId, primaryPrivateSubnetIds, primaryWriterEndpoint, appInstanceRoleArn,
 *                      appCodeBucket [arcHealthCheckId, secondaryVpcId, observerVpcId, demoClientCidr]
 *   alb-secondary      secondaryVpcId, secondaryPrivateSubnetIds, hostedZoneId [arcHealthCheckId, demoClientCidr]
 *   drs-steps-primary / drs-steps-secondary
 *                      primaryTargetGroupArn, secondaryTargetGroupArn, appInstanceProfileArn, appInstanceRoleArn,
 *                      secondaryWriterEndpoint, primaryPrivateSubnetIds, primaryAppSgId, secondaryStagingSubnetId,
 *                      secondaryRecoveredAppSgId [statefulEc2]
 *   plan               globalClusterId, primaryClusterArn, secondaryClusterArn, hostedZoneId, recordName,
 *                      + the drs-steps context [statefulEc2]
 *   observer           primaryVpcId, secondaryVpcId
 */
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { DrsRegionSwitchConfig } from '../lib/constructs/drs-region-switch-steps';
import { AlbSecondaryStack } from '../lib/alb-secondary-stack';
import { AppPrimaryStack } from '../lib/app-primary-stack';
import { DatabasePrimaryStack } from '../lib/database-primary-stack';
import { DatabaseSecondaryStack } from '../lib/database-secondary-stack';
import { DrsStepsStack } from '../lib/drs-steps-stack';
import { IamStack } from '../lib/iam-stack';
import { NetworkStack } from '../lib/network-stack';
import { ObserverStack } from '../lib/observer-stack';
import { PlanStack } from '../lib/plan-stack';

const app = new cdk.App();

// ---- context helpers -----------------------------------------------------------------------
const c = (key: string, fallback = ''): string => {
  const v = app.node.tryGetContext(key);
  return v === undefined || v === null ? fallback : String(v);
};
const list = (key: string): string[] => c(key).split(',').filter(Boolean);
const placeholderIf = (v: string, ph: string) => (v === '' ? ph : v);

const project = c('project', 'drsdemo');
const primaryRegion = c('primaryRegion', 'us-east-2');
const secondaryRegion = c('secondaryRegion', 'us-west-2');
const observerRegion = c('observerRegion', 'us-east-1');
const accountId = c('accountId', process.env.CDK_DEFAULT_ACCOUNT ?? '000000000000');
const target = c('stack', 'all');
const statefulEc2 = c('statefulEc2', 'false') === 'true';
const env = (region: string): cdk.Environment => ({ account: accountId, region });
const want = (name: string) => target === 'all' || target === name;

if (c('nag') === 'true') {
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
}
const suppressions = [
  { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole / AmazonSSMManagedInstanceCore / DRS managed policies are the documented service policies.' },
  { id: 'AwsSolutions-IAM5', reason: 'drs:* and ViaAWSService EC2 grants: DRS launches recovery instances with the caller\'s credentials and offers no resource-level scoping for these actions (design.md s8).' },
  { id: 'AwsSolutions-EC23', reason: 'Internal ALBs; ingress is limited to the workload/observer CIDRs supplied via context.' },
  { id: 'AwsSolutions-EC26', reason: 'Demo root volume; DRS replicates the block device as-is.' },
  { id: 'AwsSolutions-EC28', reason: 'Detailed monitoring not needed for the demo.' },
  { id: 'AwsSolutions-EC29', reason: 'The primary EC2 is deliberately replaceable; ASG is out of scope (DRS protects a single instance).' },
  { id: 'AwsSolutions-ELB2', reason: 'ALB access logs omitted for the demo.' },
  { id: 'AwsSolutions-RDS6', reason: 'Password auth via Secrets Manager for the demo app.' },
  { id: 'AwsSolutions-RDS10', reason: 'Deletion protection disabled so make clean can tear down.' },
  { id: 'AwsSolutions-RDS11', reason: 'Default PostgreSQL port.' },
  { id: 'AwsSolutions-SMG4', reason: 'Demo credential; rotation out of scope.' },
  { id: 'AwsSolutions-VPC7', reason: 'VPC flow logs omitted for the demo.' },
  { id: 'AwsSolutions-L1', reason: 'Python 3.12 is the current stable runtime for the step functions.' },
];
const suppress = (s: cdk.Stack) => NagSuppressions.addStackSuppressions(s, suppressions, true);

// ---- networks -----------------------------------------------------------------------------
if (want('net-primary')) {
  suppress(new NetworkStack(app, `${project}-net-primary`, {
    env: env(primaryRegion), project, role: 'primary', cidr: '10.0.0.0/16',
    peer: { region: secondaryRegion, cidr: '10.1.0.0/16', vpcId: c('secondaryVpcId') || undefined },
    observer: { cidr: c('observerCidr', '10.2.0.0/16'), peeringId: c('observerPeeringId') || undefined },
  }));
}
if (want('net-secondary')) {
  suppress(new NetworkStack(app, `${project}-net-secondary`, {
    env: env(secondaryRegion), project, role: 'secondary', cidr: '10.1.0.0/16',
    peer: { region: primaryRegion, cidr: '10.0.0.0/16', vpcId: c('primaryVpcId') || undefined,
      acceptPeeringId: c('peeringConnectionId') || undefined },
    observer: { cidr: c('observerCidr', '10.2.0.0/16'), peeringId: c('observerPeeringId') || undefined },
  }));
}

// ---- iam ----------------------------------------------------------------------------------
if (want('iam')) {
  suppress(new IamStack(app, `${project}-iam`, { env: env(primaryRegion), project }));
}

// ---- databases ----------------------------------------------------------------------------
const globalClusterId = `${project}-global`;
if (want('db-primary')) {
  suppress(new DatabasePrimaryStack(app, `${project}-db-primary`, {
    env: env(primaryRegion), project, globalClusterId,
    vpcId: placeholderIf(c('primaryVpcId'), 'vpc-placeholder'),
    subnetIds: list('primaryPrivateSubnetIds'),
  }));
}
if (want('db-secondary')) {
  suppress(new DatabaseSecondaryStack(app, `${project}-db-secondary`, {
    env: env(secondaryRegion), project, globalClusterId,
    vpcId: placeholderIf(c('secondaryVpcId'), 'vpc-placeholder'),
    subnetIds: list('secondaryPrivateSubnetIds'),
    kmsKeyId: c('kmsKeyId') || undefined,
  }));
}

// ---- app tier -----------------------------------------------------------------------------
const hostedZoneName = c('hostedZoneName', `${project}.internal`);
const recordName = `app.${hostedZoneName}`;
if (want('app-primary')) {
  suppress(new AppPrimaryStack(app, `${project}-app-primary`, {
    env: env(primaryRegion), project, hostedZoneName, recordName,
    vpcId: placeholderIf(c('primaryVpcId'), 'vpc-placeholder'),
    subnetIds: list('primaryPrivateSubnetIds'),
    writerEndpoint: c('primaryWriterEndpoint', 'placeholder.rds.amazonaws.com'),
    appInstanceRoleArn: c('appInstanceRoleArn') || undefined,
    appCodeBucket: c('appCodeBucket') || undefined,
    arcHealthCheckId: c('arcHealthCheckId') || undefined,
    secondaryVpc: c('secondaryVpcId') ? { vpcId: c('secondaryVpcId'), region: secondaryRegion } : undefined,
    observerVpc: c('observerVpcId') ? { vpcId: c('observerVpcId'), region: observerRegion } : undefined,
    demoClientCidr: c('demoClientCidr') || undefined,
  }));
}
if (want('alb-secondary')) {
  suppress(new AlbSecondaryStack(app, `${project}-alb-secondary`, {
    env: env(secondaryRegion), project, recordName,
    vpcId: placeholderIf(c('secondaryVpcId'), 'vpc-placeholder'),
    subnetIds: list('secondaryPrivateSubnetIds'),
    hostedZoneId: c('hostedZoneId') || undefined,
    arcHealthCheckId: c('arcHealthCheckId') || undefined,
    demoClientCidr: c('demoClientCidr') || undefined,
  }));
}

// ---- DRS steps (construct, one stack per region) + plan -----------------------------------
const drsConfig: DrsRegionSwitchConfig = {
  project, primaryRegion, secondaryRegion, statefulEc2,
  primaryTargetGroupArn: c('primaryTargetGroupArn', 'arn:aws:elasticloadbalancing:placeholder'),
  secondaryTargetGroupArn: c('secondaryTargetGroupArn', 'arn:aws:elasticloadbalancing:placeholder'),
  appInstanceProfileArn: c('appInstanceProfileArn', `arn:aws:iam::${accountId}:instance-profile/${project}-app-instance-profile`),
  appInstanceRoleArn: c('appInstanceRoleArn', `arn:aws:iam::${accountId}:role/${project}-app-instance-role`),
  dbEndpointParameterName: `/${project}/db-writer-endpoint`,
  secondaryDbEndpoint: c('secondaryWriterEndpoint') || undefined,
  launchTemplate: {
    primarySubnetId: list('primaryPrivateSubnetIds')[0],
    primarySecurityGroupId: c('primaryAppSgId') || undefined,
    secondarySubnetId: c('secondaryStagingSubnetId') || undefined,
    secondarySecurityGroupId: c('secondaryRecoveredAppSgId') || undefined,
    instanceType: 't2.small',
  },
};
if (want('drs-steps-primary')) {
  suppress(new DrsStepsStack(app, `${project}-drs-steps-primary`, { env: env(primaryRegion), config: drsConfig }));
}
if (want('drs-steps-secondary')) {
  suppress(new DrsStepsStack(app, `${project}-drs-steps-secondary`, { env: env(secondaryRegion), config: drsConfig }));
}
if (want('plan')) {
  suppress(new PlanStack(app, `${project}-plan`, {
    env: env(primaryRegion), project, drsConfig, globalClusterId, hostedZoneName, recordName,
    primaryClusterArn: c('primaryClusterArn', 'arn:aws:rds:placeholder'),
    secondaryClusterArn: c('secondaryClusterArn', 'arn:aws:rds:placeholder'),
    hostedZoneId: c('hostedZoneId', 'Z000PLACEHOLDER'),
  }));
}

// ---- observer (third region) --------------------------------------------------------------
if (want('observer')) {
  suppress(new ObserverStack(app, `${project}-observer`, {
    env: env(observerRegion), project, cidr: c('observerCidr', '10.2.0.0/16'),
    primary: { region: primaryRegion, vpcId: placeholderIf(c('primaryVpcId'), 'vpc-placeholder'), cidr: '10.0.0.0/16' },
    secondary: { region: secondaryRegion, vpcId: placeholderIf(c('secondaryVpcId'), 'vpc-placeholder'), cidr: '10.1.0.0/16' },
  }));
}

app.synth();
