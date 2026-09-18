/**
 * Status + Chaos Cockpit — PDD 2026-08-31-chaos-status-page.
 *
 * The cockpit is DOUBLY GATED: it exists only in us-west-2 AND only when enableCockpit
 * is true. These assertions stop a later step from silently arming it in the primary
 * region (the region it observes from the outside) or shipping it flag-off.
 *
 * STEP 1: the read-only status half is present. The west+enabled stack gains exactly one
 * NEW Lambda over baseline (the cockpit fn) and a /cockpit* listener rule — and NEITHER
 * appears in the primary stack or when the flag is off. It adds NO ungated CloudFront
 * behavior: an earlier revision added an ungated /health beacon for the active-region
 * pill, which reached argocd-server (this ALB's default target) instead of the app and
 * could not answer the question anyway; the pill is now derived from observed traffic.
 * The IAM role is READ-ONLY (no ssm:PutParameter,
 * no fis:*, no arc:StartPlanExecution, no iam:PassRole — those arrive in Steps 2-5).
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { OperatorAccessStack } from '../src/cdk/lib/operator-access-stack';
import { RegionStack } from '../src/cdk/lib/region-stack';
import { REGIONS } from '../src/cdk/regions';
import { makeSynthesizer } from '../src/cdk/synthesizer';

const APP_ID = 'eks-mr-demo';

const synth = (regionName: string, enableCockpit: boolean): Template => {
  const app = new cdk.App({ analyticsReporting: false });
  const name = `${APP_ID}-access-${regionName}`;
  const stack = new OperatorAccessStack(app, name, {
    stackName: name,
    synthesizer: makeSynthesizer(),
    env: { region: regionName },
    appId: APP_ID,
    regionName,
    enableCockpit,
  });
  return Template.fromStack(stack);
};

/** The raw synthesized template JSON — needed to read Parameters/Outputs by name. */
const synthRaw = (regionName: string, enableCockpit: boolean): any =>
  synth(regionName, enableCockpit).toJSON();

const PRIMARY = REGIONS[0].name; // us-east-2
const STANDBY = REGIONS[1].name; // us-west-2

const lambdaCount = (t: Template): number =>
  Object.keys(t.findResources('AWS::Lambda::Function')).length;
const ruleCount = (t: Template): number =>
  Object.keys(t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule')).length;

const BASELINE = lambdaCount(synth(STANDBY, false));

describe('cockpit gating contract', () => {
  test('flag OFF in standby: no cockpit resources (identical to pre-cockpit)', () => {
    expect(lambdaCount(synth(STANDBY, false))).toBe(BASELINE);
    expect(ruleCount(synth(STANDBY, false))).toBe(0);
  });

  test('flag ON in PRIMARY region: no cockpit resources (observer never rides the observed region)', () => {
    expect(lambdaCount(synth(PRIMARY, true))).toBe(BASELINE);
    expect(ruleCount(synth(PRIMARY, true))).toBe(0);
  });
});

describe('cockpit step 1 — read-only status (west + enabled only)', () => {
  const t = synth(STANDBY, true);

  test('adds exactly one Lambda over baseline (the cockpit fn)', () => {
    expect(lambdaCount(t)).toBe(BASELINE + 1);
  });

  test('adds a /cockpit* ALB listener rule', () => {
    expect(ruleCount(t)).toBe(1);
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: Match.arrayWith([
        Match.objectLike({ Field: 'path-pattern' }),
      ]),
    });
  });

  test('cockpit target group is a LAMBDA target type', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      TargetType: 'lambda',
    });
  });

  /**
   * checkov CKV_AWS_364. CDK's stock LambdaTarget grants elasticloadbalancing.amazonaws.com
   * with neither SourceArn nor SourceAccount, so a target group in ANY account could invoke
   * the cockpit. The permission must name the group -- and because it has to exist before
   * the group registers the function, it names the group by its FIXED name plus a wildcard
   * for the random suffix, and the group waits on it (registration runs inside its CREATE).
   */
  test('ELB invoke permission is bound to the cockpit target group and this account', () => {
    const resources = t.toJSON().Resources as Record<string, any>;
    const permissions = Object.entries(resources).filter(
      ([, r]) => r.Type === 'AWS::Lambda::Permission'
        && r.Properties.Principal === 'elasticloadbalancing.amazonaws.com',
    );
    expect(permissions).toHaveLength(1);
    const [permissionId, permission] = permissions[0];
    expect(JSON.stringify(permission.Properties.SourceArn)).toContain(':targetgroup/eks-mr-demo-cockpit/*');
    expect(permission.Properties.SourceAccount).toBeDefined();

    const groups = Object.entries(t.findResources('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Properties: { TargetType: 'lambda' },
    })) as Array<[string, any]>;
    expect(groups).toHaveLength(1);
    const [, group] = groups[0];
    expect(group.Properties.Name).toBe('eks-mr-demo-cockpit');
    expect(group.DependsOn ?? []).toContain(permissionId);
  });

  test('IAM carries the Steps 2-4 write set, each scoped (no wildcard mutations)', () => {
    const doc = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    // The read set survives.
    expect(doc).toContain('cloudwatch:GetMetricData');
    expect(doc).toContain('rds:DescribeGlobalClusters');
    expect(doc).toContain('ssm:GetParameter');
    // The three write actions.
    expect(doc).toContain('ssm:PutParameter');
    expect(doc).toContain('fis:StartExperiment');
    expect(doc).toContain('fis:StopExperiment');
    expect(doc).toContain('ec2:CreateTags');
    expect(doc).toContain('arc-region-switch:StartPlanExecution');
    expect(doc).toContain('arc-region-switch:UpdatePlanExecutionStep');
    expect(doc).toContain('iam:PassRole');
  });

  /**
   * The mutating grants are where a wildcard resource would actually matter, so each is
   * asserted individually. A blanket `Resource: "*"` on ssm:PutParameter would let the
   * cockpit rewrite any parameter in the account; on ec2:CreateTags it could tag any
   * resource; on PassRole it would be a privilege-escalation path.
   */
  describe('cockpit step 2-4 — write grants are scoped, not wildcarded', () => {
    const statements = (): any[] => {
      const out: any[] = [];
      for (const p of Object.values(t.findResources('AWS::IAM::Policy')) as any[]) {
        out.push(...p.Properties.PolicyDocument.Statement);
      }
      return out;
    };
    const withAction = (action: string): any[] =>
      statements().filter((s) => {
        const a = Array.isArray(s.Action) ? s.Action : [s.Action];
        return a.includes(action);
      });
    const resourcesOf = (action: string): string => JSON.stringify(
      withAction(action).map((s) => s.Resource));

    test('ssm:PutParameter is scoped to the two threaded knob parameter ARNs', () => {
      const stmts = withAction('ssm:PutParameter');
      expect(stmts.length).toBe(1);
      const res = resourcesOf('ssm:PutParameter');
      expect(res).not.toContain('"*"');
      // STEP 5: built from the THREADED parameter names, so there is no `-*/` wildcard
      // segment left. A name pattern would also have matched a future second parameter
      // under the same prefix.
      expect(res).toContain('"Ref":"PrimaryKnobParam"');
      expect(res).toContain('"Ref":"StandbyKnobParam"');
      expect(res).toContain(':ssm:us-east-2:');
      expect(res).toContain(':ssm:us-west-2:');
      // The code-exec adjacent SSM action must NOT be present anywhere.
      expect(JSON.stringify(statements())).not.toContain('ssm:SendCommand');
    });

    test('ec2 tagging is scoped to primary-region INSTANCES', () => {
      for (const action of ['ec2:CreateTags', 'ec2:DeleteTags']) {
        const res = resourcesOf(action);
        expect(res).not.toContain('"*"');
        expect(res).toContain(`:ec2:${PRIMARY}:`);
        expect(res).toContain(':instance/');
        // The FIS templates are primary-only, so arming standby nodes would be a write
        // that arms nothing.
        expect(res).not.toContain(`:ec2:${STANDBY}:`);
      }
    });

    test('iam:PassRole is the EXACT threaded FIS role ARN, conditioned on PassedToService', () => {
      const stmts = withAction('iam:PassRole').filter((s) => s.Effect !== 'Deny');
      expect(stmts.length).toBe(1);
      const s = stmts[0];
      expect(JSON.stringify(s.Resource)).not.toContain('"*"');
      // STEP 5: the threaded ARN, not a prefix on a CDK-generated role name. A prefix
      // wildcard was the loosest form this grant took, and PassRole is the one
      // escalation-adjacent action in the role.
      expect(s.Resource).toEqual({ Ref: 'FisRoleArn' });
      // Without the condition, the role ARN alone would still let this role hand that
      // role to any service that accepts it.
      expect(s.Condition.StringEquals['iam:PassedToService']).toBe('fis.amazonaws.com');
    });

    test('arc write actions are scoped to the EXACT threaded plan ARN', () => {
      const stmts = withAction('arc-region-switch:StartPlanExecution');
      expect(stmts.length).toBe(1);
      // STEP 5: was `:plan/*` — every plan in the account. A failover trigger scoped to
      // "any plan" is a different blast radius than one scoped to this demo's plan.
      expect(stmts[0].Resource).toEqual({ Ref: 'PlanArn' });
    });

    test('the role no longer holds cloudformation:DescribeStacks', () => {
      // Threading the ARNs removed the need for runtime discovery, and with it two-thirds
      // of the documented PassRole-via-CloudFormation escalation chain
      // (iam:PassRole + cloudformation:CreateStack + cloudformation:DescribeStacks).
      const doc = JSON.stringify(statements());
      expect(doc).not.toContain('cloudformation:DescribeStacks');
      expect(doc).not.toContain('cloudformation:CreateStack');
    });

    /**
     * FOUND LIVE, not by synth: the deploy was green and every stack complete while this
     * read was denied. `fis:ListExperiments` and `fis:ListExperimentTemplates` declare NO
     * resource type in the FIS service authorization reference, so granting them on ARNs
     * authorizes nothing — the live error was "no identity-based policy allows the
     * fis:ListExperiments action" while the action was plainly in the policy.
     */
    test('FIS List actions are granted on * — they are NOT resource-scopable', () => {
      for (const action of ['fis:ListExperiments', 'fis:ListExperimentTemplates']) {
        const stmts = withAction(action);
        expect(stmts.length).toBe(1);
        expect(stmts[0].Resource).toBe('*');
      }
    });

    test('StartExperiment carries BOTH required FIS resource types', () => {
      // The authorization reference marks experiment* AND experiment-template* as required
      // for StartExperiment; omitting either denies the call.
      const res = resourcesOf('fis:StartExperiment');
      expect(res).toContain(':experiment-template/');
      expect(res).toContain(':experiment/');
      expect(res).not.toContain('"*"');
    });

    test('no mutating action carries a bare wildcard resource', () => {
      // Reads may legitimately use `*` (many Describe/List actions are not scopable).
      // A MUTATION never may — with ONE narrow exception: services that scope by a
      // resource CONDITION KEY rather than the Resource element. arc-zonal-shift is one
      // (an ARN in Resource authorizes NOTHING there); for those, Resource:'*' is legal
      // ONLY when the statement carries a StringLike/StringEquals condition on the
      // service's ResourceIdentifier key pinned to a non-wildcard value. A '*' with no
      // such condition — or a condition whose value is itself '*' — still fails.
      const mutating = /:(Put|Create|Delete|Start|Stop|Update|Tag|Untag|Pass|Modify|Set)/;
      const conditionScoped = (s: any): boolean => {
        const cond = s.Condition || {};
        for (const op of ['StringLike', 'StringEquals']) {
          for (const [key, value] of Object.entries(cond[op] || {})) {
            if (!/:ResourceIdentifier$/.test(key)) continue;
            const values = Array.isArray(value) ? value : [value];
            if (values.length && values.every((v) => JSON.stringify(v) !== '"*"')) return true;
          }
        }
        return false;
      };
      for (const s of statements()) {
        if (s.Effect === 'Deny') continue; // denies are BROADER on purpose
        const actions = (Array.isArray(s.Action) ? s.Action : [s.Action]).filter(
          (a: string) => typeof a === 'string' && mutating.test(a));
        if (!actions.length) continue;
        if (conditionScoped(s)) continue;
        const res = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
        for (const r of res) {
          expect(typeof r === 'string' ? r : JSON.stringify(r)).not.toBe('*');
        }
      }
    });
  });

  /**
   * The boundary is the ceiling, and its ONE deliberate difference from PlanRoleBoundary
   * is the reason it exists: PassRole must survive for fis.amazonaws.com. If someone
   * "harmonized" the two policies, FIS starts would fail with an authorization error while
   * the role policy still showed a correct-looking grant.
   */
  describe('cockpit role boundary', () => {
    const boundaryDoc = (): any => {
      const policies = t.findResources('AWS::IAM::ManagedPolicy');
      const found = Object.values(policies).find((p: any) =>
        JSON.stringify(p).includes('Ceiling for the cockpit role')) as any;
      expect(found).toBeDefined();
      return found.Properties.PolicyDocument;
    };

    test('the cockpit role has a permissions boundary attached', () => {
      const roles = Object.values(t.findResources('AWS::IAM::Role')) as any[];
      const withBoundary = roles.filter((r) => r.Properties.PermissionsBoundary);
      expect(withBoundary.length).toBeGreaterThanOrEqual(1);
    });

    test('boundary denies the escalation set but NOT SimulatePrincipalPolicy', () => {
      const doc = JSON.stringify(boundaryDoc());
      expect(doc).toContain('organizations:*');
      expect(doc).toContain('account:*');
      expect(doc).toContain('iam:Put*');
      // A blanket iam:* deny would also block iam:SimulatePrincipalPolicy, which ARC plan
      // evaluation calls and which is read-only — that exact mistake parked plan
      // evaluation in actionRequired on 2026-08-26.
      const denies = boundaryDoc().Statement.filter((s: any) => s.Effect === 'Deny');
      for (const s of denies) {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        expect(actions).not.toContain('iam:*');
      }
    });

    test('boundary denies PassRole to every service EXCEPT fis.amazonaws.com', () => {
      const passRoleDenies = boundaryDoc().Statement.filter((s: any) => {
        const a = Array.isArray(s.Action) ? s.Action : [s.Action];
        return s.Effect === 'Deny' && a.includes('iam:PassRole');
      });
      expect(passRoleDenies.length).toBe(1);
      // StringNotEquals, not StringEquals: the deny must fire for everything OTHER than
      // FIS. Inverted, it would deny the one edge FIS needs and allow all others.
      expect(passRoleDenies[0].Condition.StringNotEquals['iam:PassedToService'])
        .toBe('fis.amazonaws.com');
    });
  });
});

