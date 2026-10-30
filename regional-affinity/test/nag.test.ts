import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { NAG_SUPPRESSIONS, StackKind, suppress } from '../lib/nag';
import { dataStack, planStack, recordsStack, regionStack } from './fixtures';

/**
 * Every stack passes the cdk-nag AwsSolutions pack with only the suppressions lib/nag.ts lists for
 * its kind of stack, and every suppression listed for a kind fires on every stack of that kind. So
 * the list cannot hide a stale reason, and a reason written for one stack cannot quietly cover a
 * finding on another.
 */
const stacks = (): Array<[StackKind, cdk.Stack]> => [
  ['region', regionStack('us-east-1', { vpcId: 'vpc-0000000000000000b' })],
  ['region', regionStack('us-east-2', { peeringConnectionId: 'pcx-0123456789abcdef0' })],
  ['data', dataStack()],
  ['plan', planStack()],
  ['records', recordsStack()],
];

/** The distinct AwsSolutions rule IDs reported on a stack, as errors or warnings. */
const findings = (stack: cdk.Stack): string[] => {
  cdk.Aspects.of(stack).add(new AwsSolutionsChecks());
  const reported = [...Annotations.fromStack(stack).findError('*', Match.anyValue()),
    ...Annotations.fromStack(stack).findWarning('*', Match.anyValue())];
  return [...new Set(reported.flatMap((m) => String(m.entry.data).match(/AwsSolutions-[A-Z]+\d+/)?.[0] ?? []))].sort();
};

test.each(stacks().map(([kind, stack]) => [stack.stackName, kind, stack] as const))(
  '%s has no AwsSolutions finding beyond the suppressions for a %s stack',
  (_name, kind, stack) => {
    suppress(stack, kind);
    expect(findings(stack)).toEqual([]);
  });

test.each(stacks().map(([kind, stack]) => [stack.stackName, kind, stack] as const))(
  '%s: every suppression listed for a %s stack fires on it, and nothing else does',
  (_name, kind, stack) => {
    // No suppression applied here: what fires is exactly what the list must cover.
    expect(findings(stack)).toEqual(NAG_SUPPRESSIONS[kind].map((s) => s.id).sort());
  });

test('IAM5 is accepted on the plan stack only, and the Region stacks accept IAM4, ELB2 and VPC7', () => {
  const ids = (kind: StackKind) => NAG_SUPPRESSIONS[kind].map((s) => s.id).sort();
  expect(ids('plan')).toEqual(['AwsSolutions-IAM5']);
  expect(ids('region')).toEqual(['AwsSolutions-ELB2', 'AwsSolutions-IAM4', 'AwsSolutions-VPC7']);
  expect([ids('data'), ids('records')]).toEqual([[], []]);
});
