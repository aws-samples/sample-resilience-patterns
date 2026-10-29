import * as fs from 'fs';
import * as path from 'path';

/**
 * The GitHub Actions e2e runs the Makefile, cleanup.sh and scripts/demo.py under one OIDC role
 * (docs/iam/github-actions-role-policy.json). This test derives every AWS call those files make and
 * asserts that the policy grants the matching IAM action, and that it grants nothing they do not
 * call. A call added to a script without a grant fails here instead of as an AccessDenied in a
 * live run. `cdk deploy` itself runs under the CDK bootstrap roles, which the policy may assume.
 */
const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const policy = JSON.parse(read('docs/iam/github-actions-role-policy.json'));

/** sts:GetCallerIdentity needs no permission (STS API reference), so the policy does not grant it. */
const NO_GRANT_NEEDED = new Set(['sts:GetCallerIdentity']);

/** CLI operations whose IAM actions are not just the PascalCase of the operation name. */
const SPECIAL: Record<string, string[]> = {
  'cloudformation wait stack-delete-complete': ['cloudformation:DescribeStacks'],
  'lambda invoke': ['lambda:InvokeFunction'],
  // UpdatePlan authorizes GetPlan and passes the plan's execution role (Service Authorization Reference)
  'arc-region-switch update-plan': ['arc-region-switch:UpdatePlan', 'arc-region-switch:GetPlan', 'iam:PassRole'],
};

const pascal = (kebab: string) => kebab.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');

function actionsFor(call: string): string[] {
  if (SPECIAL[call]) return SPECIAL[call];
  const [service, op] = call.split(' ');
  return [`${service}:${pascal(op)}`];
}

/** "service operation [waiter]" for every AWS CLI call in the shell files and in scripts/demo.py. */
function calls(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (call: string, where: string) => found.set(call, [...(found.get(call) ?? []), where]);
  for (const file of ['Makefile', 'cleanup.sh']) {
    read(file).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/(?:\$\(AWS\)|\baws)\s+([a-z0-9-]+)\s+([a-z0-9-]+)(?:\s+(stack-[a-z-]+-complete))?/g)) {
        add([m[1], m[2], m[3]].filter(Boolean).join(' '), `${file}:${i + 1}`);
      }
    });
  }
  read('scripts/demo.py').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\baws\([^,()]+,\s*"([a-z0-9-]+)",\s*"([a-z0-9-]+)"/g)) add(`${m[1]} ${m[2]}`, `scripts/demo.py:${i + 1}`);
  });
  return found;
}

const granted = (): Set<string> => new Set(policy.Statement.flatMap((s: any) => [s.Action].flat()));

test('the scan finds the calls the runner makes', () => {
  const found = calls();
  for (const expected of ['cloudformation describe-stacks', 'cloudformation delete-stack', 'cloudformation wait stack-delete-complete',
    'dynamodb batch-write-item', 'arc-region-switch start-plan-execution', 'lambda invoke', 'route53 list-resource-record-sets']) {
    expect(found.has(expected)).toBe(true);
  }
});

test('every AWS call the runner makes is granted', () => {
  const missing: string[] = [];
  for (const [call, where] of calls()) {
    for (const action of actionsFor(call)) {
      if (!NO_GRANT_NEEDED.has(action) && !granted().has(action)) missing.push(`${action} (${call}; ${where.join(', ')})`);
    }
  }
  expect(missing).toEqual([]);
});

test('the policy grants nothing the runner does not call, and no wildcard actions', () => {
  const needed = new Set([...calls().keys()].flatMap(actionsFor));
  const unused = [...granted()].filter((a) => a !== 'sts:AssumeRole' && !needed.has(a));
  expect(unused).toEqual([]);
  expect([...granted()].filter((a) => a.includes('*'))).toEqual([]);
});

test('the bootstrap roles it may assume are the deploy and file-publishing roles of both Regions only', () => {
  const statement = policy.Statement.find((s: any) => s.Sid === 'CdkBootstrap');
  const expected = ['deploy', 'file-publishing'].flatMap((role) => ['us-east-1', 'us-east-2'].map(
    (r) => `arn:aws:iam::ACCOUNT_ID:role/cdk-hnb659fds-${role}-role-ACCOUNT_ID-${r}`));
  expect(statement.Resource).toEqual(expected);
});

test('the plan role can be passed only to Region switch', () => {
  const statement = policy.Statement.find((s: any) => s.Action === 'iam:PassRole');
  expect(statement.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'arc-region-switch.amazonaws.com' } });
});

test('the e2e workflow assumes the role this directory documents', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 'regional-affinity-e2e.yml'), 'utf8');
  expect(workflow).toContain('role/github-actions-regional-affinity');
  expect(read('docs/iam/README.md')).toContain('github-actions-regional-affinity');
});
