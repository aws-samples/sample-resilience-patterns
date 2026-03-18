import * as cdk from 'aws-cdk-lib';

export interface DsqlStackProps extends cdk.StackProps {
  readonly project: string;
  readonly peerClusterArns?: string[];
}

export class DsqlStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: DsqlStackProps) {
    super(scope, id, props);

    const cluster = new cdk.CfnResource(this, 'DsqlCluster', {
      type: 'AWS::DSQL::Cluster',
      properties: {
        DeletionProtectionEnabled: false,
        Tags: [{ Key: 'Project', Value: props.project }],
        ...(props.peerClusterArns && props.peerClusterArns.length > 0
          ? { LinkedClusterArns: props.peerClusterArns }
          : {}),
      },
    });

    // AWS::DSQL::Cluster returns ResourceIdentifier via Ref, not Arn via GetAtt
    const clusterId = cluster.ref;
    const endpoint = cluster.getAtt('Endpoint').toString();

    new cdk.CfnOutput(this, 'ClusterId', { value: clusterId });
    new cdk.CfnOutput(this, 'ClusterArn', {
      value: `arn:aws:dsql:${this.region}:${this.account}:cluster/${clusterId}`,
    });
    new cdk.CfnOutput(this, 'Endpoint', { value: endpoint });
  }
}
