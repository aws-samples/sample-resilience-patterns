import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  ACTIVATE_PRIMARY_SPLIT, DrsRegionSwitchConfig, DrsRegionSwitchPlanSteps, DrsRegionSwitchSteps, STEPS,
} from '../lib/constructs/drs-region-switch-steps';

const cfg: DrsRegionSwitchConfig = {
  project: 'drsdemo',
  primaryRegion: 'us-east-2',
  secondaryRegion: 'us-west-2',
  primaryTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/pri/abc',
  secondaryTargetGroupArn: 'arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/sec/def',
  appInstanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/drsdemo-app-instance-profile',
  appInstanceRoleArn: 'arn:aws:iam::123456789012:role/drsdemo-app-instance-role',
  dbEndpointParameterName: '/drsdemo/db-writer-endpoint',
  secondaryDbEndpoint: 'db.usw2.example',
  statefulEc2: true,
};

function regionStack(region: string): { stack: Stack; steps: DrsRegionSwitchSteps } {
  const app = new App();
  const stack = new Stack(app, `S-${region}`, { env: { account: '123456789012', region } });
  const steps = new DrsRegionSwitchSteps(stack, 'Drs', { ...cfg, codePath: `${__dirname}/../lambda` });
  return { stack, steps };
}

describe('DrsRegionSwitchSteps (per region)', () => {
  const { stack } = regionStack('us-west-2');
  const t = Template.fromStack(stack);

  test('creates one function per step with deterministic name and handler', () => {
    t.resourceCountIs('AWS::Lambda::Function', STEPS.length);
    for (const s of STEPS) {
      t.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: `drsdemo-${s.name}`,
        Handler: `drs_region_switch.${s.module}.handler`,
        Runtime: 'python3.12',
        Timeout: s.timeout.toSeconds(),
      });
    }
  });

  test('every function has an explicit 1-day log group', () => {
    t.resourceCountIs('AWS::Logs::LogGroup', STEPS.length);
    t.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/aws/lambda/drsdemo-drs-retire', RetentionInDays: 1 });
  });

  test('every log group is deleted with its stack (an explicit name that outlives the stack blocks the next deploy)', () => {
    // CDK's LogGroup default is RemovalPolicy.RETAIN. With a fixed logGroupName that leaves
    // /aws/lambda/drsdemo-* behind after `make clean`, and the next deploy's change set fails early
    // validation with "already exists" on all seven groups (live, 2026-09-23, account e2e).
    const groups = t.findResources('AWS::Logs::LogGroup');
    expect(Object.keys(groups)).toHaveLength(STEPS.length);
    for (const [id, res] of Object.entries(groups)) {
      expect({ id, DeletionPolicy: res.DeletionPolicy, UpdateReplacePolicy: res.UpdateReplacePolicy })
        .toEqual({ id, DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
    }
  });

  test('environment carries the configuration the handlers read', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'drsdemo-drs-reprotect',
      Environment: { Variables: Match.objectLike({
        PROJECT: 'drsdemo', SOURCE_SERVER_TAG_KEY: 'drsdemo:role', SOURCE_SERVER_TAG_VALUE: 'app',
        PRIMARY_REGION: 'us-east-2', SECONDARY_REGION: 'us-west-2', STATEFUL_EC2: 'true',
        DB_PARAM_NAME: '/drsdemo/db-writer-endpoint', SECONDARY_DB_ENDPOINT: 'db.usw2.example',
      }) },
    });
  });

  test('orchestration role: direct StopInstances only on launch-into opt-in instances', () => {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Sid: 'StopLaunchIntoTarget', Action: 'ec2:StopInstances',
        Condition: { StringEquals: { 'ec2:ResourceTag/AWSDRS': 'AllowLaunchingIntoThisInstance' } },
      })]) },
    });
  });

  test('orchestration role: EC2 mutations DRS performs as the caller are ViaAWSService-only', () => {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Sid: 'DrsViaServiceRunInstances', Action: 'ec2:RunInstances',
        Condition: { Bool: { 'aws:ViaAWSService': 'true' } },
      })]) },
    });
  });

  test('orchestration role: PassRole limited to the app role and the DRS service roles', () => {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Sid: 'PassRolesForRecoveryLaunch',
        Resource: Match.arrayWith(['arn:aws:iam::123456789012:role/drsdemo-app-instance-role']),
        Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
      })]) },
    });
  });
});

