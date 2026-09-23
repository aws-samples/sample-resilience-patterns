import * as fs from 'fs';
import * as path from 'path';

/**
 * The GitHub Actions e2e runs the Makefile, cleanup.sh, scripts/*.sh and the DRS service-role
 * helper under one OIDC role (docs/iam/github-actions-role-policy.json). This test derives
 * every AWS call those surfaces make and asserts the policy grants the matching IAM action by
 * name. A call added to a script without a grant fails here, not as an AccessDenied an hour
 * into a live run. A wildcard action fails here too.
 */
const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RUNNER_SHELL = [
  'Makefile',
  'cleanup.sh',
  'scripts/app-code.sh',
  'scripts/drs-setup.sh',
  'scripts/rehearse-cycle.sh',
  'scripts/rehearse-switchover.sh',
  'scripts/status.sh',
];
// scripts/tunnel.sh is operator-only (ssm start-session); the workflow never runs it.
const NOT_RUN_BY_CI = ['scripts/tunnel.sh'];
const HELPER = 'scripts/create-drs-service-roles.py';
const POLICY = 'docs/iam/github-actions-role-policy.json';
const TRUST = 'docs/iam/github-actions-role-trust.json';

const SERVICE_PREFIX: Record<string, string> = { elbv2: 'elasticloadbalancing', s3api: 's3' };

/** CLI operations whose IAM action is not the PascalCase of the operation name. */
const SPECIAL: Record<string, string[]> = {
  'cloudformation wait stack-delete-complete': ['cloudformation:DescribeStacks'],
  // both `s3 cp` calls in the runner upload a local file (scripts/app-code.sh)
  's3 cp': ['s3:PutObject'],
  's3 rm': ['s3:ListBucket', 's3:DeleteObject'],
  's3 rb': ['s3:DeleteBucket'],
  's3api head-bucket': ['s3:ListBucket'],
  's3api put-public-access-block': ['s3:PutBucketPublicAccessBlock'],
  // the new template version names an instance profile: EC2 evaluates iam:PassRole on its role
  'ec2 create-launch-template-version': ['ec2:CreateLaunchTemplateVersion', 'iam:PassRole'],
};

const pascal = (kebab: string) => kebab.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');

function actionsFor(service: string, op: string, waiter?: string): string[] {
  const key = waiter ? `${service} ${op} ${waiter}` : `${service} ${op}`;
  if (SPECIAL[key]) return SPECIAL[key];
  return [`${SERVICE_PREFIX[service] ?? service}:${pascal(op)}`];
}

/**
 * Every `aws <service> <operation>` (or `$(AWS) ...` in the Makefile) in the runner's shell
 * surfaces, keyed by "service operation [waiter]", with file:line citations. Lines that pass a
 * shell string to SSM (`commands=` / `"commands":`) run on the EC2 instance under its own
 * profile; the `aws ...` inside them is not a runner call and is skipped, while the
 * `aws ssm send-command` on the same line is kept.
 */
function runnerCliCalls(): Map<string, string[]> {
  const calls = new Map<string, string[]>();
  const re = /(?:\baws|\$\(AWS\))\s+(?:--[\w-]+(?:\s+\S+)?\s+)*([a-z0-9-]+)\s+([a-z0-9-]+)(?:\s+([a-z0-9-]+))?/g;
  for (const file of RUNNER_SHELL) {
    read(file).split('\n').forEach((line, i) => {
      const payload = /commands=|"commands":/.test(line);
      for (const m of line.matchAll(re)) {
        const [, service, op, third] = m;
        if (!/^[a-z0-9-]+$/.test(service) || service === 'configure') continue;
        if (payload && service === 's3') continue; // instance-side download inside the SSM payload
        const key = op === 'wait' && third ? `${service} ${op} ${third}` : `${service} ${op}`;
        calls.set(key, [...(calls.get(key) ?? []), `${file}:${i + 1}`]);
      }
    });
  }
  return calls;
}

/** boto3 calls in the helper: iam.create_role( -> iam:CreateRole, session.client("sts").get_caller_identity() -> sts:GetCallerIdentity */
function helperSdkCalls(): Map<string, string[]> {
  const calls = new Map<string, string[]>();
  read(HELPER).split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/(?:\b(iam|sts)|client\("(iam|sts)"\))\.([a-z_]+)\(/g)) {
      const action = `${m[1] ?? m[2]}:${pascal(m[3])}`;
      calls.set(action, [...(calls.get(action) ?? []), `${HELPER}:${i + 1}`]);
    }
  });
  return calls;
}

