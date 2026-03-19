import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DsqlStack } from '../lib/dsql-stack';

describe('DsqlStack', () => {
  test('creates DSQL cluster with witness region', () => {
    const app = new cdk.App();
    const stack = new DsqlStack(app, 'TestDsql', {
      project: 'test', env: { account: '123456789012', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::DSQL::Cluster', {
      DeletionProtectionEnabled: false,
      MultiRegionProperties: { WitnessRegion: 'us-east-2' },
    });
  });

  test('creates DSQL cluster with peer ARNs when provided', () => {
    const app = new cdk.App();
    const stack = new DsqlStack(app, 'TestDsqlLinked', {
      project: 'test',
      peerClusterArns: ['arn:aws:dsql:us-east-1:123:cluster/abc', 'arn:aws:dsql:us-west-2:123:cluster/def'],
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::DSQL::Cluster', {
      MultiRegionProperties: {
        WitnessRegion: 'us-east-2',
        Clusters: ['arn:aws:dsql:us-east-1:123:cluster/abc', 'arn:aws:dsql:us-west-2:123:cluster/def'],
      },
    });
  });

  test('no Clusters property when no peers', () => {
    const app = new cdk.App();
    const stack = new DsqlStack(app, 'TestDsqlNoPeers', {
      project: 'test', env: { account: '123456789012', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);
    const clusters = template.findResources('AWS::DSQL::Cluster');
    const [, resource] = Object.entries(clusters)[0];
    expect((resource as any).Properties.MultiRegionProperties.Clusters).toBeUndefined();
  });
});
