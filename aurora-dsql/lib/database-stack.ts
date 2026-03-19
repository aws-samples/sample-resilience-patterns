import * as cdk from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

import { importVpc, importSg, VpcImportProps } from './imports';

export interface DatabaseStackProps extends cdk.StackProps {
  readonly project: string;
  readonly vpcImport: VpcImportProps;
  readonly databaseSgId: string;
  readonly globalClusterIdentifier: string;
  readonly secondaryRegion: string;
}

export class DatabaseStack extends cdk.Stack {
  public readonly globalCluster: rds.CfnGlobalCluster;
  public readonly cluster: rds.DatabaseCluster;
  public readonly encryptionKey: kms.Key;
  public readonly secret: secretsmanager.ISecret;

  constructor(scope: cdk.App, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const vpc = importVpc(this, props.vpcImport);
    const databaseSg = importSg(this, 'DatabaseSg', props.databaseSgId);

    this.encryptionKey = new kms.Key(this, 'DbEncryptionKey', {
      alias: `${props.project}-db-primary`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.globalCluster = new rds.CfnGlobalCluster(this, 'GlobalCluster', {
      globalClusterIdentifier: props.globalClusterIdentifier,
      engine: 'aurora-postgresql',
      engineVersion: '16.6',
      storageEncrypted: true,
      deletionProtection: false,
    });

    this.cluster = new rds.DatabaseCluster(this, 'PrimaryCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      writer: rds.ClusterInstance.provisioned('Writer', {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.LARGE),
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSg],
      storageEncryptionKey: this.encryptionKey,
      credentials: rds.Credentials.fromGeneratedSecret('dbadmin', {
        secretName: `${props.project}/db-credentials`,
        encryptionKey: this.encryptionKey,
      }),
      defaultDatabaseName: 'orders',
      backup: { retention: cdk.Duration.days(7) },
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Attach to global cluster
    const cfnCluster = this.cluster.node.defaultChild as rds.CfnDBCluster;
    cfnCluster.globalClusterIdentifier = props.globalClusterIdentifier;
    cfnCluster.addDependency(this.globalCluster);

    this.secret = this.cluster.secret!;

    // Replicate credentials to secondary region for cross-region app access
    const cfnSecret = this.secret.node.defaultChild as secretsmanager.CfnSecret;
    cfnSecret.addPropertyOverride('ReplicaRegions', [
      { Region: props.secondaryRegion },
    ]);

    new cdk.CfnOutput(this, 'GlobalClusterArn', {
      value: `arn:aws:rds::${this.account}:global-cluster:${props.globalClusterIdentifier}`,
    });
    new cdk.CfnOutput(this, 'ClusterIdentifier', { value: this.cluster.clusterIdentifier });
    new cdk.CfnOutput(this, 'ClusterEndpoint', { value: this.cluster.clusterEndpoint.hostname });
    new cdk.CfnOutput(this, 'ClusterReaderEndpoint', { value: this.cluster.clusterReadEndpoint.hostname });
    new cdk.CfnOutput(this, 'SecretArn', { value: this.secret.secretArn });
    new cdk.CfnOutput(this, 'EncryptionKeyArn', { value: this.encryptionKey.keyArn });
  }
}
