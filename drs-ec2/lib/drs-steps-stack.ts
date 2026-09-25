import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DrsRegionSwitchConfig, DrsRegionSwitchSteps, STEPS } from './constructs/drs-region-switch-steps';

export interface DrsStepsStackProps extends cdk.StackProps {
  readonly config: DrsRegionSwitchConfig;
}

/** One per plan region: the seven step functions + orchestration role (see the construct). */
export class DrsStepsStack extends cdk.Stack {
  public readonly steps: DrsRegionSwitchSteps;

  constructor(scope: Construct, id: string, props: DrsStepsStackProps) {
    super(scope, id, props);
    this.steps = new DrsRegionSwitchSteps(this, 'Drs', props.config);
    for (const s of STEPS) {
      new cdk.CfnOutput(this, `${s.name}-arn`, { value: this.steps.functions[s.name].functionArn });
    }
    new cdk.CfnOutput(this, 'OrchestrationRoleArn', { value: this.steps.role.roleArn });
  }
}
