// Adapted from aws-samples/sample-resilience-patterns@9091f42 (MIT-0):
// the CfnGlobalCluster wrapper in aurora/lib/database-stack.ts.
import * as cdk from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { AURORA_ENGINE_VERSION } from './aurora-member';

export interface GlobalDataStackProps extends cdk.StackProps {
  readonly appId: string;
}

/**
 * The Aurora Global Database itself. Deploy order 3: after the primary RegionStack has
 * created the primary cluster, before the secondary member can join.
 *
 * It ADOPTS the already-standalone primary cluster via `sourceDbClusterIdentifier`
 * rather than the primary declaring `globalClusterIdentifier` itself. That direction
 * matters: creating the member standalone first and wrapping it afterwards is what
 * avoids a CloudFormation delete-time 404 race on teardown, and it matches the AWS
 * reference architectures.
 */
export class GlobalDataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GlobalDataStackProps) {
    super(scope, id, props);

    // build/deploy-stack.sh appends these to EVERY deploy unconditionally and
    // CloudFormation rejects a changeset carrying parameters the template does not
    // declare. Required in every deployable stack.
    new cdk.CfnParameter(this, 'AssetsBucketName', {
      type: 'String',
      description: 'S3 bucket holding the synthesized templates and asset objects.',
    });
    new cdk.CfnParameter(this, 'AssetsBucketPrefix', {
      type: 'String',
      description: 'Key prefix inside AssetsBucketName (trailing slash required).',
    });

    // Threaded from the primary RegionStack's DbClusterArn output through the
    // dotenv → CfnParameter path. Deliberately NOT a cross-stack CDK reference: the
    // deploy mechanism is dotenv-based throughout, and using CFN exports here would
    // create an undeletable dependency between stacks that must be torn down
    // independently.
    const primaryClusterArn = new cdk.CfnParameter(this, 'PrimaryDbClusterArn', {
      type: 'String',
      description: 'ARN of the primary regional Aurora cluster to adopt as the global source.',
    });

    const globalCluster = new rds.CfnGlobalCluster(this, 'GlobalCluster', {
      globalClusterIdentifier: `${props.appId}-global`,
      sourceDbClusterIdentifier: primaryClusterArn.valueAsString,
      // Engine and engine version are NOT set alongside sourceDbClusterIdentifier —
      // RDS derives both from the adopted source cluster, and supplying them is
      // mutually exclusive with adoption. The version is pinned once on the members
      // (AURORA_ENGINE_VERSION), which is what the global cluster inherits.
      deletionProtection: false,
    });

    new cdk.CfnOutput(this, 'GlobalClusterIdentifier', {
      value: globalCluster.globalClusterIdentifier!,
      description: 'Identifier the secondary member joins, and the ARC plan targets.',
    });
    // NOTE: CfnGlobalCluster exposes NO attributes — no ARN, nothing. Verified against
    // aws-cdk-lib 2.248.0: the class has only the `globalClusterIdentifier` property you
    // set plus a `globalClusterRef`. So the global cluster's ARN and, more importantly,
    // its WRITER ENDPOINT are not obtainable at synth time. The writer endpoint has to
    // be read after deploy with
    //   aws rds describe-global-clusters --global-cluster-identifier <id> --query ...
    // and threaded onward as a deploy parameter. That is not a workaround for a missing
    // CDK feature — the resource genuinely surfaces nothing.
    new cdk.CfnOutput(this, 'MemberEngineVersion', {
      value: AURORA_ENGINE_VERSION.auroraPostgresFullVersion,
      description: 'Engine version pinned on every member of this global cluster.',
    });
  }
}
