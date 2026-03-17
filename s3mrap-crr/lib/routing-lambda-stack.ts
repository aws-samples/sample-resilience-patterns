import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export interface RoutingLambdaStackProps extends cdk.StackProps {
  readonly project: string;
  readonly primaryBucketName: string;
  readonly secondaryBucketName: string;
  readonly primaryRegion: string;
  readonly secondaryRegion: string;
  readonly accountId: string;
  readonly mrapName: string;
  readonly mrapAlias: string;
}

export class RoutingLambdaStack extends cdk.Stack {
  public readonly functionArn: string;

  constructor(scope: cdk.App, id: string, props: RoutingLambdaStackProps) {
    super(scope, id, props);

    const mrapArn = props.mrapAlias
      ? `arn:aws:s3::${props.accountId}:accesspoint/${props.mrapAlias}`
      : `arn:aws:s3::${props.accountId}:accesspoint/*`;

    const routingFn = new lambda.Function(this, 'MrapRoutingFunction', {
      functionName: `${props.project}-mrap-routing`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'mrap-routing')),
      timeout: cdk.Duration.minutes(2),
      reservedConcurrentExecutions: 5,
      environment: {
        ACCOUNT_ID: props.accountId,
        MRAP_ARN: `arn:aws:s3::${props.accountId}:accesspoint/${props.mrapAlias}`,
        PRIMARY_BUCKET: props.primaryBucketName,
        SECONDARY_BUCKET: props.secondaryBucketName,
        PRIMARY_REGION: props.primaryRegion,
        SECONDARY_REGION: props.secondaryRegion,
      },
    });

    routingFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        's3:SubmitMultiRegionAccessPointRoutes',
        's3:GetMultiRegionAccessPointRoutes',
      ],
      resources: [mrapArn],
    }));

    routingFn.addPermission('ArcInvoke', {
      principal: new iam.ServicePrincipal('arc-region-switch.amazonaws.com'),
      action: 'lambda:InvokeFunction',
    });

    this.functionArn = routingFn.functionArn;

    new cdk.CfnOutput(this, 'RoutingFunctionArn', { value: routingFn.functionArn });
  }
}
