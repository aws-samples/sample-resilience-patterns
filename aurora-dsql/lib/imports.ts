import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface VpcImportProps {
  readonly vpcId: string;
  readonly subnetIds: string;  // comma-separated
  readonly azs: string;        // comma-separated
}

export function importVpc(scope: Construct, props: VpcImportProps): ec2.IVpc {
  return ec2.Vpc.fromVpcAttributes(scope, 'ImportedVpc', {
    vpcId: props.vpcId,
    availabilityZones: props.azs.split(','),
    isolatedSubnetIds: props.subnetIds.split(','),
  });
}

export function importSg(scope: Construct, id: string, sgId: string): ec2.ISecurityGroup {
  return ec2.SecurityGroup.fromSecurityGroupId(scope, id, sgId);
}
