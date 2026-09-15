#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DnsStack } from './lib/dns-stack';
import { FailoverStack } from './lib/failover-stack';
import { GlobalDataStack } from './lib/global-data-stack';
import { LoadGenStack } from './lib/loadgen-stack';
import { ObserverStack } from './lib/observer-stack';
import { OperatorAccessStack } from './lib/operator-access-stack';
import { PeeringStack } from './lib/peering-stack';
import { RegionStack } from './lib/region-stack';
import { SecondaryDbStack } from './lib/secondary-db-stack';
import { StandbyAccessStack } from './lib/standby-access-stack';
import {
  DNS_SUFFIX,
  GLOBAL_DATA_SUFFIX,
  LOADGEN_SUFFIX,
  OBSERVER_CIDR,
  OBSERVER_REGION,
  OBSERVER_SUFFIX,
  PEERING_SUFFIX,
  PRIMARY_REGION,
  REGIONS,
  FAILOVER_SUFFIX,
  SECONDARY_DB_SUFFIX,
  STANDBY_ACCESS_SUFFIX,
  operatorAccessSuffix,
  peerVpcCidrs,
  regionSuffix,
} from './regions';
import { makeSynthesizer } from './synthesizer';

const app = new cdk.App({ analyticsReporting: false });

// PROJECT_NAME is injected by projen (.projenrc.ts: tasks.addEnvironment). The
// eks-mr-demo fallback keeps a bare local `cdk synth` producing stable stack names.
const APP_ID = process.env.PROJECT_NAME ?? 'eks-mr-demo';

// PDD 2026-08-31-chaos-status-page, Step 0. Cockpit gate — defaults ON (bare local
// `cdk synth` gets the cockpit); projen sets ENABLE_COCKPIT from the enableCockpit flag.
// Only takes effect in the us-west-2 OperatorAccessStack (the construct is west-guarded).
const ENABLE_COCKPIT = (process.env.ENABLE_COCKPIT ?? 'true') === 'true';

/**
 * TOPOLOGY (design/00-topology.md, step 1 of implementation/plan.md)
 *
 *   RegionStack × REGIONS.length   — one per region, suffix `region-<name>`
 *   GlobalDataStack                — step 1b, primary region only
 *   FailoverStack              — step 7,  primary region only
 *
 * The green `DemoStack` and its `demo` suffix are RETIRED, not kept alongside, so the
 * packaging step does not chase a stack that no longer exists.
 *
 * Stack names come from `regionSuffix()` in ./regions so they cannot drift from the
 * names the deploy task factory generates (`$PROJECT_NAME-region-${r.name}`). The
 * packaging task iterates the same derived list. That shared derivation is the point:
 * a naming mismatch here is a green build and a broken deploy.
 */
for (const region of REGIONS) {
  const stackName = `${APP_ID}-${regionSuffix(region)}`;
  new RegionStack(app, stackName, {
    stackName,
    synthesizer: makeSynthesizer(),
    env: { region: region.name },
    appId: APP_ID,
    regionName: region.name,
    defaultVpcCidr: region.cidr,
    // Primary region only. The secondary member is in SecondaryDbStack — see below.
    withPrimaryDatabase: region.name === PRIMARY_REGION,
    // Give the standby region a LOCAL copy of the database credentials. The secondary
    // member inherits its credentials by replication and owns no secret, so without
    // this the standby's pods would read the primary region's secret cross-region —
    // depending on the region they are failing away from, precisely when ARC scales
    // them up.
    replicateSecretToRegion:
      region.name === PRIMARY_REGION ? REGIONS[1].name : undefined,
    // Peer CIDRs this region must admit on the NodePort range. The load generator lives in
    // one region and follows DNS to whichever region is active, so requests arrive from
    // the peer VPC — and because the in-tree controller uses instance targets with client
    // IP preservation on, the node sees the ORIGINAL client address, not the load
    // balancer's. See RegionStack for the full reasoning.
    peerVpcCidrs: peerVpcCidrs(region.name),
  });
}

/**
 * Cross-region VPC peering. Deploy position 3 — after both region stacks, before the
 * database singletons.
 *
 * This reverses D-008. That decision traced what used the cross-region path (database
 * replication: no, it rides the AWS network; ARC Region switch: no, regional endpoints;
 * traffic shifting: DNS) and concluded nothing did. The gap in that reasoning is that DNS
 * resolves names without moving packets: the load generator follows the failover to the
 * other region's INTERNAL load balancer, and that needs a route.
 */
const peeringName = `${APP_ID}-${PEERING_SUFFIX}`;
new PeeringStack(app, peeringName, {
  stackName: peeringName,
  synthesizer: makeSynthesizer(),
  env: { region: PRIMARY_REGION },
  appId: APP_ID,
});

