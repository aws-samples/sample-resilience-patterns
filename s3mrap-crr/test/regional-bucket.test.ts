import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { RegionalBucketStack } from '../lib/regional-bucket-stack';

const app = new cdk.App();
const stack = new RegionalBucketStack(app, 'TestBucket', {
  project: 's3mrap',
  env: { account: '123456789012', region: 'us-east-1' },
});
const template = Template.fromStack(stack);

test('S3 bucket has versioning enabled', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    VersioningConfiguration: { Status: 'Enabled' },
  });
});

test('S3 bucket has encryption enabled', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
      ],
    },
  });
});

test('S3 bucket blocks public access', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});

test('Stack outputs bucket name and ARN', () => {
  template.hasOutput('BucketName', {});
  template.hasOutput('BucketArn', {});
});

test('Replication failure SNS topic exists', () => {
  template.hasResourceProperties('AWS::SNS::Topic', {
    TopicName: 's3mrap-repl-failures-us-east-1',
  });
});

test('S3 bucket has replication failure event notification', () => {
  template.resourceCountIs('Custom::S3BucketNotifications', 1);
});
