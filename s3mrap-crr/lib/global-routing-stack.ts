import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';

export interface GlobalRoutingStackProps extends cdk.StackProps {
  readonly project: string;
  readonly primaryBucketName: string;
  readonly secondaryBucketName: string;
  readonly primaryRegion: string;
  readonly secondaryRegion: string;
  readonly accountId: string;
  readonly encryptionKeyId: string;
}

export class GlobalRoutingStack extends cdk.Stack {
  public readonly mrapAlias: string;

  constructor(scope: cdk.App, id: string, props: GlobalRoutingStackProps) {
    super(scope, id, props);

    // S3 Multi-Region Access Point
    const mrap = new s3.CfnMultiRegionAccessPoint(this, 'MRAP', {
      name: `${props.project}-mrap`,
      regions: [
        { bucket: props.primaryBucketName },
        { bucket: props.secondaryBucketName },
      ],
      publicAccessBlockConfiguration: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
    });

    // IAM role for S3 replication
    const replicationRole = new iam.Role(this, 'ReplicationRole', {
      assumedBy: new iam.ServicePrincipal('s3.amazonaws.com'),
    });

    replicationRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:GetReplicationConfiguration',
        's3:ListBucket',
        's3:GetObjectVersionForReplication',
        's3:GetObjectVersionAcl',
        's3:GetObjectVersionTagging',
      ],
      resources: [
        `arn:aws:s3:::${props.primaryBucketName}`,
        `arn:aws:s3:::${props.primaryBucketName}/*`,
        `arn:aws:s3:::${props.secondaryBucketName}`,
        `arn:aws:s3:::${props.secondaryBucketName}/*`,
      ],
    }));

    replicationRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:ReplicateObject',
        's3:ReplicateDelete',
        's3:ReplicateTags',
        's3:ObjectOwnerOverrideToBucketOwner',
      ],
      resources: [
        `arn:aws:s3:::${props.primaryBucketName}/*`,
        `arn:aws:s3:::${props.secondaryBucketName}/*`,
      ],
    }));

    // KMS permissions for CRR with MRK-encrypted buckets (same key ID in both regions)
    replicationRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'],
      resources: [
        `arn:aws:kms:${props.primaryRegion}:${props.accountId}:key/${props.encryptionKeyId}`,
        `arn:aws:kms:${props.secondaryRegion}:${props.accountId}:key/${props.encryptionKeyId}`,
      ],
    }));

    // Custom resource Lambda for bidirectional CRR
    const crrFn = new lambda.Function(this, 'CrrFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'crr-custom-resource')),
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 1,
      environment: {
        PRIMARY_BUCKET: props.primaryBucketName,
        SECONDARY_BUCKET: props.secondaryBucketName,
        PRIMARY_REGION: props.primaryRegion,
        SECONDARY_REGION: props.secondaryRegion,
        REPLICATION_ROLE_ARN: replicationRole.roleArn,
        ENCRYPTION_KEY_ID: props.encryptionKeyId,
      },
    });

    crrFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        's3:PutReplicationConfiguration',
        's3:GetReplicationConfiguration',
        's3:PutBucketVersioning',
        's3:GetBucketVersioning',
        's3:GetBucketLocation',
      ],
      resources: [
        `arn:aws:s3:::${props.primaryBucketName}`,
        `arn:aws:s3:::${props.secondaryBucketName}`,
      ],
    }));

    crrFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [replicationRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 's3.amazonaws.com' } },
    }));

    const crrProvider = new cr.Provider(this, 'CrrProvider', {
      onEventHandler: crrFn,
    });

    const crrResource = new cdk.CustomResource(this, 'CrrConfig', {
      serviceToken: crrProvider.serviceToken,
    });

    crrResource.node.addDependency(mrap);

    // Set initial MRAP routing: primary=100%, secondary=0%
    const initialRouting = new cr.AwsCustomResource(this, 'InitialRouting', {
      installLatestAwsSdk: false,
      onCreate: {
        service: 'S3Control',
        action: 'submitMultiRegionAccessPointRoutes',
        parameters: {
          AccountId: props.accountId,
          Mrap: `arn:aws:s3::${props.accountId}:accesspoint/${mrap.attrAlias}`,
          RouteUpdates: [
            { Bucket: props.primaryBucketName, Region: props.primaryRegion, TrafficDialPercentage: 100 },
            { Bucket: props.secondaryBucketName, Region: props.secondaryRegion, TrafficDialPercentage: 0 },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of('initial-mrap-routing'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['s3:SubmitMultiRegionAccessPointRoutes'],
          resources: [`arn:aws:s3::${props.accountId}:accesspoint/*`],
        }),
      ]),
    });
    initialRouting.node.addDependency(mrap);

    // Outputs
    new cdk.CfnOutput(this, 'MrapAlias', { value: mrap.attrAlias });
    new cdk.CfnOutput(this, 'MrapArn', {
      value: `arn:aws:s3::${props.accountId}:accesspoint/${mrap.attrAlias}`,
    });
    new cdk.CfnOutput(this, 'ReplicationRoleArn', { value: replicationRole.roleArn });
  }
}
