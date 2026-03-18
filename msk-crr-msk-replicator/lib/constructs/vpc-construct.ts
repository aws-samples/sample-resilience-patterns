/**
 * Copyright 2025 Amazon.com and its affiliates; all rights reserved.
 * SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
 * Licensed under the Amazon Software License  https://aws.amazon.com/asl/
 **/

import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as elb from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { AppConfig } from "../utils/config";
import { Tags } from "aws-cdk-lib";

export interface PrefixList {
  readonly id: string;
  readonly name: string;
}

export type AWSManagedPrefixList = {
  [service: string]: PrefixList;
};

export type AWSManagedPrefixListByRegion = {
  [region: string]: AWSManagedPrefixList;
};

export const US_EAST_1_AWS_MANAGED_PREFIX_LISTS: AWSManagedPrefixList = {
  "ec2-instance-connect": {
    id: "pl-09f90e410b133fe9f",
    name: "com.amazonaws.us-east-1.ipv6.ec2-instance-connect",
  },
};

export const US_EAST_2_AWS_MANAGED_PREFIX_LISTS: AWSManagedPrefixList = {
  "ec2-instance-connect": {
    id: "pl-03915406641cb1f53",
    name: "com.amazonaws.us-east-2.ec2-instance-connect",
  },
};

export const US_WEST_1_AWS_MANAGED_PREFIX_LISTS: AWSManagedPrefixList = {
  "ec2-instance-connect": {
    id: "pl-0e99958a47b22d6ab",
    name: "com.amazonaws.us-west-1.ec2-instance-connect",
  },
};

export const US_WEST_2_AWS_MANAGED_PREFIX_LISTS: AWSManagedPrefixList = {
  "ec2-instance-connect": {
    id: "pl-047d464325e7bf465",
    name: "com.amazonaws.us-west-2.ec2-instance-connect",
  },
};

export const AWS_MANAGED_PREFIX_LISTS: AWSManagedPrefixListByRegion = {
  "us-east-1": US_EAST_1_AWS_MANAGED_PREFIX_LISTS,
  "us-east-2": US_EAST_2_AWS_MANAGED_PREFIX_LISTS,
  "us-west-1": US_WEST_1_AWS_MANAGED_PREFIX_LISTS,
  "us-west-2": US_WEST_2_AWS_MANAGED_PREFIX_LISTS,
};

/**
 * Properties for the NetworkConstruct
 */
export interface NetworkConstructProps extends cdk.StackProps {
  readonly config: AppConfig;
  readonly cidrRange: string;
  /** Whether the VPC should be isolated (no internet access) */
  readonly isIsolated: boolean;
  readonly allowedIPs?: string[];
  readonly publicVpcNatGatewayCount: number;
  readonly vpcAzCount: number;
  /** ID of an existing VPC to use (if not creating a new one) */
  readonly existingVpcId?: string;
}

const defaultProps: Partial<NetworkConstructProps> = {};

