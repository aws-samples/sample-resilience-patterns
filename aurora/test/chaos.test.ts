import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ChaosStack } from '../lib/chaos-stack';

function createStack() {
  const app = new cdk.App();
  return Template.fromStack(new ChaosStack(app, 'TestChaos', {
    project: 'test',
    targetRegion: 'us-west-2',
    env: { account: '123456789012', region: 'us-east-1' },
  }));
}

describe('ChaosStack', () => {
  const template = createStack();

  test('creates 2 FIS experiment templates', () => {
    template.resourceCountIs('AWS::FIS::ExperimentTemplate', 2);
  });

  test('creates network disruption experiment', () => {
    template.hasResourceProperties('AWS::FIS::ExperimentTemplate', {
      Description: 'Disrupt cross-region subnet connectivity',
      Targets: {
        Subnets: Match.objectLike({
          ResourceType: 'aws:ec2:subnet',
          ResourceTags: { ChaosAllowed: 'true' },
        }),
      },
    });
  });

  test('creates Aurora failover experiment', () => {
    template.hasResourceProperties('AWS::FIS::ExperimentTemplate', {
      Description: 'Force Aurora DB cluster failover',
      Targets: {
        Clusters: Match.objectLike({
          ResourceType: 'aws:rds:cluster',
          ResourceTags: { ChaosAllowed: 'true' },
        }),
      },
    });
  });

  test('creates FIS IAM role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'fis.amazonaws.com' },
          }),
        ]),
      },
    });
  });

  test('creates KMS-encrypted log group', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 7,
      KmsKeyId: Match.anyValue(),
    });
  });

  test('experiments use single-account targeting', () => {
    template.hasResourceProperties('AWS::FIS::ExperimentTemplate', {
      ExperimentOptions: {
        AccountTargeting: 'single-account',
        EmptyTargetResolutionMode: 'skip',
      },
    });
  });
});
