import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as path from 'path';

export interface SchemaStackProps extends cdk.StackProps {
  readonly project: string;
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly secretArn: string;
  readonly encryptionKeyArn: string;
}

export class SchemaStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: SchemaStackProps) {
    super(scope, id, props);

    const encryptionKey = kms.Key.fromKeyArn(this, 'EncryptionKey', props.encryptionKeyArn);

    const migrationFn = new lambda.Function(this, 'MigrationFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.on_event',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'schema-migration')),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 1,
      environment: {
        DB_SECRET_ARN: props.secretArn,
      },
    });

    migrationFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.secretArn],
    }));

    migrationFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [props.encryptionKeyArn],
    }));

    const provider = new cr.Provider(this, 'MigrationProvider', {
      onEventHandler: migrationFn,
    });

    new cdk.CustomResource(this, 'SchemaMigration', {
      serviceToken: provider.serviceToken,
      properties: {
        // Change to force re-run on update
        Version: '1',
      },
    });
  }
}
