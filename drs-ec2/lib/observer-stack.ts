import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface ObserverPeer {
  readonly region: string;
  readonly vpcId: string;
  readonly cidr: string;
}

export interface ObserverStackProps extends cdk.StackProps {
  readonly project: string;
  readonly cidr: string;
  readonly primary: ObserverPeer;
  readonly secondary: ObserverPeer;
}

/**
 * The "customer's user": an independent third-region VPC with a Linux bastion that has no public
 * IP and no inbound rules, reachable only through Systems Manager (interface endpoints), peered
 * to both workload VPCs. `make tunnel` port-forwards through it to the private-zone record, so
 * what you see at localhost:8080 is what a client in this VPC sees -- including the DNS flip.
 * Peering is requester-side here; the Makefile accepts in each workload region and the workload
 * network stacks add their return routes on the final pass.
 */
export class ObserverStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ObserverStackProps) {
    super(scope, id, props);
    const { project } = props;
    const name = (s: string) => `${project}-observer-${s}`;

    const vpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: props.cidr, enableDnsSupport: true, enableDnsHostnames: true, tags: [{ key: 'Name', value: name('vpc') }],
    });
    const subnet = new ec2.CfnSubnet(this, 'PrivateSubnet', {
      vpcId: vpc.ref, cidrBlock: cdk.Fn.select(0, cdk.Fn.cidr(props.cidr, 4, '8')),
      availabilityZone: cdk.Fn.select(0, cdk.Fn.getAzs()), mapPublicIpOnLaunch: false,
      tags: [{ key: 'Name', value: name('private') }],
    });
    const rt = new ec2.CfnRouteTable(this, 'RouteTable', { vpcId: vpc.ref, tags: [{ key: 'Name', value: name('rt') }] });
    new ec2.CfnSubnetRouteTableAssociation(this, 'SubnetRoute', { subnetId: subnet.ref, routeTableId: rt.ref });

    const peerTo = (lid: string, peer: ObserverPeer, tag: string) => {
      const pcx = new ec2.CfnVPCPeeringConnection(this, lid, {
        vpcId: vpc.ref, peerVpcId: peer.vpcId, peerRegion: peer.region, tags: [{ key: 'Name', value: name(tag) }],
      });
      new ec2.CfnRoute(this, `RouteTo${lid.replace('PeeringTo', '')}`, {
        routeTableId: rt.ref, destinationCidrBlock: peer.cidr, vpcPeeringConnectionId: pcx.ref,
      });
      return pcx;
    };
    const toPrimary = peerTo('PeeringToPrimary', props.primary, 'to-primary');
    const toSecondary = peerTo('PeeringToSecondary', props.secondary, 'to-secondary');

    const endpointSg = new ec2.CfnSecurityGroup(this, 'EndpointSecurityGroup', {
      groupDescription: 'HTTPS from the observer VPC to the SSM interface endpoints', vpcId: vpc.ref,
      securityGroupIngress: [{ ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: props.cidr }],
      tags: [{ key: 'Name', value: name('vpce-sg') }],
    });
    for (const svc of ['ssm', 'ssmmessages', 'ec2messages']) {
      new ec2.CfnVPCEndpoint(this, `${svc.charAt(0).toUpperCase()}${svc.slice(1)}Endpoint`, {
        vpcId: vpc.ref, serviceName: `com.amazonaws.${this.region}.${svc}`, vpcEndpointType: 'Interface',
        privateDnsEnabled: true, subnetIds: [subnet.ref], securityGroupIds: [endpointSg.ref],
      });
    }

    const role = new iam.Role(this, 'BastionRole', {
      roleName: name('bastion-role'),
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    const profile = new iam.CfnInstanceProfile(this, 'BastionProfile', { instanceProfileName: name('bastion-profile'), roles: [role.roleName] });

    const bastionSg = new ec2.CfnSecurityGroup(this, 'BastionSecurityGroup', {
      groupDescription: 'Observer bastion - no inbound; egress to SSM endpoints and the workload ALBs only', vpcId: vpc.ref,
      securityGroupEgress: [
        { ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: props.cidr, description: 'SSM interface endpoints' },
        { ipProtocol: 'tcp', fromPort: 80, toPort: 80, cidrIp: props.primary.cidr, description: 'primary ALB' },
        { ipProtocol: 'tcp', fromPort: 80, toPort: 80, cidrIp: props.secondary.cidr, description: 'secondary ALB' },
      ],
      tags: [{ key: 'Name', value: name('bastion-sg') }],
    });
    const bastion = new ec2.CfnInstance(this, 'Bastion', {
      imageId: ec2.MachineImage.latestAmazonLinux2023().getImage(this).imageId,
      instanceType: 't3.nano', subnetId: subnet.ref, iamInstanceProfile: profile.ref, securityGroupIds: [bastionSg.ref],
      tags: [{ key: 'Name', value: name('bastion') }, { key: `${project}:role`, value: 'observer-bastion' }],
    });

    new cdk.CfnOutput(this, 'VpcId', { value: vpc.ref });
    new cdk.CfnOutput(this, 'VpcCidr', { value: props.cidr });
    new cdk.CfnOutput(this, 'BastionInstanceId', { value: bastion.ref });
    new cdk.CfnOutput(this, 'PeeringToPrimaryId', { value: toPrimary.ref });
    new cdk.CfnOutput(this, 'PeeringToSecondaryId', { value: toSecondary.ref });
  }
}