/**
 * The Aurora global cluster, and the secondary member that joins it.
 *
 * The ORDER here is forced by the service, not chosen:
 *
 *   1. RegionStack(primary)   creates the primary cluster STANDALONE
 *   2. RegionStack(secondary) network + EKS only, no database
 *   3. GlobalDataStack        adopts the primary via sourceDbClusterIdentifier
 *   4. SecondaryDbStack       creates the secondary WITH globalClusterIdentifier,
 *                             which requires the global cluster to already exist
 *
 * The secondary member therefore cannot live inside the secondary RegionStack, which
 * deploys at position 2 — ahead of the global cluster it needs. Splitting it into its
 * own stack also keeps the secondary region's network and EKS off the critical path of
 * the primary's database.
 */
const globalDataName = `${APP_ID}-${GLOBAL_DATA_SUFFIX}`;
new GlobalDataStack(app, globalDataName, {
  stackName: globalDataName,
  synthesizer: makeSynthesizer(),
  env: { region: PRIMARY_REGION },
  appId: APP_ID,
});

const secondaryRegion = REGIONS[1].name;
const secondaryDbName = `${APP_ID}-${SECONDARY_DB_SUFFIX}`;
new SecondaryDbStack(app, secondaryDbName, {
  stackName: secondaryDbName,
  synthesizer: makeSynthesizer(),
  env: { region: secondaryRegion },
  appId: APP_ID,
  regionName: secondaryRegion,
});

/**
 * Global routing (step 4b). Deploys LAST — after the post-deploy installer phases,
 * because its records alias load balancers KUBERNETES creates: their DNS names and
 * canonical hosted zone ids only exist once the installers have run, and they arrive
 * here as CfnParameters off the dotenv rail. The ARC plan (step 8) flips these records;
 * the load generator (step 4c) resolves them.
 */
const dnsName = `${APP_ID}-${DNS_SUFFIX}`;
new DnsStack(app, dnsName, {
  stackName: dnsName,
  synthesizer: makeSynthesizer(),
  env: { region: PRIMARY_REGION },
  appId: APP_ID,
});

/**
 * The synthetic users (step 4c). Primary region, after `dns`: they resolve the latency
 * record the DNS stack just created, so starting them any earlier is a flood of
 * DNS-failure errors into the availability alarm before the demo has begun.
 */
const loadGenName = `${APP_ID}-${LOADGEN_SUFFIX}`;
new LoadGenStack(app, loadGenName, {
  stackName: loadGenName,
  synthesizer: makeSynthesizer(),
  env: { region: PRIMARY_REGION },
  appId: APP_ID,
});

/**
 * The ARC Region Switch plan (step 7 skeleton, step 8 body) and the standby cluster's
 * access entry. Both deploy AFTER `dns`: the plan's activate workflow needs a real hosted
 * zone id, and the standby entry needs the execution role the plan stack creates.
 */
const regionSwitchName = `${APP_ID}-${FAILOVER_SUFFIX}`;
new FailoverStack(app, regionSwitchName, {
  stackName: regionSwitchName,
  synthesizer: makeSynthesizer(),
  env: { region: PRIMARY_REGION },
  appId: APP_ID,
});

const standbyAccessName = `${APP_ID}-${STANDBY_ACCESS_SUFFIX}`;
new StandbyAccessStack(app, standbyAccessName, {
  stackName: standbyAccessName,
  synthesizer: makeSynthesizer(),
  env: { region: REGIONS[1].name },
  appId: APP_ID,
});

/**
 * The observer VPC + bastion (step 12), in a THIRD region. Deploys after both region
 * stacks (it peers to both workload VPCs, so it needs their ids — threaded as
 * CfnParameters off the dotenv rail, never Fn::ImportValue across regions). The
 * accepter-side routes back into the workload VPCs are added by the deploy rail from the
 * peering ids this stack outputs. Independent of the installer phases, so it can deploy
 * as soon as the region stacks are up.
 */
const observerName = `${APP_ID}-${OBSERVER_SUFFIX}`;
new ObserverStack(app, observerName, {
  stackName: observerName,
  synthesizer: makeSynthesizer(),
  env: { region: OBSERVER_REGION },
  appId: APP_ID,
  observerCidr: OBSERVER_CIDR,
});

/**
 * The operator access doors (step 12), one per region — see OperatorAccessStack for the
 * full reasoning. Deploy LAST (factory Phase 6, after the installer phases): each ALB
 * target group takes the Kubernetes-created argocd-server NLB ENI ips in its region,
 * which arrive as a CfnParameter off the dotenv rail, same as the DNS stack's alias
 * targets. Reached only through the observer bastion over SSM (build/tunnel.sh); there is
 * no CloudFront distribution and no signed-cookie gate.
 */
for (const region of REGIONS) {
  const accessName = `${APP_ID}-${operatorAccessSuffix(region)}`;
  new OperatorAccessStack(app, accessName, {
    stackName: accessName,
    synthesizer: makeSynthesizer(),
    env: { region: region.name },
    appId: APP_ID,
    regionName: region.name,
    enableCockpit: ENABLE_COCKPIT,
    observerCidr: OBSERVER_CIDR,
  });
}

app.synth();
