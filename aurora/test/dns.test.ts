import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DnsStack } from '../lib/dns-stack';

function createStack(healthCheckId?: string) {
  const app = new cdk.App();
  return Template.fromStack(new DnsStack(app, 'TestDns', {
    project: 'test', domainName: 'demo.internal',
    primaryVpcId: 'vpc-primary', secondaryVpcId: 'vpc-secondary',
    primaryRegion: 'us-east-1', secondaryRegion: 'us-west-2',
    primaryAuroraAlbDns: 'aurora-primary.elb.amazonaws.com', primaryAuroraAlbHostedZoneId: 'Z1PRIMARY',
    secondaryAuroraAlbDns: 'aurora-secondary.elb.amazonaws.com', secondaryAuroraAlbHostedZoneId: 'Z2SECONDARY',
    ...(healthCheckId ? { primaryHealthCheckId: healthCheckId, secondaryHealthCheckId: healthCheckId } : {}),
    env: { account: '123456789012', region: 'us-east-1' },
  }));
}

describe('DnsStack', () => {
  const template = createStack();

  test('creates private hosted zone', () => {
    template.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'demo.internal' });
  });

  test('associates both VPCs', () => {
    template.hasResourceProperties('AWS::Route53::HostedZone', {
      VPCs: [
        { VPCId: 'vpc-primary', VPCRegion: 'us-east-1' },
        { VPCId: 'vpc-secondary', VPCRegion: 'us-west-2' },
      ],
    });
  });

  test('creates 4 record sets (2 latency-based + 2 region-aligned)', () => {
    template.resourceCountIs('AWS::Route53::RecordSet', 4);
  });

  test('aurora records use latency routing', () => {
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'aurora-app.demo.internal', Type: 'A', Region: 'us-east-1', SetIdentifier: 'PrimaryRegion',
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'aurora-app.demo.internal', Type: 'A', Region: 'us-west-2', SetIdentifier: 'StandbyRegion',
    });
  });

  test('region-aligned simple A-alias records exist', () => {
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'aurora-app-use1.demo.internal', Type: 'A',
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'aurora-app-usw2.demo.internal', Type: 'A',
    });
  });

  test('records have no health check when not provided', () => {
    const records = template.findResources('AWS::Route53::RecordSet');
    for (const [, record] of Object.entries(records)) {
      expect((record as any).Properties.HealthCheckId).toBeUndefined();
    }
  });

  test('records have health check when provided', () => {
    const withHc = createStack('hc-12345');
    withHc.hasResourceProperties('AWS::Route53::RecordSet', { HealthCheckId: 'hc-12345' });
  });
});
