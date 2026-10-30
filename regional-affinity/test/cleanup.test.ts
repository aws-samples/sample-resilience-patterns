import * as fs from 'fs';
import * as path from 'path';
import { SAMPLE_TAG } from '../lib/names';
import { makeStubs, Stubs } from './stubs';

/**
 * cleanup.sh deletes real stacks, so its refusals matter as much as its deletions. These tests run
 * the script as written, with the stand-in `aws` and `sleep` of test/stubs/cleanup/.
 *
 * The stand-in answers `describe-stacks` with the two values the script's --query selects, the
 * status and the value of the sample tag, and does not evaluate the query itself: the query is
 * checked against the real AWS CLI by hand, not here.
 */
const ROOT = path.join(__dirname, '..');
const CLEANUP = path.join(ROOT, 'cleanup.sh');

const [E1, E2] = ['us-east-1', 'us-east-2'];
/** The five stacks in the order cleanup.sh deletes them: [Region, name]. */
const STACKS: Array<[string, string]> = [
  [E1, 'regional-affinity-records'], [E1, 'regional-affinity-plan'],
  [E1, 'regional-affinity-region-us-east-1'], [E2, 'regional-affinity-region-us-east-2'], [E1, 'regional-affinity-data'],
];
const TAG = SAMPLE_TAG.value;

describe('cleanup.sh', () => {
  let stubs: Stubs;
  beforeEach(() => {
    stubs = makeStubs('cleanup');
  });
  afterEach(() => stubs.cleanup());

  /** Create every stack with the given status and tag (None: untagged); `except` leaves some out. */
  const deploy = (options: { status?: string; tags?: Record<string, string>; except?: string[] } = {}) => {
    for (const [region, name] of STACKS) {
      if (options.except?.includes(name)) continue;
      stubs.put(`stacks/${region}__${name}`, `${options.status ?? 'CREATE_COMPLETE'} ${options.tags?.[name] ?? TAG}\n`);
    }
  };
  const run = (env: Record<string, string> = {}) => stubs.run('bash', [CLEANUP, '-'], { env });
  const deleted = () => stubs.calls().filter((c) => c.startsWith('cloudformation delete-stack')).map((c) => c.split(' ')[3]);

  test('deletes the five tagged stacks in dependency order, waits for each, and exits 0', () => {
    deploy();
    const result = run();
    expect(result.output).toContain('cleanup: every regional-affinity stack is gone');
    expect(result.status).toBe(0);
    expect(deleted()).toEqual(STACKS.map(([, name]) => name));
    expect(stubs.calls().filter((c) => c.startsWith('cloudformation wait'))).toHaveLength(5);
  });

  test('nothing deployed is a success, and deletes nothing', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.output).toContain('regional-affinity-data: absent');
    expect(deleted()).toEqual([]);
  });

  test('a lookup that fails for any reason but "does not exist" keeps the stack: exit 1, nothing deleted, never "gone"', () => {
    deploy();
    stubs.put('mode', 'access_denied');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.output).toContain('AccessDenied');
    expect(result.output).toMatch(/describe-stacks failed, so the stack is counted as remaining/);
    expect(result.output).not.toMatch(/is gone|: absent| deleted/);
    expect(deleted()).toEqual([]);
  });

  test.each([
    ['one Region', 'us-east-1'],
    ['a space after the comma', 'us-east-1, us-east-2'],
    ['three Regions', 'us-east-1,us-east-2,us-west-2'],
    ['the same Region twice', 'us-east-1,us-east-1'],
    ['a trailing comma', 'us-east-1,'],
    ['no Region names', 'one,two'],
  ])('REGIONS with %s is refused before any AWS call', (_name, regions) => {
    deploy();
    const result = run({ REGIONS: regions });
    expect(result.status).toBe(1);
    expect(result.output).toContain('REGIONS must name two different Regions');
    expect(stubs.calls()).toEqual([]);
  });

  test.each(['demo-', 'a', 'Upper', '1abc', 'x'.repeat(25), 'two words'])('PROJECT %p is refused before any AWS call', (project) => {
    deploy();
    const result = run({ PROJECT: project });
    expect(result.status).toBe(1);
    expect(result.output).toContain('PROJECT must be 2 to 24 lowercase letters');
    expect(stubs.calls()).toEqual([]);
  });

  test('a rejected delete-stack fails fast: each stack is reported and counted, and nothing waits', () => {
    deploy();
    stubs.put('mode', 'delete_rejected');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.output).toContain('regional-affinity-plan: delete-stack was rejected, so the stack remains');
    expect(deleted()).toEqual(STACKS.map(([, name]) => name)); // one request each, none repeated
    expect(stubs.calls().filter((c) => c.startsWith('cloudformation wait'))).toEqual([]);
  });

  test('a stack without the sample tag is left alone and makes cleanup exit 1; the others are still deleted', () => {
    deploy({ tags: { 'regional-affinity-data': 'None' } });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.output).toContain('regional-affinity-data (CREATE_COMPLETE) is not tagged sample=regional-affinity');
    expect(deleted()).toEqual(STACKS.map(([, name]) => name).filter((n) => n !== 'regional-affinity-data'));
  });

  test('a stack tagged for another application is left alone too', () => {
    deploy({ tags: { 'regional-affinity-plan': 'something-else' } });
    const result = run();
    expect(result.status).toBe(1);
    expect(deleted()).not.toContain('regional-affinity-plan');
    expect(deleted()).toHaveLength(4);
  });

  test('a stack that fails to delete is requested once more, its reasons are printed, and cleanup exits 1', () => {
    deploy();
    stubs.put('mode', 'delete_failed:regional-affinity-plan');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.output).toContain('regional-affinity-plan is DELETE_FAILED after attempt 2');
    expect(result.output).toContain('The hosted zone is not empty');
    expect(deleted().filter((n) => n === 'regional-affinity-plan')).toHaveLength(2);
    expect(deleted().filter((n) => n !== 'regional-affinity-plan')).toHaveLength(4); // the other waves still run
  });

  test('another PROJECT and other Regions address only their own stack names', () => {
    for (const [region, suffix] of [['eu-west-1', 'records'], ['eu-west-1', 'plan'], ['eu-west-1', 'region-eu-west-1'],
      ['eu-central-1', 'region-eu-central-1'], ['eu-west-1', 'data']]) {
      stubs.put(`stacks/${region}__demo-abc123-${suffix}`, `CREATE_COMPLETE ${TAG}\n`);
    }
    deploy(); // the default project's stacks must not be touched
    const result = run({ PROJECT: 'demo-abc123', REGIONS: 'eu-west-1,eu-central-1' });
    expect(result.status).toBe(0);
    expect(deleted().sort()).toEqual(['demo-abc123-data', 'demo-abc123-plan', 'demo-abc123-records',
      'demo-abc123-region-eu-central-1', 'demo-abc123-region-eu-west-1']);
  });
});

describe('the sample tag', () => {
  test('cleanup.sh requires the tag that lib/names.ts defines (test/app.test.ts shows bin/app.ts applies it)', () => {
    const script = fs.readFileSync(CLEANUP, 'utf8');
    expect(script.match(/^TAG_KEY=(\S+)/m)?.[1]).toBe(SAMPLE_TAG.key);
    expect(script.match(/^TAG_VALUE=(\S+)/m)?.[1]).toBe(SAMPLE_TAG.value);
  });
});
