import * as cdk from 'aws-cdk-lib';

export interface DsqlStackProps extends cdk.StackProps {
  readonly project: string;
  readonly peerClusterArns?: string[];
}

export class DsqlStack extends cdk.Stack {
  public readonly clusterArn: string;
  public readonly endpoint: string;

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

    this.clusterArn = cluster.getAtt('Arn').toString();
    this.endpoint = cluster.getAtt('Endpoint').toString();

    new cdk.CfnOutput(this, 'ClusterArn', { value: this.clusterArn });
    new cdk.CfnOutput(this, 'Endpoint', { value: this.endpoint });
  }
}
