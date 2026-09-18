import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudformation from 'aws-cdk-lib/aws-cloudformation';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * Generalized from the predecessor project-app:
 *   src/cdk/lib/stacks/peering-stack.ts:1-131
 *   src/lambda/peering-configurator/peering_configurator.py
 *
 * The big change vs the predecessor project (CHANGES_REQUIRED, networking-changeset §2.3):
 * the predecessor project fused two concerns in `PeeringStack`: (a) declaring the per-peer
 * `CfnParameter` slots (exactly 3: Client / ApplicationRegionA / ApplicationRegionB,
 * peering-stack.ts:32-48,82-86) and (b) building the Lambda + custom resource. We
 * SPLIT them:
 *   - `PeeringMesh` (this construct) takes a ready `peers: PeerDescriptor[]` array
 *     (any N) and builds the Lambda + IAM + custom resource. It NO-OPs when
 *     `peers.length < 2` — single-region safety: no EC2-peering IAM role and no
 *     custom resource are emitted when there is nothing to peer.
 *   - The N param-slot wiring (the demo-config-specific `PeeringStack`) lives in the
 *     skeleton, driven by the `REGIONS` config, NOT in this reusable library.
 *
 * Other generalizations out of the the predecessor project version:
 *   - Managed tag `FiveNinesDemo=managed` (peering_configurator.py:45-46) becomes a
 *     `managedTag` prop, default `{ key:'CreDemo', value:'managed' }`, threaded to the
 *     Lambda via `ResourceProperties.ManagedTag`.
 *   - The `Role: 'Client'|'Application'` literal union (peering-stack.ts:114) becomes a
 *     free-form optional `role` (requester-preference only; cosmetic).
 *   - The 3-entry `Peers` literal (peering-stack.ts:82-86) becomes a `.map()` over
 *     `props.peers` (full mesh = every unique pair, computed in the Lambda).
 *   - `declareAssetsBucketParams(this)` (peering-stack.ts:30) is a the predecessor project packaging
 *     concern of the `aws cloudformation deploy` path. The equivalent lives in the
 *     skeleton `PeeringStack`, NOT in this construct.
 *
 * Why a custom resource is unavoidable: CloudFormation can *create* an
 * `AWS::EC2::VPCPeeringConnection` with `PeerRegion`, but the **accept** must happen in
 * the peer region and the **peer-side routes** live in route tables owned by another
 * region's stack. There is no native cross-region "accept" or cross-region route
 * resource. The Lambda uses regional boto3 clients to do both sides idempotently.
 * (`crossRegionReferences` would not help — it shares values, not cross-region API
 * actions.)
 */

/** One participant in the peering mesh. Fields are usually CfnParameter tokens. */
export interface PeerDescriptor {
  /** AWS region of this peer's VPC. */
  readonly region: string;
  /** VPC id of this peer. */
  readonly vpcId: string;
  /** VPC CIDR of this peer (the route destination for the other peers). */
  readonly vpcCidr: string;
  /** Route tables in this peer's VPC that should receive peering routes. */
  readonly routeTableIds: string[];
  /** Optional, free-form. Only affects requester preference in the Lambda. */
  readonly role?: string;
}

/** Idempotency / cleanup tag applied to every managed peering connection. */
export interface ManagedTag {
  readonly key: string;
  readonly value: string;
}

export interface PeeringMeshProps {
  /**
   * N peer descriptors. Full mesh = every unique pair (N·(N−1)/2 connections),
   * computed in the Lambda.
   *
   * CRITICAL: with fewer than 2 peers this construct creates NOTHING (single-region
   * safety). A single-region demo can instantiate `PeeringMesh` with one (or zero)
   * peers and get no Lambda, no IAM role, and no custom resource.
   */
  readonly peers: PeerDescriptor[];
  /** Idempotency / cleanup tag. Default `{ key:'CreDemo', value:'managed' }`. */
  readonly managedTag?: ManagedTag;
  /** Lambda timeout. Default `Duration.minutes(5)`. */
  readonly lambdaTimeout?: cdk.Duration;
}

/** Default managed tag — removes the the predecessor project `FiveNinesDemo` coupling. */
const DEFAULT_MANAGED_TAG: ManagedTag = { key: 'CreDemo', value: 'managed' };

/**
 * Builds the cross-region VPC peering mesh: a Python custom-resource Lambda that
 * creates + accepts every unique peering pair and writes bidirectional routes, plus
 * its IAM. No-ops when `peers.length < 2`.
 */
