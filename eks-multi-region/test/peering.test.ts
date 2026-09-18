/**
 * Peering configurator IAM -- least privilege for a cross-region custom resource.
 *
 * The Lambda used to hold one statement, eight EC2 actions on `*`, on the theory that the
 * peer VPCs and route tables "live in other regions and their ARNs are unknown at synth".
 * They are not unknown: every peer's region and VPC id reach the stack as CfnParameters,
 * which is enough to build the ARNs at deploy time. These tests pin the scoped shape (the
 * one the VPC peering IAM guide documents) so a convenience `*` cannot creep back, and pin
 * the ABSENCE of the two actions the Lambda never calls (DeleteRoute, DescribeRouteTables).
 *
 * Synthesizes only the PeeringStack: it is tiny (one Lambda, one custom resource), so this
 * file stays cheap.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { PeeringStack } from '../src/cdk/lib/peering-stack';
import { PEERING_SUFFIX, PRIMARY_REGION, REGIONS } from '../src/cdk/regions';
import { makeSynthesizer } from '../src/cdk/synthesizer';

const APP_ID = 'eks-mr-demo';

const peeringTemplate = (): Template => {
  const app = new cdk.App({ analyticsReporting: false });
  const name = `${APP_ID}-${PEERING_SUFFIX}`;
  return Template.fromStack(
    new PeeringStack(app, name, {
      stackName: name,
      synthesizer: makeSynthesizer(),
      env: { region: PRIMARY_REGION },
      appId: APP_ID,
    }),
  );
};

/** Every statement of every inline policy in the template. */
const statements = (t: Template): any[] => {
  const out: any[] = [];
  for (const p of Object.values(t.findResources('AWS::IAM::Policy')) as any[]) {
    out.push(...p.Properties.PolicyDocument.Statement);
  }
  return out;
};

const actionsOf = (s: any): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const withAction = (t: Template, action: string): any[] =>
  statements(t).filter((s) => actionsOf(s).includes(action));
const asList = (v: any): any[] => (Array.isArray(v) ? v : [v]);

describe('peering configurator IAM is scoped to the mesh', () => {
  const t = peeringTemplate();

  it('grants exactly the actions the Lambda calls -- no DeleteRoute, no DescribeRouteTables', () => {
    const granted = new Set(statements(t).flatMap(actionsOf).filter((a) => a.startsWith('ec2:')));
    expect([...granted].sort()).toEqual([
      'ec2:AcceptVpcPeeringConnection',
      'ec2:CreateRoute',
      'ec2:CreateTags',
      'ec2:CreateVpcPeeringConnection',
      'ec2:DeleteVpcPeeringConnection',
      'ec2:DescribeVpcPeeringConnections',
    ]);
  });

  it('puts ONLY the Describe action on a wildcard resource', () => {
    for (const s of statements(t)) {
      const wildcard = asList(s.Resource).includes('*');
      if (!wildcard) continue;
      expect(actionsOf(s)).toEqual(['ec2:DescribeVpcPeeringConnections']);
    }
    // ...and it is there (Describe* has no resource-level support, so `*` is the only form).
    expect(withAction(t, 'ec2:DescribeVpcPeeringConnections')).toHaveLength(1);
  });

  it('binds route writes to route tables OF the mesh VPCs (ec2:Vpc condition, one ARN per peer)', () => {
    const [s] = withAction(t, 'ec2:CreateRoute');
    expect(s).toBeDefined();
    const resources = asList(s.Resource).map((r: any) => JSON.stringify(r));
    expect(resources).toHaveLength(REGIONS.length);
    for (const r of resources) expect(r).toContain(':route-table/*');
    const vpcs = asList(s.Condition?.StringEquals?.['ec2:Vpc']).map((v: any) => JSON.stringify(v));
    expect(vpcs).toHaveLength(REGIONS.length);
    for (const v of vpcs) expect(v).toContain(':vpc/');
  });

  it('binds peering-connection actions to BOTH ends being mesh VPCs', () => {
    const pcx = withAction(t, 'ec2:DeleteVpcPeeringConnection');
    expect(pcx).toHaveLength(1);
    const [s] = pcx;
    expect(actionsOf(s).sort()).toEqual([
      'ec2:AcceptVpcPeeringConnection',
      'ec2:CreateVpcPeeringConnection',
      'ec2:DeleteVpcPeeringConnection',
    ]);
    const resources = asList(s.Resource).map((r: any) => JSON.stringify(r));
    expect(resources).toHaveLength(REGIONS.length);
    for (const r of resources) expect(r).toContain(':vpc-peering-connection/*');
    for (const key of ['ec2:AccepterVpc', 'ec2:RequesterVpc']) {
      const vpcs = asList(s.Condition?.ArnEquals?.[key]).map((v: any) => JSON.stringify(v));
      expect(vpcs).toHaveLength(REGIONS.length);
      for (const v of vpcs) expect(v).toContain(':vpc/');
    }
  });

  it('names the mesh VPCs as the vpc resource of Create (requester) and Accept (accepter)', () => {
    const onVpcs = statements(t).filter((s) =>
      asList(s.Resource).some((r: any) => JSON.stringify(r).includes(':vpc/'))
      && actionsOf(s).includes('ec2:CreateVpcPeeringConnection'),
    );
    expect(onVpcs).toHaveLength(1);
    expect(actionsOf(onVpcs[0]).sort()).toEqual([
      'ec2:AcceptVpcPeeringConnection',
      'ec2:CreateVpcPeeringConnection',
    ]);
    expect(onVpcs[0].Condition).toBeUndefined();
  });

  it('lets the Lambda tag peering connections and nothing else', () => {
    const [s] = withAction(t, 'ec2:CreateTags');
    expect(actionsOf(s)).toEqual(['ec2:CreateTags']);
    for (const r of asList(s.Resource)) expect(JSON.stringify(r)).toContain(':vpc-peering-connection/*');
  });
});