/**
 * Active-region contract: the UI must only read fields the handler actually emits.
 *
 * This exists because the first revision shipped a UI that probed /health for the active
 * region while nothing on that path could answer it — a field the UI read and nothing
 * supplied, which renders as a confident wrong answer rather than a failure. These
 * assertions are deliberately source-level: the handler is Python and the UI is HTML, so
 * a CDK template assertion cannot see either.
 */
describe('cockpit active-region contract', () => {
  const read = (p: string): string =>
    fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const HANDLER = 'src/cdk/lib/constructs/cockpit/lambda/handler.py';
  const UI = 'src/cdk/lib/constructs/cockpit/lambda/ui.html';

  it('handler emits activeRegion, derived from per-region traffic metrics', () => {
    const h = read(HANDLER);
    expect(h).toContain('"activeRegion"');
    expect(h).toContain('def _region_traffic()');
    // The signal is observed traffic: both metrics, dimensioned by Region.
    expect(h).toContain('RegionSuccess');
    expect(h).toContain('RegionError');
    expect(h).toContain('"Name": "Region"');
  });

  it('UI reads activeRegion from the API and probes no /health path', () => {
    const ui = read(UI);
    expect(ui).toContain('s.activeRegion');
    // No client-side probe: /health through this front door reaches argocd-server.
    expect(ui).not.toContain('fetch("/health"');
    expect(ui).not.toContain("fetch('/health'");
  });

  it('handler no longer carries the retired health-probe env contract', () => {
    // cockpit.ts stopped setting HEALTH_PROBE_PATH; a stale default in the handler would
    // be a dead contract that reads as live configuration.
    expect(read(HANDLER)).not.toContain('HEALTH_PROBE_PATH');
  });
});

/**
 * Steps 2-4 behavior contract, asserted at SOURCE level because the handler is Python and
 * the UI is HTML — a CDK template assertion cannot see either, and these are exactly the
 * properties whose absence produces a demo that looks like it works.
 */
describe('cockpit steps 2-4 — write action contract', () => {
  const read = (p: string): string =>
    fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const HANDLER = read('src/cdk/lib/constructs/cockpit/lambda/handler.py');
  const UI = read('src/cdk/lib/constructs/cockpit/lambda/ui.html');

  /**
   * Strip Python docstrings and `#` comments before any ABSENCE assertion.
   *
   * Not defensive: the first version of the dry-run test below failed because
   * `_do_failover`'s docstring explains the `start_plan_execution` endpoint trap in prose,
   * and a raw toContain matched the explanation rather than a call. An absence assertion
   * over commented source is the classic green-for-the-wrong-reason shape — in the other
   * direction it would have passed while the call really was there.
   */
  const codeOnly = (src: string): string => src
    .replace(/"""[\s\S]*?"""/g, '')
    .split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');

  it('routes all three write actions plus step recovery', () => {
    for (const route of ['/cockpit/api/knob', '/cockpit/api/fis',
      '/cockpit/api/failover', '/cockpit/api/step']) {
      expect(HANDLER).toContain(route);
    }
    expect(HANDLER).toContain('def _do_knob');
    expect(HANDLER).toContain('def _do_fis');
    expect(HANDLER).toContain('def _do_failover');
    expect(HANDLER).toContain('def _do_step_recovery');
  });

  it('EVERY write path requires the typed confirmation', () => {
    // _require_confirm is the single enforcement point; each write must call it. A write
    // that skipped it would be reachable by any authenticated operator with one click.
    for (const fn of ['_do_knob', '_do_fis', '_do_failover']) {
      const body = HANDLER.split(`def ${fn}(`)[1].split('\ndef ')[0];
      expect(body).toContain('_require_confirm');
    }
  });

  it('the knob validates its range instead of trusting the client', () => {
    const body = HANDLER.split('def _do_knob(')[1].split('\ndef ')[0];
    expect(body).toContain('0 <= rate <= 100');
    expect(body).toContain('Overwrite=True'); // without it PutParameter fails on an existing knob
  });

  /**
   * The single most consequential gotcha in Step 3. FIS templates select instances by the
   * ChaosAllowed tag, so an experiment started against UNTAGGED nodes resolves zero
   * targets and reports SUCCESS having injected nothing. A cockpit that let you start
   * unarmed would show a green experiment and a flat availability line.
   */
  it('FIS start REFUSES when the fleet is not armed', () => {
    const body = HANDLER.split('def _do_fis(')[1].split('\ndef ')[0];
    expect(body).toContain('nodes are not armed');
    expect(body).toContain('armed == 0');
    expect(body).toContain('zero targets');
    // And the UI disables the affordance rather than inviting the 409.
    expect(UI).toContain('$("fisStart").disabled');
  });

  it('arming performs the SSM-registration precheck', () => {
    // Same failure family: aws:ssm:send-command faults need the SSM agent registered, and
    // these subnets have no NAT. Unregistered nodes = another silent zero-target success.
    const body = HANDLER.split('def _do_fis(')[1].split('\ndef ')[0];
    expect(body).toContain('describe_instance_information');
    expect(body).toContain('no nodes are registered with Systems Manager');
  });

  it('FIS start fans EVERY per-AZ template of ONE fault, and refuses to mix faults', () => {
    const body = HANDLER.split('def _do_fis(')[1].split('\ndef ')[0];
    // One fault key -> its own output -> loop over all of that fault's template ids.
    expect(body).toContain('for template_id in ids');
    expect(body).toContain('fault not in FAULTS');
    // Only ONE fault name is accepted per call (a string, not a list).
    expect(body).not.toContain('for fault in');
  });

  it('fault availability flags match MEASURED behavior, not assumed behavior', () => {
    // INVERTED 2026-09-01 from live measurement. At the construct default of 100ms,
    // latency genuinely could not move availability (reads 97ms -> 1,325ms, ZERO errors).
    // region-stack.ts now injects 500ms, which clears the app's 5s read timeout because
    // delay is amplified ~12.3x by the per-read database round trips -- so latency IS an
    // availability mover. BOTH stress faults were REMOVED from the menu after live runs
    // moved nothing: cpu-stress at the document maximum, then memory-stress at Percent=85
    // (16:22:44 UTC, availability flat 100.0%, read p90 flat 96ms, no eviction). The menu is
    // a promise that starting a fault can force a failover decision, so it carries only what
    // is proven. The construct still builds the templates; re-enabling is one line.
    expect(HANDLER).toMatch(/"latency":\s*\{[^}]*"availability":\s*True/);
    expect(HANDLER).toMatch(/"packet-loss":\s*\{[^}]*"availability":\s*True/);
    // NEITHER stress fault may appear on the menu -- both were live-proven inert.
    expect(HANDLER).not.toContain('cpu-stress":');
    expect(HANDLER).not.toContain('memory-stress":');
    expect(UI).toContain('movesAvailability');
    // The UI must still carry an honest not-an-availability-mover branch for any future
    // fault that cannot move it.
    expect(UI).toContain('LATENCY graph ONLY');
  });

  it('failover dry-run calls nothing and execute targets the ACTIVATED region endpoint', () => {
    const body = codeOnly(HANDLER).split('def _do_failover(')[1].split('\ndef ')[0];
    // Dry run returns before any client call.
    const beforeExecute = body.split('if not body.get("execute")')[0];
    expect(beforeExecute).not.toContain('start_plan_execution');
    expect(body).toContain('"dryRun": True');
    // The endpoint region must be the TARGET (the region being activated) — ARC runs the
    // plan from the activated region so the switch does not depend on the evacuated one.
    expect(body).toContain('_ARC_BY_REGION[target]');
    expect(body).toContain('action="activate"');
    // deactivate must not be offered: this plan has a single activate workflow and
    // StartPlanExecution would reject a deactivate with no matching workflow.
    expect(body).not.toContain('"deactivate"');
  });

  it('step recovery offers ONLY skip and switchToUngraceful — there is no retry', () => {
    const body = codeOnly(HANDLER).split('def _do_step_recovery(')[1].split('\ndef ')[0];
    expect(body).toContain('("skip", "switchToUngraceful")');
    expect(body).not.toContain('"retry"');
    // The UI must not invent a third button either.
    expect(UI).toContain('switchToUngraceful');
    expect(UI).not.toMatch(/actionToTake:\s*"retry"/);
  });

  it('every boto3 client sets explicit timeouts at module scope', () => {
    // A hanging control-plane call outlives the caller's own timeout, so the except/retry
    // path never runs and the failure reads as a hang rather than an error (docs/lessons.md
    // bug class 2). Each client must pass the shared Config.
    const clientLines = HANDLER.split('\n').filter((l) => l.includes('boto3.client('));
    expect(clientLines.length).toBeGreaterThan(5);
    for (const line of clientLines) {
      expect(line.includes('config=_CFG') || line.trim().endsWith('(')).toBe(true);
    }
    expect(HANDLER).toContain('connect_timeout=2');
  });

  it('the UI populates region selectors from the API, not hardcoded strings', () => {
    // A hardcoded region pair silently points the controls at a region that may not exist
    // after a rename — the classic "UI reads a field nothing supplies" inversion.
    expect(UI).toContain('REGIONS = [s.primaryRegion, s.standbyRegion]');
    expect(UI).not.toContain('value="us-east-2"');
  });
});

