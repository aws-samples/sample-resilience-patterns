import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { OBSERVER_CIDR, PRIMARY_REGION, REGIONS } from '../regions';

export interface ObserverStackProps extends cdk.StackProps {
  readonly appId: string;
  /** Observer VPC CIDR (defaults to {@link OBSERVER_CIDR}). Must overlap no workload CIDR. */
  readonly observerCidr?: string;
}

/**
 * The observer VPC (step 12) — a THIRD region that stands in for the customer's operator
 * AND the customer's clients.
 *
 * Modeled on drs-mr-demo/templates/10-observer.yaml. It replaces the old CloudFront
 * signed-cookie front
 * door: instead of exposing the Argo UI on the public internet behind a signed-cookie
 * gate, an operator reaches each region's INTERNAL ALB (see OperatorAccessStack) through a
 * bastion here — no public IP, no inbound rules, reached ONLY via SSM Session Manager, and
 * VPC-peered into both workload regions. `build/tunnel.sh` port-forwards over that bastion.
 * Surviving anything done to either workload region is the point, so the observer lives in
 * a region that is neither workload region.
 *
 * THE LOAD GENERATOR LIVES HERE TOO (LoadGenStack deploys into this VPC). The synthetic
 * users used to run in the primary region's isolated subnets, which meant a real loss of
 * the primary region took the client's view of the outage down with it. Clients belong
 * outside both workload regions for the same reason the operator does. That is why this
 * VPC carries ECR and CloudWatch Logs endpoints as well as the SSM three: a Fargate task
 * with no internet route pulls its image and ships its logs only through them.
 *
 * CROSS-REGION IDS ARE PARAMETERS, NOT IMPORTS. The workload VPC ids live in other
 * regions; CloudFormation exports are region-scoped, so they are threaded here as
 * CfnParameters off the deploy rail's dotenv mechanism (the same pattern PeeringStack
 * uses), never Fn::ImportValue. This stack is the REQUESTER of both peering connections;
 * the ACCEPTER-side routes back into the workload VPCs are added by the deploy rail using
 * the peering ids this stack outputs (there is no native cross-region accept or route
 * resource).
 */
export class ObserverStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ObserverStackProps) {
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

    const observerCidr = props.observerCidr ?? OBSERVER_CIDR;

    // The workload VPC ids (cross-region -> parameters) and their CIDRs (routes + egress).
    // R<i> matches the deploy rail's threaded REGION_<i>_* dotenv keys, mirroring
    // PeeringStack's contract with createDeployTasks.
    const workloads = REGIONS.map((region, i) => {
      const vpcId = new cdk.CfnParameter(this, `R${i}VpcId`, {
        type: 'String',
        description: `VPC id of the ${region.name} region stack (cross-region, so a parameter).`,
      });
      const vpcCidr = new cdk.CfnParameter(this, `R${i}VpcCidr`, {
        type: 'String',
        default: region.cidr,
        description: `VPC CIDR of the ${region.name} region stack.`,
      });
      return { region: region.name, vpcId: vpcId.valueAsString, cidr: vpcCidr.valueAsString };
    });

