// Adapted from aws-samples/sample-resilience-patterns@9091f42 (MIT-0):
// aurora/lib/database-replica-stack.ts.
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { AuroraMember } from './aurora-member';
import { AZ_COUNT } from '../regions';

export interface SecondaryDbStackProps extends cdk.StackProps {
  readonly appId: string;
  /** This stack's region — the secondary. */
  readonly regionName: string;
}

/**
 * The secondary Aurora member, in its OWN stack.
 *
 * WHY A SEPARATE STACK. A member joins an Aurora global cluster by declaring
 * `globalClusterIdentifier`, which requires the global cluster to ALREADY EXIST. The
 * global cluster in turn adopts the primary member. So the ordering is forced:
 *
 *     RegionStack(primary)  →  GlobalDataStack  →  SecondaryDbStack
 *
 * Folding this member into the secondary RegionStack — as the design originally did —
 * would put it at deploy position 2, ahead of the global cluster it needs, and the
 * deploy would fail. Splitting it out keeps both RegionStacks deployable early (so the
 * secondary region's network and EKS are not gated behind the primary's database) and
 * matches the shape the source repo proved.
 *
 * It reuses the secondary region's existing VPC by lookup-free import rather than
 * creating a second one, so the composition rule against duplicating baseline
 * networking still holds.
 */
export class SecondaryDbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SecondaryDbStackProps) {
    super(scope, id, props);

    new cdk.CfnParameter(this, 'AssetsBucketName', {
      type: 'String',
      description: 'S3 bucket holding the synthesized templates and asset objects.',
    });
    new cdk.CfnParameter(this, 'AssetsBucketPrefix', {
      type: 'String',
      description: 'Key prefix inside AssetsBucketName (trailing slash required).',
    });

    // Threaded from GlobalDataStack's output. This parameter is the whole reason this
    // stack exists separately — its value cannot be known until the global cluster is
    // created.
    const globalClusterId = new cdk.CfnParameter(this, 'GlobalClusterIdentifier', {
      type: 'String',
      description: 'Identifier of the existing global cluster this member joins.',
    });

    // Reuse the secondary region's VPC, threaded as parameters rather than looked up:
    // an `ec2.Vpc.fromLookup` needs account credentials at SYNTH time, which the build
    // stage deliberately does not have.
    const vpcId = new cdk.CfnParameter(this, 'VpcId', {
      type: 'String',
      description: 'VPC of the secondary RegionStack.',
    });
    const subnetIds = new cdk.CfnParameter(this, 'IsolatedSubnetIds', {
      type: 'CommaDelimitedList',
      description: 'Private-isolated subnet ids of the secondary RegionStack.',
    });
    const azs = new cdk.CfnParameter(this, 'IsolatedSubnetAzs', {
      type: 'CommaDelimitedList',
      description: 'Availability zones matching IsolatedSubnetIds, in the same order.',
    });
    // The EKS-managed cluster security group from the secondary RegionStack. That is the
    // group node-group instances actually carry, so it is the peer this database must
    // admit. Threaded as a parameter because the cluster lives in a different stack.
    const eksClusterSgId = new cdk.CfnParameter(this, 'EksClusterSecurityGroupId', {
      type: 'String',
      description: 'EKS cluster security group of the secondary RegionStack.',
    });

    // Fixed-length arrays via Fn.select, NOT the raw list tokens.
    //
    // `Vpc.fromVpcAttributes` given a list token can only materialize ONE synthetic
    // subnet — CDK cannot know a token's length — and Aurora requires at least two, so
    // passing `subnetIds.valueAsList` directly fails synth with
    //   Cluster requires at least 2 subnets, got 1
    // Selecting AZ_COUNT elements gives arrays whose LENGTH is known at synth time while
    // the VALUES stay deploy-time tokens. Same pattern ParameterizedVpc uses internally.
    const indices = Array.from({ length: AZ_COUNT }, (_, i) => i);
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'SecondaryVpc', {
      vpcId: vpcId.valueAsString,
      availabilityZones: indices.map((i) => cdk.Fn.select(i, azs.valueAsList)),
      isolatedSubnetIds: indices.map((i) => cdk.Fn.select(i, subnetIds.valueAsList)),
    });

    const member = new AuroraMember(this, 'Member', {
      vpc,
      namePrefix: props.appId,
      // Presence of this switches AuroraMember into secondary mode: no master
      // credentials, no database name, joins rather than sources.
      joinGlobalClusterId: globalClusterId.valueAsString,
    });

    // Same rule as the primary region's, for the same reason: the L2 admits nothing by
    // default, and without ingress the app's pods fail every request at the TCP connect
    // while synth, build and deploy all stay green.
    member.cluster.connections.allowDefaultPortFrom(
      ec2.Peer.securityGroupId(eksClusterSgId.valueAsString),
      'EKS node group to Aurora',
    );

    new cdk.CfnOutput(this, 'DbClusterArn', { value: member.cluster.clusterArn });
    new cdk.CfnOutput(this, 'DbClusterIdentifier', {
      value: member.cluster.clusterIdentifier,
    });
    new cdk.CfnOutput(this, 'DbReaderEndpoint', {
      value: member.cluster.clusterReadEndpoint.hostname,
      description: 'Local read endpoint for this region — reads stay in-region.',
    });
    new cdk.CfnOutput(this, 'EncryptionKeyArn', { value: member.encryptionKey.keyArn });
  }
}
