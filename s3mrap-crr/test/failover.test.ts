import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FailoverStack } from '../lib/failover-stack';

const app = new cdk.App();
const stack = new FailoverStack(app, 'TestFailover', {
  project: 's3mrap',
  primaryBucketName: 's3mrap-us-east-1-123456789012',
  secondaryBucketName: 's3mrap-us-west-2-123456789012',
  primaryRegion: 'us-east-1',
  secondaryRegion: 'us-west-2',
  accountId: '123456789012',
  mrapName: 's3mrap-mrap',
  primaryRoutingLambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:s3mrap-mrap-routing',
  secondaryRoutingLambdaArn: 'arn:aws:lambda:us-west-2:123456789012:function:s3mrap-mrap-routing',
  env: { account: '123456789012', region: 'us-east-1' },
});
const template = Template.fromStack(stack);

test('ARC plan uses Name property (not PlanName)', () => {
  template.hasResourceProperties('AWS::ARCRegionSwitch::Plan', {
    Name: 's3mrap-region-switch',
  });
});

test('ARC plan Regions is a string array', () => {
  template.hasResourceProperties('AWS::ARCRegionSwitch::Plan', {
    Regions: ['us-east-1', 'us-west-2'],
  });
});

test('ARC plan has PrimaryRegion', () => {
  template.hasResourceProperties('AWS::ARCRegionSwitch::Plan', {
    PrimaryRegion: 'us-east-1',
  });
});

test('ARC plan has ExecutionRole', () => {
  template.hasResourceProperties('AWS::ARCRegionSwitch::Plan', {
    ExecutionRole: Match.anyValue(),
  });
});

test('ARC plan lists Lambda ARNs for both regions', () => {
  template.hasResourceProperties('AWS::ARCRegionSwitch::Plan', {
    Workflows: Match.arrayWith([
      Match.objectLike({
        Steps: Match.arrayWith([
          Match.objectLike({
            ExecutionBlockConfiguration: {
              CustomActionLambdaConfig: Match.objectLike({
                Lambdas: [
                  { Arn: 'arn:aws:lambda:us-east-1:123456789012:function:s3mrap-mrap-routing' },
                  { Arn: 'arn:aws:lambda:us-west-2:123456789012:function:s3mrap-mrap-routing' },
                ],
              }),
            },
          }),
        ]),
      }),
    ]),
  });
});

test('ARC execution role trusts arc-region-switch.amazonaws.com', () => {
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: 'arc-region-switch.amazonaws.com' },
        }),
      ]),
    },
  });
});

test('ARC execution role has invoke permission for both Lambda ARNs', () => {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['lambda:InvokeFunction']),
          Resource: [
            'arn:aws:lambda:us-east-1:123456789012:function:s3mrap-mrap-routing',
            'arn:aws:lambda:us-west-2:123456789012:function:s3mrap-mrap-routing',
          ],
        }),
      ]),
    },
  });
});

test('Load test Lambda has 15 minute timeout', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 's3mrap-load-test',
    Timeout: 900,
  });
});

test('SSM Automation Document exists with correct parameters', () => {
  template.hasResourceProperties('AWS::SSM::Document', {
    DocumentType: 'Automation',
    Name: 's3mrap-load-test',
  });
});

test('SSM Document parameters are all String type (not Integer)', () => {
  const docs = template.findResources('AWS::SSM::Document');
  for (const [, doc] of Object.entries(docs)) {
    const params = (doc as any).Properties.Content.parameters;
    for (const [name, param] of Object.entries(params)) {
      expect((param as any).type).toBe('String');
    }
  }
});
