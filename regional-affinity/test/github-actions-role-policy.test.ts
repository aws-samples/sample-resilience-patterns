import * as fs from 'fs';
import * as path from 'path';

/**
 * The GitHub Actions e2e runs the Makefile, cleanup.sh and scripts/demo.py under one OIDC role
 * (docs/iam/github-actions-role-policy.json). This test reads the AWS CLI calls those files write
 * out, and checks that the policy grants the IAM action of each one and grants no action that none
 * of them uses. A call added without a grant fails here instead of as an AccessDenied in a live run.
 *
 * What it reads, exactly:
 *   - Makefile and cleanup.sh: `aws <service> <operation>` and `$(AWS) <service> <operation>`, after
 *     joining lines that end in a backslash and dropping whole-line comments.
 *   - scripts/demo.py: `aws(region, "<service>", "<operation>", ...)` calls whose service and
 *     operation are string literals (it fails on an aws() call whose are not, which it cannot read).
 *
 * What it does not do: it does not read a call's arguments, so it cannot tell which resource a call
 * is aimed at. The policy's resources are pinned statement by statement below instead, so widening
 * one, adding a Deny, or adding a statement fails here and gets reviewed by hand. `cdk deploy` itself
 * runs under the CDK bootstrap roles, which the policy may assume.
 */
const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const policy = JSON.parse(read('docs/iam/github-actions-role-policy.json'));

/** sts:GetCallerIdentity needs no permission (STS API reference), so the policy does not grant it. */
const NO_GRANT_NEEDED = new Set(['sts:GetCallerIdentity']);

/** Actions with no resource type (Service Authorization Reference), whose statement can only say "*". */
const NO_RESOURCE_TYPE = new Set(['arc-region-switch:ListPlansInRegion']);

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

/** The commands of a shell file or Makefile: backslash continuations joined, whole-line comments dropped. */
function commands(text: string): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  let pending: { line: number; text: string } | undefined;
  text.split('\n').forEach((raw, i) => {
    if (!pending && raw.trim().startsWith('#')) return;
    const continued = raw.endsWith('\\');
    const piece = (continued ? raw.slice(0, -1) : raw).trim();
    pending = pending ? { ...pending, text: `${pending.text} ${piece}` } : { line: i + 1, text: piece };
    if (!continued) {
      if (pending.text) found.push(pending);
      pending = undefined;
    }
  });
  if (pending) found.push(pending);
  return found;
}

/** scripts/demo.py without whole-line comments, with the position of each line kept for reporting. */
const withoutComments = (text: string) => text.split('\n').map((l) => (l.trim().startsWith('#') ? '' : l)).join('\n');
const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** Matches the start of every aws( call in demo.py (not its definition) and the ones the scan can read. */
const PY_CALL = /(?<![\w."])(?<!def )aws\(/g;
const PY_LITERAL_CALL = /(?<![\w."])(?<!def )aws\(\s*(?:[^,()]|\([^()]*\))+,\s*"([a-z0-9-]+)",\s*"([a-z0-9-]+)"/g;

/** "service operation [waiter]" for every AWS CLI call in the shell files and in scripts/demo.py. */
function calls(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (call: string, where: string) => found.set(call, [...(found.get(call) ?? []), where]);
  for (const file of ['Makefile', 'cleanup.sh']) {
    for (const { line, text } of commands(read(file))) {
      for (const m of text.matchAll(/(?:\$\(AWS\)|\baws)\s+([a-z0-9-]+)\s+([a-z0-9-]+)(?:\s+(stack-[a-z-]+-complete))?/g)) {
        add([m[1], m[2], m[3]].filter(Boolean).join(' '), `${file}:${line}`);
      }
    }
  }
  const demo = withoutComments(read('scripts/demo.py'));
  for (const m of demo.matchAll(PY_LITERAL_CALL)) add(`${m[1]} ${m[2]}`, `scripts/demo.py:${lineOf(demo, m.index ?? 0)}`);
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

test('the scan reads every aws() call in scripts/demo.py: each names a literal service and operation', () => {
  const demo = withoutComments(read('scripts/demo.py'));
  const sites = [...demo.matchAll(PY_CALL)].map((m) => lineOf(demo, m.index ?? 0));
  const readable = [...demo.matchAll(PY_LITERAL_CALL)].map((m) => lineOf(demo, m.index ?? 0));
  expect(sites.length).toBeGreaterThanOrEqual(10);
  expect(sites.filter((line) => !readable.includes(line))).toEqual([]);
});

test('the scan reads a call split over lines and ignores a commented one', () => {
  expect(commands('aws \\\n  ec2 delete-vpc --vpc-id v\n# aws s3 ls bucket\n  # aws sns list-topics\n')).toEqual([
    { line: 1, text: 'aws ec2 delete-vpc --vpc-id v' }]);
  // a joined call is read like a one-line command, and a comment yields none
  const text = commands('aws \\\n  ec2 delete-vpc\n# aws s3 ls\n').map((c) => c.text).join('\n');
  expect([...text.matchAll(/\baws\s+([a-z0-9-]+)\s+([a-z0-9-]+)/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual(['ec2 delete-vpc']);
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

describe('what each statement may touch', () => {
  const resources = (sid: string) => [policy.Statement.find((s: any) => s.Sid === sid).Resource].flat();
  const inBothRegions = (pattern: string) => ['us-east-1', 'us-east-2'].map((r) => pattern.replace('REGION', r));

  test('every statement allows, and names resources: nothing denies, nothing is a NotAction or NotResource', () => {
    for (const s of policy.Statement) {
      expect([s.Sid, s.Effect]).toEqual([s.Sid, 'Allow']);
      expect(s.NotAction).toBeUndefined();
      expect(s.NotResource).toBeUndefined();
    }
  });

  test('the statements, and the resources of each, are exactly these', () => {
    expect(Object.fromEntries(policy.Statement.map((s: any) => [s.Sid, [s.Resource].flat()]))).toEqual({
      CdkBootstrap: ['deploy', 'file-publishing'].flatMap((role) => inBothRegions(
        `arn:aws:iam::ACCOUNT_ID:role/cdk-hnb659fds-${role}-role-ACCOUNT_ID-REGION`)),
      Stacks: inBothRegions('arn:aws:cloudformation:REGION:ACCOUNT_ID:stack/regional-affinity*/*'),
      SeedTable: inBothRegions('arn:aws:dynamodb:REGION:ACCOUNT_ID:table/regional-affinity*-customers'),
      Plan: ['arn:aws:arc-region-switch::ACCOUNT_ID:plan/regional-affinity*'],
      PlanList: ['*'],
      PassPlanRole: ['arn:aws:iam::ACCOUNT_ID:role/regional-affinity*'],
      ReadRecords: ['arn:aws:route53:::hostedzone/*'],
      Probe: inBothRegions('arn:aws:lambda:REGION:ACCOUNT_ID:function:regional-affinity*-probe'),
    });
  });

  test('"*" is granted only for actions that have no resource type', () => {
    for (const s of policy.Statement.filter((st: any) => resources(st.Sid).includes('*'))) {
      expect([s.Sid, [s.Action].flat().filter((a: string) => !NO_RESOURCE_TYPE.has(a))]).toEqual([s.Sid, []]);
    }
  });
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