/**
 * STEP 5 — the deploy contract, DERIVED rather than restated.
 *
 * This is the test that exists because of docs/lessons.md #4: a CfnParameter declared in
 * a template but never threaded through the deploy step breaks the DEPLOY, not the build,
 * and it does so at whichever phase deploys that stack — phase 6 here, after ten other
 * stacks have already changed. The mirror case (threaded but not declared) fails the same
 * way with the opposite message.
 *
 * So the required set is read FROM THE SYNTHESIZED TEMPLATE and compared against the
 * generated projen task. Neither side is hardcoded here: adding a parameter to either place
 * alone turns this red at build time.
 */
describe('cockpit step 5 — CfnParameter deploy contract (derived both ways)', () => {
  const tasks = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'));

  // deploy-stack.sh appends these to EVERY deploy regardless of the stack, so they are
  // never named in a stackParameters map and must not be counted as missing.
  const ALWAYS_SUPPLIED = new Set(['AssetsBucketName', 'AssetsBucketPrefix']);

  const declaredParams = (regionName: string): string[] =>
    Object.keys(synthRaw(regionName, true).Parameters ?? {})
      .filter((p) => !ALWAYS_SUPPLIED.has(p));

  /** The raw STACK_PARAMETERS block the deploy task supplies to the standby front door. */
  const standbyParamBlock = (): string => {
    const steps = tasks.tasks.deploy.steps as any[];
    const step = steps.find((s) => s.exec?.includes('$PROJECT_NAME-access-us-west-2"')
      && s.exec?.includes('STACK_PARAMETERS'));
    expect(step).toBeDefined();
    return step.exec.split('STACK_PARAMETERS="')[1].split('"')[0];
  };

  /** The STACK_PARAMETERS names the generated deploy task supplies for a stack. */
  const threadedParams = (stackSuffix: string): string[] => {
    const steps = tasks.tasks.deploy.steps as any[];
    const step = steps.find((s) => s.exec?.includes(`$PROJECT_NAME-${stackSuffix}"`)
      && s.exec?.includes('STACK_PARAMETERS'));
    expect(step).toBeDefined();
    const block = step.exec.split('STACK_PARAMETERS="')[1].split('"')[0];
    return block.split('\n').map((l: string) => l.split('=')[0]).filter(Boolean);
  };

  test('STANDBY front door: declared parameters === threaded parameters', () => {
    const declared = declaredParams(STANDBY).sort();
    const threaded = threadedParams('access-us-west-2').sort();
    // Compared as sets in BOTH directions, so neither an unthreaded declaration nor an
    // undeclared thread can pass.
    expect(threaded).toEqual(declared);
    // Sanity: the step-5 additions really are in there (a test comparing two empty lists
    // would also "pass").
    expect(declared).toContain('PlanArn');
    expect(declared).toContain('FisRoleArn');
    // DERIVED from the source, not a hardcoded count. This was a literal >= 13 and went red
    // the moment memory-stress left the fault menu -- a test failing because the code
    // legitimately shrank is a maintenance tax, not a signal. Asserting that every
    // cockpitParam NAME is declared is stronger anyway: it survives adds and removals, and
    // it cannot pass against two empty lists (the reason the floor existed at all).
    const cockpitNames = [
      ...fs.readFileSync(
        path.join(__dirname, '..', 'src', 'cdk', 'lib', 'operator-access-stack.ts'), 'utf8',
      ).matchAll(/cockpitParam\('(\w+)'/g),
    ].map((m) => m[1]);
    expect(cockpitNames.length).toBeGreaterThan(5);
    for (const name of cockpitNames) expect(declared).toContain(name);
    // ...and no stale stress-fault parameter may survive the menu removal.
    expect(declared).not.toContain('FisCpuStressTemplateIds');
    expect(declared).not.toContain('FisMemoryStressTemplateIds');
  });

  test('PRIMARY front door: declared === threaded, and carries NO cockpit parameters', () => {
    const declared = declaredParams(PRIMARY).sort();
    expect(threadedParams('access-us-east-2').sort()).toEqual(declared);
    // The cockpit is standby-only, so its parameters must not appear here — if they were
    // hoisted out of the region guard, this template would declare parameters the deploy
    // step supplies nothing for.
    for (const p of ['PlanArn', 'FisRoleArn', 'PrimaryKnobParam', 'PrimaryNodeGroupName']) {
      expect(declared).not.toContain(p);
    }
  });

  test('every threaded value reads a dotenv key the rail actually exports', () => {
    // A parameter threaded from a MISSPELLED env key expands to the empty string, and
    // CloudFormation accepts an empty parameter value — so the deploy succeeds and the
    // cockpit silently addresses nothing. Each referenced key must correspond to a real
    // CfnOutput on the stack it comes from, spelled as deploy-stack.sh spells it:
    // <PREFIX>_<OUTPUTKEY.toUpperCase()>.
    //
    // The outputs come from the PRIMARY REGION STACK — not the primary front door. Reading
    // the wrong stack's outputs here made this test fail on its first run, which is the
    // same class of mistake it exists to catch one layer out.
    const app = new cdk.App({ analyticsReporting: false });
    const regionStack = new RegionStack(app, `${APP_ID}-region-${PRIMARY}`, {
      stackName: `${APP_ID}-region-${PRIMARY}`,
      synthesizer: makeSynthesizer(),
      env: { region: PRIMARY },
      appId: APP_ID,
      regionName: PRIMARY,
      defaultVpcCidr: REGIONS[0].cidr,
      withPrimaryDatabase: true,
      replicateSecretToRegion: STANDBY,
    });
    const regionOutputs = Object.keys(
      Template.fromStack(regionStack).toJSON().Outputs ?? {}).map((k) => k.toUpperCase());

    const block = standbyParamBlock();
    const refs = block.split('\n')
      .map((l: string) => l.split('=').slice(1).join('='))
      .filter((v: string) => v.startsWith('$REGION_0_'))
      .map((v: string) => v.replace('$REGION_0_', ''));
    expect(refs.length).toBeGreaterThanOrEqual(5); // the FIS + cluster + knob set
    for (const key of refs) {
      expect(regionOutputs).toContain(key);
    }
  });

  test('the standby front door sources the dotenvs those keys come from', () => {
    const steps = tasks.tasks.deploy.steps as any[];
    const step = steps.find((s) => s.exec?.includes('$PROJECT_NAME-access-us-west-2"')
      && s.exec?.includes('STACK_PARAMETERS'));
    // $REGION_0_* comes from the PRIMARY region stack's dotenv and $FAILOVER_* from the
    // failover stack's. Threading a key whose dotenv is never sourced expands to empty.
    expect(step.exec).toContain('$PROJECT_NAME-region-us-east-2.env');
    expect(step.exec).toContain('$PROJECT_NAME-failover.env');
  });

  /**
   * The chain is deploy step -> CfnParameter -> Lambda env -> os.environ[...]. Every link so
   * far has been checked; this is the LAST one, and it is the link that has broken most often
   * in this project — a change validated at the artifact it touched, then broken one consumer
   * further out (CDK once declared 0 of 5 required Lambda env vars while every stack was
   * green).
   *
   * The handler uses os.environ[KEY] (not .get) for its required configuration precisely so
   * a missing value raises at import. This asserts the construct actually sets every such
   * key, so that import error can never happen in the first place.
   */
  test('every env var the handler REQUIRES is set by the construct', () => {
    const handler = fs.readFileSync(path.join(
      __dirname, '..', 'src/cdk/lib/constructs/cockpit/lambda/handler.py'), 'utf8');
    const construct = fs.readFileSync(path.join(
      __dirname, '..', 'src/cdk/lib/constructs/cockpit/cockpit.ts'), 'utf8');

    // os.environ["X"] — the hard-required form. os.environ.get(...) is excluded on purpose:
    // those have defaults and degrade rather than raise.
    const required = [...handler.matchAll(/os\.environ\["([A-Z0-9_]+)"\]/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThanOrEqual(6);

    const supplied = new Set(
      [...construct.matchAll(/^\s{8}([A-Z0-9_]+):\s/gm)].map((m) => m[1]));
    for (const key of new Set(required)) {
      expect([...supplied]).toContain(key);
    }
  });

  /**
   * FOUND LIVE. `AWS::EKS::Nodegroup`'s Ref is `<cluster>/<nodegroup>`, and the EKS API
   * rejects that as a nodegroup name ("contains invalid characters ... ^[0-9A-Za-z]..."),
   * so threading the Ref deployed green and broke FIS arming at runtime. Pinned at BOTH
   * ends: the region stack must emit a bare name, and the handler must normalize anyway
   * because the value crosses a stack boundary.
   */
  test('the region stack emits a BARE node group name (no cluster prefix)', () => {
    const region = fs.readFileSync(path.join(
      __dirname, '..', 'src/cdk/lib/region-stack.ts'), 'utf8');
    const block = region.split("new cdk.CfnOutput(this, 'NodeGroupName'")[1].split('});')[0];
    // Must split the Ref, not pass it through.
    expect(block).toContain("cdk.Fn.split('/', nodeGroup.ref)");
    expect(block).not.toMatch(/value:\s*nodeGroup\.ref\s*,/);
  });

  test('the handler normalizes the node group name defensively', () => {
    const handler = fs.readFileSync(path.join(
      __dirname, '..', 'src/cdk/lib/constructs/cockpit/lambda/handler.py'), 'utf8');
    expect(handler).toContain('os.environ["PRIMARY_NODE_GROUP_NAME"].rsplit("/", 1)[-1]');
  });
});

/**
 * The replicas tile (Step 5's deferred capability, built as an IN-CLUSTER REPORTER).
 *
 * The design's original mechanism — view access entries — grants authorization to a
 * Kubernetes API endpoint this no-VPC Lambda has NO NETWORK PATH to (private endpoint).
 * The reporter CronJob publishes the counts as CloudWatch metrics from inside each
 * cluster instead; these tests pin the handler's consumption of them.
 */
describe('cockpit replicas tile — reporter metric read', () => {
  const read = (p: string): string =>
    fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const HANDLER = read('src/cdk/lib/constructs/cockpit/lambda/handler.py');
  const UI = read('src/cdk/lib/constructs/cockpit/lambda/ui.html');
  const codeOnly = (src: string): string => src
    .replace(/"""[\s\S]*?"""/g, '')
    .split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');

  it('the deferred-stub is gone: replicas is a real read, not hardcoded unavailable', () => {
    const code = codeOnly(HANDLER);
    expect(code).not.toContain('"available": False, "note": "EKS view access entry pending');
    expect(code).toContain('def _replicas()');
    expect(code).toContain('DesiredReplicas');
    expect(code).toContain('ReadyReplicas');
  });

  it('reads BOTH regions through per-region CloudWatch clients', () => {
    const code = codeOnly(HANDLER);
    // Each reporter publishes to its OWN region's CloudWatch (a regional VPC interface
    // endpoint serves only its own region) — a primary-only read would show the standby
    // as dataless forever, which during a failover is precisely the region that matters.
    expect(code).toMatch(/_CW\s*=\s*\{PRIMARY_REGION:\s*_cw,\s*STANDBY_REGION:\s*_cw_standby\}/);
    expect(code).toContain('for region, client in _CW.items()');
  });

  it('one dead region degrades to a note instead of killing the tile', () => {
    const body = codeOnly(HANDLER).split('def _replicas(')[1].split('\ndef ')[0];
    // The per-region try/except is the whole point: mid-failover, one region's read
    // failing is EXPECTED, and the tile must keep showing the other region.
    expect(body).toContain('except Exception');
    expect(body).toContain('read failed');
  });

  it('the UI renders per-region ready/desired and isolates a dataless region', () => {
    expect(UI).toContain('rep.regions');
    expect(UI).not.toContain('JSON.stringify(rep)'); // raw-JSON placeholder rendering is gone
    expect(UI).toContain('v.note');
  });
});

/**
 * THE ALB IS THE HANDLER'S STRICT CONSUMER. Its Lambda-target contract requires
 * `statusDescription` to be "<code> <reason-phrase>". A bare "400" is a MALFORMED
 * response: the ALB discards it and serves its own 502 HTML page — so every non-200
 * the handler produced reached the browser as "Unexpected token '<' ... is not valid
 * JSON", destroying the actual error message. Found live 2026-09-01 (arm click):
 * Lambda logged clean 1.7ms invocations while the client saw awselb/2.0 502 HTML.
 *
 * Functional, not textual: runs the real _resp in a real python for EVERY status code
 * the handler uses (derived from the source, so a new _resp(4xx) call is covered
 * automatically) and asserts the "<code> <word>" shape.
 */
describe('cockpit handler — ALB response contract', () => {
  it('every status the handler uses gets a "<code> <reason-phrase>" statusDescription', () => {
    const handlerPath = path.join(
      __dirname, '..', 'src', 'cdk', 'lib', 'constructs', 'cockpit', 'lambda', 'handler.py',
    );
    const src = fs.readFileSync(handlerPath, 'utf8');
    const codes = [...new Set([...src.matchAll(/_resp\((\d{3})/g)].map((m) => m[1]))];
    expect(codes.length).toBeGreaterThanOrEqual(4); // 200 plus the error family
    const py = `
import http.client, json, re
src = open(${JSON.stringify(handlerPath)}).read()
# The REAL _resp: from its def to the next top-level def.
start = src.index("def _resp(")
end = src.index("\\ndef ", start + 1)
ns = {"json": json, "http": http}
exec(src[start:end], ns)
for code in [${codes.join(',')}]:
    r = ns["_resp"](code, {})
    sd = r["statusDescription"]
    assert re.fullmatch(r"%d [A-Za-z][A-Za-z ]*" % code, sd), f"BAD statusDescription: {sd!r}"
    print(code, sd)
`;
    const out = execSync('python3', { input: py }).toString();
    for (const code of codes) {
      // The reason phrase must be a word, not the bare code the old version emitted.
      expect(out).toMatch(new RegExp(`${code} [A-Za-z]`));
    }
  });
});

describe('cockpit per-AZ availability chart (single-AZ feature)', () => {
  const HANDLER = path.join(__dirname, '..', 'src', 'cdk', 'lib', 'constructs',
    'cockpit', 'lambda', 'handler.py');
  const UI = path.join(__dirname, '..', 'src', 'cdk', 'lib', 'constructs',
    'cockpit', 'lambda', 'ui.html');

  /** The FULL env handler.py requires at import — every module-scope os.environ["..."].
   *  Enumerated rather than guessed: a missing one fails as a KeyError that reads like a
   *  probe bug rather than a contract change. */
  const PROBE_ENV = {
    ...process.env,
    APP_ID: 'probe',
    PRIMARY_REGION: 'us-east-2',
    STANDBY_REGION: 'us-west-2',
    PLAN_ARN: 'arn:aws:arc-region-switch::111122223333:plan/probe',
    PRIMARY_CLUSTER_NAME: 'probe-cluster',
    PRIMARY_NODE_GROUP_NAME: 'probe-ng',
    PRIMARY_KNOB_PARAM: '/probe/primary',
    STANDBY_KNOB_PARAM: '/probe/standby',
    METRIC_NAMESPACE: 'ProbeNS',
    // STEP 10: both REQUIRED at import (fail-loud rule), so every probe must supply them.
    APP_NLB_ARN: 'arn:aws:elasticloadbalancing:us-east-2:111122223333:loadbalancer/net/probe/abc',
    AZ_NAME_ID_PAIRS: 'us-east-2a=use2-az1,us-east-2b=use2-az2,us-east-2c=use2-az3',
  };

  test('_availability_series returns per-AZ lines on the AGGREGATE timestamp grid', () => {
    // BEHAVIORAL, against a fixture that actually mirrors a real GetMetricData response
    // shape (docs/lessons.md #6: a fixture claiming to mirror a real payload must
    // actually mirror it, or the test is green against a fiction). boto3 is stubbed at
    // import so no AWS call happens and no credentials are needed.
    //
    // The property under test is the one a second GetMetricData call would break: every AZ
    // line must share the aggregate lines' timestamps exactly. Two calls could straddle a
    // minute boundary and yield series of different lengths, which the chart renders as AZ
    // lines offset from the aggregate — reading as a data problem, not a rendering one.
    const probe = path.join(__dirname, 'az-series-probe.py');
    fs.writeFileSync(probe, `
import datetime as dt, json, sys, types

# --- stub boto3 BEFORE importing the handler -------------------------------------------
T0 = dt.datetime(2026, 9, 1, 12, 0)
STAMPS = [T0 + dt.timedelta(minutes=i) for i in range(3)]

def _res(mid, values, stamps=None):
    # Mirrors the real GetMetricData MetricDataResult shape: Id / Label / Timestamps /
    # Values / StatusCode, Timestamps and Values positionally aligned. A series with a
    # MISSING minute omits that timestamp entirely (CloudWatch never pads with null), so
    # gap cases pass a shorter stamps list rather than a None value.
    st = list(STAMPS) if stamps is None else stamps
    return {"Id": mid, "Label": mid, "Timestamps": st,
            "Values": values, "StatusCode": "Complete"}

class FakeCW:
    def list_metrics(self, **kw):
        # The CHART's discovery call: AWS/NetworkELB HealthyHostCount filtered by the
        # LoadBalancer dimension derived from APP_NLB_ARN (\`net/probe/abc\`).
        assert kw["Namespace"] == "AWS/NetworkELB", kw
        assert kw["MetricName"] == "HealthyHostCount", kw
        assert kw["Dimensions"] == [{"Name": "LoadBalancer", "Value": "net/probe/abc"}], kw
        LB = {"Name": "LoadBalancer", "Value": "net/probe/abc"}
        TG = {"Name": "TargetGroup", "Value": "targetgroup/probe/123"}
        return {"Metrics": [
            # The no-AZ aggregate rollup series -- MUST be skipped, not become a chart key.
            {"Namespace": "AWS/NetworkELB", "MetricName": "HealthyHostCount",
             "Dimensions": [LB, TG]},
            {"Namespace": "AWS/NetworkELB", "MetricName": "HealthyHostCount",
             "Dimensions": [LB, TG, {"Name": "AvailabilityZone", "Value": "us-east-2b"}]},
            {"Namespace": "AWS/NetworkELB", "MetricName": "HealthyHostCount",
             "Dimensions": [LB, TG, {"Name": "AvailabilityZone", "Value": "us-east-2a"}]},
        ]}
    def get_metric_data(self, **kw):
        # Every per-AZ query must carry ALL THREE dimensions (LoadBalancer + TargetGroup +
        # AvailabilityZone) and Stat=Maximum per the NLB metrics doc -- a two-dimension query
        # silently returns the rollup and every AZ line reads identical.
        for q in kw["MetricDataQueries"]:
            if q["Id"].startswith("azlat"):
                # The LATENCY-BY-AZ family (brownout feature): the pod-emitted AzLatency at
                # p90 (verified queryable live, phase3 R3), Az-dimensioned, SAME call.
                assert q["MetricStat"]["Stat"] == "p90", q
                assert q["MetricStat"]["Metric"]["Namespace"] == "ProbeNS", q
                dims = q["MetricStat"]["Metric"]["Dimensions"]
                assert [d["Name"] for d in dims] == ["Az"], q
            elif q["Id"].startswith(("azslo", "azsucc", "azerr")):
                # CLIENT-PERCEIVED AVAILABILITY BY AZ (2026-09-03). Pod-emitted counters,
                # Az-dimensioned, Stat=Sum -- these are COUNTS. p90 or Average here would
                # silently produce a per-minute average of 1s and 0s, i.e. a ratio the
                # handler would then divide again.
                assert q["MetricStat"]["Stat"] == "Sum", q
                assert q["MetricStat"]["Metric"]["Namespace"] == "ProbeNS", q
                dims = q["MetricStat"]["Metric"]["Dimensions"]
                assert [d["Name"] for d in dims] == ["Az"], q
            elif q["Id"].startswith("az"):
                dims = {d["Name"] for d in q["MetricStat"]["Metric"]["Dimensions"]}
                assert dims == {"LoadBalancer", "TargetGroup", "AvailabilityZone"}, q
                assert q["MetricStat"]["Stat"] == "Maximum", q
                assert q["MetricStat"]["Metric"]["Namespace"] == "AWS/NetworkELB", q
        ids = [q["Id"] for q in kw["MetricDataQueries"]]
        out = []
        for i in ids:
            if i.endswith("opsuccess"): out.append(_res(i, [100.0, 100.0, 100.0]))
            elif i.endswith("operror"): out.append(_res(i, [0.0, 0.0, 0.0]))
            # az0 = us-east-2a (sorted order): holds healthy throughout.
            elif i == "az0_healthyhostcount": out.append(_res(i, [1.0, 1.0, 1.0]))
            elif i == "az0_unhealthyhostcount": out.append(_res(i, [0.0, 0.0, 0.0]))
            # az1 = us-east-2b: the FAULTED zone -- its target goes unhealthy in the last
            # minute, reported by the surviving AZs' LB nodes (the line DIVES, not vanishes).
            elif i == "az1_healthyhostcount": out.append(_res(i, [1.0, 1.0, 0.0]))
            elif i == "az1_unhealthyhostcount": out.append(_res(i, [0.0, 0.0, 1.0]))
            # Latency lines: 2a at baseline; 2b is BROWNED OUT (jumps to ~2.6s) and its
            # last minute is MISSING (shorter Timestamps) -- the handler must render that
            # as a None gap on the shared grid, never as 0ms.
            elif i == "azlat0": out.append(_res(i, [90.0, 92.0, 88.0]))
            elif i == "azlat1": out.append(_res(i, [95.0, 2600.0], stamps=STAMPS[:2]))
            # CLIENT-PERCEIVED AVAILABILITY counters. 2a is healthy throughout. 2b is the
            # BROWNED-OUT zone: minute 2 answers every request but 31 of 100 land past the
            # 2s bar, giving the ~69% the live run measured -- responded 100%, available 69%.
            # Minute 3 has ZERO traffic for 2b, which must render as a None GAP: 0% there
            # would claim a quiet zone was a failing one.
            elif i == "azsucc0": out.append(_res(i, [100.0, 100.0, 100.0]))
            elif i == "azerr0": out.append(_res(i, [0.0, 0.0, 0.0]))
            elif i == "azslo0": out.append(_res(i, [100.0, 100.0, 100.0]))
            elif i == "azsucc1": out.append(_res(i, [100.0, 100.0, 0.0]))
            elif i == "azerr1": out.append(_res(i, [0.0, 0.0, 0.0]))
            elif i == "azslo1": out.append(_res(i, [100.0, 69.0, 0.0]))
            else: raise AssertionError("unexpected query id " + i)
        return {"MetricDataResults": out}
    def describe_alarms(self, **kw): return {"MetricAlarms": []}

fake_boto3 = types.ModuleType("boto3")
fake_boto3.client = lambda *a, **k: FakeCW()
sys.modules["boto3"] = fake_boto3
fake_bc = types.ModuleType("botocore")
fake_cfg = types.ModuleType("botocore.config")
fake_cfg.Config = lambda **k: None
sys.modules["botocore"] = fake_bc
sys.modules["botocore.config"] = fake_cfg

sys.path.insert(0, ${JSON.stringify(path.dirname(HANDLER))})
import handler
print(json.dumps(handler._availability_series(minutes=3)))
`);
    try {
      const out = execSync(`python3 ${probe}`, {
        encoding: 'utf8',
        env: PROBE_ENV,
      }).trim();
      const s = JSON.parse(out);
      expect(s.available).toBe(true);
      // Discovered, sorted, and NOT threaded — the handler cannot know these ahead of time.
      expect(Object.keys(s.az).sort()).toEqual(['us-east-2a', 'us-east-2b']);
      // THE PROPERTY THAT MATTERS: identical grid length for aggregate and every AZ line.
      const nAgg = s.minutes.length;
      expect(s.read.length).toBe(nAgg);
      for (const az of Object.keys(s.az)) {
        expect({ az, len: s.az[az].length }).toEqual({ az, len: nAgg });
      }
      // The faulted zone's target reads unhealthy in the last minute (0% target health)
      // while the healthy one holds at 100 — the per-AZ lines genuinely separate, and the
      // dive-not-vanish behavior is the whole reason the chart moved to the NLB source.
      expect(s.az['us-east-2a']).toEqual([100, 100, 100]);
      expect(s.az['us-east-2b']).toEqual([100, 100, 0]);
      // LATENCY-BY-AZ (brownout feature, D5): same call, same grid, p90 (asserted inside
      // the fake), keyed by the SAME zone-name vocabulary as the target-health lines. A
      // missing minute is a None GAP on the shared grid — 0ms would read as "instant",
      // the exact inverse of a browned-out zone.
      expect(Object.keys(s.latencyAz).sort()).toEqual(['us-east-2a', 'us-east-2b']);
      for (const az of Object.keys(s.latencyAz)) {
        expect({ az, len: s.latencyAz[az].length }).toEqual({ az, len: nAgg });
      }
      expect(s.latencyAz['us-east-2a']).toEqual([90, 92, 88]);
      expect(s.latencyAz['us-east-2b']).toEqual([95, 2600, null]);

      // CLIENT-PERCEIVED AVAILABILITY BY AZ (2026-09-03) -- the hero line. Same call, same
      // grid. Definition: AzSloSuccess / (AzSuccess + AzError), i.e. non-error AND within
      // the 2s bar, over everything attempted.
      expect(Object.keys(s.clientAz).sort()).toEqual(['us-east-2a', 'us-east-2b']);
      for (const az of Object.keys(s.clientAz)) {
        expect({ az, len: s.clientAz[az].length }).toEqual({ az, len: nAgg });
      }
      expect(s.clientAz['us-east-2a']).toEqual([100, 100, 100]);
      // THE PROPERTY THIS CHART EXISTS FOR: minute 2 of the browned-out zone. Nothing
      // errored -- s.read stays 100 and the target-health line stays 100 -- and yet only
      // 69% of that zone's customers were served inside the bar. A chart that cannot show
      // this disagreement cannot show a gray failure at all.
      //
      // Minute 3 is the gap case: zero attempts -> null, NEVER 0.
      expect(s.clientAz['us-east-2b']).toEqual([100, 69, null]);
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });

  test('AZ discovery uses ListMetrics, and the role is granted it', () => {
    // The handler cannot know the AZ dimension VALUES ahead of time. ListMetrics has a
    // documented response shape; a GetMetricData SEARCH expression would need no new grant
    // but its result-label format is undocumented, and parsing an undocumented identifier
    // format already cost this project a day (docs/lessons.md #18).
    const handler = fs.readFileSync(HANDLER, 'utf8');
    expect(handler).toContain('def _discover_azs(');
    expect(handler).toContain('_cw.list_metrics(');
    expect(handler).toContain('"RecentlyActive"] = "PT3H"');
    // A grant the code needs but the role lacks fails at RUNTIME with AccessDenied while
    // synth, cfn-lint and every unit test stay green. Uses the file's own synth() helper —
    // the cockpit exists only in the STANDBY region with the flag on.
    synth(STANDBY, true).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(['cloudwatch:ListMetrics']) }),
        ]),
      }),
    });
  });

  test('the UI does not read a status field nothing produces', () => {
    // docs/lessons.md #6. `faultedAz` is only produced once the single-AZ fault ships;
    // until then the UI must NOT read it, or it renders a plausible blank rather than
    // failing — the exact "UI fields nothing supplies" defect.
    const ui = fs.readFileSync(UI, 'utf8');
    const handler = fs.readFileSync(HANDLER, 'utf8');
    const uiReadsIt = /renderClientAzChart\([^)]*s\.faultedAz/.test(ui);
    const handlerProducesIt = /"faultedAz"\s*:/.test(handler);
    expect({ uiReadsIt, handlerProducesIt }).toEqual({
      uiReadsIt: handlerProducesIt, handlerProducesIt,
    });
  });

  test('every CSS variable the UI references is actually defined', () => {
    // FOUND BY RENDERING, 2026-09-03 -- and findable no other way. The per-AZ chart's
    // palette was ["var(--ok)", "var(--accent)", "var(--info)", "var(--muted)"] while the
    // stylesheet defined no --info at all, so colours[2] was an INVALID stroke and the THIRD
    // zone's line simply did not draw. This demo runs three AZs and the faulted zone is
    // frequently the third by sort order, so the single line the card exists to show was the
    // one silently absent. The 50% guardrail reference was gone too: var(--danger), also
    // never defined (the cockpit's red is --bad).
    //
    // Nothing caught it because an undefined custom property is not an error anywhere in the
    // stack -- CSS resolves it to nothing, the SVG renders with no stroke, the page looks
    // plausible, and every existing test asserts on the SOURCE string rather than on pixels.
    // Same family as docs/lessons.md #6: a UI reading something nothing supplies degrades
    // into a convincing lie instead of failing.
    const ui = fs.readFileSync(UI, 'utf8');
    const root = ui.match(/:root \{([\s\S]*?)\}/)?.[1] ?? '';
    const defined = new Set(Array.from(root.matchAll(/(--[a-z0-9-]+)\s*:/g), (m) => m[1]));
    const referenced = new Set(Array.from(ui.matchAll(/var\((--[a-z0-9-]+)/g), (m) => m[1]));
    const missing = [...referenced].filter((v) => !defined.has(v)).sort();
    // Listed rather than counted so a failure names the variable and the fix is immediate.
    expect({ missing }).toEqual({ missing: [] });
    // Sanity that the parse actually found something -- an empty :root would make the
    // assertion above vacuous, which is the way this class of test usually rots.
    expect(defined.size).toBeGreaterThan(5);
    expect(referenced.size).toBeGreaterThan(5);
  });

  test('the client-perceived availability chart reads AzSloSuccess and derives its own label', () => {
    // T1, rewritten 2026-09-03. The D7 contract test proves the four Az names AGREE across
    // three files -- it does NOT prove the chart reader ever QUERIES the new one. A defined-
    // but-unused constant passes the contract while the hero card renders the old measure
    // forever, which is indistinguishable from the feature not having shipped.
    const handler = fs.readFileSync(HANDLER, 'utf8');
    expect(handler).toContain('"MetricName": metric');
    expect(handler).toContain('AZ_SLO_SUCCESS: "azslo"');
    expect(handler).toContain('"clientAz"');
    // Sum, because these are COUNTS. Average would return the mean of a 1/0 series -- a
    // ratio -- and the handler would then compute a ratio of a ratio: wrong, and wrong in
    // the plausible direction.
    expect(handler).toContain('"Stat": "Sum"');
    // AzLatency survives as the TILE source, so its query and p90 stat must remain.
    expect(handler).toContain('"MetricName": AZ_LATENCY');
    expect(handler).toContain('"Stat": "p90"');
    expect(handler).toContain('"latencyAz"');

    const ui = fs.readFileSync(UI, 'utf8');
    // Both directions of the field contract (bug class 6): the card must read the field the
    // handler produces, for the hero line AND for the demoted signals.
    expect({
      chartReadsClientAz: /renderClientAzChart\(/.test(ui) && ui.includes('.clientAz'),
      badgeReadsTargetHealth: /renderPlatformBadge\(/.test(ui) && ui.includes('series.az'),
      tilesReadLatency: /renderLatencyTiles\(/.test(ui) && ui.includes('.latencyAz'),
    }).toEqual({
      chartReadsClientAz: true, badgeReadsTargetHealth: true, tilesReadLatency: true,
    });

    // THE THRESHOLD IS DERIVED, NOT TYPED. The heading states the definition the chart is
    // drawing; if the UI carried its own literal it would keep printing "2s" after the
    // emitter moved, and no test could see the mislabel. So: the UI must read sloMs from
    // the payload, the handler must emit it, and the UI must NOT contain a bare threshold
    // constant of its own.
    expect(ui).toContain('series.sloMs');
    expect(handler).toContain('out["sloMs"] = AZ_SLO_MS');
    expect(ui).not.toMatch(/LAT_REF|LAT_CAP/);

    // The retired latency CHART must stay retired. Its fixed-axis reference line compared a
    // client latency against a health-check timeout -- quantities ~3x apart because the
    // check pays one shaped hop and the client pays about three -- so the card invited
    // exactly the wrong inference. Live proof it had to go: experiment EXPXEWF6Dbb2B6qiug
    // held every target healthy at 100.00% aggregate availability while one zone's p90 sat
    // at 2,240ms.
    expect(ui).not.toMatch(/renderLatencyChart|HC timeout/);
  });
  test('AZ eligibility comes from TRAFFIC, and refuses with a reason when there is none', () => {
    // Decision D3. Behavioral, with boto3 stubbed: two cases in one probe.
    //   busy  -> the busiest AZ that has served traffic is selected
    //   quiet -> NOTHING is eligible, and the refusal carries a reason
    // The quiet case is the one that matters most: silently picking an AZ when we cannot tell
    // is how "the fault reported success and injected nothing" happens, and failing blank is
    // indistinguishable from a broken cockpit.
    const probe = path.join(__dirname, 'az-eligibility-probe.py');
    fs.writeFileSync(probe, `
import datetime as dt, json, sys, types
MODE = sys.argv[1]

class FakeCW:
    def list_metrics(self, **kw):
        if MODE == "quiet":
            # RecentlyActive=PT3H legitimately returns nothing when the emitter is stopped.
            return {"Metrics": []}
        return {"Metrics": [
            {"Dimensions": [{"Name": "Az", "Value": "us-east-2a"}]},
            {"Dimensions": [{"Name": "Az", "Value": "us-east-2b"}]},
            # "unknown" IS emitted for real (loadgen exception path) and belongs on the chart,
            # but it is not an AZ and FIS could not target it.
            {"Dimensions": [{"Name": "Az", "Value": "unknown"}]},
        ]}
    def get_metric_data(self, **kw):
        vals = {"elig0_azsuccess": 400.0, "elig0_azerror": 0.0,
                "elig1_azsuccess": 900.0, "elig1_azerror": 100.0}
        return {"MetricDataResults": [
            {"Id": q["Id"], "Timestamps": [dt.datetime(2026, 9, 1)],
             "Values": [vals.get(q["Id"], 0.0)], "StatusCode": "Complete"}
            for q in kw["MetricDataQueries"]]}

fb = types.ModuleType("boto3"); fb.client = lambda *a, **k: FakeCW()
sys.modules["boto3"] = fb
sys.modules["botocore"] = types.ModuleType("botocore")
cfg = types.ModuleType("botocore.config"); cfg.Config = lambda **k: None
sys.modules["botocore.config"] = cfg
sys.path.insert(0, ${JSON.stringify(path.dirname(HANDLER))})
import handler
az, reason = handler._eligible_fault_az()
print(json.dumps({"totals": handler._az_traffic_totals(), "az": az, "reason": reason}))
`);
    const env = PROBE_ENV;
    try {
      const busy = JSON.parse(execSync(`python3 ${probe} busy`, { encoding: 'utf8', env }).trim());
      // "unknown" must not appear as a candidate.
      expect(Object.keys(busy.totals).sort()).toEqual(['us-east-2a', 'us-east-2b']);
      // Busiest first, and that is what gets selected — the fault should land where it has
      // the largest visible effect on the chart.
      expect(Object.keys(busy.totals)[0]).toBe('us-east-2b'); // 1000 vs 400
      expect(busy.az).toBe('us-east-2b');
      expect(busy.reason).toContain('1000 requests');

      const quiet = JSON.parse(execSync(`python3 ${probe} quiet`, { encoding: 'utf8', env }).trim());
      expect(quiet.totals).toEqual({});
      expect(quiet.az).toBeNull();
      // A REASON, not a blank failure.
      expect(quiet.reason).toContain('no AZ has served traffic');
      expect(quiet.reason).toContain('load generator');
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });
});

describe('single-AZ fault (failure-injection extension)', () => {
  const HANDLER2 = path.join(__dirname, '..', 'src', 'cdk', 'lib', 'constructs',
    'cockpit', 'lambda', 'handler.py');
  const handler = fs.readFileSync(HANDLER2, 'utf8');

  /** Python with `#` comments and triple-quoted docstrings removed.
   *
   *  REQUIRED for any not-toContain assertion against this file. The docstrings deliberately
   *  NAME the APIs and values they exist to warn about -- the interlock's docstring explains why
   *  it must NOT query arc-zonal-shift -- so a naive substring check matches the explanation
   *  rather than the code and fails for the wrong reason. Same lesson as the manifest
   *  assertions in topology.test.ts (docs/lessons.md #16). */
  const stripPy = (py: string): string =>
    py.replace(/"""[\s\S]*?"""/g, '')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  test('single-AZ templates are threaded as az=id PAIRS, all four layers', () => {
    // A CfnParameter declared but never supplied breaks the DEPLOY, not the build (bug class 4),
    // so all four layers must move together: output -> parameter -> Lambda env -> deploy supply.
    const region = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'region-stack.ts'), 'utf8');
    const frontDoor = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'operator-access-stack.ts'), 'utf8');
    const cockpitTs = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'constructs', 'cockpit', 'cockpit.ts'), 'utf8');
    const projenrc = fs.readFileSync(path.join(__dirname, '..', '.projenrc.ts'), 'utf8');
    for (const name of ['FisLatencyTemplatesByAz', 'FisPacketLossTemplatesByAz']) {
      expect({ name, inRegion: region.includes(name) }).toEqual({ name, inRegion: true });
      expect({ name, inFrontDoor: frontDoor.includes(name) }).toEqual({ name, inFrontDoor: true });
      expect({ name, supplied: projenrc.includes(name) }).toEqual({ name, supplied: true });
    }
    expect(cockpitTs).toContain('FIS_LATENCY_TEMPLATES_BY_AZ');
    expect(cockpitTs).toContain('FIS_PACKET_LOSS_TEMPLATES_BY_AZ');
    // And the pairing is built beside the creation loop, keyed by NAME -- not zipped by index
    // in a consumer. Selecting a template by list position injects into a different AZ than the
    // operator was told about: success is reported and a different chart line moves.
    const construct = fs.readFileSync(path.join(__dirname, '..', 'src', 'cdk', 'lib',
      'constructs', 'failure-injection', 'fis-network-experiments.ts'), 'utf8');
    expect(construct).toContain('templatesByAz');
    expect(region).toContain('templatesByAz');
    // EVERY single-AZ output must carry the az= prefix, not just one of them. A first version of
    // this assertion was a single regex match, which stayed green when the prefix was dropped
    // from the latency output because the packet-loss output still had it -- the test passed for
    // the wrong reason. Counted per output instead.
    for (const output of ['FisLatencyTemplatesByAz', 'FisPacketLossTemplatesByAz']) {
      const at = region.indexOf(`new cdk.CfnOutput(this, '${output}'`);
      expect({ output, present: at !== -1 }).toEqual({ output, present: true });
      const body = region.slice(at, region.indexOf('});', at));
      expect({ output, paired: /\$\{az\}=\$\{byFault/.test(body) })
        .toEqual({ output, paired: true });
    }
  });

  test('the interlock refuses a second FAULT and is scoped to FIS experiments only', () => {
    // The docstring used to ASSERT this refusal while nothing implemented it -- prose read as
    // behaviour and repeated as a safety property the demo did not have. Now authored.
    expect(handler).toContain('def _fault_already_running(');
    expect(handler).toContain('a fault is already running');
    // Scoped to FIS. An ARC zonal shift is arc-zonal-shift:StartZonalShift, invisible to
    // list_experiments -- so fault-then-shift-then-recover stays permitted BY CONSTRUCTION,
    // with no special case to get wrong. If this ever queried shifts too, the AZ demo's central
    // beat would become unreachable.
    const fn = stripPy(handler.slice(handler.indexOf('def _fault_already_running('),
      handler.indexOf('def _faulted_az(')));
    expect(fn).toContain('_fis.list_experiments');
    for (const shiftApi of ['zonal_shift', 'list_zonal_shifts', 'arc-zonal-shift']) {
      expect({ shiftApi, leaks: fn.includes(shiftApi) }).toEqual({ shiftApi, leaks: false });
    }
    // And the interlock must run BEFORE the start, not after.
    expect(handler.indexOf('running = _fault_already_running()'))
      .toBeLessThan(handler.indexOf('_fis.start_experiment'));
  });

  test('the AZ is CHOSEN by traffic (D3) and refused with a reason when none qualifies', () => {
    // The AZ is not passed in by the caller: eligibility is recent traffic, so the fault lands
    // where it will actually move the graph. A pod-count test would select an AZ holding an idle
    // pod, where the fault injects cleanly, reports success and changes nothing measurable.
    const start = stripPy(handler.slice(handler.indexOf('if single_az:')));
    expect(start).toContain('_eligible_fault_az()');
    // Refuses WITH a reason rather than picking something anyway.
    expect(start).toContain('no AZ is eligible for a single-AZ fault');
    expect(start).toContain('"detail": reason');
    // The caller cannot override the choice -- no az/availabilityZone read from the body.
    expect(start).not.toContain('body.get("az")');
    expect(start).not.toContain('body.get("availabilityZone")');
  });

  test('faultedAz is produced AND read — both halves, in the same change', () => {
    // Bug class 6. A UI reading a field nothing produces renders a plausible blank instead of
    // failing; a field nothing reads is dead weight. This is the same assertion that guarded the
    // gap while the fault did not exist -- it now requires BOTH sides.
    const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'cdk', 'lib', 'constructs',
      'cockpit', 'lambda', 'ui.html'), 'utf8');
    const produces = /"faultedAz":/.test(handler);
    const reads = /renderClientAzChart\([^)]*s\.faultedAz/.test(ui);
    expect({ produces, reads }).toEqual({ produces: true, reads: true });
    // Derived from the RUNNING experiment, not from what the page last requested -- so it
    // survives a reload and reports what is actually happening.
    const fn = handler.slice(handler.indexOf('def _faulted_az('));
    expect(fn).toContain('experimentTemplateId');
    expect(fn).toContain('_templates_by_az(fault)');
  });
});

