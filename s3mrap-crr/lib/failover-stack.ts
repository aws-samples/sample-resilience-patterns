import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';

export interface FailoverStackProps extends cdk.StackProps {
  readonly project: string;
  readonly primaryBucketName: string;
  readonly secondaryBucketName: string;
  readonly primaryRegion: string;
  readonly secondaryRegion: string;
  readonly accountId: string;
  readonly mrapName: string;
  readonly primaryRoutingLambdaArn: string;
  readonly secondaryRoutingLambdaArn: string;
}

export class FailoverStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: FailoverStackProps) {
    super(scope, id, props);

    // --- Load Test Lambda ---
    const loadTestFn = new lambda.Function(this, 'LoadTestFunction', {
      functionName: `${props.project}-load-test`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'load-test')),
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      environment: {
        PRIMARY_BUCKET: props.primaryBucketName,
        SECONDARY_BUCKET: props.secondaryBucketName,
        PRIMARY_REGION: props.primaryRegion,
        SECONDARY_REGION: props.secondaryRegion,
      },
    });

    loadTestFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject', 's3:HeadObject', 's3:ListBucket'],
      resources: [
        `arn:aws:s3:::${props.primaryBucketName}`,
        `arn:aws:s3:::${props.primaryBucketName}/*`,
        `arn:aws:s3:::${props.secondaryBucketName}`,
        `arn:aws:s3:::${props.secondaryBucketName}/*`,
      ],
    }));

    // --- SSM Automation Document for Load Test ---
    new ssm.CfnDocument(this, 'LoadTestDocument', {
      name: `${props.project}-load-test`,
      documentType: 'Automation',
      content: {
        schemaVersion: '0.3',
        description: 'Run S3 CRR replication latency load test',
        parameters: {
          SourceRegion: {
            type: 'String',
            default: props.primaryRegion,
            allowedValues: [props.primaryRegion, props.secondaryRegion],
            description: 'Region to upload objects to',
          },
          DestRegion: {
            type: 'String',
            default: props.secondaryRegion,
            allowedValues: [props.primaryRegion, props.secondaryRegion],
            description: 'Region to check replication in',
          },
          ObjectCount: {
            type: 'String',
            default: '100',
            description: 'Number of objects to upload',
          },
          ObjectSizeKB: {
            type: 'String',
            default: '10',
            description: 'Size of each object in KB',
          },
          TimeoutSeconds: {
            type: 'String',
            default: '300',
            description: 'Max seconds to wait for replication per object',
          },
        },
        mainSteps: [{
          name: 'RunLoadTest',
          action: 'aws:invokeLambdaFunction',
          inputs: {
            FunctionName: loadTestFn.functionName,
            Payload: '{"sourceRegion":"{{SourceRegion}}","destRegion":"{{DestRegion}}","objectCount":{{ObjectCount}},"objectSizeKB":{{ObjectSizeKB}},"timeoutSeconds":{{TimeoutSeconds}}}',
          },
        }],
      },
    });

    // --- ARC Region Switch Plan ---
    const arcExecutionRole = new iam.Role(this, 'ArcExecutionRole', {
      assumedBy: new iam.ServicePrincipal('arc-region-switch.amazonaws.com'),
    });

    arcExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction', 'lambda:GetFunction'],
      resources: [props.primaryRoutingLambdaArn, props.secondaryRoutingLambdaArn],
    }));

    new cdk.CfnResource(this, 'ArcRegionSwitchPlan', {
      type: 'AWS::ARCRegionSwitch::Plan',
      properties: {
        Name: `${props.project}-region-switch`,
        RecoveryApproach: 'activePassive',
        PrimaryRegion: props.primaryRegion,
        Regions: [props.primaryRegion, props.secondaryRegion],
        ExecutionRole: arcExecutionRole.roleArn,
        Workflows: [{
          WorkflowTargetAction: 'activate',
          WorkflowDescription: 'Update MRAP routing to send traffic to the activating region',
          Steps: [{
            Name: 'update-mrap-routing',
            ExecutionBlockType: 'CustomActionLambda',
            ExecutionBlockConfiguration: {
              CustomActionLambdaConfig: {
                RegionToRun: 'activatingRegion',
                TimeoutMinutes: 2,
                RetryIntervalMinutes: 1,
                Lambdas: [
                  { Arn: props.primaryRoutingLambdaArn },
                  { Arn: props.secondaryRoutingLambdaArn },
                ],
              },
            },
          }],
        }],
      },
    });

    new cdk.CfnOutput(this, 'LoadTestFunctionArn', { value: loadTestFn.functionArn });
    new cdk.CfnOutput(this, 'LoadTestDocumentName', { value: `${props.project}-load-test` });
  }
}
