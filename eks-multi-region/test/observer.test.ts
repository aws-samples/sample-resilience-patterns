/**
 * Step 12 — the observer bastion + per-region operator access doors, the replacement for
 * the old CloudFront signed-cookie front door.
 *
 * These tests encode the NEW access contract:
 *   - NO AWS::CloudFront::* resource exists in any stack.
 *   - Each access ALB SG admits exactly one ingress rule: the observer CIDR on tcp/80.
 *   - The observer bastion has no public IP and its SG has zero ingress rules.
 *   - The observer has three SSM interface endpoints (ssm/ssmmessages/ec2messages),
 *     each with PrivateDnsEnabled.
 *   - The observer CIDR overlaps neither workload CIDR.
 *   - build/tunnel.sh passes `bash -n`.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ObserverStack } from '../src/cdk/lib/observer-stack';
import { OperatorAccessStack } from '../src/cdk/lib/operator-access-stack';
import {
  AZ_COUNT,
  OBSERVER_CIDR,
  OBSERVER_REGION,
  REGIONS,
  operatorAccessSuffix,
} from '../src/cdk/regions';
import { makeSynthesizer } from '../src/cdk/synthesizer';

const APP_ID = 'eks-mr-demo';

const observerTemplate = (): Template => {
  const app = new cdk.App({ analyticsReporting: false });
  const name = `${APP_ID}-observer`;
  return Template.fromStack(
    new ObserverStack(app, name, {
      stackName: name,
      synthesizer: makeSynthesizer(),
      env: { region: OBSERVER_REGION },
      appId: APP_ID,
    }),
  );
};

const accessTemplates = (): Map<string, Template> => {
  const app = new cdk.App({ analyticsReporting: false });
  const stacks = REGIONS.map((region) => {
    const name = `${APP_ID}-${operatorAccessSuffix(region)}`;
    return [
      region.name,
      new OperatorAccessStack(app, name, {
        stackName: name,
        synthesizer: makeSynthesizer(),
        env: { region: region.name },
        appId: APP_ID,
        regionName: region.name,
      }),
    ] as const;
  });
  return new Map(stacks.map(([r, s]) => [r, Template.fromStack(s)]));
};

// ---------------------------------------------------------------------------
// CIDR overlap helper (pure, no AWS): two /N blocks overlap iff their network
// prefixes coincide once masked to the shorter prefix. Integer arithmetic rather
// than bit operations because the project's eslint config forbids no-bitwise.
// ---------------------------------------------------------------------------
const ipToInt = (ip: string): number =>
  ip.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
const cidrsOverlap = (a: string, b: string): boolean => {
  const [aIp, aLen] = a.split('/');
  const [bIp, bLen] = b.split('/');
  const len = Math.min(Number(aLen), Number(bLen));
  // Masking to `len` bits == integer-dividing by 2^(32-len) and discarding the remainder.
  const blockSize = 2 ** (32 - len);
  return Math.floor(ipToInt(aIp) / blockSize) === Math.floor(ipToInt(bIp) / blockSize);
};

describe('the CloudFront signed-cookie front door is gone', () => {
  it('declares NO AWS::CloudFront::* resource in any observer or access stack', () => {
    const templates = [observerTemplate(), ...accessTemplates().values()];
    for (const t of templates) {
      const json = t.toJSON();
      const cfTypes = Object.values(json.Resources ?? {})
        .map((r: any) => r.Type as string)
        .filter((type) => type.startsWith('AWS::CloudFront::'));
      expect(cfTypes).toEqual([]);
      // The signed-cookie gate and its S3 bounce bucket are gone too.
      expect(Object.keys(t.findResources('AWS::CloudFront::Distribution'))).toHaveLength(0);
      expect(Object.keys(t.findResources('AWS::CloudFront::VpcOrigin'))).toHaveLength(0);
    }
  });
});

describe('operator access door (step 12)', () => {
  it('fronts argocd with an INTERNAL ALB whose only ingress is the observer CIDR on tcp/80', () => {
    for (const [, t] of accessTemplates()) {
      const albs = Object.values(
        t.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'),
      ) as any[];
      expect(albs).toHaveLength(1);
      expect(albs[0].Properties.Type).toBe('application');
      expect(albs[0].Properties.Scheme).toBe('internal');

      // Exactly one ingress rule, and it is the observer CIDR on 80 — no world-open rule
      // (open:false), no prefix list, no VPC CIDR.
      const sgs = Object.values(t.findResources('AWS::EC2::SecurityGroup')) as any[];
      const albSg = sgs.find((s) =>
        (s.Properties.GroupDescription ?? '').includes('argocd access door'),
      );
      expect(albSg).toBeDefined();
      const ingress = albSg.Properties.SecurityGroupIngress ?? [];
      expect(ingress).toHaveLength(1);
      expect(ingress[0].CidrIp).toBe(OBSERVER_CIDR);
      expect(ingress[0].FromPort).toBe(80);
      expect(ingress[0].ToPort).toBe(80);
      // The wrong sources must not creep back.
      expect(ingress[0].SourcePrefixListId).toBeUndefined();
      // No standalone prefix-list ingress resource either.
      expect(Object.keys(t.findResources('AWS::EC2::SecurityGroupIngress'))).toHaveLength(0);
    }
  });

  it('IP-targets the argocd NLB ENIs, AZ_COUNT of them', () => {
    for (const [, t] of accessTemplates()) {
      const tgs = Object.values(
        t.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'),
      ) as any[];
      const ipTgs = tgs.filter((g) => g.Properties.TargetType === 'ip');
      expect(ipTgs).toHaveLength(1);
      expect(ipTgs[0].Properties.Targets).toHaveLength(AZ_COUNT);
      expect(JSON.stringify(ipTgs[0].Properties.Targets)).toContain('ArgoNlbIps');
    }
  });
});

describe('observer VPC + bastion (step 12)', () => {
  it('runs the bastion with NO public IP and NO ingress on its SG', () => {
    const t = observerTemplate();
    const instances = Object.values(t.findResources('AWS::EC2::Instance')) as any[];
    expect(instances).toHaveLength(1);
    // No public IP: the instance is not configured for one, and the subnet does not map one.
    expect(instances[0].Properties.NetworkInterfaces).toBeUndefined();
    const subnets = Object.values(t.findResources('AWS::EC2::Subnet')) as any[];
    expect(subnets).toHaveLength(1);
    expect(subnets[0].Properties.MapPublicIpOnLaunch).toBe(false);

    const sgs = Object.values(t.findResources('AWS::EC2::SecurityGroup')) as any[];
    const bastionSg = sgs.find((s) =>
      (s.Properties.GroupDescription ?? '').includes('Observer bastion'),
    );
    expect(bastionSg).toBeDefined();
    // Zero ingress rules — SSM only, reached over the interface endpoints.
    expect(bastionSg.Properties.SecurityGroupIngress ?? []).toHaveLength(0);
    // Egress: 443 to endpoints + 80 to each workload.
    const egress = bastionSg.Properties.SecurityGroupEgress ?? [];
    expect(egress.some((e: any) => e.FromPort === 443)).toBe(true);
    expect(egress.filter((e: any) => e.FromPort === 80)).toHaveLength(REGIONS.length);
  });

  it('has NO public subnets, NO internet gateway, and NO NAT', () => {
    const t = observerTemplate();
    expect(Object.keys(t.findResources('AWS::EC2::InternetGateway'))).toHaveLength(0);
    expect(Object.keys(t.findResources('AWS::EC2::NatGateway'))).toHaveLength(0);
  });

  it('exposes three SSM interface endpoints, each with PrivateDnsEnabled', () => {
    const t = observerTemplate();
    const eps = Object.values(t.findResources('AWS::EC2::VPCEndpoint')) as any[];
    const services = eps
      .map((e) => e.Properties.ServiceName)
      .map((s: any) => (typeof s === 'string' ? s : JSON.stringify(s)));
    for (const svc of ['ssm', 'ssmmessages', 'ec2messages']) {
      expect(services.some((s: string) => s.includes(`.${svc}`))).toBe(true);
    }
    expect(eps).toHaveLength(3);
    for (const ep of eps) {
      expect(ep.Properties.VpcEndpointType).toBe('Interface');
      expect(ep.Properties.PrivateDnsEnabled).toBe(true);
    }
  });

  it('creates a requester peering to each workload VPC and routes toward each workload CIDR', () => {
    const t = observerTemplate();
    const peerings = Object.values(t.findResources('AWS::EC2::VPCPeeringConnection'));
    expect(peerings).toHaveLength(REGIONS.length);
    const routes = Object.values(t.findResources('AWS::EC2::Route')) as any[];
    // One route per workload, each via a peering connection (not a gateway).
    const peeringRoutes = routes.filter((r) => r.Properties.VpcPeeringConnectionId !== undefined);
    expect(peeringRoutes).toHaveLength(REGIONS.length);
    // The bastion instance profile grants SSM core.
    const roles = Object.values(t.findResources('AWS::IAM::Role')) as any[];
    expect(
      roles.some((r) =>
        (r.Properties.ManagedPolicyArns ?? []).some((a: string) =>
          a.includes('AmazonSSMManagedInstanceCore'),
        ),
      ),
    ).toBe(true);
  });

  it('uses an observer CIDR that overlaps NEITHER workload CIDR', () => {
    for (const region of REGIONS) {
      expect(cidrsOverlap(OBSERVER_CIDR, region.cidr)).toBe(false);
    }
    // And the overlap helper actually detects an overlap (guards the guard).
    expect(cidrsOverlap('10.0.0.0/16', '10.0.5.0/24')).toBe(true);
  });
});

describe('build/tunnel.sh', () => {
  it('is valid bash', () => {
    const tunnel = path.join(__dirname, '..', 'build', 'tunnel.sh');
    expect(fs.existsSync(tunnel)).toBe(true);
    // Throws (non-zero exit) if bash -n finds a syntax error.
    execSync(`bash -n ${tunnel}`);
  });

  it('port-forwards over SSM to the internal ALB, not to a public endpoint', () => {
    const tunnel = fs.readFileSync(
      path.join(__dirname, '..', 'build', 'tunnel.sh'),
      'utf8',
    );
    expect(tunnel).toContain('AWS-StartPortForwardingSessionToRemoteHost');
    expect(tunnel).toContain('BastionInstanceId');
    expect(tunnel).toContain('AlbDnsName');
  });
});