type Statement = { Sid: string; Effect: string; Action: string | string[]; Resource: string | string[]; Condition?: Record<string, Record<string, string | string[]>> };
const policy = JSON.parse(read(POLICY)) as { Version: string; Statement: Statement[] };
const granted = new Set(policy.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => [s.Action].flat()));
const resourcesOf = (sid: string) => [policy.Statement.find((s) => s.Sid === sid)!.Resource].flat();

describe('github-actions-drs-ec2 policy covers every call the e2e runner makes', () => {
  const cli = runnerCliCalls();
  const sdk = helperSdkCalls();

  test('the runner surfaces are the ones the workflow runs, and the extraction finds a real set', () => {
    const wf = fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 'drs-ec2-e2e.yml'), 'utf8');
    for (const step of ['./cleanup.sh', 'make deploy', 'make status', 'make rehearse-cycle LEGS=2']) expect(wf).toContain(step);
    expect(read('scripts/drs-setup.sh')).toMatch(/create-drs-service-roles\.py/);
    for (const f of NOT_RUN_BY_CI) expect(wf).not.toContain(path.basename(f));
    expect(cli.size).toBeGreaterThanOrEqual(45);
    expect([...sdk.keys()].sort()).toEqual(['iam:AddRoleToInstanceProfile', 'iam:AttachRolePolicy', 'iam:CreateInstanceProfile', 'iam:CreateRole', 'iam:GetInstanceProfile', 'sts:GetCallerIdentity']);
  });

  /**
   * `drs initialize-service` makes IAM calls under the CALLER's identity (forwarded access
   * session, userIdentity.invokedBy=drs.amazonaws.com), so the runner must hold them even though
   * no script spells them out. CloudTrail, account e2e: fresh account 2026-09-16 13:31Z ->
   * CreateServiceLinkedRole, GetInstanceProfile x4, CreateInstanceProfile x4 (path "/"),
   * AddRoleToInstanceProfile x4; every later initialize-service (14:15Z, 15:00Z, 16:19Z, 18:35Z,
   * account already initialized) -> CreateServiceLinkedRole (InvalidInputException = exists) and
   * GetInstanceProfile x4 on every call. A code-derived set cannot see these.
   */
  const SERVICE_FORWARDED = ['iam:CreateServiceLinkedRole', 'iam:GetInstanceProfile', 'iam:CreateInstanceProfile', 'iam:AddRoleToInstanceProfile'];
  for (const action of SERVICE_FORWARDED) {
    test(`grants ${action}, which drs initialize-service issues under the runner's identity`, () => {
      expect({ action, granted: granted.has(action) }).toEqual({ action, granted: true });
    });
  }

  for (const [key, where] of [...runnerCliCalls().entries()].sort()) {
    const [service, op, waiter] = key.split(' ');
    for (const action of actionsFor(service, op, waiter)) {
      test(`grants ${action} for \`${key}\` (${where[0]})`, () => {
        expect({ call: key, action, granted: granted.has(action), where }).toEqual({ call: key, action, granted: true, where });
      });
    }
  }

  for (const [action, where] of [...helperSdkCalls().entries()].sort()) {
    test(`grants ${action} for the DRS service-role helper (${where[0]})`, () => {
      expect({ action, granted: granted.has(action), where }).toEqual({ action, granted: true, where });
    });
  }

  test('no wildcard actions, no admin, and every Allow names its resources', () => {
    for (const a of granted) {
      expect(a).not.toBe('*');
      expect(a).not.toMatch(/:\*$/);
      expect(a).toMatch(/^[a-z0-9-]+:[A-Z][A-Za-z0-9]+$/);
    }
    for (const s of policy.Statement) expect([s.Resource].flat().length).toBeGreaterThan(0);
  });

  test('cdk deploy runs without --role-arn, so the runner assumes the CDK bootstrap roles in all three Regions', () => {
    const mk = read('Makefile');
    expect(mk).toMatch(/^CDK\s+:=\s+npx cdk /m);
    expect(mk).not.toMatch(/--role-arn/);
    for (const f of RUNNER_SHELL) expect(read(f)).not.toMatch(/--role-arn/);
    const regions = ['PRIMARY_REGION', 'SECONDARY_REGION', 'OBSERVER_REGION'].map((v) => mk.match(new RegExp(`^${v}\\s*\\?=\\s*(\\S+)`, 'm'))![1]);
    expect(regions.sort()).toEqual(['us-east-1', 'us-east-2', 'us-west-2']);
    const assume = resourcesOf('CdkBootstrapRoles');
    for (const r of regions) {
      for (const kind of ['deploy', 'file-publishing', 'image-publishing', 'lookup']) {
        expect(assume).toContain(`arn:aws:iam::ACCOUNT_ID:role/cdk-hnb659fds-${kind}-role-ACCOUNT_ID-${r}`);
      }
    }
    const stmt = policy.Statement.find((s) => s.Sid === 'CdkBootstrapRoles')!;
    expect([stmt.Action].flat()).toEqual(['sts:AssumeRole']);
  });

  test('the DRS service-role helper is fenced to the six role names and the six AWS managed policies it attaches', () => {
    const helper = read(HELPER);
    const roles = [...helper.matchAll(/\("(AWSElasticDisasterRecovery\w+Role)", "(drs|ec2)"/g)].map((m) => m[1]);
    expect(roles).toHaveLength(6);
    const roleArns = roles.map((r) => `arn:aws:iam::ACCOUNT_ID:role/service-role/${r}`).sort();
    expect([...resourcesOf('CreateOnlyTheDrsServiceRoles')].sort()).toEqual(roleArns);
    expect([...resourcesOf('AttachOnlyTheDrsManagedPolicies')].sort()).toEqual(roleArns);
    const attach = policy.Statement.find((s) => s.Sid === 'AttachOnlyTheDrsManagedPolicies')!;
    const allowedPolicies = new Set([attach.Condition!.ArnEquals['iam:PolicyARN']].flat());
    const mp = helper.match(/^MP = "([^"]+)"/m)![1];
    const ssm = helper.match(/^SSM = "([^"]+)"/m)![1];
    const attached = new Set<string>([ssm]);
    for (const m of helper.matchAll(/MP \+ "(\w+)"/g)) attached.add(mp + m[1]);
    expect([...allowedPolicies].sort()).toEqual([...attached].sort());
    // only the four EC2-trust roles get instance profiles. DRS creates these profiles itself at
    // path "/" (CloudTrail 2026-09-16 13:31Z, invokedBy drs.amazonaws.com); the helper creates
    // them at "/service-role/". IAM evaluates the EXISTING profile's ARN, so both forms are named.
    const profiled = [...helper.matchAll(/\("(AWSElasticDisasterRecovery\w+Role)", "ec2"/g)].map((m) => m[1]);
    expect(profiled).toHaveLength(4);
    const profileArns = profiled.flatMap((p) => [
      `arn:aws:iam::ACCOUNT_ID:instance-profile/${p}`,
      `arn:aws:iam::ACCOUNT_ID:instance-profile/service-role/${p}`,
    ]).sort();
    expect([...resourcesOf('CreateOnlyTheDrsInstanceProfiles')].sort()).toEqual(profileArns);
    const profileStmt = policy.Statement.find((s) => s.Sid === 'CreateOnlyTheDrsInstanceProfiles')!;
    expect([profileStmt.Action].flat().sort()).toEqual(['iam:AddRoleToInstanceProfile', 'iam:CreateInstanceProfile', 'iam:GetInstanceProfile']);
    // the service-linked role initialize-service creates: one name, one service
    const slr = policy.Statement.find((s) => s.Sid === 'DrsServiceLinkedRoleOnInitialize')!;
    expect([slr.Action].flat()).toEqual(['iam:CreateServiceLinkedRole']);
    expect([slr.Resource].flat()).toEqual(['arn:aws:iam::ACCOUNT_ID:role/aws-service-role/drs.amazonaws.com/AWSServiceRoleForElasticDisasterRecovery']);
    expect(slr.Condition).toEqual({ StringEquals: { 'iam:AWSServiceName': 'drs.amazonaws.com' } });
  });

  test('iam:PassRole: the app instance role to EC2, and the four DRS EC2-trust roles into their instance profiles (also EC2)', () => {
    const pass = policy.Statement.filter((s) => [s.Action].flat().includes('iam:PassRole'));
    expect(pass).toHaveLength(2);
    for (const s of pass) {
      expect([s.Action].flat()).toEqual(['iam:PassRole']);
      // AddRoleToInstanceProfile requires PassRole on the role and passes it to EC2 (the instance
      // profile's service): IAM docs, iam:AssociatedResourceArn / API_AddRoleToInstanceProfile.
      expect(s.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } });
    }
    const app = pass.find((s) => s.Sid === 'PassOnlyTheAppRoleToEc2')!;
    expect([app.Resource].flat()).toEqual(['arn:aws:iam::ACCOUNT_ID:role/drsdemo-app-instance-role']);
    expect(read('lib/iam-stack.ts')).toContain("roleName: `${project}-app-instance-role`");
    const drs = pass.find((s) => s.Sid === 'PassOnlyTheDrsEc2RolesIntoTheirInstanceProfiles')!;
    const helper = read(HELPER);
    const ec2Roles = [...helper.matchAll(/\("(AWSElasticDisasterRecovery\w+Role)", "ec2"/g)].map((m) => `arn:aws:iam::ACCOUNT_ID:role/service-role/${m[1]}`).sort();
    expect([drs.Resource].flat().sort()).toEqual(ec2Roles);
  });

  test('the runner holds none of the DRS launch or reverse-replication authority; the plan steps do', () => {
    for (const a of ['drs:StartRecovery', 'drs:ReverseReplication', 'drs:StartFailbackLaunch', 'drs:CreateRecoveryInstanceForDrs']) {
      expect(granted.has(a)).toBe(false);
    }
    for (const f of RUNNER_SHELL) expect(read(f)).not.toMatch(/drs (start-recovery|reverse-replication|start-failback-launch)/);
  });

  test('the runner does not accept VPC peerings: CloudFormation accepts a same-account peering while creating it', () => {
    // CloudTrail, account e2e, every drs-ec2 deploy 2026-09-16..23: AcceptVpcPeeringConnection by the
    // requester Region's cdk cfn-exec role (invokedBy cloudformation.amazonaws.com) seconds after the
    // AWS::EC2::VPCPeeringConnection create, for the primary<->secondary and both observer peerings.
    // The former `make accept-peering` ran after that and was redundant; under the runner it was also
    // denied, because the action is evaluated against the accepter `vpc` resource as well as the
    // `vpc-peering-connection` (live, 2026-09-23 19:17Z). It is gone rather than widened.
    expect(granted.has('ec2:AcceptVpcPeeringConnection')).toBe(false);
    for (const f of RUNNER_SHELL) expect(read(f)).not.toMatch(/accept-vpc-peering-connection/);
    expect(read('lib/network-stack.ts')).toContain('new ec2.CfnVPCPeeringConnection');
    expect(read('lib/observer-stack.ts')).toContain('new ec2.CfnVPCPeeringConnection');
  });

  test('log-group deletion is fenced to the project Lambda groups in the two DRS Regions', () => {
    // cleanup.sh sweeps /aws/lambda/<project>-* after the stacks are gone: a group that outlived its
    // stack keeps the fixed name and makes the next deploy fail with "already exists" (live, 2026-09-23).
    const del = policy.Statement.filter((s) => [s.Action].flat().includes('logs:DeleteLogGroup'));
    expect(del).toHaveLength(1);
    expect([del[0].Resource].flat().sort()).toEqual([
      'arn:aws:logs:us-east-2:ACCOUNT_ID:log-group:/aws/lambda/drsdemo-*',
      'arn:aws:logs:us-west-2:ACCOUNT_ID:log-group:/aws/lambda/drsdemo-*',
    ]);
    const sweep = read('cleanup.sh');
    expect(sweep).toMatch(/--log-group-name-prefix "\/aws\/lambda\/\$\{PROJECT\}-"/);
    expect(sweep).toMatch(/\[\[ "\$lg" == "\/aws\/lambda\/\$\{PROJECT\}-"\* \]\] \|\| continue/);
    expect(read('lib/constructs/drs-region-switch-steps.ts')).toContain('removalPolicy: RemovalPolicy.DESTROY');
  });

  test('trust: GitHub OIDC for this repository only, audience sts.amazonaws.com', () => {
    const trust = JSON.parse(read(TRUST));
    expect(trust.Statement).toHaveLength(1);
    const s = trust.Statement[0];
    expect(s.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(s.Principal.Federated).toBe('arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com');
    expect(s.Condition.StringEquals['token.actions.githubusercontent.com:aud']).toBe('sts.amazonaws.com');
    expect(s.Condition.StringLike['token.actions.githubusercontent.com:sub']).toBe('repo:aws-samples/sample-resilience-patterns:*');
  });

  test('the workflow assumes the documented role name and asks for a session the README documents', () => {
    const wf = fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 'drs-ec2-e2e.yml'), 'utf8');
    expect(wf).toContain('role/github-actions-drs-ec2');
    const readme = read('docs/iam/README.md');
    expect(readme).toContain('--role-name github-actions-drs-ec2');
    const requested = Number(wf.match(/role-duration-seconds:\s*(\d+)/)![1]);
    expect(readme).toContain(`--max-session-duration ${requested}`);
  });
});
