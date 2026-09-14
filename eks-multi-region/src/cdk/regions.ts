/**
 * The demo's region list — the SINGLE source of truth.
 *
 * Imported by BOTH `src/cdk/app.ts` (to build one RegionStack per entry) and
 * `.projenrc.ts` (to derive `STACK_SUFFIXES` and the per-region deploy phases). That
 * shared import is deliberate: the packaging task names stacks `$PROJECT_NAME-<suffix>`
 * while the deploy task names them `$PROJECT_NAME-region-${r.name}`, and if those two
 * ever disagree the build stays green and the DEPLOY fails on a stack nobody packaged.
 * Deriving both from this one array is what makes that class of mismatch impossible
 * rather than merely unlikely.
 *
 * Keep this module free of `aws-cdk-lib` imports. `.projenrc.ts` runs under ts-node
 * during synth, and pulling CDK into that path costs startup time for no benefit.
 *
 * The shape intentionally matches `RegionConfig` in `projenrc/tasks/deploy-tasks.ts`
 * so `REGIONS` can be passed straight into `createDeployTasks`.
 */
export interface DemoRegion {
  /** AWS region name, e.g. 'us-east-2'. */
  readonly name: string;
  /** VPC CIDR for this region's RegionStack. Must not overlap another region's. */
  readonly cidr: string;
}

/**
 * us-east-2 (Ohio) is PRIMARY — element 0, and the region every singleton stack
 * deploys into. us-west-2 (Oregon) is the secondary, chosen for power-grid isolation
 * from Ohio rather than latency (design decision D-006).
 *
 * Order matters: `REGIONS[0]` is the primary throughout the deploy tasks.
 */
export const REGIONS: readonly DemoRegion[] = [
  { name: 'us-east-2', cidr: '10.0.0.0/16' },
  { name: 'us-west-2', cidr: '10.1.0.0/16' },
] as const;

/** The primary region — where the global and region-switch singletons live. */
export const PRIMARY_REGION = REGIONS[0].name;

/**
 * Availability zones per region, and therefore private-isolated subnets per region.
 *
 * Exported and passed EXPLICITLY to `RegionalNetwork` rather than relying on its
 * internal default, because a consumer needs the count at synth time. `SecondaryDbStack`
 * imports the secondary region's VPC from CommaDelimitedList parameters, and
 * `Vpc.fromVpcAttributes` given a list TOKEN can only materialize one synthetic subnet —
 * CDK cannot know a token's length. Aurora requires at least two subnets, so the import
 * has to build fixed-length arrays with `Fn.select(i, list)`, which needs this number.
 *
 * Change it here and both sides move together.
 */
export const AZ_COUNT = 3;

/**
 * Kubernetes version for both EKS clusters.
 *
 * PINNED DELIBERATELY. `eks.CfnCluster` treats `version` as optional and, left unset, EKS
 * assigns whatever its current default happens to be at create time. That makes the demo
 * silently unreproducible — redeploy in six months and an unchanged template gives a
 * different Kubernetes version, with different API deprecations and add-on behaviour.
 *
 * It stops being merely untidy once Karpenter is involved (step 11): Karpenter's support
 * matrix is version-bound, so an unpinned cluster can drift out of the pinned Karpenter
 * release's supported range with no code change and no warning.
 *
 * WHY 1.35 AND NOT THE NEWEST. Against the EKS release calendar as of 2026-08-25:
 * 1.33 is already PAST end of standard support (29 Jul 2026), so it would quietly incur
 * extended-support billing. 1.34 ends standard support 2 Dec 2026 — roughly three months
 * out, too close for a demo that gets redeployed. 1.36 is newest but only reached EKS in
 * June 2026. 1.35 (EKS Jan 2026, standard support through 27 Mar 2027) has months of field
 * exposure and a real runway.
 *
 * ON BUMPING: re-check https://karpenter.sh/docs/upgrading/compatibility/ — Kubernetes
 * 1.36 requires Karpenter >= 1.13, and the mirrored Karpenter version is pinned separately
 * in src/mirror/images.json. A test asserts the two are declared together so they cannot
 * drift apart unnoticed.
 */
export const KUBERNETES_VERSION = '1.35';