describe('DrsRegionSwitchPlanSteps (plan side)', () => {
  const app = new App();
  const stack = new Stack(app, 'Plan', { env: { account: '123456789012', region: 'us-east-2' } });
  const plan = new DrsRegionSwitchPlanSteps(stack, 'Steps', { config: cfg });

  test('emits the two workflows in the documented order', () => {
    expect(plan.activateSecondarySteps.map((s) => s.name)).toEqual(['drs-recover-ec2', 'register-target']);
    expect(plan.activatePrimarySteps.map((s) => s.name)).toEqual([
      'drs-reverse-replicate', 'drs-failback-launch', 'register-failback-target', 'drs-reprotect', 'drs-retire',
    ]);
  });

  test('each step references the function in its RegionToRun region', () => {
    const cfgOf = (s: any) => s.executionBlockConfiguration.customActionLambdaConfig;
    const arnOf = (s: any) => stack.resolve(cfgOf(s).lambdas[0].arn);
    const expectArn = (region: string, fn: string) => ({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' },
      `:lambda:${region}:123456789012:function:${fn}`]] });
    // activate secondary: recover runs in the activating (secondary) region
    expect(arnOf(plan.activateSecondarySteps[0])).toEqual(expectArn('us-west-2', 'drsdemo-drs-recover-ec2'));
    // activate primary: reverse-replicate runs in the deactivating (secondary) region
    expect(arnOf(plan.activatePrimarySteps[0])).toEqual(expectArn('us-west-2', 'drsdemo-drs-reverse-replicate'));
    // ...and retire too; recover's counterpart in the primary is NOT referenced by any step
    expect(arnOf(plan.activatePrimarySteps[4])).toEqual(expectArn('us-west-2', 'drsdemo-drs-retire'));
    expect(cfgOf(plan.activatePrimarySteps[0]).regionToRun).toBe('deactivatingRegion');
    expect(cfgOf(plan.activatePrimarySteps[1]).timeoutMinutes).toBe(45);
    for (const s of [...plan.activateSecondarySteps, ...plan.activatePrimarySteps]) {
      expect(s.executionBlockType).toBe('CustomActionLambda');
      expect(cfgOf(s).ungraceful).toEqual({ behavior: 'skip' });
    }
  });

  test('interleave puts the consumer steps after register-failback-target and before reprotect', () => {
    const aurora = { name: 'aurora-back', executionBlockType: 'AuroraGlobalDatabase', executionBlockConfiguration: {} } as any;
    const dns = { name: 'dns-back', executionBlockType: 'Route53HealthCheck', executionBlockConfiguration: {} } as any;
    const names = plan.interleaveActivatePrimary(aurora, dns).map((s) => s.name);
    expect(names).toEqual(['drs-reverse-replicate', 'drs-failback-launch', 'register-failback-target',
      'aurora-back', 'dns-back', 'drs-reprotect', 'drs-retire']);
    expect(ACTIVATE_PRIMARY_SPLIT).toBe(3);
  });

  test('grantInvoke covers all 14 functions with Invoke + GetFunction', () => {
    const role = new iam.Role(stack, 'PlanRole', { assumedBy: new iam.ServicePrincipal('arc-region-switch.amazonaws.com') });
    plan.grantInvoke(role);
    expect(plan.functionArns).toHaveLength(STEPS.length * 2);
    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Sid: 'InvokeDrsRegionSwitchSteps',
        Action: ['lambda:InvokeFunction', 'lambda:GetFunction'],
        Resource: Match.arrayWith([
          { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':lambda:us-east-2:123456789012:function:drsdemo-drs-retire']] },
          { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':lambda:us-west-2:123456789012:function:drsdemo-drs-retire']] },
        ]),
      })]) },
    });
  });
});