/* ------------------------------------------------------------------------------------------
 * STEP 10 — the zonal shift control.
 *
 * The identifier trap is the whole risk: FIS selects by AZ NAME (us-east-2a), StartZonalShift
 * awayFrom takes the AZ ID (use2-az1), the mapping is account-specific, and a wrong choice
 * mis-binds SILENTLY — the shift reports ACTIVE and drains a different AZ than the fault is
 * degrading. These tests pin the pieces the build can see; build/verify-zonal-shift-azs.py
 * proves the pairing against the live account at deploy (the part no test can).
 * ------------------------------------------------------------------------------------------ */
describe('zonal shift control (step 10)', () => {
  const HANDLER = path.join(__dirname, '..', 'src', 'cdk', 'lib', 'constructs',
    'cockpit', 'lambda', 'handler.py');
  const handler = fs.readFileSync(HANDLER, 'utf8');
  const stripPy = (py: string): string =>
    py.replace(/"""[\s\S]*?"""/g, '')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  const template = synth(STANDBY, true);

  const policyStatements = (): any[] => {
    const policies = template.findResources('AWS::IAM::Policy');
    return Object.values(policies).flatMap(
      (p: any) => p.Properties.PolicyDocument.Statement as any[]);
  };

  test('writes are scoped by the ResourceIdentifier CONDITION KEY, pinned to the NLB param (D4a)', () => {
    // The service scopes by condition key, NOT the Resource element — an ARN in Resource
    // authorizes nothing. And the boundary is allow-all + deny-list, so this condition is
    // the ONLY least-privilege layer. It must reference the AppNlbArn parameter, not '*'.
    const writes = policyStatements().filter((s) => {
      const a = Array.isArray(s.Action) ? s.Action : [s.Action];
      return a.includes('arc-zonal-shift:StartZonalShift');
    });
    expect(writes).toHaveLength(1);
    const s = writes[0];
    expect(s.Action).toEqual(expect.arrayContaining([
      'arc-zonal-shift:StartZonalShift',
      'arc-zonal-shift:UpdateZonalShift',
      'arc-zonal-shift:CancelZonalShift',
    ]));
    const cond = s.Condition?.StringLike?.['arc-zonal-shift:ResourceIdentifier'];
    expect(cond).toBeDefined();
    // Pinned to the threaded CfnParameter, never a literal '*'.
    expect(JSON.stringify(cond)).toContain('AppNlbArn');
    expect(JSON.stringify(cond)).not.toBe('"*"');
  });

  test('the zonal-shift listers ride their OWN statement with no mutating action (D4b)', () => {
    // ListZonalShifts / ListManagedResources take no resource input so they need '*' —
    // and that wildcard must carry nothing mutating (the fis:List* lesson, bug class 22c).
    const lists = policyStatements().filter((s) => {
      const a = Array.isArray(s.Action) ? s.Action : [s.Action];
      return a.includes('arc-zonal-shift:ListZonalShifts');
    });
    expect(lists).toHaveLength(1);
    const actions = Array.isArray(lists[0].Action) ? lists[0].Action : [lists[0].Action];
    for (const a of actions) {
      expect({ a, mutating: /:(Start|Stop|Cancel|Update|Put|Create|Delete)/.test(a) })
        .toEqual({ a, mutating: false });
    }
  });

  test('the boundary does NOT deny arc-zonal-shift (N5 pairing check)', () => {
    // No widening was needed — the boundary is allow-all + deny-list and arc-zonal-shift
    // is not in any deny set. This is the mirror of the PassRole two-sided pin: a future
    // boundary tightening that adds such a deny would kill the control with an error
    // message pointing at the role policy, where the grant is present and looks right.
    const roles = Object.values(template.findResources('AWS::IAM::ManagedPolicy'));
    const boundary = roles.find((r: any) =>
      JSON.stringify(r).includes('organizations:*')) as any;
    expect(boundary).toBeDefined();
    const denies = boundary.Properties.PolicyDocument.Statement
      .filter((s: any) => s.Effect === 'Deny');
    for (const d of denies) {
      const actions = Array.isArray(d.Action) ? d.Action : [d.Action];
      for (const a of actions) {
        expect({ a, hitsZonalShift: String(a).startsWith('arc-zonal-shift') })
          .toEqual({ a, hitsZonalShift: false });
      }
    }
  });

  test('the shift targets the RUNNING fault\'s AZ and translates through the threaded map only', () => {
    const fn = stripPy(handler.slice(handler.indexOf('def _do_zonalshift(')));
    // Derived server-side from the running experiment, never from the page.
    expect(fn).toContain('_faulted_az()');
    // Name -> ID through the threaded dict; string-munging a name into an ID is the
    // account-specific silent mis-bind. The only occurrence of the ID must come from
    // AZ_NAME_TO_ID.
    expect(fn).toContain('AZ_NAME_TO_ID.get(az_name)');
    expect(fn).toContain('awayFrom=zone_id');
    // And the start is typed-confirmed against the AZ name the shift will drain.
    expect(fn).toContain('_require_confirm(body, az_name');
  });

  test('F6: start refuses with a stated reason when traffic is not in the primary', () => {
    const fn = stripPy(handler.slice(
      handler.indexOf('def _do_zonalshift('), handler.indexOf('def _do_failover(')));
    // The gate consults observed traffic and treats region:None (loadgen stopped) as
    // not-primary; the refusal names where traffic actually is.
    expect(fn).toContain('_region_traffic()');
    expect(fn).toContain('!= PRIMARY_REGION');
    // The refusal must come BEFORE the start call.
    expect(fn.indexOf('PRIMARY_REGION')).toBeLessThan(fn.indexOf('start_zonal_shift'));
  });

  test('F4: stopping the fault auto-cancels the shift, by direct API call in the stop path', () => {
    // A shift is a MITIGATION; the fault stopping must take it down or the next run
    // measures a two-AZ baseline. Direct call, never prose-driven (bug class 8) — and it
    // lives INSIDE the fis stop action, before the start path.
    const stop = stripPy(handler.slice(
      handler.indexOf('if action == "stop":'), handler.indexOf('# action == start')));
    expect(stop).toContain('cancel_zonal_shift');
    expect(stop).toContain('_active_shifts()');
  });

  test('status tile reports the shift with expiry, and the UI reads what the handler produces', () => {
    // Bug class 6 both ways: the handler produces zonalShift (status/awayFrom/expiryTime),
    // and the UI reads exactly those fields — a field nothing produces renders a plausible
    // blank; a field nothing reads is dead weight.
    expect(handler).toContain('"zonalShift": _zonal_shift()');
    const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'cdk', 'lib', 'constructs',
      'cockpit', 'lambda', 'ui.html'), 'utf8');
    expect(ui).toContain('s.zonalShift');
    for (const field of ['expiryTime', 'awayFrom', 'zonalShiftId', 'enabled', 'reason']) {
      expect({ field, produced: handler.includes(`"${field}"`) }).toEqual({ field, produced: true });
      expect({ field, read: ui.includes(field) }).toEqual({ field, read: true });
    }
    // And the route is dispatched.
    expect(handler).toContain('if path == "/cockpit/api/zonalshift":');
    expect(ui).toContain('/cockpit/api/zonalshift');
  });

  test('AzNameIdPairs + AppNlbArn are threaded through all four layers (bug class 4)', () => {
    // Output/capture -> CfnParameter declaration -> deploy supply -> Lambda env. A
    // parameter declared but never supplied breaks the DEPLOY, not the build.
    const region = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'region-stack.ts'), 'utf8');
    const frontDoor = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'operator-access-stack.ts'), 'utf8');
    const cockpitTs = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'constructs', 'cockpit', 'cockpit.ts'), 'utf8');
    const projenrc = fs.readFileSync(path.join(__dirname, '..', '.projenrc.ts'), 'utf8');
    expect(region).toContain('AzNameIdPairs');
    for (const name of ['AppNlbArn', 'AzNameIdPairs']) {
      expect({ name, declared: frontDoor.includes(name) }).toEqual({ name, declared: true });
      expect({ name, supplied: projenrc.includes(name) }).toEqual({ name, supplied: true });
    }
    // The installer captures the ARN (Kubernetes-created, no CfnOutput exists for it).
    expect(projenrc).toContain('APP_NLB_ARN_');
    expect(cockpitTs).toContain('APP_NLB_ARN');
    expect(cockpitTs).toContain('AZ_NAME_ID_PAIRS');
    expect(handler).toContain('os.environ["APP_NLB_ARN"]');
    expect(handler).toContain('os.environ["AZ_NAME_ID_PAIRS"]');
  });

  test('the arm gesture resolves the Karpenter fleet too, scoped to THIS cluster', () => {
    // The node-group walk sees only ASG members; Karpenter nodes belong to no ASG and were
    // silently immune to every fault (3 of 5 nodes, measured 2026-09-01). Comment-stripped:
    // the docstring names the tag keys it exists to explain.
    const fn = stripPy(handler.slice(
      handler.indexOf('def _node_instance_ids('), handler.indexOf('def _armed_counts(')));
    expect(fn).toContain('karpenter.sh/nodepool');
    // Scoped to this cluster — a second cluster's Karpenter fleet in the same account must
    // never be armed by accident.
    expect(fn).toContain('eks:eks-cluster-name');
    expect(fn).toContain('PRIMARY_CLUSTER_NAME');
    // And only RUNNING instances: a terminating node accepted into the target set is a
    // fault that partially lands and reads as a calibration error.
    expect(fn).toContain('instance-state-name');
  });

  test('the post-deploy verifier exists, checks both risks, and maps env correctly (bug class 20)', () => {
    const verifier = fs.readFileSync(
      path.join(__dirname, '..', 'build', 'verify-zonal-shift-azs.py'), 'utf8');
    // Risk 1: the threaded pairing vs a LIVE describe-availability-zones.
    expect(verifier).toContain('describe-availability-zones');
    // Risk 2: the NLB opt-in.
    expect(verifier).toContain('get-managed-resource');
    // Non-mutating and fail-loud.
    expect(verifier).toContain('sys.exit(1)');
    // Its deploy step maps values through env: (sourced dotenvs are unexported+prefixed —
    // the exact failure that silently broke the ARC verify step on every deploy).
    const projenrc = fs.readFileSync(path.join(__dirname, '..', '.projenrc.ts'), 'utf8');
    const step = projenrc.slice(projenrc.indexOf('verify the zonal-shift AZ mapping'));
    const envBlock = step.slice(0, step.indexOf('run:'));
    for (const name of ['APPNLBARN', 'AZNAMEIDPAIRS']) {
      expect({ name, inScriptEnvReads: verifier.includes(`env("${name}")`) })
        .toEqual({ name, inScriptEnvReads: true });
      expect({ name, mappedInStep: envBlock.includes(`${name}:`) })
        .toEqual({ name, mappedInStep: true });
    }
  });
});

