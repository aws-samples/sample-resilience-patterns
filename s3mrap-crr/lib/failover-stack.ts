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
  readonly encryptionKeyId?: string;
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

    // KMS permissions for writing to CMK-encrypted buckets
    if (props.encryptionKeyId) {
      loadTestFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: [
          `arn:aws:kms:${props.primaryRegion}:${props.accountId}:key/${props.encryptionKeyId}`,
          `arn:aws:kms:${props.secondaryRegion}:${props.accountId}:key/${props.encryptionKeyId}`,
        ],
      }));
    }

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

    // Topology-only tagging: the ARC Region Switch Plan + its execution role are part of the
    // s3mrap resilience topology and are tagged for NGRH discovery. The load-test harness
    // (LoadTestFunction / LoadTestDocument, below) is deliberately left untagged.
    cdk.Tags.of(arcExecutionRole).add('service', props.project);

    new cdk.CfnResource(this, 'ArcRegionSwitchPlan', {
      type: 'AWS::ARCRegionSwitch::Plan',
      properties: {
        Name: `${props.project}-region-switch`,
        RecoveryApproach: 'activePassive',
        PrimaryRegion: props.primaryRegion,
        Regions: [props.primaryRegion, props.secondaryRegion],
        ExecutionRole: arcExecutionRole.roleArn,
        // Explicit tag: this is a generic CfnResource, so cdk.Tags.of(app) (aspect-based,
        // needs a TagManager) does NOT propagate to it. NGRH tag-based discovery needs
        // the ARC Region Switch Plan tagged into the s3mrap service. Tags shape is a map.
        Tags: { service: props.project },
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
