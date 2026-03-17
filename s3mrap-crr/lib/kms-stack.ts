import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';

export interface KmsStackProps extends cdk.StackProps {
  readonly project: string;
}

export class KmsStack extends cdk.Stack {
  public readonly key: kms.Key;

  constructor(scope: cdk.App, id: string, props: KmsStackProps) {
    super(scope, id, props);

    this.key = new kms.Key(this, 'MrKey', {
      alias: `${props.project}-mrk`,
      description: `Multi-region key for ${props.project}`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cfnKey = this.key.node.defaultChild as kms.CfnKey;
    cfnKey.addPropertyOverride('MultiRegion', true);

    new cdk.CfnOutput(this, 'KeyArn', { value: this.key.keyArn });
    new cdk.CfnOutput(this, 'KeyId', { value: this.key.keyId });
  }
}

export interface KmsReplicaStackProps extends cdk.StackProps {
  readonly project: string;
  readonly primaryKeyArn: string;
  readonly accountId: string;
}

export class KmsReplicaStack extends cdk.Stack {
  public readonly replicaKeyArn: string;

  constructor(scope: cdk.App, id: string, props: KmsReplicaStackProps) {
    super(scope, id, props);

    const replica = new kms.CfnReplicaKey(this, 'MrKeyReplica', {
      primaryKeyArn: props.primaryKeyArn,
      keyPolicy: {
        Version: '2012-10-17',
        Statement: [{
          Sid: 'EnableIAMPolicies',
          Effect: 'Allow',
          Principal: { AWS: `arn:aws:iam::${props.accountId}:root` },
          Action: 'kms:*',
          Resource: '*',
        }],
      },
      description: `Multi-region replica key for ${props.project}`,
    });

    new kms.CfnAlias(this, 'MrKeyReplicaAlias', {
      aliasName: `alias/${props.project}-mrk`,
      targetKeyId: replica.attrKeyId,
    });

    this.replicaKeyArn = replica.attrArn;

    new cdk.CfnOutput(this, 'ReplicaKeyArn', { value: replica.attrArn });
  }
}