/**
 * Stack suffix for a region. The deploy task factory derives its stack names as
 * `$PROJECT_NAME-region-${r.name}`, so this MUST stay `region-<name>` — a shorter
 * form (`use2`) would package under one name and deploy under another.
 */
export const regionSuffix = (region: DemoRegion | string): string =>
  `region-${typeof region === 'string' ? region : region.name}`;

/**
 * Suffixes of the singleton stacks. Each is added to {@link STACK_SUFFIXES} in the SAME
 * increment that adds the stack to `app.ts` — never before.
 *
 * `secondarydb` exists because an Aurora member joins a global cluster by declaring
 * `globalClusterIdentifier`, which needs the global cluster to ALREADY exist, while the
 * global cluster adopts the primary member. That forces the order
 *   RegionStack(primary) → GlobalDataStack → SecondaryDbStack
 * so the secondary member cannot live inside the secondary RegionStack (deploy position
 * 2, ahead of the global cluster it needs).
 */
export const GLOBAL_DATA_SUFFIX = 'globaldata';
export const SECONDARY_DB_SUFFIX = 'secondarydb';
export const FAILOVER_SUFFIX = 'failover';
/**
 * The standby cluster's ARC access entry (step 7). Its own stack because
 * `eks.CfnAccessEntry` is a REGIONAL resource that must be created in the cluster's own
 * region, while the execution role it references is created once in the primary's
 * FailoverStack. One stack cannot satisfy both.
 */
export const STANDBY_ACCESS_SUFFIX = 'standbyaccess';
/**
 * Cross-region VPC peering. REINSTATED after being dropped as D-008.
 *
 * D-008 reasoned that nothing here is VPC-routed across regions — Aurora replication rides
 * the AWS network, ARC Region switch uses per-region endpoints, traffic shifting is DNS.
 * All true, and all beside the point: DNS resolves names, it does not move packets. A
 * client that follows the failover to the other region needs a path to a load balancer
 * that is internal, and peering is that path.
 */
export const PEERING_SUFFIX = 'peering';

/**
 * Global routing (step 4b). A PRIVATE hosted zone associated with both regions' VPCs,
 * holding the latency records the load generator resolves and the ARC Region Switch
 * `Route53HealthCheck` block flips. This was the plan gap found at step 4: the records
 * appeared only in the architecture diagram while step 8's plan assumed they existed.
 */
export const DNS_SUFFIX = 'dns';

/**
 * The load generator (step 4c). PRIMARY region only — Option A's one set of users
 * that follows the failover DNS. Deploys after `dns` (both are post-deploy stacks)
 * so the name its tasks resolve exists before the first request.
 */
export const LOADGEN_SUFFIX = 'loadgen';

/**
 * The operator access door (step 12) — ONE PER REGION, like the region stacks.
 *
 * Each region keeps an INTERNAL ALB in front of the Kubernetes-owned argocd-server NLB
 * (and, in the standby, the cockpit's `/cockpit*` listener rule). The ALB is not reached
 * from the internet: there is no CloudFront distribution and no signed-cookie gate. The
 * only path in is the third-region observer bastion (see {@link OBSERVER_SUFFIX}), which
 * peers to both workload VPCs and port-forwards to these ALBs over SSM Session Manager.
 * Per-region because the claim is about the STANDBY, so both regions' Argo UIs must be
 * reachable, and an ALB lives in one VPC in one region.
 */
export const operatorAccessSuffix = (region: DemoRegion | string): string =>
  `access-${typeof region === 'string' ? region : region.name}`;

/**
 * The observer VPC (step 12) — a THIRD region, independent of both workload regions, that
 * stands in for the customer's operator. It holds an SSM-only bastion (no public IP, no
 * inbound rules) peered to both workload VPCs, so `build/tunnel.sh` can port-forward to
 * whichever region's internal ALB the operator wants to watch. Surviving anything done to
 * either workload region is the point, so it lives outside both.
 */
export const OBSERVER_SUFFIX = 'observer';

/**
 * The observer region. us-east-1 by default — deliberately neither workload region
 * (us-east-2 / us-west-2), so a fault injected into either does not take the observer
 * with it.
 */
export const OBSERVER_REGION = 'us-east-1';

