import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { regionShort } from './database-primary-stack';

export interface DatabaseSecondaryStackProps extends cdk.StackProps {
  readonly project: string;
  readonly globalClusterId: string;
  readonly vpcId: string;
  readonly subnetIds: string[];
  /** KMS key in THIS region for the encrypted replica. The primary is StorageEncrypted, so the
   *  replica must be too and CloudFormation will not default the key. Default: alias/aws/rds. */
  readonly kmsKeyId?: string;
  readonly engineVersion?: string;
}

/**
 * Aurora Global Database, secondary side: a headless-writer regional cluster that joins the
 * global cluster created by the primary stack. No master credentials here -- they belong to the
 * global cluster. Deleted BEFORE the primary on teardown (it must leave the global cluster first).
 */
export class DatabaseSecondaryStack extends cdk.Stack {
  public readonly cluster: rds.CfnDBCluster;

  constructor(scope: Construct, id: string, props: DatabaseSecondaryStackProps) {
    super(scope, id, props);
    const { project } = props;
    const engineVersion = props.engineVersion ?? '16.8';
    const short = regionShort(this.region);

    const subnetGroup = new rds.CfnDBSubnetGroup(this, 'DbSubnetGroup', {
      dbSubnetGroupDescription: `${project} secondary aurora subnets`,
      subnetIds: props.subnetIds,
    });
    const sg = new ec2.CfnSecurityGroup(this, 'DbSecurityGroup', {
      groupDescription: `${project} secondary aurora sg`,
      vpcId: props.vpcId,
      securityGroupIngress: ['10.1.0.0/16', '10.0.0.0/16'].map((cidr) => ({ ipProtocol: 'tcp', fromPort: 5432, toPort: 5432, cidrIp: cidr })),
      tags: [{ key: 'Name', value: `${project}-secondary-aurora-sg` }],
    });

    this.cluster = new rds.CfnDBCluster(this, 'SecondaryCluster', {
      dbClusterIdentifier: `${project}-${short}`,
      engine: 'aurora-postgresql',
      engineVersion,
      globalClusterIdentifier: props.globalClusterId,
      dbSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroupIds: [sg.ref],
      storageEncrypted: true,
      kmsKeyId: props.kmsKeyId ?? 'alias/aws/rds',
      serverlessV2ScalingConfiguration: { minCapacity: 0.5, maxCapacity: 4 },
    });
    new rds.CfnDBInstance(this, 'SecondaryInstance', {
      dbInstanceIdentifier: `${project}-${short}-1`,
      dbClusterIdentifier: this.cluster.ref,
      engine: 'aurora-postgresql',
      dbInstanceClass: 'db.serverless',
      publiclyAccessible: false,
    });

    const out = (key: string, value: string) => new cdk.CfnOutput(this, key, { value, exportName: `${project}-${key}` });
    out('SecondaryClusterId', this.cluster.ref);
    out('SecondaryClusterArn', `arn:${this.partition}:rds:${this.region}:${this.account}:cluster:${project}-${short}`);
    out('SecondaryWriterEndpoint', this.cluster.attrEndpointAddress);
  }
}
