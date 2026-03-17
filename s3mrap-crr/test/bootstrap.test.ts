import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BootstrapStack } from '../lib/bootstrap-stack';

const app = new cdk.App();
const stack = new BootstrapStack(app, 'TestBootstrap', {
  project: 's3mrap',
  primaryRegion: 'us-east-1',
  secondaryRegion: 'us-west-2',
  encryptionKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/test-key-id',
  env: { account: '123456789012', region: 'us-east-1' },
});
const template = Template.fromStack(stack);

test('CodeBuild project exists', () => {
  template.hasResourceProperties('AWS::CodeBuild::Project', {
    Name: 's3mrap-deploy',
  });
});

test('Artifact bucket exists with encryption', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } },
      ],
    },
  });
});
