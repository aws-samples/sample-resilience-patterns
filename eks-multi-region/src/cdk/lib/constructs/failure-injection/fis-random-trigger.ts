import * as fis from 'aws-cdk-lib/aws-fis';
import { Construct } from 'constructs';

/**
 * Props for {@link FisRandomTrigger}.
 *
 * FURTHER-OPTIONAL add-on (failure-injection-changeset §5, "Further-optional
 * `FisRandomTrigger`"). Distilled from multi-az `ssm-random-fault-stack.ts`: SSM
 * Automation documents (`schemaVersion 0.3`, `aws:executeScript` python3.11) that call
 * `fis.start_experiment` on a randomly-chosen template, plus an `ssm.amazonaws.com` role
 * scoped to `fis:StartExperiment` on exactly the generated template ARNs.
 */
export interface FisRandomTriggerProps {
  /** Experiment templates the trigger may randomly start. */
  readonly experiments: fis.CfnExperimentTemplate[];
}

/**
 * **DOCUMENTED STUB (not implemented).** Authoring is deferred per the changeset:
 * "This add-on is NOT needed for basic FIS use — modern FIS pre-built scenarios cover
 * most of it; drop the source's CodeDeploy 'bad-deploy' branch from the generic version.
 * Offer only for demos wanting an unattended/randomized run."
 *
 * Intended shape when implemented (from `ssm-random-fault-stack.ts:36-127`):
 *   1. An `ssm.amazonaws.com` IAM role with `fis:StartExperiment` scoped to exactly the
 *      ARNs of `props.experiments` (NOT `*`).
 *   2. An `ssm.CfnDocument` (Automation, schemaVersion 0.3) whose `aws:executeScript`
 *      step randomly selects one of `props.experiments` and calls `fis.start_experiment`.
 *      The python script is embedded at synth time (`fault-injection/fis-random-trigger/
 *      scripts/*.py`), with the multi-az CodeDeploy "bad-deploy" branch removed.
 *
 * Until implemented, this construct creates NO resources, so it remains inert and never
 * breaks the green skeleton. The constructor validates only that at least one experiment
 * was supplied (so a wiring mistake surfaces early), then no-ops.
 */
export class FisRandomTrigger extends Construct {
  constructor(scope: Construct, id: string, props: FisRandomTriggerProps) {
    super(scope, id);

    if (props.experiments.length === 0) {
      throw new Error(
        'FisRandomTrigger requires at least one experiment template to start. ' +
          'Pass FisNetworkExperiments.{latency,packetLoss,memoryStress}Experiments.',
      );
    }

    // Intentionally creates no resources — see class docstring. This add-on is a
    // documented stub; implement the SSM Automation document + scoped IAM role here.
  }
}
