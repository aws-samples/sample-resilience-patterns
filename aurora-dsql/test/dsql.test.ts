import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DsqlStack } from '../lib/dsql-stack';

describe('DsqlStack', () => {
  test('creates DSQL cluster', () => {
    const app = new cdk.App();
    const stack = new DsqlStack(app, 'TestDsql', {
      project: 'test',
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::DSQL::Cluster', {
      DeletionProtectionEnabled: false,
    });
  });

  test('creates DSQL cluster with peer ARNs when provided', () => {
    const app = new cdk.App();
    const stack = new DsqlStack(app, 'TestDsqlLinked', {
      project: 'test',
      peerClusterArns: ['arn:aws:dsql:us-east-1:123456789012:cluster/abc', 'arn:aws:dsql:us-west-2:123456789012:cluster/def'],
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::DSQL::Cluster', {
      LinkedClusterArns: [
        'arn:aws:dsql:us-east-1:123456789012:cluster/abc',
        'arn:aws:dsql:us-west-2:123456789012:cluster/def',
      ],
    });
  });

  test('DSQL cluster has project tag', () => {
    const app = new cdk.App();
    const stack = new DsqlStack(app, 'TestDsqlTags', {
      project: 'test',
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::DSQL::Cluster', {
      Tags: [{ Key: 'Project', Value: 'test' }],
    });
  });
});
