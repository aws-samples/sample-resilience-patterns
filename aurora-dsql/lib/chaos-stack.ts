import * as cdk from 'aws-cdk-lib';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';

export interface ChaosStackProps extends cdk.StackProps {
  readonly project: string;
  readonly targetRegion: string;
  readonly duration?: string;
}

export class ChaosStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: ChaosStackProps) {
    super(scope, id, props);

    const duration = props.duration || 'PT20M';

    const logKey = new kms.Key(this, 'FisLogKey', {
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Grant CloudWatch Logs access to the KMS key
    logKey.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
      principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
      resources: ['*'],
    }));

    const logGroup = new logs.LogGroup(this, 'FisLogGroup', {
      logGroupName: `${props.project}-chaos-${this.region}`,
      retention: logs.RetentionDays.ONE_WEEK,
      encryptionKey: logKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fisRole = new iam.Role(this, 'FisRole', {
      assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
    });

    // Network disruption permissions
    fisRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ec2:DescribeRouteTables', 'ec2:DescribeSubnets', 'ec2:DescribeVpcs',
        'ec2:DescribeVpcPeeringConnections', 'ec2:DescribeNetworkInterfaces',
        'ec2:DescribeManagedPrefixLists', 'ec2:DescribeVpcEndpoints',
      ],
      resources: ['*'],
    }));

    fisRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ec2:CreateRouteTable', 'ec2:CreateRoute', 'ec2:DeleteRouteTable',
        'ec2:ReplaceRouteTableAssociation', 'ec2:AssociateRouteTable', 'ec2:DisassociateRouteTable',
        'ec2:CreateNetworkInterface', 'ec2:DeleteNetworkInterface',
        'ec2:CreateManagedPrefixList', 'ec2:DeleteManagedPrefixList', 'ec2:ModifyManagedPrefixList',
        'ec2:GetManagedPrefixListEntries', 'ec2:ModifyVpcEndpoint',
        'ec2:CreateTags',
      ],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:ResourceAccount': this.account } },
    }));

    // RDS failover permissions
    fisRole.addToPolicy(new iam.PolicyStatement({
      actions: ['rds:FailoverDBCluster', 'rds:RebootDBInstance'],
      resources: [
        `arn:aws:rds:${this.region}:${this.account}:cluster:*`,
        `arn:aws:rds:${this.region}:${this.account}:db:*`,
      ],
    }));

    // Tag resolution
    fisRole.addToPolicy(new iam.PolicyStatement({
      actions: ['tag:GetResources'],
      resources: ['*'],
    }));

    // Logging
    fisRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogDelivery', 'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups'],
      resources: ['*'],
    }));

    // Cross-region network disruption experiment
    new fis.CfnExperimentTemplate(this, 'NetworkDisruption', {
      description: 'Disrupt cross-region subnet connectivity',
      roleArn: fisRole.roleArn,
      targets: {
        Subnets: {
          resourceType: 'aws:ec2:subnet',
          resourceTags: { ChaosAllowed: 'true' },
          selectionMode: 'ALL',
        },
      },
      actions: {
        DisruptSubnetConnectivity: {
          actionId: 'aws:network:route-table-disrupt-cross-region-connectivity',
          parameters: { duration, region: props.targetRegion },
          targets: { Subnets: 'Subnets' },
        },
      },
      stopConditions: [{ source: 'none' }],
      logConfiguration: {
        logSchemaVersion: 2,
        cloudWatchLogsConfiguration: { logGroupArn: logGroup.logGroupArn },
      },
      tags: { Name: `Cross-Region: Connectivity to ${props.targetRegion}`, Project: props.project },
      experimentOptions: { accountTargeting: 'single-account', emptyTargetResolutionMode: 'skip' },
    });

    // Aurora cluster failover experiment
    new fis.CfnExperimentTemplate(this, 'AuroraFailover', {
      description: 'Force Aurora DB cluster failover',
      roleArn: fisRole.roleArn,
      targets: {
        Clusters: {
          resourceType: 'aws:rds:cluster',
          resourceTags: { ChaosAllowed: 'true' },
          selectionMode: 'ALL',
        },
      },
      actions: {
        FailoverCluster: {
          actionId: 'aws:rds:failover-db-cluster',
          targets: { Clusters: 'Clusters' },
        },
      },
      stopConditions: [{ source: 'none' }],
      logConfiguration: {
        logSchemaVersion: 2,
        cloudWatchLogsConfiguration: { logGroupArn: logGroup.logGroupArn },
      },
      tags: { Name: 'Aurora Cluster Failover', Project: props.project },
      experimentOptions: { accountTargeting: 'single-account', emptyTargetResolutionMode: 'skip' },
    });
  }
}
