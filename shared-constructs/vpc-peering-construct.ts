/**
 * Copyright 2025 Amazon.com and its affiliates; all rights reserved.
 * SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
 * Licensed under the Amazon Software License  https://aws.amazon.com/asl/
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cf from 'aws-cdk-lib/aws-cloudformation';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { join } from 'path';

/**
 * Properties for VpcPeeringConstruct.
 *
 * Creates a cross-region VPC peering connection and wires routes in both VPCs.
 * Local VPC routes are added directly via CfnRoute. Peer (remote) VPC routes
 * are added via a Lambda-backed custom resource that iterates over the peer
 * VPC's route tables and adds/removes routes dynamically.
 */
export interface VpcPeeringConstructProps {
  /** The local VPC (in this stack's region) */
  readonly vpc: ec2.IVpc;
  /** VPC ID of the peer VPC (in the remote region) */
  readonly peerVpcId: string;
  /** Region of the peer VPC */
  readonly peerRegion: string;
  /** CIDR block of the peer VPC (used for route destinations) */
  readonly peerCidr: string;
  /** CIDR block of the local VPC (used for reverse route destinations) */
  readonly localCidr: string;
  /** Optional: peer account ID for cross-account peering */
  readonly peerOwnerId?: string;
  /** Optional: peer role ARN for cross-account peering */
  readonly peerRoleArn?: string;
}

export class VpcPeeringConstruct extends Construct {
  /** The peering connection ID */
  public readonly peeringConnectionId: string;

  constructor(scope: Construct, id: string, props: VpcPeeringConstructProps) {
    super(scope, id);

    // Create the VPC peering connection
    const peering = new ec2.CfnVPCPeeringConnection(this, 'PeeringConnection', {
      vpcId: props.vpc.vpcId,
      peerVpcId: props.peerVpcId,
      peerRegion: props.peerRegion,
      peerOwnerId: props.peerOwnerId,
      peerRoleArn: props.peerRoleArn,
    });
    this.peeringConnectionId = peering.ref;

    // Add routes in local VPC pointing peer CIDR → peering connection
    this.addLocalRoutes(props.vpc, props.peerCidr, peering.ref);

    // Add reverse routes in peer VPC via Lambda custom resource
    this.addPeerRoutes(props, peering.ref);
  }

  /**
   * Adds routes in the local VPC's private and public subnet route tables
   * pointing the peer CIDR at the peering connection.
   */
  private addLocalRoutes(vpc: ec2.IVpc, peerCidr: string, peeringConnectionId: string): void {
    vpc.privateSubnets.forEach((subnet: ec2.ISubnet, index: number) => {
      new ec2.CfnRoute(this, `PrivatePeeringRoute${index}`, {
        destinationCidrBlock: peerCidr,
        routeTableId: subnet.routeTable.routeTableId,
        vpcPeeringConnectionId: peeringConnectionId,
      });
    });

    vpc.publicSubnets.forEach((subnet: ec2.ISubnet, index: number) => {
      new ec2.CfnRoute(this, `PublicPeeringRoute${index}`, {
        destinationCidrBlock: peerCidr,
        routeTableId: subnet.routeTable.routeTableId,
        vpcPeeringConnectionId: peeringConnectionId,
      });
    });
  }

  /**
   * Adds reverse routes in the peer VPC using a Lambda-backed custom resource.
   * The Lambda discovers route tables in the peer VPC and adds/removes routes
   * pointing back to the local CIDR via the peering connection.
   */
  private addPeerRoutes(props: VpcPeeringConstructProps, peeringConnectionId: string): void {
    const role = new iam.Role(this, 'RouteAdderRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeRouteTables', 'ec2:CreateRoute', 'ec2:DeleteRoute'],
      resources: ['*'],
    }));

    NagSuppressions.addResourceSuppressions(role, [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is standard for Lambda functions' },
      { id: 'AwsSolutions-IAM5', reason: 'Route table IDs are dynamic — discovered at deploy time' },
    ], true);

    const fn = new lambda.Function(this, 'RouteAdderFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(join(__dirname, 'lambda', 'route-adder')),
      role,
      timeout: cdk.Duration.seconds(30),
      environment: {
        vpc_id: props.peerVpcId,
        peer_region: props.peerRegion,
        peering_connection_id: peeringConnectionId,
        destination_cidr: props.localCidr,
      },
    });

    NagSuppressions.addResourceSuppressions(fn, [
      { id: 'AwsSolutions-L1', reason: 'Python 3.12 is current LTS' },
    ], true);

    const customResource = new cf.CfnCustomResource(this, 'RouteAdderCR', {
      serviceToken: fn.functionArn,
    });
    customResource.node.addDependency(fn);
  }
}
