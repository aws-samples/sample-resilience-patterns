import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AppPrimaryStack } from '../lib/app-primary-stack';

/** Resolve a synthesized UserData value (plain string or Fn::Join) to the boot script text. */
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
  expect(instances).toHaveLength(1);
  return flatten((instances[0] as any).Properties.UserData);
}

describe('app instance boot script: database credential handling', () => {
  const script = appBootScript();

  test('the unit file never carries the database credentials', () => {
    // A systemd unit under /etc/systemd/system is world-readable (0644); credentials go in a
    // root-only EnvironmentFile instead.
    expect(script).not.toMatch(/Environment=DB_PASSWORD/);
    expect(script).not.toMatch(/Environment=DB_USER/);
    expect(script).toMatch(/^EnvironmentFile=\/etc\/drsapp\.env$/m);
  });

  test('the secret is fetched with xtrace off and written under umask 077', () => {
    // `set -x` echoes every expansion into cloud-init-output.log and the EC2 console output.
    const off = script.indexOf('set +x');
    const on = script.indexOf('set -x', off);
    expect(off).toBeGreaterThan(0);
    expect(on).toBeGreaterThan(off);
    const quiet = script.slice(off, on);
    expect(quiet).toMatch(/secretsmanager get-secret-value/);
    expect(quiet).toMatch(/umask 077/);
    expect(quiet).toMatch(/> \/etc\/drsapp\.env/);
    // ... and nowhere else, so the value never sits in a traced shell variable.
    const loud = script.slice(0, off) + script.slice(on);
    expect(loud).not.toMatch(/get-secret-value/);
    expect(loud).not.toMatch(/DB_PASS/);
  });
});
