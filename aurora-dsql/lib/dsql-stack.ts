import * as cdk from 'aws-cdk-lib';

export interface DsqlStackProps extends cdk.StackProps {
  readonly project: string;
  readonly witnessRegion?: string;
  readonly peerClusterArns?: string[];
}

export class DsqlStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: DsqlStackProps) {
    super(scope, id, props);

    const witnessRegion = props.witnessRegion || 'us-east-2';
    const hasPeers = props.peerClusterArns && props.peerClusterArns.length > 0;

    const cluster = new cdk.CfnResource(this, 'DsqlCluster', {
      type: 'AWS::DSQL::Cluster',
      properties: {
        DeletionProtectionEnabled: false,
        MultiRegionProperties: {
          WitnessRegion: witnessRegion,
          ...(hasPeers ? { Clusters: props.peerClusterArns } : {}),
        },
        Tags: [{ Key: 'Project', Value: props.project }],
      },
    });

    const clusterId = cluster.ref;

    new cdk.CfnOutput(this, 'ClusterId', { value: clusterId });
    new cdk.CfnOutput(this, 'ClusterArn', { value: cluster.getAtt('ResourceArn').toString() });
    new cdk.CfnOutput(this, 'Endpoint', { value: cluster.getAtt('Endpoint').toString() });
  }
}
