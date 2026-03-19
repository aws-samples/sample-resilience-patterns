import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export interface DsqlAppStackProps extends cdk.StackProps {
  readonly project: string;
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly albSg: ec2.ISecurityGroup;
  readonly dsqlEndpoint: string;
}

export class DsqlAppStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly fn: lambda.Function;

  constructor(scope: cdk.App, id: string, props: DsqlAppStackProps) {
    super(scope, id, props);

    this.fn = new lambda.Function(this, 'DsqlAppFunction', {
      functionName: `${props.project}-dsql-app-${this.region}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'dsql-app')),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      timeout: cdk.Duration.seconds(60),
      reservedConcurrentExecutions: 5,
      environment: {
        DSQL_ENDPOINT: props.dsqlEndpoint,
      },
    });

    // DSQL IAM auth — generate-db-connect-admin-auth-token
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dsql:DbConnectAdmin'],
      resources: ['*'],
    }));

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${props.project}-dsql-${this.region}`,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      internetFacing: false,
      securityGroup: props.albSg,
    });

    const listener = this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    listener.addTargets('LambdaTarget', {
      targets: [new targets.LambdaTarget(this.fn)],
      healthCheck: {
        enabled: true,
        path: '/health',
      },
    });

    new cdk.CfnOutput(this, 'AlbDnsName', { value: this.alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'AlbArn', { value: this.alb.loadBalancerArn });
    new cdk.CfnOutput(this, 'AlbHostedZoneId', { value: this.alb.loadBalancerCanonicalHostedZoneId });
  }
}
