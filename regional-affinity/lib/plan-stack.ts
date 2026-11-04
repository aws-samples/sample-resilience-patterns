import * as cdk from 'aws-cdk-lib';
import * as arc from 'aws-cdk-lib/aws-arcregionswitch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { RecordNames } from './names';

export interface PlanStackProps extends cdk.StackProps {
  readonly project: string;
  readonly domain: string;
  readonly names: RecordNames;
  /** The two Regions, in order, and the VPC of each, which the private hosted zone answers in. */
  readonly regions: readonly [string, string];
  readonly vpcIds: readonly [string, string];
}

/**
 * The private hosted zone and the Amazon Application Recovery Controller (ARC) Region switch plan.
 * One plan execution drains or restores a Region at all three ARC-controlled record names at once.
 * The records live in records-stack.ts, because they need the health check IDs this plan vends.
 *
 * activeActive: ARC starts every health check healthy, so the region-less name answers 50/50 at
 * rest. A deactivate execution marks the target Region's checks unhealthy; an activate execution
 * marks them healthy again. activeActive requires exactly two workflows, one per action.
 *
 * ARC vends one health check per Region per record name, six here. Every block lists the same
 * record set identifiers: a contract with records-stack.ts, where each record's SetIdentifier is
 * the Region it sends traffic to.
 */
export class PlanStack extends cdk.Stack {
  public readonly zone: route53.CfnHostedZone;
  public readonly plan: arc.CfnPlan;
  public readonly executionRole: iam.Role;

  constructor(scope: Construct, id: string, props: PlanStackProps) {
    super(scope, id, props);
    const { project, names, regions } = props;

    // Inside the two VPCs it answers ahead of any public zone with the same name; nothing outside
    // those VPCs sees it.
    this.zone = new route53.CfnHostedZone(this, 'PrivateZone', {
      name: props.domain,
      hostedZoneConfig: { comment: `${project}: home Region routing with ARC Region switch` },
      vpcs: regions.map((region, i) => ({ vpcId: props.vpcIds[i], vpcRegion: region })),
    });

    // Region switch has no service-linked role, so the plan names this role. Route 53 health check
    // blocks do not assume it during an execution (ARC flips health checks it owns); ARC assumes it
    // for plan evaluation, which reads the records and simulates this role's policy.
    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('arc-region-switch.amazonaws.com'),
      description: `${project}: ARC Region switch plan execution role`,
    });
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadRecords', // the Route 53 health check block's documented policy
      actions: ['route53:ListResourceRecordSets'],
      resources: [`arn:${this.partition}:route53:::hostedzone/${this.zone.attrId}`],
    }));
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EvaluateOwnPolicy', // plan evaluation simulates this role's policy against each step
      actions: ['iam:SimulatePrincipalPolicy'],
      resources: [this.executionRole.roleArn],
    }));
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadPlan', // read-only, as in the AWS managed plan execution policy
      actions: ['arc-region-switch:GetPlan', 'arc-region-switch:GetPlanExecution', 'arc-region-switch:ListPlanExecutions'],
      resources: ['*'],
    }));

    const arcNames = [
      { step: 'region-less', recordName: names.regionLess, description: 'Region-less weighted name' },
      ...regions.map((region) => ({
        step: names.regional[region].split('.')[1], // ue1, ue2
        recordName: names.regional[region],
        description: `${region} home Region name (failover)`,
      })),
    ];
    const recordSets = regions.map((region) => ({ recordSetIdentifier: region, region }));
    const workflow = (action: 'deactivate' | 'activate', verb: string, description: string): arc.CfnPlan.WorkflowProperty => ({
      workflowTargetAction: action,
      workflowDescription: description,
      steps: [{
        name: `${verb}-dns`,
        description: 'One Route 53 health check block per record name, run in parallel',
        executionBlockType: 'Parallel',
        executionBlockConfiguration: {
          parallelConfig: {
            steps: arcNames.map((n) => ({
              name: `${verb}-${n.step}`,
              description: n.description,
              executionBlockType: 'Route53HealthCheck',
              executionBlockConfiguration: {
                route53HealthCheckConfig: {
                  hostedZoneId: this.zone.attrId,
                  recordName: n.recordName,
                  recordSets,
                  timeoutMinutes: 5,
                },
              },
            })),
          },
        },
      }],
    });

    this.plan = new arc.CfnPlan(this, 'Plan', {
      name: project,
      description: 'Drain or restore a Region at every level of the Route 53 hierarchy',
      executionRole: this.executionRole.roleArn,
      recoveryApproach: 'activeActive',
      regions: [...regions],
      recoveryTimeObjectiveMinutes: 10,
      workflows: [
        workflow('deactivate', 'drain', 'Drain the target Region from all three record names at once'),
        workflow('activate', 'restore', 'Restore the target Region at all three record names at once'),
      ],
    });
    // Plan evaluation simulates the role's policy, so the policy must exist before the plan does.
    this.plan.node.addDependency(this.executionRole);

    new cdk.CfnOutput(this, 'HostedZoneId', { value: this.zone.attrId });
    new cdk.CfnOutput(this, 'PlanArn', { value: this.plan.attrArn });
  }
}
