import * as cdk from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';

import { importVpc, importSg, VpcImportProps } from './imports';

export interface DatabaseReplicaStackProps extends cdk.StackProps {
  readonly project: string;
  readonly vpcImport: VpcImportProps;
  readonly databaseSgId: string;
  readonly globalClusterIdentifier: string;
}

export class DatabaseReplicaStack extends cdk.Stack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly encryptionKey: kms.Key;

  constructor(scope: cdk.App, id: string, props: DatabaseReplicaStackProps) {
    super(scope, id, props);

    const vpc = importVpc(this, props.vpcImport);
    const databaseSg = importSg(this, 'DatabaseSg', props.databaseSgId);

    this.encryptionKey = new kms.Key(this, 'DbEncryptionKey', {
      alias: `${props.project}-db-secondary`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.cluster = new rds.DatabaseCluster(this, 'SecondaryCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      writer: rds.ClusterInstance.provisioned('Reader', {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.LARGE),
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSg],
      storageEncryptionKey: this.encryptionKey,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Attach to global cluster as secondary
    const cfnCluster = this.cluster.node.defaultChild as rds.CfnDBCluster;
    cfnCluster.globalClusterIdentifier = props.globalClusterIdentifier;

    // Secondary clusters don't have credentials — they inherit from the global cluster
    cfnCluster.addPropertyDeletionOverride('MasterUsername');
    cfnCluster.addPropertyDeletionOverride('MasterUserPassword');
    cfnCluster.addPropertyDeletionOverride('DatabaseName');

    new cdk.CfnOutput(this, 'ClusterIdentifier', { value: this.cluster.clusterIdentifier });
    new cdk.CfnOutput(this, 'ClusterReaderEndpoint', { value: this.cluster.clusterReadEndpoint.hostname });
    new cdk.CfnOutput(this, 'EncryptionKeyArn', { value: this.encryptionKey.keyArn });
  }
}
