import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';

export interface BootstrapStackProps extends cdk.StackProps {
  readonly project: string;
  readonly primaryRegion: string;
  readonly secondaryRegion: string;
}

export class BootstrapStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: BootstrapStackProps) {
    super(scope, id, props);

    const encryptionKey = new kms.Key(this, 'ArtifactKey', {
      alias: `${props.project}-artifacts`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `${props.project}-codebuild-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const sourceDeployment = new s3deploy.BucketDeployment(this, 'SourceUpload', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..'), {
        exclude: ['.git', 'node_modules', 'cdk.out', 'cdk.out.*', 'dist', '.specs'],
      })],
      destinationBucket: artifactBucket,
      destinationKeyPrefix: 'source',
      extract: true,
    });

    const buildRole = new iam.Role(this, 'BuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });

    buildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
    }));

    buildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks', 'cloudformation:ListStacks',
        'cloudformation:DescribeStackResources'],
      resources: ['*'],
    }));

    buildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:*:${this.account}:parameter/cdk-bootstrap/*`],
    }));

    // Makefile needs these for VPC peering route setup and output capture
    buildRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ec2:DescribeRouteTables', 'ec2:CreateRoute',
        'ec2:AcceptVpcPeeringConnection', 'ec2:DescribeVpcPeeringConnections',
        'rds:DescribeDBClusters', 'rds:DescribeGlobalClusters',
        'dsql:GetCluster',
      ],
      resources: ['*'],
    }));

    buildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['arc-region-switch:ListRoute53HealthChecks', 'arc-region-switch:ListPlans'],
      resources: ['*'],
    }));

    artifactBucket.grantRead(buildRole);

    const cbProject = new codebuild.Project(this, 'DeployProject', {
      projectName: `${props.project}-deploy`,
      source: codebuild.Source.s3({
        bucket: artifactBucket,
        path: 'source/',
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      environmentVariables: {
        PROJECT: { value: props.project },
        PRIMARY_REGION: { value: props.primaryRegion },
        SECONDARY_REGION: { value: props.secondaryRegion },
        ACCOUNT_ID: { value: this.account },
      },
      role: buildRole,
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
      timeout: cdk.Duration.minutes(60),
    });

    const triggerFn = new lambda.Function(this, 'BuildTriggerFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.on_event',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'build-trigger')),
      timeout: cdk.Duration.minutes(1),
    });

    triggerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      resources: [cbProject.projectArn],
    }));

    const isCompleteFn = new lambda.Function(this, 'BuildIsCompleteFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.is_complete',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'build-trigger')),
      timeout: cdk.Duration.seconds(30),
    });

    isCompleteFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['codebuild:BatchGetBuilds'],
      resources: [cbProject.projectArn],
    }));

    const buildProvider = new cr.Provider(this, 'BuildProvider', {
      onEventHandler: triggerFn,
      isCompleteHandler: isCompleteFn,
      queryInterval: cdk.Duration.seconds(30),
      totalTimeout: cdk.Duration.minutes(60),
    });

    const buildTrigger = new cdk.CustomResource(this, 'BuildTrigger', {
      serviceToken: buildProvider.serviceToken,
      properties: {
        ProjectName: cbProject.projectName,
        Timestamp: Date.now().toString(),
      },
    });

    buildTrigger.node.addDependency(sourceDeployment);
    buildTrigger.node.addDependency(cbProject);

    new cdk.CfnOutput(this, 'ArtifactBucketName', { value: artifactBucket.bucketName });
    new cdk.CfnOutput(this, 'ProjectName', { value: cbProject.projectName });
  }
}
