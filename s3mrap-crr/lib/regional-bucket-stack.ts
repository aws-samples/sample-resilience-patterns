import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';

export interface RegionalBucketStackProps extends cdk.StackProps {
  readonly project: string;
  readonly encryptionKeyArn: string;
}

export class RegionalBucketStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;

  constructor(scope: cdk.App, id: string, props: RegionalBucketStackProps) {
    super(scope, id, props);

    const encryptionKey = kms.Key.fromKeyArn(this, 'EncryptionKey', props.encryptionKeyArn);

    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{
        id: 'expire-logs-24h',
        enabled: true,
        expiration: cdk.Duration.days(1),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
      }],
    });

    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `${props.project}-${this.region}-${this.account}`,
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'access-logs/',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const snsKey = kms.Key.fromKeyArn(this, 'SnsKey', props.encryptionKeyArn);
    const replFailTopic = new sns.Topic(this, 'ReplicationFailureTopic', {
      topicName: `${props.project}-repl-failures-${this.region}`,
      enforceSSL: true,
      masterKey: snsKey,
    });

    // Allow S3 to publish to the encrypted SNS topic
    replFailTopic.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['sns:Publish'],
      principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
      resources: ['*'],
    }));

    this.bucket.addEventNotification(
      s3.EventType.REPLICATION_OPERATION_FAILED_REPLICATION,
      new s3n.SnsDestination(replFailTopic),
    );

    new cdk.CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
    new cdk.CfnOutput(this, 'BucketArn', { value: this.bucket.bucketArn });
    new cdk.CfnOutput(this, 'ReplicationFailureTopicArn', { value: replFailTopic.topicArn });
  }
}
