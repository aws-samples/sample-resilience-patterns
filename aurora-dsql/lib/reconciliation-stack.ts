import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';

export interface ReconciliationStackProps extends cdk.StackProps {
  readonly project: string;
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly secretArn: string;
  readonly encryptionKeyArn: string;
  readonly globalClusterIdentifier: string;
  readonly primaryRegion: string;
  readonly secondaryRegion: string;
}

export class ReconciliationStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: ReconciliationStackProps) {
    super(scope, id, props);

    const reconcileFn = new lambda.Function(this, 'ReconcileFunction', {
      functionName: `${props.project}-reconcile-${this.region}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'reconciliation')),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      timeout: cdk.Duration.minutes(10),
      reservedConcurrentExecutions: 5,
      environment: {
        DB_SECRET_ARN: props.secretArn,
      },
    });

    reconcileFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.secretArn],
    }));

    reconcileFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [props.encryptionKeyArn],
    }));

    // SSM Automation role
    const automationRole = new iam.Role(this, 'AutomationRole', {
      assumedBy: new iam.ServicePrincipal('ssm.amazonaws.com'),
    });

    automationRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [reconcileFn.functionArn],
    }));

    automationRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'rds:RestoreDBClusterFromSnapshot', 'rds:DescribeDBClusterSnapshots',
        'rds:DescribeDBClusters', 'rds:CreateDBInstance', 'rds:DescribeDBInstances',
        'rds:DeleteDBCluster', 'rds:DeleteDBInstance',
      ],
      resources: [`arn:aws:rds:${this.region}:${this.account}:cluster:${props.project}-reconciliation-*`],
    }));

    automationRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:CreateGrant', 'kms:DescribeKey'],
      resources: [props.encryptionKeyArn],
    }));

    // Snapshot & Copy SSM Document
    new ssm.CfnDocument(this, 'SnapshotCopyDoc', {
      documentType: 'Automation',
      name: `${props.project}-snapshot-copy-${this.region}`,
      content: {
        schemaVersion: '0.3',
        description: 'Snapshot Aurora cluster and copy cross-region',
        assumeRole: automationRole.roleArn,
        parameters: {
          SourceSnapshotArn: { type: 'String', description: 'ARN of the source snapshot to copy' },
        },
        mainSteps: [
          {
            name: 'CopySnapshot',
            action: 'aws:executeScript',
            inputs: {
              Runtime: 'python3.11',
              Handler: 'handler',
              InputPayload: { SourceSnapshotArn: '{{SourceSnapshotArn}}' },
              Script: `
def handler(event, context):
    import boto3
    client = boto3.client('rds')
    src_arn = event['SourceSnapshotArn']
    target_id = src_arn.split(':')[-1] + '-copy'
    resp = client.copy_db_cluster_snapshot(
        SourceDBClusterSnapshotIdentifier=src_arn,
        TargetDBClusterSnapshotIdentifier=target_id,
        CopyTags=True,
    )
    return {'CopyStatus': resp['DBClusterSnapshot']['Status']}
`,
            },
          },
        ],
      },
    });

    // Restore & Reconcile SSM Document
    new ssm.CfnDocument(this, 'RestoreReconcileDoc', {
      documentType: 'Automation',
      name: `${props.project}-restore-reconcile-${this.region}`,
      content: {
        schemaVersion: '0.3',
        description: 'Restore snapshot to temp cluster and run reconciliation',
        assumeRole: automationRole.roleArn,
        parameters: {
          SnapshotArn: { type: 'String', description: 'ARN of the snapshot to restore' },
          TargetDbEndpoint: { type: 'String', description: 'Endpoint of the new primary DB to compare against' },
        },
        mainSteps: [
          {
            name: 'RestoreCluster',
            action: 'aws:executeAwsApi',
            inputs: {
              Service: 'rds',
              Api: 'RestoreDBClusterFromSnapshot',
              DBClusterIdentifier: `${props.project}-reconciliation-{{automation:EXECUTION_ID}}`,
              Engine: 'aurora-postgresql',
              SnapshotIdentifier: '{{SnapshotArn}}',
              DeletionProtection: false,
            },
            outputs: [
              { Name: 'ClusterId', Selector: '$.DBCluster.DBClusterIdentifier', Type: 'String' },
              { Name: 'ClusterEndpoint', Selector: '$.DBCluster.Endpoint', Type: 'String' },
            ],
          },
          {
            name: 'WaitForCluster',
            action: 'aws:waitForAwsResourceProperty',
            inputs: {
              Service: 'rds',
              Api: 'DescribeDBClusters',
              DBClusterIdentifier: '{{RestoreCluster.ClusterId}}',
              PropertySelector: '$.DBClusters[0].Status',
              DesiredValues: ['available'],
            },
          },
          {
            name: 'CreateInstance',
            action: 'aws:executeAwsApi',
            inputs: {
              Service: 'rds',
              Api: 'CreateDBInstance',
              DBInstanceIdentifier: `${props.project}-recon-inst-{{automation:EXECUTION_ID}}`,
              DBClusterIdentifier: '{{RestoreCluster.ClusterId}}',
              Engine: 'aurora-postgresql',
              DBInstanceClass: 'db.t4g.medium',
            },
          },
          {
            name: 'WaitForInstance',
            action: 'aws:waitForAwsResourceProperty',
            inputs: {
              Service: 'rds',
              Api: 'DescribeDBInstances',
              DBInstanceIdentifier: `${props.project}-recon-inst-{{automation:EXECUTION_ID}}`,
              PropertySelector: '$.DBInstances[0].DBInstanceStatus',
              DesiredValues: ['available'],
            },
          },
          {
            name: 'RunReconciliation',
            action: 'aws:invokeLambdaFunction',
            inputs: {
              FunctionName: reconcileFn.functionName,
              InputPayload: JSON.stringify({
                source_db_endpoint: '{{RestoreCluster.ClusterEndpoint}}',
                target_db_endpoint: '{{TargetDbEndpoint}}',
              }),
            },
          },
        ],
      },
    });
  }
}
