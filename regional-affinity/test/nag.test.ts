import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { NAG_SUPPRESSIONS, suppress } from '../lib/nag';
import { dataStack, planStack, recordsStack, regionStack } from './fixtures';

/**
 * Every stack passes the cdk-nag AwsSolutions pack with only the suppressions in lib/nag.ts, and
 * every suppression there is used by at least one stack, so the list cannot hide a stale reason.
 */
const stacks = (): cdk.Stack[] => [
  regionStack('us-east-1', { vpcId: 'vpc-0000000000000000b' }),
  regionStack('us-east-2', { peeringConnectionId: 'pcx-0123456789abcdef0' }),
  dataStack(), planStack(), recordsStack(),
];

test.each(stacks().map((s) => [s.stackName, s]))('%s has no unsuppressed AwsSolutions finding', (_name, stack) => {
  suppress(stack as cdk.Stack);
  cdk.Aspects.of(stack as cdk.Stack).add(new AwsSolutionsChecks());
  const nag = Match.stringLikeRegexp('AwsSolutions-.*');
  expect(Annotations.fromStack(stack as cdk.Stack).findError('*', nag)).toEqual([]);
  expect(Annotations.fromStack(stack as cdk.Stack).findWarning('*', nag)).toEqual([]);
});

test('every suppression is needed by some stack', () => {
  const fired = new Set<string>();
  for (const stack of stacks()) {
    cdk.Aspects.of(stack).add(new AwsSolutionsChecks());
    for (const msg of [...Annotations.fromStack(stack).findError('*', Match.anyValue()),
      ...Annotations.fromStack(stack).findWarning('*', Match.anyValue())]) {
      const id = String(msg.entry.data).match(/AwsSolutions-[A-Z]+\d+/)?.[0];
      if (id) fired.add(id);
    }
  }
  expect([...fired].sort()).toEqual(NAG_SUPPRESSIONS.map((s) => s.id).sort());
});
