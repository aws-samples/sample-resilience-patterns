import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { GlobalRoutingStack } from '../lib/global-routing-stack';

const app = new cdk.App();
const stack = new GlobalRoutingStack(app, 'TestRouting', {
  project: 's3mrap',
  primaryBucketName: 's3mrap-us-east-1-123456789012',
  secondaryBucketName: 's3mrap-us-west-2-123456789012',
  primaryRegion: 'us-east-1',
  secondaryRegion: 'us-west-2',
  accountId: '123456789012', encryptionKeyId: 'test-key-id',
  env: { account: '123456789012', region: 'us-east-1' },
});
const template = Template.fromStack(stack);

test('MRAP references both regional buckets', () => {
  template.hasResourceProperties('AWS::S3::MultiRegionAccessPoint', {
    Regions: Match.arrayWith([
      Match.objectLike({ Bucket: 's3mrap-us-east-1-123456789012' }),
      Match.objectLike({ Bucket: 's3mrap-us-west-2-123456789012' }),
    ]),
  });
});

test('MRAP blocks public access', () => {
  template.hasResourceProperties('AWS::S3::MultiRegionAccessPoint', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});

test('CRR Lambda role includes GetBucketLocation', () => {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['s3:GetBucketLocation']),
        }),
      ]),
    },
  });
});

test('Replication role is trusted by s3.amazonaws.com', () => {
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: 's3.amazonaws.com' },
        }),
      ]),
    },
  });
});

test('Replication role has ReplicateObject permission', () => {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['s3:ReplicateObject']),
        }),
      ]),
    },
  });
});

test('Stack outputs MRAP alias and ARN', () => {
  template.hasOutput('MrapAlias', {});
  template.hasOutput('MrapArn', {});
});
