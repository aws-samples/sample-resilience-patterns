import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export interface VpcPeeringStackProps extends cdk.StackProps {
  readonly project: string;
  readonly primaryVpcId: string;
  readonly secondaryVpcId: string;
  readonly primaryRegion: string;
  readonly secondaryRegion: string;
  readonly primaryCidr: string;
  readonly secondaryCidr: string;
}

export class VpcPeeringStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: VpcPeeringStackProps) {
    super(scope, id, props);

    const peering = new ec2.CfnVPCPeeringConnection(this, 'Peering', {
      vpcId: props.primaryVpcId,
      peerVpcId: props.secondaryVpcId,
      peerRegion: props.secondaryRegion,
    });

    // Primary VPC routes are added via Makefile using AWS CLI after peering is accepted,
    // since route table IDs must be resolved at deploy time from CloudFormation outputs.
    // Secondary VPC routes require a cross-region CLI call.

    new cdk.CfnOutput(this, 'PeeringConnectionId', { value: peering.attrId });
  }
}
