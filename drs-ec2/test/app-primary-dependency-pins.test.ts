import * as fs from 'fs';
import * as path from 'path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AppPrimaryStack } from '../lib/app-primary-stack';

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

describe('app instance boot script: Python dependency pins', () => {
  const script = appBootScript();
  const pipLines = script.split('\n').filter((l) => /\bpip install\b/.test(l));

  test('every pip install names exact versions only', () => {
    expect(pipLines.length).toBeGreaterThan(0);
    for (const line of pipLines) {
      const specs = line.replace(/.*\bpip install\b/, '').split(/\s+/).filter((t) => t && !t.startsWith('-'));
      expect(specs.length).toBeGreaterThan(0);
      for (const spec of specs) expect(spec).toMatch(/^[A-Za-z0-9_.-]+==\d+\.\d+\.\d+$/);
    }
  });

  test('THIRD-PARTY-LICENSES lists the same versions the instance installs', () => {
    const licenses = fs.readFileSync(path.join(__dirname, '..', 'THIRD-PARTY-LICENSES'), 'utf8');
    for (const line of pipLines) {
      for (const m of line.matchAll(/([A-Za-z0-9_.-]+)==(\d+\.\d+\.\d+)/g)) {
        const [, name, version] = m;
        expect(licenses).toMatch(new RegExp(`\\|\\s*${name}[^|\\n]*\\|\\s*${version.replace(/\./g, '\\.')}\\s*\\|`, 'i'));
      }
    }
  });
});
