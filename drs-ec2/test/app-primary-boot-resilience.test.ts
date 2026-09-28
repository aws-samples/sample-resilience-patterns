import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AppPrimaryStack } from '../lib/app-primary-stack';

/**
 * The boot script runs under `set -e` and depends on the package repositories, SSM, S3 and
 * Secrets Manager. Before this pin a single transient failure ended the script before the systemd
 * unit existed, so `Restart=always` had nothing to restart and the instance never served. Every
 * network-dependent command is wrapped in a bounded retry, and the unit waits for network-online.
 */
function flatten(node: any): string {
  if (typeof node === 'string') return node;
  if (node && node['Fn::Base64'] !== undefined) return flatten(node['Fn::Base64']);
  if (node && node['Fn::Join']) {
    const [sep, parts] = node['Fn::Join'];
    return parts.map(flatten).join(sep);
  }
  return JSON.stringify(node);
}

function appBootScript(): string {
  const app = new App();
  const stack = new AppPrimaryStack(app, 'app', {
    env: { account: '123456789012', region: 'us-east-2' },
    project: 'drsdemo', hostedZoneName: 'drsdemo.internal', recordName: 'app.drsdemo.internal',
    vpcId: 'vpc-12345678', subnetIds: ['subnet-aaaa', 'subnet-bbbb'], writerEndpoint: 'writer.example.com',
    appCodeBucket: 'appcode-bucket',
  });
  const instances = Object.values(Template.fromStack(stack).findResources('AWS::EC2::Instance'));
  return flatten((instances[0] as any).Properties.UserData);
}

/** The `retry()` definition as the instance runs it. */
function retryDefinition(script: string): string {
  const line = script.split('\n').find((l) => l.startsWith('retry() {'));
  expect(line).toBeDefined();
  return line!;
}

/** Run `retry` against a command that fails `failures` times before succeeding; sleep is a no-op. */
function runRetry(script: string, failures: number): { code: number; out: string } {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'boot-retry-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\necho "slept $1"\nexit 0\n', { mode: 0o755 });
  const harness = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    retryDefinition(script),
    `flaky() { n=$(cat "${dir}/n" 2>/dev/null || echo 0); echo $((n+1)) > "${dir}/n"; [ "$n" -ge ${failures} ]; }`,
    'retry flaky',
    'echo "RETRY RETURNED 0"',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'harness.sh'), harness, { mode: 0o755 });
  try {
    // `retry` writes its notices to stderr on purpose (stdout may be captured, as in DB_ENDPOINT=$(...)),
    // so merge the two streams here to see them.
    const out = execFileSync('bash', ['-c', `exec 2>&1; bash "${path.join(dir, 'harness.sh')}"`], {
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

describe('app instance boot script: survives transient failures of its network dependencies', () => {
  const script = appBootScript();

  test('every network-dependent command is wrapped in retry', () => {
    expect(script).toMatch(/^retry dnf install -y postgresql15$/m);
    expect(script).toMatch(/^retry \/opt\/app\/venv\/bin\/pip install /m);
    expect(script).toMatch(/^DB_ENDPOINT=\$\(retry aws ssm get-parameter /m);
    expect(script).toMatch(/^retry aws s3 cp "s3:\/\/[^"]+\/app\/app\.py"/m);
    expect(script).toMatch(/^retry aws s3 cp "s3:\/\/[^"]+\/app\/ui\.html"/m);
    expect(script).toMatch(/\(umask 077; retry aws secretsmanager get-secret-value /);
    // No bare call slipped past the wrapper.
    for (const line of script.split('\n')) {
      if (/^(dnf |aws |\/opt\/app\/venv\/bin\/pip )/.test(line)) throw new Error(`unwrapped network call: ${line}`);
    }
  });

  test('the unit waits for the network and restarts the app after a crash', () => {
    expect(script).toMatch(/^After=network-online\.target$/m);
    expect(script).toMatch(/^Wants=network-online\.target$/m);
    expect(script).toMatch(/^Restart=always$/m);
    expect(script).not.toMatch(/^After=network\.target$/m);
  });

  test('retry succeeds once the command does, sleeping between attempts', () => {
    const r = runRetry(script, 2);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/retry 1\/5: flaky/);
    expect(r.out).toMatch(/slept 10/);
    expect(r.out).toMatch(/retry 2\/5: flaky/);
    expect(r.out).toMatch(/slept 20/);
    expect(r.out).toMatch(/RETRY RETURNED 0/);
  });

  test('retry gives up after five attempts and the script fails under set -e', () => {
    const r = runRetry(script, 99);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/retry 4\/5: flaky/);
    expect(r.out).not.toMatch(/retry 5\/5/);
    expect(r.out).not.toMatch(/RETRY RETURNED 0/);
  });
});
