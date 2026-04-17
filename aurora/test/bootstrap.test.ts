import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BootstrapStack } from '../lib/bootstrap-stack';

describe('BootstrapStack', () => {
  const app = new cdk.App();
  const stack = new BootstrapStack(app, 'TestBootstrap', {
    project: 'test',
    primaryRegion: 'us-east-1',
    secondaryRegion: 'us-west-2',
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const template = Template.fromStack(stack);

  test('creates CodeBuild project', () => {
    template.resourceCountIs('AWS::CodeBuild::Project', 1);
  });

  test('creates KMS-encrypted artifact bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: 'aws:kms',
          },
        }],
      },
    });
  });

  test('creates KMS key with rotation', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  test('blocks public access on artifact bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('CodeBuild role scoped to cdk-* roles', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Resource: Match.stringLikeRegexp('cdk-\\*'),
          }),
        ]),
      },
    });
  });

  test('creates build trigger Lambda functions', () => {
    // onEvent + isComplete + CDK Provider framework functions
    const lambdas = template.findResources('AWS::Lambda::Function');
    expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(2);
  });

  test('creates custom resource for build trigger', () => {
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
  });
});
