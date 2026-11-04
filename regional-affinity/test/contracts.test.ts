import * as fs from 'fs';
import * as path from 'path';
import { Template } from 'aws-cdk-lib/assertions';
import { dataStack, planStack, recordsStack, regionStack } from './fixtures';

/**
 * The Makefile and scripts/demo.py find stacks by name, read their outputs by key, and pass context
 * keys to bin/app.ts. None of that is type-checked, so a rename on one side would surface only
 * during a deploy. These tests read the three files and compare.
 */
const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const makefile = read('Makefile');
const demo = read('scripts/demo.py');
const app = read('bin/app.ts');

/** Stack suffix (after `<project>-`) -> the output keys its synthesized template declares. */
const outputs: Record<string, Set<string>> = {
  'region-$(R1)': new Set(Object.keys(Template.fromStack(regionStack('us-east-1', { vpcId: 'vpc-0000000000000000b' })).toJSON().Outputs)),
  'region-$(R2)': new Set(Object.keys(Template.fromStack(regionStack('us-east-2')).toJSON().Outputs)),
  plan: new Set(Object.keys(Template.fromStack(planStack()).toJSON().Outputs)),
  data: new Set(Object.keys(Template.fromStack(dataStack()).toJSON().Outputs)),
  records: new Set(Object.keys(Template.fromStack(recordsStack()).toJSON().Outputs ?? {})),
};

test('every output the Makefile reads exists on that stack', () => {
  const reads = [...makefile.matchAll(/\$\(call so,\$\((R1|R2)\),([^,]+),([A-Za-z]+)\)/g)].map((m) => [m[2], m[3]]);
  expect(reads.length).toBeGreaterThanOrEqual(8);
  for (const [stack, key] of reads) {
    expect([stack, outputs[stack]?.has(key)]).toEqual([stack, true]);
  }
});

test('every output scripts/demo.py reads exists on that stack', () => {
  const reads = [...demo.matchAll(/stack_outputs\([^,]+,\s*STACK\[(\w+|"\w+")\]\)\["(\w+)"\]/g)]
    .map((m) => [m[1].replace(/"/g, ''), m[2]]);
  // The script reads outputs only where it must (the commands that run at deploy time); the scan has
  // to find at least one, or the regex above has stopped matching what the script writes.
  expect(reads.length).toBeGreaterThanOrEqual(1);
  for (const [stack, key] of reads) {
    const suffix = stack === 'plan' || stack === 'data' || stack === 'records' ? stack : 'region-$(R1)'; // STACK[region]
    expect([stack, key, outputs[suffix].has(key)]).toEqual([stack, key, true]);
  }
});

test('the stack names the Makefile, scripts/demo.py and bin/app.ts use agree', () => {
  const appStacks = [...app.matchAll(/new \w+Stack\(app, `\$\{project\}-([a-z${}-]+)`/g)]
    .map((m) => m[1].replace('${first}', '$(R1)').replace('${second}', '$(R2)'));
  expect(new Set(appStacks)).toEqual(new Set(['region-$(R1)', 'region-$(R2)', 'data', 'plan', 'records']));
  for (const suffix of ['plan', 'records', 'data']) {
    expect(demo).toContain(`"${suffix}": f"{PROJECT}-${suffix}"`);
  }
  expect(demo).toContain('f"{PROJECT}-region-{r}"');
  expect(read('cleanup.sh')).toContain('"$R1:$PROJECT-records"');
  for (const s of ['$PROJECT-plan', '$PROJECT-region-$R1', '$PROJECT-region-$R2', '$PROJECT-data']) expect(read('cleanup.sh')).toContain(s);
});

test('every context key the Makefile passes is one bin/app.ts reads', () => {
  const passed = new Set([...makefile.matchAll(/-c ([a-zA-Z]+)=/g)].map((m) => m[1]));
  const readKeys = new Set([...app.matchAll(/(?:\bc|list|tryGetContext|needed)\('([a-zA-Z]+)'/g)].map((m) => m[1]));
  const unread = [...passed].filter((k) => !readKeys.has(k));
  expect(unread).toEqual([]);
  expect([...passed].sort()).toEqual(['albDnsNames', 'albHostedZoneIds', 'appLabel', 'domain', 'healthChecks', 'hostedZoneId',
    'nag', 'peerVpcId', 'peeringConnectionId', 'project', 'regions', 'stack', 'vpcIds']);
});
