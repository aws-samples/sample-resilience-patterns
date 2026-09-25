import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The sample's own success signals must not be false-green. Before these pins:
 *   - `rehearse-switchover.sh` returned 0 on `completedWithExceptions` (a skipped step) and only
 *     printed WARN when the recovered target, the ARC health check or the Aurora writer was wrong,
 *     so `make rehearse` passed with no EC2 tier in the secondary;
 *   - `drs-setup.sh` skipped everything after the registration loop when the agent never
 *     registered, and downgraded a failed tag write to a message, so `make deploy` ended green
 *     with nothing protected or with a server the plan cannot select.
 */
const ROOT = path.join(__dirname, '..');
const rehearse = fs.readFileSync(path.join(ROOT, 'scripts', 'rehearse-switchover.sh'), 'utf8');
const setup = fs.readFileSync(path.join(ROOT, 'scripts', 'drs-setup.sh'), 'utf8');

function slice(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end + endMarker.length);
}

/** Run a bash harness with a fake `aws` (a bash script body) on PATH and a no-op sleep. */
function run(harnessBody: string, fakeAws: string): { code: number; out: string } {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'green-signals-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'aws'), `#!/usr/bin/env bash\n${fakeAws}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'harness.sh'), `#!/usr/bin/env bash\nset -euo pipefail\n${harnessBody}\n`, { mode: 0o755 });
  try {
    const out = execFileSync('bash', [path.join(dir, 'harness.sh')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STATE_DIR: dir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('rehearse-switchover.sh: a rehearsal is green only when the plan and the estate are', () => {
  const runPlan = slice(rehearse, 'run_plan() {', '\n}\n');

  test('completedWithExceptions (a skipped step) fails the leg', () => {
    const r = run([
      'PLAN_ARN=arn:plan; aws() { command aws "$@"; }',
      runPlan,
      'run_plan activate us-west-2 graceful && echo "LEG PASSED" || echo "LEG FAILED rc=$?"',
    ].join('\n'), [
      'if [[ "$*" == *start-plan-execution* ]]; then echo ex-1; exit 0; fi',
      'if [[ "$*" == *"query executionState"* ]]; then echo completedWithExceptions; exit 0; fi',
      'if [[ "$*" == *stepStates* ]]; then printf "drs-recover-ec2\\tskipped\\n"; exit 0; fi',
      'echo "{}"',
    ].join('\n'));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/FAIL: completed with skipped step\(s\)/);
    expect(r.out).toMatch(/drs-recover-ec2\s+skipped/);
    expect(r.out).toMatch(/LEG FAILED/);
    expect(r.out).not.toMatch(/LEG PASSED/);
  });

  test('a completed leg still passes', () => {
    const r = run([
      'PLAN_ARN=arn:plan; aws() { command aws "$@"; }',
      runPlan,
      'run_plan activate us-west-2 graceful && echo "LEG PASSED"',
    ].join('\n'), [
      'if [[ "$*" == *start-plan-execution* ]]; then echo ex-1; exit 0; fi',
      'if [[ "$*" == *"query executionState"* ]]; then echo completed; exit 0; fi',
      'echo "{}"',
    ].join('\n'));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/LEG PASSED/);
  });

  test('post-failover checks are PASS or FAIL, and any FAIL makes the rehearsal exit non-zero', () => {
    expect(rehearse).not.toMatch(/echo "WARN:/);
    const checks = slice(rehearse, 'FAILURES=0', 'ARC check not healthy"');
    const tail = slice(rehearse, 'if (( FAILURES ))', 'exit 1; fi');
    const r = run([
      'SECONDARY=us-west-2; AR=us-east-2',
      'A="writer_region=us-east-2 | arc_hc: us-east-2=healthy us-west-2=unhealthy | secondary_tg: <empty> | drs_recovery: <none>"',
      checks,
      tail,
      'echo "UNREACHABLE"',
    ].join('\n'), 'echo "{}"');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL: expected writer in us-west-2, got us-east-2/);
    expect(r.out).toMatch(/FAIL: no healthy target in secondary TG/);
    expect(r.out).toMatch(/FAIL: us-west-2 ARC check not healthy/);
    expect(r.out).toMatch(/rehearsal FAILED: 3 check\(s\) failed/);
    expect(r.out).not.toMatch(/UNREACHABLE/);
  });

  test('the fail-back runs before the verdict, so a failed check never leaves the estate mid-switch', () => {
    const checksAt = rehearse.indexOf('FAILURES=0');
    const failBackAt = rehearse.indexOf('== [4] FAIL BACK');
    const verdictAt = rehearse.indexOf('if (( FAILURES ))');
    expect(checksAt).toBeGreaterThan(0);
    expect(failBackAt).toBeGreaterThan(checksAt);
    expect(verdictAt).toBeGreaterThan(failBackAt);
  });
});

describe('drs-setup.sh: make deploy cannot end green without a protected, selectable source server', () => {
  const registration = slice(setup, 'echo "== [4] wait for DRS source server registration =="', 'never saw the server"; exit 1; }');

  test('fails when the agent never registers a source server', () => {
    const r = run([
      'SECONDARY=us-west-2; IID=i-0abc; aws() { command aws "$@"; }',
      registration,
      'echo "REGISTRATION PASSED"',
    ].join('\n'), 'echo None');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no source server yet \(30\)/);
    expect(r.out).toMatch(/ERROR: no DRS source server registered for i-0abc within 15 min/);
    expect(r.out).not.toMatch(/REGISTRATION PASSED/);
  });

  test('continues once the source server appears', () => {
    const r = run([
      'SECONDARY=us-west-2; IID=i-0abc; aws() { command aws "$@"; }',
      registration,
      'echo "REGISTRATION PASSED: $SS"',
    ].join('\n'), [
      'n=$(cat "$STATE_DIR/n" 2>/dev/null || echo 0); echo $((n+1)) > "$STATE_DIR/n"',
      'if [ "$n" -lt 2 ]; then echo None; else echo s-123; fi',
    ].join('\n'));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/source server registered: s-123/);
    expect(r.out).toMatch(/REGISTRATION PASSED: s-123/);
  });

  const tagging = slice(setup, '  ACCOUNT_ID=$(aws sts get-caller-identity', 'echo "tagged $SS with ${PROJECT}:role=app"');

  test('the tag write is not best-effort and is read back', () => {
    expect(setup).not.toMatch(/tag may need manual apply/);
    const r = run([
      'SECONDARY=us-west-2; SS=s-123; PROJECT=drsdemo; aws() { command aws "$@"; }',
      tagging,
      'echo "TAG PASSED"',
    ].join('\n'), [
      'if [[ "$*" == *get-caller-identity* ]]; then echo 123456789012; exit 0; fi',
      'if [[ "$*" == *tag-resource* ]]; then echo "$*" > "$STATE_DIR/tagged"; exit 0; fi',
      'if [[ "$*" == *describe-source-servers* ]]; then if [ -f "$STATE_DIR/tagged" ]; then echo app; else echo None; fi; exit 0; fi',
      'echo "{}"',
    ].join('\n'));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/tagged s-123 with drsdemo:role=app/);
    expect(r.out).toMatch(/TAG PASSED/);
  });

  test('a tag that does not land fails the deploy', () => {
    const r = run([
      'SECONDARY=us-west-2; SS=s-123; PROJECT=drsdemo; aws() { command aws "$@"; }',
      tagging,
      'echo "TAG PASSED"',
    ].join('\n'), [
      'if [[ "$*" == *get-caller-identity* ]]; then echo 123456789012; exit 0; fi',
      'if [[ "$*" == *tag-resource* ]]; then exit 0; fi',
      'if [[ "$*" == *describe-source-servers* ]]; then echo None; exit 0; fi',
      'echo "{}"',
    ].join('\n'));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ERROR: drsdemo:role=app is not on s-123 after tag-resource/);
    expect(r.out).not.toMatch(/TAG PASSED/);
  });

  test('a rejected tag write fails the deploy', () => {
    const r = run([
      'SECONDARY=us-west-2; SS=s-123; PROJECT=drsdemo; aws() { command aws "$@"; }',
      tagging,
      'echo "TAG PASSED"',
    ].join('\n'), [
      'if [[ "$*" == *get-caller-identity* ]]; then echo 123456789012; exit 0; fi',
      'if [[ "$*" == *tag-resource* ]]; then echo "AccessDeniedException" >&2; exit 254; fi',
      'echo "{}"',
    ].join('\n'));
    expect(r.code).not.toBe(0);
    expect(r.out).not.toMatch(/TAG PASSED/);
  });
});
