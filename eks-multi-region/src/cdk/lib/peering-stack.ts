import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { PeeringMesh } from './constructs/networking';
import { REGIONS } from '../regions';

export interface PeeringStackProps extends cdk.StackProps {
  readonly appId: string;
}

/**
 * Cross-region VPC peering between every region's VPC.
 *
 * REINSTATED. An earlier decision (D-008) dropped this on the reasoning that nothing in
 * the demo is VPC-routed across regions: Aurora Global Database replication rides the AWS
 * network, ARC Region switch uses per-region service endpoints, and traffic shifting is
 * DNS. All three were true. What the reasoning missed is that **DNS resolves names, it
 * does not move packets** — so a client that follows the failover from one region to the
 * other needs an actual network path, and the application's load balancer is internal.
 *
 * The source repository this demo is adapted from carries both a DNS stack and a peering
 * stack for exactly this reason.
 *
 * WHAT PEERING ALONE DOES NOT GIVE YOU. Two things beyond the connection itself:
 *
 *   1. A route in each side's route tables. `PeeringMesh` adds those, on both sides, via a
 *      custom-resource Lambda — there is no native cross-region accept or cross-region
 *      route resource, so it cannot be done declaratively.
 *   2. A node security group rule admitting the PEER CIDR on the NodePort range. That one
 *      lives in `RegionStack` and is the non-obvious half: the in-tree service controller
 *      creates NLBs with instance targets, where client IP preservation is on by default,
 *      so the node sees the original cross-region client address rather than the load
 *      balancer's. Without that rule every cross-region request times out while peering,
 *      routes, DNS and the load balancer all look correct.
 *
 * Deployed into the FIRST region; the configurator Lambda reaches the others with regional
 * boto3 clients. Parameter names (`R<i>*`) are the ones the deploy task factory threads
 * from each region stack's dotenv — they are a contract with `createDeployTasks`, not a
 * local choice.
 */
export class PeeringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PeeringStackProps) {
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
      description: 'Key prefix inside AssetsBucketName (trailing slash required).',
    });

    const peers = REGIONS.map((region, i) => {
      const vpcId = new cdk.CfnParameter(this, `R${i}VpcId`, {
        type: 'String',
        description: `VPC id of the ${region.name} region stack.`,
      });
      const vpcCidr = new cdk.CfnParameter(this, `R${i}VpcCidr`, {
        type: 'String',
        description: `VPC CIDR of the ${region.name} region stack.`,
      });
      const routeTableIds = new cdk.CfnParameter(this, `R${i}RouteTableIds`, {
        type: 'CommaDelimitedList',
        description: `Non-public route tables of the ${region.name} region stack.`,
      });
      // R<i>Region is threaded by the factory too. Declared so CloudFormation accepts the
      // changeset, and used as the peer's region so the value that reaches the
      // configurator is the one the region stack actually reported rather than a literal
      // compiled in here.
      const regionParam = new cdk.CfnParameter(this, `R${i}Region`, {
        type: 'String',
        default: region.name,
        description: `AWS region of peer ${i}.`,
      });
      return {
        region: regionParam.valueAsString,
        vpcId: vpcId.valueAsString,
        vpcCidr: vpcCidr.valueAsString,
        // A token list is fine here: these become custom-resource PROPERTIES, resolved at
        // deploy time. That is unlike `Vpc.fromVpcAttributes`, which needs a length known
        // at synth time and silently yields one synthetic entry from a token.
        routeTableIds: routeTableIds.valueAsList,
      };
    });

    new PeeringMesh(this, 'Mesh', {
      peers,
      managedTag: { key: 'ManagedBy', value: props.appId },
    });
  }
}
