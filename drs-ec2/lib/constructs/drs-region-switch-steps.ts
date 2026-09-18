/**
 * DRS orchestration steps for an ARC Region Switch plan.
 *
 * Two constructs, because CDK stacks are single-region and ARC wants a Lambda in each plan
 * region:
 *
 *  - {@link DrsRegionSwitchSteps} -- instantiate once in EACH region's stack. Creates the seven
 *    step functions (one Python asset, selected by Handler string), their log groups, and the
 *    orchestration role. Function names are deterministic (`<project>-<step>`), so the plan
 *    stack can address them without cross-region references.
 *
 *  - {@link DrsRegionSwitchPlanSteps} -- instantiate in the plan's stack. Emits typed
 *    `CfnPlan.StepProperty[]` for the two workflows, with each step's Lambda ARN in that step's
 *    `RegionToRun` region, and grants the plan's execution role permission to invoke them.
 *
 * The consumer owns the plan and the Aurora / Route 53 steps; this construct only contributes
 * the EC2 tier. See README "Adding DRS steps to an existing plan".
 */
import * as path from 'path';
import { ArnFormat, Duration, Stack, Tags } from 'aws-cdk-lib';
import * as arc from 'aws-cdk-lib/aws-arcregionswitch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { ACTIVATE_PRIMARY_SPLIT, handlerFor, StepName, STEPS, stepsFor, StepSpec, Workflow } from './step-table';

export { StepName, STEPS, ACTIVATE_PRIMARY_SPLIT } from './step-table';

/** Configuration shared by both constructs (and by the Terraform module). */
export interface DrsRegionSwitchConfig {
  /** Resource-name prefix; also the default tag namespace (`<project>:role`). */
  readonly project: string;
  readonly primaryRegion: string;
  readonly secondaryRegion: string;
  /** Tag on the DRS source server that identifies the protected instance. Default `<project>:role` = `app`. */
  readonly sourceServerTag?: { readonly key: string; readonly value: string };
  readonly primaryTargetGroupArn: string;
  readonly secondaryTargetGroupArn: string;
  /** Instance profile the recovered / failed-back EC2 runs with (needs the DRS recovery-instance policy). */
  readonly appInstanceProfileArn: string;
  /** The role behind that instance profile; DRS passes it at launch (iam:PassRole). */
  readonly appInstanceRoleArn: string;
  /** SSM parameter (same name in both regions) the app reads for its DB endpoint. Optional. */
  readonly dbEndpointParameterName?: string;
  /** Secondary-region Aurora writer endpoint written to the parameter on failover. Optional. */
  readonly secondaryDbEndpoint?: string;
  /** Enable the stateful fail-back path (reverse-replicate, launch-into, re-protect). Default false. */
  readonly statefulEc2?: boolean;
  /** Recovery / failback launch template shape, used only when DRS's auto template is unusable. */
  readonly launchTemplate?: {
    readonly primarySubnetId?: string;
    readonly primarySecurityGroupId?: string;
    readonly secondarySubnetId?: string;
    readonly secondarySecurityGroupId?: string;
    readonly instanceType?: string;
  };
  readonly targetPort?: number;
}

export interface DrsRegionSwitchStepsProps extends DrsRegionSwitchConfig {
  /** Directory containing the `drs_region_switch` Python package. Defaults to `../../lambda`. */
  readonly codePath?: string;
  readonly logRetention?: logs.RetentionDays;
  readonly runtime?: lambda.Runtime;
  /** Override Lambda timeout/memory per step. */
  readonly functionOverrides?: Partial<Record<StepName, { timeout?: Duration; memorySize?: number }>>;
}

export function functionName(project: string, step: StepName): string {
  return `${project}-${step}`;
}

