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

    // Create the primary DBCluster FIRST as a standalone cluster.
    // Do NOT set GlobalClusterIdentifier on the CfnDBCluster — this avoids
    // the CFN delete-time race where the DBCluster handler looks up the
    // referenced global cluster, gets a 404 after the global cluster is
    // deleted, and misinterprets it as "cluster already deleted". See
    // commit message for commit adding this comment for full analysis.
    this.cluster = new rds.DatabaseCluster(this, 'PrimaryCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_8,
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

    // Promote the existing DBCluster into a global cluster by setting
    // SourceDBClusterIdentifier. The GlobalCluster resource DependsOn
    // the DBCluster, so CFN creates the DBCluster first, then wraps it.
    // On delete: CFN deletes GlobalCluster first (before DBCluster),
    // which is a clean AWS API operation when the source cluster is
    // still alive. DBCluster then deletes normally with no global
    // reference to race against.
    this.globalCluster = new rds.CfnGlobalCluster(this, 'GlobalCluster', {
      globalClusterIdentifier: props.globalClusterIdentifier,
      sourceDbClusterIdentifier: this.cluster.clusterArn,
      deletionProtection: false,
      // engine/engineVersion/storageEncrypted are inherited from the source
    });
    this.globalCluster.addDependency(this.cluster.node.defaultChild as cdk.CfnResource);

    this.secret = this.cluster.secret!;

    // Replicate credentials to secondary region for cross-region app access
    // The secret is created by RDS — find the CfnSecret and add replication
    const secretConstruct = this.cluster.node.findAll().find(
      c => (c as any).cfnResourceType === 'AWS::SecretsManager::Secret'
    ) as secretsmanager.CfnSecret | undefined;
    if (secretConstruct) {
      secretConstruct.addPropertyOverride('ReplicaRegions', [
        { Region: props.secondaryRegion },
      ]);
    }

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
