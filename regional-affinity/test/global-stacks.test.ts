import { Template } from 'aws-cdk-lib/assertions';
import { ALB, dataStack, healthChecks, NAMES, planStack, recordsStack, REGIONS, TABLE } from './fixtures';

const only = (t: Template, type: string) => {
  const found = Object.entries(t.findResources(type));
  expect(found).toHaveLength(1);
  return found[0][1] as any;
};

describe('the global table', () => {
  const table = only(Template.fromStack(dataStack()), 'AWS::DynamoDB::GlobalTable');

  test('replicates to both Regions with multi-Region eventual consistency (not MRSC)', () => {
    expect(table.Properties.TableName).toBe(TABLE);
    expect(table.Properties.MultiRegionConsistency).toBe('EVENTUAL');
    expect(table.Properties.Replicas.map((r: any) => r.Region).sort()).toEqual([...REGIONS]);
    expect(table.Properties.StreamSpecification).toEqual({ StreamViewType: 'NEW_AND_OLD_IMAGES' }); // MREC replicates through it
  });

  test('one partition per customer: customerId, then record', () => {
    expect(table.Properties.KeySchema).toEqual([
      { AttributeName: 'customerId', KeyType: 'HASH' }, { AttributeName: 'record', KeyType: 'RANGE' }]);
  });

  test('point-in-time recovery is on in both replicas, and cleanup can delete it', () => {
    for (const replica of table.Properties.Replicas) {
      expect(replica.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
      expect(replica.DeletionProtectionEnabled ?? false).toBe(false);
    }
    expect(table.DeletionPolicy).toBe('Delete');
  });
});

describe('the plan', () => {
  const t = Template.fromStack(planStack());
  const plan = only(t, 'AWS::ARCRegionSwitch::Plan');

  test('the private hosted zone answers in both VPCs', () => {
    expect(only(t, 'AWS::Route53::HostedZone').Properties).toMatchObject({
      Name: 'demo.io',
      VPCs: [{ VPCId: 'vpc-0000000000000000a', VPCRegion: 'us-east-1' }, { VPCId: 'vpc-0000000000000000b', VPCRegion: 'us-east-2' }],
    });
  });

  test('activeActive with exactly one deactivate and one activate workflow', () => {
    expect(plan.Properties.RecoveryApproach).toBe('activeActive');
    expect(plan.Properties.Regions).toEqual([...REGIONS]);
    expect(plan.Properties.Workflows.map((w: any) => w.WorkflowTargetAction)).toEqual(['deactivate', 'activate']);
  });

  test('each workflow flips all three ARC-controlled names in one parallel step', () => {
    for (const workflow of plan.Properties.Workflows) {
      expect(workflow.Steps).toHaveLength(1);
      expect(workflow.Steps[0].ExecutionBlockType).toBe('Parallel');
      const blocks = workflow.Steps[0].ExecutionBlockConfiguration.ParallelConfig.Steps;
      expect(blocks.map((b: any) => b.ExecutionBlockConfiguration.Route53HealthCheckConfig.RecordName))
        .toEqual([NAMES.regionLess, NAMES.regional['us-east-1'], NAMES.regional['us-east-2']]);
      for (const block of blocks) {
        expect(block.ExecutionBlockType).toBe('Route53HealthCheck');
        expect(block.ExecutionBlockConfiguration.Route53HealthCheckConfig.RecordSets)
          .toEqual(REGIONS.map((r) => ({ RecordSetIdentifier: r, Region: r })));
      }
    }
  });

  test('the execution role is assumed by Region switch, and exists with its policy before the plan', () => {
    const roles = t.findResources('AWS::IAM::Role');
    const [roleId, role] = Object.entries(roles)[0] as [string, any];
    expect(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal).toEqual({ Service: 'arc-region-switch.amazonaws.com' });
    expect(plan.Properties.ExecutionRole).toEqual({ 'Fn::GetAtt': [roleId, 'Arn'] });
    const policyId = Object.keys(t.findResources('AWS::IAM::Policy'))[0];
    expect(plan.DependsOn).toEqual(expect.arrayContaining([roleId, policyId]));
  });

  test('the role can only read the zone records, simulate itself and read plans', () => {
    const statements = (Object.values(t.findResources('AWS::IAM::Policy'))[0] as any).Properties.PolicyDocument.Statement;
    expect(statements.map((s: any) => [s.Sid, [s.Action].flat()])).toEqual([
      ['ReadRecords', ['route53:ListResourceRecordSets']],
      ['EvaluateOwnPolicy', ['iam:SimulatePrincipalPolicy']],
      ['ReadPlan', ['arc-region-switch:GetPlan', 'arc-region-switch:GetPlanExecution', 'arc-region-switch:ListPlanExecutions']],
    ]);
  });
});

describe('the records', () => {
  const ids = healthChecks();
  const records = (Object.values(Template.fromStack(recordsStack(ids)).findResources('AWS::Route53::RecordSetGroup')) as any[])
    .flatMap((g) => g.Properties.RecordSets);
  const byName = (name: string) => records.filter((r) => r.Name === name);

  test('every record that sends traffic to a Region carries the ARC check for that name and Region', () => {
    const bound = records.filter((r) => r.HealthCheckId);
    expect(bound).toHaveLength(6);
    for (const record of bound) {
      expect(record.HealthCheckId).toBe(ids[record.Name][record.SetIdentifier]);
    }
  });

  test('the record set identifiers are the ones the plan blocks name', () => {
    const plan = only(Template.fromStack(planStack()), 'AWS::ARCRegionSwitch::Plan');
    const blocks = plan.Properties.Workflows[0].Steps[0].ExecutionBlockConfiguration.ParallelConfig.Steps;
    for (const block of blocks) {
      const config = block.ExecutionBlockConfiguration.Route53HealthCheckConfig;
      expect(byName(config.RecordName).map((r) => r.SetIdentifier).sort())
        .toEqual(config.RecordSets.map((s: any) => s.RecordSetIdentifier).sort());
    }
  });

  test('app names alias their own ALB and carry no ARC check', () => {
    for (const region of REGIONS) {
      const [record] = byName(NAMES.app[region]);
      expect(record.AliasTarget).toEqual({ DNSName: ALB[region].dnsName, HostedZoneId: ALB[region].hostedZoneId, EvaluateTargetHealth: false });
      expect(record.HealthCheckId).toBeUndefined();
    }
  });

  test('each home Region name fails over from its own app name to the other one, never to the other regional name', () => {
    for (const [home, standby] of [['us-east-1', 'us-east-2'], ['us-east-2', 'us-east-1']] as const) {
      const pair = byName(NAMES.regional[home]);
      expect(pair.map((r) => [r.Failover, r.SetIdentifier, r.AliasTarget.DNSName])).toEqual([
        ['PRIMARY', home, NAMES.app[home]], ['SECONDARY', standby, NAMES.app[standby]]]);
    }
  });

  test('the region-less name weights 50/50 across the two home Region names', () => {
    expect(byName(NAMES.regionLess).map((r) => [r.Weight, r.SetIdentifier, r.AliasTarget.DNSName])).toEqual([
      [50, 'us-east-1', NAMES.regional['us-east-1']], [50, 'us-east-2', NAMES.regional['us-east-2']]]);
  });

  test('levels are created bottom-up, because an alias needs its target to exist', () => {
    const groups = Template.fromStack(recordsStack(ids)).findResources('AWS::Route53::RecordSetGroup');
    expect(groups.RegionalRecords.DependsOn).toEqual(['AppRecords']);
    expect(groups.RegionLessRecords.DependsOn).toEqual(['RegionalRecords']);
  });

  test('a missing or malformed health check ID stops the synth instead of deploying a bad record', () => {
    const missing = healthChecks();
    delete missing[NAMES.regional['us-east-2']]['us-east-1'];
    expect(() => recordsStack(missing)).toThrow(/no ARC health check ID for ingest.ue2.demo.io in us-east-1/);
    const malformed = healthChecks();
    malformed[NAMES.regionLess]['us-east-1'] = 'None';
    expect(() => recordsStack(malformed)).toThrow(/got "None"/);
  });
});
