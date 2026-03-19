import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';

import { importVpc, importSg, VpcImportProps } from './imports';

export interface LoadGenStackProps extends cdk.StackProps {
  readonly project: string;
  readonly vpcImport: VpcImportProps;
  readonly lambdaSgId: string;
  readonly auroraAlbDns: string;
  readonly dsqlAlbDns: string;
}

export class LoadGenStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: LoadGenStackProps) {
    super(scope, id, props);

    const vpc = importVpc(this, props.vpcImport);
    const lambdaSg = importSg(this, 'LambdaSg', props.lambdaSgId);

    const loadGenFn = new lambda.Function(this, 'LoadGenFunction', {
      functionName: `${props.project}-loadgen`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'loadgen')),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      reservedConcurrentExecutions: 10,
      environment: {
        AURORA_ALB_DNS: props.auroraAlbDns,
        DSQL_ALB_DNS: props.dsqlAlbDns,
      },
    });

    loadGenFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    // SSM Automation Document
    const automationRole = new iam.Role(this, 'AutomationRole', {
      assumedBy: new iam.ServicePrincipal('ssm.amazonaws.com'),
    });

    automationRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [loadGenFn.functionArn],
    }));

    new ssm.CfnDocument(this, 'LoadGenDoc', {
      documentType: 'Automation',
      name: `${props.project}-load-test`,
      content: {
        schemaVersion: '0.3',
        description: 'Generate sustained CRUD load against Aurora and DSQL apps',
        assumeRole: automationRole.roleArn,
        parameters: {
          RequestsPerSecond: { type: 'String', default: '10', description: 'Target RPS' },
          DurationSeconds: { type: 'String', default: '300', description: 'Test duration in seconds' },
          TargetApp: { type: 'String', default: 'both', description: 'aurora, dsql, or both' },
          OperationMix: { type: 'String', default: '50,20,10,20', description: 'insert,update,delete,query percentages' },
        },
        mainSteps: [
          {
            name: 'RunLoadTest',
            action: 'aws:invokeLambdaFunction',
            inputs: {
              FunctionName: loadGenFn.functionName,
              InputPayload: {
                rps: '{{RequestsPerSecond}}',
                duration: '{{DurationSeconds}}',
                target: '{{TargetApp}}',
                mix: '{{OperationMix}}',
              },
            },
          },
        ],
      },
    });

    new cdk.CfnOutput(this, 'LoadGenFunctionArn', { value: loadGenFn.functionArn });
  }
}
