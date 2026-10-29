import * as cdk from 'aws-cdk-lib';
import { NagPackSuppression, NagSuppressions } from 'cdk-nag';

/**
 * The cdk-nag AwsSolutions findings this sample accepts, each with its reason. Only rules that
 * fire are listed; test/nag.test.ts fails when a stack has a finding not listed here.
 */
export const NAG_SUPPRESSIONS: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWSLambdaBasicExecutionRole and AWSLambdaVPCAccessExecutionRole are the documented Lambda execution '
      + 'policies: log delivery, and the network interfaces of the probe that runs in the VPC.',
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'The plan execution role reads its own plan (arc-region-switch GetPlan, GetPlanExecution, '
      + 'ListPlanExecutions only), whose ARN ARC generates when it creates the plan, after the role exists.',
  },
  { id: 'AwsSolutions-ELB2', reason: 'ALB access logs are left out to keep the sample small; enable them in production.' },
  {
    id: 'AwsSolutions-VPC7',
    reason: 'VPC flow logs are left out to keep the sample small; the VPCs have no internet path. Enable them in production.',
  },
];

export function suppress<T extends cdk.Stack>(stack: T): T {
  NagSuppressions.addStackSuppressions(stack, NAG_SUPPRESSIONS, true);
  return stack;
}
