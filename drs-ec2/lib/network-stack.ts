import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface NetworkStackProps extends cdk.StackProps {
  readonly project: string;
  /** Names the VPC and its exports (`<project>-<role>-VpcId` ...). */
  readonly role: 'primary' | 'secondary';
  /** /16 for this VPC; subnets are carved as <a>.<b>.{0,1,10,11}.0/24. */
  readonly cidr: string;
  readonly peer: {
    readonly region: string;
    readonly cidr: string;
    /** Primary only: when set, create the peering connection to this (secondary) VPC. */
    readonly vpcId?: string;
    /** Secondary only: the peering id created by the primary, once accepted, for the return route. */
    readonly acceptPeeringId?: string;
  };
  readonly observer: {
    readonly cidr: string;
    /** Peering id created by the observer stack; adds the return route when set. */
    readonly peeringId?: string;
  };
}

/**
 * A workload VPC: 2 public + 2 private /24s across two AZs, IGW, one NAT in public-1, and the
 * private route table's peering routes. Explicit subnets (not ec2.Vpc's auto layout) because the
 * DRS staging subnet and downstream stacks reference the exact CIDRs and exported ids.
 *
 * Peering is requester-side on the primary and accepted by the Makefile (CLI) -- CloudFormation
 * cannot accept a cross-region peering itself. Routes are added on the second `make deploy` pass,
 * once the peering / observer ids exist (the template Conditions become optional props here).
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.CfnVPC;
  public readonly privateSubnets: ec2.CfnSubnet[];
  public readonly publicSubnets: ec2.CfnSubnet[];
  public readonly privateRouteTable: ec2.CfnRouteTable;
  public readonly peering?: ec2.CfnVPCPeeringConnection;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { project, role } = props;
    const name = (s: string) => `${project}-${role}-${s}`;
    const base = props.cidr.split('.').slice(0, 2).join('.'); // "10.0"
    const azs = cdk.Fn.getAzs();

    this.vpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: props.cidr, enableDnsSupport: true, enableDnsHostnames: true,
      tags: [{ key: 'Name', value: name('vpc') }],
    });
    const igw = new ec2.CfnInternetGateway(this, 'Igw', { tags: [{ key: 'Name', value: name('igw') }] });
    const igwAttach = new ec2.CfnVPCGatewayAttachment(this, 'IgwAttach', { vpcId: this.vpc.ref, internetGatewayId: igw.ref });

    const subnet = (lid: string, third: number, az: number, pub: boolean, tag: string) =>
      new ec2.CfnSubnet(this, lid, {
        vpcId: this.vpc.ref, cidrBlock: `${base}.${third}.0/24`, availabilityZone: cdk.Fn.select(az, azs),
        ...(pub ? { mapPublicIpOnLaunch: true } : {}),
        tags: [{ key: 'Name', value: name(tag) }],
      });
    this.publicSubnets = [subnet('PublicSubnet1', 0, 0, true, 'public-1'), subnet('PublicSubnet2', 1, 1, true, 'public-2')];
    this.privateSubnets = [subnet('PrivateSubnet1', 10, 0, false, 'private-1'), subnet('PrivateSubnet2', 11, 1, false, 'private-2')];

    const publicRt = new ec2.CfnRouteTable(this, 'PublicRouteTable', { vpcId: this.vpc.ref, tags: [{ key: 'Name', value: name('public-rt') }] });
    const publicDefault = new ec2.CfnRoute(this, 'PublicDefaultRoute', { routeTableId: publicRt.ref, destinationCidrBlock: '0.0.0.0/0', gatewayId: igw.ref });
    publicDefault.addDependency(igwAttach);
    this.publicSubnets.forEach((s, i) => new ec2.CfnSubnetRouteTableAssociation(this, `PublicSubnet${i + 1}RtAssoc`, { subnetId: s.ref, routeTableId: publicRt.ref }));

    const natEip = new ec2.CfnEIP(this, 'NatEip', { domain: 'vpc' });
    natEip.addDependency(igwAttach);
    const nat = new ec2.CfnNatGateway(this, 'NatGateway', {
      allocationId: natEip.attrAllocationId, subnetId: this.publicSubnets[0].ref, tags: [{ key: 'Name', value: name('nat') }],
    });
    this.privateRouteTable = new ec2.CfnRouteTable(this, 'PrivateRouteTable', { vpcId: this.vpc.ref, tags: [{ key: 'Name', value: name('private-rt') }] });
    new ec2.CfnRoute(this, 'PrivateDefaultRoute', { routeTableId: this.privateRouteTable.ref, destinationCidrBlock: '0.0.0.0/0', natGatewayId: nat.ref });
    this.privateSubnets.forEach((s, i) => new ec2.CfnSubnetRouteTableAssociation(this, `PrivateSubnet${i + 1}RtAssoc`, { subnetId: s.ref, routeTableId: this.privateRouteTable.ref }));

    // Peering: primary requests; secondary routes back once accepted.
    let peerRouteTarget: string | undefined;
    if (role === 'primary' && props.peer.vpcId) {
      this.peering = new ec2.CfnVPCPeeringConnection(this, 'VpcPeering', {
        vpcId: this.vpc.ref, peerVpcId: props.peer.vpcId, peerRegion: props.peer.region,
        tags: [{ key: 'Name', value: `${project}-peering` }],
      });
      peerRouteTarget = this.peering.ref;
    } else if (role === 'secondary' && props.peer.acceptPeeringId) {
      peerRouteTarget = props.peer.acceptPeeringId;
    }
    if (peerRouteTarget) {
      new ec2.CfnRoute(this, 'PeerRoutePrivate', {
        routeTableId: this.privateRouteTable.ref, destinationCidrBlock: props.peer.cidr, vpcPeeringConnectionId: peerRouteTarget,
      });
    }
    if (props.observer.peeringId) {
      new ec2.CfnRoute(this, 'ObserverRoutePrivate', {
        routeTableId: this.privateRouteTable.ref, destinationCidrBlock: props.observer.cidr, vpcPeeringConnectionId: props.observer.peeringId,
      });
    }

    const out = (key: string, value: string, exportName: string) =>
      new cdk.CfnOutput(this, key, { value, exportName: `${project}-${exportName}` });
    out('VpcId', this.vpc.ref, `${role}-VpcId`);
    out('VpcCidr', props.cidr, `${role}-VpcCidr`);
    out('PublicSubnets', cdk.Fn.join(',', this.publicSubnets.map((s) => s.ref)), `${role}-PublicSubnets`);
    out('PrivateSubnets', cdk.Fn.join(',', this.privateSubnets.map((s) => s.ref)), `${role}-PrivateSubnets`);
    out('PrivateRouteTableId', this.privateRouteTable.ref, `${role}-PrivateRtId`);
    if (this.peering) {
      out('PeeringConnectionId', this.peering.ref, 'PeeringConnectionId');
    }
  }
}