describe('NLB-sourced per-AZ target-health chart (power-interruption feature)', () => {
  const HANDLER = path.join(__dirname, '..', 'src', 'cdk', 'lib', 'constructs',
    'cockpit', 'lambda', 'handler.py');
  const UI = path.join(__dirname, '..', 'src', 'cdk', 'lib', 'constructs',
    'cockpit', 'lambda', 'ui.html');
  const PROBE_ENV = {
    ...process.env,
    APP_ID: 'probe',
    PRIMARY_REGION: 'us-east-2',
    STANDBY_REGION: 'us-west-2',
    PLAN_ARN: 'arn:aws:arc-region-switch::111122223333:plan/probe',
    PRIMARY_CLUSTER_NAME: 'probe-cluster',
    PRIMARY_NODE_GROUP_NAME: 'probe-ng',
    PRIMARY_KNOB_PARAM: '/probe/primary',
    STANDBY_KNOB_PARAM: '/probe/standby',
    METRIC_NAMESPACE: 'ProbeNS',
    APP_NLB_ARN: 'arn:aws:elasticloadbalancing:us-east-2:111122223333:loadbalancer/net/probe/abc',
    AZ_NAME_ID_PAIRS: 'us-east-2a=use2-az1,us-east-2b=use2-az2,us-east-2c=use2-az3',
  };

  // T1 — THE LOAD-BEARING CONTRACT (design D5). The chart's AZ keys now come from the
  // NLB metric's AvailabilityZone dimension; _faulted_az speaks pod-emitted AZ NAMES.
  // If the vocabularies ever diverge (an LBC/ELB change to zone-ID labels), the faulted
  // line silently stops being highlighted — the beat renders but unmarked, and nothing
  // else catches it. This is the green-lies-about-the-fault class hit four times on
  // 2026-09-02. The reconciler is the fix; this test is its pin.
  test('T1: NLB chart labels reconcile to the _faulted_az vocabulary (name/id/junk)', () => {
    const probe = path.join(__dirname, 'nlb-az-reconcile-probe.py');
    fs.writeFileSync(probe, `
import json, sys, types

fake_boto3 = types.ModuleType("boto3")
fake_boto3.client = lambda *a, **k: object()
sys.modules["boto3"] = fake_boto3
fake_cfg = types.ModuleType("botocore.config")
class Config:  # noqa: D401 - shape only
    def __init__(self, **kw): pass
fake_cfg.Config = Config
fake_botocore = types.ModuleType("botocore")
fake_botocore.config = fake_cfg
sys.modules["botocore"] = fake_botocore
sys.modules["botocore.config"] = fake_cfg

sys.path.insert(0, ${JSON.stringify(path.dirname(HANDLER))})
import handler

# LIVE-VERIFIED (R1, 2026-09-02): this NLB's AvailabilityZone dimension carries zone
# NAMES. Identity must hold for names...
assert handler._reconcile_nlb_az("us-east-2a") == "us-east-2a"
assert handler._reconcile_nlb_az("us-east-2c") == "us-east-2c"
# ...zone IDs must map BACK through the threaded pairs (the documented alternative
# vocabulary — never derived by string rule, bug class 19)...
assert handler._reconcile_nlb_az("use2-az2") == "us-east-2b"
# ...and anything else must be DROPPED (None), never passed through as a chart key the
# highlight comparison can silently miss.
assert handler._reconcile_nlb_az("net/probe/abc") is None
assert handler._reconcile_nlb_az("") is None
print("RECONCILER_OK")
`);
    try {
      const out = execSync(`python3 ${probe}`, { encoding: 'utf8', env: PROBE_ENV });
      expect(out).toContain('RECONCILER_OK');
    } finally {
      fs.unlinkSync(probe);
    }
  });

  test('T1b: the chart az keys pass through the reconciler, and the highlight compares them', () => {
    const handler = fs.readFileSync(HANDLER, 'utf8');
    const ui = fs.readFileSync(UI, 'utf8');
    // The series builder must feed every NLB-derived AZ label through _reconcile_nlb_az
    // before it becomes a chart key. Source-level: the reconciler must be CALLED inside
    // the NLB discovery/series path, not merely defined.
    const nlbBlock = handler.split('def _nlb_chart_azs')[1];
    expect(nlbBlock).toBeDefined();
    expect(nlbBlock).toContain('_reconcile_nlb_az(');
    // And the UI still highlights by faultedAz === az over those keys — the consumer half
    // of the contract (already true today; pinned so a refactor cannot drop it).
    expect(ui).toMatch(/az === faultedAz/);
  });

  // T4 (part): the chart's AZ discovery is now the NLB metric, scoped to THIS load
  // balancer — not the pod-emitted Az family (which remains the ELIGIBILITY selector).
  test('chart discovery queries AWS/NetworkELB scoped by the LoadBalancer dimension', () => {
    const handler = fs.readFileSync(HANDLER, 'utf8');
    const nlbBlock = handler.split('def _nlb_chart_azs')[1]?.split('\ndef ')[0] ?? '';
    expect(nlbBlock).toContain('AWS/NetworkELB');
    expect(nlbBlock).toContain('HealthyHostCount');
    expect(nlbBlock).toContain('LoadBalancer');
    // Eligibility must NOT have moved: _eligible_fault_az still rides the Az family.
    expect(handler).toMatch(/_az_traffic_totals|AzSuccess/);
  });

  // T5 (UI half of design D2): the card must SAY what it now measures. "Availability"
  // over target-health data overclaims — the axis label is part of the honesty.
  test('each per-AZ signal is labeled as the thing it actually measures', () => {
    // THE HONESTY INVARIANT, INVERTED 2026-09-03 -- and it is the same invariant, not a
    // relaxation of it. The old rule was "do not say availability over target-health data":
    // the card drew HealthyHostCount and calling that availability would have overclaimed.
    //
    // The hero card now draws AzSloSuccess / attempted, which IS availability, so saying so
    // is correct. The overclaim risk simply moved: target health is still on screen, in the
    // badge, and IT must not be dressed up as availability. So the assertion flips sides
    // rather than being deleted -- deleting it would leave the demoted signal unguarded,
    // which is exactly where an overclaim would now go unnoticed.
    const ui = fs.readFileSync(UI, 'utf8');
    // The chart says availability, because it measures it.
    expect(ui).toMatch(/client-perceived availability per minute, by availability zone/);
    expect(ui).not.toMatch(/target health per minute, by availability zone/);
    // The badge says LOAD BALANCER, and never claims availability. Under a brownout it reads
    // healthy while the chart sags -- the whole point -- so a reader who mistook it for an
    // availability figure would draw precisely the wrong conclusion.
    const badge = ui.match(/function renderPlatformBadge[\s\S]{0,1400}/)?.[0] ?? '';
    expect(badge).toMatch(/load balancer: /);
    expect(badge).not.toMatch(/availability/i);
  });
});
