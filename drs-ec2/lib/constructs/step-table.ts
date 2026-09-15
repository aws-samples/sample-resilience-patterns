/**
 * The seven DRS Region Switch steps. This table is the contract shared by the CDK construct,
 * the Terraform module, the Lambda package (`lambda/drs_region_switch/__init__.py`) and the
 * documentation. Keep the four in sync.
 */
import { Duration } from 'aws-cdk-lib';

export type StepName =
  | 'drs-recover-ec2'
  | 'register-target'
  | 'drs-reverse-replicate'
  | 'drs-failback-launch'
  | 'register-failback-target'
  | 'drs-reprotect'
  | 'drs-retire';

export type RegionToRun = 'activatingRegion' | 'deactivatingRegion';
export type Workflow = 'activateSecondary' | 'activatePrimary';

export interface StepSpec {
  readonly name: StepName;
  /** Python module inside the `drs_region_switch` package. */
  readonly module: string;
  readonly regionToRun: RegionToRun;
  /** Lambda function timeout. */
  readonly timeout: Duration;
  /** ARC re-invokes the step every N minutes until it returns or the step times out. */
  readonly retryIntervalMinutes: number;
  readonly stepTimeoutMinutes: number;
  /** Returns SKIPPED in ~5 s when statefulEc2 is false. */
  readonly statefulOnly: boolean;
  readonly workflow: Workflow;
  readonly description: string;
}

export const STEPS: readonly StepSpec[] = [
  {
    name: 'drs-recover-ec2', module: 'recover', regionToRun: 'activatingRegion',
    timeout: Duration.minutes(15), retryIntervalMinutes: 1, stepTimeoutMinutes: 30,
    statefulOnly: false, workflow: 'activateSecondary',
    description: 'DRS StartRecovery of the tagged source server; RUNNING recovery instance in the activating region',
  },
  {
    name: 'register-target', module: 'register_target', regionToRun: 'activatingRegion',
    timeout: Duration.minutes(5), retryIntervalMinutes: 1, stepTimeoutMinutes: 15,
    statefulOnly: false, workflow: 'activateSecondary',
    description: 'Repoint the app DB parameter; register the recovered EC2 in the secondary target group; wait healthy',
  },
  {
    name: 'drs-reverse-replicate', module: 'reverse_replicate', regionToRun: 'deactivatingRegion',
    timeout: Duration.minutes(2), retryIntervalMinutes: 1, stepTimeoutMinutes: 120,
    statefulOnly: true, workflow: 'activatePrimary',
    description: 'Reverse replication from the recovery instance back to the primary until CONTINUOUS',
  },
  {
    name: 'drs-failback-launch', module: 'failback_launch', regionToRun: 'deactivatingRegion',
    timeout: Duration.minutes(2), retryIntervalMinutes: 1, stepTimeoutMinutes: 45,
    statefulOnly: true, workflow: 'activatePrimary',
    description: 'Launch for failback in the primary (into the original instance when configured; stops it first)',
  },
  {
    name: 'register-failback-target', module: 'register_failback', regionToRun: 'deactivatingRegion',
    timeout: Duration.minutes(5), retryIntervalMinutes: 1, stepTimeoutMinutes: 15,
    statefulOnly: true, workflow: 'activatePrimary',
    description: 'Register the failed-back EC2 in the primary target group; wait healthy',
  },
  // -- the consumer's Aurora switchover-back and DNS flip-back steps go here --
  {
    name: 'drs-reprotect', module: 'reprotect', regionToRun: 'deactivatingRegion',
    timeout: Duration.minutes(2), retryIntervalMinutes: 1, stepTimeoutMinutes: 120,
    statefulOnly: true, workflow: 'activatePrimary',
    description: 'Re-point the forward source server at the failed-back EC2; wait for RESCAN to complete',
  },
  {
    name: 'drs-retire', module: 'retire', regionToRun: 'deactivatingRegion',
    timeout: Duration.minutes(2), retryIntervalMinutes: 1, stepTimeoutMinutes: 30,
    statefulOnly: false, workflow: 'activatePrimary',
    description: 'Retire cycle residue (recovery instance, FAILBACK server, stale targets); assert the resting state',
  },
];

/** Index in the activatePrimary step list before which the consumer inserts Aurora/DNS steps. */
export const ACTIVATE_PRIMARY_SPLIT = 3;

export function stepsFor(workflow: Workflow): readonly StepSpec[] {
  return STEPS.filter((s) => s.workflow === workflow);
}

export function handlerFor(step: StepSpec): string {
  return `drs_region_switch.${step.module}.handler`;
}
