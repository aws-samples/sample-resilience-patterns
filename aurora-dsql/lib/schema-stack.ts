import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as path from 'path';

import { importVpc, importSg, VpcImportProps } from './imports';

export interface SchemaStackProps extends cdk.StackProps {
  readonly project: string;
  readonly vpcImport: VpcImportProps;
  readonly lambdaSgId: string;
  readonly secretArn: string;
  readonly encryptionKeyArn: string;
}

export class SchemaStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: SchemaStackProps) {
    super(scope, id, props);

    const vpc = importVpc(this, props.vpcImport);
    const lambdaSg = importSg(this, 'LambdaSg', props.lambdaSgId);
    const encryptionKey = kms.Key.fromKeyArn(this, 'EncryptionKey', props.encryptionKeyArn);

    const migrationFn = new lambda.Function(this, 'MigrationFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.on_event',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'schema-migration')),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
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
        Version: '1',
      },
    });
  }
}
