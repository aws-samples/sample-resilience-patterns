import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
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

    // WaitCondition: CodeBuild signals when deploy completes (no 1-hour Lambda limit)
    const waitHandle = new cdk.CfnWaitConditionHandle(this, 'DeployWaitHandle');

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
        WAIT_HANDLE_URL: { value: waitHandle.ref },
      },
      role: buildRole,
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
      timeout: cdk.Duration.minutes(150),
    });

    // Trigger build via custom resource (lightweight — just starts the build, doesn't wait)
    const triggerRole = new iam.Role(this, 'TriggerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    triggerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['codebuild:StartBuild'],
      resources: [cbProject.projectArn],
    }));

    const triggerFn = new cdk.aws_lambda.Function(this, 'BuildTriggerFunction', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      role: triggerRole,
      timeout: cdk.Duration.seconds(30),
      code: cdk.aws_lambda.Code.fromInline(`
import boto3, json, urllib.request
def handler(event, context):
    status = 'SUCCESS'
    data = {}
    physical_id = event.get('PhysicalResourceId', 'build-trigger')
    try:
        if event['RequestType'] != 'Delete':
            cb = boto3.client('codebuild')
            resp = cb.start_build(projectName=event['ResourceProperties']['ProjectName'])
            physical_id = resp['build']['id']
            data = {'BuildId': physical_id}
    except Exception as e:
        status = 'FAILED'
        data = {'Error': str(e)}
    body = json.dumps({
        'Status': status,
        'Reason': json.dumps(data),
        'PhysicalResourceId': physical_id,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data,
    }).encode()
    req = urllib.request.Request(event['ResponseURL'], data=body, method='PUT')
    req.add_header('Content-Type', '')
    req.add_header('Content-Length', str(len(body)))
    urllib.request.urlopen(req)
`),
    });

    const trigger = new cdk.CustomResource(this, 'BuildTrigger', {
      serviceToken: triggerFn.functionArn,
      properties: {
        ProjectName: cbProject.projectName,
        Timestamp: Date.now().toString(),
      },
    });
    trigger.node.addDependency(sourceDeployment);
    trigger.node.addDependency(cbProject);

    // WaitCondition: waits for CodeBuild to signal completion (up to 150 min)
    const waitCondition = new cdk.CfnWaitCondition(this, 'DeployWaitCondition', {
      handle: waitHandle.ref,
      timeout: '9000', // 150 minutes in seconds
      count: 1,
    });
    waitCondition.addDependency(trigger.node.defaultChild as cdk.CfnResource);

    new cdk.CfnOutput(this, 'ArtifactBucketName', { value: artifactBucket.bucketName });
    new cdk.CfnOutput(this, 'ProjectName', { value: cbProject.projectName });
  }
}