    // ---- the observer VPC: one private subnet, its own route table -------------------
    const vpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: observerCidr,
      enableDnsSupport: true,
      enableDnsHostnames: true,
      tags: [{ key: 'Name', value: `${props.appId}-observer-vpc` }],
    });

    // A /24 carved from the observer CIDR, in the first AZ. Fn.select/Fn.cidr keeps this
    // deploy-time so the region's real AZ list resolves at deploy, not synth.
    const subnet = new ec2.CfnSubnet(this, 'PrivateSubnet', {
      vpcId: vpc.ref,
      cidrBlock: cdk.Fn.select(0, cdk.Fn.cidr(observerCidr, 4, '8')),
      availabilityZone: cdk.Fn.select(0, cdk.Fn.getAzs('')),
      mapPublicIpOnLaunch: false,
      tags: [{ key: 'Name', value: `${props.appId}-observer-private` }],
    });

    const routeTable = new ec2.CfnRouteTable(this, 'RouteTable', {
      vpcId: vpc.ref,
      tags: [{ key: 'Name', value: `${props.appId}-observer-rt` }],
    });
    new ec2.CfnSubnetRouteTableAssociation(this, 'SubnetRoute', {
      subnetId: subnet.ref,
      routeTableId: routeTable.ref,
    });

    // ---- peering to both workload VPCs (requester side) + routes ---------------------
    // The accepter side (in each workload region) is completed by the deploy rail from the
    // peering ids output below — there is no cross-region accept resource in CloudFormation.
    const peeringRefs: string[] = [];
    workloads.forEach((w, i) => {
      const peering = new ec2.CfnVPCPeeringConnection(this, `PeeringTo${i}`, {
        vpcId: vpc.ref,
        peerVpcId: w.vpcId,
        peerRegion: w.region,
        tags: [{ key: 'Name', value: `${props.appId}-observer-to-${w.region}` }],
      });
      peeringRefs.push(peering.ref);
      new ec2.CfnRoute(this, `RouteTo${i}`, {
        routeTableId: routeTable.ref,
        destinationCidrBlock: w.cidr,
        vpcPeeringConnectionId: peering.ref,
      });
    });

    // ---- AWS reachability with no internet path: interface endpoints + the S3 gateway
    //
    // Two consumers share these. The bastion needs the three Systems Manager endpoints.
    // The load generator (LoadGenStack, deployed into this VPC) is a Fargate task in a
    // subnet with no internet route, and the ECS documentation is explicit about what
    // that needs: the ecr.api and ecr.dkr interface endpoints plus an S3 gateway endpoint
    // to pull its image, and a CloudWatch Logs interface endpoint because it ships EMF
    // through the awslogs driver. Tasks on Fargate need no ECS endpoints of their own.
    const endpointSg = new ec2.CfnSecurityGroup(this, 'EndpointSecurityGroup', {
      groupDescription: 'HTTPS from the observer VPC to the interface endpoints',
      vpcId: vpc.ref,
      securityGroupIngress: [
        {
          ipProtocol: 'tcp',
          fromPort: 443,
          toPort: 443,
          cidrIp: observerCidr,
          description: 'observer VPC to the interface endpoints',
        },
      ],
      // Interface endpoints only ANSWER, and security groups are stateful, so replies to the
      // admitted inbound flows need no egress rule. Without an explicit list CloudFormation
      // applies its allow-all default (cfn_nag F1000). This unroutable ICMP rule is the exact
      // shape CDK emits for `allowAllOutbound: false` -- the same rule the region stacks'
      // endpoint SGs carry -- so "no egress" is stated in the template rather than implied.
      securityGroupEgress: [
        {
          ipProtocol: 'icmp',
          fromPort: 252,
          toPort: 86,
          cidrIp: '255.255.255.255/32',
          description: 'Disallow all traffic',
        },
      ],
      tags: [{ key: 'Name', value: `${props.appId}-observer-vpce-sg` }],
    });

    const serviceName = (svc: string): string => `com.amazonaws.${this.region}.${svc}`;
    // Logical ids are spelled out rather than derived so the three SSM endpoints keep the
    // ids they were first deployed with (a changed logical id is a replace, not an update).
    const interfaceEndpoints: Record<string, string> = {
      SsmEndpoint: 'ssm',
      SsmMessagesEndpoint: 'ssmmessages',
      Ec2MessagesEndpoint: 'ec2messages',
      EcrApiEndpoint: 'ecr.api',
      EcrDockerEndpoint: 'ecr.dkr',
      LogsEndpoint: 'logs',
    };
    for (const [logicalId, svc] of Object.entries(interfaceEndpoints)) {
      new ec2.CfnVPCEndpoint(this, logicalId, {
        vpcId: vpc.ref,
        serviceName: serviceName(svc),
        vpcEndpointType: 'Interface',
        privateDnsEnabled: true,
        subnetIds: [subnet.ref],
        securityGroupIds: [endpointSg.ref],
      });
    }
    // Image LAYERS come from S3 (ECR stores them there), so the pull needs this gateway
    // as well as the two ECR interface endpoints. A gateway endpoint is a route-table
    // entry, not an ENI: no subnet, no security group, and no hourly charge.
    new ec2.CfnVPCEndpoint(this, 'S3GatewayEndpoint', {
      vpcId: vpc.ref,
      serviceName: serviceName('s3'),
      vpcEndpointType: 'Gateway',
      routeTableIds: [routeTable.ref],
    });

    // ---- the bastion: SSM only. No inbound. Egress to the endpoints + workload VPCs. ---
    const bastionRole = new iam.CfnRole(this, 'BastionRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      },
      managedPolicyArns: ['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'],
    });
    const bastionProfile = new iam.CfnInstanceProfile(this, 'BastionProfile', {
      roles: [bastionRole.ref],
    });

    // NO ingress. Egress: 443 to the SSM endpoints (observer CIDR) and 80 to each
    // workload ALB (workload CIDRs). No `->` in any description (EC2 charset).
    const bastionSg = new ec2.CfnSecurityGroup(this, 'BastionSecurityGroup', {
      groupDescription: 'Observer bastion - no inbound; egress to SSM endpoints and the workload ALBs only',
      vpcId: vpc.ref,
      securityGroupEgress: [
        {
          ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: observerCidr,
          description: 'SSM interface endpoints',
        },
        ...workloads.map((w) => ({
          ipProtocol: 'tcp', fromPort: 80, toPort: 80, cidrIp: w.cidr,
          description: `${w.region} access door ALB`,
        })),
      ],
      tags: [{ key: 'Name', value: `${props.appId}-observer-bastion-sg` }],
    });

    // Graviton nano on the latest AL2023 arm64 AMI, resolved from the standard SSM public
    // parameter AT DEPLOY TIME (a CloudFormation dynamic parameter of type
    // AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>) so the template never pins a stale
    // AMI id. NOT a CfnParameter: nothing on the deploy rail has a reason to override it,
    // and the template-vs-deploy contract test rightly requires every declared parameter
    // to be threaded by a deploy step.
    const amiId = ssm.StringParameter.valueForTypedStringParameterV2(
      this,
      '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64',
      ssm.ParameterValueType.AWS_EC2_IMAGE_ID,
    );
    const bastion = new ec2.CfnInstance(this, 'Bastion', {
      imageId: amiId,
      instanceType: 't4g.nano',
      subnetId: subnet.ref,
      iamInstanceProfile: bastionProfile.ref,
      securityGroupIds: [bastionSg.ref],
      tags: [
        { key: 'Name', value: `${props.appId}-observer-bastion` },
        { key: `${props.appId}:role`, value: 'observer-bastion' },
      ],
    });

    // Outputs consumed by build/tunnel.sh (BastionInstanceId), by the deploy rail's
    // accepter-side route step (the peering ids, per workload region), and by
    // LoadGenStack, which places its Fargate task in this subnet (PrivateSubnetId/Az).
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.ref });
    new cdk.CfnOutput(this, 'VpcCidr', { value: observerCidr });
    new cdk.CfnOutput(this, 'PrivateSubnetId', {
      value: subnet.ref,
      description: 'The observer private subnet. The load generator runs here.',
    });
    new cdk.CfnOutput(this, 'PrivateSubnetAz', {
      value: subnet.attrAvailabilityZone,
      description: 'Availability zone of PrivateSubnetId, for Vpc.fromVpcAttributes.',
    });
    new cdk.CfnOutput(this, 'BastionInstanceId', { value: bastion.ref });
    workloads.forEach((w, i) => {
      new cdk.CfnOutput(this, `PeeringTo${i}Id`, {
        value: peeringRefs[i],
        description: `VPC peering connection id, observer -> ${w.region}. The accepter route lives in ${w.region}.`,
      });
    });
    // A convenience marker so the rail can assert the primary region matches expectation.
    new cdk.CfnOutput(this, 'PrimaryRegion', { value: PRIMARY_REGION });
  }
}
