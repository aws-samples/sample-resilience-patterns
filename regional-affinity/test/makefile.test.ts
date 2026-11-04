import * as fs from 'fs';
import * as path from 'path';
import { makeStubs, Stubs } from './stubs';

/**
 * Runs the Makefile as written, with the stand-in `aws`, `npx` and `python3` of test/stubs/make/, so
 * a recipe's commands are recorded instead of deployed. What the Makefile passes to cdk and to
 * scripts/demo.py is what the stubs log.
 */
const ROOT = path.join(__dirname, '..');
const STEPS = ['base', 'seed', 'peering', 'peering-return', 'plan', 'health-checks', 'records', 'verify'];
/** The stub aws resolves the credentials to 111122223333; a pin on this other account must refuse. */
const OTHER_ACCOUNT = '9'.repeat(12);

describe('the Makefile', () => {
  let stubs: Stubs;
  beforeEach(() => {
    stubs = makeStubs('make');
  });
  afterEach(() => stubs.cleanup());

  const make = (args: string[], env: Record<string, string> = {}) => stubs.run('make', args, { cwd: ROOT, env });
  /** What the recipes ran: the cdk and demo.py calls, without the aws lookups. */
  const commands = () => stubs.calls().filter((c) => !c.startsWith('aws '));
  const cdkContext = (line: string, key: string) => line.match(new RegExp(`-c ${key}=(\\S*)`))?.[1];

  describe('the account pin covers every deploy step, not just deploy', () => {
    test.each(STEPS)('make %s refuses another account and runs nothing', (step) => {
      stubs.put('account', '111122223333');
      const result = make([step, `ACCOUNT=${OTHER_ACCOUNT}`]);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(`credentials resolve to 111122223333 but ACCOUNT=${OTHER_ACCOUNT} is pinned; refusing`);
      expect(commands()).toEqual([]);
    });

    test('a step runs when the account matches the pin', () => {
      const result = make(['plan', 'ACCOUNT=111122223333']);
      expect(result.status).toBe(0);
      expect(result.output).toContain('account: 111122223333');
      expect(commands()).toHaveLength(1);
      expect(commands()[0]).toMatch(/^npx cdk .*deploy regional-affinity-plan /);
    });
  });

  test('make -j still runs the deploy steps one at a time, in order', () => {
    const result = make(['-j4', 'deploy']);
    expect(result.status).toBe(0);
    expect(stubs.calls().filter((c) => c.startsWith('OVERLAP'))).toEqual([]);
    const step = (c: string) => (c.startsWith('npx') ? `cdk ${c.match(/-c stack=(\S+)/)?.[1]}` : `demo ${c.split(' ').slice(2).join(' ')}`);
    expect(commands().map(step)).toEqual(['cdk base', 'demo seed', 'cdk region-us-east-1', 'cdk region-us-east-2', 'cdk plan',
      'demo health-checks', 'demo health-checks --json', 'cdk records', 'demo verify']);
  });

  describe('the stack output lookups', () => {
    const base = () => {
      const result = make(['base']);
      const line = commands()[0] ?? '';
      return { result, peerVpcId: cdkContext(line, 'peerVpcId'), peeringConnectionId: cdkContext(line, 'peeringConnectionId') };
    };

    test('on the first deploy no stack exists, so both values are empty and nothing is printed about it', () => {
      stubs.put('stacks', 'none');
      const { result, peerVpcId, peeringConnectionId } = base();
      expect(result.status).toBe(0);
      expect([peerVpcId, peeringConnectionId]).toEqual(['', '']);
      expect(result.output).not.toMatch(/does not exist|cannot read/);
    });

    test('on a re-deploy both values are passed, so the peering survives', () => {
      stubs.put('stacks', 'outputs');
      const { peerVpcId, peeringConnectionId } = base();
      expect([peerVpcId, peeringConnectionId]).toEqual(['vpc-0abc-us-east-2', 'pcx-0abc']);
    });

    test('a stack that rolled back has no outputs: the value is empty, not the text None', () => {
      stubs.put('stacks', 'rollback');
      const { result, peerVpcId, peeringConnectionId } = base();
      expect([peerVpcId, peeringConnectionId]).toEqual(['', '']);
      expect(commands()[0]).not.toContain('None');
      expect(result.status).toBe(0);
    });

    test('a warning the CLI prints on stderr does not end up in the value', () => {
      stubs.put('stacks', 'warn');
      const { peerVpcId, peeringConnectionId } = base();
      expect([peerVpcId, peeringConnectionId]).toEqual(['vpc-0abc-us-east-2', 'pcx-0abc']);
    });

    test('any other failure stops make with the reason, before anything is deployed', () => {
      stubs.put('stacks', 'denied');
      const { result } = base();
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('cannot read the outputs of regional-affinity-region-us-east-2 in us-east-2');
      expect(result.output).toContain('AccessDenied');
      expect(commands()).toEqual([]);
    });
  });

  describe('drain and restore', () => {
    test.each(['drain', 'restore'])('make %s needs REGION on the command line', (target) => {
      const result = make([target]);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(`pass REGION on the command line, for example: make ${target} REGION=us-east-1`);
      expect(commands()).toEqual([]);
    });

    test.each(['drain', 'restore'])('make %s ignores a REGION left exported in the environment', (target) => {
      const result = make([target], { REGION: 'us-east-1' });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('an exported REGION is ignored');
      expect(commands()).toEqual([]);
    });

    test.each(['drain', 'restore'])('make %s passes REGION, and FROM when it is set', (target) => {
      expect(make([target, 'REGION=us-east-1']).status).toBe(0);
      expect(make([target, 'REGION=us-east-2', 'FROM=us-east-1']).status).toBe(0);
      expect(commands()).toEqual([
        `python3 scripts/demo.py ${target} us-east-1`,
        `python3 scripts/demo.py ${target} us-east-2 --from us-east-1`,
      ]);
    });

    test('status and call pass FROM too', () => {
      expect(make(['status', 'FROM=us-east-1']).status).toBe(0);
      expect(make(['call', 'CUSTOMER=cust-007', 'FROM=us-east-2']).status).toBe(0);
      expect(commands()).toEqual(['python3 scripts/demo.py status --from us-east-1',
        'python3 scripts/demo.py call cust-007 --from us-east-2']);
    });
  });

  describe('the account check of the operate targets belongs to scripts/demo.py', () => {
    // demo.py checks the account itself, with an STS call in the Region the command acts in. A check-account
    // prerequisite would call STS first with no Region, which can be the Region a drain is about to remove.
    test.each([
      ['status', []],
      ['call', []],
      ['drain', ['REGION=us-east-1']],
      ['restore', ['REGION=us-east-1']],
      ['rehearse', []],
    ] as Array<[string, string[]]>)('make %s makes no AWS call of its own before demo.py runs', (target, args) => {
      const result = make([target, ...args]);
      expect(result.status).toBe(0);
      expect(stubs.calls().filter((c) => c.startsWith('aws '))).toEqual([]);
      expect(commands()).toHaveLength(1);
      expect(commands()[0]).toMatch(new RegExp(`^python3 scripts/demo\\.py ${target}\\b`));
    });

    test('ACCOUNT still reaches demo.py, which refuses another account itself', () => {
      expect(make(['drain', 'REGION=us-east-1', `ACCOUNT=${OTHER_ACCOUNT}`]).status).toBe(0); // the stand-in demo.py does not refuse
      expect(fs.readFileSync(path.join(stubs.dir, 'demo-account'), 'utf8').trim()).toBe(OTHER_ACCOUNT);
    });

    test('clean, which runs no demo.py command, still checks the account here, before cleanup.sh', () => {
      const refused = make(['clean', `ACCOUNT=${OTHER_ACCOUNT}`]);
      expect(refused.status).not.toBe(0);
      expect(refused.output).toContain(`ACCOUNT=${OTHER_ACCOUNT} is pinned; refusing`);
      expect(refused.output).not.toContain('cleanup:');
      const ran = make(['clean', 'PROJECT=demo-abc123', 'REGIONS=eu-west-1,eu-central-1', 'ACCOUNT=111122223333']);
      expect(ran.status).toBe(0);
      expect(ran.output).toContain('cleanup: project demo-abc123 in account 111122223333, Regions eu-west-1 and eu-central-1');
    });
  });
});
