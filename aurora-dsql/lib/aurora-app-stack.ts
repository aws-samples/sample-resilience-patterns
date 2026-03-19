import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

import { importVpc, importSg, VpcImportProps } from './imports';

export interface AuroraAppStackProps extends cdk.StackProps {
  readonly project: string;
  readonly vpcImport: VpcImportProps;
  readonly lambdaSgId: string;
  readonly albSgId: string;
  readonly secretArn: string;
  readonly encryptionKeyArn: string;
}

export class AuroraAppStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly fn: lambda.Function;

  constructor(scope: cdk.App, id: string, props: AuroraAppStackProps) {
    super(scope, id, props);

    const vpc = importVpc(this, props.vpcImport);
    const lambdaSg = importSg(this, 'LambdaSg', props.lambdaSgId);
    const albSg = importSg(this, 'AlbSg', props.albSgId);

    this.fn = new lambda.Function(this, 'AuroraAppFunction', {
      functionName: `${props.project}-aurora-app-${this.region}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'aurora-app')),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      timeout: cdk.Duration.seconds(60),
      reservedConcurrentExecutions: 5,
      environment: {
        DB_SECRET_ARN: props.secretArn,
      },
    });

    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.secretArn],
    }));

    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [props.encryptionKeyArn],
    }));

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${props.project}-aurora-${this.region}`,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      internetFacing: false,
      securityGroup: albSg,
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
