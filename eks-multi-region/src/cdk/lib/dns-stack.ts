import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import {
  APP_DOMAIN,
  APP_RECORD_NAME,
  OBSERVER_REGION,
  REGIONS,
} from '../regions';

export interface DnsStackProps extends cdk.StackProps {
  readonly appId: string;
}

/**
 * Global routing (step 4b) — the plan step that existed only as a box in the
 * architecture diagram until step 4 found the gap.
 *
 * A PRIVATE hosted zone for {@link APP_DOMAIN}, associated with BOTH workload regions'
 * VPCs and with the observer VPC (the load generator resolves the app record from there).
 * That is ALL this stack owns.
 *
 * THE APP RECORDS ARE NOT HERE. They live in the FAILOVER stack, next to the ARC plan whose
 * health checks they carry — see `failover-stack.ts`. The plan and the records are a mutual
 * contract: the plan names them by `{ HostedZoneId, RecordName, RecordSetIdentifier }`, and
 * they must carry the health check ids the plan vends. While they lived here, that contract
 * spanned two stacks and the ids could only be attached out-of-band; they were attached by
 * hand twice (2026-08-27, 2026-08-31) and a CloudFormation DELETE of a record then failed to
 * match its live shape. The ZONE stays here because it is long-lived infrastructure; the
 * records are part of the failover mechanism.
 *
 * CORRECTION (2026-08-31). This docblock previously claimed ARC "binds [its health checks] to
 * these records itself — which is why NO health check resources are declared here". The
 * binding half was FALSE and cost real time twice. The AWS docs are explicit: the Route 53
 * health check execution block "creates Amazon Route 53 health checks, which you then attach
 * to Route 53 DNS records in your account". ARC creates them; attaching them is on us. It is
 * still true that no health check RESOURCES are declared — they are service-owned, absent
 * from `route53 list-health-checks`, and `get-health-check` returns AccessDenied even to
 * Admin — but their ids are now threaded into the records from the plan's `PlanHealthChecks`
 * attribute inside the failover stack.
 *
 * WHY THE ZONE IS STILL PARAMETERISED. The VPC ids come from the two RegionStacks on the
 * dotenv rail. The load-balancer coordinates that used to be threaded here moved to the
 * failover stack with the records.
 *
 * DEPLOYED INTO THE PRIMARY REGION. Route 53 is a global service; the stack has to
 * live somewhere, and the primary is where every other singleton lives. The VPC
 * associations name each VPC's region explicitly, so the stack's own region carries no
 * meaning for the zone.
 */
export class DnsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    // build/deploy-stack.sh appends these to EVERY deploy unconditionally and
    // CloudFormation rejects a changeset carrying parameters the template does not
    // declare. Required in every deployable stack.
    new cdk.CfnParameter(this, 'AssetsBucketName', {
      type: 'String',
      description: 'S3 bucket holding the synthesized templates and asset objects.',
    });
    new cdk.CfnParameter(this, 'AssetsBucketPrefix', {
      type: 'String',
      description: 'Run-scoped key prefix inside the assets bucket.',
    });

    // Per-region inputs, threaded by the deploy task factory. R<i> ordering follows
    // REGIONS — a contract with `createDeployTasks`, like the peering stack's params.
    const perRegion = REGIONS.map((r, i) => ({
      region: r.name,
      vpcId: new cdk.CfnParameter(this, `R${i}VpcId`, {
        type: 'String',
        description: `VPC id of the ${r.name} RegionStack, for the private zone association.`,
      }),
    }));

    // The observer VPC as well: the load generator runs there (LoadGenStack) and resolves
    // the app record from it, so the zone must answer in that VPC too. A hosted zone's
    // VPC associations may name any region, which is what makes a third-region client
    // possible without a resolver rule or a forwarding endpoint.
    const observerVpcId = new cdk.CfnParameter(this, 'ObserverVpcId', {
      type: 'String',
      description: `VPC id of the ${OBSERVER_REGION} observer stack, where the load generator resolves the app record.`,
    });

    const zone = new route53.CfnHostedZone(this, 'HostedZone', {
      name: APP_DOMAIN,
      vpcs: [
        ...perRegion.map((p) => ({
          vpcId: p.vpcId.valueAsString,
          vpcRegion: p.region,
        })),
        { vpcId: observerVpcId.valueAsString, vpcRegion: OBSERVER_REGION },
      ],
    });

    // NO app records here. They live in the FAILOVER stack alongside the ARC plan, because
    // the plan and the records are a mutual contract (the plan names them by
    // recordSetIdentifier; they carry the health check ids the plan vends). Keeping them in
    // separate stacks meant the ids could only be attached out-of-band. This stack owns the
    // ZONE -- long-lived infrastructure -- and nothing that the failover mechanism mutates.

    new cdk.CfnOutput(this, 'HostedZoneId', { value: zone.attrId });
    new cdk.CfnOutput(this, 'AppRecordName', { value: APP_RECORD_NAME });
  }
}
