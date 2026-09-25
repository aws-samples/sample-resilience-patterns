import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * DRS creates the "AWS Elastic Disaster Recovery default Replication Server Security Group"
 * outside CloudFormation and terminates the replication server asynchronously after
 * delete-source-server. e2e run 36040999672 (2026-09-24): cleanup's one-shot sweep got
 * DependencyViolation at 19:01:51Z, DRS terminated the replication server at 19:12:44Z, and
 * CloudFormation failed the VPC delete with "has dependencies" at 19:31:20Z and again at
 * 19:48:00Z (both del() attempts), leaving drsdemo-net-secondary DELETE_FAILED; `make deploy`
 * then failed at net-1 because a DELETE_FAILED stack cannot be updated. The sweep must wait
 * for the group to become deletable before the network stacks are deleted.
 */
const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'cleanup.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');

function sweepFn(): string {
  const start = src.indexOf('sweep_drs_sgs() {');
  const end = src.indexOf('\n}\n', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end + '\n}\n'.length);
}

/**
 * Run sweep_drs_sgs under a fake `aws`: describe-stack-resources returns a VPC id;
 * describe-security-groups lists one DRS group until it has been deleted; delete-security-group
 * fails with DependencyViolation for the first `refusals` calls, then succeeds. sleep is a no-op.
 */
function runSweep(refusals: number): { code: number; out: string; deletes: number } {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'cleanup-sweep-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'deletes'), '0\n');
  fs.writeFileSync(path.join(bin, 'aws'), [
    '#!/usr/bin/env bash',
    'case "$*" in',
    '  *describe-stack-resources*) echo "vpc-0123456789abcdef0"; exit 0;;',
    '  *describe-security-groups*)',
    `    [[ -f "${dir}/gone" ]] && { echo ""; exit 0; }; echo "sg-0drs00000000000001"; exit 0;;`,
    '  *delete-security-group*)',
    `    n=$(cat "${dir}/deletes"); echo $((n+1)) > "${dir}/deletes"`,
    `    if (( n < ${refusals} )); then echo "DependencyViolation: resource has a dependent object" >&2; exit 254; fi`,
    `    touch "${dir}/gone"; exit 0;;`,
    'esac',
    'echo "{}"',
  ].join('\n') + '\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const harness = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'aws() { command aws --no-cli-pager "$@"; }',
    sweepFn(),
    'sweep_drs_sgs us-west-2 drsdemo-net-secondary',
    'echo "SWEEP EXITED 0"',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'harness.sh'), harness, { mode: 0o755 });
  try {
    const out = execFileSync('bash', [path.join(dir, 'harness.sh')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out, deletes: Number(fs.readFileSync(path.join(dir, 'deletes'), 'utf8')) };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}`, deletes: Number(fs.readFileSync(path.join(dir, 'deletes'), 'utf8')) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('cleanup.sh waits for DRS to release its replication-server security group', () => {
  test('the sweep runs before the network stacks are deleted', () => {
    const sweep = src.indexOf('sweep_drs_sgs "$SECONDARY"');
    const delNet = src.indexOf('del "$SECONDARY" "${PROJECT}-net-secondary"');
    expect(sweep).toBeGreaterThan(0);
    expect(delNet).toBeGreaterThan(sweep);
  });

  test('retries the delete until DRS has released the group, then returns', () => {
    // 45 refusals = 11 min of a 15 s cadence, longer than the 10m53s DRS took live.
    const r = runSweep(45);
    expect(r.code).toBe(0);
    expect(r.deletes).toBe(46);
    expect(r.out).toMatch(/still referenced \(45\/80\)/);
    expect(r.out).toMatch(/deleted DRS-created security group sg-0drs00000000000001/);
    expect(r.out).toMatch(/SWEEP EXITED 0/);
  });

  test('returns on the first pass when the group is already deletable', () => {
    const r = runSweep(0);
    expect(r.code).toBe(0);
    expect(r.deletes).toBe(1);
    expect(r.out).not.toMatch(/still referenced/);
  });

  test('gives up with a warning, not an error, after 80 polls (20 min) so the stack deletes still run', () => {
    const r = runSweep(1000);
    expect(r.code).toBe(0);
    expect(r.deletes).toBe(80);
    expect(r.out).toMatch(/WARN: DRS-created security group\(s\) still referenced after 20 min/);
    expect(r.out).toMatch(/SWEEP EXITED 0/);
  });

  test('bounded at 80 x 15 s', () => {
    expect(sweepFn()).toMatch(/seq 1 80/);
    expect(sweepFn()).toMatch(/sleep 15/);
  });
});
