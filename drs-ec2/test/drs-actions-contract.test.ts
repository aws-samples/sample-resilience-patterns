import * as fs from 'fs';
import * as path from 'path';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DrsRegionSwitchConfig, DrsRegionSwitchSteps } from '../lib/constructs/drs-region-switch-steps';

/**
 * Derives the set of DRS actions the step Lambdas invoke by reading their source, and asserts the
 * orchestration policy grants exactly those by name. A new boto3 call without a matching grant fails
 * here instead of as an AccessDenied halfway through a live fail-over; a wildcard fails here too.
 */
const LAMBDA_DIR = path.join(__dirname, '..', 'lambda', 'drs_region_switch');
const IAM_TF = path.join(__dirname, '..', 'terraform', 'iam.tf');

const cfg: DrsRegionSwitchConfig = {
  project: 'drsdemo',
  primaryRegion: 'us-east-2',
  secondaryRegion: 'us-west-2',
  primaryTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/pri/abc',
  secondaryTargetGroupArn: 'arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/sec/def',
  appInstanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/drsdemo-app-instance-profile',
  appInstanceRoleArn: 'arn:aws:iam::123456789012:role/drsdemo-app-instance-role',
  dbEndpointParameterName: '/drsdemo/db-writer-endpoint',
  secondaryDbEndpoint: 'db.usw2.example',
  statefulEc2: true,
};

const pascal = (snake: string) => snake.split('_').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');

/** DRS client variables are named drs, drs_sec, drs_pri, drs_origin; paginators name the API as a string. */
function drsActionsCalledByLambdas(): Set<string> {
  const actions = new Set<string>();
  for (const file of fs.readdirSync(LAMBDA_DIR).filter((f) => f.endsWith('.py'))) {
    const src = fs.readFileSync(path.join(LAMBDA_DIR, file), 'utf8');
    for (const m of src.matchAll(/\bdrs\w*\.([a-z_]+)\(/g)) {
      if (m[1] !== 'get_paginator') actions.add(`drs:${pascal(m[1])}`);
    }
    for (const m of src.matchAll(/get_paginator\(\s*["']([a-z_]+)["']\s*\)/g)) actions.add(`drs:${pascal(m[1])}`);
  }
  return actions;
}

function grantedByConstruct(): string[] {
  const app = new App();
  const stack = new Stack(app, 'S', { env: { account: '123456789012', region: 'us-west-2' } });
  new DrsRegionSwitchSteps(stack, 'Drs', { ...cfg, codePath: `${__dirname}/../lambda` });
  const policies = Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy')) as any[];
  const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement as any[]);
  const drs = statements.find((s) => s.Sid === 'Drs');
  expect(drs).toBeDefined();
  return Array.isArray(drs.Action) ? drs.Action : [drs.Action];
}

function grantedByTerraform(): string[] {
  const tf = fs.readFileSync(IAM_TF, 'utf8');
  const block = tf.match(/sid\s*=\s*"Drs"[\s\S]*?actions\s*=\s*\[([\s\S]*?)\]/);
  expect(block).not.toBeNull();
  return [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe('DRS action contract (Lambda code -> orchestration policy)', () => {
  const called = drsActionsCalledByLambdas();
  const cdkGranted = grantedByConstruct();
  const tfGranted = grantedByTerraform();

  test('the Lambda code calls a meaningful, known set of DRS APIs', () => {
    expect(called.size).toBeGreaterThanOrEqual(10);
    for (const a of called) expect(a).toMatch(/^drs:[A-Z][A-Za-z]+$/);
  });

  test('CDK construct: no wildcard, and every called DRS API is granted by name', () => {
    for (const a of cdkGranted) expect(a).not.toMatch(/\*/);
    for (const a of called) expect(cdkGranted).toContain(a);
  });

  test('CDK construct: every granted DRS action is one the Lambda code calls', () => {
    for (const a of cdkGranted) expect(called.has(a)).toBe(true);
  });

  test('Terraform module grants the identical set', () => {
    expect([...tfGranted].sort()).toEqual([...cdkGranted].sort());
  });
});
