import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface IamStackProps extends cdk.StackProps {
  readonly project: string;
}

/**
 * The app instance role + profile. Named (not generated) because DRS launch templates and the
 * step functions refer to it by name across regions and across fail-back cycles.
 *
 * Both DRS instance policies are attached: Ec2InstancePolicy lets the agent replicate this
 * instance; RecoveryInstancePolicy lets a RECOVERED copy of it (same profile, other region)
 * initialise its agent and later reverse-replicate. Without the second, stateful fail-back cannot
 * start (live finding, 2026-09-10).
 */
export class IamStack extends cdk.Stack {
  public readonly role: iam.Role;
  public readonly instanceProfile: iam.CfnInstanceProfile;

  constructor(scope: Construct, id: string, props: IamStackProps) {
    super(scope, id, props);
    const { project } = props;

    this.role = new iam.Role(this, 'AppInstanceRole', {
      roleName: `${project}-app-instance-role`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSElasticDisasterRecoveryEc2InstancePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSElasticDisasterRecoveryRecoveryInstancePolicy'),
      ],
    });
    this.role.attachInlinePolicy(new iam.Policy(this, 'AppRuntime', {
      policyName: 'app-runtime',
      statements: [
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter', 'ssm:GetParameters'],
          resources: [`arn:${this.partition}:ssm:*:${this.account}:parameter/${project}/*`],
        }),
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [`arn:${this.partition}:secretsmanager:*:${this.account}:secret:${project}/*`],
        }),
        new iam.PolicyStatement({
          sid: 'AppCode', actions: ['s3:GetObject'],
          resources: [`arn:${this.partition}:s3:::${project}-app-code-${this.account}-*/app/*`],
        }),
        // The demo console (/ui) reads control-plane state and can start/cancel THIS project's plan.
        new iam.PolicyStatement({
          sid: 'DashboardReadOnly',
          actions: [
            'arc-region-switch:ListPlans', 'arc-region-switch:GetPlan', 'arc-region-switch:ListPlanExecutions',
            'arc-region-switch:GetPlanExecution', 'arc-region-switch:GetPlanEvaluationStatus',
            'arc-region-switch:ListRoute53HealthChecks', 'drs:DescribeSourceServers', 'drs:DescribeRecoveryInstances',
            'rds:DescribeGlobalClusters', 'elasticloadbalancing:DescribeTargetGroups', 'elasticloadbalancing:DescribeTargetHealth',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'DashboardRunPlan',
          actions: ['arc-region-switch:StartPlanExecution', 'arc-region-switch:CancelPlanExecution'],
          resources: [`arn:${this.partition}:arc-region-switch::${this.account}:plan/${project}-*`],
        }),
      ],
    }));

    this.instanceProfile = new iam.CfnInstanceProfile(this, 'AppInstanceProfile', {
      instanceProfileName: `${project}-app-instance-profile`,
      roles: [this.role.roleName],
    });

    new cdk.CfnOutput(this, 'AppInstanceRoleArn', { value: this.role.roleArn, exportName: `${project}-AppInstanceRoleArn` });
    new cdk.CfnOutput(this, 'AppInstanceProfileArn', { value: this.instanceProfile.attrArn, exportName: `${project}-AppInstanceProfileArn` });
  }
}