export class NetworkConstruct extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly allowedIpsSg: ec2.SecurityGroup;
  public readonly publicSubnetSg: ec2.SecurityGroup;
  public readonly privateSubnetSg: ec2.SecurityGroup;
  public readonly isolatedSubnetSg: ec2.SecurityGroup;
  public readonly publicEIPref!: string[];
  public readonly logBucket!: s3.IBucket;
  public readonly vpcParam: ssm.StringParameter;

  constructor(parent: Construct, name: string, props: NetworkConstructProps) {
    super(parent, name);

    props = { ...defaultProps, ...props };
    const envIdentifier = `${props.config.appName.toLowerCase()}-${
      props.config.envName
    }`;
    const envPathIdentifier = `/${props.config.appName.toLowerCase()}/${props.config.envName.toLowerCase()}`;

    let vpc: ec2.IVpc;

    if (props.existingVpcId) {
      vpc = ec2.Vpc.fromLookup(this, "ExistingVPC", {
        vpcId: props.existingVpcId,
        vpcName: envIdentifier,
      });

      const publicSubnetIds =
        vpc.publicSubnets.length > 0
          ? vpc.publicSubnets.map((subnet) => subnet.subnetId)
          : [" "];
      const privateSubnetIds =
        vpc.privateSubnets.length > 0
          ? vpc.privateSubnets.map((subnet) => subnet.subnetId)
          : [" "];
      const isolatedSubnetIds =
        vpc.isolatedSubnets.length > 0
          ? vpc.isolatedSubnets.map((subnet) => subnet.subnetId)
          : [" "];

      new ssm.StringListParameter(
        this,
        `${envIdentifier}-public-subnet-param`,
        {
          allowedPattern: ".*",
          description: `The VPC public subnetIds for ${props.config.appName}: ${props.config.envName} Environment`,
          parameterName: `${envPathIdentifier}/vpc/public-subnets`,
          stringListValue: publicSubnetIds,
        }
      );

      new ssm.StringListParameter(
        this,
        `${envIdentifier}-private-subnet-param`,
        {
          allowedPattern: ".*",
          description: `The VPC Private subnetIds for ${props.config.appName}: ${props.config.envName} Environment`,
          parameterName: `${envPathIdentifier}/vpc/private-subnets`,
          stringListValue: privateSubnetIds,
        }
      );

      new ssm.StringListParameter(
        this,
        `${envIdentifier}-isolated-subnet-param`,
        {
          allowedPattern: ".*",
          description: `The VPC Isolated subnetIds for ${props.config.appName}: ${props.config.envName} Environment`,
          parameterName: `${envPathIdentifier}/vpc/isolated-subnets`,
          stringListValue: isolatedSubnetIds,
        }
      );

      // Store subnet IDs by AZ for Private Subnets
      vpc.privateSubnets.forEach((subnet, index) => {
        new ssm.StringParameter(this, `PrivateSubnetParameter${index}`, {
          parameterName: `${envPathIdentifier}/vpc/privateSubnet/${subnet.availabilityZone}`,
          stringValue: subnet.subnetId,
        });
      });

      // Store subnet IDs by AZ for Isolated Subnets
      vpc.isolatedSubnets.forEach((subnet, index) => {
        new ssm.StringParameter(this, `IsolatedSubnetParameter${index}`, {
          parameterName: `${envPathIdentifier}/vpc/isolatedSubnet/${subnet.availabilityZone}`,
          stringValue: subnet.subnetId,
        });
      });

      // Store subnet IDs by AZ for Public Subnets
      vpc.publicSubnets.forEach((subnet, index) => {
        new ssm.StringParameter(this, `PublicSubnetParameter${index}`, {
          parameterName: `${envPathIdentifier}/vpc/publicSubnet/${subnet.availabilityZone}`,
          stringValue: subnet.subnetId,
        });
      });
    } else {
      const allocationIds: string[] = [];
      this.publicEIPref = [];

      if (!props.isIsolated) {
        for (let i = 0; i < props.publicVpcNatGatewayCount; i++) {
          const eip = new ec2.CfnEIP(
            this,
            `VPCPublicSubnet${i + 1}NATGatewayEIP${i}`,
            {
              domain: "vpc",
              tags: [{ key: "Name", value: `${envIdentifier}-nat-${i + 1}` }],
            }
          );
          allocationIds.push(eip.attrAllocationId);
          this.publicEIPref.push(eip.ref);
        }
      }

      vpc = new ec2.Vpc(this, "VPC", {
        ipAddresses: ec2.IpAddresses.cidr(props.cidrRange),
        enableDnsHostnames: true,
        enableDnsSupport: true,
        vpcName: envIdentifier,
        natGateways: props.isIsolated ? 0 : props.publicVpcNatGatewayCount,
        maxAzs: props.vpcAzCount,
        createInternetGateway: !props.isIsolated,
        natGatewayProvider: props.isIsolated
          ? undefined
          : ec2.NatProvider.gateway({ eipAllocationIds: allocationIds }),
        subnetConfiguration: props.isIsolated
          ? [
              {
                cidrMask: 24,
                name: "isolated",
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
              },
            ]
          : [
              {
                cidrMask: 24,
                name: "public",
                subnetType: ec2.SubnetType.PUBLIC,
              },
              {
                cidrMask: 24,
                name: "private",
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
              },
              {
                cidrMask: 24,
                name: "isolated",
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
              },
            ],
        defaultInstanceTenancy: ec2.DefaultInstanceTenancy.DEFAULT,
      });

      NagSuppressions.addResourceSuppressions(
        vpc,
        [
          {
            id: "AwsSolutions-VPC7",
            reason: "VPC Flow Logs not required for this PoC as it is a resiliency-related PoC, not security-focused",
          },
        ],
        true
      );

      const publicSubnetIds = props.isIsolated
        ? "[]"
        : JSON.stringify(vpc.publicSubnets.map((subnet) => subnet.subnetId));
      const privateSubnetIds = props.isIsolated
        ? "[]"
        : JSON.stringify(vpc.privateSubnets.map((subnet) => subnet.subnetId));

      new ssm.StringListParameter(
        this,
        `${envIdentifier}-public-subnet-param`,
        {
          allowedPattern: ".*",
          description: `The VPC public subnetIds for ${props.config.appName}: ${props.config.envName} Environment`,
          parameterName: `${envPathIdentifier}/vpc/public-subnets`,
          stringListValue: JSON.parse(publicSubnetIds) as string[],
        }
      );

      new ssm.StringListParameter(
        this,
        `${envIdentifier}-private-subnet-param`,
        {
          allowedPattern: ".*",
          description: `The VPC Private subnetIds for ${props.config.appName}: ${props.config.envName} Environment`,
          parameterName: `${envPathIdentifier}/vpc/private-subnets`,
          stringListValue: JSON.parse(privateSubnetIds) as string[],
        }
      );

      vpc.privateSubnets.forEach((subnet, index) => {
        new ssm.StringParameter(this, `PrivateSubnetParameter${index}`, {
          parameterName: `${envPathIdentifier}/vpc/privateSubnet/${subnet.availabilityZone}`,
          stringValue: subnet.subnetId,
        });
      });

      vpc.publicSubnets.forEach((subnet, index) => {
        new ssm.StringParameter(this, `PublicSubnetParameter${index}`, {
          parameterName: `${envPathIdentifier}/vpc/publicSubnet/${subnet.availabilityZone}`,
          stringValue: subnet.subnetId,
        });
      });

      const isolatedSubnetIds = vpc
        .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED })
        .subnets.map((subnet) => subnet.subnetId);
      if (isolatedSubnetIds.length > 0) {
        new ssm.StringListParameter(
          this,
          `${envIdentifier}-isolated-subnet-param`,
          {
            allowedPattern: ".*",
            description: `The VPC Isolated subnetIds for ${props.config.appName}: ${props.config.envName} Environment`,
            parameterName: `${envPathIdentifier}/vpc/isolated-subnets`,
            stringListValue: isolatedSubnetIds,
          }
        );

        vpc.isolatedSubnets.forEach((subnet, index) => {
          new ssm.StringParameter(this, `IsolatedSubnetParameter${index}`, {
            parameterName: `${envPathIdentifier}/vpc/isolatedSubnet/${subnet.availabilityZone}`,
            stringValue: subnet.subnetId,
          });
        });
      } else {
        console.warn("No isolated subnets found in the VPC.");
      }
    }

    const vpcParam = new ssm.StringParameter(
      this,
      `${envIdentifier}-vpc-param`,
      {
        allowedPattern: ".*",
        description: `The VPC ID for ${props.config.appName}: ${props.config.envName} Environment`,
        parameterName: `${envPathIdentifier}/vpc`,
        stringValue: vpc.vpcId,
      }
    );

    this.allowedIpsSg = new ec2.SecurityGroup(this, "allowed-ip-sg", {
      vpc,
      securityGroupName: `${envIdentifier}-allowed-ip-sg`,
      allowAllOutbound: true,
      description: "Security group for allowed IPs into the VPC network",
    });
    Tags.of(this.allowedIpsSg).add("Name", `${envIdentifier}-allowed-ip-sg`);

    NagSuppressions.addResourceSuppressions(
      this.allowedIpsSg,
      [
        {
          id: "AwsSolutions-EC23",
          reason: "Security group does not allow unrestricted 0.0.0.0/0 access, only specific allowed IPs and prefix lists",
        },
      ],
      true
    );

    new ssm.StringParameter(this, `${envIdentifier}-allowed-ip-sg-param`, {
      allowedPattern: ".*",
      description: `The Allowed IP Security Group ID for ${props.config.appName}: ${props.config.envName} Environment`,
      parameterName: `${envPathIdentifier}/vpc/allowed-ip-sg`,
      stringValue: this.allowedIpsSg.securityGroupId,
    });

    if (props.allowedIPs) {
      for (const ip of props.allowedIPs) {
        if (ip.startsWith("pl-")) {
          this.allowedIpsSg.addIngressRule(
            ec2.Peer.prefixList(ip),
            ec2.Port.tcp(80),
            "allow HTTP access from Allowed Prefix List"
          );
          this.allowedIpsSg.addIngressRule(
            ec2.Peer.prefixList(ip),
            ec2.Port.tcp(443),
            "allow HTTPS access from Allowed Prefix List"
          );
        } else {
          this.allowedIpsSg.addIngressRule(
            ec2.Peer.ipv4(ip),
            ec2.Port.tcp(80),
            "allow HTTP access from Allowed IP"
          );
          this.allowedIpsSg.addIngressRule(
            ec2.Peer.ipv4(ip),
            ec2.Port.tcp(443),
            "allow HTTPS access from Allowed IPs"
          );
        }
      }
    }

    for (const ip of this.publicEIPref) {
      this.allowedIpsSg.addIngressRule(
        ec2.Peer.ipv4(ip + "/32"),
        ec2.Port.tcp(80),
        "Allow Access From NAT Gateway"
      );
      this.allowedIpsSg.addIngressRule(
        ec2.Peer.ipv4(ip + "/32"),
        ec2.Port.tcp(443),
        "Allow Access From NAT Gateway"
      );
    }

    this.publicSubnetSg = new ec2.SecurityGroup(this, "public-subnets-sg", {
      vpc,
      securityGroupName: `${envIdentifier}-public-subnets-sg`,
      allowAllOutbound: true,
      description: "Security group for services within public subnets",
    });

    Tags.of(this.publicSubnetSg).add(
      "Name",
      `${envIdentifier}-public-subnets-sg`
    );

    this.publicSubnetSg.addIngressRule(
      ec2.Peer.ipv4("0.0.0.0/0"),
      ec2.Port.HTTPS,
      "Allow HTTPS traffic from Internet"
    );

    NagSuppressions.addResourceSuppressions(
      this.publicSubnetSg,
      [
        {
          id: "AwsSolutions-EC23",
          reason: "Public subnet security group intentionally allows 0.0.0.0/0 for public internet access",
        },
      ],
      true
    );

    new ssm.StringParameter(this, `${envIdentifier}-public-subnets-sg-param`, {
      allowedPattern: ".*",
      description: `The public subnets service Security Group ID for ${props.config.appName}: ${props.config.envName} Environment`,
      parameterName: `${envPathIdentifier}/vpc/public-subnet-sg`,
      stringValue: this.publicSubnetSg.securityGroupId,
    });

    // Loadbalancer SG
    const lbSg = new ec2.SecurityGroup(this, "lb-sg", {
      vpc,
      securityGroupName: `${envIdentifier}-loadbalancer-sg`,
      allowAllOutbound: true,
      description: "Security group for load balancer",
    });

    Tags.of(lbSg).add("Name", `${envIdentifier}-alb-sg`);

    lbSg.addIngressRule(
      ec2.Peer.ipv4("0.0.0.0/0"),
      ec2.Port.HTTP,
      "Allow HTTP traffic from within 0.0.0.0/0"
    );

    lbSg.addIngressRule(
      ec2.Peer.ipv4("0.0.0.0/0"),
      ec2.Port.HTTPS,
      "Allow HTTPS traffic from within 0.0.0.0/0"
    );

    NagSuppressions.addResourceSuppressions(
      lbSg,
      [
        {
          id: "AwsSolutions-EC23",
          reason: "Load balancer security group intentionally allows 0.0.0.0/0 for public internet access",
        },
      ],
      true
    );

    // Create Private subnets security group
    this.privateSubnetSg = new ec2.SecurityGroup(this, "private-subnets-sg", {
      vpc,
      securityGroupName: `${envIdentifier}-private-subnets-sg`,
      allowAllOutbound: true,
      description: "Security group for service within private subnets",
    });

    Tags.of(this.privateSubnetSg).add(
      "Name",
      `${envIdentifier}-private-subnets-sg`
    );

    // The ingress rules below are for EC2 Instance Connect Service that enables connection to a bastian host in
    // a private subnet.
    // This rule is needed when preserveClientIp is set to false in EC2 Instance Connect VPC Endpoint
    this.privateSubnetSg.addIngressRule(
      ec2.Peer.ipv4(props.cidrRange),
      ec2.Port.tcp(22),
      "Allow SSH traffic from within VPC"
    );
    // PrefixList for EC2 Instance Connect Service
    let eicPrefixList: PrefixList =
      AWS_MANAGED_PREFIX_LISTS[props.config.awsDefaultRegion][
        "ec2-instance-connect"
      ];
    this.privateSubnetSg.addIngressRule(
      ec2.Peer.prefixList(eicPrefixList.id),
      ec2.Port.SSH,
      "Allow SSH traffic from EC2 Instance Connect"
    );
    // Inbound traffic from public subnets
    this.privateSubnetSg.addIngressRule(
      this.publicSubnetSg,
      ec2.Port.HTTPS,
      "Allow HTTPS traffic from public subnets"
    );

    this.privateSubnetSg.addIngressRule(
      lbSg,
      ec2.Port.allTcp(),
      "Allow TCP traffic from loadbalancer SG"
    );

    // Allow Private subnets to access resources on common ports within the private subnet VPC
    // this.privateSubnetSg.addIngressRule(this.privateSubnetSg, ec2.Port.allTcp(), "Allow all TCP traffic between service within private subnets");
    // this.privateSubnetSg.addIngressRule(this.privateSubnetSg, ec2.Port.allUdp(), "Allow all UDP traffic between service within private subnets");
    // this.privateSubnetSg.addIngressRule(this.privateSubnetSg, ec2.Port.allIcmp(), "Allow all ICMP traffic between service within private subnets");
    NagSuppressions.addResourceSuppressions(
      this.privateSubnetSg,
      [
        {
          id: "AwsSolutions-EC23",
          reason:
            "Security group for service within private subnets is intentionally configured to allow access within VPC",
        },
      ],
      true
    );

    new ssm.StringParameter(this, `${envIdentifier}-private-subnets-sg-param`, {
      allowedPattern: ".*",
      description: `The private subnets service Security Group ID for ${props.config.appName}: ${props.config.envName} Environment`,
      parameterName: `${envPathIdentifier}/vpc/private-subnet-sg`,
      stringValue: this.privateSubnetSg.securityGroupId,
    });

    // Create Isolated subnet security group
    this.isolatedSubnetSg = new ec2.SecurityGroup(this, "isolated-subnets-sg", {
      vpc,
      securityGroupName: `${envIdentifier}-isolated-subnets-sg`,
      allowAllOutbound: true,
      description:
        "Security group for resources running on the isolated subnets",
    });

    Tags.of(this.isolatedSubnetSg).add(
      "Name",
      `${envIdentifier}-isolated-subnets-sg`
    );

    this.isolatedSubnetSg.addIngressRule(
      this.privateSubnetSg,
      ec2.Port.POSTGRES,
      "Allow private subnets service to access resource within Isolated subnets (Postgress DB)"
    );

    new ssm.StringParameter(
      this,
      `${envIdentifier}-isolated-subnets-sg-param`,
      {
        allowedPattern: ".*",
        description: `The Isolated Subnet Security Group ID for ${props.config.appName}: ${props.config.envName} Environment`,
        parameterName: `${envPathIdentifier}/vpc/isolated-subnet-sg`,
        stringValue: this.isolatedSubnetSg.securityGroupId,
      }
    );

    const vpcInterfaceSg = new ec2.SecurityGroup(this, "vpc-interface-sg", {
      vpc,
      securityGroupName: `${envIdentifier}-vpc-interface-sg`,
      allowAllOutbound: true,
      description: "security group for vpc interface",
    });

    Tags.of(vpcInterfaceSg).add("Name", `${envIdentifier}-vpc-interface-sg`);

    vpcInterfaceSg.addIngressRule(
      ec2.Peer.ipv4(props.cidrRange),
      ec2.Port.allTcp(),
      "Allow all TCP traffic from within VPC"
    );

    NagSuppressions.addResourceSuppressions(
      vpcInterfaceSg,
      [
        {
          id: "AwsSolutions-EC23",
          reason: "VPC interface security group only allows traffic from within VPC CIDR range, not from 0.0.0.0/0",
        },
      ],
      true
    );

    //create applicaiton loadbalancer v2
    const lb = new elb.ApplicationLoadBalancer(this, "lb", {
      vpc,
      loadBalancerName: `${envIdentifier}-loadbalancer`,
      internetFacing: props.isIsolated ? false : true,
      securityGroup: lbSg,
      crossZoneEnabled: true,
      http2Enabled: true,
      vpcSubnets: {
        subnetType: props.isIsolated
          ? ec2.SubnetType.PRIVATE_ISOLATED
          : ec2.SubnetType.PUBLIC,
      },
    });

    NagSuppressions.addResourceSuppressions(
      lb,
      [
        {
          id: "AwsSolutions-ELB2",
          reason: "ALB access logs not required for this PoC",
        },
      ],
      true
    );

    // Store ALB parameters for other stacks
    new ssm.StringParameter(this, `${envIdentifier}-alb-arn-param`, {
      parameterName: `${envPathIdentifier}/alb-arn`,
      stringValue: lb.loadBalancerArn,
      description: `ALB ARN for ${props.config.appName}: ${props.config.envName}`,
    });

    new ssm.StringParameter(this, `${envIdentifier}-alb-sg-param`, {
      parameterName: `${envPathIdentifier}/alb-security-group-id`,
      stringValue: lbSg.securityGroupId,
      description: `ALB Security Group ID for ${props.config.appName}: ${props.config.envName}`,
    });

    new ssm.StringParameter(this, `${envIdentifier}-alb-dns-param`, {
      parameterName: `${envPathIdentifier}/alb-dns-name`,
      stringValue: lb.loadBalancerDnsName,
      description: `ALB DNS name for ${props.config.appName}: ${props.config.envName}`,
    });


  
    const currentRegion = cdk.Stack.of(this).region;
    if (currentRegion === props.config.secondaryRegion.region) {
      const replicaRegions = [];
      replicaRegions.push({
        region: props.config.primaryRegion.region,
      });
      const albDnsSecret = new secretsmanager.Secret(this, `${envIdentifier}-alb-dns-secret`, {
        secretName: `${envPathIdentifier}/${props.config.secondaryRegion.regionPrefix}-alb-dns-name`,
        description: `ALB DNS name for ${props.config.appName}: ${props.config.envName} in ${currentRegion}`,
        secretStringValue: cdk.SecretValue.unsafePlainText(lb.loadBalancerDnsName),
        replicaRegions: replicaRegions.length > 0 ? replicaRegions : undefined,
      });

      NagSuppressions.addResourceSuppressions(
        albDnsSecret,
        [
          {
            id: "AwsSolutions-SMG4",
            reason: "ALB DNS name is not a credential and does not require automatic rotation",
          },
        ],
        true
      );
    }

    this.vpcParam = vpcParam;
    this.vpc = vpc;

    // Create VPC endpoints after security groups have been created
    this.addVpcEndpoints(vpc, envIdentifier, vpcInterfaceSg);
  }

  private addVpcEndpoints(
    vpc: ec2.IVpc,
    envIdentifier: string,
    sg: ec2.ISecurityGroup
  ) {
    const endpointServices = [
      {
        name: "DynamoDBEndpoint",
        service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      },
      { name: "S3Endpoint", service: ec2.GatewayVpcEndpointAwsService.S3 },
      { name: "KMSEndpoint", service: ec2.InterfaceVpcEndpointAwsService.KMS },
      { name: "ECREndpoint", service: ec2.InterfaceVpcEndpointAwsService.ECR },
      {
        name: "ECRDockerEndpoint",
        service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      },
      { name: "SSMEndpoint", service: ec2.InterfaceVpcEndpointAwsService.SSM },
      {
        name: "SSMMessagesEndpoint",
        service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      },
      {
        name: "Ec2Messages",
        service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      },
      {
        name: "Ec2",
        service: ec2.InterfaceVpcEndpointAwsService.EC2,
      },
      {
        name: "CWEndpoint",
        service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      },
      { name: "ECSEndpoint", service: ec2.InterfaceVpcEndpointAwsService.ECS },
      {
        name: "ECSAgentEndpoint",
        service: ec2.InterfaceVpcEndpointAwsService.ECS_AGENT,
      },
      {
        name: "ECSTelemetryEndpoint",
        service: ec2.InterfaceVpcEndpointAwsService.ECS_TELEMETRY,
      },
      {
        name: "EfsEndpoint",
        service: ec2.InterfaceVpcEndpointAwsService.ELASTIC_FILESYSTEM,
      },
    ];

    endpointServices.forEach(({ name, service }) => {
      if (service instanceof ec2.GatewayVpcEndpointAwsService) {
        vpc.addGatewayEndpoint(name, { service });
      } else {
        const endpoint = vpc.addInterfaceEndpoint(name, {
          service,
          securityGroups: [sg],
        });
        Tags.of(endpoint).add("Name", name);
      }
    });

    // Add EC2 Instance Connect VPC Endpoint
    const ec2InstanceConnectVpcEndpoint = new ec2.CfnInstanceConnectEndpoint(
      this,
      `${envIdentifier}-instance-connect-ep`,
      {
        // @ts-ignore
        subnetId: vpc.privateSubnets.at(0).subnetId,
        preserveClientIp: false,
        securityGroupIds: [this.privateSubnetSg?.securityGroupId],
        tags: [
          {
            key: "Name",
            value: `${envIdentifier}-instance-connect-ep`,
          },
        ],
      }
    );
  }
}
