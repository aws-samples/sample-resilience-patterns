import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DatabasePrimaryStackProps extends cdk.StackProps {
  readonly project: string;
  readonly globalClusterId: string;
  readonly vpcId: string;
  readonly subnetIds: string[];
  readonly engineVersion?: string;
  readonly dbUsername?: string;
  readonly dbName?: string;
}

/** us-east-2 -> use2, us-west-2 -> usw2, eu-central-1 -> euc1 (cluster identifier suffix). */
export function regionShort(region: string): string {
  const parts = region.split('-');
  return parts.slice(0, -1).map((p) => p[0]).join('') + parts[parts.length - 1];
}

/**
 * Aurora Global Database, primary side: the global cluster plus the primary regional
 * Aurora PostgreSQL Serverless v2 cluster with one writer. Master credentials live in Secrets
 * Manager and are resolved by CloudFormation at create time. Ingress from both workload CIDRs
 * so the recovered EC2 in the secondary can still reach whichever cluster is the writer.
 */
export class DatabasePrimaryStack extends cdk.Stack {
  public readonly cluster: rds.CfnDBCluster;
  public readonly secret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DatabasePrimaryStackProps) {
    super(scope, id, props);
    const { project } = props;
    const engineVersion = props.engineVersion ?? '16.8';
    const dbUsername = props.dbUsername ?? 'drsadmin';
    const dbName = props.dbName ?? project;
    const short = regionShort(this.region); // env.region is always set by bin/app.ts

    this.secret = new secretsmanager.Secret(this, 'DbSecret', {
      secretName: `${project}/aurora/master`,
      description: `Aurora master credentials for ${project}`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: dbUsername }),
        generateStringKey: 'password',
        passwordLength: 24,
        // RDS forbids / @ " and space. The rest are for the delivery path: the app instance
        // writes the password into a systemd unit as `Environment=DB_PASSWORD=<value>` from a
        // shell heredoc, where % is a systemd specifier, ' and \ are systemd quoting, and $ and `
        // are expanded by the shell. A % in a generated password produced a DB login failure in
        // the original demo (one redeploy in ~four).
        excludeCharacters: '"@/\\ %\'$`;',
      },
    });

    const global = new rds.CfnGlobalCluster(this, 'GlobalCluster', {
      globalClusterIdentifier: props.globalClusterId,
      engine: 'aurora-postgresql',
      engineVersion,
      storageEncrypted: true,
    });

    const subnetGroup = new rds.CfnDBSubnetGroup(this, 'DbSubnetGroup', {
      dbSubnetGroupDescription: `${project} primary aurora subnets`,
      subnetIds: props.subnetIds,
    });
    const sg = new ec2.CfnSecurityGroup(this, 'DbSecurityGroup', {
      groupDescription: `${project} primary aurora sg`,
      vpcId: props.vpcId,
      securityGroupIngress: ['10.0.0.0/16', '10.1.0.0/16'].map((cidr) => ({ ipProtocol: 'tcp', fromPort: 5432, toPort: 5432, cidrIp: cidr })),
      tags: [{ key: 'Name', value: `${project}-primary-aurora-sg` }],
    });

    this.cluster = new rds.CfnDBCluster(this, 'PrimaryCluster', {
      dbClusterIdentifier: `${project}-${short}`,
      engine: 'aurora-postgresql',
      engineVersion,
      globalClusterIdentifier: global.ref,
      databaseName: dbName,
      masterUsername: this.secret.secretValueFromJson('username').unsafeUnwrap(),
      masterUserPassword: this.secret.secretValueFromJson('password').unsafeUnwrap(),
      dbSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroupIds: [sg.ref],
      storageEncrypted: true,
      serverlessV2ScalingConfiguration: { minCapacity: 0.5, maxCapacity: 4 },
    });
    new rds.CfnDBInstance(this, 'PrimaryInstance', {
      dbInstanceIdentifier: `${project}-${short}-1`,
      dbClusterIdentifier: this.cluster.ref,
      engine: 'aurora-postgresql',
      dbInstanceClass: 'db.serverless',
      publiclyAccessible: false,
    });

    const out = (key: string, value: string) => new cdk.CfnOutput(this, key, { value, exportName: `${project}-${key}` });
    out('GlobalClusterId', global.ref);
    out('PrimaryClusterId', this.cluster.ref);
    out('PrimaryClusterArn', `arn:${this.partition}:rds:${this.region}:${this.account}:cluster:${project}-${short}`);
    out('PrimaryWriterEndpoint', this.cluster.attrEndpointAddress);
    out('DbSecretArn', this.secret.secretArn);
    out('DbName', dbName);
  }
}
