import { Match, Template } from 'aws-cdk-lib/assertions';
import { NAMES, regionStack, TABLE } from './fixtures';

const template = (...args: Parameters<typeof regionStack>) => Template.fromStack(regionStack(...args));
const resourcesOf = (t: Template, type: string) => Object.values(t.findResources(type)) as any[];

describe('the VPC is isolated', () => {
  const t = template('us-east-1');

  test('no internet gateway, no NAT gateway, no public subnet', () => {
    t.resourceCountIs('AWS::EC2::InternetGateway', 0);
    t.resourceCountIs('AWS::EC2::NatGateway', 0);
    for (const subnet of resourcesOf(t, 'AWS::EC2::Subnet')) {
      expect(subnet.Properties.MapPublicIpOnLaunch).toBe(false);
    }
  });

  test('DNS support and hostnames stay on, so the private hosted zone resolves', () => {
    t.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.11.0.0/16', EnableDnsHostnames: true, EnableDnsSupport: true });
  });

  test('without peering context there is no peering connection and no route out of the VPC', () => {
    t.resourceCountIs('AWS::EC2::VPCPeeringConnection', 0);
    t.resourceCountIs('AWS::EC2::Route', 0);
  });
});

describe('peering, added on the second deploy pass', () => {
  test('the first Region requests the connection and routes to the second from every subnet', () => {
    const t = template('us-east-1', { vpcId: 'vpc-0000000000000000b' });
    t.hasResourceProperties('AWS::EC2::VPCPeeringConnection', { PeerVpcId: 'vpc-0000000000000000b', PeerRegion: 'us-east-2' });
    const routes = resourcesOf(t, 'AWS::EC2::Route');
    expect(routes).toHaveLength(2);
    for (const route of routes) {
      expect(route.Properties.DestinationCidrBlock).toBe('10.12.0.0/16');
      expect(route.Properties.VpcPeeringConnectionId).toEqual({ Ref: 'Peering' });
    }
    t.hasOutput('PeeringConnectionId', {});
  });

  test('the second Region only routes back over the given connection', () => {
    const t = template('us-east-2', { peeringConnectionId: 'pcx-0123456789abcdef0' });
    t.resourceCountIs('AWS::EC2::VPCPeeringConnection', 0);
    const routes = resourcesOf(t, 'AWS::EC2::Route');
    expect(routes.map((r) => [r.Properties.DestinationCidrBlock, r.Properties.VpcPeeringConnectionId]))
      .toEqual([['10.11.0.0/16', 'pcx-0123456789abcdef0'], ['10.11.0.0/16', 'pcx-0123456789abcdef0']]);
  });
});

describe('the internal ALB', () => {
  const t = template('us-east-1');

  test('is internal and drops invalid header fields', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
      LoadBalancerAttributes: Match.arrayWith([{ Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' }]),
    });
  });

  test('accepts HTTP only from the two sample VPCs, never from anywhere', () => {
    const albSg = resourcesOf(t, 'AWS::EC2::SecurityGroup').find((sg) => sg.Properties.GroupDescription.startsWith('Internal ALB'));
    expect(albSg.Properties.SecurityGroupIngress.map((r: any) => [r.CidrIp, r.FromPort, r.ToPort]))
      .toEqual([['10.11.0.0/16', 80, 80], ['10.12.0.0/16', 80, 80]]);
    expect(JSON.stringify(t.toJSON())).not.toContain('0.0.0.0/0');
  });

  test('sends the region-less name to the router and every other name to the app', () => {
    const rule = resourcesOf(t, 'AWS::ElasticLoadBalancingV2::ListenerRule');
    expect(rule).toHaveLength(1);
    expect(rule[0].Properties.Conditions).toEqual([{ Field: 'host-header', HostHeaderConfig: { Values: [NAMES.regionLess] } }]);
    const groups = t.findResources('AWS::ElasticLoadBalancingV2::TargetGroup');
    const targetOf = (ref: any) => groups[ref.Ref].Properties.Targets[0].Id['Fn::GetAtt'][0];
    expect(targetOf(rule[0].Properties.Actions[0].TargetGroupArn)).toMatch(/^Router/);
    const [listener] = resourcesOf(t, 'AWS::ElasticLoadBalancingV2::Listener');
    expect(targetOf(listener.Properties.DefaultActions[0].TargetGroupArn)).toMatch(/^App/);
  });
});

describe('the functions', () => {
  const t = template('us-east-1');
  const fn = (name: string) => resourcesOf(t, 'AWS::Lambda::Function').find((f) => f.Properties.FunctionName === name);

  test('the router and app get the table name and the home Region names; the probe its VPC CIDR', () => {
    for (const name of ['regional-affinity-router', 'regional-affinity-app']) {
      expect(fn(name).Properties.Environment.Variables).toEqual({ TABLE, REGIONAL_NAMES: JSON.stringify(NAMES.regional) });
      expect(fn(name).Properties.VpcConfig).toBeUndefined(); // the ALB invokes them directly
    }
    expect(fn('regional-affinity-probe').Properties.Environment.Variables).toEqual({ VPC_CIDR: '10.11.0.0/16' });
    expect(fn('regional-affinity-probe').Properties.VpcConfig).toBeDefined();
  });

  test.each([
    ['Router', ['dynamodb:GetItem']],
    ['App', ['dynamodb:GetItem', 'dynamodb:PutItem']],
  ])('the %s role reaches only this Region\'s replica, with only %p', (id, actions) => {
    const policies = Object.entries(t.findResources('AWS::IAM::Policy')).filter(([k]) => k.startsWith(`${id}Role`));
    expect(policies).toHaveLength(1);
    const [statement] = (policies[0][1] as any).Properties.PolicyDocument.Statement;
    expect([statement.Action].flat()).toEqual(actions);
    expect(JSON.stringify(statement.Resource)).toContain(':dynamodb:us-east-1:');
    expect(JSON.stringify(statement.Resource)).toContain(`:table/${TABLE}`);
  });

  test('the probe may reach only the VPC resolver and the two ALBs', () => {
    const sg = resourcesOf(t, 'AWS::EC2::SecurityGroup').find((g) => g.Properties.GroupDescription.startsWith('Probe'));
    expect(sg.Properties.SecurityGroupEgress.map((r: any) => [r.IpProtocol, r.CidrIp, r.FromPort])).toEqual([
      ['udp', '10.11.0.0/16', 53], ['tcp', '10.11.0.0/16', 53], ['tcp', '10.11.0.0/16', 80], ['tcp', '10.12.0.0/16', 80]]);
    expect(sg.Properties.SecurityGroupIngress).toBeUndefined();
  });

  test('every function has a log group the stack deletes', () => {
    const logs = t.findResources('AWS::Logs::LogGroup');
    expect(Object.values(logs).map((l: any) => l.Properties.LogGroupName).sort())
      .toEqual(['/aws/lambda/regional-affinity-app', '/aws/lambda/regional-affinity-probe', '/aws/lambda/regional-affinity-router']);
    for (const log of Object.values(logs) as any[]) {
      expect(log.DeletionPolicy).toBe('Delete');
      expect(log.Properties.RetentionInDays).toBe(7);
    }
  });

  test('the outputs the Makefile and scripts/demo.py read are there', () => {
    for (const key of ['VpcId', 'VpcCidr', 'AlbDnsName', 'AlbHostedZoneId', 'ProbeFunctionName']) t.hasOutput(key, {});
  });
});
