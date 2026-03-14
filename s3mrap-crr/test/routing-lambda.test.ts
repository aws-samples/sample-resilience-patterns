import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { RoutingLambdaStack } from '../lib/routing-lambda-stack';

const app = new cdk.App();
const stack = new RoutingLambdaStack(app, 'TestRouting', {
  project: 's3mrap',
  primaryBucketName: 's3mrap-us-east-1-123456789012',
  secondaryBucketName: 's3mrap-us-west-2-123456789012',
  primaryRegion: 'us-east-1',
  secondaryRegion: 'us-west-2',
  accountId: '123456789012',
  mrapName: 's3mrap-mrap',
  mrapAlias: 'test-alias.mrap',
  env: { account: '123456789012', region: 'us-east-1' },
});
const template = Template.fromStack(stack);

test('Routing Lambda exists with correct name', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 's3mrap-mrap-routing',
    Runtime: 'python3.12',
  });
});

test('Routing Lambda has SubmitMultiRegionAccessPointRoutes permission', () => {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['s3:SubmitMultiRegionAccessPointRoutes']),
        }),
      ]),
    },
  });
});

test('Routing Lambda grants ARC invoke permission', () => {
  template.hasResourceProperties('AWS::Lambda::Permission', {
    Action: 'lambda:InvokeFunction',
    Principal: 'arc-region-switch.amazonaws.com',
  });
});

test('Stack outputs routing function ARN', () => {
  template.hasOutput('RoutingFunctionArn', {});
});
