import * as cdk from 'aws-cdk-lib';
import { NagPackSuppression, NagSuppressions } from 'cdk-nag';

/** The kinds of stack the sample deploys. Each gets only the suppressions for rules that fire on it. */
export type StackKind = 'region' | 'data' | 'plan' | 'records';

const IAM4: NagPackSuppression = {
  id: 'AwsSolutions-IAM4',
  reason: 'AWSLambdaBasicExecutionRole and AWSLambdaVPCAccessExecutionRole are the documented Lambda execution '
    + 'policies: log delivery, and the network interfaces of the probe that runs in the VPC.',
};
const IAM5: NagPackSuppression = {
  id: 'AwsSolutions-IAM5',
  reason: 'The plan execution role reads its own plan (arc-region-switch GetPlan, GetPlanExecution, '
    + 'ListPlanExecutions only), whose ARN ARC generates when it creates the plan, after the role exists.',
};
const ELB2: NagPackSuppression = {
  id: 'AwsSolutions-ELB2',
  reason: 'ALB access logs are left out to keep the sample small; enable them in production.',
};
const VPC7: NagPackSuppression = {
  id: 'AwsSolutions-VPC7',
  reason: 'VPC flow logs are left out to keep the sample small; the VPCs have no internet path. Enable them in production.',
};

/**
 * The cdk-nag AwsSolutions findings this sample accepts, each with its reason, on the kind of stack
 * where its rule fires and nowhere else: a later change that makes a rule fire on another stack is
 * reported there instead of being covered by a reason written for a different stack. Only rules that
 * fire are listed; test/nag.test.ts fails when a stack has a finding that is not listed for it, and
 * when a suppression listed for a stack does not fire on it.
 */
export const NAG_SUPPRESSIONS: Record<StackKind, NagPackSuppression[]> = {
  region: [IAM4, ELB2, VPC7],
  plan: [IAM5],
  data: [],
  records: [],
};

export function suppress<T extends cdk.Stack>(stack: T, kind: StackKind): T {
  if (NAG_SUPPRESSIONS[kind].length > 0) {
    NagSuppressions.addStackSuppressions(stack, NAG_SUPPRESSIONS[kind], true);
  }
  return stack;
}
