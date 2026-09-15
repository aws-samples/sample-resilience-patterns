import * as cdk from 'aws-cdk-lib';
import * as arc from 'aws-cdk-lib/aws-arcregionswitch';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { DrsRegionSwitchConfig, DrsRegionSwitchPlanSteps } from './constructs/drs-region-switch-steps';

export interface PlanStackProps extends cdk.StackProps {
  readonly project: string;
  readonly drsConfig: DrsRegionSwitchConfig;
  readonly globalClusterId: string;
  readonly primaryClusterArn: string;
  readonly secondaryClusterArn: string;
  readonly hostedZoneId: string;
  readonly hostedZoneName: string;
  readonly recordName: string;
}

/**
 * The single ARC Region Switch plan. activePassive plans have two service-side rules cfn-lint
 * cannot see (each cost a live CREATE_FAILED on 2026-09-10): no `deactivate` workflow, and an
 * `activate` workflow for EACH region. Fail-back is therefore an ACTIVATE of the primary.
 *
 * ACTIVATE secondary: Aurora switchover -> drs-recover-ec2 -> register-target -> DNS flip
 * ACTIVATE primary:   reverse-replicate -> failback-launch -> register-failback-target ->
 *                     Aurora switchover back -> DNS flip back -> reprotect -> retire
 */
export class PlanStack extends cdk.Stack {
  public readonly plan: arc.CfnPlan;
  public readonly executionRole: iam.Role;

  constructor(scope: Construct, id: string, props: PlanStackProps) {
    super(scope, id, props);
    const { project, drsConfig: cfg } = props;

    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: `${project}-arc-exec-role`,
      assumedBy: new iam.ServicePrincipal('arc-region-switch.amazonaws.com'),
      description: `${project}: ARC Region Switch plan execution role`,
    });
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AuroraGlobal',
      actions: ['rds:SwitchoverGlobalCluster', 'rds:FailoverGlobalCluster', 'rds:DescribeGlobalClusters', 'rds:DescribeDBClusters'],
      resources: ['*'],
    }));
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'Route53HealthChecks',
      actions: ['route53:GetHealthCheck', 'route53:UpdateHealthCheck', 'route53:CreateHealthCheck', 'route53:DeleteHealthCheck',
        'route53:ChangeResourceRecordSets', 'route53:GetHostedZone', 'route53:ListResourceRecordSets'],
      resources: ['*'],
    }));
    // ARC's plan evaluation simulates the role against itself.
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ArcPreflight', actions: ['iam:SimulatePrincipalPolicy'],
      resources: [cdk.Stack.of(this).formatArn({ service: 'iam', region: '', resource: 'role', resourceName: `${project}-arc-exec-role` })],
    }));
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ArcObservability', actions: ['cloudwatch:GetMetricData', 'cloudwatch:DescribeAlarms'], resources: ['*'],
    }));

    const drs = new DrsRegionSwitchPlanSteps(this, 'DrsSteps', { config: cfg });
    drs.grantInvoke(this.executionRole);

    const aurora = (name: string, description: string): arc.CfnPlan.StepProperty => ({
      name, description, executionBlockType: 'AuroraGlobalDatabase',
      executionBlockConfiguration: {
        globalAuroraConfig: {
          behavior: 'switchoverOnly',
          globalClusterIdentifier: props.globalClusterId,
          databaseClusterArns: [props.primaryClusterArn, props.secondaryClusterArn],
          timeoutMinutes: 15,
          ungraceful: { ungraceful: 'failover' },
        },
      },
    });
    const dns = (name: string, description: string): arc.CfnPlan.StepProperty => ({
      name, description, executionBlockType: 'Route53HealthCheck',
      executionBlockConfiguration: {
        route53HealthCheckConfig: { hostedZoneId: props.hostedZoneId, recordName: props.recordName, timeoutMinutes: 5 },
      },
    });

    this.plan = new arc.CfnPlan(this, 'Plan', {
      name: `${project}-switchover`,
      description: 'Aurora Global + DRS EC2 + Route 53 failover record; graceful by default, ungraceful at execution time',
      executionRole: this.executionRole.roleArn,
      recoveryApproach: 'activePassive',
      primaryRegion: cfg.primaryRegion,
      regions: [cfg.primaryRegion, cfg.secondaryRegion],
      recoveryTimeObjectiveMinutes: 30,
      workflows: [
        {
          workflowTargetAction: 'activate',
          workflowTargetRegion: cfg.secondaryRegion,
          workflowDescription: `Fail over to ${cfg.secondaryRegion}`,
          steps: [
            aurora('aurora-switchover', `Aurora Global: make ${cfg.secondaryRegion} the writer`),
            ...drs.activateSecondarySteps,
            dns('dns-flip', `Route 53 failover record -> ${cfg.secondaryRegion}`),
          ],
        },
        {
          workflowTargetAction: 'activate',
          workflowTargetRegion: cfg.primaryRegion,
          workflowDescription: `Fail back to ${cfg.primaryRegion}`,
          steps: drs.interleaveActivatePrimary(
            aurora('aurora-switchover-back', `Aurora Global: make ${cfg.primaryRegion} the writer again`),
            dns('dns-flip-back', `Route 53 failover record -> ${cfg.primaryRegion}`),
          ),
        },
      ],
    });
    this.plan.node.addDependency(this.executionRole);

    new cdk.CfnOutput(this, 'SwitchoverPlanArn', { value: this.plan.attrArn });
    new cdk.CfnOutput(this, 'ArcExecutionRoleArn', { value: this.executionRole.roleArn });
  }
}