export function functionArn(scope: Construct, cfg: { project: string }, step: StepName, region: string): string {
  return Stack.of(scope).formatArn({
    service: 'lambda', region, resource: 'function', resourceName: functionName(cfg.project, step),
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
}

/** Region-scoped half: functions, log groups and the orchestration role. Instantiate per region. */
export class DrsRegionSwitchSteps extends Construct {
  public readonly functions: Record<StepName, lambda.Function>;
  public readonly role: iam.Role;
  public readonly config: DrsRegionSwitchConfig;

  constructor(scope: Construct, id: string, props: DrsRegionSwitchStepsProps) {
    super(scope, id);
    this.config = props;
    const stack = Stack.of(this);
    const tag = props.sourceServerTag ?? { key: `${props.project}:role`, value: 'app' };
    const retention = props.logRetention ?? logs.RetentionDays.ONE_DAY;

    this.role = new iam.Role(this, 'OrchestrationRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `${props.project}: DRS Region Switch step functions (${stack.region})`,
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    this.role.attachInlinePolicy(orchestrationPolicy(this, props));

    const code = lambda.Code.fromAsset(props.codePath ?? path.join(__dirname, '..', '..', 'lambda'), {
      exclude: ['tests', '**/__pycache__', '*.pyc', 'ruff.toml', '.pytest_cache'],
    });

    const env: Record<string, string> = {
      PROJECT: props.project,
      SOURCE_SERVER_TAG_KEY: tag.key,
      SOURCE_SERVER_TAG_VALUE: tag.value,
      PRIMARY_REGION: props.primaryRegion,
      SECONDARY_REGION: props.secondaryRegion,
      PRIMARY_TARGET_GROUP_ARN: props.primaryTargetGroupArn,
      SECONDARY_TARGET_GROUP_ARN: props.secondaryTargetGroupArn,
      APP_INSTANCE_PROFILE_ARN: props.appInstanceProfileArn,
      STATEFUL_EC2: String(props.statefulEc2 ?? false),
      TARGET_PORT: String(props.targetPort ?? 8080),
      ...(props.dbEndpointParameterName ? { DB_PARAM_NAME: props.dbEndpointParameterName } : {}),
      ...(props.secondaryDbEndpoint ? { SECONDARY_DB_ENDPOINT: props.secondaryDbEndpoint } : {}),
      ...(props.launchTemplate?.primarySubnetId ? { PRIMARY_SUBNET_ID: props.launchTemplate.primarySubnetId } : {}),
      ...(props.launchTemplate?.primarySecurityGroupId ? { PRIMARY_APP_SG_ID: props.launchTemplate.primarySecurityGroupId } : {}),
      ...(props.launchTemplate?.secondarySubnetId ? { SECONDARY_SUBNET_ID: props.launchTemplate.secondarySubnetId } : {}),
      ...(props.launchTemplate?.secondarySecurityGroupId ? { SECONDARY_APP_SG_ID: props.launchTemplate.secondarySecurityGroupId } : {}),
      ...(props.launchTemplate?.instanceType ? { INSTANCE_TYPE: props.launchTemplate.instanceType } : {}),
    };

    const fns = {} as Record<StepName, lambda.Function>;
    for (const step of STEPS) {
      const name = functionName(props.project, step.name);
      const logGroup = new logs.LogGroup(this, `${step.name}-logs`, {
        logGroupName: `/aws/lambda/${name}`,
        retention: retention,
      });
      const override = props.functionOverrides?.[step.name];
      fns[step.name] = new lambda.Function(this, step.name, {
        functionName: name,
        description: step.description,
        runtime: props.runtime ?? lambda.Runtime.PYTHON_3_12,
        handler: handlerFor(step),
        code,
        role: this.role,
        timeout: override?.timeout ?? step.timeout,
        memorySize: override?.memorySize ?? 256,
        environment: env,
        logGroup,
      });
      Tags.of(fns[step.name]).add(`${props.project}:step`, step.name);
    }
    this.functions = fns;
  }
}

export interface DrsRegionSwitchPlanStepsProps {
  readonly config: DrsRegionSwitchConfig;
}

/** Plan-scoped half: typed steps for `CfnPlan` and the invoke grant for the plan's role. */
export class DrsRegionSwitchPlanSteps extends Construct {
  /** ACTIVATE <secondary> workflow steps, in order: drs-recover-ec2, register-target. */
  public readonly activateSecondarySteps: arc.CfnPlan.StepProperty[];
  /**
   * ACTIVATE <primary> workflow steps, in order: reverse-replicate, failback-launch,
   * register-failback-target, [Aurora/DNS steps belong here], reprotect, retire.
   * Use {@link interleaveActivatePrimary} to insert the consumer's steps at the right point.
   */
  public readonly activatePrimarySteps: arc.CfnPlan.StepProperty[];
  /** All 14 function ARNs (7 steps x 2 regions), for IAM. */
  public readonly functionArns: string[];

  constructor(scope: Construct, id: string, props: DrsRegionSwitchPlanStepsProps) {
    super(scope, id);
    const cfg = props.config;
    const regionFor = (workflow: Workflow, run: StepSpec['regionToRun']): string => {
      const activating = workflow === 'activateSecondary' ? cfg.secondaryRegion : cfg.primaryRegion;
      const deactivating = workflow === 'activateSecondary' ? cfg.primaryRegion : cfg.secondaryRegion;
      return run === 'activatingRegion' ? activating : deactivating;
    };
    const toStep = (s: StepSpec): arc.CfnPlan.StepProperty => ({
      name: s.name,
      description: s.description,
      executionBlockType: 'CustomActionLambda',
      executionBlockConfiguration: {
        customActionLambdaConfig: {
          regionToRun: s.regionToRun,
          retryIntervalMinutes: s.retryIntervalMinutes,
          timeoutMinutes: s.stepTimeoutMinutes,
          // ARC's console requires a function per plan region; the API accepts one ARN per step,
          // resolved in RegionToRun. We deploy to both regions and reference the in-region one.
          lambdas: [{ arn: functionArn(this, cfg, s.name, regionFor(s.workflow, s.regionToRun)) }],
          ungraceful: { behavior: 'skip' },
        },
      },
    });
    this.activateSecondarySteps = stepsFor('activateSecondary').map(toStep);
    this.activatePrimarySteps = stepsFor('activatePrimary').map(toStep);
    this.functionArns = STEPS.flatMap((s) => [
      functionArn(this, cfg, s.name, cfg.primaryRegion),
      functionArn(this, cfg, s.name, cfg.secondaryRegion),
    ]);
  }

  /** Insert the consumer's Aurora switchover-back / DNS flip-back steps at the documented point. */
  public interleaveActivatePrimary(...middle: arc.CfnPlan.StepProperty[]): arc.CfnPlan.StepProperty[] {
    return [
      ...this.activatePrimarySteps.slice(0, ACTIVATE_PRIMARY_SPLIT),
      ...middle,
      ...this.activatePrimarySteps.slice(ACTIVATE_PRIMARY_SPLIT),
    ];
  }

  /** Grant the plan's execution role what ARC needs to run the steps. */
  public grantInvoke(role: iam.IRole): void {
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'InvokeDrsRegionSwitchSteps',
      actions: ['lambda:InvokeFunction', 'lambda:GetFunction'],
      resources: this.functionArns,
    }));
  }
}

