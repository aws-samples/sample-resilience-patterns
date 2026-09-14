import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { LoadGenerator } from './constructs/load-generation';
import { APP_RECORD_NAME, AZ_COUNT } from '../regions';

export interface LoadGenStackProps extends cdk.StackProps {
  readonly appId: string;
}

/**
 * The synthetic users (step 4c). Locust on Fargate in the PRIMARY region's isolated
 * subnets — Option A's one set of users that follows the failover.
 *
 * TARGET. `http://app.eks-mr-demo.internal` — the Route 53 latency record, as a
 * SYNTH-TIME CONSTANT from `regions.ts`, shared with the DNS stack that creates the
 * record and (step 8) the ARC plan that flips it. `LoadGenerator.targetUrl` requires a
 * synth-time string, and this is why threading the raw NLB hostname instead would be
 * wrong twice over: it is a deploy-time value, and users pinned to one region's load
 * balancer can never follow the failover.
 *
 * WORKLOAD. `src/locust/` overlays the construct's build context: reads (GET /orders)
 * and writes (POST /orders), emitting ClientSuccess/ClientError/ClientLatency — the
 * exact names the availability alarm reads — plus Region-dimensioned metrics
 * attributed from the app's own response. The stock workload's Success/Error names
 * would leave the alarm in INSUFFICIENT_DATA forever.
 *
 * PLACEMENT. Its own stack, deployed AFTER `dns` (factory Phase 6), not inside the
 * RegionStack: the region stacks deploy before the app or the DNS records exist, and
 * a load generator started then would hammer an unresolvable name — flooding the
 * availability alarm with deploy-sequencing noise dressed up as an outage.
 *
 * NETWORK PATH. Task → NLB (same VPC, or over peering after failover) → NodePort.
 * With client IP preservation the node sees the TASK's address, so the RegionStacks
 * admit both their own VPC CIDR and the peer CIDR on the NodePort range. The isolated
 * subnets carry the ECR/ECR_DOCKER/LOGS endpoints the construct documents as required
 * (present since steps 3a/3b), and image layers ride the free S3 gateway endpoint.
 */
export class LoadGenStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LoadGenStackProps) {
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

    const vpcId = new cdk.CfnParameter(this, 'VpcId', {
      type: 'String',
      description: 'VPC id of the primary RegionStack the load generator runs in.',
    });
    const subnetIds = new cdk.CfnParameter(this, 'IsolatedSubnetIds', {
      type: 'CommaDelimitedList',
      description: 'Private-isolated subnet ids of the primary RegionStack.',
    });
    const azs = new cdk.CfnParameter(this, 'IsolatedSubnetAzs', {
      type: 'CommaDelimitedList',
      description: 'Availability zones matching IsolatedSubnetIds, in the same order.',
    });

    // Fixed-length arrays via Fn.select over AZ_COUNT, NOT the raw list tokens — same
    // pattern (and same reason) as SecondaryDbStack: `Vpc.fromVpcAttributes` given a
    // list token can only materialize ONE synthetic subnet.
    const indices = Array.from({ length: AZ_COUNT }, (_, i) => i);
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'PrimaryVpc', {
      vpcId: vpcId.valueAsString,
      availabilityZones: indices.map((i) => cdk.Fn.select(i, azs.valueAsList)),
      isolatedSubnetIds: indices.map((i) => cdk.Fn.select(i, subnetIds.valueAsList)),
    });

    new LoadGenerator(this, 'LoadGen', {
      vpc,
      // The construct defaults to PRIVATE_WITH_EGRESS, which this VPC does not have.
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      targetUrl: `http://${APP_RECORD_NAME}`,
      // Documentation only — the overlay locustfile defines its own /orders tasks.
      targetPath: '/orders',
      // The demo workload: reads + writes + the emf_helper the alarms depend on.
      workloadDirectory: path.join(__dirname, '..', '..', 'locust'),
      // Defaults kept explicit where they are contracts:
      //   architecture ARM64 — matches the CI runners; kaniko cannot cross-build, the
      //   same constraint that moved the EKS nodes to Graviton in step 3b.
      //   emfNamespace default — the shared DEMO_METRIC_NAMESPACE constant both this
      //   container's helper and DemoObservability read.
      requestTimeoutSeconds: 5,
      users: 10,
      spawnRate: 10,
      desiredCount: 1,
    });

    new cdk.CfnOutput(this, 'TargetRecordName', { value: APP_RECORD_NAME });
  }
}
