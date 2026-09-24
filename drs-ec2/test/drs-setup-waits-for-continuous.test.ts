import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * `make deploy` ends at the resting state: the rehearsal's leg-0 baseline asserts forward
 * replication CONTINUOUS with a 5-minute settle budget, which is sized for the minute or so
 * DRS needs after a fail-back, not for a fresh install's initial sync (15 to 25 minutes for
 * the 8 GB root volume). e2e run 36028055691 (2026-09-24) registered the agent at 18:03Z,
 * started `rehearse-cycle` at 18:04Z and failed at "forward replication is INITIAL_SYNC"
 * without executing the plan. The wait belongs in drs-setup.sh, where the Makefile already
 * promised it ("wait for CONTINUOUS").
 */
const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'drs-setup.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');

/** The wait loop as one unit, so the fake-aws test runs exactly what the script runs. */
function waitLoop(): string {
  const start = src.indexOf('echo "== [7] wait for forward replication CONTINUOUS');
  const end = src.indexOf('\n  done\n', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end + '\n  done\n'.length);
}

/**
 * Run the wait loop under a fake `aws` whose describe-source-servers answers walk a scripted
 * list of states (one per call, last value repeats). Sleep is a no-op so 90 polls take no time.
 */
function runLoop(states: string[]): { code: number; out: string } {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'drs-setup-wait-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'states'), states.join('\n') + '\n');
  fs.writeFileSync(path.join(bin, 'aws'), [
    '#!/usr/bin/env bash',
    '# fake aws: describe-source-servers pops the next scripted state; anything else prints {}',
    'if [[ "$*" == *"describe-source-servers"* && "$*" == *dataReplicationState* ]]; then',
    `  n=$(cat "${dir}/calls" 2>/dev/null || echo 0); echo $((n+1)) > "${dir}/calls"`,
    `  s=$(sed -n "$((n+1))p" "${dir}/states"); [[ -n "$s" ]] || s=$(tail -n1 "${dir}/states")`,
    '  echo "$s"; exit 0',
    'fi',
    'echo "{}"',
  ].join('\n') + '\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const harness = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SECONDARY=us-west-2; SS=s-test',
    'aws() { command aws --no-cli-pager "$@"; }',
    waitLoop(),
    'echo "LOOP EXITED 0"',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'harness.sh'), harness, { mode: 0o755 });
  try {
    const out = execFileSync('bash', [path.join(dir, 'harness.sh')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
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

describe('drs-setup.sh ends at the resting state (forward replication CONTINUOUS)', () => {
  test('waits for CONTINUOUS after tagging the source server, bounded at 45 min', () => {
    const tagAt = src.indexOf('drs tag-resource');
    const waitAt = src.indexOf('wait for forward replication CONTINUOUS');
    expect(tagAt).toBeGreaterThan(0);
    expect(waitAt).toBeGreaterThan(tagAt);
    expect(waitLoop()).toMatch(/seq 1 90/); // 90 x 30 s = 45 min
    expect(waitLoop()).toMatch(/sleep 30/);
  });

  test('the Makefile promise "wait for CONTINUOUS" is kept by the script it runs', () => {
    const mk = fs.readFileSync(path.join(ROOT, 'Makefile'), 'utf8');
    expect(mk).toMatch(/^drs-setup:.*wait for CONTINUOUS/m);
    expect(mk).toMatch(/^drs-setup:[^\n]*\n\t@scripts\/drs-setup\.sh/m);
  });

  test('returns once the state reaches CONTINUOUS', () => {
    const r = runLoop(['INITIATING', 'INITIAL_SYNC', 'INITIAL_SYNC', 'CREATING_SNAPSHOT', 'CONTINUOUS']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/replication is INITIAL_SYNC \(2\/90\)/);
    expect(r.out).toMatch(/replication CONTINUOUS after 2 min/);
    expect(r.out).toMatch(/LOOP EXITED 0/);
  });

  test('fails fast on a state that will not progress on its own', () => {
    for (const bad of ['STALLED', 'DISCONNECTED']) {
      const r = runLoop(['INITIAL_SYNC', bad, 'CONTINUOUS']);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(new RegExp(`ERROR: replication is ${bad}`));
      expect(r.out).not.toMatch(/LOOP EXITED 0/);
    }
  });

  test('fails after 90 polls when replication never reaches CONTINUOUS', () => {
    const r = runLoop(['INITIAL_SYNC']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\(90\/90\)/);
    expect(r.out).toMatch(/did not reach CONTINUOUS within 45 min \(last state: INITIAL_SYNC\)/);
  });
});