export class PeeringMesh extends Construct {
  /** The configurator Lambda — undefined when the mesh no-ops (`peers.length < 2`). */
  public readonly configurator?: lambda.Function;

  constructor(scope: Construct, id: string, props: PeeringMeshProps) {
    super(scope, id);

    // Single-region / no-peer: build nothing. Keeps the template free of the
    // EC2-peering IAM role + custom resource when there is nothing to peer.
    // (networking-changeset §2.3, §8 single-region skip.)
    if (props.peers.length < 2) {
      return;
    }

    const fn = new lambda.Function(this, 'PeeringConfiguratorFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'peering_configurator.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'peering-configurator')),
      timeout: props.lambdaTimeout ?? cdk.Duration.minutes(5),
      memorySize: 256,
    });

    // Least privilege for a cross-region configurator. Every peer's region and VPC id are
    // known here (as CfnParameter tokens, resolved at deploy time), so the mutating actions
    // are bound to THOSE VPCs, to peering connections in THOSE regions, and to route tables
    // IN those VPCs. Only Describe stays on `*`: DescribeVpcPeeringConnections has no
    // resource-level support. The statement shapes are the ones the VPC peering IAM guide
    // documents -- the `vpc` resource of Create is the requester and of Accept the accepter;
    // AccepterVpc/RequesterVpc are condition keys of the peering-connection resource ONLY,
    // so they sit on their own statement (on a `vpc` resource they would be absent from the
    // request context and deny everything); CreateRoute takes `route-table/*` narrowed by
    // `ec2:Vpc`, the guide's own example for scoping route edits to one VPC. Route-table ids
    // arrive as a CommaDelimitedList token whose length synth cannot know, which is why they
    // are matched by owning VPC rather than enumerated. The Lambda never calls DeleteRoute
    // or DescribeRouteTables, so neither is granted.
    const stack = cdk.Stack.of(this);
    const ec2Arn = (region: string, resource: string, resourceName: string): string =>
      stack.formatArn({
        service: 'ec2', region, resource, resourceName, arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
      });
    const vpcArns = props.peers.map((p) => ec2Arn(p.region, 'vpc', p.vpcId));
    const peeringArns = props.peers.map((p) => ec2Arn(p.region, 'vpc-peering-connection', '*'));
    const routeTableArns = props.peers.map((p) => ec2Arn(p.region, 'route-table', '*'));

    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'DescribePeerings',
      actions: ['ec2:DescribeVpcPeeringConnections'],
      resources: ['*'],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'PeerMeshVpcs',
      actions: ['ec2:CreateVpcPeeringConnection', 'ec2:AcceptVpcPeeringConnection'],
      resources: vpcArns,
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ManageMeshPeeringConnections',
      actions: [
        'ec2:CreateVpcPeeringConnection',
        'ec2:AcceptVpcPeeringConnection',
        'ec2:DeleteVpcPeeringConnection',
      ],
      resources: peeringArns,
      // Both ends of every peering this role may touch must be mesh VPCs.
      conditions: { ArnEquals: { 'ec2:AccepterVpc': vpcArns, 'ec2:RequesterVpc': vpcArns } },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'TagMeshPeeringConnections',
      // Covers the TagSpecifications on create (requester region) and the explicit
      // create_tags after accept (accepter region).
      actions: ['ec2:CreateTags'],
      resources: peeringArns,
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'RouteMeshVpcs',
      actions: ['ec2:CreateRoute'],
      resources: routeTableArns,
      conditions: { StringEquals: { 'ec2:Vpc': vpcArns } },
    }));

    const tag = props.managedTag ?? DEFAULT_MANAGED_TAG;

    const cr = new cloudformation.CfnCustomResource(this, 'PeeringConfigurator', {
      serviceToken: fn.functionArn,
    });
    // Threaded to the Lambda via ResourceProperties. The Lambda defaults to
    // CreDemo=managed if absent, but we pass it explicitly so an override applies.
    cr.addPropertyOverride('ManagedTag', { Key: tag.key, Value: tag.value });
    // The Peers array drives the Lambda: it creates every unique pair as a peering,
    // writes routes in both directions, and tags everything for idempotent re-runs.
    cr.addPropertyOverride(
      'Peers',
      props.peers.map((p) => ({
        Role: p.role ?? '',
        Region: p.region,
        VpcId: p.vpcId,
        VpcCidr: p.vpcCidr,
        RouteTableIds: p.routeTableIds,
      })),
    );

    this.configurator = fn;
  }
}
