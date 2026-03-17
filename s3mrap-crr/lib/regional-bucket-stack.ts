import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';

export interface RegionalBucketStackProps extends cdk.StackProps {
  readonly project: string;
}

export class RegionalBucketStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;

  constructor(scope: cdk.App, id: string, props: RegionalBucketStackProps) {
    super(scope, id, props);

    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `${props.project}-${this.region}-${this.account}`,
      versioned: true,
      encryption: s3.BucketEncryption.KMS_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'access-logs/',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // SNS topic for replication failure events
    const replFailTopic = new sns.Topic(this, 'ReplicationFailureTopic', {
      topicName: `${props.project}-repl-failures-${this.region}`,
      enforceSSL: true,
      masterKey: kms.Alias.fromAliasName(this, 'SnsKey', 'alias/aws/sns'),
    });

    this.bucket.addEventNotification(
      s3.EventType.REPLICATION_OPERATION_FAILED_REPLICATION,
      new s3n.SnsDestination(replFailTopic),
    );

    new cdk.CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
    new cdk.CfnOutput(this, 'BucketArn', { value: this.bucket.bucketArn });
    new cdk.CfnOutput(this, 'ReplicationFailureTopicArn', { value: replFailTopic.topicArn });
  }
}
