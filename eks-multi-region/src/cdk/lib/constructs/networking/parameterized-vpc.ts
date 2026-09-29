import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * Ported largely verbatim from the predecessor project-app:
 *   src/cdk/lib/constructs/parameterized-vpc.ts:1-216
 *
 * Zero the predecessor project coupling — this is the reuse keystone. The deploy-time CIDR
 * (Fn::Cidr) + deploy-time AZ selection (Fn::GetAZs/Fn::Select) approach is what
 * lets a single template deploy to N regions with different CfnParameter CIDRs.
 */

export interface SubnetSpec {
  /** Logical prefix for the subnet construct IDs (e.g. 'Public', 'Private'). */
  readonly name: string;
  /** Subnet kind (affects route table defaults + downstream consumers). */
  readonly subnetType: ec2.SubnetType;
  /** Whether to associate a PublicIpOnLaunch flag. Derived from subnetType if omitted. */
  readonly mapPublicIpOnLaunch?: boolean;
}

export interface ParameterizedVpcProps {
  /** VPC CIDR. May be a CfnParameter token. */
  readonly vpcCidr: string;
  /**
   * Ordered list of subnet tiers. One subnet per AZ per tier is produced,
   * carved from the VPC CIDR using `Fn::Cidr` so subnet blocks are assigned
   * deterministically from the top of the VPC CIDR.
   *
   * Example: 3 AZs × [Public, Private] → 6 subnets.
   */
  readonly subnets: SubnetSpec[];
  /** Number of /24 bits to carve from the VPC CIDR for each subnet. Default 8. */
  readonly cidrMaskBits?: number;
  /** Number of AZs to use. Default 3. AZ names come from `Fn::GetAZs`. */
  readonly azCount?: number;
  /** If true, provision a single NAT gateway in the first public subnet. */
  readonly includeNatGateway?: boolean;
  /**
   * If true, attach an Internet Gateway to the VPC even when there are
   * no public subnets. CloudFront VPC origins require the VPC to have
   * an IGW attached — CloudFront checks the VPC's "can receive traffic
   * from the internet" flag, not the subnet routing tables. The IGW is
   * otherwise unused in this case; traffic to/from VPC origins goes
   * through CloudFront's managed ENIs, not through the IGW.
   *
   * Implied true when any subnet tier is PUBLIC.
   */
  readonly includeInternetGateway?: boolean;
}

/**
 * A VPC whose CIDR is supplied at deploy time via a CfnParameter. The L2
 * `ec2.Vpc` construct requires a literal CIDR (it subdivides subnets during
 * synth), so this helper builds `CfnVPC` + `CfnSubnet` directly and exposes
 * an `ec2.IVpc` for downstream consumers.
 *
 * Subnets are carved from the VPC CIDR via `Fn::Cidr`, so changing the
 * parameter at deploy time automatically shifts the subnet ranges.
 */