/** The orchestration role policy proven live through repeated fail-over/fail-back cycles, both modes. */
function orchestrationPolicy(scope: Construct, cfg: DrsRegionSwitchConfig): iam.Policy {
  const stack = Stack.of(scope);
  const partition = stack.partition;
  const account = stack.account;
  const viaService = { Bool: { 'aws:ViaAWSService': 'true' } };
  const paramBase = (cfg.dbEndpointParameterName ?? `/${cfg.project}/`).replace(/^\//, '').split('/')[0];

  return new iam.Policy(scope, 'OrchestrationPolicy', {
    statements: [
      // DRS: exactly the APIs the seven steps call (lambda/drs_region_switch). Read side first, then the
      // recovery / reverse-replication / retire mutations. Resource must stay '*': source servers,
      // recovery instances and jobs are created by DRS at run time and carry no predictable ARN.
      // test/drs-actions-contract.test.ts derives this list from the Lambda code and fails on drift.
      new iam.PolicyStatement({
        sid: 'Drs',
        actions: [
          'drs:DescribeSourceServers', 'drs:DescribeRecoveryInstances', 'drs:DescribeJobs',
          'drs:DescribeJobLogItems', 'drs:GetLaunchConfiguration',
          'drs:UpdateLaunchConfiguration', 'drs:StartRecovery', 'drs:ReverseReplication',
          'drs:StopFailback', 'drs:StopReplication', 'drs:TerminateRecoveryInstances',
          'drs:DisconnectSourceServer', 'drs:DeleteSourceServer', 'drs:DeleteRecoveryInstance',
          'drs:TagResource', 'drs:UntagResource',
        ],
        resources: ['*'],
      }),
      // Read-only EC2/KMS/IAM that DRS and the steps use as the caller.
      new iam.PolicyStatement({
        sid: 'Ec2Describe',
        actions: [
          'ec2:DescribeInstances', 'ec2:DescribeInstanceStatus', 'ec2:DescribeInstanceAttribute',
          'ec2:DescribeInstanceTypes', 'ec2:DescribeInstanceTypeOfferings', 'ec2:DescribeAccountAttributes',
          'ec2:DescribeAvailabilityZones', 'ec2:DescribeImages', 'ec2:DescribeLaunchTemplates',
          'ec2:DescribeLaunchTemplateVersions', 'ec2:DescribeSecurityGroups', 'ec2:DescribeSnapshots',
          'ec2:DescribeSubnets', 'ec2:DescribeVolumes', 'ec2:DescribeKeyPairs', 'ec2:DescribeCapacityReservations',
          'ec2:DescribeHosts', 'ec2:GetEbsEncryptionByDefault', 'ec2:GetEbsDefaultKmsKeyId',
          'kms:DescribeKey', 'kms:ListAliases', 'iam:ListInstanceProfiles', 'iam:ListRoles',
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        sid: 'TagOwnInstances', actions: ['ec2:CreateTags'],
        resources: [`arn:${partition}:ec2:*:${account}:instance/*`],
      }),
      // launch-into-source requires the target STOPPED; the step stops it directly (not via DRS),
      // so ViaAWSService below does not cover it. Scoped to instances that opted in.
      new iam.PolicyStatement({
        sid: 'StopLaunchIntoTarget', actions: ['ec2:StopInstances'],
        resources: [`arn:${partition}:ec2:*:${account}:instance/*`],
        conditions: { StringEquals: { 'ec2:ResourceTag/AWSDRS': 'AllowLaunchingIntoThisInstance' } },
      }),
      // DRS launches recovery instances with the CALLER's credentials (forwarded access session).
      new iam.PolicyStatement({
        sid: 'DrsViaServiceMutations',
        actions: [
          'ec2:CreateVolume', 'ec2:DeleteVolume', 'ec2:AttachVolume', 'ec2:DetachVolume', 'ec2:CreateSnapshot',
          'ec2:DeleteSnapshot', 'ec2:CreateSecurityGroup', 'ec2:AuthorizeSecurityGroupIngress',
          'ec2:AuthorizeSecurityGroupEgress', 'ec2:RevokeSecurityGroupEgress', 'ec2:StartInstances',
          'ec2:StopInstances', 'ec2:TerminateInstances', 'ec2:ModifyInstanceAttribute', 'ec2:GetConsoleOutput',
          'ec2:GetConsoleScreenshot',
        ],
        resources: ['*'], conditions: viaService,
      }),
      new iam.PolicyStatement({ sid: 'DrsViaServiceRunInstances', actions: ['ec2:RunInstances'], resources: ['*'], conditions: viaService }),
      new iam.PolicyStatement({
        sid: 'DrsViaServiceCreateTags', actions: ['ec2:CreateTags'],
        resources: ['security-group', 'volume', 'snapshot', 'instance', 'network-interface']
          .map((r) => `arn:${partition}:ec2:*:*:${r}/*`),
        conditions: {
          StringEquals: { 'ec2:CreateAction': ['CreateSecurityGroup', 'CreateVolume', 'CreateSnapshot', 'RunInstances'] },
          ...viaService,
        },
      }),
      new iam.PolicyStatement({
        sid: 'DrsLaunchTemplateMaintenance',
        actions: ['ec2:CreateLaunchTemplateVersion', 'ec2:ModifyLaunchTemplate', 'ec2:DeleteLaunchTemplateVersions'],
        resources: [`arn:${partition}:ec2:*:*:launch-template/*`],
        conditions: { Null: { 'aws:ResourceTag/AWSElasticDisasterRecoveryManaged': 'false' } },
      }),
      new iam.PolicyStatement({
        sid: 'PassRolesForRecoveryLaunch', actions: ['iam:PassRole'],
        resources: [
          cfg.appInstanceRoleArn,
          `arn:${partition}:iam::${account}:role/service-role/AWSElasticDisasterRecoveryConversionServerRole`,
          `arn:${partition}:iam::${account}:role/service-role/AWSElasticDisasterRecoveryRecoveryInstanceRole`,
        ],
        conditions: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
      }),
      new iam.PolicyStatement({
        sid: 'Elb',
        actions: ['elasticloadbalancing:RegisterTargets', 'elasticloadbalancing:DeregisterTargets',
          'elasticloadbalancing:DescribeTargetHealth', 'elasticloadbalancing:DescribeTargetGroups'],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        sid: 'SsmDbEndpoint', actions: ['ssm:PutParameter', 'ssm:GetParameter'],
        resources: [`arn:${partition}:ssm:*:${account}:parameter/${paramBase}/*`],
      }),
    ],
  });
}
