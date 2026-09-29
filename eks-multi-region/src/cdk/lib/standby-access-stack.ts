import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import { Construct } from 'constructs';
import { APP_NAMESPACE } from '../k8s';

/**
 * Must match FailoverStack's. ARC Region Switch's own access policy — plan evaluation
 * validates that the execution role is associated with THIS policy specifically.
 */
const ARC_SCALING_POLICY_ARN =
  'arn:aws:eks::aws:cluster-access-policy/AmazonARCRegionSwitchScalingPolicy';

export interface StandbyAccessStackProps extends cdk.StackProps {
  readonly appId: string;
}

/**
 * The STANDBY cluster's access entry for the ARC execution role (step 7).
 *
 * WHY THIS IS ITS OWN STACK, which the changeset did not anticipate. The plan's EKS
 * scaling block names BOTH clusters, so ARC needs Kubernetes authorization in both. But
 * `eks.CfnAccessEntry` is a REGIONAL resource — it must be created in the cluster's own
 * region — while the execution role it references is created once, in the primary
 * region's FailoverStack. One stack cannot satisfy both constraints, so the standby's
 * entry lives here, deployed into the secondary region AFTER FailoverStack so the
 * role already exists.
 *
 * Putting the role in an early stack instead would not help: a role's policy has to be
 * scoped to cluster and database ARNs that only exist once the region stacks have
 * deployed, so the role cannot precede them either.
 *
 * WITHOUT THIS ENTRY the failover's scaling step fails at execution time — after the
 * human has approved — while IAM, synth, deploy and plan evaluation all look correct.
 * That is the worst possible moment to discover it.
 */
export class StandbyAccessStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StandbyAccessStackProps) {
    super(scope, id, props);

    new cdk.CfnParameter(this, 'AssetsBucketName', {
      type: 'String',
      description: 'S3 bucket holding the synthesized templates and asset objects.',
    });
    new cdk.CfnParameter(this, 'AssetsBucketPrefix', {
      type: 'String',
      description: 'Run-scoped key prefix inside the assets bucket.',
    });

    const clusterName = new cdk.CfnParameter(this, 'ClusterName', {
      type: 'String',
      description: 'Standby EKS cluster name.',
    });
    const executionRoleArn = new cdk.CfnParameter(this, 'ExecutionRoleArn', {
      type: 'String',
      description: 'ARC plan execution role, created by FailoverStack.',
    });

    new eks.CfnAccessEntry(this, 'StandbyClusterAccess', {
      clusterName: clusterName.valueAsString,
      principalArn: executionRoleArn.valueAsString,
      accessPolicies: [
        {
          policyArn: ARC_SCALING_POLICY_ARN,
          accessScope: { type: 'namespace', namespaces: [APP_NAMESPACE] },
        },
      ],
    });

    new cdk.CfnOutput(this, 'StandbyAccessClusterName', { value: clusterName.valueAsString });
  }
}