export class ParameterizedVpc extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly vpcId: string;
  public readonly vpcCidrBlock: string;
  public readonly publicSubnets: ec2.ISubnet[] = [];
  public readonly privateSubnets: ec2.ISubnet[] = [];
  public readonly isolatedSubnets: ec2.ISubnet[] = [];
  public readonly internetGatewayId?: string;
  public readonly natGatewayId?: string;

  private readonly allSubnets: ec2.ISubnet[] = [];

  constructor(scope: Construct, id: string, props: ParameterizedVpcProps) {
    super(scope, id);

    const azCount = props.azCount ?? 3;
    const cidrMaskBits = props.cidrMaskBits ?? 8;
    // AZ names are resolved at deploy time via Fn::GetAZs. We don't want
    // to hardcode letter suffixes — ca-central-1 skips 'c' and uses 'd',
    // and other partitions/regions have their own quirks. Fn::GetAZs
    // returns the actual list of AZ names for the region the stack is
    // deployed in, which we then Select from by index.
    const azList = cdk.Fn.getAzs(cdk.Aws.REGION);
    const azs = Array.from({ length: azCount }, (_, i) => cdk.Fn.select(i, azList));

    // --- VPC resource -------------------------------------------------------
    const cfnVpc = new ec2.CfnVPC(this, 'Resource', {
      cidrBlock: props.vpcCidr,
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });
    this.vpcId = cfnVpc.ref;
    this.vpcCidrBlock = props.vpcCidr;

    // --- Internet gateway ----------------------------------------------------
    // An IGW is created when:
    //   - the VPC has PUBLIC subnets (routed via 0.0.0.0/0 → IGW), OR
    //   - the caller explicitly asks for one via includeInternetGateway.
    //     CloudFront VPC origins require an IGW attachment on the VPC
    //     even though traffic never flows through it — it's a static
    //     "this VPC can face the internet" flag that CloudFront checks.
    const hasPublic = props.subnets.some((s) => s.subnetType === ec2.SubnetType.PUBLIC);
    const needsIgw = hasPublic || (props.includeInternetGateway ?? false);
    let igw: ec2.CfnInternetGateway | undefined;
    if (needsIgw) {
      igw = new ec2.CfnInternetGateway(this, 'IGW', {});
      new ec2.CfnVPCGatewayAttachment(this, 'IGWAttachment', {
        vpcId: this.vpcId,
        internetGatewayId: igw.ref,
      });
      this.internetGatewayId = igw.ref;
    }

    // --- Subnets ------------------------------------------------------------
    // `Fn::Cidr(vpcCidr, count, cidrBits)` → list of CIDR strings to carve.
    const totalSubnets = props.subnets.length * azCount;
    const subnetCidrs = cdk.Fn.cidr(props.vpcCidr, totalSubnets, cidrMaskBits.toString());

    // Track first-public-subnet RTB (needed for NAT gateway routing)
    let firstPublicRtb: ec2.CfnRouteTable | undefined;
    let firstPublicSubnetId: string | undefined;

    let subnetIndex = 0;
    for (const spec of props.subnets) {
      const bucket = this.bucketFor(spec.subnetType);

      for (let azIdx = 0; azIdx < azCount; azIdx++) {
        const az = azs[azIdx];
        const subnetCidr = cdk.Fn.select(subnetIndex, subnetCidrs);
        const logicalId = `${spec.name}Subnet${azIdx + 1}`;

        const cfnSubnet = new ec2.CfnSubnet(this, logicalId, {
          vpcId: this.vpcId,
          cidrBlock: subnetCidr,
          availabilityZone: az,
          mapPublicIpOnLaunch:
            spec.mapPublicIpOnLaunch ?? spec.subnetType === ec2.SubnetType.PUBLIC,
        });

        const rtb = new ec2.CfnRouteTable(this, `${logicalId}RouteTable`, {
          vpcId: this.vpcId,
        });

        new ec2.CfnSubnetRouteTableAssociation(this, `${logicalId}RouteTableAssociation`, {
          subnetId: cfnSubnet.ref,
          routeTableId: rtb.ref,
        });

        // Default routes per subnet type
        if (spec.subnetType === ec2.SubnetType.PUBLIC && igw) {
          new ec2.CfnRoute(this, `${logicalId}DefaultRoute`, {
            routeTableId: rtb.ref,
            destinationCidrBlock: '0.0.0.0/0',
            gatewayId: igw.ref,
          });
          if (!firstPublicRtb) {
            firstPublicRtb = rtb;
            firstPublicSubnetId = cfnSubnet.ref;
          }
        }

        const subnet = ec2.Subnet.fromSubnetAttributes(this, `${logicalId}Ref`, {
          subnetId: cfnSubnet.ref,
          availabilityZone: az,
          routeTableId: rtb.ref,
          ipv4CidrBlock: subnetCidr,
        });

        bucket.push(subnet);
        this.allSubnets.push(subnet);
        subnetIndex++;
      }
    }

    // --- NAT gateway (single, in first public AZ) ----------------------------
    if (props.includeNatGateway && firstPublicSubnetId && firstPublicRtb) {
      const eip = new ec2.CfnEIP(this, 'NatEip', { domain: 'vpc' });
      const nat = new ec2.CfnNatGateway(this, 'NatGateway', {
        subnetId: firstPublicSubnetId,
        allocationId: eip.attrAllocationId,
      });
      this.natGatewayId = nat.ref;

      // Default route on every private-with-egress subnet's RTB → NAT
      for (let i = 0; i < this.privateSubnets.length; i++) {
        const rtbId = this.privateSubnets[i].routeTable.routeTableId;
        new ec2.CfnRoute(this, `PrivateDefaultRoute${i}`, {
          routeTableId: rtbId,
          destinationCidrBlock: '0.0.0.0/0',
          natGatewayId: nat.ref,
        });
      }
    }

    // --- Expose an IVpc so downstream L2 constructs work --------------------
    this.vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: this.vpcId,
      vpcCidrBlock: this.vpcCidrBlock,
      availabilityZones: azs,
      publicSubnetIds: this.publicSubnets.map((s) => s.subnetId),
      publicSubnetRouteTableIds: this.publicSubnets.map((s) => s.routeTable.routeTableId),
      privateSubnetIds: this.privateSubnets.map((s) => s.subnetId),
      privateSubnetRouteTableIds: this.privateSubnets.map((s) => s.routeTable.routeTableId),
      isolatedSubnetIds: this.isolatedSubnets.map((s) => s.subnetId),
      isolatedSubnetRouteTableIds: this.isolatedSubnets.map((s) => s.routeTable.routeTableId),
    });
  }

  // --- helpers --------------------------------------------------------------

  private bucketFor(type: ec2.SubnetType): ec2.ISubnet[] {
    switch (type) {
      case ec2.SubnetType.PUBLIC:
        return this.publicSubnets;
      case ec2.SubnetType.PRIVATE_WITH_EGRESS:
      case ec2.SubnetType.PRIVATE_WITH_NAT:
        return this.privateSubnets;
      case ec2.SubnetType.PRIVATE_ISOLATED:
        return this.isolatedSubnets;
      default:
        throw new Error(`Unsupported subnet type: ${type}`);
    }
  }
}
