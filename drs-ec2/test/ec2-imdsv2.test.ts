import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AppPrimaryStack } from '../lib/app-primary-stack';
import { ObserverStack } from '../lib/observer-stack';

function instances(): Record<string, any> {
  const app = new App();
  const appStack = new AppPrimaryStack(app, 'app', {
    env: { account: '123456789012', region: 'us-east-2' },
    project: 'drsdemo', hostedZoneName: 'drsdemo.internal', recordName: 'app.drsdemo.internal',
    vpcId: 'vpc-12345678', subnetIds: ['subnet-aaaa', 'subnet-bbbb'], writerEndpoint: 'writer.example.com',
  });
  const observer = new ObserverStack(app, 'observer', {
    env: { account: '123456789012', region: 'us-east-1' },
    project: 'drsdemo', cidr: '10.2.0.0/16',
    primary: { region: 'us-east-2', vpcId: 'vpc-primary', cidr: '10.0.0.0/16' },
    secondary: { region: 'us-west-2', vpcId: 'vpc-secondary', cidr: '10.1.0.0/16' },
  });
  return {
    ...Template.fromStack(appStack).findResources('AWS::EC2::Instance'),
    ...Template.fromStack(observer).findResources('AWS::EC2::Instance'),
  };
}

describe('EC2 instances: instance metadata service', () => {
  const all = instances();

  test('the pattern launches exactly two instances (app + observer bastion)', () => {
    expect(Object.keys(all)).toHaveLength(2);
  });

  test('every instance requires IMDSv2 (session tokens) and keeps the endpoint enabled', () => {
    for (const [id, res] of Object.entries(all)) {
      const opts = res.Properties.MetadataOptions;
      expect({ id, opts }).toEqual({ id, opts: expect.objectContaining({ HttpTokens: 'required', HttpEndpoint: 'enabled' }) });
    }
  });
});
