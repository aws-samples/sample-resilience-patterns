import * as cdk from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack';
import { recordNames, VPC_CIDRS } from '../lib/names';
import { PlanStack } from '../lib/plan-stack';
import { HealthCheckIds, RecordsStack } from '../lib/records-stack';
import { RegionStack } from '../lib/region-stack';

export const REGIONS = ['us-east-1', 'us-east-2'] as const;
export const PROJECT = 'regional-affinity';
export const NAMES = recordNames('ingest', 'demo.io', REGIONS);
export const TABLE = `${PROJECT}-customers`;
export const ALB = {
  'us-east-1': { dnsName: 'internal-a-1.us-east-1.elb.amazonaws.com', hostedZoneId: 'Z35SXDOTRQ7X7K' },
  'us-east-2': { dnsName: 'internal-b-2.us-east-2.elb.amazonaws.com', hostedZoneId: 'Z3AADJGX6KTTL2' },
};

/** One distinct health check ID per (record name, Region), recognizable in assertions. */
export function healthChecks(): HealthCheckIds {
  let i = 0;
  return Object.fromEntries([NAMES.regionLess, ...Object.values(NAMES.regional)].map((name) =>
    [name, Object.fromEntries(REGIONS.map((r) => [r, `00000000-0000-4000-8000-${String(++i).padStart(12, '0')}`]))]));
}

export function regionStack(region: 'us-east-1' | 'us-east-2', peer: { vpcId?: string; peeringConnectionId?: string } = {}) {
  const i = REGIONS.indexOf(region);
  return new RegionStack(new cdk.App(), `${PROJECT}-region-${region}`, {
    env: { region }, project: PROJECT, names: NAMES, tableName: TABLE, cidr: VPC_CIDRS[i],
    peer: { region: REGIONS[1 - i], cidr: VPC_CIDRS[1 - i], ...peer },
  });
}

export function dataStack() {
  return new DataStack(new cdk.App(), `${PROJECT}-data`, { env: { region: REGIONS[0] }, tableName: TABLE, replicaRegion: REGIONS[1] });
}

export function planStack() {
  return new PlanStack(new cdk.App(), `${PROJECT}-plan`, {
    env: { region: REGIONS[0] }, project: PROJECT, domain: 'demo.io', names: NAMES, regions: REGIONS,
    vpcIds: ['vpc-0000000000000000a', 'vpc-0000000000000000b'],
  });
}

export function recordsStack(ids: HealthCheckIds = healthChecks()) {
  return new RecordsStack(new cdk.App(), `${PROJECT}-records`, {
    env: { region: REGIONS[0] }, names: NAMES, regions: REGIONS, hostedZoneId: 'Z0PRIVATEZONE', albs: ALB, healthChecks: ids,
  });
}