/**
 * The observer VPC CIDR. 10.2.0.0/16 by default — it must overlap NEITHER workload CIDR
 * (10.0.0.0/16, 10.1.0.0/16) or the peering routes would be ambiguous. A test asserts the
 * non-overlap.
 */
export const OBSERVER_CIDR = '10.2.0.0/16';


/**
 * The private zone's domain and the one application record everything targets.
 *
 * Constants rather than deploy-time values because two synth-time consumers need the
 * SAME string: the load generator's `targetUrl` (a required synth-time prop, step 4c)
 * and the ARC plan's `RecordName` (step 8). Threading it as a parameter would let the
 * two drift; a shared constant cannot.
 */
export const APP_DOMAIN = 'eks-mr-demo.internal';
export const APP_RECORD_NAME = `app.${APP_DOMAIN}`;

/**
 * Route 53 `SetIdentifier` for a region's latency record. These exact strings are the
 * other half of the ARC `Route53HealthCheck` block's `RecordSets` config (step 8), which
 * references records by `{ RecordSetIdentifier, Region }` — matching the source repo's
 * `PrimaryRegion` / `StandbyRegion` pair. Two-region demo: a third region would need
 * distinct standby identifiers before this could scale.
 */
export const recordSetIdentifier = (regionName: string): string =>
  regionName === PRIMARY_REGION ? 'PrimaryRegion' : 'StandbyRegion';

/** CIDRs of every region other than `region` — the peers it must admit traffic from. */
export const peerVpcCidrs = (region: string): string[] =>
  REGIONS.filter((r) => r.name !== region).map((r) => r.cidr);

/**
 * Every CURRENTLY DEPLOYABLE stack suffix, in deploy order. Consumed by
 * `STACK_SUFFIXES` in `projenrc/tasks/build-tasks.ts`, which runs
 * `build/package.py $PROJECT_NAME-<suffix>` once per entry.
 *
 * This list must contain exactly the stacks `app.ts` declares — no more, no less.
 * Listing a suffix whose stack does not exist fails packaging with
 *   FileNotFoundError: ./cdk.out/<project>-<suffix>.assets.json
 * and listing a stack that is NOT here means it is never packaged, so the deploy asks
 * CloudFormation for a template that was never uploaded. That second direction is the
 * one that stays green through build AND synth, and only fails on a live deploy — the
 * same defect that made the orphaned PeeringStack a deploy break (C-2).
 *
 * `peering` is present again as of step 4: the load generator lives in one region and
 * follows DNS to whichever region is active, so it needs a route to the other region's
 * internal load balancer. It sits between the region stacks and the singletons, matching
 * the deploy factory's own Phase 3.
 */
export const STACK_SUFFIXES: readonly string[] = [
  ...REGIONS.map((r) => regionSuffix(r)),
  PEERING_SUFFIX,
  GLOBAL_DATA_SUFFIX,
  SECONDARY_DB_SUFFIX,
  // `dns` deploys LAST (factory Phase 6), after the post-deploy installer phases: its
  // records alias load balancers KUBERNETES creates, so the alias targets only exist
  // once the installers have run. Packaging order here is not deploy order.
  DNS_SUFFIX,
  // `loadgen` deploys after `dns` so app.eks-mr-demo.internal resolves before the
  // first synthetic request. Starting it earlier floods the availability alarm with
  // DNS-failure errors that are deploy noise, not signal.
  LOADGEN_SUFFIX,
  // Both deploy after `dns`: the plan's Route53HealthCheck block needs a real hosted
  // zone, and the standby access entry needs the role the plan stack creates.
  FAILOVER_SUFFIX,
  STANDBY_ACCESS_SUFFIX,
  // The observer VPC + bastion, in a third region. Deploys after the region stacks
  // (it peers to both workload VPCs, so it needs their ids) but has no dependency on
  // the installers. Packaging order here is not deploy order.
  OBSERVER_SUFFIX,
  // The per-region operator access doors deploy LAST (factory Phase 6, after the
  // installers): their ALB target groups take the Kubernetes-created argocd-server NLB
  // ENI ips, which arrive on the dotenv rail. Packaging order here is not deploy order.
  ...REGIONS.map((r) => operatorAccessSuffix(r)),
];
