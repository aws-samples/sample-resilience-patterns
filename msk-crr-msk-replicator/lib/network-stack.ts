/**
 * Copyright 2025 Amazon.com and its affiliates; all rights reserved.
 * SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
 * Licensed under the Amazon Software License  https://aws.amazon.com/asl/
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { AppConfig, RegionConfig } from './utils/config';
import { NetworkConstruct } from './constructs/vpc-construct';
import { VpcPeeringConstruct } from './constructs/vpc-peering-construct';

interface NetworkStackProps extends cdk.StackProps {
  readonly config: AppConfig;
  readonly regionConfig: RegionConfig;
  /** Peer region config — when provided, sets up VPC peering */
  readonly peerRegionConfig?: RegionConfig;
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: NetworkConstruct;
  public readonly mskSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const envPathIdentifier = `/${props.config.appName}/${props.config.envName}`;

    this.vpc = new NetworkConstruct(
      this,
      `${props.config.appName}-${props.config.envName}-${props.regionConfig.regionPrefix}-network`,
      {
        config: {
          ...props.config,
          awsDefaultRegion: props.regionConfig.region,
        },
        cidrRange: props.regionConfig.vpcCidr,
        isIsolated: false,
        publicVpcNatGatewayCount: 1,
        vpcAzCount: 3,
      },
    );

    // MSK security group — allows SASL_IAM (9098) from within VPC
    this.mskSg = new ec2.SecurityGroup(this, 'msk-sg', {
      vpc: this.vpc.vpc,
      securityGroupName: `${props.config.appName}-${props.config.envName}-${props.regionConfig.regionPrefix}-msk-sg`,
      allowAllOutbound: true,
      description: 'Security group for MSK cluster',
    });
    this.mskSg.addIngressRule(
      ec2.Peer.ipv4(props.regionConfig.vpcCidr),
      ec2.Port.tcp(9098),
      'Allow SASL_IAM traffic from within VPC',
    );

    new ssm.StringParameter(this, 'msk-sg-param', {
      parameterName: `${envPathIdentifier}/vpc/${props.regionConfig.regionPrefix}/msk-sg`,
      stringValue: this.mskSg.securityGroupId,
      description: `MSK Security Group ID for ${props.regionConfig.region}`,
    });

    // Store VPC ID in Secrets Manager for cross-region access (peering)
    if (props.regionConfig.isPrimary) {
      const vpcSecret = new secretsmanager.Secret(this, 'vpc-id-secret', {
        secretName: `${envPathIdentifier}/${props.regionConfig.regionPrefix}-vpc-id`,
        description: `VPC ID for ${props.config.appName} ${props.regionConfig.region}`,
        secretStringValue: cdk.SecretValue.unsafePlainText(this.vpc.vpc.vpcId),
        replicaRegions: [{ region: props.config.secondaryRegion.region }],
      });

      NagSuppressions.addResourceSuppressions(vpcSecret, [
        { id: 'AwsSolutions-SMG4', reason: 'VPC ID is not a credential and does not require rotation' },
      ], true);
    }

    // Set up VPC peering if peer config is provided (secondary region)
    if (props.peerRegionConfig) {
      // Retrieve primary VPC ID from replicated secret
      const vpcSecret = secretsmanager.Secret.fromSecretNameV2(
        this,
        'peer-vpc-id-secret',
        `${envPathIdentifier}/${props.peerRegionConfig.regionPrefix}-vpc-id`,
      );
      const peerVpcId = vpcSecret.secretValue.unsafeUnwrap().toString().trim();

      // Also allow MSK traffic from peer VPC CIDR
      this.mskSg.addIngressRule(
        ec2.Peer.ipv4(props.peerRegionConfig.vpcCidr),
        ec2.Port.tcp(9098),
        'Allow SASL_IAM traffic from peer VPC',
      );

      new VpcPeeringConstruct(this, 'vpc-peering', {
        vpc: this.vpc.vpc,
        peerVpcId,
        peerRegion: props.peerRegionConfig.region,
        peerCidr: props.peerRegionConfig.vpcCidr,
        localCidr: props.regionConfig.vpcCidr,
      });
    }

    NagSuppressions.addStackSuppressions(this, [
      { id: 'AwsSolutions-IAM4', reason: 'AWS-managed policies permitted on CDK custom-resource roles' },
      { id: 'AwsSolutions-IAM5', reason: 'Wildcard permissions required for VPC peering route discovery' },
    ]);
  }
}
