#!/usr/bin/env node
/**
 * regional-affinity: each customer has a home Region for its reads and writes in an Amazon
 * DynamoDB global table, a router redirects region-less requests to the home Region's name, and
 * one Amazon Application Recovery Controller (ARC) Region switch plan drains or restores a Region
 * at all three levels of an Amazon Route 53 private hosted zone.
 *
 * Wiring follows the repo idiom (see drs-ec2/): the Makefile deploys stacks in dependency order and
 * feeds each stack's outputs to the next as `-c key=value` context, so synth makes no AWS calls.
 * `-c stack=<name>` selects the stack(s) to synthesize; `cdk synth --all` (the CI build) synthesizes
 * everything with placeholder context.
 *
 * Stacks (all prefixed `<project>-`) and the context each consumes, beyond project, regions,
 * domain and appLabel:
 *   region-<first>   [peerVpcId]             -- set on the second pass: creates the peering
 *   region-<second>  [peeringConnectionId]   -- set on the second pass: adds the return route
 *   data             (none)                  -- global table, replica in the second Region
 *   plan             vpcIds                  -- private hosted zone + Region switch plan
 *   records          hostedZoneId, albDnsNames, albHostedZoneIds, healthChecks
 *
 * `-c stack=base` selects the two Region stacks and the data stack, which deploy in parallel.
 */
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DataStack } from '../lib/data-stack';
import { checkDomain, checkLabel, checkProject, parseRegions, recordNames, VPC_CIDRS } from '../lib/names';
import { suppress } from '../lib/nag';
import { PlanStack } from '../lib/plan-stack';
import { HealthCheckIds, RecordsStack } from '../lib/records-stack';
import { RegionStack } from '../lib/region-stack';

const app = new cdk.App();

// ---- context ---------------------------------------------------------------------------------
const c = (key: string, fallback = ''): string => {
  const v = app.node.tryGetContext(key);
  return v === undefined || v === null ? fallback : String(v);
};
const list = (key: string): string[] => c(key).split(',').map((s) => s.trim()).filter(Boolean);
const target = c('stack', 'all');
const synthAll = target === 'all';
const want = (...names: string[]) => synthAll || names.includes(target);
/** A value the selected stack needs; placeholders are allowed only when synthesizing every stack. */
const needed = (key: string, value: string, placeholder: string): string => {
  if (value) return value;
  if (synthAll) return placeholder;
  throw new Error(`context "${key}" is required for -c stack=${target}; run it through the Makefile`);
};

const project = checkProject(c('project', 'regional-affinity'));
const regions = parseRegions(c('regions', 'us-east-1,us-east-2'));
const [first, second] = regions;
const domain = checkDomain(c('domain', 'demo.io'));
const appLabel = checkLabel(c('appLabel', 'ingest'));
const names = recordNames(appLabel, domain, regions);
const tableName = `${project}-customers`;
// No account: synth stays free of AWS lookups, and the stacks deploy to the account of the
// credentials in use, which the Makefile prints and can pin with ACCOUNT=<id>.
const env = (region: string): cdk.Environment => ({ region });

if (c('nag') === 'true') {
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
}

// ---- the two Regions + the global table ------------------------------------------------------
if (want('base', `region-${first}`)) {
  suppress(new RegionStack(app, `${project}-region-${first}`, {
    env: env(first), project, names, tableName, cidr: VPC_CIDRS[0],
    peer: { region: second, cidr: VPC_CIDRS[1], vpcId: c('peerVpcId') || undefined },
  }));
}
if (want('base', `region-${second}`)) {
  suppress(new RegionStack(app, `${project}-region-${second}`, {
    env: env(second), project, names, tableName, cidr: VPC_CIDRS[1],
    peer: { region: first, cidr: VPC_CIDRS[0], peeringConnectionId: c('peeringConnectionId') || undefined },
  }));
}
if (want('base', 'data')) {
  suppress(new DataStack(app, `${project}-data`, { env: env(first), tableName, replicaRegion: second }));
}

// ---- the private hosted zone + the Region switch plan ----------------------------------------
if (want('plan')) {
  const vpcIds = list('vpcIds');
  suppress(new PlanStack(app, `${project}-plan`, {
    env: env(first), project, domain, names, regions,
    vpcIds: [needed('vpcIds', vpcIds[0] ?? '', 'vpc-00000000000000001'), needed('vpcIds', vpcIds[1] ?? '', 'vpc-00000000000000002')],
  }));
}

// ---- the records ----------------------------------------------------------------------------
if (want('records')) {
  const raw = app.node.tryGetContext('healthChecks');
  let healthChecks: HealthCheckIds = typeof raw === 'string' && raw ? JSON.parse(raw) : raw ?? {};
  if (synthAll && Object.keys(healthChecks).length === 0) {
    const placeholder = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    let i = 0;
    healthChecks = Object.fromEntries([names.regionLess, ...Object.values(names.regional)].map((name) =>
      [name, Object.fromEntries(regions.map((r) => [r, placeholder(++i)]))]));
  }
  const dnsNames = list('albDnsNames');
  const zoneIds = list('albHostedZoneIds');
  suppress(new RecordsStack(app, `${project}-records`, {
    env: env(first), names, regions, healthChecks,
    hostedZoneId: needed('hostedZoneId', c('hostedZoneId'), 'Z00000000000000000000'),
    albs: Object.fromEntries(regions.map((r, i) => [r, {
      dnsName: needed('albDnsNames', dnsNames[i] ?? '', `internal-placeholder-${i}.${r}.elb.amazonaws.com`),
      hostedZoneId: needed('albHostedZoneIds', zoneIds[i] ?? '', 'Z35SXDOTRQ7X7K'),
    }])),
    albEvaluateTargetHealth: c('albEvaluateTargetHealth', 'false') === 'true',
  }));
}

app.synth();
