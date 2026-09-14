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

    // Same action set as peering-stack.ts:61-73, on `*`: cross-region peering +
    // route + tag actions. The peer VPCs / route tables live in other regions and
    // their ARNs are unknown at synth, so `*` is required. cdk-nag flags this as
    // AwsSolutions-IAM5; a demo that runs cdk-nag should add a documented
    // suppression with this justification.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ec2:CreateVpcPeeringConnection',
          'ec2:AcceptVpcPeeringConnection',
          'ec2:DeleteVpcPeeringConnection',
          'ec2:DescribeVpcPeeringConnections',
          'ec2:CreateRoute',
          'ec2:DeleteRoute',
          'ec2:DescribeRouteTables',
          'ec2:CreateTags',
        ],
        resources: ['*'],
      }),
    );

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
