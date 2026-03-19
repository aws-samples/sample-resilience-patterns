import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export interface VpcStackProps extends cdk.StackProps {
  readonly project: string;
  readonly cidr: string;
  readonly peerCidr: string;
}

export class VpcStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly albSg: ec2.SecurityGroup;
  public readonly databaseSg: ec2.SecurityGroup;
  public readonly lambdaSg: ec2.SecurityGroup;
  public readonly vpcEndpointSg: ec2.SecurityGroup;
  public readonly syntheticsSg: ec2.SecurityGroup;

  constructor(scope: cdk.App, id: string, props: VpcStackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${props.project}-${this.region}`,
      ipAddresses: ec2.IpAddresses.cidr(props.cidr),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // Security groups
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc, description: 'ALB security group', allowAllOutbound: false,
    });

    this.databaseSg = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc: this.vpc, description: 'Database security group', allowAllOutbound: false,
    });

    this.lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc, description: 'Lambda security group', allowAllOutbound: false,
    });

    this.vpcEndpointSg = new ec2.SecurityGroup(this, 'VpcEndpointSg', {
      vpc: this.vpc, description: 'VPC endpoint security group', allowAllOutbound: false,
    });

    this.syntheticsSg = new ec2.SecurityGroup(this, 'SyntheticsSg', {
      vpc: this.vpc, description: 'Synthetics canary security group', allowAllOutbound: false,
    });

    // ALB SG: inbound 80 from local Synthetics + cross-region CIDR
    this.albSg.addIngressRule(this.syntheticsSg, ec2.Port.tcp(80), 'Synthetics local');
    this.albSg.addIngressRule(ec2.Peer.ipv4(props.peerCidr), ec2.Port.tcp(80), 'Synthetics cross-region');

    // Database SG: inbound 5432 from Lambda
    this.databaseSg.addIngressRule(this.lambdaSg, ec2.Port.tcp(5432), 'Lambda to PostgreSQL');

    // Lambda SG: inbound from ALB, outbound to DB + VPC endpoints
    this.lambdaSg.addIngressRule(this.albSg, ec2.Port.tcp(80), 'ALB to Lambda');
    this.lambdaSg.addEgressRule(this.databaseSg, ec2.Port.tcp(5432), 'Lambda to DB');
    this.lambdaSg.addEgressRule(this.vpcEndpointSg, ec2.Port.tcp(443), 'Lambda to VPC endpoints');

    // VPC Endpoint SG: inbound 443 from Lambda and Synthetics
    this.vpcEndpointSg.addIngressRule(this.lambdaSg, ec2.Port.tcp(443), 'Lambda to endpoints');
    this.vpcEndpointSg.addIngressRule(this.syntheticsSg, ec2.Port.tcp(443), 'Synthetics to endpoints');

    // Synthetics SG: outbound 80 to local ALB + cross-region CIDR
    this.syntheticsSg.addEgressRule(this.albSg, ec2.Port.tcp(80), 'Synthetics to local ALB');
    this.syntheticsSg.addEgressRule(ec2.Peer.ipv4(props.peerCidr), ec2.Port.tcp(80), 'Synthetics to cross-region ALB');
    // Synthetics also needs VPC endpoint access for CloudWatch/S3
    this.syntheticsSg.addEgressRule(this.vpcEndpointSg, ec2.Port.tcp(443), 'Synthetics to VPC endpoints');

    // VPC endpoints
    const isolatedSubnets = { subnets: this.vpc.isolatedSubnets };

    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [isolatedSubnets],
    });

    const interfaceEndpoints: [string, ec2.InterfaceVpcEndpointAwsService][] = [
      ['CwLogs', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ['CwMonitoring', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING],
      ['SecretsManager', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ['Sts', ec2.InterfaceVpcEndpointAwsService.STS],
      ['Lambda', ec2.InterfaceVpcEndpointAwsService.LAMBDA],
      ['Synthetics', new ec2.InterfaceVpcEndpointAwsService('synthetics')],
    ];

    for (const [name, service] of interfaceEndpoints) {
      this.vpc.addInterfaceEndpoint(`${name}Endpoint`, {
        service,
        subnets: isolatedSubnets,
        securityGroups: [this.vpcEndpointSg],
        privateDnsEnabled: true,
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'VpcCidr', { value: props.cidr });
    new cdk.CfnOutput(this, 'IsolatedSubnetIds', {
      value: this.vpc.isolatedSubnets.map(s => s.subnetId).join(','),
    });
    new cdk.CfnOutput(this, 'AvailabilityZones', {
      value: this.vpc.availabilityZones.join(','),
    });
    new cdk.CfnOutput(this, 'AlbSgId', { value: this.albSg.securityGroupId });
    new cdk.CfnOutput(this, 'DatabaseSgId', { value: this.databaseSg.securityGroupId });
    new cdk.CfnOutput(this, 'LambdaSgId', { value: this.lambdaSg.securityGroupId });
    new cdk.CfnOutput(this, 'VpcEndpointSgId', { value: this.vpcEndpointSg.securityGroupId });
    new cdk.CfnOutput(this, 'SyntheticsSgId', { value: this.syntheticsSg.securityGroupId });
  }
}
