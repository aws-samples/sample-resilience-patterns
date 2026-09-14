import { execSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  APP_CONTAINER_PORT,
  APP_DEPLOYMENT_NAME,
  APP_HPA_NAME,
  APP_LABEL,
  APP_MANIFEST,
  APP_NAMESPACE,
  APP_SERVICE_NAME,
  APP_SERVICE_PORT,
  SCHEMA_JOB_MANIFEST,
} from '../src/cdk/k8s';
import {
  AURORA_MAX_ACU,
  AURORA_MIN_ACU,
  AURORA_READER_AZ_INDEXES,
  AURORA_WRITER_AZ_INDEX,
} from '../src/cdk/lib/aurora-member';
import { DnsStack } from '../src/cdk/lib/dns-stack';
import { FailoverStack } from '../src/cdk/lib/failover-stack';
import { GlobalDataStack } from '../src/cdk/lib/global-data-stack';
import { KARPENTER_NAMESPACE, KARPENTER_SERVICE_ACCOUNT } from '../src/cdk/lib/karpenter-iam';
import { LoadGenStack } from '../src/cdk/lib/loadgen-stack';
import { ObserverStack } from '../src/cdk/lib/observer-stack';
import { OperatorAccessStack } from '../src/cdk/lib/operator-access-stack';
import { PeeringStack } from '../src/cdk/lib/peering-stack';
import { RegionStack } from '../src/cdk/lib/region-stack';
import { SecondaryDbStack } from '../src/cdk/lib/secondary-db-stack';
import { StandbyAccessStack } from '../src/cdk/lib/standby-access-stack';
import {
  APP_DOMAIN,
  APP_RECORD_NAME,
  AZ_COUNT,
  operatorAccessSuffix,
  OBSERVER_REGION,
  OBSERVER_SUFFIX,
  DNS_SUFFIX,
  GLOBAL_DATA_SUFFIX,
  KUBERNETES_VERSION,
  LOADGEN_SUFFIX,
  PEERING_SUFFIX,
  PRIMARY_REGION,
  REGIONS,
  FAILOVER_SUFFIX,
  SECONDARY_DB_SUFFIX,
  STACK_SUFFIXES,
  STANDBY_ACCESS_SUFFIX,
  peerVpcCidrs,
  recordSetIdentifier,
  regionSuffix,
} from '../src/cdk/regions';
import { makeSynthesizer } from '../src/cdk/synthesizer';

const APP_ID = 'eks-mr-demo';

/**
 * Build the app the way `src/cdk/app.ts` does. Deliberately a re-implementation rather
 * than an import: `app.ts` calls `app.synth()` at module scope, which cannot be driven
 * from a test. The shapes under test (stack names, parameters) are asserted against
 * `regions.ts` — the module both sides share — so a drift between this and `app.ts`
 * shows up as a name mismatch here.
 *
 * ALL stacks are constructed BEFORE any `Template.fromStack` call. `fromStack` synths
 * the whole App, and adding a stack afterwards throws
 * `ConstructTreeModifiedAfterSynth`. Memoized so the 11 assertions share one synth.
 */
let cached: Map<string, Template> | undefined;
const synthAll = (): Map<string, Template> => {
  if (cached) return cached;
  const app = new cdk.App({ analyticsReporting: false });
  const built: Array<[string, cdk.Stack]> = [];

  for (const region of REGIONS) {
    const stackName = `${APP_ID}-${regionSuffix(region)}`;
    built.push([
      stackName,
      new RegionStack(app, stackName, {
        stackName,
        // MUST match app.ts: the default synthesizer injects a BootstrapVersion
        // parameter the real deploy never sees, so omitting this would assert
        // against a template that does not exist.
        synthesizer: makeSynthesizer(),
        env: { region: region.name },
        appId: APP_ID,
        regionName: region.name,
        defaultVpcCidr: region.cidr,
        withPrimaryDatabase: region.name === PRIMARY_REGION,
        replicateSecretToRegion:
          region.name === PRIMARY_REGION ? REGIONS[1].name : undefined,
        peerVpcCidrs: peerVpcCidrs(region.name),
      }),
    ]);
  }

  // Peering sits between the region stacks and the singletons, mirroring app.ts and the
  // deploy factory's Phase 3.
  const peerName = `${APP_ID}-${PEERING_SUFFIX}`;
  built.push([
    peerName,
    new PeeringStack(app, peerName, {
      stackName: peerName,
      synthesizer: makeSynthesizer(),
      env: { region: PRIMARY_REGION },
      appId: APP_ID,
    }),
  ]);

  const gdName = `${APP_ID}-${GLOBAL_DATA_SUFFIX}`;
  built.push([
    gdName,
    new GlobalDataStack(app, gdName, {
      stackName: gdName,
      synthesizer: makeSynthesizer(),
      env: { region: PRIMARY_REGION },
      appId: APP_ID,
    }),
  ]);

  const sdName = `${APP_ID}-${SECONDARY_DB_SUFFIX}`;
  built.push([
    sdName,
    new SecondaryDbStack(app, sdName, {
      stackName: sdName,
      synthesizer: makeSynthesizer(),
      env: { region: REGIONS[1].name },
      appId: APP_ID,
      regionName: REGIONS[1].name,
    }),
  ]);

  // DNS deploys LAST (factory Phase 6): its alias targets are Kubernetes-created load
  // balancers, discovered by the installer phases. Constructed here in deploy order
  // like everything else — position in this list is documentation, not behaviour.
  const dnsName = `${APP_ID}-${DNS_SUFFIX}`;
  built.push([
    dnsName,
    new DnsStack(app, dnsName, {
      stackName: dnsName,
      synthesizer: makeSynthesizer(),
      env: { region: PRIMARY_REGION },
      appId: APP_ID,
    }),
  ]);

  // Load generator after dns: its tasks resolve the record the dns stack creates.
  const lgName = `${APP_ID}-${LOADGEN_SUFFIX}`;
  built.push([
    lgName,
    new LoadGenStack(app, lgName, {
      stackName: lgName,
      synthesizer: makeSynthesizer(),
      env: { region: PRIMARY_REGION },
      appId: APP_ID,
    }),
  ]);

  // ARC plan + the standby's regional access entry, both after dns.
  const rsName = `${APP_ID}-${FAILOVER_SUFFIX}`;
  built.push([
    rsName,
    new FailoverStack(app, rsName, {
      stackName: rsName,
      synthesizer: makeSynthesizer(),
      env: { region: PRIMARY_REGION },
      appId: APP_ID,
    }),
  ]);
  const saName = `${APP_ID}-${STANDBY_ACCESS_SUFFIX}`;
  built.push([
    saName,
    new StandbyAccessStack(app, saName, {
      stackName: saName,
      synthesizer: makeSynthesizer(),
      env: { region: REGIONS[1].name },
      appId: APP_ID,
    }),
  ]);

  // The observer VPC + bastion (step 12), a third region. Built after the region stacks
  // whose VPC ids it consumes as parameters.
  const observerName = `${APP_ID}-${OBSERVER_SUFFIX}`;
  built.push([
    observerName,
    new ObserverStack(app, observerName, {
      stackName: observerName,
      synthesizer: makeSynthesizer(),
      env: { region: OBSERVER_REGION },
      appId: APP_ID,
    }),
  ]);

  // The per-region operator access doors (step 12), reached through the observer bastion.
  for (const region of REGIONS) {
    const accessName = `${APP_ID}-${operatorAccessSuffix(region)}`;
    built.push([
      accessName,
      new OperatorAccessStack(app, accessName, {
        stackName: accessName,
        synthesizer: makeSynthesizer(),
        env: { region: region.name },
        appId: APP_ID,
        regionName: region.name,
      }),
    ]);
  }

  cached = new Map(built.map(([name, stack]) => [name, Template.fromStack(stack)]));
  return cached;
};

/** Only the per-region stacks — several assertions are region-scoped. */
const regionStacks = (): Map<string, Template> =>
  new Map(
    [...synthAll()].filter(([name]) =>
      REGIONS.some((r) => name === `${APP_ID}-${regionSuffix(r)}`),
    ),
  );

describe('topology', () => {
  it('synthesizes a stack per region plus the two data singletons, and retires DemoStack', () => {
    const stacks = [...synthAll().keys()];
    expect(stacks).toEqual([
      `${APP_ID}-region-us-east-2`,
      `${APP_ID}-region-us-west-2`,
      `${APP_ID}-${PEERING_SUFFIX}`,
      `${APP_ID}-globaldata`,
      `${APP_ID}-secondarydb`,
      `${APP_ID}-${DNS_SUFFIX}`,
      `${APP_ID}-${LOADGEN_SUFFIX}`,
      `${APP_ID}-${FAILOVER_SUFFIX}`,
      `${APP_ID}-${STANDBY_ACCESS_SUFFIX}`,
      `${APP_ID}-${OBSERVER_SUFFIX}`,
      ...REGIONS.map((r) => `${APP_ID}-${operatorAccessSuffix(r)}`),
    ]);
    expect(stacks).not.toContain(`${APP_ID}-demo`);
  });

  it('lists exactly the stacks that exist — no orphans in either direction', () => {
    // Both directions matter, and they fail differently:
    //   suffix with no stack  → packaging dies on a missing .assets.json (loud, early)
    //   stack with no suffix  → never packaged, so the DEPLOY asks CloudFormation for a
    //                           template nobody uploaded (green build, green synth,
    //                           failure only on a live deploy — the C-2 defect)
    // Asserted against what synth actually produces, not against a hand-written list.
    const synthesized = [...synthAll().keys()].map((s) => s.replace(`${APP_ID}-`, ''));
    expect([...STACK_SUFFIXES].sort()).toEqual(synthesized.sort());
  });

  it('derives stack suffixes in the region-<name> form the deploy factory generates', () => {
    // The deploy factory names multi-region stacks `$PROJECT_NAME-region-${r.name}`.
    // A short form (use2) would package one name and deploy another: green build,
    // failed deploy. Asserting the FORM, not just equality, catches a future rename.
    for (const region of REGIONS) {
      expect(regionSuffix(region)).toBe(`region-${region.name}`);
    }
    expect(STACK_SUFFIXES).toEqual([
      'region-us-east-2',
      'region-us-west-2',
      PEERING_SUFFIX,
      GLOBAL_DATA_SUFFIX,
      SECONDARY_DB_SUFFIX,
      DNS_SUFFIX,
      LOADGEN_SUFFIX,
      FAILOVER_SUFFIX,
      STANDBY_ACCESS_SUFFIX,
      OBSERVER_SUFFIX,
      ...REGIONS.map((r) => operatorAccessSuffix(r)),
    ]);
  });

  it('declares a peering stack — DNS resolves names, it does not move packets', () => {
    // This inverts an earlier assertion. D-008 dropped peering after tracing what used a
    // cross-region VPC path: Aurora replication (rides the AWS network), ARC Region switch
    // (per-region endpoints), traffic shifting (DNS). All three were correct, and all three
    // missed the client: the load generator lives in ONE region and follows DNS to whichever
    // region is active, so it needs a route to the other region's INTERNAL load balancer.
    expect(STACK_SUFFIXES).toContain('peering');
    // Position matters — after both region stacks (whose VPCs it peers) and before the
    // singletons, matching the deploy factory's Phase 3.
    const idx = STACK_SUFFIXES.indexOf('peering');
    expect(idx).toBe(REGIONS.length);
  });
});

describe('deploy parameter contract', () => {
  // Asserted INDIVIDUALLY, never as one alternation, so a failure names the missing
  // parameter instead of reporting "one of these four is absent".
  const REQUIRED = ['AssetsBucketName', 'AssetsBucketPrefix', 'VpcCidr', 'AllowedCidr'];

  for (const name of REQUIRED) {
    it(`declares ${name} in every region stack`, () => {
      for (const [stackName, template] of regionStacks()) {
        const params = Object.keys(template.toJSON().Parameters ?? {});
        expect({ stackName, params }).toEqual({
          stackName,
          params: expect.arrayContaining([name]),
        });
      }
    });
  }

  it('leaves AllowedCidr to the auth construct — declared once, verbatim logical id', () => {
    // AllowedCidrSecurityGroup creates this parameter and calls
    // overrideLogicalId('AllowedCidr') internally. If RegionStack also declared one the
    // logical ids would collide; if the override ever broke, the id would carry a hash
    // suffix and deploy-stack.sh would pass a parameter the template does not have.
    for (const [, template] of regionStacks()) {
      const params = Object.keys(template.toJSON().Parameters ?? {});
      expect(params.filter((p) => p.startsWith('AllowedCidr'))).toEqual(['AllowedCidr']);
    }
  });

  it('threads every declared parameter from the deploy task (both directions)', () => {
    // THE cross-file contract test. Six defects in this project were two things that
    // had to agree, in different files, with nothing checking them — and four produced
    // a green build with a broken deploy. This asserts the synthesized template and the
    // generated deploy task agree, in BOTH directions.
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    );
    const deploySteps: string[] = (tasks.tasks.deploy?.steps ?? [])
      .map((s: { exec?: string }) => s.exec ?? '')
      .filter(Boolean);
    const deployText = deploySteps.join('\n');

    // AssetsBucketName / AssetsBucketPrefix are appended unconditionally by
    // build/deploy-stack.sh, so they are threaded by construction and are asserted
    // present in the template above rather than searched for here.
    const APPENDED_BY_SCRIPT = ['AssetsBucketName', 'AssetsBucketPrefix'];
    // AllowedCidr is deliberately NOT threaded: it is rotated by a console update on
    // the deployed stack, and passing it would reset the operator's value on every
    // deploy. Its default is deny-all, which is the intended post-deploy state.
    const INTENTIONALLY_NOT_THREADED = ['AllowedCidr'];

    for (const [stackName, template] of synthAll()) {
      const params = (template.toJSON().Parameters ?? {}) as Record<string, { Type?: string; Default?: unknown }>;
      const declared = Object.keys(params);
      // CDK's ssm.StringParameter.valueForTypedStringParameterV2 materializes as a
      // parameter of type AWS::SSM::Parameter::Value<...> WITH a Default naming the SSM
      // path (the observer bastion's AL2023 AMI). CloudFormation resolves it at deploy
      // time from that default; there is nothing for the rail to thread. Recognised by
      // TYPE + Default, never by CDK's generated name, so a hand-declared SSM parameter
      // with no default would still be caught.
      const RESOLVED_BY_CFN = declared.filter(
        (p) => (params[p].Type ?? '').startsWith('AWS::SSM::Parameter::Value<') && params[p].Default !== undefined,
      );
      const mustThread = declared.filter(
        (p) => !APPENDED_BY_SCRIPT.includes(p) && !INTENTIONALLY_NOT_THREADED.includes(p)
          && !RESOLVED_BY_CFN.includes(p),
      );
      for (const p of mustThread) {
        expect({ stackName, param: p, threaded: deployText.includes(`${p}=`) }).toEqual({
          stackName,
          param: p,
          threaded: true,
        });
      }
    }

    // Reverse direction: every parameter the deploy task passes must exist in some
    // template, or CloudFormation rejects the changeset with
    //   Parameters: [X] do not exist in the template
    const allDeclared = new Set<string>();
    for (const [, template] of synthAll()) {
      Object.keys(template.toJSON().Parameters ?? {}).forEach((p) => allDeclared.add(p));
    }
    const threaded = [...deployText.matchAll(/([A-Za-z][A-Za-z0-9]*)=\$REGION_/g)].map(
      (m) => m[1],
    );
    for (const p of new Set(threaded)) {
      expect({ param: p, declared: allDeclared.has(p) }).toEqual({
        param: p,
        declared: true,
      });
    }
  });
});

describe('observability wiring (coherence finding C-1)', () => {
  it('gives each region a DISTINCT dashboard name', () => {
    // The green stub used `${appId}-demo`, identical in both regions, which would
    // produce colliding dashboard names as soon as there is more than one region.
    const names = [...regionStacks().values()].map((t) => {
      const dashboards = t.findResources('AWS::CloudWatch::Dashboard');
      return Object.values(dashboards)[0]?.Properties?.DashboardName;
    });
    expect(names.length).toBe(REGIONS.length);
    expect(new Set(names).size).toBe(REGIONS.length);
  });

  it('renders each dashboard against its OWN region (F-005)', () => {
    // The dashboard region MUST equal the region of the EMF log group it reads.
    for (const region of REGIONS) {
      const stackName = `${APP_ID}-${regionSuffix(region)}`;
      const body = JSON.stringify(
        regionStacks().get(stackName)!.findResources('AWS::CloudWatch::Dashboard'),
      );
      expect({ stackName, mentionsOwnRegion: body.includes(region.name) }).toEqual({
        stackName,
        mentionsOwnRegion: true,
      });
    }
  });
});

describe('EKS (step 2)', () => {
  // region-scoped: the singleton stacks have no EKS
  it('creates exactly one cluster and one managed node group per region', () => {
    for (const [stackName, template] of regionStacks()) {
      expect({
        stackName,
        clusters: Object.keys(template.findResources('AWS::EKS::Cluster')).length,
        nodegroups: Object.keys(template.findResources('AWS::EKS::Nodegroup')).length,
      }).toEqual({ stackName, clusters: 1, nodegroups: 1 });
    }
  });

  it('sets authenticationMode explicitly — the CFN default breaks access entries', () => {
    // THE most consequential single property in this stack. CloudFormation-created
    // clusters default to CONFIG_MAP, under which EKS access entries silently do
    // nothing — so the ARC plan's EKS scaling step would fail at EXECUTION time while
    // synth, deploy and plan evaluation all look correct. Asserted per region because
    // the failure is invisible until the failover runs.
    for (const [stackName, template] of regionStacks()) {
      const cluster = Object.values(template.findResources('AWS::EKS::Cluster'))[0];
      expect({
        stackName,
        mode: cluster.Properties?.AccessConfig?.AuthenticationMode,
      }).toEqual({ stackName, mode: 'API_AND_CONFIG_MAP' });
    }
  });

  it('does NOT grant the CI deploy role a standing cluster-admin entry', () => {
    // The CFN default is true, which gives the cluster creator — the CI deploy role,
    // assumed by a runner on the public internet — a cluster-admin access entry. With the
    // API endpoint private that grant is inert, so it buys nothing while staying a live
    // path if the endpoint is ever widened. The only principal granted cluster access is
    // the in-VPC installer.
    //
    // Break-glass is unaffected: access entries are created through the EKS CONTROL API,
    // reachable from anywhere. Changing this property later REPLACES the cluster, which is
    // why it is set now.
    for (const [stackName, template] of regionStacks()) {
      const cluster = Object.values(template.findResources('AWS::EKS::Cluster'))[0];
      expect({
        stackName,
        bootstrap: cluster.Properties?.AccessConfig?.BootstrapClusterCreatorAdminPermissions,
      }).toEqual({ stackName, bootstrap: false });
    }
  });

  it('uses an AMI and node role that make FIS node targeting possible (F-002)', () => {
    // The shipped network faults reach nodes via aws:ssm:send-command, so the node
    // needs the SSM agent (AL2023 standard AMI) AND SSM registration permission. If
    // either is missing, injection silently targets nothing.
    //
    // Changed from AL2023_x86_64_STANDARD to the ARM variant in step 3b: the app image is
    // built by kaniko on arm64 runners and kaniko cannot cross-build, so x86 nodes would
    // CrashLoopBackOff with `exec format error`. Same AMI family, so the SSM-agent
    // property this test exists for is unchanged — see the step 3b arch test.
    for (const [stackName, template] of regionStacks()) {
      const ng = Object.values(template.findResources('AWS::EKS::Nodegroup'))[0];
      expect({ stackName, amiType: ng.Properties?.AmiType }).toEqual({
        stackName,
        amiType: 'AL2023_ARM_64_STANDARD',
      });
      const roles = template.findResources('AWS::IAM::Role');
      const hasSsm = Object.values(roles).some((r) =>
        JSON.stringify(r.Properties?.ManagedPolicyArns ?? []).includes(
          'AmazonSSMManagedInstanceCore',
        ),
      );
      expect({ stackName, hasSsm }).toEqual({ stackName, hasSsm: true });
    }
  });

  it('managed nodes carry IMDS hop limit 2 via a launch template, BOTH regions', () => {
    // Codifies the 2026-08-27 live hot-fix. MNG defaults to hop limit 1; pods on the
    // pod network need 2 hops, and with node-role-only credentials (no IRSA) hop 1
    // means boto3 finds NO credentials: every request 500s with "Unable to locate
    // credentials" while /health (no AWS call) stays green. The Karpenter EC2NodeClass
    // already sets 2 -- this asserts the managed nodes match.
    for (const [stackName, template] of regionStacks()) {
      const lts = Object.values(template.findResources('AWS::EC2::LaunchTemplate')) as any[];
      const withImds = lts.filter(
        (lt) => lt.Properties?.LaunchTemplateData?.MetadataOptions?.HttpPutResponseHopLimit === 2
          && lt.Properties?.LaunchTemplateData?.MetadataOptions?.HttpTokens === 'required',
      );
      expect({ stackName, imdsLts: withImds.length }).toEqual({ stackName, imdsLts: 1 });
      // And the node group actually REFERENCES it -- a declared-but-unthreaded launch
      // template changes nothing (the CfnCluster.version lesson, same shape).
      const ng = Object.values(template.findResources('AWS::EKS::Nodegroup'))[0] as any;
      expect({ stackName, ltRef: JSON.stringify(ng.Properties?.LaunchTemplate ?? {}) })
        .toEqual({ stackName, ltRef: expect.stringContaining('NodeLaunchTemplate') });
    }
  });

  it('BOTH node roles carry the db-secret read grant -- managed AND Karpenter', () => {
    // Codifies the 2026-08-27 live hot-fix (inline policy demo-db-secret-read). Pods
    // use node-role credentials; ARC's Day 2 scale-up lands pods on KARPENTER nodes,
    // so a grant only on the managed node group role fails exactly when scaling
    // matters -- AccessDeniedException on GetSecretValue, mid-failover.
    for (const [stackName, template] of regionStacks()) {
      const policies = {
        ...template.findResources('AWS::IAM::Policy'),
      } as Record<string, any>;
      const grantingPolicies = Object.values(policies).filter((p) =>
        JSON.stringify(p.Properties?.PolicyDocument ?? {}).includes('secretsmanager:GetSecretValue'),
      );
      const roleNames = grantingPolicies.flatMap((p) =>
        (p.Properties?.Roles ?? []).map((r: any) => JSON.stringify(r)),
      );
      const touchesMng = roleNames.some((r) => r.includes('NodeRole') && !r.includes('Karpenter'));
      const touchesKarpenter = roleNames.some((r) => r.includes('Karpenter'));
      expect({ stackName, touchesMng, touchesKarpenter }).toEqual({
        stackName, touchesMng: true, touchesKarpenter: true,
      });
    }
  });

  it('every dashboard widget reads metrics from the PRIMARY region, BOTH dashboards', () => {
    // Codifies the 2026-08-27 mid-demo finding: the load generator is the only metrics
    // emitter and EMF lands in ITS region (the primary) -- including the
    // Region=us-west-2 series. A standby dashboard whose widgets query us-west-2
    // CloudWatch is structurally empty forever; failover moves where requests are
    // SERVED, not where the emitter writes. Widgets support cross-region metrics.
    for (const [stackName, template] of regionStacks()) {
      const dashboards = Object.values(template.findResources('AWS::CloudWatch::Dashboard')) as any[];
      expect(dashboards.length).toBeGreaterThanOrEqual(1);
      // Resolve the Fn::Join to literal JSON (same technique as the Op-row test).
      const bodyProp = dashboards[0].Properties?.DashboardBody;
      const parts = (bodyProp?.['Fn::Join']?.[1] ?? [bodyProp]) as unknown[];
      const body = parts.map((x) => (typeof x === 'string' ? x : 'X')).join('');
      // Every region stamp inside the dashboard body must be the primary region --
      // one us-west-2 stamp on the standby means an empty widget on stage.
      const regionStamps = [...body.matchAll(/"region":\s*"(us-[a-z]+-\d)"/g)].map((m) => m[1]);
      expect(regionStamps.length).toBeGreaterThan(0);
      expect({ stackName, offRegion: regionStamps.filter((r) => r !== PRIMARY_REGION) })
        .toEqual({ stackName, offRegion: [] });
    }
  });

  it('leaves node-group headroom for the failover scaling step', () => {
    // The ARC plan raises the activated region by targetPercent. If maxSize equals
    // desiredSize the step has nowhere to go and the failover appears to succeed while the
    // standby stays at steady-state capacity.
    for (const [stackName, template] of regionStacks()) {
      const sc = Object.values(template.findResources('AWS::EKS::Nodegroup'))[0]
        .Properties?.ScalingConfig;
      expect({ stackName, headroom: sc.MaxSize >= sc.DesiredSize * 2 }).toEqual({
        stackName,
        headroom: true,
      });
    }
  });

  it('one ARC round trip inside a 24h window fits under the pod ceiling (bug class 12b)', () => {
    // ARC sizes the target from the SOURCE region's 24-hour max replica count times
    // targetPercent, and EKS offers no other monitoring approach and no reset. So inside one
    // window each execution feeds the next: fail-over asks ceil(floor x p), fail-back asks
    // ceil(that x p). At 200 that was 3 -> 6 -> 12 against a ceiling of 10, and the 2026-09-09
    // fail-back (us-east-2/0e76faf068eeec41) sat in scale-target-capacity for its whole
    // timeout. The ceiling itself is a three-way contract -- HPA maxReplicas, Karpenter's
    // vCPU limit, and the managed node group -- because required one-pod-per-node
    // anti-affinity makes every pod cost a node. Every number below is READ from the file
    // that owns it; a literal here would pass for the wrong reason the day one of them moved.
    const strip = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    const failoverSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'failover-stack.ts'), 'utf8');
    const appYaml = strip(fs.readFileSync(path.join(__dirname, '..', 'k8s', 'app.yaml'), 'utf8'));
    const nodepool = strip(fs.readFileSync(
      path.join(__dirname, '..', 'k8s', 'karpenter-nodepool.yaml'), 'utf8'));

    const targetPercent = Number(failoverSrc.match(/^\s*targetPercent: (\d+),/m)![1]);
    const hpa = appYaml.split('\n---\n').find((d) => d.includes('kind: HorizontalPodAutoscaler'))!;
    const minReplicas = Number(hpa.match(/minReplicas: (\d+)/)![1]);
    const maxReplicas = Number(hpa.match(/maxReplicas: (\d+)/)![1]);
    // Karpenter ceiling in pods: vCPU limit / vCPU per permitted node. The NodePool admits
    // m7g.large (2 vCPU) and m7g.xlarge (4); the pessimistic per-pod cost is the SMALLER node
    // since one pod per node means a .large spends 2 vCPU of the budget per pod.
    const karpenterCpu = Number(nodepool.match(/limits:\s*\n\s*cpu: '(\d+)'/)![1]);
    expect(nodepool).toMatch(/values: \['m7g\.large', 'm7g\.xlarge'\]/);
    const karpenterPods = Math.floor(karpenterCpu / 2);
    // Managed node group baseline: one pod per node, so its desiredSize is pods too. Both
    // regions must agree (the standby is the one that receives the surge).
    const desiredSizes = [...regionStacks().values()].map((template) =>
      Object.values(template.findResources('AWS::EKS::Nodegroup'))[0]
        .Properties?.ScalingConfig.DesiredSize as number);
    expect(new Set(desiredSizes).size).toBe(1);
    const baselineNodes = desiredSizes[0];
    const podCeiling = Math.min(maxReplicas, karpenterPods + baselineNodes);

    const p = targetPercent / 100;
    const failover = Math.ceil(minReplicas * p);
    const failback = Math.ceil(failover * p);
    // Both executions of one round trip must be satisfiable. At 200 this is 6 then 12 > 10.
    // Object form so a failure prints every input, not just "12 > 10".
    expect({
      targetPercent,
      minReplicas,
      podCeiling,
      failover,
      failback,
      fits: failover <= podCeiling && failback <= podCeiling,
    })
      .toEqual({ targetPercent, minReplicas, podCeiling, failover, failback, fits: true });
    // And the two ceilings must AGREE: an HPA max above what nodes can hold would let ARC
    // scale the Deployment to replicas that stay Pending forever with the step reporting
    // progress; an HPA max below it wastes Karpenter budget. Live-patching one without the
    // other (2026-09-10, 12 vs 20 vCPU) is exactly the drift this catches.
    expect(maxReplicas).toBe(karpenterPods + baselineNodes);
  });

  it('stays a pure declaration — no kubectl provider custom resource', () => {
    // Guards the L1 choice. Swapping in the eks.Cluster L2 would add a
    // kubectl-provider custom resource and a new dependency, breaking the pinned
    // cdkVersion posture.
    for (const [stackName, template] of regionStacks()) {
      const custom = Object.keys(template.toJSON().Resources ?? {}).filter((k) =>
        JSON.stringify(template.toJSON().Resources[k].Type).includes('KubectlProvider'),
      );
      expect({ stackName, kubectlProviders: custom }).toEqual({
        stackName,
        kubectlProviders: [],
      });
    }
  });

  it('exports the cluster ARN attribute, not the cluster name', () => {
    // ARC's EksClusterProperty.clusterArn is REQUIRED and takes an ARN. Exporting the
    // name here would be accepted by synth and rejected by the service.
    for (const [stackName, template] of regionStacks()) {
      const outputs = template.toJSON().Outputs ?? {};
      expect({ stackName, hasArnOutput: 'EksClusterArn' in outputs }).toEqual({
        stackName,
        hasArnOutput: true,
      });
      expect(JSON.stringify(outputs.EksClusterArn.Value)).toContain('Arn');
    }
  });
});

describe('Aurora Global Database (step 1b)', () => {
  const primary = () => synthAll().get(`${APP_ID}-region-us-east-2`)!;
  const secondary = () => synthAll().get(`${APP_ID}-secondarydb`)!;
  const globalData = () => synthAll().get(`${APP_ID}-${GLOBAL_DATA_SUFFIX}`)!;

  it('pins 16.8 on BOTH members and never 16.6 anywhere', () => {
    // G-001. RDS retired 16.6 in July 2026 but it is STILL in the CDK enum, so a stack
    // pinning it compiles, synthesizes and passes every local gate — then is rejected by
    // RDS at deploy. Checked as raw template text so a hardcoded string cannot slip past
    // the enum.
    for (const [label, t] of [['primary', primary()], ['secondary', secondary()]] as const) {
      const clusters = Object.values(t.findResources('AWS::RDS::DBCluster'));
      expect({ label, count: clusters.length }).toEqual({ label, count: 1 });
      expect({ label, version: clusters[0].Properties?.EngineVersion }).toEqual({
        label,
        version: expect.stringContaining('16.8'),
      });
    }
    for (const [name, t] of synthAll()) {
      expect({ name, has166: JSON.stringify(t.toJSON()).includes('16.6') }).toEqual({
        name,
        has166: false,
      });
    }
  });

  it('makes the primary a SOURCE and the secondary a JOINER, never both', () => {
    // The asymmetry is the crux of the whole ordering problem, and getting it backwards
    // deploys "successfully" into a broken global cluster.
    //   primary   → NO globalClusterIdentifier; the global cluster adopts it via
    //               sourceDbClusterIdentifier. Setting it here reintroduces a
    //               CloudFormation delete-time 404 race on teardown.
    //   secondary → HAS globalClusterIdentifier; it joins an existing cluster.
    const p = Object.values(primary().findResources('AWS::RDS::DBCluster'))[0];
    expect(p.Properties?.GlobalClusterIdentifier).toBeUndefined();

    const s = Object.values(secondary().findResources('AWS::RDS::DBCluster'))[0];
    expect(s.Properties?.GlobalClusterIdentifier).toBeDefined();
  });

  it('strips master credentials and database name from the joining member', () => {
    // RDS rejects a member that joins a global cluster while declaring any of these —
    // it inherits all three by replication.
    const s = Object.values(secondary().findResources('AWS::RDS::DBCluster'))[0];
    for (const prop of ['MasterUsername', 'MasterUserPassword', 'DatabaseName']) {
      expect({ prop, present: prop in (s.Properties ?? {}) }).toEqual({
        prop,
        present: false,
      });
    }
  });

  it('creates exactly one global cluster, adopting the primary by parameter', () => {
    const globals = Object.values(globalData().findResources('AWS::RDS::GlobalCluster'));
    expect(globals.length).toBe(1);
    // Adoption, not declaration: SourceDBClusterIdentifier comes from the primary
    // stack's output threaded in as a parameter.
    expect(globals[0].Properties?.SourceDBClusterIdentifier).toBeDefined();
    // Engine/EngineVersion must NOT be set alongside adoption — mutually exclusive in
    // RDS, and the version is pinned once on the members.
    expect(globals[0].Properties?.Engine).toBeUndefined();
    expect(globals[0].Properties?.EngineVersion).toBeUndefined();
  });

  it('gives every member its own CMK', () => {
    for (const [label, t] of [['primary', primary()], ['secondary', secondary()]] as const) {
      const keys = Object.keys(t.findResources('AWS::KMS::Key'));
      expect({ label, keys: keys.length }).toEqual({ label, keys: 1 });
    }
  });

  /**
   * The AZ index each cluster member is pinned to, read out of the synthesized
   * `AvailabilityZone`. Both members express it as `Fn::Select[index, <az list>]` — the
   * primary over `Fn::GetAZs`, the secondary over a split CommaDelimitedList parameter —
   * so the INDEX is comparable across stacks even though the AZ names are deploy-time.
   */
  const azIndexesOf = (t: Template): number[] =>
    Object.values(t.findResources('AWS::RDS::DBInstance'))
      .map((i) => i.Properties?.AvailabilityZone?.['Fn::Select']?.[0])
      .sort((a, b) => a - b);

  it('runs every member on Aurora Serverless v2, with no provisioned class left', () => {
    for (const [label, t] of [['primary', primary()], ['secondary', secondary()]] as const) {
      const instances = Object.values(t.findResources('AWS::RDS::DBInstance'));
      const classes = instances.map((i) => i.Properties?.DBInstanceClass);
      expect({ label, classes }).toEqual({
        label,
        classes: classes.map(() => 'db.serverless'),
      });
      // `db.serverless` is orderable for aurora-postgresql 16.8 in every AZ of both
      // regions (live-checked 2026-09-04), so the engine pin stays put. Asserted as raw
      // text so a provisioned class cannot return via an escape hatch.
      expect({ label, provisioned: /"db\.(r|m|t|c)\d/.test(JSON.stringify(t.toJSON())) })
        .toEqual({ label, provisioned: false });
    }
  });

  it('declares a capacity range on both members, bounded on BOTH sides', () => {
    // A range is MANDATORY: RDS rejects a db.serverless instance on a cluster with no
    // ServerlessV2ScalingConfiguration. The bounds are two-sided on purpose — the
    // one-sided version of this test would pass for a floor of 0.5 (which reintroduces
    // scaling variance into every calibrated FIS severity number) and for a ceiling of
    // 256 (which is an unbounded bill, not a capacity plan).
    expect(AURORA_MIN_ACU).toBeGreaterThanOrEqual(1);
    expect(AURORA_MIN_ACU).toBeLessThanOrEqual(AURORA_MAX_ACU);
    expect(AURORA_MAX_ACU).toBeLessThanOrEqual(32);
    for (const [label, t] of [['primary', primary()], ['secondary', secondary()]] as const) {
      const c = Object.values(t.findResources('AWS::RDS::DBCluster'))[0];
      // Identical on both members, because a secondary whose ceiling is below the
      // primary's cannot keep up with replication.
      expect({ label, cfg: c.Properties?.ServerlessV2ScalingConfiguration }).toEqual({
        label,
        cfg: { MinCapacity: AURORA_MIN_ACU, MaxCapacity: AURORA_MAX_ACU },
      });
    }
  });

  it('spreads three members one per AZ in BOTH regions', () => {
    for (const [label, t] of [['primary', primary()], ['secondary', secondary()]] as const) {
      expect({ label, azIndexes: azIndexesOf(t) }).toEqual({ label, azIndexes: [0, 1, 2] });
    }
  });

  it('leaves no AZ whose power blackhole can take the whole database', () => {
    /**
     * THE REGRESSION GUARD FOR 2026-09-04, and the reason this construct has readers.
     *
     * The AZ power-interruption fault's `aws:network:disrupt-connectivity` action
     * blackholes the faulted zone's subnets by the `AzImpairmentPower: DisruptSubnet`
     * tag — and those are the SAME subnets as the Aurora DB subnet group. With a
     * single-instance cluster in us-east-2b, faulting that zone cut the region's only
     * database out from under all three AZs: regional availability read 0.00%, FIS's own
     * 50% guardrail halted the experiment three minutes in, and a fault the demo calls
     * single-AZ was region-wide one time in three.
     *
     * Derived rather than hardcoded: the blast set comes from the tagged subnets in the
     * template, so adding a fourth AZ, or dropping a member back to one instance, fails
     * here instead of during a customer demo.
     */
    const t = primary();
    const disruptable = new Set(
      Object.values(t.findResources('AWS::EC2::Subnet'))
        .filter((s) => (s.Properties?.Tags ?? []).some(
          (tag: { Key: string; Value: string }) =>
            tag.Key === 'AzImpairmentPower' && tag.Value === 'DisruptSubnet',
        ))
        .map((s) => s.Properties?.AvailabilityZone?.['Fn::Select']?.[0]),
    );
    expect(disruptable.size).toBeGreaterThan(1); // else the fault is not zonal at all

    const members = azIndexesOf(t);
    for (const az of disruptable) {
      const survivors = members.filter((i) => i !== az);
      expect({ az, survivors: survivors.length }).toEqual({
        az,
        survivors: members.length - 1,
      });
      expect(survivors.length).toBeGreaterThan(0);
    }
  });

  it('keeps exactly one reader failover-ready and one scaling on read load', () => {
    // For Aurora Serverless v2 the promotion tier controls CAPACITY as well as failover
    // order: tier 0-1 is held at least at the writer's capacity, tier 2-15 idles down to
    // the cluster floor. So the split is a deliberate cost/readiness trade, and a drift
    // to all-tier-1 (double cost) or all-tier-2 (cold failover) is a real change.
    //
    // Tier and AZ are pinned as PAIRS rather than as two independent sets, because the
    // property that matters is that the failover-ready reader is in a DIFFERENT zone
    // from the writer — which two separate assertions would each pass without proving.
    for (const [label, t] of [['primary', primary()], ['secondary', secondary()]] as const) {
      const pairs = Object.values(t.findResources('AWS::RDS::DBInstance'))
        .map((i) => `tier${i.Properties?.PromotionTier}@az${i.Properties?.AvailabilityZone?.['Fn::Select']?.[0]}`)
        .sort();
      expect({ label, pairs }).toEqual({
        label,
        pairs: [
          `tier0@az${AURORA_WRITER_AZ_INDEX}`, // writer — CDK pins the writer at tier 0
          `tier1@az${AURORA_READER_AZ_INDEXES[0]}`, // designated failover target
          `tier2@az${AURORA_READER_AZ_INDEXES[1]}`, // read capacity, idles to the floor
        ].sort(),
      });
    }
  });

  it('deploys the global cluster BEFORE the joining member', () => {
    // The ordering that forced the stack split. Asserted on the generated deploy task,
    // because nothing in synth can catch it: both stacks synthesize perfectly and only
    // the deploy sequence makes them correct.
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    );
    const execs: string[] = tasks.tasks.deploy.steps
      .map((s: { exec?: string }) => s.exec ?? '')
      .filter(Boolean);
    const gdIdx = execs.findIndex((e) => e.includes(`-${GLOBAL_DATA_SUFFIX}"`));
    const sdIdx = execs.findIndex((e) => e.includes(`-${SECONDARY_DB_SUFFIX}"`));
    expect(gdIdx).toBeGreaterThanOrEqual(0);
    expect(sdIdx).toBeGreaterThanOrEqual(0);
    expect(gdIdx).toBeLessThan(sdIdx);
  });

  it('sources the dotenvs each singleton depends on, via the bash -c wrapper', () => {
    // projen's shell rejects `set -a`, so a dotenv-sourcing step must run inside one
    // real bash. This is the demo path that actually exercises that fix.
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    );
    const execs: string[] = tasks.tasks.deploy.steps
      .map((s: { exec?: string }) => s.exec ?? '')
      .filter(Boolean);
    const sd = execs.find((e) => e.includes(`-${SECONDARY_DB_SUFFIX}"`))!;
    expect(sd.startsWith("bash -c '")).toBe(true);
    expect(sd).not.toContain('set -a');
    expect(sd).toContain(`dist/$PROJECT_NAME-${GLOBAL_DATA_SUFFIX}.env`);
    expect(sd).toContain('dist/$PROJECT_NAME-region-us-west-2.env');
  });
});

describe('private-cluster prerequisites (step 3a)', () => {
  // Both of these are invisible to synth AND to CloudFormation. They fail as a node
  // group that never becomes ready, or a Service that stays <pending> forever.
  const REQUIRED_INTERFACE_ENDPOINTS = [
    'ec2',
    'ecr.api',
    'ecr.dkr',
    'sts',
    'logs',
    // Required by the in-cluster AWS Load Balancer Controller (single-AZ / zonal-shift
    // feature). The controller is a POD in these no-NAT subnets, so without this endpoint
    // its ELB API calls fail as a connect timeout and the migrated Service never
    // provisions an NLB — a failure synth cannot see, because the template is identical
    // either way.
    'elasticloadbalancing',
  ];

  for (const svc of REQUIRED_INTERFACE_ENDPOINTS) {
    it(`creates the ${svc} interface endpoint in every region`, () => {
      // These subnets have no NAT and no internet gateway. AWS documents
      // ec2 + ecr.api + ecr.dkr + s3 as the minimum for nodes to JOIN the cluster,
      // plus sts (registration/IRSA) and logs. Without them the managed node group
      // creation simply TIMES OUT — no useful error, roughly 20 wasted minutes.
      // Asserted individually so a failure names the missing endpoint.
      for (const [stackName, template] of regionStacks()) {
        const names = Object.values(template.findResources('AWS::EC2::VPCEndpoint'))
          .map((e) => JSON.stringify(e.Properties?.ServiceName));
        expect({
          stackName,
          svc,
          present: names.some((n) => n.includes(`.${svc}"`) || n.endsWith(`.${svc}"`)),
        }).toEqual({ stackName, svc, present: true });
      }
    });
  }

  it('keeps the S3 GATEWAY endpoint — it carries the image layers', () => {
    for (const [stackName, template] of regionStacks()) {
      const gateways = Object.values(template.findResources('AWS::EC2::VPCEndpoint'))
        .filter((e) => e.Properties?.VpcEndpointType === 'Gateway')
        .map((e) => JSON.stringify(e.Properties?.ServiceName));
      expect({
        stackName,
        s3Gateway: gateways.some((g) => g.includes('s3')),
      }).toEqual({ stackName, s3Gateway: true });
    }
  });

  it('tags EVERY isolated subnet for internal load balancers', () => {
    // The in-tree service controller places an internal load balancer only into subnets
    // carrying kubernetes.io/role/internal-elb=1. Missing it leaves a Service of type
    // LoadBalancer <pending> forever, and CloudFormation reports nothing because
    // Kubernetes owns that object.
    //
    // This test exists because the first implementation iterated
    // `vpc.isolatedSubnets` and silently tagged NOTHING: ParameterizedVpc creates raw
    // CfnSubnets and re-imports the VPC via fromVpcAttributes, so those objects are not
    // the real constructs. Zero tags, zero errors. Counting is the only way to see it.
    for (const [stackName, template] of regionStacks()) {
      const subnets = Object.values(template.findResources('AWS::EC2::Subnet'));
      const tagged = subnets.filter((s) =>
        (s.Properties?.Tags ?? []).some(
          (t: { Key?: string; Value?: string }) =>
            t.Key === 'kubernetes.io/role/internal-elb' && t.Value === '1',
        ),
      );
      expect({ stackName, tagged: tagged.length, total: subnets.length }).toEqual({
        stackName,
        tagged: subnets.length,
        total: subnets.length,
      });
      expect(subnets.length).toBe(AZ_COUNT);
    }
  });
});

describe('app on EKS (step 3b)', () => {
  const primaryStack = `${APP_ID}-${regionSuffix(PRIMARY_REGION)}`;
  const secondaryStack = `${APP_ID}-${regionSuffix(REGIONS[1].name)}`;
  const readManifest = (p: string) =>
    fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  test('sp_query_orders is BOUNDED — LIMIT + newest-first + a partial index to serve it', () => {
    // The unbounded original returned the ENTIRE live table on every GET /orders. Under
    // a continuously-inserting load generator with soft deletes (rows never leave the
    // table), read latency grew linearly with uptime until it crossed the client's 5s
    // timeout — live 2026-08-28: p90 1.7s -> 5.15s over 14h, reads failing at 3,133/hr,
    // which inverts the demo's core story ("reads stay healthy while writes fail").
    // Assert on comment-stripped SQL so the words cannot survive only in a comment.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'schema.py'), 'utf8');
    const sql = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('#'))
      .join('\n');
    const fn = sql.match(/FUNCTION sp_query_orders[\s\S]*?\$\$ LANGUAGE plpgsql/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/ORDER BY created_at DESC\s+LIMIT 100/);
    // The index that keeps the bounded scan O(limit) at any table size: partial on live
    // rows, ordered the way the query walks.
    expect(sql).toMatch(/idx_orders_active_created\s+ON orders \(created_at DESC\) WHERE deleted_at IS NULL/);
  });

  /**
   * THE ARCHITECTURE CONTRACT — the one that would have produced a CrashLoopBackOff.
   *
   * The image is built by kaniko on the arm64 runner fleet, and kaniko cannot cross-build:
   * --custom-platform rewrites the recorded platform without changing what is produced.
   * So the node architecture MUST be arm64 or the pods die with `exec format error`,
   * with nothing in the build, synth or CloudFormation deploy saying so. Step 2 shipped
   * AL2023_x86_64_STANDARD / m5.large before there was an image to run.
   */
  test('node groups are arm64 in every region, matching the arm64 image build', () => {
    for (const region of REGIONS) {
      const t = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      t.hasResourceProperties('AWS::EKS::Nodegroup', {
        AmiType: 'AL2023_ARM_64_STANDARD',
      });
      const groups = t.findResources('AWS::EKS::Nodegroup');
      for (const ng of Object.values(groups)) {
        // Graviton families only. An x86 instance type with an arm64 AMI fails to
        // launch, which at least fails loudly — but the pair must agree regardless.
        // t4g is Graviton burstable — added when the MNG moved to t4g.large for cost;
        // the contract is arm64 pairing, not a performance class.
        for (const it of ng.Properties.InstanceTypes as string[]) {
          expect(it).toMatch(/^(m7g|m6g|c7g|c6g|r7g|r6g|t4g)\./);
        }
      }
    }
  });

  test('every region declares an app image output resolving to its OWN region registry', () => {
    for (const region of REGIONS) {
      const t = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const outputs = t.toJSON().Outputs ?? {};
      const key = Object.keys(outputs).find((k) => k.startsWith('AppImageUri'));
      expect(key).toBeDefined();
      // The repository name embeds the region as a LITERAL (CDK resolves it), which is
      // exactly why build/container-plan.sh must emit one push target per destination
      // rather than one per image hash. Assert the literal so that stays visible.
      expect(JSON.stringify(outputs[key!])).toContain(
        `container-assets-\${AWS::AccountId}-${region.name}`.replace('${', '${'),
      );
    }
  });

  /**
   * Pods have no identity of their own on this cluster (no OIDC provider, no IRSA), so
   * the credential grant has to be on the NODE role. Without it every pod fails at
   * startup — after passing a health probe that makes no database call.
   */
  test('node role can read the credentials secret, scoped to that secret', () => {
    for (const region of REGIONS) {
      const t = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const policies = Object.values(t.findResources('AWS::IAM::Policy'));
      const statements = policies.flatMap(
        (p) => p.Properties.PolicyDocument.Statement as any[],
      );
      const grant = statements.find(
        (s) =>
          (Array.isArray(s.Action) ? s.Action : [s.Action]).includes(
            'secretsmanager:GetSecretValue',
          ),
      );
      expect(grant).toBeDefined();
      // Scoped, not '*'.
      expect(JSON.stringify(grant.Resource)).toContain(`${APP_ID}/db-credentials-*`);
    }
  });

  test('Secrets Manager has a VPC endpoint in every region', () => {
    for (const region of REGIONS) {
      const t = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const services = Object.values(t.findResources('AWS::EC2::VPCEndpoint')).map((e) =>
        JSON.stringify(e.Properties.ServiceName),
      );
      // Fully-isolated subnets: no NAT, no internet gateway. Without this endpoint the
      // pod's GetSecretValue has nowhere to go and times out inside the pod.
      expect(services.some((s) => s.includes('secretsmanager'))).toBe(true);
    }
  });

  /**
   * BUG CLASS GUARD, not a behaviour test.
   *
   * `secretsmanager:GetSecretValue` on a CMK-encrypted secret fails as
   * "Access to KMS is not allowed" unless the caller ALSO has kms:Decrypt. The grant
   * above deliberately omits kms:Decrypt because the generated secret uses the
   * AWS-managed key and Secrets Manager decrypts server-side. If anyone gives the secret
   * a customer-managed key, that assumption silently breaks at runtime — so fail here
   * instead.
   */
  test('the credentials secret uses the AWS-managed key (no KmsKeyId)', () => {
    const t = synthAll().get(primaryStack)!;
    const secrets = Object.values(t.findResources('AWS::SecretsManager::Secret'));
    expect(secrets.length).toBeGreaterThan(0);
    for (const s of secrets) {
      expect(s.Properties.KmsKeyId).toBeUndefined();
    }
  });

  test('the credentials secret is replicated to the secondary region', () => {
    const t = synthAll().get(primaryStack)!;
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      ReplicaRegions: [{ Region: REGIONS[1].name }],
    });
    // And the standby's own stack creates none — it inherits credentials by replication,
    // which is the whole reason a replica is needed.
    const secondaryDb = synthAll().get(`${APP_ID}-${SECONDARY_DB_SUFFIX}`)!;
    expect(
      Object.keys(secondaryDb.findResources('AWS::SecretsManager::Secret')),
    ).toHaveLength(0);
  });

  /**
   * rds.DatabaseCluster creates a security group that admits NOTHING. Without an explicit
   * ingress rule the pods fail every request at the TCP connect while synth, build and
   * deploy all stay green — so assert the rule exists in BOTH regions, sourced from the
   * EKS-managed cluster security group (which is what node instances actually carry,
   * unlike the baseline SG passed to resourcesVpcConfig).
   */
  test('Aurora admits the EKS cluster security group in both regions', () => {
    // Matched on Description, NOT on FromPort. `allowDefaultPortFrom` uses the cluster's
    // OWN port, which renders as an Fn::GetAtt on Endpoint.Port rather than the literal
    // 5432 — asserting 5432 looked right and matched nothing.
    const ruleFor = (t: Template) =>
      Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')).find(
        (r) => r.Properties?.Description === 'EKS node group to Aurora',
      );

    const primaryRule = ruleFor(synthAll().get(primaryStack)!);
    expect(primaryRule).toBeDefined();
    expect(JSON.stringify(primaryRule!.Properties.SourceSecurityGroupId)).toContain(
      'ClusterSecurityGroupId',
    );

    const secondaryRule = ruleFor(synthAll().get(`${APP_ID}-${SECONDARY_DB_SUFFIX}`)!);
    expect(secondaryRule).toBeDefined();
    expect(secondaryRule!.Properties.SourceSecurityGroupId).toEqual({
      Ref: 'EksClusterSecurityGroupId',
    });
  });

  test('the secondary region exports the cluster security group the DB stack needs', () => {
    const outputs = synthAll().get(secondaryStack)!.toJSON().Outputs ?? {};
    expect(
      Object.keys(outputs).some((k) => k.startsWith('EksClusterSecurityGroupId')),
    ).toBe(true);
  });

  // ---- manifest ↔ src/cdk/k8s.ts, BOTH directions -------------------------------
  //
  // These names live in four formats that must agree: the YAML, the EKS access entry's
  // namespace scope (step 7), the ARC plan's scalingResources (step 8), and k8s.ts. A
  // mismatch in the ARC direction is the worst case — the scaling step reports success
  // having scaled nothing, and a later block still shifts traffic, so every check is
  // green and the standby is unscaled.

  test('manifests use the shared namespace and nothing else', () => {
    for (const file of [APP_MANIFEST, SCHEMA_JOB_MANIFEST]) {
      const text = readManifest(file);
      const found = [...text.matchAll(/^\s*namespace:\s*(\S+)$/gm)].map((m) => m[1]);
      expect(found.length).toBeGreaterThan(0);
      // Reverse direction too: EVERY namespace in the file must be the shared one, so a
      // second namespace cannot be introduced without this failing.
      for (const ns of found) expect(ns).toBe(APP_NAMESPACE);
    }
  });

  test('manifest object names and ports match the shared constants', () => {
    const text = readManifest(APP_MANIFEST);
    expect(text).toContain(`name: ${APP_DEPLOYMENT_NAME}`);
    expect(text).toContain(`name: ${APP_SERVICE_NAME}`);
    expect(text).toContain(`app: ${APP_LABEL}`);
    expect(text).toContain(`containerPort: ${APP_CONTAINER_PORT}`);
    expect(text).toContain(`port: ${APP_SERVICE_PORT}`);
  });

  test('the Service is an INTERNAL NLB, which the step 3a subnet tag depends on', () => {
    const text = readManifest(APP_MANIFEST);
    expect(text).toContain('type: LoadBalancer');
    // `external`, NOT the legacy `nlb`. `nlb` selected the IN-TREE service controller, which
    // runs on the EKS-managed control plane and cannot enable ip targets, cross-zone load
    // balancing or ARC zonal shift -- so a zonal shift against its NLB reports ACTIVE and moves
    // nothing measurable. The single-AZ feature migrated this to the AWS Load Balancer
    // Controller. The INTERNAL requirement below is unchanged and still depends on the step-3a
    // subnet tag; only the provisioner moved.
    expect(text).toContain('aws-load-balancer-type: "external"');
    // The internal annotation is what requires kubernetes.io/role/internal-elb on the
    // subnets. Without the tag the Service sits <pending> forever while CloudFormation
    // reports success, because Kubernetes owns that object.
    expect(text).toContain('aws-load-balancer-internal: "true"');
  });

  test('health probes make NO database call, preserving the gray-failure signature', () => {
    const text = readManifest(APP_MANIFEST);
    // Both probes must hit /health. A database-dependent probe would pull degraded pods
    // out of the load balancer and turn partial degradation into hard connection
    // failures — a different failure than the one the demo claims to show.
    expect([...text.matchAll(/path: \/health/g)]).toHaveLength(2);
    expect(text).not.toContain('path: /orders');
  });

  /**
   * THE STRONGEST CONTRACT HERE: every placeholder the manifests read is supplied by the
   * deploy task.
   *
   * Read against the GENERATED task file, because that is what actually runs. A manifest
   * placeholder nobody supplies produces pods that start, pass a health probe and 500 on
   * every real request — the exact "a field something reads but nothing supplies" defect,
   * caught at build time here instead.
   */
  test('every manifest placeholder is exported by some post-deploy step', () => {
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    );
    const deploySteps: string[] = (tasks.tasks.deploy.steps as any[])
      .filter((s) => s.exec)
      .map((s) => s.exec as string);
    const postDeploy = deploySteps.filter((e) => e.includes('render-manifest.py'));
    expect(postDeploy.length).toBe(REGIONS.length);

    for (const file of [APP_MANIFEST, SCHEMA_JOB_MANIFEST]) {
      const placeholders = new Set(
        [...readManifest(file).matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]),
      );
      expect(placeholders.size).toBeGreaterThan(0);
      for (const name of placeholders) {
        // The schema job manifest is applied only in the primary region, so it is enough
        // that SOME apply step supplies each of its placeholders.
        const supplied = postDeploy.some(
          (e) => e.includes(`${name}=`) || e.includes(`export ${name}=`),
        );
        expect(supplied).toBe(true);
      }
    }
  });

  test('the workload is installed AFTER every stack, including secondarydb', () => {
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    );
    const execs: string[] = (tasks.tasks.deploy.steps as any[])
      .filter((s) => s.exec)
      .map((s) => s.exec as string);
    const secondaryDbAt = execs.findIndex((e) =>
      e.includes(`STACK_NAME="$PROJECT_NAME-${SECONDARY_DB_SUFFIX}"`),
    );
    const writerReadAt = execs.findIndex((e) => e.includes('describe-global-clusters'));
    const firstApplyAt = execs.findIndex((e) => e.includes('render-manifest.py'));

    expect(secondaryDbAt).toBeGreaterThanOrEqual(0);
    // Ordering is forced, not chosen: the standby's pods need its own reader endpoint,
    // which does not exist until the secondary member is created. Nothing in synth can
    // catch a wrong order here — only the deploy sequence makes it correct.
    expect(firstApplyAt).toBeGreaterThan(secondaryDbAt);
    // And the global writer endpoint must be read before anything substitutes it.
    expect(writerReadAt).toBeGreaterThan(secondaryDbAt);
    expect(firstApplyAt).toBeGreaterThan(writerReadAt);
  });

  test('post-deploy steps use the bash wrapper and never `set -a`', () => {
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    );
    const execs: string[] = (tasks.tasks.deploy.steps as any[])
      .filter((s) => s.exec)
      .map((s) => s.exec as string);
    const post = execs.filter(
      (e) => e.includes('render-manifest.py') || e.includes('describe-global-clusters'),
    );
    expect(post.length).toBeGreaterThan(0);
    for (const e of post) {
      expect(e.startsWith('bash -c ')).toBe(true);
      // projen's dax shell rejects `set -a` outright, and the single-region baseline
      // never reaches this branch — so only an assertion keeps it out.
      expect(e).not.toContain('set -a');
      // pipefail matters specifically: these steps pipe a rendered manifest into
      // kubectl, and without it a renderer that refused to emit would be reported as a
      // successful apply.
      expect(e).toContain('pipefail');
    }
  });

  /**
   * DERIVED CONTRACT for the ARC verify step: every env name the script's own `env("X")`
   * calls require must be EXPORTED by the generated step.
   *
   * This failure mode shipped: sourcing a dotenv sets UNEXPORTED shell vars under
   * prefixed names (DNS_HOSTEDZONEID), while the Python child reads bare names from
   * os.environ. The step failed with "HOSTEDZONEID is not set" on every deploy tail
   * until 2026-09-01 — while all 11 stacks were green, so nobody noticed. The required
   * set is parsed from the script (not restated here) so adding an env() call without
   * threading it goes red at build time.
   */
  test('every env the ARC verify script requires is exported by its deploy step', () => {
    const script = fs.readFileSync(
      path.join(__dirname, '..', 'build', 'verify-arc-health-checks.py'),
      'utf8',
    );
    const required = new Set([...script.matchAll(/env\("([A-Z0-9_]+)"\)/g)].map((m) => m[1]));
    expect(required.size).toBeGreaterThanOrEqual(3); // HOSTEDZONEID, APPRECORDNAME, PLANARN

    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    );
    const verify = (tasks.tasks.deploy.steps as any[])
      .map((s) => s.exec as string | undefined)
      .find((e) => e?.includes('verify-arc-health-checks.py'))!;
    expect(verify).toBeDefined();
    const exported = verify.match(/export ([^&]*)&&/)?.[1] ?? '';
    for (const name of required) {
      // Must appear inside the `export ...` segment — a bare `NAME=value cmd` prefix or
      // an unexported sourced var never reaches the Python child's os.environ.
      expect(exported).toContain(`${name}=`);
    }
  });

  /**
   * FUNCTIONAL half of the same contract: run the step's real sourcing+export payload in
   * bash against fake dotenvs (with the real prefixed key names deploy-stack.sh writes)
   * and prove a Python child observes the values. This is what catches the
   * exported-vs-unexported distinction a string assertion cannot.
   */
  test('the verify step payload delivers sourced dotenv values into a python child', () => {
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    );
    const verify = (tasks.tasks.deploy.steps as any[])
      .map((s) => s.exec as string | undefined)
      .find((e) => e?.includes('verify-arc-health-checks.py'))!;
    const payload = verify.slice("bash -c '".length, -1);
    expect(payload).not.toContain("'"); // bug class 1: no single quotes in the wrapper

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-env-'));
    try {
      fs.mkdirSync(path.join(tmp, 'dist'));
      fs.writeFileSync(
        path.join(tmp, 'dist', 'eks-mr-demo-dns.env'),
        'DNS_HOSTEDZONEID=Z123TEST\nDNS_APPRECORDNAME=app.test.internal\n',
      );
      fs.writeFileSync(
        path.join(tmp, 'dist', 'eks-mr-demo-failover.env'),
        'FAILOVER_PLANARN=arn:aws:arc-region-switch::1:plan/x:y\n',
      );
      // Swap the script invocation for an env probe; everything upstream is verbatim.
      const probe = payload.replace(
        /python3 build\/verify-arc-health-checks\.py/,
        'python3 -c "import os; print(os.environ[\\"HOSTEDZONEID\\"], os.environ[\\"APPRECORDNAME\\"], os.environ[\\"PLANARN\\"])"',
      );
      expect(probe).not.toEqual(payload); // the swap must have matched
      const out = execSync('bash -c "$PAYLOAD"', {
        cwd: tmp,
        env: { ...process.env, PAYLOAD: probe, PROJECT_NAME: 'eks-mr-demo' },
      })
        .toString()
        .trim();
      expect(out).toBe('Z123TEST app.test.internal arn:aws:arc-region-switch::1:plan/x:y');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('in-VPC installer (step 3b, option B)', () => {
  const deployExecs = (): string[] => {
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    );
    return (tasks.tasks.deploy.steps as any[]).filter((s) => s.exec).map((s) => s.exec);
  };

  test('every region has an installer build project inside the isolated subnets', () => {
    for (const region of REGIONS) {
      const t = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const projects = Object.values(t.findResources('AWS::CodeBuild::Project'));
      expect(projects).toHaveLength(1);
      const vpcConfig = projects[0].Properties.VpcConfig;
      // Attached to the VPC is the entire point: the cluster API endpoint is private and
      // its ENIs are resolvable only from inside. A project with no VpcConfig would
      // authenticate fine and then time out reaching the API server.
      expect(vpcConfig).toBeDefined();
      expect(vpcConfig.Subnets).toHaveLength(AZ_COUNT);
      // Isolated subnets — the same ones the nodes and Aurora use.
      for (const subnet of vpcConfig.Subnets) {
        expect(JSON.stringify(subnet)).toContain('Isolated');
      }
    }
  });

  /**
   * ARCHITECTURE CONTRACT, second instance.
   *
   * The pipeline stages a linux/arm64 kubectl into S3 because the build has no route to
   * the internet and cannot fetch its own. That only works if the build image is ARM. A
   * mismatch fails as `exec format error` inside a build log nobody reads by default —
   * the same failure mode the node group already had to be corrected for, one layer over.
   */
  test('the build image arch matches the kubectl the pipeline stages', () => {
    for (const region of REGIONS) {
      const t = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const env = Object.values(t.findResources('AWS::CodeBuild::Project'))[0].Properties
        .Environment;
      expect(env.Type).toBe('ARM_CONTAINER');
      expect(env.Image).toContain('aarch64');
    }
    const staging = deployExecs().find((e) => e.includes('dl.k8s.io/release/$PATCH'));
    expect(staging).toBeDefined();
    expect(staging).toContain('bin/linux/arm64/kubectl');
  });

  test('access entries are exactly the installer and the Karpenter node role', () => {
    for (const region of REGIONS) {
      const t = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const entries = Object.values(t.findResources('AWS::EKS::AccessEntry'));

      // Enumerated rather than counted. This used to assert exactly ONE entry, which was
      // right until Karpenter needed one for its node role (step 11a) -- and "toHaveLength"
      // would then have been "fixed" by bumping the number, which asserts nothing about
      // WHICH principals got in. An access entry is a grant of in-cluster authority, so the
      // set is the thing worth pinning: a third one appearing must fail this test.
      const byType = entries.map((e) => ({
        type: e.Properties.Type ?? 'STANDARD',
        principal: JSON.stringify(e.Properties.PrincipalArn),
        policies: e.Properties.AccessPolicies,
      }));
      expect(byType).toHaveLength(2);

      const installer = byType.find((e) => e.principal.includes('Installer'));
      expect(installer).toBeDefined();
      // IAM lets it CALL EKS; this is what lets it act INSIDE the cluster. Without it
      // every kubectl call is a 403 while IAM, synth and the deploy all look correct.
      //
      // Cluster-scoped cluster-admin, because the installer creates the Namespace and a
      // namespace is a cluster-scoped object no namespace-scoped policy can create.
      expect(installer!.policies).toEqual([
        {
          AccessScope: { Type: 'cluster' },
          PolicyArn:
            'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy',
        },
      ]);

      const node = byType.find((e) => e.type === 'EC2_LINUX');
      expect(node).toBeDefined();
      expect(node!.principal).toContain('KarpenterNodeRole');
      // EC2_LINUX carries the node permissions itself. Attaching an access policy to it is
      // an error for this type, so the absence is a contract, not an omission.
      expect(node!.policies).toBeUndefined();
    }
  });

  test('the API server admits the installer, and the installer admits nobody', () => {
    for (const region of REGIONS) {
      const t = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const rule = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')).find(
        (r) => r.Properties?.Description === 'In-VPC installer to the Kubernetes API server',
      );
      expect(rule).toBeDefined();
      expect(rule!.Properties.ToPort).toBe(443);
      // Onto the EKS-MANAGED cluster security group, which is what the API server ENIs
      // actually carry — not the baseline group passed to resourcesVpcConfig.
      expect(JSON.stringify(rule!.Properties.GroupId)).toContain('ClusterSecurityGroupId');

      // The build's own group takes no inbound traffic. AWS guidance for CodeBuild is
      // explicit about this, and nothing needs to reach a build.
      const installerSg = Object.entries(t.findResources('AWS::EC2::SecurityGroup')).find(
        ([lid]) => lid.startsWith('InstallerSg'),
      );
      expect(installerSg).toBeDefined();
      expect(installerSg![1].Properties.SecurityGroupIngress).toBeUndefined();
    }
  });

  test('the endpoints the installer and the injection both need are present', () => {
    // eks    — the build calls `aws eks update-kubeconfig`.
    // codebuild — how a VPC-attached build reaches the CodeBuild service with no NAT.
    // ssm/ssmmessages/ec2messages — step 6: the SSM agent cannot REGISTER without them,
    //   so `aws:ssm:send-command` would resolve zero targets and the injection would
    //   report success having done nothing.
    for (const region of REGIONS) {
      const t = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const services = Object.values(t.findResources('AWS::EC2::VPCEndpoint')).map((e) =>
        JSON.stringify(e.Properties.ServiceName),
      );
      for (const svc of ['.eks', '.codebuild', '.ssm', '.ssmmessages', '.ec2messages']) {
        expect(services.some((s) => s.includes(svc))).toBe(true);
      }
    }
  });

  test('the deploy drives the installer and never runs kubectl on the runner', () => {
    const execs = deployExecs();
    const installSteps = execs.filter((e) => e.includes('codebuild start-build'));
    expect(installSteps).toHaveLength(REGIONS.length);

    for (const step of installSteps) {
      // Rendering stays on the runner so the unresolved-placeholder check is a visible
      // pipeline error rather than a line in a build log.
      expect(step).toContain('render-manifest.py');
      // Waiting is not optional: without it the deploy returns before the manifests are
      // applied, and a later step reads an endpoint that does not exist yet.
      expect(step).toContain('buildStatus');
      expect(step).toContain('SUCCEEDED');
      // A build in an isolated subnet is a black box unless its log is surfaced.
      expect(step).toContain('logs get-log-events');
    }

    // No step may invoke kubectl or update-kubeconfig directly — that is precisely what
    // cannot work from outside the VPC, and it would fail as a silent multi-minute TCP
    // timeout rather than an error.
    for (const e of execs) {
      expect(e).not.toContain('kubectl apply');
      expect(e).not.toContain('update-kubeconfig');
    }
  });

  test('the manifests and kubectl reach the build through the assets bucket', () => {
    // The S3 gateway endpoint is the one route out of a subnet with no NAT that needs no
    // new wiring, and the assets bucket already exists per region.
    for (const step of deployExecs().filter((e) => e.includes('codebuild start-build'))) {
      expect(step).toContain('MANIFEST_S3_URI');
      expect(step).toContain('KUBECTL_S3_URI');
      expect(step).toContain('ENDPOINT_S3_URI');
      expect(step).toContain('$ASSETS_BUCKET_PREFIX-');
    }
  });
});

describe('cross-region client path (step 4a, option A)', () => {
  const peeringStack = `${APP_ID}-${PEERING_SUFFIX}`;

  test('the peering stack declares exactly the parameters the deploy factory threads', () => {
    const params = Object.keys(synthAll().get(peeringStack)!.toJSON().Parameters ?? {});
    // These names are a CONTRACT with createDeployTasks, not a local choice — the factory
    // emits R<i>{Region,VpcId,VpcCidr,RouteTableIds} from each region's dotenv. A rename on
    // either side is a green build and a deploy that fails on an unknown parameter.
    for (let i = 0; i < REGIONS.length; i++) {
      for (const suffix of ['Region', 'VpcId', 'VpcCidr', 'RouteTableIds']) {
        expect(params).toContain(`R${i}${suffix}`);
      }
    }
  });

  test('peering is done by a custom resource, because it cannot be declarative', () => {
    const t = synthAll().get(peeringStack)!;
    // There is no native cross-region accept and no cross-region route resource, so the
    // peer-side accept and the peer-side routes have to be done with regional API calls.
    expect(Object.keys(t.findResources('AWS::CloudFormation::CustomResource'))).not.toHaveLength(0);
    expect(Object.keys(t.findResources('AWS::Lambda::Function'))).not.toHaveLength(0);
  });

  test('every region exports its route tables for the peering mesh', () => {
    for (const region of REGIONS) {
      const outputs = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!.toJSON().Outputs ?? {};
      expect(Object.keys(outputs).some((k) => k.startsWith('RouteTableIds'))).toBe(true);
    }
  });

  /**
   * THE NON-OBVIOUS HALF, and the one that would have cost a live debugging session.
   *
   * Peering carries the packets; it does not get them past the node security group. The
   * in-tree service controller — the only one on this cluster — creates NLBs with INSTANCE
   * targets, and instance target groups have CLIENT IP PRESERVATION ON BY DEFAULT. So the
   * node does not see the load balancer's private address as the source, it sees the
   * ORIGINAL CLIENT address, which lives in the peer region's CIDR.
   *
   * A rule admitting the load balancer is therefore not enough. Without a rule admitting
   * the PEER CIDR on the NodePort range, every cross-region request times out while
   * peering, routes, DNS, the load balancer and every health check all look correct.
   */
  test('each region admits the PEER CIDR on the NodePort range, not just the load balancer', () => {
    for (const region of REGIONS) {
      const t = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const rules = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')).filter(
        (r) => String(r.Properties?.Description ?? '').includes('Cross-region client to NodePort'),
      );
      // One per peer. (The same-VPC client rule — step 4c, for the load generator —
      // is a SEPARATE rule with its own test, filtered out by description here.)
      expect(rules).toHaveLength(REGIONS.length - 1);
      for (const rule of rules) {
        // The Kubernetes default service NodePort range.
        expect(rule.Properties.FromPort).toBe(30000);
        expect(rule.Properties.ToPort).toBe(32767);
        // On the EKS-MANAGED cluster security group — the group node-group instances
        // actually carry — and sourced from a CIDR, not from a security group.
        expect(JSON.stringify(rule.Properties.GroupId)).toContain('ClusterSecurityGroupId');
        expect(rule.Properties.CidrIp).toBeDefined();
        expect(rule.Properties.SourceSecurityGroupId).toBeUndefined();
      }
    }
  });

  test('the peer CIDR each region admits is the OTHER region, not its own', () => {
    for (const region of REGIONS) {
      const t = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const declared = t.toJSON().Parameters.PeerVpcCidrs.Default as string;
      const expected = peerVpcCidrs(region.name).join(',');
      expect(declared).toBe(expected);
      // Guard the direction explicitly: admitting your own CIDR would look plausible,
      // change nothing about a same-region request, and silently fail cross-region.
      expect(declared).not.toContain(region.cidr);
    }
  });
});

describe('global routing (step 4b)', () => {
  const dnsTemplate = () => synthAll().get(`${APP_ID}-${DNS_SUFFIX}`)!;

  const deployExecs = (): string[] => {
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    );
    return tasks.tasks.deploy.steps
      .map((s: { exec?: string }) => s.exec ?? '')
      .filter(Boolean);
  };

  test('the private zone is associated with BOTH regions VPCs, each under its own region', () => {
    // A zone associated with one VPC resolves in one region only. The load generator
    // lives in the primary but must keep resolving after the failover — and the standby
    // region's pods and any debugging session there need the name too. Association is
    // per-VPC-per-region, so a wrong vpcRegion fails only at deploy.
    const t = dnsTemplate();
    t.hasResourceProperties('AWS::Route53::HostedZone', {
      Name: APP_DOMAIN,
      VPCs: REGIONS.map((r, i) => ({
        VPCId: { Ref: `R${i}VpcId` },
        VPCRegion: r.name,
      })),
    });
  });

  test('ONE RecordSetGroup holding a FAILOVER pair, with the set identifiers ARC flips', () => {
    // The ARC Route53HealthCheck block (step 8) references these records by
    // { HostedZoneId, RecordName, RecordSetIdentifier } and creates/binds the health
    // checks itself -- which is why none are declared here. The identifier strings are
    // therefore a CONTRACT: rename one and the plan's RecordSets reference silently
    // stops matching, and the failover shifts nothing.
    //
    // ONE GROUP, NOT TWO RECORDS. Route 53 refuses same-name+type records under DIFFERENT
    // routing policies, so latency->failover is legal only as a SINGLE change batch
    // covering both. CloudFormation updates separate RecordSet resources INDIVIDUALLY --
    // exactly the rejected case -- so the pair must stay in one RecordSetGroup. Proven
    // live 2026-08-31: see AGENTS.md bug class 17 experiments
    // A-D. Splitting this back into per-region resources makes the stack un-updatable.
    // The records live in the FAILOVER stack, not the dns stack: the plan and the records
    // are a mutual contract, and co-locating them is what lets the template own the health
    // check ids instead of attaching them out-of-band.
    expect(
      Object.keys(dnsTemplate().findResources('AWS::Route53::RecordSetGroup')),
    ).toHaveLength(0);
    const t = synthAll().get(`${APP_ID}-${FAILOVER_SUFFIX}`)!;
    expect(Object.keys(t.findResources('AWS::Route53::RecordSet'))).toHaveLength(0);
    const groups = t.findResources('AWS::Route53::RecordSetGroup');
    expect(Object.keys(groups)).toHaveLength(1);
    const sets = (
      Object.values(groups)[0] as { Properties: { RecordSets: Record<string, any>[] } }
    ).Properties.RecordSets;
    expect(sets).toHaveLength(REGIONS.length);

    REGIONS.forEach((r, i) => {
      const rec = sets.find((s) => s.SetIdentifier === recordSetIdentifier(r.name));
      expect(rec).toBeDefined();
      expect(rec!.Name).toEqual(APP_RECORD_NAME);
      expect(rec!.Type).toEqual('A');
      // Latency's discriminator must be GONE: Region alongside Failover is rejected.
      expect(rec!.Region).toBeUndefined();
      expect(rec!.AliasTarget).toEqual({
        DNSName: { Ref: `R${i}LbDns` },
        HostedZoneId: { Ref: `R${i}LbZoneId` },
        EvaluateTargetHealth: true,
      });
    });

    // Exactly one PrimaryRegion and one StandbyRegion -- a duplicated identifier is a
    // deploy-time Route 53 rejection at best, a mis-flipped record at worst.
    expect(sets.map((s) => s.SetIdentifier).sort()).toEqual(['PrimaryRegion', 'StandbyRegion']);

    // LITERALS, deliberately not recordSetIdentifier(): the assertions above call the
    // same function the stack does, so a swapped mapping moves both sides and passes.
    // The semantic pairing -- the PRIMARY region carries 'PrimaryRegion' AND Failover
    // PRIMARY -- is the convention step 8's plan is written against, and only literals
    // can hold it still.
    const primary = sets.find((s) => s.SetIdentifier === 'PrimaryRegion')!;
    const standby = sets.find((s) => s.SetIdentifier === 'StandbyRegion')!;
    expect(primary.Failover).toEqual('PRIMARY');
    expect(standby.Failover).toEqual('SECONDARY');
    expect(primary.AliasTarget.DNSName).toEqual({ Ref: 'R0LbDns' });
    expect(standby.AliasTarget.DNSName).toEqual({ Ref: 'R1LbDns' });

    // Each record carries a health check id derived from the plan's PlanHealthChecks. The
    // region field would be the order-independent way to pick it, but a CfnCondition doing
    // that is rejected at deploy (see the sibling test below), so selection is positional and
    // build/verify-arc-health-checks.py enforces the true pairing after deploy. What this
    // test pins is that the id comes FROM the attribute and that the two records never
    // resolve to the same entry -- attaching one region's check to both is a SILENT failure.
    for (const rec of [primary, standby]) {
      const hc = JSON.stringify(rec.HealthCheckId);
      // Derived from the plan attribute, never hardcoded.
      expect(hc).toContain('PlanHealthChecks');
      // field 3 of a colon-split entry is the health check id
      expect(hc).toContain('Fn::Split');
      expect(hc).toContain('Fn::Select');
    }
    // The two records must not resolve to the SAME entry -- that would point both at one
    // region's check, which is the silent-mis-bind failure this pairing exists to avoid.
    expect(JSON.stringify(primary.HealthCheckId)).not.toEqual(
      JSON.stringify(standby.HealthCheckId),
    );
  });

  test('no Condition references a RESOURCE -- CloudFormation rejects that at deploy', () => {
    // Regression test for a real deploy failure (2026-08-31). Selecting the health check by
    // MATCHING the region field is the correct thing to do, and an earlier revision did it with
    // a CfnCondition doing Fn::Equals on that field. CloudFormation refuses:
    //
    //   Template format error: Unresolved dependencies [Plan]. Cannot reference resources in
    //   the Conditions block of the template
    //
    // Conditions may only reference parameters, pseudo-parameters and mappings. CDK synthesizes
    // the illegal form WITHOUT complaint, so nothing but a deploy catches it -- hence this test.
    // Fn::GetAtt is fine inside Resources; only Conditions are restricted.
    const raw = JSON.parse(
      JSON.stringify(synthAll().get(`${APP_ID}-${FAILOVER_SUFFIX}`)!.toJSON()),
    ) as { Conditions?: Record<string, unknown>; Resources: Record<string, unknown> };
    const resourceIds = new Set(Object.keys(raw.Resources));
    for (const [name, body] of Object.entries(raw.Conditions ?? {})) {
      const text = JSON.stringify(body);
      expect(text).not.toContain('Fn::GetAtt');
      for (const id of resourceIds) {
        // A Ref to a resource is equally illegal here; Ref to a PARAMETER is fine.
        expect(text).not.toContain(`"Ref":"${id}"`);
        expect(text).not.toContain(`{"Ref": "${id}"}`);
      }
      expect(name).toBeTruthy();
    }
  });

  test('alias records target the LOAD BALANCER zone parameter, never the zone itself', () => {
    // The conflation trap: an alias needs the TARGET's canonical hosted zone id, and the
    // group also carries the containing zone's id one property away. Pointing the alias
    // at the zone's own id synthesizes cleanly and fails only at deploy.
    const t = synthAll().get(`${APP_ID}-${FAILOVER_SUFFIX}`)!;
    for (const grp of Object.values(t.findResources('AWS::Route53::RecordSetGroup'))) {
      const props = grp.Properties as {
        HostedZoneId: unknown;
        RecordSets: { AliasTarget: { HostedZoneId: { Ref?: string } } }[];
      };
      // The conflation trap survives the move, it just changes shape: the CONTAINING zone
      // now arrives as a parameter (the zone itself lives in the dns stack), while each
      // alias still needs the TARGET load balancer's canonical zone. Swapping them
      // synthesizes cleanly and fails only at deploy.
      expect(props.HostedZoneId).toEqual({ Ref: 'HostedZoneId' });
      for (const rec of props.RecordSets) {
        expect(rec.AliasTarget.HostedZoneId.Ref).toMatch(/^R\d+LbZoneId$/);
      }
    }
  });

  test('the dns stack deploys AFTER every installer phase', () => {
    // Its alias targets are Kubernetes-created load balancers: DNS name and canonical
    // zone id only exist once the installers have run. Both stacks synthesize in any
    // order — only the deploy sequence makes this correct, so only the generated task
    // can be asserted. Moving the dns phase before the installers is a deploy that
    // fails on unresolved APP_ENDPOINT/APP_LB_ZONE variables, many phases in.
    const execs = deployExecs();
    const dnsIdx = execs.findIndex((e) => e.includes(`-${DNS_SUFFIX}"`));
    const installerIdxs = execs
      .map((e, i) => (e.includes('start-build') ? i : -1))
      .filter((i) => i >= 0);
    expect(dnsIdx).toBeGreaterThanOrEqual(0);
    expect(installerIdxs.length).toBeGreaterThanOrEqual(REGIONS.length);
    expect(dnsIdx).toBeGreaterThan(Math.max(...installerIdxs));
  });

  test('each installer phase captures the NLB canonical zone id alongside the endpoint', () => {
    // Alias records need the target's canonical hosted zone id — a second Kubernetes-era
    // value no CloudFormation output carries. The runner looks it up (the build's
    // isolated subnet has no elasticloadbalancing endpoint) and an empty result stops
    // the deploy THERE, not three phases later inside the dns stack.
    const text = deployExecs().join('\n');
    REGIONS.forEach((_, i) => {
      expect(text).toContain(`APP_LB_ZONE_${i}=`);
    });
    expect(text).toContain('describe-load-balancers');
    expect(text).toContain('CanonicalHostedZoneId');
  });
});

describe('load generation (step 4c)', () => {
  const lgTemplate = () => synthAll().get(`${APP_ID}-${LOADGEN_SUFFIX}`)!;

  const deployExecs = (): string[] => {
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    );
    return tasks.tasks.deploy.steps
      .map((s: { exec?: string }) => s.exec ?? '')
      .filter(Boolean);
  };

  test('the users target the Route 53 record, not a load balancer hostname', () => {
    // THE point of Option A: users that follow the failover. Pinning TARGET_URL to a
    // regional NLB hostname would synthesize, deploy and serve traffic — and the
    // failover's DNS flip would move nothing, killing the demo's recovery beat. The
    // literal here is the same constant the DnsStack writes the record from.
    const t = lgTemplate();
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        Match.objectLike({
          Environment: Match.arrayWith([
            { Name: 'TARGET_URL', Value: `http://${APP_RECORD_NAME}` },
          ]),
        }),
      ],
    });
  });

  test('task architecture is ARM64 — the CI runners build, kaniko cannot cross-build', () => {
    // Same constraint that moved the EKS nodes to Graviton in step 3b. Flipping the
    // construct's architecture prop to AMD64 synthesizes green here and fails in CI
    // with `exec format error` inside the kaniko build.
    lgTemplate().hasResourceProperties('AWS::ECS::TaskDefinition', {
      RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
    });
  });

  test('tasks run in the imported isolated subnets', () => {
    // The construct defaults to PRIVATE_WITH_EGRESS, which this VPC does not have —
    // left at the default, subnet selection fails at synth OR lands somewhere with no
    // ECR path and the task dies pulling its image.
    lgTemplate().hasResourceProperties('AWS::ECS::Service', {
      NetworkConfiguration: {
        AwsvpcConfiguration: {
          Subnets: Array.from({ length: AZ_COUNT }, (_, i) => ({
            'Fn::Select': [i, { Ref: 'IsolatedSubnetIds' }],
          })),
        },
      },
    });
  });

  test('every EKS AccessEntry references the cluster by Ref, never by literal name', () => {
    // A literal cluster-name string carries NO CloudFormation dependency edge, so an
    // access entry -- whose create handler calls EKS -- races the ~10-minute cluster
    // creation and 404s the whole stack (live rollback, first deploy, 2026-08-26).
    // Ref resolves to the same name AND orders creation behind the cluster.
    for (const [stackName, template] of synthAll()) {
      const resources = template.toJSON().Resources ?? {};
      for (const [lid, res] of Object.entries(resources) as Array<
        [string, { Type: string; Properties?: { ClusterName?: unknown } }]
      >) {
        if (res.Type !== 'AWS::EKS::AccessEntry') continue;
        const cn = (res.Properties as { ClusterName?: unknown } | undefined)?.ClusterName;
        const dependsOn: string[] = ([] as string[]).concat(
          (res as { DependsOn?: string | string[] }).DependsOn ?? [],
        );
        const clusterIds = Object.entries(resources)
          .filter(([, r]) => (r as { Type: string }).Type === 'AWS::EKS::Cluster')
          .map(([id]) => id);
        // Ordered either way: an intrinsic ClusterName (Ref/GetAtt), or an explicit
        // DependsOn naming the cluster. A bare literal with neither is the race.
        const ordered =
          typeof cn === 'object' || dependsOn.some((d) => clusterIds.includes(d));
        expect({ stackName, lid, ordered }).toEqual({ stackName, lid, ordered: true });
      }
    }
  });

  test('Dockerfile pip invocations use valid flag syntax', () => {
    // Container builds run ONLY in CI kaniko -- the local build gate never executes a
    // Dockerfile RUN line, so a syntactically invalid pip flag ships green and fails
    // the first live pipeline (proven 2026-08-26: `--require-hashes=false` -- pip's
    // boolean flags take NO value form -- killed build:docker with exit 2). This pins
    // the class: no value-form boolean pip flags anywhere a Dockerfile calls pip.
    const dockerfiles = [
      'src/app/Dockerfile',
      'src/locust/Dockerfile',
      'src/cdk/lib/constructs/load-generation/container/Dockerfile',
    ];
    const booleanFlags = ['require-hashes', 'no-cache-dir', 'upgrade', 'no-deps', 'pre', 'user'];
    for (const df of dockerfiles) {
      const text = fs.readFileSync(path.join(__dirname, '..', df), 'utf8');
      const pipLines = text.split('\n').filter((l) => /pip3? +install/.test(l));
      expect({ file: df, hasPipLine: pipLines.length > 0 }).toEqual({ file: df, hasPipLine: true });
      for (const line of pipLines) {
        for (const flag of booleanFlags) {
          expect({ file: df, line, badFlag: line.includes(`--${flag}=`) }).toEqual({
            file: df, line, badFlag: false,
          });
        }
      }
    }
  });

  test('the Az metric-name contract holds across ALL THREE consumers', () => {
    // D7 / D7c. The Az family names live in three files and NO import can span them:
    //   authority  src/cdk/lib/constructs/observability/metric-namespace.ts   (TypeScript)
    //   emitter    src/locust/az_metrics.py            (imported by locustfile.py)
    //   reader     .../cockpit/lambda/handler.py       (CANNOT import the emitter's copy —
    //              its asset is Code.fromAsset(.../'lambda'), that directory alone)
    //
    // Nothing type-checks a CloudWatch metric string. Spell one of them `AZSuccess` and the
    // code compiles, the stack synthesizes, cfn-lint passes, the deploy goes green, and the
    // AZ chart lines are permanently empty — which presents as a broken load generator, not
    // as a naming bug. This test is the only thing that catches it.
    //
    // It MUST cover all three. A two-way test (TS <-> Python) passes while the READER is
    // wrong, and the reader is the consumer whose failure is the empty chart this control
    // exists to prevent. Two-way coverage is worse than none: it certifies the wrong pair
    // and makes the gap look closed.
    const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

    const ts = read('src', 'cdk', 'lib', 'constructs', 'observability', 'metric-namespace.ts');
    const py = read('src', 'locust', 'az_metrics.py');
    const handler = read(
      'src', 'cdk', 'lib', 'constructs', 'cockpit', 'lambda', 'handler.py',
    );

    // Parse rather than import: the point is to read what each file literally SAYS.
    const grab = (text: string, re: RegExp, label: string): string => {
      const m = text.match(re);
      expect({ label, found: m !== null }).toEqual({ label, found: true });
      return m![1];
    };

    // The family gained a FOURTH name and a THRESHOLD in 2026-09-03's SLO reframing
    // (AzSloSuccess = non-error AND within AZ_SLO_MS). Both are in the contract for the
    // same reason the other three are: the threshold is baked in at EMIT time but printed
    // as a label by the READER, so a divergence produces a chart whose axis label lies
    // about the definition it is drawing -- green everywhere, wrong on screen.
    const tsNames = {
      dimension: grab(ts, /export const AZ_DIMENSION = '([^']+)'/, 'ts AZ_DIMENSION'),
      success: grab(ts, /success: '([^']+)'/, 'ts AZ_METRICS.success'),
      error: grab(ts, /error: '([^']+)'/, 'ts AZ_METRICS.error'),
      latency: grab(ts, /latency: '([^']+)'/, 'ts AZ_METRICS.latency'),
      sloSuccess: grab(ts, /sloSuccess: '([^']+)'/, 'ts AZ_METRICS.sloSuccess'),
      sloMs: grab(ts, /export const AZ_SLO_MS = (\d+)/, 'ts AZ_SLO_MS'),
    };
    const pyNames = {
      dimension: grab(py, /^AZ_DIMENSION = "([^"]+)"/m, 'py AZ_DIMENSION'),
      success: grab(py, /^AZ_SUCCESS = "([^"]+)"/m, 'py AZ_SUCCESS'),
      error: grab(py, /^AZ_ERROR = "([^"]+)"/m, 'py AZ_ERROR'),
      latency: grab(py, /^AZ_LATENCY = "([^"]+)"/m, 'py AZ_LATENCY'),
      sloSuccess: grab(py, /^AZ_SLO_SUCCESS = "([^"]+)"/m, 'py AZ_SLO_SUCCESS'),
      sloMs: grab(py, /^AZ_SLO_MS = (\d+)/m, 'py AZ_SLO_MS'),
    };
    const readerNames = {
      dimension: grab(handler, /^AZ_DIMENSION = "([^"]+)"/m, 'handler AZ_DIMENSION'),
      success: grab(handler, /^AZ_SUCCESS = "([^"]+)"/m, 'handler AZ_SUCCESS'),
      error: grab(handler, /^AZ_ERROR = "([^"]+)"/m, 'handler AZ_ERROR'),
      latency: grab(handler, /^AZ_LATENCY = "([^"]+)"/m, 'handler AZ_LATENCY'),
      sloSuccess: grab(handler, /^AZ_SLO_SUCCESS = "([^"]+)"/m, 'handler AZ_SLO_SUCCESS'),
      sloMs: grab(handler, /^AZ_SLO_MS = (\d+)/m, 'handler AZ_SLO_MS'),
    };

    // Compared as whole objects so a failure prints every name from every side at once,
    // rather than stopping at the first mismatch and hiding the others.
    expect({ emitter: pyNames, reader: readerNames }).toEqual({
      emitter: tsNames, reader: tsNames,
    });

    // The naming invariant itself (D1): dimension name == metric prefix, matching
    // Region -> Region* and Op -> Op*. Pinned so a future family cannot drift from it, and
    // so `Az` cannot be renamed to something that no longer prefixes its own metrics.
    for (const [side, names] of Object.entries({ tsNames, pyNames, readerNames })) {
      for (const metric of [names.success, names.error, names.latency, names.sloSuccess]) {
        expect({ side, metric, prefixed: metric.startsWith(names.dimension) }).toEqual({
          side, metric, prefixed: true,
        });
      }
    }
  });

  test('the SLO threshold sits INSIDE the measurable band -- two-sided', () => {
    // 2026-09-03. The SLO threshold defines "successful" for the client-perceived
    // availability chart: non-error AND answered within AZ_SLO_MS. It has a CEILING as
    // well as a floor, and the ceiling is the one that bites silently.
    //
    // CEILING -- the loadgen abandons any request at REQUEST_TIMEOUT and scores it an
    // ERROR, so no successful request can ever be observed slower than that. A threshold
    // at or above it classifies ZERO requests: the chart compiles, deploys, and draws a
    // line identical to the plain error rate while claiming to measure latency. A 10s
    // threshold was proposed on 2026-09-03 and is exactly this trap -- REQUEST_TIMEOUT is
    // 5s, so it would have measured nothing at all.
    //
    // FLOOR -- steady-state p90 is ~90ms and the observed MAXIMUM across a quiet 5-minute
    // window was 109ms (live, us-east-2c, 2026-09-03 16:27-16:32). A threshold near that
    // makes healthy traffic breach and the chart cries wolf at rest.
    //
    // The band is therefore (floor, REQUEST_TIMEOUT). Shipped value 2000ms: ~18x the
    // observed quiet-window maximum, and 2.5x under the error wall. A ONE-SIDED assertion
    // is what let the 500ms FIS overshoot look correct in August -- both ends or neither.
    const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
    const py = read('src', 'locust', 'az_metrics.py');
    const locust = read('src', 'locust', 'locustfile.py');

    const sloMs = Number(py.match(/^AZ_SLO_MS = (\d+)/m)![1]);
    // Parsed from the DEFAULT in the env lookup -- that is the value that ships.
    const requestTimeoutMs =
      Number(locust.match(/^REQUEST_TIMEOUT = float\(os\.environ\.get\("REQUEST_TIMEOUT", "([\d.]+)"\)\)/m)![1]) * 1000;

    const FLOOR_MS = 500;
    expect({
      sloMs,
      requestTimeoutMs,
      aboveFloor: sloMs > FLOOR_MS,
      belowErrorWall: sloMs < requestTimeoutMs,
    }).toEqual({
      sloMs, requestTimeoutMs, aboveFloor: true, belowErrorWall: true,
    });
  });

  test('slo_success classifies non-error AND within-threshold, at the boundary', () => {
    // BEHAVIORAL, not a source grep. az_metrics.py imports NOTHING, so a real Python
    // subprocess can exercise the classifier without locust or boto3 installed -- the
    // reason the classifier lives there rather than inline in locustfile.py.
    //
    // The boundary case is the one worth pinning: `<=` vs `<` at exactly AZ_SLO_MS is
    // invisible in review and shifts every number the demo quotes.
    const probe = path.join(__dirname, 'slo-classify-probe.py');
    fs.writeFileSync(probe, `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'src', 'locust'))})
from az_metrics import AZ_SLO_MS, slo_success
print(json.dumps({
    "fastSuccess": slo_success(True, 100.0),
    "atBoundary": slo_success(True, float(AZ_SLO_MS)),
    "justOver": slo_success(True, float(AZ_SLO_MS) + 1),
    "slowSuccess": slo_success(True, float(AZ_SLO_MS) * 2),
    "fastError": slo_success(False, 10.0),
    "slowError": slo_success(False, float(AZ_SLO_MS) * 2),
}))
`);
    try {
      const got = JSON.parse(execSync(`python3 ${probe}`, { encoding: 'utf8' }).trim());
      expect(got).toEqual({
        // Within the bar and not an error -> counts toward availability.
        fastSuccess: 1,
        atBoundary: 1,
        // Answered, but too slow to count. This is the whole point of the reframing: the
        // request SUCCEEDED and still does not count as available.
        justOver: 0,
        slowSuccess: 0,
        // An error never counts, however fast it failed.
        fastError: 0,
        slowError: 0,
      });
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });

  test('the workload ships the SAME emf helper the observability pattern defines', () => {
    // The workload's build context cannot COPY from outside itself, so the helper is
    // duplicated into src/locust/. This is the guard that keeps the copy honest: if
    // the canonical helper changes (metric names, the is_first gate), a stale copy
    // keeps emitting yesterday's contract and nothing else fails.
    const canonical = fs.readFileSync(
      path.join(
        __dirname, '..', 'src', 'cdk', 'lib', 'constructs', 'observability', 'emf', 'emf_helper.py',
      ),
      'utf8',
    );
    const shipped = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'locust', 'emf_helper.py'),
      'utf8',
    );
    expect(shipped).toBe(canonical);
  });

  test('the workload emits the metric names the availability alarm reads', () => {
    // The contracts table's fourth row: metrics the workload emits ↔ metrics the
    // alarms read. The stock locustfile emits Success/Error — names nothing here
    // consumes — and the only symptom is an alarm in INSUFFICIENT_DATA forever.
    // Asserted on the files the container actually ships.
    const helper = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'locust', 'emf_helper.py'),
      'utf8',
    );
    const locustfile = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'locust', 'locustfile.py'),
      'utf8',
    );
    const alarmSource = fs.readFileSync(
      path.join(
        __dirname, '..', 'src', 'cdk', 'lib', 'constructs', 'observability', 'demo-observability.ts',
      ),
      'utf8',
    );
    for (const name of ['ClientSuccess', 'ClientError']) {
      expect(alarmSource).toContain(name); // the reader
      expect(helper).toContain(`"${name}"`); // the emitter
    }
    // The locustfile must route through the helper — a hand-rolled EMF line here is
    // exactly how the names drift apart again.
    expect(locustfile).toContain('from emf_helper import DEMO_METRIC_NAMESPACE, emit_emf, emit_request');
    expect(locustfile).toContain('emit_request(');
  });

  test('the workload attributes each request to its serving AZ with an Az-dimensioned family', () => {
    // The single-AZ story needs a per-AZ line: a single-AZ fault and a milder region-wide
    // fault produce the SAME aggregate shape (a partial dip), so without per-AZ series the
    // audience cannot tell which is happening — nor whether recovery came from the zonal
    // shift or from the fault easing off. Behavioral, exactly like the Op probe above:
    // import the real locustfile (locust stubbed) and parse the EMF line emit_az prints.
    const probe = path.join(__dirname, 'az-metrics-probe.py');
    fs.writeFileSync(probe, [
      'import io, json, sys, types',
      "fake = types.ModuleType('locust')",
      'class HttpUser: pass',
      'fake.HttpUser = HttpUser',
      'fake.between = lambda a, b: None',
      'fake.task = lambda w: (lambda f: f)',
      "sys.modules['locust'] = fake",
      "sys.path.insert(0, 'src/locust')",
      'buf = io.StringIO()',
      'sys.stdout = buf',
      'import locustfile',
      "locustfile.emit_az(az='us-east-2b', success=False, latency_ms=12.5)",
      // The SLO half of the family, exercised through the REAL emitter rather than the
      // classifier alone: a request that SUCCEEDED but took far too long. This is the case
      // the whole reframing exists for, so it is pinned where it actually ships.
      "locustfile.emit_az(az='us-east-2a', success=True, latency_ms=9999.0)",
      'sys.stdout = sys.__stdout__',
      'print(json.dumps([json.loads(l) for l in buf.getvalue().strip().split(chr(10)) if l.strip()]))',
    ].join('\n'));
    try {
      const out = execSync(`python3 ${probe}`, {
        encoding: 'utf8',
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, DEMO_METRIC_NAMESPACE: 'ProbeNS' },
      }).trim();
      const lines = JSON.parse(out);
      const line = lines[0];
      const spec = line._aws.CloudWatchMetrics[0];
      // The Az dimension and ONLY the Az dimension. A Client or Region name here would mean
      // the new family collided with an existing metric identity — and the Client aggregate
      // is what the availability alarm reads.
      expect(spec.Dimensions).toEqual([['Az']]);
      expect(spec.Namespace).toBe('ProbeNS');
      expect(spec.Metrics.map((m: { Name: string }) => m.Name).sort()).toEqual([
        'AzError', 'AzLatency', 'AzSloSuccess', 'AzSuccess',
      ]);
      expect(line.Az).toBe('us-east-2b');
      expect(line.AzError).toBe(1);
      expect(line.AzSuccess).toBe(0);
      // A FAST error still counts for nothing. 12.5ms is comfortably inside the bar, and
      // being inside the bar must not launder a failure into an availability datapoint.
      expect(line.AzSloSuccess).toBe(0);

      // THE SLOW SUCCESS -- the case the reframing exists for, through the real emitter.
      // Answered (AzSuccess 1, AzError 0) and yet NOT available (AzSloSuccess 0), because
      // 9,999ms is past the bar. An error-only chart draws this minute at 100%.
      const slow = lines[1];
      expect({
        az: slow.Az, success: slow.AzSuccess, error: slow.AzError, slo: slow.AzSloSuccess,
      }).toEqual({ az: 'us-east-2a', success: 1, error: 0, slo: 0 });
      // NO client metric on this line. The double-count footgun: the Client* aggregate must
      // appear exactly once per logical request, and emit_az must never be a second one.
      for (const name of ['ClientSuccess', 'ClientError', 'ClientLatency']) {
        expect({ name, present: name in line }).toEqual({ name, present: false });
      }
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });

  test('the emitter IMPORTS the Az names and field names rather than hand-typing them', () => {
    // D1/D7. Region* and Op* work only because independently hand-typed literals happen to
    // match. Nothing type-checks a CloudWatch metric string, so a case flip deploys green
    // and draws nothing. The Az family does not get to repeat that.
    const locustfile = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'locust', 'locustfile.py'), 'utf8');
    // Asserted name-by-name rather than as one exact line: the import went multi-line when
    // the SLO members joined it (2026-09-03), and pinning the formatting rather than the
    // CONTRACT makes a reformat look like a regression while a dropped name looks fine.
    const importBlock = locustfile.slice(
      locustfile.indexOf('from az_metrics import'),
      locustfile.indexOf('from emf_helper import'),
    );
    for (const name of [
      'AZ_DIMENSION', 'AZ_ERROR', 'AZ_FIELDS', 'AZ_LATENCY', 'AZ_SUCCESS',
      // The SLO members: the name the counter is published under, and the classifier that
      // decides its value. Importing the name but re-implementing the comparison inline is
      // the failure this pin exists to stop -- the boundary case would then live in a file
      // no behavioral test can reach.
      'AZ_SLO_SUCCESS', 'slo_success',
    ]) {
      expect({ name, imported: importBlock.includes(name) })
        .toEqual({ name, imported: true });
    }
    // The literals must NOT appear in the emitter at all — importing them and then also
    // typing one would defeat the contract test, which reads az_metrics.py, not this file.
    for (const literal of [
      '"AzSuccess"', "'AzSuccess'", '"AzError"', '"AzLatency"', '"Az"',
      '"AzSloSuccess"', "'AzSloSuccess'",
    ]) {
      expect({ literal, handTyped: locustfile.includes(literal) })
        .toEqual({ literal, handTyped: false });
    }
    // Both call sites emit it — including the exception path. A timed-out request is
    // precisely the event the per-AZ error series exists to count, and a series that is
    // silently shorter than the Op series reads as "that AZ was fine" rather than
    // "we could not tell".
    expect(locustfile).toContain('emit_az(az=az_of(resp), success=ok, latency_ms=latency_ms)');
    expect(locustfile).toContain('emit_az(az="unknown", success=False, latency_ms=latency_ms)');
  });

  test('importing the app module cannot hang or raise, with or without IMDS', () => {
    // AGENTS.md bug class 14: a green image build does not prove a startable image. NODE_AZ
    // is resolved at IMPORT scope from IMDS, and a blocking or raising read there would hang
    // or break EVERY container start. The in-image smoke test
    // (`RUN AWS_REGION=smoke ... python -c "import server, schema"`, src/app/Dockerfile:52)
    // only runs in CI, so this subprocess test is the local gate.
    //
    // Uses the SAME env set as that Dockerfile line — common.py requires those vars at
    // import, independently of this feature.
    //
    // DELIBERATELY DOES NOT ASSERT THE AZ VALUE. Whether IMDS answers is a property of the
    // HOST, not of the code: it is unreachable on a dev desktop and may well answer on an
    // EC2 build runner. Asserting '' would pin the test to one environment and fail in the
    // other. The invariants that belong to the code are: import does not raise, it is
    // BOUNDED, and the result is always a string — never None, never a fabricated AZ.
    const smokeEnv = {
      ...process.env,
      AWS_REGION: 'smoke',
      DB_SECRET_NAME: 'smoke',
      DB_READ_HOST: 'smoke',
      DB_WRITE_HOST: 'smoke',
      ERROR_RATE_PARAM: 'smoke',
    };
    const t0 = Date.now();
    const out = execSync(
      'python3 -c "import common; print(type(common.NODE_AZ).__name__ + \':\' + common.NODE_AZ)"',
      { encoding: 'utf8', cwd: path.join(__dirname, '..', 'src', 'app'), env: smokeEnv, timeout: 30_000 },
    ).trim();
    const elapsedMs = Date.now() - t0;

    const [typeName, value] = [out.slice(0, out.indexOf(':')), out.slice(out.indexOf(':') + 1)];
    expect(typeName).toBe('str');
    // Either unknown (no IMDS) or a real AZ name — never a placeholder, never partial.
    //
    // MUTATION COVERAGE, STATED HONESTLY: making the read raise DOES turn this test red, so
    // the never-raises contract is genuinely pinned. Making it return a fabricated value does
    // NOT, on a host where IMDS is unreachable — that branch simply never executes, so the
    // shape assertion below is unexercised locally. It bites only where IMDS answers (an EC2
    // runner, or a pod in the cluster). Keep it: the risk it guards — a placeholder or
    // truncated AZ silently becoming a metric dimension value — is real, and the alternative
    // (an injection seam in production code purely for testability) costs more than it buys.
    expect({ value, shape: value === '' || /^[a-z]{2}-[a-z]+-\d[a-z]$/.test(value) })
      .toEqual({ value, shape: true });
    // Two bounded round trips at _IMDS_TIMEOUT_SECONDS each, plus interpreter startup. The
    // assertion that matters is that it is BOUNDED, not that it is fast.
    expect({ boundedUnder15s: elapsedMs < 15_000 }).toEqual({ boundedUnder15s: true });
  });

  test('the write pool SELF-HEALS after a writer failover (no restart, no operator)', () => {
    // THE defect this public sample must not carry. The original demo's write pool returned
    // connections to a LIFO queue unconditionally -- even after the write on them raised --
    // and never validated a pooled connection before handing it out. After the Aurora
    // writer moved regions, every pooled socket was dead, every write reused a dead
    // socket and failed in ~5ms, the failure put the socket straight back, and the pool
    // was never empty so a fresh connection was never opened. Writes stayed at 0% for
    // 65 minutes with every pod reporting healthy, until a rollout restart. Reads, which
    // open a fresh connection per request, stayed at 100% -- the asymmetry that made it
    // look like an endpoint problem rather than a pool problem.
    //
    // test/fixtures/pool_probe.py installs a fake pg8000 whose sockets can be killed en
    // masse (the failover), then drives the pool through four scenarios and prints one JSON
    // object. Run against the ORIGINAL common.py the failover section reports ten failures,
    // zero new connections and no recovery -- the live incident in miniature.
    const smokeEnv = {
      ...process.env,
      AWS_REGION: 'smoke',
      DB_SECRET_NAME: 'smoke',
      DB_READ_HOST: 'smoke',
      DB_WRITE_HOST: 'smoke',
      ERROR_RATE_PARAM: 'smoke',
    };
    const out = execSync(`python3 ${path.join(__dirname, 'fixtures', 'pool_probe.py')}`, {
      encoding: 'utf8', cwd: path.join(__dirname, '..', 'src', 'app'), env: smokeEnv, timeout: 30_000,
    }).trim();
    const r = JSON.parse(out);

    // Steady state: the pool is a pool -- ten writes, one connection.
    expect(r.steady_state_opened).toBe(1);
    // Failover: the one pooled socket fails ONCE, is closed and dropped, and exactly one
    // replacement is opened; every later write succeeds. Recovery is measured in requests,
    // not restarts.
    expect(r.failover_outcomes).toEqual([false, true, true, true, true, true, true, true, true, true]);
    expect(r.failover_new_connections).toBe(1);
    expect(r.dead_conn_closed).toBe(true);
    // Validate-after-idle: a socket that died while idle is caught by the checkout ping and
    // replaced BEFORE the caller uses it -- the request never sees the failure at all.
    expect(r.idle_dead_write_succeeds_first_try).toBe(true);
    // Max lifetime: a connection past its lifetime is retired at checkout even if healthy.
    expect(r.expired_conn_closed).toBe(true);
    expect(r.expired_conn_replaced).toBe(true);
  });

  test('the write pool never returns a connection whose body raised (source pin)', () => {
    // The behavioural probe above is the real guard; this pins the two source-level shapes
    // that make it hold, so a refactor that quietly reintroduces "put back in finally,
    // unconditionally" is caught even if someone also edits the probe. Comment-stripped so
    // prose describing the old bug cannot satisfy or break the assertion.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'common.py'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    const body = src.slice(src.indexOf('def write_connection('));
    // A success flag decides whether the connection goes back.
    expect(body).toMatch(/ok = False[\s\S]*yield entry\.conn[\s\S]*ok = True/);
    expect(body).toMatch(/if not ok:\s*\n\s*_close_quietly\(entry\.conn\)/);
    // And checkout validates: both the lifetime and the idle-ping rules exist.
    expect(src).toContain('DB_CONN_MAX_LIFETIME_SECONDS');
    expect(src).toContain('DB_CONN_VALIDATE_AFTER_IDLE_SECONDS');
    expect(src).toMatch(/def _is_alive\(conn\)[\s\S]*SELECT 1/);
  });

  test('the workload separates read and write paths with Op-dimensioned metrics', () => {
    // Goal 2's on-stage signature is writes failing while reads succeed. The Client*
    // and Region* lines cannot show WHICH path fails, and adding a dimension to them
    // would change the metric identity the availability alarm reads. So a THIRD
    // family exists: OpSuccess/OpError/OpLatency, dimensioned by Op ∈ {read, write}.
    // Behavioral: import the real locustfile (locust stubbed — it is a container
    // dependency, not a build one) and parse the actual EMF line emit_op prints.
    const probe = path.join(__dirname, 'op-metrics-probe.py');
    fs.writeFileSync(probe, [
      'import io, json, sys, types',
      "fake = types.ModuleType('locust')",
      'class HttpUser: pass',
      'fake.HttpUser = HttpUser',
      'fake.between = lambda a, b: None',
      'fake.task = lambda w: (lambda f: f)',
      "sys.modules['locust'] = fake",
      "sys.path.insert(0, 'src/locust')",
      'buf = io.StringIO()',
      'sys.stdout = buf',
      'import locustfile',
      "locustfile.emit_op(op='write', success=False, latency_ms=12.5)",
      'sys.stdout = sys.__stdout__',
      'print(buf.getvalue().strip())',
    ].join('\n'));
    try {
      const out = execSync(`python3 ${probe}`, {
        encoding: 'utf8',
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, DEMO_METRIC_NAMESPACE: 'ProbeNS' },
      }).trim();
      const line = JSON.parse(out);
      const spec = line._aws.CloudWatchMetrics[0];
      // The Op dimension — and ONLY the Op dimension. A Region or Client name here
      // would mean the new family collided with an existing metric identity.
      expect(spec.Dimensions).toEqual([['Op']]);
      expect(spec.Namespace).toBe('ProbeNS'); // env-threaded, same as every other line
      expect(spec.Metrics.map((m: { Name: string }) => m.Name).sort()).toEqual([
        'OpError', 'OpLatency', 'OpSuccess',
      ]);
      expect(line.Op).toBe('write');
      expect(line.OpError).toBe(1);
      expect(line.OpSuccess).toBe(0);
      expect(line.OpLatency).toBe(12.5);
    } finally {
      fs.unlinkSync(probe);
    }
    // The ACTUAL call sites (not prose): both tasks name their path, and the
    // exception branch emits too — a timed-out write is precisely the event the
    // write series exists to count.
    const locustfile = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'locust', 'locustfile.py'),
      'utf8',
    );
    expect(locustfile).toContain('self._scored_request("GET", 200, op="read")');
    expect(locustfile).toContain('op="write",');
    expect(locustfile).toContain('emit_op(op=op, success=False, latency_ms=latency_ms)');
  });

  test('BOTH dashboards split availability by Op (cross-region widgets)', () => {
    // The read-vs-write row explains the ~75% park the aggregate graph only shows.
    // ORIGINALLY primary-only ("empty graph on the standby"), which reasoned from
    // where EMF lands but drew the wrong conclusion: widgets support cross-region
    // metrics, and mid-demo (2026-08-27) the standby dashboard was exactly the one
    // on screen -- bare. Both dashboards now carry the row, stamped with the
    // primary metrics region; the companion test below pins the region stamps.
    for (const region of REGIONS) {
      const template = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const dashboards = template.findResources('AWS::CloudWatch::Dashboard');
      expect(Object.keys(dashboards)).toHaveLength(1);
      // Resolve the Fn::Join into the literal dashboard JSON rather than string-
      // matching through CloudFormation escape levels (the buildspec lesson: parse,
      // don't count backslashes). Non-string parts (Refs) join as placeholders.
      const bodyProp = Object.values(dashboards)[0].Properties.DashboardBody;
      const parts = (bodyProp['Fn::Join']?.[1] ?? [bodyProp]) as unknown[];
      const body = parts.map((x) => (typeof x === 'string' ? x : 'X')).join('');
      for (const marker of ['OpSuccess', 'OpError', 'Read path availability', 'Write path availability']) {
        expect({ region: region.name, marker, present: body.includes(marker) }).toEqual({
          region: region.name,
          marker,
          present: true,
        });
      }
      // Both Op values must be dimension VALUES in the metric arrays, not just labels.
      expect(body).toContain('"OpSuccess","Op","read"');
      expect(body).toContain('"OpSuccess","Op","write"');
      expect(body).toContain('"OpError","Op","read"');
      expect(body).toContain('"OpError","Op","write"');
    }
  });

  test('the loadgen stack deploys AFTER the dns stack', () => {
    // Its tasks resolve app.eks-mr-demo.internal at startup. Deployed earlier, every
    // request fails DNS and the availability alarm opens the demo already firing —
    // deploy-sequencing noise indistinguishable from an outage.
    const execs = deployExecs();
    const dnsIdx = execs.findIndex((e) => e.includes(`-${DNS_SUFFIX}"`));
    const lgIdx = execs.findIndex((e) => e.includes(`-${LOADGEN_SUFFIX}"`));
    expect(dnsIdx).toBeGreaterThanOrEqual(0);
    expect(lgIdx).toBeGreaterThanOrEqual(0);
    expect(lgIdx).toBeGreaterThan(dnsIdx);
  });

  test('each region admits its OWN VPC CIDR on the NodePort range, alongside the peers', () => {
    // The load generator is a SAME-VPC client of the primary NLB, and client IP
    // preservation applies to it exactly as it does cross-region: the node sees the
    // task's address. Whether the in-tree controller adds its own client rules cannot
    // be verified offline; without this rule and without those, the demo's only
    // traffic source times out while everything looks green.
    for (const region of REGIONS) {
      const t = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      t.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        FromPort: 30000,
        ToPort: 32767,
        CidrIp: { Ref: 'VpcCidr' },
      });
    }
  });

  test('every python file the container ships compiles', () => {
    // The container is only built in CI (kaniko, arm64) — a syntax error in the
    // workload otherwise first surfaces as a CrashLoopBackOff'd Fargate task.
    const dir = path.join(__dirname, '..', 'src', 'locust');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.py'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      execSync(`python3 -m py_compile ${path.join(dir, f)}`);
    }
  });
});

describe('the three-alarm split (step 5)', () => {
  const alarmsOf = (stackName: string): Record<string, any>[] => {
    const t = synthAll().get(stackName)!;
    return Object.values(t.findResources('AWS::CloudWatch::Alarm')).map(
      (r) => (r as { Properties: Record<string, any> }).Properties,
    );
  };
  const primaryAlarms = () => alarmsOf(`${APP_ID}-${regionSuffix(REGIONS[0])}`);
  const byName = (frag: string) =>
    primaryAlarms().filter((p) => String(p.AlarmName).includes(frag));

  test('all four alarms live in the PRIMARY stack; the secondary declares none', () => {
    // Deliberate deviation from the OBS-002 changeset, forced by Option A: the load
    // generator in the primary region is the demo's ONLY metric emitter (the app emits
    // nothing), EMF metrics land in the log group's region, and CloudWatch alarms
    // cannot read across regions. A secondary-region alarm would watch a namespace
    // nothing ever writes — INSUFFICIENT_DATA for the life of the demo, a gray box on
    // stage. Step 8 consumes these by region-qualified ARN, so placement costs nothing.
    expect(primaryAlarms()).toHaveLength(4);
    expect(alarmsOf(`${APP_ID}-${regionSuffix(REGIONS[1])}`)).toHaveLength(0);
  });

  test('role 1 — decision signal: 99, 3-of-5, missing data is NOT a decision, wired to nothing', () => {
    const [a] = byName('ClientAvailability');
    expect(a).toBeDefined();
    expect(a.Threshold).toBe(99);
    expect(a.ComparisonOperator).toBe('LessThanThreshold');
    expect(a.EvaluationPeriods).toBe(5);
    expect(a.DatapointsToAlarm).toBe(3);
    // A telemetry gap must not masquerade as a reason to fail over.
    expect(a.TreatMissingData).toBe('notBreaching');
    expect(a.AlarmActions ?? []).toHaveLength(0);
  });

  test('role 2 — guardrail: STRICTLY below the decision threshold, 2 consecutive, missing = stop', () => {
    const [g] = byName('Guardrail');
    const [d] = byName('ClientAvailability');
    expect(g).toBeDefined();
    expect(g.Threshold).toBe(50);
    // THE ordering the split exists for: a guardrail at or above the decision
    // threshold fires first and self-terminates the injection before the operator has
    // decided anything — the demo ends in minute two with nothing to approve.
    expect(g.Threshold).toBeLessThan(d.Threshold);
    expect(g.EvaluationPeriods).toBe(2);
    expect(g.DatapointsToAlarm).toBe(2);
    // Total telemetry loss ALSO stops the injection.
    expect(g.TreatMissingData).toBe('breaching');
    expect(g.AlarmActions ?? []).toHaveLength(0);
  });

  test('role 3 — app health: one alarm per Region DIMENSION, reading the names the workload emits', () => {
    const health = byName('AppHealth');
    expect(health).toHaveLength(REGIONS.length);
    for (const region of REGIONS) {
      const [a] = health.filter((p) => String(p.AlarmName).endsWith(region.name));
      expect(a).toBeDefined();
      expect(a.Threshold).toBe(99);
      expect(a.EvaluationPeriods).toBe(3);
      expect(a.DatapointsToAlarm).toBe(3);
      // No telemetry in a region == that region is not serving. For the RECOVERY
      // measure that is the truth — and it is why the standby's alarm opens in ALARM
      // deliberately: its transition to OK after the DNS flip IS the measured recovery.
      expect(a.TreatMissingData).toBe('breaching');
      // The Region dimension, with the region NAME the app echoes (AWS_REGION) and the
      // workload copies into emit_request — the other half of the 4c metric contract.
      const dims = (a.Metrics as any[])
        .filter((m) => m.MetricStat)
        .map((m) => m.MetricStat.Metric);
      expect(dims.map((m: any) => m.MetricName).sort()).toEqual([
        'RegionError',
        'RegionSuccess',
      ]);
      for (const m of dims) {
        expect(m.Dimensions).toEqual([{ Name: 'Region', Value: region.name }]);
      }
    }
  });

  test('no alarm anywhere carries an action — the operator decides, nothing auto-fires', () => {
    // C-001's alarm-side half. FIS consumes the guardrail as STATE, ARC reads the
    // app-health pair as STATE; SNS on any of them is a path to an automated reaction
    // this demo's premise (a HUMAN approves the failover) forbids.
    for (const [name] of synthAll()) {
      for (const a of alarmsOf(name)) {
        expect(a.AlarmActions ?? []).toHaveLength(0);
        expect(a.OKActions ?? []).toHaveLength(0);
      }
    }
  });

  test('alarm ARNs are exported for steps 6 and 8', () => {
    const t = synthAll().get(`${APP_ID}-${regionSuffix(REGIONS[0])}`)!;
    const outputs = Object.keys(t.toJSON().Outputs ?? {});
    // Guardrail → failure-injection stopConditionAlarm; AppHealth pair → the ARC
    // plan's associatedAlarms; Decision → runbook deep-link only.
    expect(outputs).toEqual(
      expect.arrayContaining([
        'GuardrailAlarmArn',
        'DecisionAlarmArn',
        'AppHealthAlarmArn0',
        'AppHealthAlarmArn1',
      ]),
    );
  });

  test('the app echoes its region on ERROR responses, not just successes', () => {
    // Injected failures are 500s and timeouts. A 500 without a region lands in the
    // workload's "unknown" bucket, thinning the degraded region's error series at
    // exactly the moment the app-health alarm needs it. The app always knows REGION —
    // it is env config, not a database read.
    const server = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'app', 'server.py'),
      'utf8',
    );
    const errorResponses = server.match(/_respond\(500.*$/gm) ?? [];
    expect(errorResponses.length).toBeGreaterThanOrEqual(3);
    for (const resp of errorResponses) {
      expect(resp).toContain('"region": REGION');
    }
  });
});

describe('failure injection (step 6)', () => {
  const resourcesOf = (stackName: string, type: string): Record<string, any>[] =>
    Object.values(synthAll().get(stackName)!.findResources(type)).map(
      (r) => (r as { Properties: Record<string, any> }).Properties,
    );
  const primary = `${APP_ID}-${regionSuffix(REGIONS[0])}`;
  const secondary = `${APP_ID}-${regionSuffix(REGIONS[1])}`;
  const fisOf = (s: string) => resourcesOf(s, 'AWS::FIS::ExperimentTemplate');

  test('FIS templates exist ONLY in the primary region', () => {
    // The gray failure is scoped to the primary: the secondary is the healthy region the
    // operator switches TO, and degrading it removes the thing being switched to.
    expect(fisOf(primary).length).toBeGreaterThan(0);
    expect(fisOf(secondary)).toHaveLength(0);
  });

  test('one template set PER AZ across every AZ — region-wide, not one sick zone', () => {
    // A single degraded AZ's correct answer is a zonal shift, not a Region switch, and a
    // sharp audience says so. Covering every AZ is what makes the failover the right
    // answer. 5 faults x AZ_COUNT AZs (latency, packet-loss, memory-stress,
    // power-interruption, brownout).
    const templates = fisOf(primary);
    expect(templates).toHaveLength(5 * AZ_COUNT);
    // One distinct AZ filter per AZ, each shared by the three faults.
    const distinctAz = new Set(
      templates.map((p) =>
        JSON.stringify((Object.values(p.Targets)[0] as any).Filters[0].Values[0]),
      ),
    );
    expect(distinctAz.size).toBe(AZ_COUNT);
  });

  test('AZ filters resolve at DEPLOY time, never a synth-time literal', () => {
    // Stack.availabilityZones was verified offline to return the LITERAL strings
    // ['dummy1a','dummy1b','dummy1c'] for an account+region stack, and only TWO tokens
    // for a region-only stack like ours. Either way the failure is silent: a
    // Placement.AvailabilityZone filter for 'dummy1a' resolves zero targets, and two
    // tokens quietly covers 2 of 3 AZs while still calling itself region-wide.
    // Fn::GetAZs is the only form that resolves to the real AZ names the VPC used.
    for (const p of fisOf(primary)) {
      const value = (Object.values(p.Targets)[0] as any).Filters[0].Values[0];
      expect(JSON.stringify(value)).toContain('Fn::GetAZs');
      expect(JSON.stringify(value)).not.toContain('dummy');
    }
  });

  test('every experiment stops on the GUARDRAIL alarm — never on `none`', () => {
    // The upstream sample ships stopConditions: none, which lets a 30-minute experiment
    // run unbounded. And it must be the guardrail (50%), NOT the decision signal (99%):
    // stopping on the decision signal would halt the injection at the exact moment the
    // operator got their reason to act, and the demo would heal itself before the human
    // decided anything.
    const guardrailLogicalId = Object.keys(
      synthAll().get(primary)!.findResources('AWS::CloudWatch::Alarm', {
        Properties: { Threshold: 50 },
      }),
    )[0];
    expect(guardrailLogicalId).toBeDefined();
    for (const p of fisOf(primary)) {
      expect(p.StopConditions).toHaveLength(1);
      expect(p.StopConditions[0].Source).toBe('aws:cloudwatch:alarm');
      expect(JSON.stringify(p.StopConditions[0].Value)).toContain(guardrailLogicalId);
      expect(JSON.stringify(p.StopConditions)).not.toContain('"none"');
    }
  });

  test('faults target EKS NODES by the ChaosAllowed tag, applied externally at arm time', () => {
    // aws:ec2:instance, not pods: the shipped faults are aws:ssm:send-command documents
    // that run on an instance. The tag is NOT applied by CloudFormation (managed
    // node-group instances belong to an AWS-owned ASG), which makes tagging the
    // deliberate arming gesture — an un-armed experiment resolves nothing.
    for (const p of fisOf(primary)) {
      const target = Object.values(p.Targets)[0] as any;
      expect(target.ResourceType).toBe('aws:ec2:instance');
      expect(target.ResourceTags).toEqual({ ChaosAllowed: 'true' });
    }
    // And nothing in ANY template tags an instance with ChaosAllowed — that would defeat
    // the arming gate. The observer bastion (observer stack) IS a CFN-declared instance,
    // but it must NOT carry the arming tag, so assert on the TAG, not on instance presence.
    for (const [, t] of synthAll()) {
      for (const inst of Object.values(t.findResources('AWS::EC2::Instance')) as any[]) {
        const tags = (inst.Properties?.Tags ?? []) as Array<{ Key: string; Value: string }>;
        expect(tags.some((tag) => tag.Key === 'ChaosAllowed')).toBe(false);
      }
    }
  });

  // ── T3: the AZ power-interruption template (2026-09-02 feature) ─────────────────────
  const powerTemplates = () =>
    fisOf(primary).filter((p) =>
      Object.values(p.Actions).some((a: any) => a.ActionId === 'aws:ec2:stop-instances'));

  test('power-interruption: one template per AZ, and the autoshift action is ABSENT', () => {
    const templates = powerTemplates();
    expect(templates).toHaveLength(AZ_COUNT);
    for (const p of templates) {
      const ids = Object.values(p.Actions).map((a: any) => a.ActionId).sort();
      // EXACTLY these four — the scenario's RDS/ElastiCache/EBS actions are deliberately
      // not carried, and above all `aws:arc:start-zonal-autoshift` must NOT be here: the
      // operator's cockpit zonal shift IS the recovery beat, and FIS auto-shifting five
      // minutes in would steal it while the demo reported success. Mutation: add the
      // autoshift action to the construct → this line goes red.
      expect(ids).toEqual([
        'aws:ec2:api-insufficient-instance-capacity-error',
        'aws:ec2:asg-insufficient-instance-capacity-error',
        'aws:ec2:stop-instances',
        'aws:network:disrupt-connectivity',
      ]);
    }
  });

  test('power-interruption: durations — 15 min impairment, 2 min network blip', () => {
    // The fault must not outlive the zonal shift's 15-minute default (the established
    // two-lifetimes rule), and the subnet blackhole is the scenario's own PT2M: long
    // enough to force timeouts and DNS refresh, short enough that regional-service DNS
    // recovers while the AZ stays dark.
    for (const p of powerTemplates()) {
      const byId = Object.fromEntries(
        Object.values(p.Actions).map((a: any) => [a.ActionId, a]));
      expect(byId['aws:ec2:stop-instances'].Parameters).toEqual({
        completeIfInstancesTerminated: 'true',
        startInstancesAfterDuration: 'PT15M',
      });
      expect(byId['aws:ec2:asg-insufficient-instance-capacity-error'].Parameters.duration).toBe('PT15M');
      expect(byId['aws:ec2:asg-insufficient-instance-capacity-error'].Parameters.percentage).toBe('100');
      expect(byId['aws:ec2:api-insufficient-instance-capacity-error'].Parameters.duration).toBe('PT15M');
      expect(byId['aws:network:disrupt-connectivity'].Parameters).toEqual({
        duration: 'PT2M', scope: 'all',
      });
    }
  });

  test('power-interruption: targets — armed instances/ASGs, per-AZ tagged subnets, Karpenter role', () => {
    for (const p of powerTemplates()) {
      const targets = p.Targets as Record<string, any>;
      // Instances: the SAME ChaosAllowed arm gate as every other fault, AZ-filtered.
      expect(targets.oneAZ.ResourceType).toBe('aws:ec2:instance');
      expect(targets.oneAZ.ResourceTags).toEqual({ ChaosAllowed: 'true' });
      // ASGs: tagged at ARM time (EKS owns the ASG; CloudFormation cannot tag it).
      expect(targets.armedAsgs.ResourceType).toBe('aws:ec2:autoscaling-group');
      expect(targets.armedAsgs.ResourceTags).toEqual({ ChaosAllowed: 'true' });
      // Subnets: synth-time tag + per-AZ filter bounds the 2-min blip to ONE zone.
      expect(targets.oneAzSubnets.ResourceType).toBe('aws:ec2:subnet');
      expect(targets.oneAzSubnets.ResourceTags).toEqual({ AzImpairmentPower: 'DisruptSubnet' });
      expect(targets.oneAzSubnets.Filters[0].Path).toBe('AvailabilityZone');
      // Launch-pause: the Karpenter controller role, by explicit ARN (the action does
      // not support tag targeting) — blocks the Karpenter half of the heal-race.
      expect(targets.provisioningRoles.ResourceType).toBe('aws:iam:role');
      expect(targets.provisioningRoles.ResourceArns).toHaveLength(1);
    }
  });

  test('power-interruption: the demo VPC subnets carry the DisruptSubnet tag at synth', () => {
    // The blip target selects by AzImpairmentPower=DisruptSubnet. A zero-match tag is a
    // silent no-op start (the house failure mode), so the tag's presence on the actual
    // subnets is pinned here, in the same build that pins the target's tag.
    const subnets = Object.values(
      synthAll().get(primary)!.findResources('AWS::EC2::Subnet'));
    expect(subnets.length).toBeGreaterThan(0);
    for (const s of subnets as any[]) {
      const tags = Object.fromEntries(
        (s.Properties.Tags ?? []).map((t: any) => [t.Key, t.Value]));
      expect(tags.AzImpairmentPower).toBe('DisruptSubnet');
    }
  });

  test('power-interruption: FIS role carries InjectApiError with the FisActionId condition', () => {
    // The ICE actions need `ec2:InjectApiError`, which declares NO resource type — an
    // ARN-scoped grant authorizes nothing (bug class 22c family). Granted inline with
    // the documented FisActionId condition rather than assumed present in the AWS-managed
    // policies, whose content this account's ReadOnly role cannot read.
    const policies = Object.values(
      synthAll().get(primary)!.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap(
      (p: any) => p.Properties.PolicyDocument.Statement);
    const inject = statements.find((s: any) =>
      JSON.stringify(s.Action).includes('ec2:InjectApiError'));
    expect(inject).toBeDefined();
    expect(inject.Resource).toBe('*');
    expect(inject.Condition['ForAnyValue:StringEquals']['ec2:FisActionId'].sort()).toEqual([
      'aws:ec2:api-insufficient-instance-capacity-error',
      'aws:ec2:asg-insufficient-instance-capacity-error',
    ]);
  });

  test('power-interruption: az=templateId pairs are threaded, all four layers', () => {
    // Same four-layer thread as latency/packet-loss: region-stack CfnOutput →
    // .projen deploy parameter → front-door CfnParameter → cockpit env → handler FAULTS.
    const regionOutputs = synthAll().get(primary)!.toJSON().Outputs ?? {};
    expect(regionOutputs.FisPowerTemplatesByAz).toBeDefined();
    const tasks = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'));
    expect(JSON.stringify(tasks)).toContain('$REGION_0_FISPOWERTEMPLATESBYAZ');
    const handler = fs.readFileSync(path.join(__dirname, '..', 'src', 'cdk', 'lib',
      'constructs', 'cockpit', 'lambda', 'handler.py'), 'utf8');
    expect(handler).toContain('"power-interruption-single-az"');
    expect(handler).toContain('FIS_POWER_TEMPLATES_BY_AZ');
    const cockpit = fs.readFileSync(path.join(__dirname, '..', 'src', 'cdk', 'lib',
      'constructs', 'cockpit', 'cockpit.ts'), 'utf8');
    expect(cockpit).toContain('FIS_POWER_TEMPLATES_BY_AZ: props.fisPowerTemplatesByAz');
  });

  // ── T3/T6: the brownout template (gray AZ fault, 2026-09-02 feature) ─────────────────
  const brownoutTemplates = () =>
    fisOf(primary).filter((p) => JSON.stringify(p.Actions).includes(APP_RECORD_NAME));

  test('brownout: latency scoped to the pod↔NLB path — the app record and NOTHING else', () => {
    // Design D3. The tc document shapes egress toward Sources. With client-IP
    // preservation pinned off (app.yaml), EVERY pod response — health checks and client
    // data — is addressed to the NLB's ENI IPs, and the app record resolves on-host
    // (dig, at experiment start) to exactly those IPs. So ONE Sources entry shapes
    // exactly the pod↔NLB path, and the Aurora path — which shares these subnets and so
    // can never be excluded by CIDR — is untouched BY CONSTRUCTION. 500ms on the DB path
    // breached the 50% guardrail live (2026-09-01); this scoping is what keeps a 2,500ms
    // brownout gray instead of repeating that.
    const templates = brownoutTemplates();
    expect(templates).toHaveLength(AZ_COUNT);
    for (const p of templates) {
      const action = Object.values(p.Actions)[0] as any;
      expect(JSON.stringify(action.Parameters.documentArn))
        .toContain('AWSFIS-Run-Network-Latency-Sources');
      const docParams = action.Parameters.documentParameters;
      // A PLAIN STRING, deliberately. The region-wide faults' documentParameters embed
      // DB endpoint tokens, so they synthesize as Fn::Join OBJECTS; the brownout's
      // Sources is a synth-time constant. Any token here means a database endpoint
      // crept in — the mutation this test exists to catch (add the writer endpoint →
      // this typeof goes red). The INVERSE of the reader-endpoint test above.
      expect(typeof docParams).toBe('string');
      const parsed = JSON.parse(docParams);
      expect(parsed.Sources).toBe(APP_RECORD_NAME);
      expect(parsed.TrafficType).toBe('egress');
      expect(parsed.FlowsPercent).toBe('100');
      expect(parsed.DurationSeconds).toBe('900');
      expect(action.Parameters.duration).toBe('PT15M');
      // Same armed-instance, one-AZ target as every other single-AZ fault.
      const target = Object.values(p.Targets)[0] as any;
      expect(target.ResourceType).toBe('aws:ec2:instance');
      expect(target.ResourceTags).toEqual({ ChaosAllowed: 'true' });
    }
  });

  test('brownout severity is TWO-SIDED: check always passes, client always breaches the SLO', () => {
    // T6, re-derived 2026-09-04 from TWO live runs at the SHIPPED severity
    // (EXPXEWF6Dbb2B6qiug 2026-09-03, EXPhWdkgP52mRngRvz 2026-09-04). The previous
    // version of this test asserted a FLAP, and the flap does not exist:
    //
    //   The health check pays ONE shaped hop -- the pod's egress response to the NLB ENI
    //   -- so at 800ms +/- 400ms its RTT is ~0.5-1.3s including base. Max observed 1.24s
    //   against a 2s timeout. No jitter draw fails a single check, let alone the three
    //   consecutive ones needed to mark a target unhealthy. Both runs held 3/3 targets
    //   HEALTHY for their whole duration, with ZERO errors.
    //
    //   The client pays ~3 shaped hops: 2,240ms at 800ms (2.80x) and 8,700ms at 2,500ms
    //   (3.48x), both measured.
    //
    // That asymmetry is a CONSTRAINT, not an accident: straddling the 2s check timeout
    // needs delay ~1,800-2,000ms, which puts client p90 at ~5.0-5.6s -- past the app's 5s
    // read timeout. A flapping check and a surviving client are MUTUALLY EXCLUSIVE, so
    // the correct target state is the one measured: check green, client slow.
    //
    // The two amplification constants are deliberately different and used in the
    // conservative direction on each side -- the LOW measurement where the assertion
    // needs the client to be slow ENOUGH, the HIGH one where it needs the client to stay
    // under the error wall. A single averaged constant would let one side pass on the
    // other side's evidence.
    const HC_TIMEOUT_MS = 2000; // read back live from the target group 2026-09-03
    const HC_BASE_RTT_MS = 150; // baseline p90 93ms, max 109ms; rounded up
    const CLIENT_AMP_LOW = 2.8; // 2,240ms p90 at 800ms delay -- the shipped severity
    const CLIENT_AMP_HIGH = 3.5; // 8,700ms p90 at 2,500ms delay -- the worse case
    const appSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'app', 'common.py'), 'utf8');
    const readTimeoutMs = Number(appSrc.match(/read_timeout=(\d+)/)![1]) * 1000;
    // The SLO bar the chart classifies against, read from the emitter rather than
    // restated -- this test's whole floor is "the faulted zone must visibly sag on that
    // chart", so a bar change must reach here.
    const sloMs = Number(fs.readFileSync(
      path.join(__dirname, '..', 'src', 'locust', 'az_metrics.py'), 'utf8')
      .match(/^AZ_SLO_MS = (\d+)/m)![1]);

    for (const p of brownoutTemplates()) {
      const parsed = JSON.parse(
        (Object.values(p.Actions)[0] as any).Parameters.documentParameters);
      const delay = Number(parsed.DelayMilliseconds);
      const jitter = Number(parsed.JitterMilliseconds);
      // HEALTH-CHECK CEILING -- the gray/black discriminator. Even the SLOWEST shaped
      // check must clear the timeout, or the target goes unhealthy, the NLB routes around
      // the zone within a minute, and the beat becomes the black fault's shape with the
      // operator's judgment call erased. Proven live at 2,500ms: solid-down in ~40s.
      expect(delay + jitter + HC_BASE_RTT_MS).toBeLessThan(HC_TIMEOUT_MS);
      // CLIENT FLOOR -- the fault must be VISIBLE on the SLO chart. A nominal request
      // (no jitter) has to breach the bar, or the chart reads 100% and the fault shows
      // nothing. 2.8 x 800 = 2,240ms against a 2,000ms bar; measured 66.2% on the
      // faulted zone, which is the intended "clearly degraded, still serving" shape.
      expect(CLIENT_AMP_LOW * delay).toBeGreaterThan(sloMs);
      // CLIENT CEILING -- even the jittered slow tail must stay under the app's read
      // timeout, so the zone degrades with ZERO errors rather than cratering toward the
      // 50% guardrail that self-terminated the 500ms DB-path experiment live.
      expect(CLIENT_AMP_HIGH * (delay + jitter)).toBeLessThan(readTimeoutMs);
      // Jitter must be REAL, but for a different reason than the old flap story gave:
      // jitter is what leaves part of the distribution INSIDE the bar, which is why the
      // faulted zone reads ~66% rather than 0% and stays distinguishable from black.
      expect(jitter).toBeGreaterThanOrEqual(delay * 0.2);
    }
  });

  test('brownout: az=templateId pairs are threaded, all four layers', () => {
    // Same four-layer thread as every other single-AZ fault (bug class 4, both
    // directions — the derived deploy-contract test in cockpit.test.ts covers the
    // param↔supply pairing automatically once the param exists).
    const regionOutputs = synthAll().get(primary)!.toJSON().Outputs ?? {};
    expect(regionOutputs.FisBrownoutTemplatesByAz).toBeDefined();
    const tasks = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'));
    expect(JSON.stringify(tasks)).toContain('$REGION_0_FISBROWNOUTTEMPLATESBYAZ');
    const handler = fs.readFileSync(path.join(__dirname, '..', 'src', 'cdk', 'lib',
      'constructs', 'cockpit', 'lambda', 'handler.py'), 'utf8');
    expect(handler).toContain('"brownout-single-az"');
    expect(handler).toContain('FIS_BROWNOUT_TEMPLATES_BY_AZ');
    const cockpit = fs.readFileSync(path.join(__dirname, '..', 'src', 'cdk', 'lib',
      'constructs', 'cockpit', 'cockpit.ts'), 'utf8');
    expect(cockpit).toContain('FIS_BROWNOUT_TEMPLATES_BY_AZ: props.fisBrownoutTemplatesByAz');
  });

  test('the L1 knob exists in BOTH regions, seeded to an inert 0', () => {
    // Seeded "0" so the stack deploys green with nothing degraded. Both regions have one:
    // render-manifest.py rejects an empty placeholder, and pointing the standby at a
    // nonexistent parameter would make every standby request pay a failed SSM call.
    for (const stack of [primary, secondary]) {
      const knobs = resourcesOf(stack, 'AWS::SSM::Parameter');
      expect(knobs).toHaveLength(1);
      expect(knobs[0].Value).toBe('0');
      expect(knobs[0].Name).toContain('error-rate');
    }
  });

  test('the app READS the knob and fails requests — the knob is inert otherwise', () => {
    // THE gotcha for this pattern: creating an SSM parameter changes nothing on its own.
    // Without a consumer the operator raises the knob, nothing happens, and every deploy
    // is still green. These three have to hold together.
    const server = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'app', 'server.py'),
      'utf8',
    );
    const dockerfile = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'app', 'Dockerfile'),
      'utf8',
    );
    const manifest = fs.readFileSync(
      path.join(__dirname, '..', APP_MANIFEST),
      'utf8',
    );
    expect(server).toContain('from error_rate import should_fail');
    expect(server).toContain('_injected');
    // The image must actually SHIP the helper. The Dockerfile copies a named list, so a
    // helper that exists in the build context but not in the COPY is an ImportError at
    // container start — and it would pass every other check here.
    expect(dockerfile).toMatch(/COPY .*error_rate\.py/);
    expect(manifest).toContain('ERROR_RATE_PARAM');
  });

  test('injection never touches /health — a gray failure, not a hard outage', () => {
    // /health makes no database call by design, and both probes hit it. Failing it would
    // pull every degraded pod out of the load balancer's target group, converting partial
    // degradation into connection refusals: a completely different signature, and one the
    // failover story does not need.
    const server = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'app', 'server.py'),
      'utf8',
    );
    // The health branch returns before any injection check.
    const healthBranch = server.slice(
      server.indexOf('if parsed.path in ("/health", "/ready")'),
      server.indexOf('if parsed.path == "/orders"'),
    );
    expect(healthBranch.length).toBeGreaterThan(0);
    expect(healthBranch).not.toContain('_injected');
  });

  test('the vendored python knob reader has module-scope boto3 timeouts', () => {
    // Rule 16, and it is on the REQUEST HOT PATH here. Default botocore timeouts are
    // effectively unbounded, so a hanging get_parameter outlives the caller's own budget
    // and the `except: return 0` fallback never runs — the failure looks like an app
    // outage rather than a knob read. The TTL cache makes it worse: the cache is only
    // refreshed by a call that COMPLETES.
    for (const p of [
      path.join(__dirname, '..', 'src', 'app', 'error_rate.py'),
      path.join(
        __dirname, '..', 'src', 'cdk', 'lib', 'constructs', 'failure-injection',
        'app-helper', 'error_rate.py',
      ),
      path.join(
        __dirname, '..', 'src', 'cdk', 'lib', 'constructs', 'failure-injection',
        'inject-api', 'lambda', 'inject', 'handler.py',
      ),
    ]) {
      const src = fs.readFileSync(p, 'utf8');
      expect(src).toContain('botocore.config.Config');
      expect(src).toContain('connect_timeout');
      expect(src).toContain('read_timeout');
      expect(src).toContain('retries');
      // The config must actually be PASSED, not merely defined.
      expect(src).toMatch(/boto3\.client\(\s*"ssm",\s*config=_BOTO_CFG\s*\)/);
    }
  });

  test('the app ships the SAME knob reader the construct family defines', () => {
    // Duplicated because Docker cannot COPY from outside its build context. This keeps
    // the copy honest: a drifted duplicate keeps reading yesterday's contract and
    // nothing else fails.
    const canonical = fs.readFileSync(
      path.join(
        __dirname, '..', 'src', 'cdk', 'lib', 'constructs', 'failure-injection',
        'app-helper', 'error_rate.py',
      ),
      'utf8',
    );
    const shipped = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'app', 'error_rate.py'),
      'utf8',
    );
    expect(shipped).toBe(canonical);
  });

  test('the randomized trigger is vendored but NEVER instantiated', () => {
    // C-001: an FSI demo is human-approved. Nothing may start chaos unattended. The stub
    // creates no resources, but instantiating it is still the wrong shape to ship.
    const app = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'app.ts'),
      'utf8',
    );
    const regionStack = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'region-stack.ts'),
      'utf8',
    );
    for (const src of [app, regionStack]) {
      expect(src).not.toContain('new FisRandomTrigger');
    }
    // And no EventBridge rule anywhere that could start an experiment on a schedule.
    for (const [name] of synthAll()) {
      expect(Object.keys(resourcesOf(name, 'AWS::Events::Rule'))).toHaveLength(0);
    }
  });

  test('the InjectApi control-plane surface is OFF — the CLI is the path', () => {
    // Opt-in by design: the button adds a Lambda + API Gateway that only a demo wanting
    // a UI needs, and this one drives L1 from the CLI.
    for (const [name] of synthAll()) {
      expect(resourcesOf(name, 'AWS::ApiGateway::RestApi')).toHaveLength(0);
    }
  });

  test('every FIS output the wrapper reads is exported', () => {
    const outputs = Object.keys(synthAll().get(primary)!.toJSON().Outputs ?? {});
    expect(outputs).toEqual(
      expect.arrayContaining([
        'ErrorRateParamName',
        'FisLatencyTemplateIds',
        'FisPacketLossTemplateIds',
        'FisMemoryStressTemplateIds',
        // The wrapper resolves node instances through the node group to tag them.
        'NodeGroupName',
      ]),
    );
  });

  test('the FIS network faults resolve the interface on the HOST, not by a guessed name', () => {
    // The construct defaults Interface to the literal 'ens5'. AWS's document reference
    // documents a sentinel instead: "ALL and DEFAULT values are supported. The default is
    // DEFAULT, which will target the primary network interface for the Operating System."
    // A wrong device name is the worst kind of wrong here — tc attaches to nothing, the
    // fault injects nothing, and FIS still reports the experiment as running.
    // Filter by the SSM DOCUMENT names, not a bare 'Network' substring: the
    // power-interruption template's disrupt-connectivity action also says "network",
    // but it is not an SSM-document fault and carries no documentParameters. The
    // brownout rides the SAME latency document and must satisfy the same
    // DEFAULT-interface and explicit-egress rules, so it is counted here.
    const networkFaults = fisOf(primary).filter((p) =>
      JSON.stringify(p.Actions).includes('Network-Latency')
      || JSON.stringify(p.Actions).includes('Network-Packet-Loss'),
    );
    expect(networkFaults.length).toBe(3 * AZ_COUNT); // latency + packet loss + brownout, per AZ
    for (const p of networkFaults) {
      const docParams = JSON.stringify(
        (Object.values(p.Actions)[0] as any).Parameters.documentParameters,
      );
      expect(docParams).toContain('DEFAULT');
      expect(docParams).not.toContain('ens5');
      // egress, not the document's ingress default: the region-wide faults shape latency
      // TOWARD the database dependency; the brownout shapes it toward the NLB. Either
      // way the pods' RESPONSES are the shaped direction.
      expect(docParams).toContain('egress');
    }
  });

  /**
   * SEVERITY CONTRACT, derived from the app's OWN timeout rather than restated here.
   *
   * A fault the cockpit advertises as an availability mover must actually be able to fail
   * a request, and a request only fails when it exceeds `read_timeout` in common.py. Both
   * network faults shipped at construct defaults that could NOT do that, and both were
   * proven inert live on 2026-09-01 -- 100ms delay gave reads 97ms -> 1,325ms and 10% loss
   * gave ~1,100ms, each with ZERO errors, so availability sat at a flat 100% while the
   * demo's entire premise is that the operator sees a reason to fail over.
   *
   * The amplification factor is the measured number of database round trips per read
   * (+1,228ms observed per 100ms injected). It is an empirical constant, so it is stated
   * once, here, with its provenance -- but the TIMEOUT is parsed from the application
   * source, so lowering the delay below the useful threshold, or tightening the app's
   * timeout, turns this red instead of silently producing a demo that proves nothing.
   */
  test('network fault severity is calibrated to exceed the app read timeout', () => {
    const appSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'app', 'common.py'), 'utf8',
    );
    const readTimeoutMs = Number(appSrc.match(/read_timeout=(\d+)/)![1]) * 1000;
    expect(readTimeoutMs).toBeGreaterThan(0);

    /** Measured live 2026-09-01: +1,228ms of read p90 per 100ms of injected delay. */
    const READ_ROUND_TRIPS = 12.3;

    /**
     * documentParameters is NOT a plain string in the synthesized template: it embeds the
     * database endpoint, which is a CFN token, so CDK emits an Fn::Join object. Read the
     * numbers out of the stringified form -- robust to both shapes and to JSON escaping.
     */
    const paramBlobs = (needle: string): string[] =>
      fisOf(primary)
        .filter((p) => JSON.stringify(p.Actions).includes(needle))
        .map((p) => JSON.stringify(
          (Object.values(p.Actions)[0] as any).Parameters.documentParameters,
        ));

    // The brownout reuses the latency DOCUMENT but is calibrated against the 6s HTTP
    // health-check timeout, not the DB round-trip amplification — its own two-sided test
    // below owns that window. Distinguished by Sources content: only the brownout's is
    // the app record.
    const latency = paramBlobs('Network-Latency')
      .filter((b) => !b.includes(APP_RECORD_NAME));
    expect(latency.length).toBe(AZ_COUNT);
    for (const blob of latency) {
      const delayMs = Number(blob.match(/DelayMilliseconds\D+(\d+)/)![1]);
      const amplifiedP90 = delayMs * READ_ROUND_TRIPS;
      // TWO-SIDED, because severity has a CEILING as well as a floor. Proven live
      // 2026-09-01: at 500ms the amplified p90 (~6.2s) put EVERY read past the timeout,
      // availability hit 0%, the 50% ClientAvailabilityGuardrail fired, and FIS halted the
      // experiment itself -- the demo healed before the operator could decide. A one-sided
      // "must exceed the timeout" assertion is what allowed that, so it is gone.
      //
      // The band lives where the amplified p90 sits JUST UNDER the timeout: the slow tail
      // of the round-trip distribution crosses, the rest does not.
      expect(amplifiedP90).toBeGreaterThan(readTimeoutMs * 0.8); // tail must reach it
      expect(amplifiedP90).toBeLessThan(readTimeoutMs * 1.05); // but must not swamp it
    }

    const loss = paramBlobs('Packet-Loss');
    expect(loss.length).toBe(AZ_COUNT);
    for (const blob of loss) {
      const lossPercent = Number(blob.match(/LossPercent\D+(\d+)/)![1]);
      // 10% was absorbed ENTIRELY by TCP retransmission (proven live, zero errors), so it
      // must be meaningfully higher. Capped well under half because a majority-drop link
      // would fail everything and trip the same guardrail the latency overshoot did.
      expect(lossPercent).toBeGreaterThan(10);
      expect(lossPercent).toBeLessThanOrEqual(40);
    }
  });

  /**
   * The Sources list must carry BOTH database endpoints, and the reader is the one that
   * matters.
   *
   * The app splits its traffic -- writes to the writer endpoint, reads to `cluster-ro-*`
   * (see common.py and the stack's DbReaderEndpoint output). The templates originally
   * listed the WRITER only, which reached reads solely because a single-instance cluster
   * resolved both names to the same address. That is no longer the case: as of 2026-09-04
   * each member runs a writer plus TWO readers (one per remaining AZ), so `cluster-ro-*`
   * resolves to instances the writer entry does not cover. A writer-only Sources list
   * would now let every read sail through untouched while FIS still reported the
   * experiment as running -- and the severity values above are calibrated on READ
   * amplification, so they would quietly stop meaning anything.
   *
   * Asserted as a SET of GetAtt attributes, not with substring containment: the writer
   * attribute 'Endpoint.Address' is a suffix of the reader's 'ReadEndpoint.Address', so a
   * reader-only list would satisfy a naive toContain for the writer as well.
   */
  test('FIS network Sources include the reader endpoint, not just the writer', () => {
    /** Every GetAtt attribute name referenced anywhere inside a value. */
    const getAttrs = (node: any, acc: string[] = []): string[] => {
      if (Array.isArray(node)) { node.forEach((n) => getAttrs(n, acc)); return acc; }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === 'Fn::GetAtt' && Array.isArray(v)) acc.push(String(v[1]));
          else getAttrs(v, acc);
        }
      }
      return acc;
    };

    // Filter by the SSM DOCUMENT names, not a bare 'Network' substring: the
    // power-interruption template's disrupt-connectivity action also says "network",
    // but it is not an SSM-document fault and carries no documentParameters.
    //
    // The BROWNOUT is excluded by its Sources content: it reuses the SAME latency
    // document but its scoping contract is the INVERSE of this one -- its Sources is the
    // app record and must carry NO database endpoint (its own test pins that). Requiring
    // DB endpoints of it here would mandate the exact defect its test forbids.
    const networkFaults = fisOf(primary).filter((p) =>
      (JSON.stringify(p.Actions).includes('Network-Latency')
      || JSON.stringify(p.Actions).includes('Network-Packet-Loss'))
      && !JSON.stringify(p.Actions).includes(APP_RECORD_NAME),
    );
    expect(networkFaults.length).toBe(2 * AZ_COUNT); // latency + packet loss, per AZ

    for (const p of networkFaults) {
      const docParams = (Object.values(p.Actions)[0] as any).Parameters.documentParameters;
      const attrs = new Set(getAttrs(docParams));
      expect(attrs).toContain('Endpoint.Address'); // writer
      expect(attrs).toContain('ReadEndpoint.Address'); // reader -- the regression guard
    }
  });

  /**
   * No experiment may outlive the zonal shift that mitigates it.
   *
   * A zonal shift is temporary by design: ARC caps a customer-initiated shift at 72h and
   * demands an expiry up front, and the cockpit defaults it to 15 minutes. If a fault ran
   * longer, the shift would expire mid-experiment -- availability recovers, then sags again
   * with no operator action -- which on stage reads as the shift having FAILED rather than
   * merely expired. So the fault must be no longer than the shift's default lifetime.
   *
   * Also plain demo hygiene: the previous 30 minutes outlasted any segment, so a
   * stopped-and-forgotten experiment kept injecting long after the discussion of it.
   */
  test('no FIS experiment outlives the zonal shift default lifetime', () => {
    /** Cockpit default for a customer-initiated zonal shift. */
    const SHIFT_DEFAULT_MINUTES = 15;

    const durations = fisOf(primary).map((p) => {
      // ISO-8601 duration as CDK renders it, e.g. PT15M.
      const m = JSON.stringify(Object.values(p.Actions)[0]).match(/"PT(\d+)M"/);
      expect(m).not.toBeNull();
      return Number(m![1]);
    });
    expect(durations).toHaveLength(5 * AZ_COUNT); // every fault, every AZ
    for (const mins of durations) {
      expect(mins).toBeLessThanOrEqual(SHIFT_DEFAULT_MINUTES);
      expect(mins).toBeGreaterThanOrEqual(5); // long enough for the 5-min chart window to fill
    }
  });
});

describe('ARC Region Switch skeleton (step 7)', () => {
  const rsName = `${APP_ID}-${FAILOVER_SUFFIX}`;
  const saName = `${APP_ID}-${STANDBY_ACCESS_SUFFIX}`;
  const planProps = (): any =>
    Object.values(
      synthAll().get(rsName)!.findResources('AWS::ARCRegionSwitch::Plan'),
    )[0]!.Properties;
  const workflow = (action: string): any =>
    planProps().Workflows.find((w: any) => w.WorkflowTargetAction === action);
  /** Only the two roles THIS stack authors, found by their explicit RoleName. */
  const arcRoles = (): any[] =>
    Object.values(synthAll().get(rsName)!.findResources('AWS::IAM::Role'))
      .map((r: any) => r.Properties)
      .filter((p) => typeof p.RoleName === 'string' && p.RoleName.includes('-arc-'));

  test('exactly one workflow, carrying exactly three blocks', () => {
    // Step 7 shipped a two-block skeleton on purpose — a wrong executionBlockType string
    // compiles, synthesizes and deploys, then fails only when a human presses the button,
    // so a small body names WHICH literal was wrong. Step 8 filled it in; the two
    // workflows collapsed into one when the plan moved to activePassive (2026-08-26).
    // A postRecovery workflow existed for ONE deploy (plan v4, 2026-08-27) and was
    // removed by operator decision — cleanup lives in build/restore-steady-state.sh,
    // asserted in its own describe block. ONE workflow is again the deliberate count.
    expect(planProps().Workflows).toHaveLength(1);
    expect(workflow('activate').Steps).toHaveLength(3);
  });

  test('block-type literals are exact — the config keys do not spell them', () => {
    // executionBlockType is typed as a bare `string`, so nothing is compiler-checked.
    // And the config key is NOT derivable from the type: EKSResourceScaling pairs with
    // eksResourceScalingConfig, Route53HealthCheck with route53HealthCheckConfig.
    const scale = workflow('activate').Steps[0];
    expect(scale.ExecutionBlockType).toBe('EKSResourceScaling');
    expect(scale.ExecutionBlockConfiguration).toHaveProperty('EksResourceScalingConfig');
    // Found by TYPE, not by index: with one bidirectional workflow the DNS block is last,
    // and an index would silently start asserting against the scaling block.
    const dns = workflow('activate').Steps.find(
      (s: any) => s.ExecutionBlockType === 'Route53HealthCheck',
    );
    expect(dns.ExecutionBlockType).toBe('Route53HealthCheck');
    expect(dns.ExecutionBlockConfiguration).toHaveProperty('Route53HealthCheckConfig');
  });

  test('the ManualApproval gate and its approval role are BOTH gone -- deliberately', () => {
    // Removed 2026-08-26 so the demo executes end to end unattended. Pinned as a test
    // rather than left to a comment because a PARTIAL re-add is a defect this repo already
    // hit live: the gate needs the approval role AND its ApprovePlanExecutionStep grant,
    // and restoring the block alone yields a gate nobody can release -- with IAM, synth,
    // deploy and ARC's own plan evaluation all looking correct.
    const types = workflow('activate').Steps.map((s: any) => s.ExecutionBlockType);
    expect(types).not.toContain('ManualApproval');
    const rs = JSON.stringify(synthAll().get(rsName)!.toJSON());
    expect(rs).not.toContain('ExecutionApprovalConfig');
    expect(rs).not.toContain('ApprovePlanExecutionStep');
    expect(rs).not.toContain('arc-approval');
    expect(arcRoles()).toHaveLength(1);
  });

  test('C-001 needs BOTH enforcement points, not just absent triggers', () => {
    // With the ManualApproval gate removed (2026-08-26) these are no longer defence in
    // depth behind a human gate -- they ARE the control that stops an alarm starting a
    // regional failover with nobody in the loop. Weakening either one is now a posture
    // change, not a tidy-up.
    // Leaving `triggers` empty is necessary and NOT sufficient: associatedAlarms accepts
    // alarmType 'trigger', so a plan with no triggers can still be handed a trigger alarm
    // through the alarm map and start itself.
    const p = planProps();
    expect(p.Triggers).toBeUndefined();
    const alarms = Object.values(p.AssociatedAlarms) as any[];
    expect(alarms.length).toBe(REGIONS.length);
    for (const a of alarms) {
      expect(a.AlarmType).toBe('applicationHealth');
    }
    expect(JSON.stringify(p.AssociatedAlarms)).not.toContain('trigger');
  });

  test('associatedAlarms is a KEYED MAP and recordSets an ARRAY — both verified shapes', () => {
    // Two shapes the design doc had backwards. Prose said recordSets was keyed
    // PrimaryRegion/StandbyRegion; the .d.ts says an array of objects. Getting either
    // wrong is a deploy-time rejection at best.
    const p = planProps();
    expect(Array.isArray(p.AssociatedAlarms)).toBe(false);
    const cfg = workflow('activate').Steps.find(
      (s: any) => s.ExecutionBlockType === 'Route53HealthCheck',
    ).ExecutionBlockConfiguration.Route53HealthCheckConfig;
    expect(Array.isArray(cfg.RecordSets)).toBe(true);
  });

  test('the DNS block targets the SAME record and identifiers the dns stack created', () => {
    // The plan flips records by { hostedZoneId, recordName, recordSetIdentifier }. Rename
    // an identifier on either side and the block matches nothing — it reports success and
    // shifts no traffic. Both sides come from the same constants in regions.ts.
    const cfg = workflow('activate').Steps.find(
      (s: any) => s.ExecutionBlockType === 'Route53HealthCheck',
    ).ExecutionBlockConfiguration.Route53HealthCheckConfig;
    expect(cfg.RecordName).toBe(APP_RECORD_NAME);
    expect(cfg.RecordSets.map((r: any) => r.RecordSetIdentifier).sort()).toEqual([
      'PrimaryRegion',
      'StandbyRegion',
    ]);
    // And they must equal what the DNS stack actually synthesized. The records live in a
    // single RecordSetGroup (not per-region RecordSet resources) because the
    // latency->failover migration is only legal as one atomic change batch -- see
    // dns-stack.ts. This cross-check is the reason that migration needed NO plan edit:
    // the identifiers were preserved, so the plan's reference still matches.
    const dnsRecords = (
      Object.values(
        synthAll()
          .get(`${APP_ID}-${FAILOVER_SUFFIX}`)!
          .findResources('AWS::Route53::RecordSetGroup'),
      ) as { Properties: { RecordSets: { SetIdentifier: string }[] } }[]
    ).flatMap((g) => g.Properties.RecordSets.map((r) => r.SetIdentifier));
    expect(cfg.RecordSets.map((r: any) => r.RecordSetIdentifier).sort()).toEqual(
      dnsRecords.sort(),
    );
  });

  test('exactly ONE arc role remains, and only ARC assumes it', () => {
    // Scoped to the ARC roles by their explicit RoleName. The stack also contains
    // CDK-generated service roles (the reports bucket's auto-delete Lambda) which are not
    // ours to constrain and must not be swept into this assertion -- nor allowed to mask a
    // missing one. This was TWO roles until the approval gate was removed (2026-08-26).
    const roles = arcRoles();
    expect(roles).toHaveLength(1);
    const exec = roles[0];
    expect(exec.RoleName).toContain('-arc-execution');
    // The trust principal is arc-region-switch.amazonaws.com — NOT any r53recovery
    // principal, which belongs to routing controls and readiness (different capabilities).
    expect(JSON.stringify(exec.AssumeRolePolicyDocument)).toContain(
      'arc-region-switch.amazonaws.com',
    );
  });

  test('the boundary denies IAM ESCALATION, org and account writes -- but not read-only simulate', () => {
    // A failover role that can edit IAM can grant itself anything, and explicit deny in a
    // boundary wins over any allow, including one added in a hurry during an incident.
    //
    // The deny is ENUMERATED rather than `iam:*` for a concrete reason: ARC's plan
    // evaluation calls iam:SimulatePrincipalPolicy against these roles to check each step
    // can run, and a blanket iam:* deny cannot be allowed past -- which left evaluation
    // permanently in actionRequired (live 2026-08-26), disabling the very pre-flight gate
    // that protects against a scale-nothing-report-success failover. Simulate is
    // read-only, so permitting it grants no authority.
    const roles = arcRoles();
    expect(roles).toHaveLength(1);
    for (const r of roles) {
      expect(r.PermissionsBoundary).toBeDefined();
    }
    const boundary = Object.values(
      synthAll().get(rsName)!.findResources('AWS::IAM::ManagedPolicy'),
    ).map((p: any) => p.Properties)[0];
    const denies = boundary.PolicyDocument.Statement.filter((s: any) => s.Effect === 'Deny');
    expect(denies).toHaveLength(1);
    const denied: string[] = denies[0].Action;

    // Every escalation family stays denied -- permission mutation, credential mutation,
    // and PassRole (the recommendation engine's privilege-escalation set).
    for (const action of [
      'iam:Attach*',
      'iam:Put*',
      'iam:Create*',
      'iam:Update*',
      'iam:Delete*',
      'iam:Set*',
      'iam:PassRole',
      'organizations:*',
      'account:*',
    ]) {
      expect(denied).toContain(action);
    }
    // ...and the blanket form is GONE, or simulate is unreachable again.
    expect(denied).not.toContain('iam:*');
    // No enumerated pattern may match SimulatePrincipalPolicy. Checked mechanically
    // rather than by eye: a future 'iam:S*' would silently re-break evaluation.
    const matches = (pattern: string, action: string) =>
      new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(action);
    for (const p of denied) {
      expect(matches(p, 'iam:SimulatePrincipalPolicy')).toBe(false);
    }
  });

  test('the execution role can self-simulate, scoped to its own ARN', () => {
    // Live finding 2026-08-26: plan evaluation reported "missing policies
    // [iam:SimulatePrincipalPolicy]" and sat in evaluationState=actionRequired, which
    // disables the Day 2 pre-flight gate -- the one check that catches a
    // scale-nothing-report-success failover. The real blocker was the permissions
    // boundary's blanket `iam:*` deny, not the role policy, so adding the action alone
    // would have changed nothing.
    const policies = Object.values(
      synthAll().get(rsName)!.findResources('AWS::IAM::Policy'),
    ).map((p: any) => p.Properties);
    const statements = policies.flatMap((p) => p.PolicyDocument.Statement);

    const simulate = statements.filter((s: any) =>
      JSON.stringify(s.Action).includes('iam:SimulatePrincipalPolicy'),
    );
    // Scoped to a role ARN rather than '*' (ARCC SAX-08 Outcome 1).
    expect(simulate).toHaveLength(1);
    for (const s of simulate) {
      expect(s.Resource).not.toBe('*');
      expect(JSON.stringify(s.Resource)).not.toContain('"*"');
    }
  });

  test('the execution role can scale EKS, scoped to the two clusters', () => {
    const policies = Object.values(
      synthAll().get(rsName)!.findResources('AWS::IAM::Policy'),
    ).map((p: any) => p.Properties);
    const statements = policies.flatMap((p) => p.PolicyDocument.Statement);
    const eksStatement = statements.find((s: any) => s.Sid === 'EksScaling');
    expect(eksStatement).toBeDefined();
    // UpdateNodegroupConfig is the action the scaling block needs; without it the step
    // fails at execution with an IAM error after the human has already approved.
    expect(eksStatement.Action).toContain('eks:UpdateNodegroupConfig');
    // Scoped, not '*'.
    expect(JSON.stringify(eksStatement.Resource)).not.toBe('"*"');
    expect(JSON.stringify(eksStatement.Resource)).toContain('ClusterArn');
  });

  test('no mutating statement uses a wildcard resource except the documented one', () => {
    // ARC CREATES the Route 53 health checks its DNS block flips, so there is no ARN to
    // scope to at synth time and Route 53 health-check actions do not support
    // resource-level permissions anyway. That statement is the ONLY exception, and the
    // boundary is what bounds it. Any other wildcard-on-write is a regression.
    const statements = Object.values(
      synthAll().get(rsName)!.findResources('AWS::IAM::Policy'),
    )
      .map((p: any) => p.Properties)
      .flatMap((p) => p.PolicyDocument.Statement);
    const READ_ONLY_SIDS = ['AuroraRead', 'ObserveAndReport'];
    const ALLOWED_WILDCARD_SIDS = ['Route53HealthChecks'];
    for (const s of statements as any[]) {
      const wildcard = JSON.stringify(s.Resource) === '"*"';
      if (!wildcard) continue;
      expect([...READ_ONLY_SIDS, ...ALLOWED_WILDCARD_SIDS]).toContain(s.Sid);
    }
    // And the exception must still exist and be recognisable, so removing the comment
    // without removing the grant does not quietly widen the surface.
    expect(statements.some((s: any) => s.Sid === 'Route53HealthChecks')).toBe(true);
  });

  test('the execution role has a namespace-scoped access entry in BOTH clusters', () => {
    // WITHOUT THESE the scaling step fails at execution time — after the approval —
    // while IAM, synth, deploy and ARC's own plan evaluation all look correct. IAM lets
    // ARC call the EKS API; scaling a Deployment is a KUBERNETES authorization decision.
    for (const stack of [rsName, saName]) {
      const entries = Object.values(
        synthAll().get(stack)!.findResources('AWS::EKS::AccessEntry'),
      ).map((e: any) => e.Properties);
      expect(entries).toHaveLength(1);
      const policy = entries[0].AccessPolicies[0];
      // ARC's OWN policy, not the general-purpose AmazonEKSEditPolicy. Plan evaluation
      // validates the role is associated with THIS specific policy, so the wrong one
      // fails evaluation while IAM, synth and deploy all look correct.
      expect(policy.PolicyArn).toContain('AmazonARCRegionSwitchScalingPolicy');
      expect(policy.PolicyArn).not.toContain('AmazonEKSEditPolicy');
      // Namespace-scoped, not cluster admin: the job is to scale one Deployment.
      expect(policy.AccessScope.Type).toBe('namespace');
      expect(policy.AccessScope.Namespaces).toEqual([APP_NAMESPACE]);
    }
  });

  test('the standby access entry deploys in the SECONDARY region, after the plan stack', () => {
    // eks.CfnAccessEntry is a REGIONAL resource, so the standby's entry cannot live in
    // the primary's stack; and it references the role the plan stack creates, so it
    // cannot deploy before it. Both constraints together are why it is its own stack.
    const execs = (() => {
      const tasks = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
      );
      return tasks.tasks.deploy.steps
        .map((s: { exec?: string }) => s.exec ?? '')
        .filter(Boolean) as string[];
    })();
    const rsIdx = execs.findIndex((e) => e.includes(`-${FAILOVER_SUFFIX}"`));
    const saIdx = execs.findIndex((e) => e.includes(`-${STANDBY_ACCESS_SUFFIX}"`));
    expect(rsIdx).toBeGreaterThanOrEqual(0);
    expect(saIdx).toBeGreaterThan(rsIdx);
    expect(execs[saIdx]).toContain(`AWS_REGION="${REGIONS[1].name}"`);
    // And the plan stack itself must follow dns, whose hosted zone it needs.
    const dnsIdx = execs.findIndex((e) => e.includes(`-${DNS_SUFFIX}"`));
    expect(rsIdx).toBeGreaterThan(dnsIdx);
  });
});

describe('the full failover sequence (step 8)', () => {
  const rsName = `${APP_ID}-${FAILOVER_SUFFIX}`;
  const planProps = (): any =>
    Object.values(
      synthAll().get(rsName)!.findResources('AWS::ARCRegionSwitch::Plan'),
    )[0]!.Properties;
  const workflow = (action: string): any =>
    planProps().Workflows.find((w: any) => w.WorkflowTargetAction === action);
  const blockOf = (action: string, type: string): any =>
    workflow(action).Steps.find((s: any) => s.ExecutionBlockType === type)
      .ExecutionBlockConfiguration;

  test('POSITIONAL ORDERING: scale < database < DNS', () => {
    // THE most valuable assertion in this suite. The order is counter-intuitive enough
    // that someone will reasonably "tidy" it — DNS first reads like the obvious way to
    // fail over. Doing so shifts traffic to a standby whose pods are not there yet and
    // to a database that has not accepted the writer, which MOVES the outage instead of
    // ending it. Every other test in this file still passes if the order is wrong.
    const types = workflow('activate').Steps.map((s: any) => s.ExecutionBlockType);
    expect(types).toEqual([
      'EKSResourceScaling',
      'AuroraGlobalDatabase',
      'Route53HealthCheck',
    ]);
    // Asserted as indices too, so a failure message names the relation that broke.
    const at = (t: string) => types.indexOf(t);
    expect(at('EKSResourceScaling')).toBeLessThan(at('AuroraGlobalDatabase'));
    expect(at('AuroraGlobalDatabase')).toBeLessThan(at('Route53HealthCheck'));
  });

  test('the two ungraceful shapes are DIFFERENT — a cross-copy fails', () => {
    // EksResourceScalingUngraceful is { minimumSuccessPercentage: number }; the Aurora
    // one is { ungraceful: string }.
    //
    // CREDIT WHERE IT IS DUE: unlike executionBlockType and alarmType, these two ARE
    // compiler-protected — swapping them is TS2353 in both directions, verified. So this
    // test is not the primary guard; it holds the emitted shape against an addOverride
    // or a cast that would bypass the type. Worth having, but the type system does the
    // real work here, and that is unusual for ARC.
    const eks = blockOf('activate', 'EKSResourceScaling').EksResourceScalingConfig;
    expect(eks.Ungraceful).toEqual({ MinimumSuccessPercentage: expect.any(Number) });
    expect(eks.Ungraceful.Ungraceful).toBeUndefined();

    const aurora = blockOf('activate', 'AuroraGlobalDatabase').GlobalAuroraConfig;
    expect(aurora.Ungraceful).toEqual({ Ungraceful: 'failover' });
    expect(aurora.Ungraceful.MinimumSuccessPercentage).toBeUndefined();
  });

  test('Aurora goes GRACEFUL first, with an ungraceful fallback', () => {
    // switchoverOnly is the zero-data-loss path, and the gray-failure premise is what
    // makes it available: the region is still up and replication still flowing, so the
    // writer can be handed over rather than promoted out from under itself. Starting
    // ungraceful would throw that away — it is the demo's best moment. But with NO
    // fallback a real outage would stall waiting for a clean handover that cannot happen.
    const aurora = blockOf('activate', 'AuroraGlobalDatabase').GlobalAuroraConfig;
    expect(aurora.Behavior).toBe('switchoverOnly');
    expect(aurora.Ungraceful.Ungraceful).toBe('failover');
    // Both member clusters, and the global cluster identifier.
    expect(aurora.DatabaseClusterArns).toHaveLength(REGIONS.length);
    expect(aurora.GlobalClusterIdentifier).toBeDefined();
  });

  test('eksClusters is an array of OBJECTS, minimum two', () => {
    // Written as bare ARN strings in the design doc; the type is Array<EksCluster>, and
    // the CFN reference sets a minimum of 2. Bare strings deploy-fail.
    const eks = blockOf('activate', 'EKSResourceScaling').EksResourceScalingConfig;
    expect(eks.EksClusters).toHaveLength(REGIONS.length);
    expect(REGIONS.length).toBeGreaterThanOrEqual(2);
    for (const c of eks.EksClusters) {
      expect(c).toHaveProperty('ClusterArn');
      expect(typeof c).toBe('object');
    }
  });

  test('scalingResources NAMES the workload, nested APPLICATION -> REGION per the deployed schema', () => {
    // Without it the block has nothing to act on: kubernetesResourceType states only the
    // KIND, and there is no scale-everything mode. A block that resolves no resource
    // reports success while the standby stays at its original size — the plan then shifts
    // traffic onto it. That is the U-2 risk, and this is what closes it.
    //
    // NESTING ORDER is the part that bit us live on 2026-08-26: we had
    // region -> clusterArn -> resource, and CREATE failed with
    //   ScalingResources/0/us-east-2: extraneous key [arn:aws:eks:...] is not permitted
    // The deployed resource schema (vendored in test/fixtures) is APPLICATION-id first,
    // then REGION -- and the inner key is pattern-constrained to a region name, which an
    // ARN can never match. The SDK docs say only "array of maps" and the CDK type is
    // Record<string, Record<string, ...>>, so neither states which key is which: this
    // test reads the PATTERNS OUT OF THE SCHEMA rather than hand-copying them.
    const schema = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, 'fixtures', 'arc-plan-scaling.schema.json'),
        'utf8',
      ),
    );
    const regionPattern = new RegExp(
      Object.keys(schema.definitions.RegionalScalingResource.patternProperties)[0],
    );
    const leafSchema = schema.definitions.KubernetesScalingResource;

    const eks = blockOf('activate', 'EKSResourceScaling').EksResourceScalingConfig;
    expect(eks.ScalingResources).toHaveLength(1);
    expect(eks.KubernetesResourceType).toEqual({
      ApiVersion: 'apps/v1',
      Kind: 'Deployment',
    });

    // Level 1: exactly one application, keyed by the Deployment name.
    const apps = Object.keys(eks.ScalingResources[0]);
    expect(apps).toEqual([APP_DEPLOYMENT_NAME]);

    // Level 2: EVERY region, each key satisfying the schema's region pattern. A region
    // missing here never scales, which is the vacuous-success shape.
    const perRegion = eks.ScalingResources[0][APP_DEPLOYMENT_NAME];
    expect(Object.keys(perRegion).sort()).toEqual(REGIONS.map((r) => r.name).sort());
    for (const key of Object.keys(perRegion)) {
      expect(key).toMatch(regionPattern);
    }

    // Level 3: leaves carry exactly the schema's fields, including every required one.
    for (const leaf of Object.values<any>(perRegion)) {
      for (const req of leafSchema.required) expect(leaf).toHaveProperty(req);
      for (const k of Object.keys(leaf)) {
        expect(Object.keys(leafSchema.properties)).toContain(k);
      }
      expect(leaf.Name).toBe(APP_DEPLOYMENT_NAME);
      expect(leaf.Namespace).toBe(APP_NAMESPACE);
      expect(leaf.HpaName).toBe(APP_HPA_NAME);
    }

    // A cluster ARN must not appear ANYWHERE in here -- eksClusters already names them,
    // and an ARN in a key position is exactly what the region pattern rejects.
    expect(JSON.stringify(eks.ScalingResources)).not.toContain('arn:aws:eks');
    // Both keys are plain literals now, so the whole structure is synth-visible: no
    // deferral, and therefore no CfnJson custom resource left behind for this.
    expect(JSON.stringify(eks.ScalingResources)).not.toContain('Fn::GetAtt');
    expect(
      Object.values(synthAll().get(rsName)!.findResources('Custom::AWSCDKCfnJson')),
    ).toHaveLength(0);

    // Names come from k8s.ts, not hardcoded strings that could drift from the manifests.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'failover-stack.ts'),
      'utf8',
    );
    expect(src).toContain('name: APP_DEPLOYMENT_NAME');
    expect(src).toContain('namespace: APP_NAMESPACE');
    expect(src).not.toContain(`name: '${APP_DEPLOYMENT_NAME}'`);
  });

  test('capacityMonitoringApproach is OMITTED rather than guessed', () => {
    // Exactly one value exists and the console pre-selects it; its literal spelling was
    // never verified. An unset optional takes the service default, whereas a wrong
    // literal is a deploy rejection — or worse, accepted and meaningless.
    const eks = blockOf('activate', 'EKSResourceScaling').EksResourceScalingConfig;
    expect(eks.CapacityMonitoringApproach).toBeUndefined();
  });

  test('ONE workflow, activePassive, and NO pinned region -- direction is chosen at run time', () => {
    // StartPlanExecution REQUIRES --action AND --target-region, and the deployed schema
    // makes Workflow.WorkflowTargetRegion OPTIONAL. Omitting it is precisely what makes
    // this plan bidirectional: the same three blocks activate whichever region the
    // operator names, and under activePassive that deactivates the other. Pinning a
    // region would make fail-back impossible with this plan, and nothing would reveal it
    // until someone tried to fail back.
    const p = planProps();
    expect(p.RecoveryApproach).toBe('activePassive');
    expect(p.Workflows).toHaveLength(1);
    const wf = p.Workflows[0];
    expect(wf.WorkflowTargetAction).toBe('activate');
    expect(wf.WorkflowTargetRegion).toBeUndefined();
    expect(wf.Steps).toHaveLength(3);
    // A symmetric workflow only works if every block config names BOTH regions; one that
    // enumerated a single region would run "successfully" and act on nothing in the other
    // direction -- the vacuity failure this repo keeps guarding against.
    const blob = JSON.stringify(wf);
    for (const r of REGIONS) {
      expect(blob).toContain(r.name);
    }
  });

  test('the single DNS block flips the record the dns stack created', () => {
    // ONE block now rather than a pair. Two blocks (shift-away plus shift-back) could
    // drift apart and leave one direction reporting success while flipping nothing; a
    // bidirectional workflow removes that failure mode by construction rather than by
    // asserting the two stay equal.
    const cfg = blockOf('activate', 'Route53HealthCheck').Route53HealthCheckConfig;
    expect(cfg.RecordName).toBe(APP_RECORD_NAME);
  });

  test('audit reports go to an encrypted, TLS-only, versioned bucket', () => {
    // The artifact a regulated audience asks for. Created here rather than added to the
    // operator's prerequisites so its security properties are not left to a hand-made
    // bucket.
    const bucket = Object.values(
      synthAll().get(rsName)!.findResources('AWS::S3::Bucket'),
    ).map((b: any) => b.Properties)[0];
    expect(bucket.BucketEncryption.ServerSideEncryptionConfiguration[0]
      .ServerSideEncryptionByDefault.SSEAlgorithm).toBe('aws:kms');
    expect(bucket.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    expect(bucket.PublicAccessBlockConfiguration.BlockPublicPolicy).toBe(true);
    // enforceSSL emits an aws:SecureTransport deny on the bucket policy.
    const policy = Object.values(
      synthAll().get(rsName)!.findResources('AWS::S3::BucketPolicy'),
    ).map((p: any) => p.Properties)[0];
    expect(JSON.stringify(policy)).toContain('aws:SecureTransport');

    const plan = planProps();
    // reportOutput is an ARRAY, and bucketPath carries the bucket NAME plus prefix —
    // there is no separate bucketName property.
    expect(Array.isArray(plan.ReportConfiguration.ReportOutput)).toBe(true);
    expect(
      JSON.stringify(plan.ReportConfiguration.ReportOutput[0].S3Configuration.BucketPath),
    ).toContain('region-switch-reports');
  });

  test('the execution role can write reports AND use the key — both grants', () => {
    // s3:PutObject alone against a CMK-encrypted bucket fails as "Access to KMS is not
    // allowed": a grant that is necessary but not sufficient, and a defect class this
    // project has already paid for once.
    const statements = Object.values(
      synthAll().get(rsName)!.findResources('AWS::IAM::Policy'),
    )
      .map((p: any) => p.Properties)
      .flatMap((p) => p.PolicyDocument.Statement);
    const text = JSON.stringify(statements);
    expect(text).toContain('s3:PutObject');
    expect(text).toContain('kms:GenerateDataKey');
    expect(text).toContain('kms:Decrypt');
  });

  test('the RTO is declared, so recovery is measured rather than described', () => {
    // Actual recovery = plan execution time + time for the app-health alarms to reach OK,
    // compared against this number. Without it there is nothing to compare against.
    expect(planProps().RecoveryTimeObjectiveMinutes).toBeGreaterThan(0);
  });
});

describe('restore-steady-state — the post-failover cleanup script (2026-08-27)', () => {
  // WHY THIS EXISTS. ARC's EKS block leaves scaleDown.selectPolicy=Disabled "during or
  // after the execution" and nothing ever reverses it; the block itself only scales UP.
  // Live consequence 2026-08-27: two failovers ratcheted the app to 10 pods with
  // scale-down off, and no restore-steady-state step existed.
  //
  // AN ARC postRecovery WORKFLOW IS DELIBERATELY ABSENT. One was built, deployed
  // (plan v4) and executed live on 2026-08-27, then removed by operator decision:
  // two kubectl verbs of cleanup should not be coupled to ARC's execution model. The
  // cleanup is build/restore-steady-state.sh; these tests pin what the ARC version
  // validated live so the knowledge survives the removal.
  const script = (): string =>
    fs.readFileSync(path.join(__dirname, '..', 'build', 'restore-steady-state.sh'), 'utf8');
  // Assert on CODE, not comments (a lesson: words surviving only in a comment pass
  // toContain while the mechanism is absent). Shell: drop full-line comments.
  const code = (): string =>
    script()
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');

  test('reverts selectPolicy — NOT minReplicas — and never issues an explicit scale', () => {
    // The single most gettable-wrong detail in the coexistence contract: ARC's patch is
    // scaleDown.selectPolicy, so the REVERT must target the same pointer. "Reverting"
    // minReplicas (the intuitive guess) would leave ARC's real patch in place with
    // scale-down still disabled — cleanup reporting success while cleaning nothing.
    expect(code()).toContain('selectPolicy');
    expect(code()).toContain('Min');
    expect(code()).not.toContain('minReplicas');
    // No explicit scale: rightsizing is the re-enabled HPA's job. A kubectl scale here
    // would fight the autoscaler and hardcode a replica count.
    expect(code()).not.toContain('kubectl scale');
    expect(code()).not.toContain(' scale deployment');
  });

  test('fresh pools via restart, gated on rollout status, dry-run by default, fail-loud', () => {
    expect(code()).toContain('rollout restart deployment');
    expect(code()).toMatch(/rollout status deployment.*--timeout/);
    // Same operator contract as arc-switch.sh: prints and exits unless --execute.
    expect(code()).toContain('!= "--execute"');
    expect(code()).toContain('DRY RUN');
    // Fail-loud, serial: set -euo pipefail plus an explicit non-SUCCEEDED exit 1.
    expect(code()).toContain('set -euo pipefail');
    expect(code()).toMatch(/SUCCEEDED.*\n.*exit 1|"\$status" != "SUCCEEDED"/);
  });

  test('supplies KUBECTL_S3_URI per run — the installer bakes in only CLUSTER_NAME + ns vars', () => {
    // The live gotcha from the 2026-08-26 diagnostics: an out-of-pipeline StartBuild
    // without this override fails on an empty `aws s3 cp` before any kubectl runs.
    expect(code()).toContain('KUBECTL_S3_URI');
    expect(code()).toContain('--environment-variables-override');
    expect(code()).toContain('--buildspec-override');
    // kubectl discovery must pick the NEWEST staged binary, not an arbitrary one.
    expect(code()).toContain('LastModified');
  });

  test('kubectl discovery survives a >1,000-object bucket (per-page --query trap)', () => {
    /**
     * HIT LIVE 2026-09-08. The AWS CLI applies --query PER PAGE of list-objects-v2, so
     * once the assets bucket crossed 1,000 objects `sort_by(...)[-1].Key` returned one
     * key PER PAGE — two keys concatenated into a malformed multi-line "URI", and the
     * cleanup build died at INSTALL on `aws s3 cp` before any kubectl ran. The script
     * had run clean on 2026-09-01; the bucket was just smaller then, which is exactly
     * why this is a time bomb and not a style point.
     *
     * The fix emits [LastModified, Key] per page and picks the global newest
     * client-side (ISO-8601 sorts lexicographically, so `sort | tail -n 1` is a
     * correct max). Pin the SHAPE of the fix: the client-side selection chain must be
     * present, and the bare per-page form must not come back.
     */
    expect(code()).toMatch(/\[LastModified,Key\]/);
    expect(code()).toMatch(/sort \| tail -n 1 \| cut/);
    // The regression: selecting .Key server-side with nothing after the CLI call.
    expect(code()).not.toMatch(/\[-1\]\.Key/);
  });

  test('--no-wait starts builds without polling but never weakens the default contract', () => {
    // Added 2026-09-08 for automation callers: the serial poll loop runs ~5-10 min per
    // region, which chat-tool watchdogs kill mid-poll — orphaning an already-started
    // build the caller must then rediscover. Two-sided: the flag exists AND the
    // default path still polls + fails loud, so automation convenience cannot quietly
    // become the only behavior.
    expect(code()).toContain('--no-wait');
    expect(code()).toMatch(/NO_WAIT.*--no-wait/);
    // The no-wait exit must SAY the result is unverified — a fire-and-forget that
    // reads like success is the "reports success, did nothing" family.
    expect(script()).toMatch(/NOT verified/);
    // And the caller gets the poll command, not just an id to go figure out.
    expect(code()).toContain('batch-get-builds');
    // Default path unchanged: poll loop + fail-loud exit survive.
    expect(code()).toContain('polling until terminal');
    expect(code()).toMatch(/"\$status" != "SUCCEEDED"/);
  });

  test('script defaults agree with src/cdk/k8s.ts — the cross-file contract', () => {
    // The script cannot import TypeScript constants, so its defaults are literals; this
    // pins them to the same module the manifests and the ARC plan are generated from.
    // A renamed Deployment/HPA otherwise leaves the script patching nothing, silently.
    const k8s = fs.readFileSync(path.join(__dirname, '..', 'src', 'cdk', 'k8s.ts'), 'utf8');
    const constOf = (name: string): string => {
      const m = k8s.match(new RegExp(`export const ${name} = '([^']+)'`));
      expect(m).not.toBeNull();
      return m![1];
    };
    expect(code()).toContain(`RSS_APP_NAMESPACE:-${constOf('APP_NAMESPACE')}`);
    expect(code()).toContain(`RSS_DEPLOYMENT:-${constOf('APP_DEPLOYMENT_NAME')}`);
    expect(code()).toContain(`RSS_HPA:-${constOf('APP_HPA_NAME')}`);
  });

  test('no operator script counts a paginated result set with length()', () => {
    /**
     * THE SAME PER-PAGE --query TRAP AS THE KUBECTL DISCOVERY ABOVE, in its other
     * common form. `length(...)` on a paginated list/describe returns one count PER
     * PAGE, so the "count" becomes several numbers once the result set outgrows the
     * service's default page size. start-region-wide-injection.sh counted SSM-managed
     * nodes this way (default MaxResults 10): past ten nodes MANAGED became "10<tab>2"
     * and its `-eq 0` guard died with "integer expression expected" -- and because
     * `set -e` is suppressed inside an `if` condition, the script carried on.
     *
     * Note the zero case -- the one that guard actually defends -- was always a single
     * page and always worked. This pins the ROBUSTNESS fix, not a rescue.
     *
     * Scoped to the aws-calling operator scripts in build/. Counting client-side
     * (`--output text | wc -w`) is page-count-independent; length() is not.
     */
    const buildDir = path.join(__dirname, '..', 'build');
    const shells = fs.readdirSync(buildDir).filter((f) => f.endsWith('.sh'));
    expect(shells.length).toBeGreaterThan(0); // a moved/renamed dir must not vacuously pass
    for (const f of shells) {
      const body = fs
        .readFileSync(path.join(buildDir, f), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      expect(body).not.toMatch(/--query\s+'?"?length\(/);
    }
    // And the replacement is actually in place, not merely the old form removed.
    const inj = fs.readFileSync(path.join(buildDir, 'start-region-wide-injection.sh'), 'utf8');
    expect(inj).toMatch(/InstanceInformationList\[\]\.InstanceId'\s+--output text[^|]*\|\s*wc -w/);
  });

  test('the ARC-side machinery is FULLY removed — no partial teardown', () => {
    // The known failure family: removing a feature but leaving one of its limbs (a
    // CfnParameter still threaded, an orphaned grant, a Lambda with no caller). Assert
    // every limb is gone in the same breath.
    for (const [, template] of synthAll()) {
      const blob = JSON.stringify(template.toJSON());
      expect(blob).not.toContain('postRecovery');
      expect(blob).not.toContain('RestoreSteadyState');
      expect(blob).not.toContain('RestoreFnArn');
    }
    const tasks = fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8');
    expect(tasks).not.toContain('RESTOREFNARN');
    expect(fs.existsSync(path.join(__dirname, '..', 'src', 'cdk', 'lib', 'restore-steady-state'))).toBe(false);
  });
});


describe('third-party image mirror (step 10a)', () => {
  const mirrorManifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'mirror', 'images.json'), 'utf8'),
  ) as {
    ecrRepositoryPrefix: string;
    images: Array<{
      name: string;
      upstream: string;
      tag: string;
      digest: string;
      arm64Digest: string;
      arm64: boolean;
      neededBy: string;
    }>;
  };

  const tasks = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
  ) as { tasks: Record<string, any> };

  test('every mirrored image is pinned by a real sha256 digest, never by tag alone', () => {
    // Tags upstream are MUTABLE. A tag-only entry would mirror whatever the
    // publisher moved the tag to since review, so the mirror would be neither
    // reproducible nor verifiable — and nothing downstream would notice.
    //
    // BOTH digests are required. The default copy is linux/arm64 only, which pushes
    // the CHILD manifest, so arm64Digest is what lands in ECR and what the read-back
    // compares. Without it the fast path could not be verified at all.
    expect(mirrorManifest.images.length).toBeGreaterThan(0);
    for (const img of mirrorManifest.images) {
      expect(img.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(img.arm64Digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      // An index and the child manifest it references are different objects. Equal
      // values mean one was copy-pasted, and every flattened push would then fail
      // verification against a digest that can never appear.
      expect(img.arm64Digest).not.toBe(img.digest);
      expect(img.tag).not.toBe('latest');
      expect(img.upstream).not.toContain('@');
    }
  });

  test('the mirror copies only arm64 by default — measured, not a guess', () => {
    // A full-index copy moves 1500 MB per region against 309 MB for arm64 alone
    // (layer bytes summed from every child manifest, 2026-08-25). The surplus is
    // amd64/386/ppc64le/s390x/arm-v6/arm-v7/riscv64, none of which this node group
    // can run. Verification is not traded away for the saving: see the digest test.
    const script = fs.readFileSync(
      path.join(__dirname, '..', 'build', 'mirror-images.sh'),
      'utf8',
    );
    expect(script).toContain('MIRROR_PLATFORM="${MIRROR_PLATFORM:-linux/arm64}"');
    expect(script).toContain('MIRROR_FULL_INDEX');
  });

  test('image names are unique — the ECR repository path is derived from them', () => {
    // Two entries sharing a name would silently collide on one ECR repository,
    // and the second copy would overwrite the first one's tag.
    const names = mirrorManifest.images.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every mirrored image declares arm64, matching the node group it must run on', () => {
    // THE CROSS-FILE CONTRACT. The node group is AL2023_ARM_64_STANDARD on m7g
    // (Graviton). An image with no linux/arm64 variant SCHEDULES and then
    // CrashLoopBackOffs with "exec format error" — which reads as an application
    // fault, not a platform mismatch, and costs an hour to attribute.
    const regionStack = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'region-stack.ts'),
      'utf8',
    );
    expect(regionStack).toContain('AL2023_ARM_64_STANDARD');
    for (const img of mirrorManifest.images) {
      expect(img.arm64).toBe(true);
    }
  });

  test('every stack-output env var a deploy step consumes is actually an output', () => {
    // THE GENERAL THEOREM behind three separate live deploy failures. deploy-stack.sh
    // writes each stack's outputs to a dotenv as <OUTPUTS_PREFIX>_<OUTPUTKEY-UPPERCASED>,
    // and later steps read them back as shell variables. A name that does not match an
    // actual output is simply UNSET -- bash expands it to an empty string, the step runs,
    // and the failure lands far away as a service-level validation error. Live 2026-08-26:
    // the peering step read $REGION_i_VPCCIDR while RegionStack outputs `VpcCidrOut`
    // (the id `VpcCidr` was already taken by its CfnParameter), so ec2:CreateRoute got
    // `destination-cidr-block: ` and rolled the stack back at phase 3 of 7.
    //
    // Both sides are DERIVED, nothing hardcoded: the prefix->stack map comes from the
    // generated tasks.json, the output keys come from the synthesized templates. So this
    // covers every current and future step without being updated.
    const execs: string[] = tasks.tasks.deploy.steps
      .map((s: any) => s.exec ?? '')
      .filter(Boolean);
    const all = execs.join('\n');

    // 1. prefix -> stack name, read off the steps that capture outputs.
    const prefixToStack = new Map<string, string>();
    for (const e of execs) {
      const stack = /STACK_NAME=\\?"([^"\\]+)\\?"/.exec(e);
      const prefix = /OUTPUTS_PREFIX=\\?"([^"\\]+)\\?"/.exec(e);
      if (stack && prefix) {
        prefixToStack.set(prefix[1], stack[1].replace('$PROJECT_NAME', APP_ID));
      }
    }
    // Sanity: the map must be populated, or the assertions below are vacuous.
    expect(prefixToStack.size).toBeGreaterThanOrEqual(8);
    expect(prefixToStack.get('REGION_0')).toBe(`${APP_ID}-${regionSuffix(REGIONS[0])}`);

    // 2. outputs actually present in each synthesized template.
    const templates = synthAll();
    const outputsOf = (stackName: string): string[] =>
      Object.keys((templates.get(stackName)!.toJSON() as any).Outputs ?? {});

    // 3. every consumed $PREFIX_KEY must exist. The negative lookahead skips
    //    $REGION_0_VPC_CIDR and friends -- underscore-separated names are CI variables
    //    (.gitlab-ci.yml), not dotenv output keys.
    const missing: string[] = [];
    for (const [prefix, stackName] of prefixToStack) {
      expect(templates.has(stackName)).toBe(true);
      const keys = outputsOf(stackName).map((k) => k.toUpperCase());
      const re = new RegExp(`\\$${prefix}_([A-Z0-9]+)(?![A-Z0-9_])`, 'g');
      for (const m of all.matchAll(re)) {
        if (!keys.includes(m[1])) missing.push(`$${prefix}_${m[1]} (${stackName} outputs: ${keys.join(',')})`);
      }
    }
    expect(missing).toEqual([]);

    // 4. Anti-vacuity: the audit must actually be inspecting the key that broke, so a
    //    revert to the short name cannot pass by the loop finding nothing to check.
    expect(all).toContain('$REGION_0_VPCCIDROUT');
    expect(outputsOf(`${APP_ID}-${regionSuffix(REGIONS[0])}`)).toContain('VpcCidrOut');
  });

  test('deploy:s3 syncs assets to EVERY region bucket, not just $AWS_REGION', () => {
    // 7th template gap, live-proven 2026-08-26 (Day 1 attempt 2): the template's
    // single sync targets $ASSETS_BUCKET_PREFIX-$AWS_REGION where AWS_REGION is
    // the pipeline-global default (us-east-2) — so the us-west-2 bucket received
    // ZERO objects, ever, and the region-1 stack died at create-change-set with
    // "S3 object does not exist ... NoSuchKey". Invisible on attempt 1 only
    // because that run failed in region 0 before the region-1 step executed.
    //
    // Assert on the GENERATED tasks.json (the artifact CI runs), one literal
    // sync line per region targeting that region's OWN bucket with a matching
    // --region flag — and that the $AWS_REGION-shaped single-region sync is GONE
    // (its survival is exactly the bug).
    const s3 = tasks.tasks['deploy:s3'];
    expect(s3).toBeDefined();
    const execs = s3.steps.map((s: any) => s.exec ?? '');
    for (const r of REGIONS) {
      const line = execs.find((e: string) =>
        e.includes(`s3://$ASSETS_BUCKET_PREFIX-${r.name}/$ASSETS_PREFIX`),
      );
      expect(line).toBeDefined();
      expect(line).toContain(`--region "${r.name}"`);
      expect(line).toContain('aws s3 sync');
    }
    expect(execs.join('\n')).not.toContain('$ASSETS_BUCKET_PREFIX-$AWS_REGION');
    // And the fan-out must run before any stack deploy: deploy:upload (which
    // spawns deploy:s3) stays Phase 1.
    const upload = tasks.tasks['deploy:upload'];
    expect(upload.steps.map((s: any) => s.spawn)).toContain('deploy:s3');
  });

  test('deploy:mirror runs the mirror script and is folded into deploy:upload', () => {
    // Phase 1 ("publishing assets") is the right home: the mirror must finish
    // before any stack deploys or the in-VPC installer applies manifests. Later,
    // and the installer references images that are not in ECR yet — which surfaces
    // as ImagePullBackOff long after the step that should have failed.
    const mirror = tasks.tasks['deploy:mirror'];
    expect(mirror).toBeDefined();
    expect(mirror.steps.map((s: any) => s.exec).join('\n')).toContain('build/mirror-images.sh');
    const upload = tasks.tasks['deploy:upload'];
    expect(upload.steps.map((s: any) => s.spawn)).toContain('deploy:mirror');
  });

  test('MIRROR_REGIONS names EVERY region, not just the deploy region', () => {
    // The standby cluster runs its own Argo CD, so it needs every image in its
    // OWN regional ECR. A mirror that covered only the primary would look green
    // for the whole demo and fail exactly when the standby is promoted and starts
    // pulling. Derived from REGIONS so adding a third region cannot skip it.
    const mirror = tasks.tasks['deploy:mirror'];
    const declared = String(mirror.env.MIRROR_REGIONS)
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    expect(declared.sort()).toEqual(REGIONS.map((r) => r.name).sort());
    expect(declared.length).toBeGreaterThan(1);
  });

  test('src/lbc/render.sh pins agree with the LBC mirror entry', () => {
    // THE CONTRACT THIS PROTECTS. Two files independently name the controller image: the
    // mirror decides what gets PUSHED to ECR, and the render script decides what the
    // committed manifest PULLS. Bump one without the other and the manifest points at an
    // image the mirror never pushed -- pods time out pulling, which reads as a network fault
    // rather than a version mismatch (AGENTS.md bug class 10).
    //
    // It also pins the arm64-child-not-index rule: mirror-images.sh copies only linux/arm64,
    // so the multi-platform INDEX digest does not exist in our ECR. Pointing the manifest at
    // the index gives "manifest unknown" on every pod.
    const render = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lbc', 'render.sh'), 'utf8');
    const manifest = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lbc', 'lbc.yaml'), 'utf8');
    const lbc = mirrorManifest.images.find((i) => i.name === 'aws-load-balancer-controller');
    expect(lbc).toBeDefined();

    const pin = (name: string): string => {
      const m = render.match(new RegExp(`^${name}="\\$\\{${name}:-([^}]+)\\}"`, 'm'));
      expect({ name, found: m !== null }).toEqual({ name, found: true });
      return m![1];
    };
    expect(pin('IMAGE_TAG')).toBe(lbc!.tag);
    // The ARM64 CHILD digest, never the index digest.
    expect(pin('IMAGE_DIGEST')).toBe(lbc!.arm64Digest);
    expect(pin('IMAGE_DIGEST')).not.toBe(lbc!.digest);

    // And the COMMITTED manifest must actually have been re-rendered against those pins --
    // agreeing pins with a stale manifest is the same defect one step later.
    expect(manifest).toContain(`:${lbc!.tag}@${lbc!.arm64Digest}`);
    expect(manifest).toContain(`chart:  https://aws.github.io/eks-charts  aws-load-balancer-controller  ${pin('CHART_VERSION')}`);

    // The Service mutator webhook is what injects spec.loadBalancerClass on CREATE, and that
    // field is immutable afterwards. Rendered without it, the recreated Service is silently
    // claimed by the in-tree controller again and the old instance-target NLB comes back --
    // a green install that undoes the whole point of the migration.
    expect(manifest).toContain('mservice.elbv2.k8s.aws');
  });

  test('the mirror script pulls by digest and verifies the digest after the copy', () => {

    // Asserting the MECHANISM, not just the data: pinning in images.json achieves
    // nothing if the script copies the tag. The read-back is what catches a copy
    // that silently changed the digest.
    //
    // This assertion targets the ACTUAL `crane copy` invocations, not the file as a
    // whole. An earlier version used toContain over the whole script and passed a
    // mutation that switched both real copies to `${UPSTREAM}:${TAG}` — because the
    // dry-run ECHO still mentioned the digest form. A test satisfied by a log
    // message is worse than no test.
    const script = fs.readFileSync(
      path.join(__dirname, '..', 'build', 'mirror-images.sh'),
      'utf8',
    );
    const copyLines = script
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('crane copy'));
    expect(copyLines.length).toBeGreaterThan(0);
    for (const line of copyLines) {
      expect(line).toContain('@${DIGEST}');
      expect(line).not.toContain(':${TAG}');
    }
    expect(script).toContain('digest_present');
    expect(script).toContain('imageDigest=$digest');
    // The fail-loud branch is the point of the read-back. Assert the branch that
    // ABORTS, not merely that a verification helper is mentioned somewhere.
    expect(script).toContain('does not carry the pinned digest');
    const verifyBlock = script.slice(script.indexOf('# Read back.'));
    expect(verifyBlock).toMatch(/does not carry the pinned digest[\s\S]{0,400}exit 1/);
  });

  test('Argo CD, its dependencies, metrics-server and the chart server are all covered', () => {
    // Derived from the upstream install manifests, not guessed: argo-cd v3.4.7's
    // install.yaml references exactly argocd + redis + dex, metrics-server's
    // components.yaml references metrics-server, and 10c's chart repo needs nginx.
    // A missing entry means a pod in an isolated subnet with nothing to pull.
    //
    // Grouped by the step that consumes each image so adding one is a deliberate edit
    // rather than a list that quietly grows. Karpenter's own docs require its image be
    // copied into private ECR for a private cluster.
    const byStep: Record<string, string[]> = {};
    for (const img of mirrorManifest.images) {
      (byStep[img.neededBy] ??= []).push(img.name);
    }
    for (const names of Object.values(byStep)) names.sort();
    expect(byStep).toEqual({
      '10b': ['argocd', 'dex', 'metrics-server', 'redis'],
      '10c': ['nginx'],
      '11': ['karpenter-controller'],
      // The AWS Load Balancer Controller runs IN-CLUSTER, unlike the in-tree service
      // controller it replaces (which runs on the AWS-managed control plane and needed no
      // mirror at all). So it needs both this mirror entry and the elasticloadbalancing VPC
      // endpoint -- two prerequisites the in-tree path never had.
      'single-AZ': ['aws-load-balancer-controller'],
      // The cluster-wide pod log shipper. Same in-cluster/no-NAT constraint as the LBC:
      // it runs on nodes in isolated subnets, so public.ecr.aws is unreachable at runtime
      // and this entry is mandatory rather than an optimisation.
      'log-shipping': ['aws-for-fluent-bit'],
    });
  });

  test('the Kubernetes version and the Karpenter version are pinned together', () => {
    // Karpenter's support matrix is version-bound, so these two pins are one decision.
    // Leaving the cluster version unset lets EKS choose its current default at create
    // time -- the same template then drifts to a Kubernetes version the pinned Karpenter
    // release may not support, with no code change and no warning.
    expect(KUBERNETES_VERSION).toMatch(/^1\.\d+$/);
    const regionStack = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'region-stack.ts'),
      'utf8',
    );
    expect(regionStack).toContain('version: KUBERNETES_VERSION');
    const karpenter = mirrorManifest.images.find((i) => i.name === 'karpenter-controller');
    expect(karpenter).toBeDefined();
    expect(karpenter!.tag).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('both clusters synthesize with the pinned Kubernetes version', () => {
    // Asserting the SYNTHESIZED template, not the source: a constant that is declared but
    // never threaded through changes nothing, and CfnCluster.version is optional so the
    // omission is silent at synth AND at deploy.
    for (const region of REGIONS) {
      const app = new cdk.App();
      const stack = new RegionStack(app, `Ver${region.name}`, {
        appId: APP_ID,
        regionName: region.name,
        env: { region: region.name },
        synthesizer: makeSynthesizer(),
      } as any);
      Template.fromStack(stack).hasResourceProperties('AWS::EKS::Cluster', {
        Version: KUBERNETES_VERSION,
      });
    }
  });

  test('nothing is mirrored FROM private ECR, and public.ecr.aws is treated as upstream', () => {
    // public.ecr.aws looks like it might already be reachable, but the step-3a
    // interface endpoints serve PRIVATE ECR only — ECR Public is a separate
    // internet-facing service. So Argo's own redis reference is an upstream to be
    // mirrored, not a source pods can use directly.
    for (const img of mirrorManifest.images) {
      expect(img.upstream).not.toMatch(/\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/);
    }
    expect(mirrorManifest.images.some((i) => i.upstream.startsWith('public.ecr.aws/'))).toBe(true);
  });
});

describe('Karpenter IAM, instance profile and discovery tags (step 11a)', () => {
  const templates = () => synthAll();

  test('the OIDC provider omits ThumbprintList so IAM resolves it', () => {
    // Deliberate. The alternative is a hardcoded 40-char SHA-1 hex string that breaks
    // silently whenever the CA rotates -- and the failure mode is every IRSA call returning
    // WebIdentityErr, which reads as a network or endpoint problem. CfnOIDCProvider's
    // contract: omitted, "IAM will retrieve and use the top intermediate certificate
    // authority (CA) thumbprint". Using the CDK L2 instead would add a Lambda-backed custom
    // resource to fetch a value CloudFormation can resolve on its own.
    for (const region of REGIONS) {
      const t = templates().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const providers = Object.values(t.findResources('AWS::IAM::OIDCProvider'));
      expect(providers).toHaveLength(1);
      expect(providers[0].Properties.ThumbprintList).toBeUndefined();
      expect(providers[0].Properties.ClientIdList).toEqual(['sts.amazonaws.com']);
    }
  });

  test('the instance profile is PRE-CREATED with an explicit name', () => {
    // Karpenter normally creates this itself. It cannot here: IAM interface endpoints exist
    // only in each partition's control-plane region (us-east-1 / cn-north-1 /
    // us-gov-west-1), and this demo runs in neither. Karpenter documents
    // spec.instanceProfile as REQUIRED for that case. The name must be explicit because the
    // EC2NodeClass references it as a synth-time constant rather than a lookup the
    // controller would have to make against an unreachable IAM API.
    for (const region of REGIONS) {
      const t = templates().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const profiles = Object.values(t.findResources('AWS::IAM::InstanceProfile'));
      expect(profiles).toHaveLength(1);
      expect(profiles[0].Properties.InstanceProfileName).toBe(
        `${APP_ID}-${region.name}-karpenter-node`,
      );
    }
  });

  test('the controller trust policy pins sub AND aud exactly, never a wildcard', () => {
    // This role can launch and terminate EC2 instances. A StringLike wildcard on `sub`
    // would let ANY service account in the cluster assume it -- a privilege-escalation path
    // out of any compromised pod.
    for (const region of REGIONS) {
      const t = templates().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const trust = Object.values(t.findResources('Custom::AWSCDKCfnJson')).find((r) =>
        JSON.stringify(r.Properties).includes(':sub'),
      );
      expect(trust).toBeDefined();
      const value = JSON.stringify(trust!.Properties.Value);
      expect(value).toContain('system:serviceaccount:kube-system:karpenter');
      expect(value).toContain('sts.amazonaws.com');

      const role = Object.entries(t.findResources('AWS::IAM::Role')).find(([k]) =>
        k.includes('KarpenterControllerRole'),
      );
      expect(role).toBeDefined();
      const doc = JSON.stringify(role![1].Properties.AssumeRolePolicyDocument);
      expect(doc).toContain('StringEquals');
      expect(doc).not.toContain('StringLike');
      expect(doc).toContain('sts:AssumeRoleWithWebIdentity');
    }
  });

  test('the controller policy carries PassRole but NO instance-profile management', () => {
    // We pre-create the profile precisely because IAM is unreachable from these subnets, so
    // granting CreateInstanceProfile would invite Karpenter to attempt a call that cannot
    // succeed. PassRole is still required to hand the profile to CreateFleet/RunInstances.
    for (const region of REGIONS) {
      const t = templates().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const policy = Object.entries(t.findResources('AWS::IAM::Policy')).find(([k]) =>
        k.includes('KarpenterControllerPolicy'),
      );
      expect(policy).toBeDefined();
      const doc = JSON.stringify(policy![1].Properties.PolicyDocument);
      expect(doc).toContain('iam:PassRole');
      expect(doc).toContain('ec2:CreateFleet');
      expect(doc).toContain('ec2:RunInstances');
      expect(doc).toContain('ssm:GetParameter');
      expect(doc).not.toContain('iam:CreateInstanceProfile');
      expect(doc).not.toContain('iam:AddRoleToInstanceProfile');
      expect(doc).not.toContain('iam:DeleteInstanceProfile');
      // No SQS interruption queue exists (no SQS endpoint, on-demand capacity only), so
      // granting queue permissions would point Karpenter at a queue that is not there --
      // the documented symptom is repeated QueueNotFound errors.
      expect(doc).not.toContain('sqs:ReceiveMessage');
    }
  });

  test('no placeholder survived into the rendered controller policy', () => {
    // A leftover "${Something}" inside an ARN or a condition key is accepted by IAM, and the
    // policy then simply never matches: nodes never launch, and CloudTrail names the action
    // rather than the condition that rejected it. This already happened once --
    // ${KarpenterNodeRole.Arn} is a GetAtt-form placeholder the first substitution missed.
    for (const region of REGIONS) {
      const t = templates().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const policy = Object.entries(t.findResources('AWS::IAM::Policy')).find(([k]) =>
        k.includes('KarpenterControllerPolicy'),
      );
      const doc = JSON.stringify(policy![1].Properties.PolicyDocument);
      expect(doc).not.toMatch(/\$\{(AWS::|ClusterName|KarpenterNodeRole)/);
    }
  });

  test('EVERY isolated subnet carries the discovery tag', () => {
    // The tag is applied to the network SUBTREE with a resource-type filter. Iterating
    // vpc.isolatedSubnets and calling Tags.of() on them is a SILENT no-op -- those are
    // imported objects, not the real CfnSubnet constructs -- and the repo has already been
    // bitten by exactly that once, producing zero tags with a green synth. Counting the
    // tagged subnets is what catches it.
    for (const region of REGIONS) {
      const t = templates().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const subnets = Object.values(t.findResources('AWS::EC2::Subnet'));
      expect(subnets.length).toBe(AZ_COUNT);
      const tagged = subnets.filter((s) =>
        (s.Properties.Tags ?? []).some(
          (tag: any) =>
            tag.Key === 'karpenter.sh/discovery' && tag.Value === `${APP_ID}-${region.name}`,
        ),
      );
      expect(tagged).toHaveLength(subnets.length);
    }
  });
});

describe('the vendored Karpenter manifest (step 11b)', () => {
  const manifest = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'karpenter', 'karpenter.yaml'),
    'utf8',
  );
  const mirror = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'mirror', 'images.json'), 'utf8'),
  ) as { images: Array<{ name: string; tag: string; digest: string; arm64Digest: string }> };
  const karpenterImage = mirror.images.find((i) => i.name === 'karpenter-controller')!;

  test('the manifest pins the ARM64 CHILD digest, never the index digest', () => {
    // THE TRAP THIS TEST EXISTS FOR. The chart's own default is the multi-platform INDEX
    // digest, and build/mirror-images.sh copies only linux/arm64 -- so the index digest is
    // ABSENT from our ECR mirror. Left at the chart default every pod fails to pull with
    // "manifest unknown", which reads as a mirror that never ran rather than a digest that
    // does not match what was pushed.
    const imageLine = manifest
      .split('\n')
      .find((l) => l.trim().startsWith('image:') && !l.trim().startsWith('#'));
    expect(imageLine).toBeDefined();
    expect(imageLine).toContain(`@${karpenterImage.arm64Digest}`);
    expect(imageLine).not.toContain(karpenterImage.digest);
    expect(imageLine).toContain(`:${karpenterImage.tag}@`);
  });

  test('a version bump in the mirror without re-rendering fails here', () => {
    // The manifest is committed, so nothing re-renders it automatically. This is the only
    // thing standing between "bumped images.json" and a manifest that points at an image
    // tag the mirror never pushed.
    expect(manifest).toContain(`oci://public.ecr.aws/karpenter/karpenter  ${karpenterImage.tag}`);
    expect(manifest).toContain('GENERATED by src/karpenter/render.sh');
  });

  test('the service account identity matches what the IRSA trust policy pins', () => {
    // Cross-file contract between a Kubernetes object and an IAM condition. The trust policy
    // pins sub to system:serviceaccount:<ns>:<name> with StringEquals, so a rename on either
    // side produces a controller whose every AWS call returns WebIdentityErr -- which reads
    // as a network or endpoint fault rather than a naming mismatch.
    expect(KARPENTER_NAMESPACE).toBe('kube-system');
    expect(KARPENTER_SERVICE_ACCOUNT).toBe('karpenter');
    // Anchored to end-of-line. `toContain('serviceAccountName: karpenter')` is satisfied by
    // `serviceAccountName: karpenter-sa`, so a rename passed straight through it -- the
    // mutation proved it.
    expect(manifest).toMatch(
      new RegExp(`^\\s+serviceAccountName: ${KARPENTER_SERVICE_ACCOUNT}$`, 'm'),
    );
    expect(manifest).toMatch(new RegExp(`^  name: ${KARPENTER_SERVICE_ACCOUNT}$`, 'm'));
    expect(manifest).toMatch(new RegExp(`^  namespace: ${KARPENTER_NAMESPACE}$`, 'm'));
  });

  test('CRDs are included, or the first EC2NodeClass apply fails on an unknown kind', () => {
    // `helm template` OMITS crds/ unless --include-crds is passed, because `helm install`
    // installs them separately. We apply plain YAML with kubectl, so without them the
    // manifest applies cleanly and then the EC2NodeClass fails with "no matches for kind" --
    // and nothing in the apply of THIS file reports a problem.
    expect(manifest).toContain('kind: CustomResourceDefinition');
    expect(manifest).toContain('ec2nodeclasses.karpenter.k8s.aws');
    expect(manifest).toContain('nodepools.karpenter.sh');
    expect(manifest).toContain('nodeclaims.karpenter.sh');
  });

  test('Karpenter cannot schedule onto the nodes it manages', () => {
    // Bootstrap: a controller evicted onto its own capacity cannot recover that capacity.
    // Upstream's default affinity already handles it; asserted so a values change cannot
    // drop it silently.
    expect(manifest).toContain('karpenter.sh/nodepool');
    expect(manifest).toContain('DoesNotExist');
  });

  test('no interruption queue is configured', () => {
    // There is no SQS VPC endpoint and capacity is on-demand only. Pointing Karpenter at a
    // queue that does not exist produces repeated QueueNotFound errors -- a documented FAQ
    // entry -- so the setting is empty and the chart omits the env var entirely.
    expect(manifest).not.toContain('name: INTERRUPTION_QUEUE');
  });

  test('placeholders are exactly the three the deploy must supply', () => {
    // build/render-manifest.py FAILS on any ${UPPER_SNAKE} it cannot resolve, so this set is
    // the contract the installer has to satisfy. Enumerated rather than counted: a new
    // placeholder appearing is a deploy that breaks at apply time, and it should break here.
    const found = [...new Set(manifest.match(/\$\{[A-Z][A-Z0-9_]*\}/g) ?? [])].sort();
    expect(found).toEqual([
      '${KARPENTER_CLUSTER_NAME}',
      '${KARPENTER_CONTROLLER_ROLE_ARN}',
      '${KARPENTER_IMAGE_REPO}',
    ]);
  });

  test('render is a maintenance task, NOT part of the build', () => {
    // Rendering needs helm and egress. In the build it would stop a builder on a restricted
    // network from running the gate at all.
    //
    // Walks build's TRANSITIVE spawn graph. `build.steps` holds only spawns of
    // default/pre-compile/compile/post-compile/test/package, so asserting on that array
    // alone would miss the render being added to any one of those subtasks -- which is
    // exactly how it would get folded in by someone wanting it to run automatically.
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    ) as { tasks: Record<string, { steps?: Array<{ spawn?: string; exec?: string }> }> };
    expect(tasks.tasks['karpenter:render']).toBeDefined();

    const seen = new Set<string>();
    const reachable: string[] = [];
    const walk = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      for (const step of tasks.tasks[name]?.steps ?? []) {
        if (step.exec) reachable.push(step.exec);
        if (step.spawn) {
          reachable.push(`spawn:${step.spawn}`);
          walk(step.spawn);
        }
      }
    };
    walk('build');
    expect(reachable.length).toBeGreaterThan(5); // the walk actually traversed something
    expect(reachable.join('\n')).not.toContain('karpenter');
  });
});

describe('Karpenter EC2NodeClass, NodePool and installer wiring (step 11c)', () => {
  // Comment lines are STRIPPED before asserting. The file documents why amd64 and
  // WhenEmptyOrUnderutilized are wrong, so a naive not.toContain matches the EXPLANATION
  // rather than the configuration -- both of these assertions failed that way first. Prose
  // must not be able to satisfy or break a contract test.
  const nodepoolRaw = fs.readFileSync(
    path.join(__dirname, '..', 'k8s', 'karpenter-nodepool.yaml'),
    'utf8',
  );
  const nodepool = nodepoolRaw
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  const tasks = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
  ) as { tasks: Record<string, { steps?: Array<{ exec?: string }> }> };
  const deployExecs = (tasks.tasks.deploy.steps ?? [])
    .map((s) => s.exec ?? '')
    .join('\n');

  test('the NodePool admits arm64 on-demand ONLY', () => {
    // arm64 is not a preference. The app image is arm64-only because kaniko cannot
    // cross-build, so an amd64 node would take the pod and CrashLoopBackOff with "exec
    // format error" -- read as an application fault, not an architecture mismatch.
    // On-demand because there is no SQS interruption queue, so a spot reclaim would be an
    // unhandled node disappearance mid-demo.
    expect(nodepool).toMatch(/key: kubernetes\.io\/arch[\s\S]{0,80}values: \['arm64'\]/);
    expect(nodepool).not.toContain('amd64');
    expect(nodepool).toMatch(
      /key: karpenter\.sh\/capacity-type[\s\S]{0,80}values: \['on-demand'\]/,
    );
    expect(nodepool).not.toContain("'spot'");
  });

  test('disruption reaps EMPTY nodes only: WhenEmpty + 5m + budget 1', () => {
    // Karpenter's defaults are consolidationPolicy WhenEmptyOrUnderutilized with
    // consolidateAfter 0 -- it starts consolidating immediately, and on the standby two idle
    // pods on two nodes IS the underutilized case, so it would evict app pods and delete a
    // node mid-demo. WhenEmpty never touches a node carrying a pod, which is the safety
    // property recordings rely on. The original budget of '0' additionally blocked reaping
    // EMPTY nodes -- proven live 2026-08-29: eight empty nodes per region billed indefinitely
    // after a failover/restore cycle. The contract is now: empties reaped after 5m, one at a
    // time, and ONLY empties.
    expect(nodepool).toContain('consolidationPolicy: WhenEmpty');
    expect(nodepool).not.toContain('WhenEmptyOrUnderutilized');
    expect(nodepool).toContain('consolidateAfter: 5m');
    expect(nodepool).not.toContain('consolidateAfter: Never');
    expect(nodepool).toContain("nodes: '1'");
    expect(nodepool).not.toContain("nodes: '0'");
    // The budget is only safe BECAUSE the policy is WhenEmpty -- pin the pairing, not just
    // the two values independently: the policy must appear in the same disruption block
    // that carries the budget.
    expect(nodepool).toMatch(
      /disruption:[\s\S]{0,600}consolidationPolicy: WhenEmpty[\s\S]{0,600}nodes: '1'/,
    );
  });

  test('EC2NodeClass spec.tags arms every launched node with the tag FIS selects by', () => {
    // Karpenter nodes belong to no ASG, so the arm gesture's node-group walk never saw
    // them: 3 of 5 nodes were silently immune to every fault (measured 2026-09-01), and a
    // node launched MID-demo by a scale-up would arrive unarmed exactly when the chart is
    // being watched. spec.tags applies at LAUNCH — Karpenter's at-creation CreateTags has
    // no tag-key allowlist, so no IAM change is needed — and CANNOT retro-tag running
    // nodes (that is the cockpit arm action's job). Comment-stripped `nodepool`: the
    // explanation above the tag names ChaosAllowed too.
    // The tag must live in the EC2NodeClass document, not the NodePool (NodePool has no
    // spec.tags; a tag there applies cleanly as unknown config and arms nothing).
    const nodeClassDoc = nodepool
      .split(/^---$/m)
      .find((d) => d.includes('kind: EC2NodeClass'));
    expect(nodeClassDoc).toBeDefined();
    expect(nodeClassDoc).toMatch(/\n  tags:\n(    .+\n)*    ChaosAllowed: "true"/);
    // PAIRED with the selector, derived not duplicated: the key the EC2NodeClass stamps
    // must be the key the FIS templates target, or arming-at-launch silently arms nothing.
    const regionStack = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'region-stack.ts'), 'utf8');
    const m = regionStack.match(/resourceTags:\s*\{\s*(\w+):\s*'true'\s*\}/);
    expect(m).not.toBeNull();
    expect(nodeClassDoc).toContain(`${m![1]}: "true"`);
  });

  test('IMDS hop limit is 2, not Karpenter default 1', () => {
    // A real divergence with a real consequence. Managed node groups default to 2, Karpenter
    // to 1 -- and hop limit 1 stops pods NOT on the host network from reaching IMDS. The app
    // reads the failure-injection knob from SSM using the NODE role's credentials via IMDS,
    // so at 1 the knob read fails on Karpenter nodes while still working on managed nodes:
    // injection would appear to work at baseline and silently miss every surge pod.
    expect(nodepool).toContain('httpPutResponseHopLimit: 2');
    expect(nodepool).toContain('httpTokens: required');
  });

  test('the instance profile is referenced, never a role', () => {
    // spec.role would make Karpenter try to MANAGE a profile through the IAM API, which is
    // unreachable from these subnets.
    expect(nodepool).toContain('instanceProfile: ${KARPENTER_INSTANCE_PROFILE}');
    expect(nodepool).not.toMatch(/^\s+role:/m);
  });

  test('the security group is selected BY ID, so surge pods stay reachable', () => {
    // It must be the EKS-owned CLUSTER security group: that is where the NodePort
    // 30000-32767 ingress rules live (4a/4c). A surge node with any other group is
    // unreachable by the in-tree load balancer while every health signal looks fine. EKS owns
    // that group, so CloudFormation cannot tag it -- hence an id selector, not a tag one.
    expect(nodepool).toContain('- id: ${KARPENTER_SECURITY_GROUP_ID}');
    expect(nodepool).toContain('karpenter.sh/discovery: ${KARPENTER_CLUSTER_NAME}');
  });

  test('the main manifest is applied SERVER-SIDE, because two CRDs exceed the annotation cap', () => {
    // Client-side `kubectl apply` writes the entire object into the
    // `last-applied-configuration` annotation, and Kubernetes caps annotations at
    // 262144 bytes. Live-proven 2026-08-26: the install died mid-file on
    // `applicationsets.argoproj.io` AFTER namespaces and chart-repo had applied, so the
    // failure looks like a partial install rather than a size limit. Argo CD's own
    // 3.2->3.3 upgrade notes require SSA for this reason.
    const installerRaw = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'app-installer.ts'),
      'utf8',
    );
    // Comments MUST be stripped before any absence assertion -- the explanation above the
    // command names the client-side form, and a naive toContain would pass on the comment.
    const code = installerRaw
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');

    // Assert the ACTUAL invocation, both flags, on one line.
    expect(code).toContain(
      'kubectl apply --server-side --force-conflicts -f /tmp/manifest.yaml',
    );
    // ...and that the client-side form is gone. This is the assertion that fails if
    // someone "simplifies" the flags away.
    expect(code).not.toContain("'kubectl apply -f /tmp/manifest.yaml'");

    // Anchor the WHY in a measurement, not folklore: at least one document in the
    // vendored Argo CD install genuinely exceeds the cap, so client-side apply cannot
    // work no matter what else is fixed. (Two do today: applications.argoproj.io ~397KB
    // and applicationsets.argoproj.io ~1.39MB.)
    const argocd = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'argo', 'argocd-install.yaml'),
      'utf8',
    );
    const oversized = argocd
      .split('\n---\n')
      .filter((d) => d.length > 262144 && d.includes('kind: CustomResourceDefinition'));
    expect(oversized.length).toBeGreaterThanOrEqual(1);
  });

  test('custom resources are applied in a SECOND pass, after CRD establishment', () => {
    // `kubectl apply -f` does not wait for a CRD to become established, so one combined file
    // races: the EC2NodeClass fails with "no matches for kind" while its CRD sits earlier in
    // the same document.
    const installer = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'app-installer.ts'),
      'utf8',
    );
    expect(installer).toContain('CR_MANIFEST_S3_URI');
    expect(installer).toContain('--for=condition=established');
    expect(installer).toContain('crd/ec2nodeclasses.karpenter.k8s.aws');
    expect(installer).toContain('crd/nodepools.karpenter.sh');
    // The wait must come BEFORE the custom-resource apply, or it buys nothing.
    expect(installer.indexOf('--for=condition=established')).toBeLessThan(
      installer.indexOf('kubectl apply -f /tmp/cr-manifest.yaml'),
    );
  });

  test('every namespaced doc in every manifest names its namespace EXPLICITLY', () => {
    // Attempt 10 shipped an entire Argo CD instance into `default`: upstream's
    // install.yaml assumes `kubectl apply -n argocd` and carries no
    // metadata.namespace on 50 of its 59 docs, while OUR installer applies one
    // concatenated file with no -n. The Service and config override sat in
    // `argocd` selecting nothing — empty NLB endpoints, dead front door, and an
    // Application CR no controller ever reconciled. Namespace must therefore be
    // IN THE DOCUMENT, never inherited from the apply invocation.
    const CLUSTER_SCOPED = new Set([
      'ClusterRole', 'ClusterRoleBinding', 'CustomResourceDefinition',
      'Namespace', 'APIService', 'PriorityClass', 'StorageClass',
      'EC2NodeClass', 'NodePool',
    ]);
    const files = [
      ...fs.readdirSync(path.join(__dirname, '..', 'k8s')).map((f) => path.join('k8s', f)),
      path.join('src', 'argo', 'argocd-install.yaml'),
      path.join('src', 'argo', 'metrics-server.yaml'),
    ].filter((f) => f.endsWith('.yaml'));
    const missing: string[] = [];
    for (const f of files) {
      const raw = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      for (const doc of raw.split(/^---\s*$/m)) {
        const kind = doc.match(/^kind:\s*(\S+)/m)?.[1];
        if (!kind || CLUSTER_SCOPED.has(kind)) continue;
        // The TOP-LEVEL metadata block only: from a column-0 `metadata:` to the
        // next column-0 key. Subjects in bindings also say `namespace:` at a
        // 2-space indent, so the block must be isolated before matching.
        const block = doc.match(/^metadata:\n((?:[ \t].*\n|\n)*)/m)?.[1] ?? '';
        if (!/^ {2}namespace:\s*\S+/m.test(block)) {
          missing.push(`${f}: ${kind}/${doc.match(/^ {2}name:\s*(\S+)/m)?.[1] ?? '?'}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('the installer deletes the mis-placed default-namespace Argo CD copy first', () => {
    // Fixing the manifests alone leaves the wrong instance RUNNING: the apply
    // creates a second Argo CD in `argocd` and two application controllers then
    // fight over the same Application CR. The label-scoped delete must exist and
    // must run BEFORE the apply.
    const installer = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'app-installer.ts'),
      'utf8',
    );
    const cleanup = 'kubectl -n default delete deploy,statefulset,service,configmap,secret,serviceaccount,role,rolebinding,networkpolicy -l app.kubernetes.io/part-of=argocd --ignore-not-found';
    // Anchored to the string's OPENING QUOTE: `toContain(cleanup)` alone stays
    // green if the command is prefixed into a comment or echo inside the same
    // literal — the mutation test caught exactly that survival.
    expect(installer).toContain(`'${cleanup}'`);
    expect(installer.indexOf(cleanup)).toBeLessThan(
      installer.indexOf('kubectl apply --server-side --force-conflicts -f /tmp/manifest.yaml'),
    );
  });

  test('kaniko runs are isolated and the EXPORTED tarball is verified', () => {
    // The in-image import smoke test was NOT enough: attempt 11's image passed it
    // in CI and still shipped without urllib3, because the loss happened at layer
    // EXPORT, after the build filesystem was checked. Two defenses, both pinned:
    // (1) kaniko's executor is single-use -- looping it in one container without
    //     --cleanup lets run N+1 export layers contaminated by run N's leftover
    //     filesystem; (2) the check that matters runs against the artifact that
    //     ships: every ==-pinned package must appear in the exported layers.
    const script = fs.readFileSync(
      path.join(__dirname, '..', 'build', 'build-docker.sh'),
      'utf8',
    );
    // Strip comments so a flag surviving only in prose cannot pass.
    const code = script.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    // Every executor invocation carries --cleanup. Anchor on --no-push, which
    // appears exactly once per real invocation (the bare `[ -x /kaniko/executor ]`
    // existence check would false-positive a split on the binary path).
    const pushes = [...code.matchAll(/--no-push/g)].map((m) => m.index as number);
    expect(pushes.length).toBeGreaterThanOrEqual(2);
    for (const idx of pushes) {
      const window = code.slice(Math.max(0, idx - 300), idx);
      expect(window).toContain('--cleanup');
    }
    // The tarball verification exists, keys off requirements.txt pins, and FAILS
    // the build (exit 1) when a pinned package is absent from the exported layers.
    expect(code).toContain('tar -tf "$TAR_PATH"');
    expect(code).toMatch(/MISSING pinned package/);
    expect(code).toMatch(/if \[ -n "\$MISSING" \]; then[\s\S]{0,400}exit 1/);
  });

  test('the app image proves its import graph at BUILD time', () => {
    // The attempt-10 image was missing urllib3 — a module botocore requires
    // unconditionally, while s3transfer WAS present: a state no single pip run
    // can produce. The pods crashed at import with every build green. The
    // Dockerfile must run the full runtime import inside the image so that
    // failure mode dies in CI instead of as CrashLoopBackOff.
    const dockerfile = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'app', 'Dockerfile'),
      'utf8',
    );
    expect(dockerfile).toMatch(/^RUN AWS_REGION=\S+ [^\n]*\\\n[^\n]*python -c "import server, schema"/m);
    // The smoke test must come AFTER the app code lands in the image.
    expect(dockerfile.indexOf('COPY common.py')).toBeLessThan(
      dockerfile.indexOf('import server, schema'),
    );
    // And urllib3 is now a DIRECT, pinned dependency.
    const reqs = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'app', 'requirements.txt'),
      'utf8',
    );
    expect(reqs).toMatch(/^urllib3==/m);
  });

  test('BOTH regions install Karpenter and stage the CR manifest', () => {
    // The standby needs its own Karpenter: it is the region ARC scales up, so it is where
    // surge capacity is actually required. Installing only in the primary would look green
    // for the whole demo and fail exactly at cutover.
    for (const region of REGIONS) {
      expect(deployExecs).toContain(`cr-manifest-${region.name}.yaml`);
    }
    expect(deployExecs).toContain('src/karpenter/karpenter.yaml');
    expect(deployExecs).toContain('k8s/karpenter-nodepool.yaml');
    // Two stages per region: rendered locally, then staged to S3 for the in-VPC installer.
    expect(
      (deployExecs.match(/cr-manifest-us-(east|west)-2\.yaml/g) ?? []).length,
    ).toBeGreaterThanOrEqual(REGIONS.length * 2);
  });

  test('every Karpenter placeholder is supplied by the deploy task', () => {
    // The renderer FAILS on an unresolved placeholder, so a placeholder the deploy does not
    // supply is a deploy that dies at the render step. Derived from the manifests rather
    // than listed, so a new placeholder cannot be added without also being supplied.
    const manifests = [
      nodepoolRaw,
      fs.readFileSync(path.join(__dirname, '..', 'src', 'karpenter', 'karpenter.yaml'), 'utf8'),
    ].join('\n');
    const needed = [...new Set(manifests.match(/\$\{KARPENTER_[A-Z0-9_]*\}/g) ?? [])];
    expect(needed.length).toBeGreaterThan(3);
    const projenrc = fs.readFileSync(path.join(__dirname, '..', '.projenrc.ts'), 'utf8');
    for (const ph of needed) {
      const name = ph.slice(2, -1);
      expect(projenrc).toContain(`${name}:`);
    }
  });
});

describe('pod anti-affinity and the ARC scale-up timeout (steps 11d/11e)', () => {
  const appRaw = fs.readFileSync(path.join(__dirname, '..', 'k8s', 'app.yaml'), 'utf8');
  // Comment lines stripped: the file explains why preferred anti-affinity and a non-zero
  // maxSurge are wrong, and a naive substring assertion matches the explanation.
  const app = appRaw
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

  test('anti-affinity is REQUIRED, per hostname', () => {
    // Preferred would let the scheduler pack all four replicas onto the two existing nodes
    // whenever it felt like it -- Karpenter would then never be asked for capacity, and the
    // demo would show a failover that provisioned nothing while claiming otherwise.
    expect(app).toContain('podAntiAffinity');
    expect(app).toContain('requiredDuringSchedulingIgnoredDuringExecution');
    expect(app).not.toContain('preferredDuringSchedulingIgnoredDuringExecution');
    expect(app).toContain('topologyKey: kubernetes.io/hostname');
  });

  test('the anti-affinity selector matches the Deployment OWN labels', () => {
    // THE SILENT NO-OP THIS GUARDS. A labelSelector that matches no pod makes the whole
    // constraint vacuous: every replica schedules anywhere, all four fit on two nodes,
    // Karpenter provisions nothing, and the manifest still applies cleanly with no warning
    // from Kubernetes. The selector and the Deployment's own matchLabels have to agree.
    const selectorApp = [...app.matchAll(/matchLabels:\s*\n\s+app: (\S+)/g)].map((m) => m[1]);
    expect(selectorApp.length).toBeGreaterThanOrEqual(2); // Deployment selector + affinity
    expect(new Set(selectorApp).size).toBe(1);
    const podLabel = app.match(/^      labels:\n        app: (\S+)$/m);
    expect(podLabel).not.toBeNull();
    expect(selectorApp[0]).toBe(podLabel![1]);
  });

  test('maxSurge is 0, so an image update does not provision a node', () => {
    // With one-pod-per-node required and two nodes, a surge pod has nowhere to go on
    // existing capacity, so the default 25% maxSurge would make EVERY app update wait on a
    // fresh Karpenter node.
    expect(app).toMatch(/maxSurge: 0/);
    expect(app).toMatch(/maxUnavailable: 1/);
  });

  test('the ARC EKS scaling block timeout is a measured bound, not headroom', () => {
    // Node provisioning is a SERIAL PREREQUISITE of this block (required anti-affinity leaves
    // surge replicas Pending until Karpenter provisions). Four live executions put the whole
    // step at 3-6 minutes when capacity exists. When it CANNOT exist (request above the pod
    // ceiling) the step burns the full timeout with nothing to skip until it expires -- the
    // 2026-09-09 fail-back sat 20 silent minutes that way. So the bound is two-sided.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'failover-stack.ts'),
      'utf8',
    );
    const t = synthAll().get(`${APP_ID}-${FAILOVER_SUFFIX}`);
    expect(t).toBeDefined();
    const plan = Object.values(t!.findResources('AWS::ARCRegionSwitch::Plan'))[0];
    // Identified by TargetPercent, which only the EKS scaling block carries. Matching on
    // the configuration key with [^}]* fails because the surrounding JSON nests objects.
    const eksBlock = JSON.stringify(plan.Properties).match(
      /"TargetPercent": ?\d+, ?"TimeoutMinutes": ?(\d+)/,
    );
    // Fall back to the source when the synthesized shape nests differently; the point is the
    // VALUE, and asserting only the source would miss it being overridden later.
    const minutes = eksBlock
      ? Number(eksBlock[1])
      : Number(src.match(/minimumSuccessPercentage: 90,[\s\S]*?timeoutMinutes: (\d+)/)![1]);
    // Floor: the slowest measured successful step (6 min) plus margin.
    expect(minutes).toBeGreaterThanOrEqual(8);
    // Ceiling: anything past 10 turns a mis-sized request back into a silent wait on stage.
    expect(minutes).toBeLessThanOrEqual(10);
  });
});

describe('the ARC endpoint wrapper and operator runbook (step 9)', () => {
  const wrapper = path.join(__dirname, '..', 'build', 'arc-switch.sh');
  const run = (args: string) =>
    execSync(`bash ${wrapper} ${args} 2>&1 || true`, { encoding: 'utf8' });

  test('deactivate is REFUSED, with the activate form to use instead', () => {
    // The plan became activePassive with a SINGLE activate workflow (2026-08-26), so
    // StartPlanExecution has no deactivate workflow to match and would reject the call --
    // after the operator had already typed a failover command. Refusing locally, with the
    // replacement spelled out, is the difference between a typo and a confusing API error
    // during an event.
    //
    // The endpoint trap this script exists for is still real and still guarded (see the
    // source assertion below): --target-region is "the Region that traffic will be shifted
    // to or FROM, depending on the action", while the API endpoint must be the region being
    // ACTIVATED, because ARC runs a regional data plane precisely to avoid depending on the
    // impaired region. With only activate available the two now always coincide.
    const out = run('deactivate us-east-2 arn:aws:x::1:plan/p');
    expect(out).toContain('NO deactivate workflow');
    expect(out).toContain('activate <standby-region>');
    expect(out).not.toContain('Starting execution');
  });

  test('activate targets and calls the same region', () => {
    const out = run('activate us-west-2 arn:aws:x::1:plan/p');
    expect(out).toMatch(/API endpoint: +us-west-2/);
    expect(out).toContain('region ACTIVATED:  us-west-2');
    // Failback flips both, automatically.
    const back = run('activate us-east-2 arn:aws:x::1:plan/p');
    expect(back).toMatch(/API endpoint: +us-east-2/);
  });

  test('it is a DRY RUN unless --execute is passed', () => {
    // A failover should not be triggerable by a mistyped argument.
    const out = run('activate us-west-2 arn:aws:x::1:plan/p');
    expect(out).toContain('DRY RUN');
    expect(out).not.toContain('Starting execution');
  });

  test('bad input is refused rather than sent to the API', () => {
    expect(run('sideways us-east-2 arn:x')).toContain("action must be 'activate' or 'deactivate'");
    // A region typo would otherwise become a valid-looking API request.
    expect(run('activate eu-west-1 arn:x')).toContain('is not one of the plan');
    expect(run('activate us-west-2')).toContain('usage:');
  });

  test('the endpoint can never be the region being deactivated', () => {
    // A guard against a future refactor reintroducing the exact dependency the regional data
    // plane exists to remove. Asserted on the source because it is unreachable by input.
    const src = fs.readFileSync(wrapper, 'utf8');
    expect(src).toContain('Refusing');
    expect(src).toMatch(/ENDPOINT_REGION" = "\$TARGET_REGION"/);
  });

  test('the runbook carries the operational facts CDK cannot express', () => {
    // Prose, but these specific items each cost real debugging time to discover and every one
    // of them is invisible in the code.
    const rb = fs.readFileSync(path.join(__dirname, '..', 'docs', 'runbook.md'), 'utf8');
    for (const fact of [
      'DEPLOY THE DAY BEFORE', // the 24h replica sample
      'AllowedCidr', // every deploy resets it to deny-all
      'ALARM, by design', // the standby alarm is expected to be open
      'flat 100% line', // what the INERT construct defaults produced, and why they changed
      'ChaosAllowed', // the arming gesture
      'not quota headroom', // evaluation does not check quotas
      'regional data plane', // the endpoint rule
      'Writes recover, not just reads', // application vs platform recovery
      '2 \u2192 4', // the replica-count check
    ]) {
      expect(rb).toContain(fact);
    }
  });

  test('the runbook severity claims match the SHIPPED calibration, not a superseded one', () => {
    // The runbook carried "latency 500 ms" and "packet loss 60%" for a day after the menu
    // shipped 400ms/25% — an operator following it would have narrated numbers the cockpit
    // does not offer, and 500ms is the value PROVEN to trip the 50% guardrail and
    // self-terminate (bug class 23). Operator-facing text is a gated code change.
    const rb = fs.readFileSync(path.join(__dirname, '..', 'docs', 'runbook.md'), 'utf8');
    expect(rb).toContain('FIS latency 400 ms');
    expect(rb).toContain('FIS packet loss 25%');
    // The superseded values may appear ONLY as the cautionary tale, never as a menu row.
    expect(rb).not.toContain('FIS latency 500 ms');
    expect(rb).not.toContain('FIS packet loss 60%');
    // The ceiling is part of the calibration story now — one-sided "must exceed the
    // timeout" reasoning is what let 500ms look correct.
    expect(rb).toContain('ceiling as well as a floor');
    // The stress faults are gone; the runbook must say so rather than list them.
    expect(rb).not.toContain('stays on the menu');
    expect(rb).toContain('gone from the menu');
    // Re-validation after the armed fleet changed is an operator step, not a suggestion.
    expect(rb).toContain('Re-validate both numbers after any change to the armed fleet');
  });

  test('the runbook AZ segment covers the beats and the segment script exists', () => {
    const rb = fs.readFileSync(path.join(__dirname, '..', 'docs', 'runbook.md'), 'utf8');
    for (const fact of [
      'The AZ segment', // the section exists
      'You do not pick the AZ', // auto-selection is a design property, not a limitation
      'auto-cancels with it', // F4 — stopping the fault takes the shift down
      'karpenter.sh/nodepool', // the arm action now reaches the Karpenter fleet
      'verify-zonal-shift-azs.py', // where to look when the shift 409s
      'power-interruption-single-az', // the black impairment fault, by its menu name
      'target health', // the platform's verdict — a BADGE now, and never called availability
      'client-perceived availability', // what the per-AZ chart actually measures (2026-09-03)
      'Target resolution returned empty set', // the unarmed-AZ failure, named
      // T5 (2026-09-02 evening): the segment is now the THREE-beat gray-to-black ladder.
      'brownout-single-az', // the gray fault, by its menu name
      'THREE beats', // the ladder is the structure, pinned so a beat cannot be dropped
      'expect ALL THREE zones to wobble', // the PT2M blackhole artifact, pre-narrated
      'control move, not the recovery mechanism', // the honest shift claim (live-corrected)
      'recovers on its own', // the aggregate self-heals in ~1 min — say it FIRST
      'registered-unhealthy for the whole window', // tolerations hold the dark zone visible
      // 2026-09-04 CORRECTIONS. Each of these replaced a claim the live runs disproved, so
      // each is pinned: the retraction is the content, and a doc that quietly reverts to
      // the old story is worse than one that never had it.
      'the flap that cannot happen', // the retraction section itself
      'the ladder does NOT run in menu order', // latency 22.7% is worse than brownout 66.2%
      '22.7%', // measured faulted-zone SLO for latency-single-az
      '66.2%', // measured faulted-zone SLO for the brownout
      'calibration table', // the measured four-fault table exists
    ]) {
      expect(rb).toContain(fact);
    }
    // The superseded story must be GONE, not merely joined. §4b narrating a latency-driven
    // availability dip is what the first calibration disproved — and attributing the
    // AGGREGATE's recovery to the shift is what the 2026-09-02 live validation disproved:
    // cross-zone routing restored the aggregate in ~1 minute with no operator action, so
    // "recovery ... attributable to the shift" would be contradicted by the chart on
    // stage. The shift is the operator's control move; only the runbook may say so.
    // ANCHORED ON THE SECTION HEADING, and length-guarded. The previous version sliced on
    // 'The AZ segment', which occurs THREE times -- twice as "See \"The AZ segment\" below"
    // inside the fault-menu table -- so it captured 468 characters of that table instead of
    // §4b, and every negative assertion below was vacuous. Found 2026-09-04 by mutating the
    // runbook to reinstate the flap narration and watching the test stay green. The guard is
    // the durable half of the fix: an anchor that drifts again shrinks the slice, and a
    // shrunken slice must fail rather than silently pass.
    const azSegment = rb.split('\n## 4b.')[1].split('\n## ')[0];
    expect(azSegment.length).toBeGreaterThan(4000);
    expect(azSegment).not.toContain('The aggregate sags into the 90s');
    expect(azSegment).not.toContain('attributable to the shift');
    // And the flap must not come back as narration. Two live runs at the shipped severity
    // held 3/3 targets healthy; a step telling an operator to watch for a flap sends them
    // looking for something that cannot happen, on stage.
    expect(azSegment).not.toContain('target health start flapping');
    expect(azSegment).not.toContain('a flapping zone is WORSE');
    // The on-stage script (F9 / Q5b) — and its beats must not contradict the mechanics.
    const script = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'az-segment-script.md'), 'utf8');
    expect(script).toContain('If it goes sideways on stage');
    // T5: the script runs the same three-beat ladder in the same order, and carries the
    // same live-corrected recovery claim.
    for (const fault of ['latency-single-az', 'brownout-single-az', 'power-interruption-single-az']) {
      expect(script).toContain(fault);
    }
    expect(script.indexOf('latency-single-az'))
      .toBeLessThan(script.indexOf('brownout-single-az'));
    expect(script.indexOf('brownout-single-az'))
      .toBeLessThan(script.indexOf('power-interruption-single-az'));
    expect(script).toContain('target health');
    expect(script).toContain('control move, not the recovery');
    expect(script).toContain('recovers *on its own*');
    expect(script).not.toContain('attributable to the shift');
    // 2026-09-04: the script's beat 2 was "what this app shrugs off" over a fault that
    // measures 22.7%. The spoken correction is pinned, and the retracted word is banned
    // outright — every occurrence in the script was a claim about the brownout.
    expect(script).toContain('Our error rate said');
    expect(script.toLowerCase()).not.toContain('flapping');
  });

  test('the runbook does not claim Argo coexistence from status alone', () => {
    // "Argo stayed Synced" is equally true when ARC scaled nothing, so the replica-count
    // check has to come first or the demo's central claim is unfalsifiable.
    const rb = fs.readFileSync(path.join(__dirname, '..', 'docs', 'runbook.md'), 'utf8');
    const replicaCheck = rb.indexOf('replica count actually moved');
    const argoCheck = rb.indexOf('Argo CD still shows');
    expect(replicaCheck).toBeGreaterThan(-1);
    expect(argoCheck).toBeGreaterThan(replicaCheck);
  });
});

describe('vendored Argo CD and metrics-server (step 10b)', () => {
  const argo = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'argo', 'argocd-install.yaml'), 'utf8');
  const ms = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'argo', 'metrics-server.yaml'), 'utf8');
  const mirror = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'mirror', 'images.json'), 'utf8'),
  ) as { images: Array<{ name: string; tag: string; digest: string; arm64Digest: string }> };
  const img = (n: string) => mirror.images.find((i) => i.name === n)!;
  const imageLines = (t: string) =>
    t.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('image:'));

  test('NO image points at a public registry', () => {
    // Pods in the isolated subnets cannot reach quay.io, ghcr.io or registry.k8s.io -- and
    // public.ecr.aws is NOT a shortcut, because the step-3a interface endpoints serve PRIVATE
    // ECR only. A missed rewrite applies cleanly and surfaces as an image-pull timeout that
    // reads as a network fault rather than a manifest that was never repointed.
    for (const line of [...imageLines(argo), ...imageLines(ms)]) {
      expect(line).toContain('${MIRROR_REGISTRY}/');
      expect(line).not.toMatch(/quay\.io|ghcr\.io|registry\.k8s\.io|public\.ecr\.aws/);
    }
    expect(imageLines(argo).length).toBeGreaterThan(5); // argocd backs many containers
    expect(imageLines(ms)).toHaveLength(1);
  });

  test('every digest is the ARM64 CHILD digest from the mirror lockfile', () => {
    // THE TRAP, same as step 11b. The mirror copies only linux/arm64, so an INDEX digest is
    // absent from our ECR and the pod fails with "manifest unknown". Tied to images.json so a
    // mirror bump that forgets to re-render fails the build.
    for (const [text, name] of [
      [argo, 'argocd'], [argo, 'redis'], [argo, 'dex'], [ms, 'metrics-server'],
    ] as Array<[string, string]>) {
      const e = img(name);
      expect(text).toContain(`\${MIRROR_REGISTRY}/${name}:${e.tag}@${e.arm64Digest}`);
      expect(text).not.toContain(e.digest); // never the index digest
    }
  });

  test('metrics-server is installed — the HPA is inert without it', () => {
    // An HPA with no metrics source reports <unknown>/target forever and never acts, which
    // silently removes one of the three controllers the coexistence story is about.
    expect(ms).toContain('kind: APIService');
    expect(ms).toContain('v1beta1.metrics.k8s.io');
    // Upstream already sets the kubelet address-type args EKS needs; asserted so a re-render
    // against a changed upstream cannot drop them unnoticed.
    expect(ms).toContain('--kubelet-preferred-address-types=InternalIP');
  });

  test('Argo CD CRDs are present, so 10d has something to create against', () => {
    for (const crd of [
      'applications.argoproj.io', 'appprojects.argoproj.io', 'applicationsets.argoproj.io',
    ]) {
      expect(argo).toContain(crd);
    }
  });

  test('BOTH regions install Argo CD and metrics-server', () => {
    // The standby must be Argo-managed: it is the region ARC scales, so it is where the
    // claimed conflict would actually occur. Primary-only would look green all demo.
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    ) as { tasks: Record<string, { steps?: Array<{ exec?: string }> }> };
    const execs = (tasks.tasks.deploy.steps ?? []).map((s) => s.exec ?? '').join('\n');
    expect(
      (execs.match(/src\/argo\/argocd-install\.yaml/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      (execs.match(/src\/argo\/metrics-server\.yaml/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test('argo:render is a maintenance task, not part of the build', () => {
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    ) as { tasks: Record<string, { steps?: Array<{ spawn?: string; exec?: string }> }> };
    expect(tasks.tasks['argo:render']).toBeDefined();
    const seen = new Set<string>();
    const reach: string[] = [];
    const walk = (n: string) => {
      if (seen.has(n)) return;
      seen.add(n);
      for (const st of tasks.tasks[n]?.steps ?? []) {
        if (st.exec) reach.push(st.exec);
        if (st.spawn) { reach.push(st.spawn); walk(st.spawn); }
      }
    };
    walk('build');
    expect(reach.join('\n')).not.toContain('argo/render.sh');
  });
});

describe('the in-cluster Helm chart repository (step 10c)', () => {
  const repoRaw = fs.readFileSync(path.join(__dirname, '..', 'k8s', 'chart-repo.yaml'), 'utf8');
  // Comments stripped: this file explains why port 80, ECR-OCI and git are wrong, so a naive
  // substring assertion matches the prose rather than the config.
  const repo = repoRaw.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const pkg = fs.readFileSync(path.join(__dirname, '..', 'build', 'package-chart.py'), 'utf8');
  const mirror = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'mirror', 'images.json'), 'utf8'),
  ) as { images: Array<{ name: string; tag: string; digest: string; arm64Digest: string }> };
  const nginx = mirror.images.find((i) => i.name === 'nginx')!;

  test('nginx runs unprivileged and listens on 8080, not 80', () => {
    // The container runs as UID 101 and cannot bind a privileged port. Left at 80 the pod
    // CrashLoopBackOffs with a permission error that looks nothing like a port problem.
    expect(repo).toContain('runAsNonRoot: true');
    expect(repo).toContain('containerPort: 8080');
    expect(repo).toContain('listen 8080;');
    expect(repo).not.toMatch(/containerPort: 80$/m);
  });

  test('the image is the mirrored nginx at the ARM64 CHILD digest', () => {
    expect(repo).toContain(
      `\${MIRROR_REGISTRY}/nginx:${nginx.tag}@${nginx.arm64Digest}`,
    );
    expect(repo).not.toContain(nginx.digest); // never the multi-platform index digest
  });

  test('readiness probes index.yaml, not /', () => {
    // If the ConfigMap failed to mount, `/` would still answer while the repository is
    // useless -- and Argo's failure would surface as a confusing "chart not found".
    expect(repo).toContain('path: /index.yaml');
    expect(repo).toContain('autoindex off;');
  });

  test('the Service is ClusterIP only', () => {
    // Nothing outside the cluster has any business reading this.
    expect(repo).toContain('type: ClusterIP');
    expect(repo).not.toContain('LoadBalancer');
    expect(repo).not.toContain('NodePort');
  });

  test('packaging REFUSES an unrendered manifest', () => {
    // Argo does not substitute ${...}, so an unrendered chart would ship literal
    // placeholders into the cluster. Proven by running it, not by reading the source.
    const out = execSync(
      `python3 ${path.join(__dirname, '..', 'build', 'package-chart.py')} ` +
        `${path.join(__dirname, '..', 'k8s', 'app.yaml')} /tmp/reject.yaml 2>&1 || true`,
      { encoding: 'utf8' },
    );
    expect(out).toContain('still contains placeholders');
  });

  test('packaging produces a valid chart archive containing the app Deployment', () => {
    // The chart's only template IS the rendered k8s/app.yaml, so Argo manages exactly the
    // Deployment the installer applies and ARC later scales. A separate copy could drift.
    const dir = fs.mkdtempSync('/tmp/chart-test-');
    const rendered = path.join(dir, 'app.yaml');
    execSync(
      `python3 ${path.join(__dirname, '..', 'build', 'render-manifest.py')} ` +
        `${path.join(__dirname, '..', 'k8s', 'app.yaml')} > ${rendered}`,
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          CLUSTER_NAME: 'c',
          APP_IMAGE_URI: 'r/app:t',
          APP_REGION: 'us-east-2',
          DB_SECRET_NAME: 's',
          DB_READ_HOST: 'r',
          DB_WRITE_HOST: 'w',
          ERROR_RATE_PARAM: 'p',
        },
      },
    );
    const cm = path.join(dir, 'cm.yaml');
    execSync(
      `python3 ${path.join(__dirname, '..', 'build', 'package-chart.py')} ${rendered} ${cm}`,
      { encoding: 'utf8' },
    );
    const out = fs.readFileSync(cm, 'utf8');
    expect(out).toContain('kind: ConfigMap');
    expect(out).toContain('name: chart-repo-content');
    expect(out).toContain('binaryData:');
    expect(out).toMatch(/orders-api-0\.1\.\d+\.tgz:/);
    // The digest in index.yaml must be the digest OF the archive, or Helm rejects the chart.
    const b64 = out.match(/^  orders-api-[\d.]+\.tgz: (\S+)$/m)![1];
    const tgz = Buffer.from(b64, 'base64');
    const sha = crypto.createHash('sha256').update(tgz).digest('hex');
    expect(out).toContain(`digest: ${sha}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the chart version is MONOTONIC, not a content hash', () => {
    // Argo CD's repo-server caches resolved manifests keyed by chart VERSION. Republishing
    // one version with different bytes can be served from cache indefinitely -- the symptom
    // is "Argo just doesn't notice", with nothing in its UI explaining why. A content hash
    // would be tidier but hashes are not ORDERED, so targetRevision '*' could resolve
    // BACKWARDS to an older chart.
    expect(pkg).toContain('def chart_version');
    expect(pkg).toContain('time.time()');
    expect(repo).not.toContain('targetRevision'); // that lives in 10d's Application
    expect(repoRaw).toContain("targetRevision: '*'"); // documented in the trailing comment
  });

  test('both regions render, package and apply the chart repo', () => {
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    ) as { tasks: Record<string, { steps?: Array<{ exec?: string }> }> };
    const execs = (tasks.tasks.deploy.steps ?? []).map((s) => s.exec ?? '').join('\n');
    for (const region of REGIONS) {
      // app.yaml is rendered ALONE first so the chart can be built from resolved content.
      expect(execs).toContain(`dist/app-rendered-${region.name}.yaml`);
      expect(execs).toContain(`dist/chart-content-${region.name}.yaml`);
    }
    expect(execs).toContain('build/package-chart.py');
    expect(execs).toContain('k8s/chart-repo.yaml');
    // TWO orderings matter, and only one of them was asserted at first -- a mutation that
    // moved packaging later still passed, because it stayed ahead of the `cat`.
    //
    // 1. app.yaml must be rendered ALONE before packaging, or there is nothing resolved to
    //    package and package-chart.py refuses the file.
    // 2. the append must come after packaging, or it appends a file that does not exist.
    const iRender = execs.indexOf('dist/app-rendered-');
    const iPkg = execs.indexOf('package-chart.py');
    const iCat = execs.indexOf('cat dist/chart-content-');
    expect(iRender).toBeGreaterThan(-1);
    expect(iRender).toBeLessThan(iPkg);
    expect(iPkg).toBeLessThan(iCat);
  });
});

describe('the Argo CD Application, the inert HPA and hpaName (steps 10d/10e)', () => {
  const strip = (t: string) =>
    t.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const appl = strip(
    fs.readFileSync(path.join(__dirname, '..', 'k8s', 'argo-application.yaml'), 'utf8'),
  );
  const app = strip(fs.readFileSync(path.join(__dirname, '..', 'k8s', 'app.yaml'), 'utf8'));

  test('BOTH ignoreDifferences entries are present', () => {
    // One alone is not enough, and which two is the thing that took a correction to get
    // right. ARC scales the Deployment (/spec/replicas) AND patches the HPA's
    // scaleDown.selectPolicy. Excluding only the first leaves Argo reverting the HPA patch on
    // the next reconcile, re-enabling scale-down mid-failover.
    expect(appl).toContain('ignoreDifferences');
    expect(appl).toContain('- /spec/replicas');
    expect(appl).toContain('- /spec/behavior/scaleDown/selectPolicy');
    // NOT minReplicas -- ARC never touches it. An earlier design excluded that path, which
    // would have made the demo disprove its own thesis.
    expect(appl).not.toContain('/spec/minReplicas');
    expect(appl).toContain('kind: HorizontalPodAutoscaler');
    expect(appl).toContain('kind: Deployment');
  });

  test('selfHeal is ON — it is the behaviour under test', () => {
    // A demo with selfHeal off proves nothing: nothing would have reverted ARC's scaling in
    // the first place. The claim is that Argo CAN revert drift and deliberately does not
    // revert THIS drift.
    expect(appl).toMatch(/selfHeal: true/);
    // prune off: the Service owns a Kubernetes-managed load balancer, and an over-eager
    // prune during a failover is far worse than a leftover object.
    expect(appl).toMatch(/prune: false/);
  });

  test('the Application points at the in-cluster chart repo with a floating revision', () => {
    expect(appl).toContain('http://chart-repo.argocd.svc.cluster.local');
    expect(appl).toContain('chart: orders-api');
    // '*' is required: the repo-server caches by chart VERSION, so a pinned version can be
    // served from cache indefinitely after the bytes change.
    expect(appl).toContain("targetRevision: '*'");
  });

  test('the HPA exists, is managed by Argo, and is inert at demo load', () => {
    // In app.yaml -- which IS the chart's only template -- so Argo manages it and therefore
    // has an opinion about the field ARC patches. In a separate uncharted file, Argo would
    // never see ARC's HPA patch and the second exclusion would be untested.
    expect(app).toContain('kind: HorizontalPodAutoscaler');
    expect(app).toContain('averageUtilization: 80');
    expect(app).not.toContain('averageUtilization: 50');
    // The field ARC overwrites must EXIST in the desired state, so ignoreDifferences has a
    // field to ignore rather than suppressing a key that only appears live.
    expect(app).toMatch(/scaleDown:[\s\S]{0,120}selectPolicy: Min/);
    // THREE, not two, since the single-AZ feature: one pod per AZ is the floor the story
    // needs, so the HPA must never scale below it. Left at 2, a quiet period lets the HPA drop
    // a pod and silently empty an AZ, and a fault aimed there injects cleanly and moves no
    // graph. Raising this dates the recorded narration's spoken 2 -> 4 -> 6 and perturbs the
    // ARC 24-hour replica sample for about a day (AGENTS.md bug class 12) -- both known and
    // accepted. Do NOT revert it to keep this assertion green.
    expect(app).toContain('minReplicas: 3');
  });

  test('the three names agree: manifest, ARC plan, Argo exclusion', () => {
    // Nothing would notice a mismatch. A wrong hpaName in the ARC plan is a silently skipped
    // HPA patch, after which the autoscaler is free to undo the scale-up on its next cycle --
    // with the plan reporting success.
    expect(APP_HPA_NAME).toBe('orders-api');
    expect(app).toMatch(new RegExp(`^  name: ${APP_HPA_NAME}$`, 'm'));
    const hpaBlock = appl.slice(appl.indexOf('group: autoscaling'));
    expect(hpaBlock).toContain(`name: ${APP_HPA_NAME}`);
  });

  test('the ARC plan sets hpaName for EVERY region', () => {
    // Read off the SYNTHESIZED plan, not the source: a constant declared but never threaded
    // would look fine in the source. This used to have to dig into a CfnJson payload
    // because the structure was deferred to deploy time; after the 2026-08-26 nesting fix
    // both map keys are plain literals, so the real structure is visible here.
    const t = synthAll().get(`${APP_ID}-${FAILOVER_SUFFIX}`)!;
    const plan = Object.values(t.findResources('AWS::ARCRegionSwitch::Plan'))[0] as any;
    const eks = plan.Properties.Workflows.flatMap((w: any) => w.Steps).find(
      (s: any) => s.ExecutionBlockType === 'EKSResourceScaling',
    ).ExecutionBlockConfiguration.EksResourceScalingConfig;
    const payload = JSON.stringify(eks.ScalingResources);
    expect(payload).toContain('HpaName');
    // One per region, or the standby's HPA is never patched -- and the standby is the region
    // ARC actually scales.
    expect((payload.match(/HpaName/g) ?? []).length).toBe(REGIONS.length);
    expect(payload).toContain(APP_HPA_NAME);
  });

  test('the Application is applied in the SECOND pass, with the nodepool', () => {
    // It is a custom resource of a CRD that Argo's own install creates. In the first pass it
    // fails with "no matches for kind" while the CRDs sit earlier in the same document.
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    ) as { tasks: Record<string, { steps?: Array<{ exec?: string }> }> };
    const execs = (tasks.tasks.deploy.steps ?? []).map((s) => s.exec ?? '').join('\n');
    // Rendered into the CR manifest (2nd arg to runInstaller), not the pass-1 list.
    expect(execs).toContain('k8s/argo-application.yaml');
    for (const region of REGIONS) {
      expect(execs).toContain(`cr-manifest-${region.name}.yaml`);
    }
  });
});

describe('EC2 security group descriptions (found by a rolled-back deploy)', () => {
  // THE DEFECT THIS EXISTS FOR. EC2 accepts a security group description only from
  //   a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*
  // and `>` is NOT in that set. A description reading "CloudFront VPC origin -> us-east-2"
  // passed tsc, passed synth, passed validation against the DEPLOYED CloudFormation
  // resource schema (which types it as a plain string), and then failed the CREATE with
  //   Invalid security group description. Valid descriptions are strings less than 256
  //   characters from the following set: ...
  // taking the whole front-door stack to UPDATE_ROLLBACK_COMPLETE. An arrow in a comment
  // or a stack description is harmless; in THIS field it costs a deploy attempt.
  //
  // Written over EVERY stack rather than the one that broke, because the next arrow will
  // be somewhere else.
  const ALLOWED = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]{1,255}$/;

  test('every SG description in every stack matches the EC2 charset', () => {
    const offenders: string[] = [];
    for (const [stackName, template] of synthAll()) {
      const sgs = template.findResources('AWS::EC2::SecurityGroup');
      for (const [logicalId, res] of Object.entries(sgs)) {
        const props = (res as any).Properties ?? {};
        const fields: Array<[string, unknown]> = [
          ['GroupDescription', props.GroupDescription],
          ...((props.SecurityGroupIngress ?? []) as any[]).map(
            (r, i) => [`ingress[${i}].Description`, r?.Description] as [string, unknown],
          ),
          ...((props.SecurityGroupEgress ?? []) as any[]).map(
            (r, i) => [`egress[${i}].Description`, r?.Description] as [string, unknown],
          ),
        ];
        for (const [field, value] of fields) {
          // Tokens (Fn::Join and friends) are not literal strings and cannot be checked
          // here; only literals are asserted.
          if (typeof value !== 'string') continue;
          if (!ALLOWED.test(value)) {
            const badChars = [...new Set([...value].filter((c) => !ALLOWED.test(c)))];
            offenders.push(`${stackName} ${logicalId}.${field}=${value} bad=${badChars.join('')}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the check actually rejects an arrow (the mutation that broke the deploy)', () => {
    // Guards the guard: a regex that accepted everything would make the test above green
    // for the wrong reason, which is exactly how the original defect shipped.
    expect(ALLOWED.test('observer bastion access -> us-east-2 argocd access door')).toBe(false);
    expect(ALLOWED.test('observer bastion access to the us-east-2 argocd access door')).toBe(true);
    // The punctuation we DO rely on stays legal.
    expect(ALLOWED.test('a-b_c.d:e/f(g)h#i,j@k[l]m+n=o&p;q{r}s!t$u*v')).toBe(true);
  });
});

describe('manifest apply ORDER (found by review, not by the build)', () => {
  // Kubernetes creates these itself; nothing may declare them.
  const BUILTIN = new Set(['default', 'kube-system', 'kube-public', 'kube-node-lease']);

  /** Render the installer's pass-1 manifest list exactly as the deploy task does. */
  const renderPassOne = (): string => {
    const files = [
      'k8s/namespaces.yaml', 'k8s/app.yaml', 'k8s/schema-job.yaml',
      'src/karpenter/karpenter.yaml', 'src/argo/metrics-server.yaml',
      'src/argo/argocd-install.yaml', 'k8s/argocd-config.yaml', 'k8s/chart-repo.yaml',
    ].map((f) => path.join(__dirname, '..', f)).join(' ');
    return execSync(
      `python3 ${path.join(__dirname, '..', 'build', 'render-manifest.py')} ${files}`,
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          CLUSTER_NAME: 'c',
          APP_IMAGE_URI: 'r/a:t',
          APP_REGION: 'us-east-2',
          DB_SECRET_NAME: 's',
          DB_READ_HOST: 'r',
          DB_WRITE_HOST: 'w',
          ERROR_RATE_PARAM: 'p',
          SCHEMA_JOB_SUFFIX: 'ab',
          KARPENTER_CLUSTER_NAME: 'k',
          KARPENTER_IMAGE_REPO: 'x',
          KARPENTER_CONTROLLER_ROLE_ARN: 'a',
          KARPENTER_INSTANCE_PROFILE: 'i',
          KARPENTER_SECURITY_GROUP_ID: 's',
          MIRROR_REGISTRY: 'm',
        },
      },
    );
  };

  test('every namespace is DECLARED BEFORE it is referenced', () => {
    // THE DEFECT THIS EXISTS FOR, and the build never saw it.
    //
    // `kubectl apply -f` on a concatenated manifest applies documents IN ORDER -- it does not
    // topologically sort by kind the way Helm does. Argo CD's vendored install.yaml does NOT
    // create its own Namespace (upstream expects `kubectl create ns argocd` first), and the
    // only thing creating it was k8s/chart-repo.yaml, which the installer applied LAST. Every
    // Argo CD resource would have failed with `namespaces "argocd" not found`, about 2,500
    // lines before the Namespace appeared.
    //
    // Synth green, build green, 182 tests green -- and a failed installer several phases into
    // a live deploy. Written generally so it also covers a namespace nobody has added yet.
    const lines = renderPassOne().split('\n');
    const declared = new Map<string, number>();
    lines.forEach((l, i) => {
      if (i >= 2 && lines[i - 2].trim() === 'kind: Namespace') {
        const m = l.match(/^\s*name: (\S+)\s*$/);
        if (m && !declared.has(m[1])) declared.set(m[1], i);
      }
    });
    expect(declared.has('demo')).toBe(true);
    expect(declared.has('argocd')).toBe(true);

    const violations: string[] = [];
    lines.forEach((l, i) => {
      const m = l.match(/^\s*namespace: (\S+)\s*$/);
      if (!m) return;
      const ns = m[1];
      if (BUILTIN.has(ns)) return;
      if (!declared.has(ns)) {violations.push(`${ns} referenced at ${i} but never declared`);} else if (declared.get(ns)! > i) {
        violations.push(`${ns} referenced at ${i} but declared later at ${declared.get(ns)}`);
      }
    });
    expect(violations).toEqual([]);
  });

  test('namespaces.yaml is the SINGLE owner of every namespace', () => {
    // Not just tidiness. If the chart carried a Namespace, Argo CD would claim ownership of
    // it -- and deleting the Application, or a prune, could take the namespace and everything
    // inside it. k8s/app.yaml IS the chart's only template, so a Namespace there is a
    // Namespace Argo owns.
    const appYaml = fs.readFileSync(path.join(__dirname, '..', 'k8s', 'app.yaml'), 'utf8');
    const chartRepo = fs.readFileSync(path.join(__dirname, '..', 'k8s', 'chart-repo.yaml'), 'utf8');
    expect(appYaml).not.toMatch(/^kind: Namespace$/m);
    expect(chartRepo).not.toMatch(/^kind: Namespace$/m);
    const ns = fs.readFileSync(path.join(__dirname, '..', 'k8s', 'namespaces.yaml'), 'utf8');
    // Assert the NAMED set rather than a bare count: a count tells a future reader that
    // something changed but not what was expected, and it passes for the wrong reason if one
    // namespace is renamed while another is added. Adding a namespace is a deliberate edit
    // here, and each name below has a live consumer:
    //   demo     the application (enforce: baseline)
    //   argocd   Argo CD's vendored install, which creates no namespace of its own
    //   logging  the fluent-bit DaemonSet -- enforce: PRIVILEGED, because baseline forbids
    //            the hostPath mounts a log shipper cannot work without
    const declared = [...ns.matchAll(/^kind: Namespace$[\s\S]*?^  name: (\S+)$/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual(['argocd', 'demo', 'logging']);
  });

  test('namespaces.yaml is FIRST in both regions pass-1 list', () => {
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    ) as { tasks: Record<string, { steps?: Array<{ exec?: string }> }> };
    const execs = (tasks.tasks.deploy.steps ?? []).map((s) => s.exec ?? '');
    const renders = execs.filter((e) => e.includes('render-manifest.py k8s/namespaces.yaml'));
    // One per region -- the standby needs Argo CD too, so it needs the namespace too.
    expect(renders.length).toBeGreaterThanOrEqual(REGIONS.length);
    for (const e of renders) {
      // Must precede argocd-install.yaml in the SAME render invocation.
      const i = e.indexOf('k8s/namespaces.yaml');
      const j = e.indexOf('src/argo/argocd-install.yaml');
      if (j > -1) expect(i).toBeLessThan(j);
    }
  });
});

/**
 * ARC health-check attach step (post-deploy).
 *
 * The ARC Route 53 health check execution block CREATES the checks but does NOT attach
 * them -- the AWS docs put that on the caller. Unattached, an execution flips check state
 * while the records reference nothing: the plan reports SUCCESS and shifts NO traffic, which
 * is the worst possible failure mode for a failover demo. It was fixed by hand twice before
 * being codified, so these assertions exist to stop it regressing to manual again.
 */
describe('ARC health-check verify step', () => {
  const steps = (): string[] => {
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    );
    return (tasks.tasks.deploy.steps as { exec?: string }[]).map((s) => s.exec ?? '');
  };
  const SCRIPT = 'build/verify-arc-health-checks.py';

  it('the deploy runs the verify script exactly once', () => {
    const hits = steps().filter((e) => e.includes(SCRIPT));
    expect(hits).toHaveLength(1);
  });

  it('the script exists (a step referencing a missing file fails only at deploy)', () => {
    expect(fs.existsSync(path.join(__dirname, '..', SCRIPT))).toBe(true);
  });

  it('it sources BOTH the dns and failover dotenvs', () => {
    // HOSTEDZONEID/APPRECORDNAME come from the dns stack, PLANARN from regionswitch. Miss
    // either and the script fails loudly at deploy -- but only after everything else ran.
    const step = steps().find((e) => e.includes(SCRIPT))!;
    expect(step).toContain('dist/$PROJECT_NAME-dns.env');
    expect(step).toContain('dist/$PROJECT_NAME-failover.env');
  });

  it('it runs AFTER both the dns and the failover stack deploys', () => {
    // The zone must exist (dns) and the plan must have vended its checks (regionswitch)
    // before anything can be attached. Ordering is the whole contract.
    const all = steps();
    const attachIdx = all.findIndex((e) => e.includes(SCRIPT));
    const dnsIdx = all.findIndex((e) => e.includes('STACK_NAME=') && e.includes('-dns'));
    const foIdx = all.findIndex((e) => e.includes('STACK_NAME=') && e.includes('-failover'));
    expect(dnsIdx).toBeGreaterThanOrEqual(0);
    expect(foIdx).toBeGreaterThanOrEqual(0);
    expect(attachIdx).toBeGreaterThan(dnsIdx);
    expect(attachIdx).toBeGreaterThan(foIdx);
  });

  it('its generated exec honours the bash -c single-quote invariant', () => {
    // projen's dax shell is not bash, so the step is wrapped in one real `bash -c '...'`.
    // A single quote ANYWHERE inside the payload terminates the wrapper early and the
    // deploy dies with `unexpected EOF` many phases in. Assert on the GENERATED string.
    const step = steps().find((e) => e.includes(SCRIPT))!;
    expect(step.startsWith("bash -c '")).toBe(true);
    expect(step.endsWith("'")).toBe(true);
    // Exactly the wrapper's own two quotes, none inside.
    expect((step.match(/'/g) ?? []).length).toBe(2);
  });
});

describe('synthesized-template lint gate (cfn-lint)', () => {
  const tasksJson = () =>
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'));
  const scriptPath = path.join(__dirname, '..', 'build', 'lint-templates.sh');

  it('the build lints templates AFTER synth and BEFORE the container steps', () => {
    // Order is the point. It must follow synth (no templates exist before it) and precede
    // the docker build so a bad template costs seconds, not a full image build.
    const steps: string[] = tasksJson()
      .tasks['post-compile'].steps.map((s: { spawn?: string }) => s.spawn ?? '')
      .filter(Boolean);
    const synthIdx = steps.indexOf('synth:silent');
    const lintIdx = steps.indexOf('lint:templates');
    expect(synthIdx).toBeGreaterThanOrEqual(0);
    expect(lintIdx).toBeGreaterThan(synthIdx);
    for (const container of ['build:container-plan', 'build:docker']) {
      const cIdx = steps.indexOf(container);
      if (cIdx >= 0) expect(lintIdx).toBeLessThan(cIdx);
    }
  });

  it('the lint task shells out to the script, and the script exists', () => {
    // A task referencing a missing script fails only when the task runs.
    expect(tasksJson().tasks['lint:templates'].steps).toEqual([
      { exec: 'bash build/lint-templates.sh' },
    ]);
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  it('passes the templates BEFORE the flags -- cfn-lint --ignore-checks is variadic', () => {
    // THE subtle failure. `--ignore-checks` is variadic, so placed IMMEDIATELY before the
    // file list it eats the template paths as check names, lints NOTHING, and reports
    // "E1001 'Resources' is a required property" at None:1:1 -- red for the wrong reason,
    // and relaxing that noise yields a gate that is green while checking nothing.
    // Measured on cfn-lint 1.45.0: `--ignore-checks X <files>` lints nothing, while
    // `--ignore-checks X --other-flag <files>` works only because the next flag terminates
    // the variadic consumption -- i.e. correct by accident, and one reordering away from
    // silently checking nothing. Files-first is the only form that cannot break.
    const src = fs.readFileSync(scriptPath, 'utf8');
    const invocation = src.slice(src.indexOf('cfn-lint "${TEMPLATES[@]}"'));
    expect(invocation).toContain('cfn-lint "${TEMPLATES[@]}"');
    const filesAt = invocation.indexOf('"${TEMPLATES[@]}"');
    const ignoreAt = invocation.indexOf('--ignore-checks');
    expect(filesAt).toBeGreaterThanOrEqual(0);
    expect(ignoreAt).toBeGreaterThan(filesAt);
  });

  it('fails loudly rather than passing when it has linted nothing', () => {
    // Both silent-pass routes are closed: an empty glob, and cfn-lint being handed no files.
    const src = fs.readFileSync(scriptPath, 'utf8');
    expect(src).toContain('None:1:1');
    expect(src).toMatch(/no \*\.template\.json found/);
    // ...and it must not hard-fail merely because the tool is missing, which would break
    // any CI image without cfn-lint and block deploys for a lint tool.
    expect(src).toContain('CFN_LINT_REQUIRED');
  });

  it('suppresses only the justified cfn-lint check', () => {
    // E3018 is a linter schema gap for AWS::ARCRegionSwitch::Plan's ReportConfiguration:
    // the identical shape reached CREATE_COMPLETE on 2026-08-29. Keep this list short --
    // a growing ignore list is how a gate stops gating.
    const src = fs.readFileSync(scriptPath, 'utf8');
    const line = src.split('\n').find((l) => l.startsWith('IGNORE_CHECKS='));
    expect(line).toBe('IGNORE_CHECKS="E3018"');
  });
});

describe('stack-output dotenv is safe to source', () => {
  // These files are consumed by `. dist/<stack>.env` in later deploy phases. An unquoted
  // value containing a shell metacharacter is EXECUTED, not assigned. Proven live on
  // 2026-08-31: the failover stack's PlanHealthChecks output used '|' separators, and
  // sourcing it produced
  //   dist/eks-mr-demo-failover.env: line 3: Z10195162...:us-west-2:808a9bb3...:
  //   command not found
  // which failed the deploy at the NEXT phase (standbyaccess), with an error naming a
  // health check id and no hint that quoting was the cause.
  const scriptPath = path.join(__dirname, '..', 'build', 'deploy-stack.sh');

  it('quotes every output value with shlex.quote', () => {
    const src = fs.readFileSync(scriptPath, 'utf8');
    expect(src).toContain('shlex.quote(value)');
    expect(src).toContain('import json, os, shlex, sys');
    // The unquoted form must not survive anywhere.
    expect(src).not.toMatch(/print\(f'\{key\}=\{value\}'\)/);
  });

  it('a value full of shell metacharacters survives a real source round-trip', () => {
    // Run the ACTUAL generator out of the script rather than a copy of it, so this test
    // cannot pass against a stale duplicate of the logic.
    const src = fs.readFileSync(scriptPath, 'utf8');
    const gen = src.slice(
      src.indexOf('import json, os, shlex, sys'),
      src.indexOf("print(f'{key}={shlex.quote(value)}')") +
        "print(f'{key}={shlex.quote(value)}')".length,
    );
    expect(gen).toContain('shlex.quote');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-'));
    const pyPath = path.join(dir, 'gen.py');
    // Un-escape the \$ and \` the surrounding double-quoted heredoc needs in the .sh file.
    fs.writeFileSync(pyPath, gen.replace(/\\\$/g, '$').replace(/\\`/g, '`'));

    const nasty = 'ZONE:app.example.internal:us-west-2:abc|ZONE:app:us-east-2:def';
    const withSpaces = "a b;c&d$(echo hi)`echo no`'quoted'";
    const jsonIn = JSON.stringify([
      { OutputKey: 'PlanHealthChecks', OutputValue: nasty },
      { OutputKey: 'Nasty', OutputValue: withSpaces },
    ]);
    const envPath = path.join(dir, 'out.env');
    execSync(`python3 ${pyPath} > ${envPath}`, {
      input: jsonIn,
      env: { ...process.env, OUTPUTS_PREFIX: 'FAILOVER' },
    });

    // Sourcing must succeed AND preserve both values byte-for-byte.
    const readBack = execSync(
      `set -euo pipefail; . ${envPath}; printf '%s\\n%s' "$FAILOVER_PLANHEALTHCHECKS" "$FAILOVER_NASTY"`,
      { shell: '/bin/bash', encoding: 'utf8' },
    );
    expect(readBack).toBe(`${nasty}\n${withSpaces}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the PlanHealthChecks output does not use a shell-metacharacter separator', () => {
    // Belt to the shlex braces: keep the value safe even where quoting is not applied.
    const t = synthAll().get(`${APP_ID}-${FAILOVER_SUFFIX}`)!;
    const out = (
      t as unknown as { toJSON(): { Outputs: Record<string, { Value: unknown }> } }
    ).toJSON().Outputs.PlanHealthChecks;
    const joined = JSON.stringify(out.Value);
    expect(joined).toContain('Fn::Join');
    expect(joined).not.toContain('"|"');
    expect(joined).toContain('","');
  });
});

describe('replica reporter (cockpit replicas tile)', () => {
  const manifest = fs.readFileSync(path.join(__dirname, '..', APP_MANIFEST), 'utf8');
  // The reporter's own manifest section, so RBAC assertions cannot accidentally pass
  // against some other Role in the file.
  const reporterSection = manifest.slice(manifest.indexOf('name: replica-reporter'));

  test('every region has the CloudWatch METRICS endpoint, distinct from logs', () => {
    for (const region of REGIONS) {
      const t = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const services = Object.values(t.findResources('AWS::EC2::VPCEndpoint')).map((e) =>
        JSON.stringify(e.Properties.ServiceName),
      );
      // `.monitoring` is the metrics API. Without it the reporter's PutMetricData from
      // the isolated subnets hangs as a connect timeout: the CronJob goes red while
      // every stack stays green — the same healthy-looking-and-useless failure as the
      // Secrets Manager endpoint this VPC has already produced.
      expect(services.some((s) => s.includes('.monitoring'))).toBe(true);
    }
  });

  test('PutMetricData is namespace-conditioned on BOTH node roles, never bare', () => {
    for (const region of REGIONS) {
      const t = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const policies = Object.values(t.findResources('AWS::IAM::Policy'));
      const carriers: string[] = [];
      for (const p of policies) {
        for (const st of p.Properties.PolicyDocument.Statement as any[]) {
          const actions = JSON.stringify(st.Action ?? '');
          if (!actions.includes('cloudwatch:PutMetricData')) continue;
          carriers.push(JSON.stringify(p.Properties.Roles));
          // PutMetricData declares NO resource type (same family as fis:ListExperiments)
          // so '*' is the only legal resource — the confinement is the namespace
          // condition. Dropping it would let any pod on the node write into ANY metric
          // namespace, silently corrupting the availability tiles the demo story hangs on.
          expect(st.Condition?.StringEquals?.['cloudwatch:namespace']).toBe('MyResilienceDemo');
        }
      }
      // The MNG node role AND the Karpenter node role: the reporter pod schedules
      // wherever there is room, and a grant on only one role fails exactly when ARC
      // scale-up puts the pod on a surge node — mid-failover, the worst time.
      expect(carriers.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('the reporter CronJob reuses the app image and the app region placeholders', () => {
    // A new image would need its own mirror step (airgapped pulls — bug class 10);
    // reusing ${APP_IMAGE_URI} means the existing placeholder-contract test also covers
    // the reporter's substitutions.
    expect(reporterSection).toContain('kind: CronJob');
    expect(reporterSection).toContain('image: ${APP_IMAGE_URI}');
    expect(reporterSection).toContain('value: "${APP_REGION}"');
  });

  test('the reporter RBAC is read-only: get on deployments, nothing else', () => {
    const roleBlock = reporterSection
      .slice(reporterSection.indexOf('kind: Role\n'))
      .split('---')[0];
    expect(roleBlock).toContain('verbs: ["get"]');
    // The reporter must never become a lever. These are the verbs that would turn a
    // metrics read into a scaling control with the node role's credentials.
    for (const verb of ['create', 'update', 'patch', 'delete', 'scale', '"*"']) {
      expect(roleBlock).not.toContain(verb);
    }
  });

  test('the reporter script pins botocore timeouts and survives render-manifest', () => {
    const script = reporterSection
      .slice(reporterSection.indexOf('report.py: |'))
      .split('---')[0];
    // Bug class 2: a hanging PutMetricData must die inside activeDeadlineSeconds, not
    // outlive it. Default botocore timeouts defeat that.
    expect(script).toContain('connect_timeout');
    expect(script).toContain('read_timeout');
    // render-manifest.py substitutes ${...} placeholders THROUGH the ConfigMap body.
    // Any `${` inside the python source would be rewritten or rejected — so the script
    // must not contain one. (The CronJob's own ${APP_IMAGE_URI}/${APP_REGION} sit in a
    // LATER document, past the `---` this slice stops at.)
    expect(script).not.toContain('${');
  });

  test('CronJob history is capped and runs cannot pile up', () => {
    expect(reporterSection).toContain('concurrencyPolicy: Replace');
    expect(reporterSection).toContain('activeDeadlineSeconds: 50');
    expect(reporterSection).toContain('backoffLimit: 0');
  });
});

describe('AWS Load Balancer Controller install (single-AZ / zonal-shift feature)', () => {
  const tasks = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
  ) as { tasks: Record<string, { steps?: { exec?: string }[] }> };
  const allExecs = Object.values(tasks.tasks)
    .flatMap((t) => t.steps ?? [])
    .map((s) => s.exec ?? '');

  test('the app manifest list still applies namespaces FIRST', () => {
    // Bug class 9 -- `kubectl apply -f` on a concatenated manifest applies documents IN ORDER
    // and does not sort by kind, so a namespaced resource ahead of its Namespace fails.
    //
    // The LBC manifest was REMOVED from this list, deliberately: see the failurePolicy: Fail
    // reasoning in the test below. Its own ordering requirement -- cert generated, caBundle
    // injected, controller Ready, all BEFORE the app Service is created -- belongs to the
    // separate installer pass, and is NOT expressible against this concatenated list.
    const renderLists = allExecs.filter(
      (e) => e.includes('k8s/namespaces.yaml') && e.includes('k8s/app.yaml'),
    );
    expect(renderLists.length).toBeGreaterThan(0);
    for (const full of renderLists) {
      const list = full.slice(full.indexOf('k8s/namespaces.yaml'));
      expect({ nsFirst: list.indexOf('k8s/namespaces.yaml') < list.indexOf('k8s/app.yaml') })
        .toEqual({ nsFirst: true });
    }
  });

  test('every LBC placeholder the manifest uses is supplied by a deploy step', () => {
    // A placeholder the manifest needs but no step supplies fails at DEPLOY, not at build:
    // render-manifest.py aborts on an unresolved placeholder several phases into a live
    // deploy (AGENTS.md bug class 4). Derived from the manifest itself, so adding a
    // placeholder without threading it turns the gate red.
    const manifest = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lbc', 'lbc.yaml'), 'utf8');
    const needed = [...new Set(
      [...manifest.matchAll(/\$\{(LBC_[A-Z0-9_]+)\}/g)].map((m) => m[1]),
    )].sort();
    // The render script sets five; all must appear in the manifest and be supplied.
    expect(needed.length).toBeGreaterThan(0);
    const supplied = allExecs.filter((e) => e.includes('render-manifest.py')).join('\n')
      + allExecs.join('\n');
    for (const name of needed) {
      expect({ name, supplied: supplied.includes(`${name}=`) || supplied.includes(name) })
        .toEqual({ name, supplied: true });
    }
  });

  test('the controller IRSA role pins sub AND aud, and reuses the cluster OIDC provider', () => {
    // A StringLike `sub` would let ANY service account in the cluster assume a role that can
    // create and delete load balancers and rewrite target groups — including the app's own
    // front door. And a SECOND CfnOIDCProvider for the same issuer URL fails the deploy with
    // EntityAlreadyExists, which reads as a stack-naming problem rather than a duplicate.
    for (const [stackName, template] of regionStacks()) {
      const providers = template.findResources('AWS::IAM::OIDCProvider');
      expect({ stackName, providers: Object.keys(providers).length })
        .toEqual({ stackName, providers: 1 });

      const roles = Object.values(template.findResources('AWS::IAM::Role'))
        .filter((r) => JSON.stringify(r.Properties?.AssumeRolePolicyDocument ?? {})
          .includes('sts:AssumeRoleWithWebIdentity'));
      const lbcRole = roles.find((r) =>
        JSON.stringify(r.Properties?.RoleName ?? '').includes('lbc-controller'));
      expect({ stackName, lbcRole: lbcRole !== undefined })
        .toEqual({ stackName, lbcRole: true });
      const trust = JSON.stringify(lbcRole!.Properties!.AssumeRolePolicyDocument);
      expect({ stackName, stringEquals: trust.includes('StringEquals') })
        .toEqual({ stackName, stringEquals: true });
      expect({ stackName, stringLike: trust.includes('StringLike') })
        .toEqual({ stackName, stringLike: false });
    }
  });

  test('NO vendored manifest commits private key material', () => {
    // ARCC SAX-02 Outcome 3 lists "Storing certificates and private keys in version control
    // systems" as its FIRST common pitfall; SAX-05 Outcome 2 requires secrets live in Secrets
    // Manager or KMS and "never hardcode in source code".
    //
    // This is not hypothetical here. The LBC chart's `genSelfSignedCert` bakes a REAL 2240-byte
    // private key into an aws-load-balancer-tls Secret. src/lbc/render.sh strips it, because
    // committing it would be a ONE-WAY DOOR: git history is not revocable, and this repo is
    // shared. The other vendored manifests commit only EMPTY Secret shells, so a key here would
    // have been the repo's first — an earlier draft of render.sh claimed the opposite.
    const vendored = [
      ['src', 'lbc', 'lbc.yaml'],
      ['src', 'karpenter', 'karpenter.yaml'],
      ['src', 'argo', 'argocd-install.yaml'],
      ['src', 'argo', 'metrics-server.yaml'],
    ];
    for (const parts of vendored) {
      const file = path.join(...parts);
      const text = fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
      // PEM key blocks, in any of their forms.
      expect({ file, pem: /BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY/.test(text) })
        .toEqual({ file, pem: false });
      // And no populated tls.key in any Secret — base64 hides the PEM header.
      for (const doc of text.split('\n---\n')) {
        const m = doc.match(/tls\.key:\s*(\S+)/);
        expect({ file, populatedTlsKey: m !== null && m[1].replace(/["']/g, '').length > 0 })
          .toEqual({ file, populatedTlsKey: false });
      }
    }
  });

  test('the LBC manifest gets its OWN pass, and the installer generates the cert', () => {
    // The service webhook is failurePolicy: Fail and its caBundle is BLANKED at render time
    // (no key material in git -- ARCC SAX-02 Outcome 3). A webhook registered with a blank CA
    // makes EVERY Service create in the cluster fail, so the installer must generate the cert,
    // create the Secret, apply this manifest, patch the caBundle and WAIT -- all before the app
    // manifest. None of that is visible to synth: the template is identical either way.
    const installer = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'app-installer.ts'), 'utf8');
    // Cert generated in-cluster, not committed.
    expect(installer).toContain('openssl req -x509');
    expect(installer).toContain('create secret generic aws-load-balancer-tls');
    // BOTH webhook kinds get the CA. Patching only the mutating one leaves the validating
    // webhook failing closed, which reads as a broken controller rather than a missing CA.
    expect(installer).toContain('mutatingwebhookconfiguration validatingwebhookconfiguration');
    // The patch targets the EXACT configuration name, DERIVED from the vendored manifest --
    // not discovered by grepping. The first version grepped configuration NAMES for
    // elbv2.k8s.aws, which appears only in the webhook ENTRIES inside them: zero matches,
    // || true swallowed it, zero patches, and the blank-caBundle Fail-policy webhook blocked
    // every Service create in the cluster right after the D6 migration had deleted
    // orders-api. Full primary outage, live, 2026-09-02 12:11 UTC -- and this test was green
    // through all of it because it pinned the loop's PRESENCE, not that its selector
    // selected anything.
    const lbcDocs = fs.readFileSync(path.join(__dirname, '..', 'src', 'lbc', 'lbc.yaml'), 'utf8')
      .split(/^---$/m).filter((d) => d.includes('WebhookConfiguration'));
    expect(lbcDocs).toHaveLength(2); // one Mutating + one Validating
    const cfgNames = new Set(lbcDocs.map((d) => {
      const m = d.match(/^metadata:\n(?:.*\n)*?\s{2}name:\s*(\S+)/m);
      return m ? m[1] : '(no name)';
    }));
    expect(cfgNames.size).toBe(1); // both kinds share one name; the installer pins it
    const cfgName = [...cfgNames][0];
    expect(installer).toContain(`WEBHOOK_CFG=${cfgName};`);
    // No name-grep discovery, and nothing swallows a failed selection.
    expect(installer).not.toContain('grep elbv2.k8s.aws || true');
    // Fail-loud: an empty selection or an incomplete patch must kill the deploy HERE, not
    // surface three phases later as an unknown-authority error on an unrelated apply.
    expect(installer).toContain('the caBundle patch would patch NOTHING');
    expect(installer).toContain('caBundle patch INCOMPLETE');
    // RESTART before the wait: on a re-run the Secret is recreated with a NEW cert but the
    // deployment spec is unchanged, so already-Available pods keep serving the OLD cert and
    // rollout status returns instantly -- the same unknown-authority failure, as a race.
    expect(installer).toContain('rollout restart deploy/aws-load-balancer-controller');
    expect(installer.indexOf('rollout restart deploy/aws-load-balancer-controller'))
      .toBeLessThan(installer.indexOf('rollout status deploy/aws-load-balancer-controller'));
    // The WAIT is the point: apply returning is not the webhook being ready to inject, and
    // loadBalancerClass is immutable after create.
    expect(installer).toContain('rollout status deploy/aws-load-balancer-controller');
    // And it must run BEFORE the main manifest is fetched.
    expect(installer.indexOf('LBC_MANIFEST_S3_URI'))
      .toBeLessThan(installer.indexOf('aws s3 cp \"$MANIFEST_S3_URI\"'));
    // The deploy task uploads it separately and passes the override.
    const joined = allExecs.join('\n');
    expect(joined).toContain('name=LBC_MANIFEST_S3_URI');
    expect(joined).toContain('dist/lbc-');
  });

  test('the LBC manifest is NOT in the CONCATENATED manifest render list', () => {
    // The distinction that matters: appearing in the same deploy COMMAND is fine (it is
    // rendered and uploaded separately), but appearing in the same `render-manifest.py <list>`
    // that produces manifest-<region>.yaml would concatenate it with the app Service. That
    // registers a failurePolicy: Fail webhook holding a blank caBundle, and every Service
    // create in the cluster -- including the app's own, later in the same file -- fails.
    //
    // Asserted against the render-manifest.py ARGUMENT LIST, not the whole exec string: the
    // cruder form passed for the wrong reason once the separate upload landed.
    const renderCalls = allExecs
      .join('\n')
      .split('\n')
      .flatMap((line) => [...line.matchAll(/render-manifest\.py ([^>]+)>/g)])
      .map((m) => m[1].trim());
    expect(renderCalls.length).toBeGreaterThan(0);
    const appLists = renderCalls.filter((l) => l.includes('k8s/app.yaml'));
    expect(appLists.length).toBeGreaterThan(0);
    for (const list of appLists) {
      expect({ list, hasLbc: list.includes('src/lbc/lbc.yaml') })
        .toEqual({ list, hasLbc: false });
    }
    // And it IS rendered, on its own.
    expect(renderCalls.some((l) => l.trim() === 'src/lbc/lbc.yaml')).toBe(true);
  });

  test('the vendored controller policy drops the Ingress-only services', () => {
    // The upstream policy grants 80 actions across 8 services. This demo exposes the app with
    // a Service of type LoadBalancer (an NLB) — no Ingress, no ACM certificate, no Cognito
    // auth, no WAF or Shield association — so one WHOLE upstream statement was removed rather
    // than individual actions picked out of it. Pinned both ways: the five services must be
    // absent, and the statement count must match, so an upstream re-fetch that silently
    // reinstates them fails the build instead of quietly widening the role.
    const policy = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lbc', 'iam_policy.json'), 'utf8'),
    ) as { Statement: { Action: string | string[] }[] };
    const actions = policy.Statement.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action]);
    const services = [...new Set(actions.map((a) => a.split(':')[0]))].sort();
    expect(services).toEqual(['ec2', 'elasticloadbalancing', 'iam']);
    expect(policy.Statement.length).toBe(15);
    // The elasticloadbalancing actions are the reason the role exists at all — a policy that
    // lost them would leave a controller that starts cleanly and never provisions anything.
    expect(actions).toContain('elasticloadbalancing:CreateTargetGroup');
    expect(actions).toContain('elasticloadbalancing:RegisterTargets');
  });
});

describe('three replicas one per AZ, with graceful termination (single-AZ feature)', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'k8s', 'app.yaml'), 'utf8');
  const docs = app.split('\n---\n');
  const deployment = docs.find((d) => /^kind: Deployment$/m.test(d) && d.includes('orders-api'))!;
  const service = docs.find((d) => /^kind: Service$/m.test(d) && d.includes('orders-api'))!;
  const hpa = docs.find((d) => d.includes('kind: HorizontalPodAutoscaler'))!;
  const namespaces = fs.readFileSync(
    path.join(__dirname, '..', 'k8s', 'namespaces.yaml'), 'utf8');

  test('the replica floor is 3 in BOTH the Deployment and the HPA', () => {
    // Two replicas cannot cover three AZs: at least one AZ holds no pod, and under
    // target-type: ip an AZ with no pods has NO TARGETS — the NLB excludes it, a single-AZ
    // fault aimed there acts on nothing, and a shift away from it changes nothing measurable.
    //
    // BOTH matter. Left at minReplicas 2, a quiet period lets the HPA drop a pod and silently
    // empty one AZ, and the next fault aimed there injects cleanly and moves no graph.
    expect(deployment).toMatch(/^  replicas: 3$/m);
    expect(hpa).toMatch(/^  minReplicas: 3$/m);
  });

  test('pods are spread by ZONE, not only by node', () => {
    // topologyKey: kubernetes.io/hostname guarantees three different NODES and says NOTHING
    // about AZs. Nodes exist in all three AZs here, so all three pods could legally land in
    // ONE AZ and satisfy the anti-affinity completely — two AZs with no targets and the
    // single-AZ story untellable, with nothing failing.
    expect(deployment).toContain('topologySpreadConstraints');
    expect(deployment).toContain('topologyKey: topology.kubernetes.io/zone');
    // DoNotSchedule: ScheduleAnyway would silently degrade to all-in-one-AZ under capacity
    // pressure, and the demo would look correct while measuring something else.
    expect(deployment).toContain('whenUnsatisfiable: DoNotSchedule');
    // The node-scoped rule stays — the two are complementary, not alternatives.
    expect(deployment).toContain('topologyKey: kubernetes.io/hostname');
  });

  test('pod shutdown is drained, and the drain fits inside the grace period', () => {
    // Under target-type: ip the POD is the target, so its shutdown is part of the traffic
    // path. Without a preStop pause the pod stops accepting connections while the NLB is still
    // sending it traffic, and those failures land on the per-AZ chart looking exactly like the
    // injected fault.
    expect(deployment).toContain('preStop');
    const sleep = deployment.match(/sleep (\d+)/);
    expect(sleep).not.toBeNull();
    const grace = deployment.match(/^      terminationGracePeriodSeconds: (\d+)$/m);
    expect(grace).not.toBeNull();
    // A preStop longer than the grace period means SIGKILL lands mid-drain, which is worse
    // than not sleeping at all.
    expect({ sleep: +sleep![1], grace: +grace![1], fits: +sleep![1] < +grace![1] })
      .toEqual({ sleep: +sleep![1], grace: +grace![1], fits: true });
  });

  test('the target group deregistration delay is bounded well under the NLB default', () => {
    // THE DEFAULT IS THE DEFECT: an NLB target group drains for 300 SECONDS unset. At
    // maxUnavailable 1 of three replicas one-per-AZ, every pod replacement would park an
    // entire AZ's worth of targets in draining for five minutes — on the very chart the AZ
    // story is read from. A rollout would present as a partial zonal outage.
    const m = service.match(/deregistration_delay\.timeout_seconds=(\d+)/);
    expect(m).not.toBeNull();
    expect({ delay: +m![1], bounded: +m![1] <= 30 }).toEqual({ delay: +m![1], bounded: true });
  });

  test('the demo namespace opts in to the readiness gate, with the webhook-verified label', () => {
    // The label literal is read from the webhook's OWN namespaceSelector in the vendored
    // manifest, not from documentation — that is the selector the webhook actually evaluates.
    // A near-miss spelling means the gate is never injected, pods go Ready before the NLB has
    // registered them, and a rollout drops requests with nothing reporting an error.
    const selectorKey = 'elbv2.k8s.aws/pod-readiness-gate-inject';
    const lbc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lbc', 'lbc.yaml'), 'utf8');
    expect(lbc).toContain(selectorKey); // the webhook still selects on it at this chart version
    // Derived, not duplicated: the namespace must carry the key the webhook selects on.
    const demoDoc = namespaces.split('\n---\n').find((d) => /name: demo$/m.test(d))!;
    expect(demoDoc).toContain(`${selectorKey}: enabled`);
    // The argocd namespace must NOT opt in: its Service stays in-tree and gating its pods on
    // an ELB target-group condition would leave them un-Ready forever.
    const argoDoc = namespaces.split('\n---\n').find((d) => /name: argocd$/m.test(d))!;
    expect(argoDoc).not.toContain(selectorKey);
  });

  test('the probes stay DATABASE-FREE — a documented divergence from SMRMS-APP-005', () => {
    // SMRMS-APP-005 asks for dependency-aware readiness. That is right for a production
    // service and WRONG here, and the code says why (src/app/server.py): failing the probes
    // would pull every pod out of the target group and turn a GRAY failure into a hard
    // outage — the opposite of what this demo demonstrates. The pattern's own listed blind
    // spot ("health endpoints prove only that the process responds") is a FEATURE here.
    //
    // This guard exists so nobody later "fixes" the probes and silently converts the demo's
    // central mechanism into a conventional outage. The readiness GATE is the correct place
    // for external dependency signal, and it is added at the namespace instead.
    const server = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'app', 'server.py'), 'utf8');
    const health = server.slice(server.indexOf('/health'), server.indexOf('/health') + 1200);
    for (const dbCall of ['read_connection', 'write_connection', 'sp_query_orders']) {
      expect({ dbCall, inHealthPath: health.includes(dbCall) })
        .toEqual({ dbCall, inHealthPath: false });
    }
    // And the probes still target /health, not a new dependency-aware path.
    expect(deployment).toContain('path: /health');
  });
});

describe('Service migration to ip targets (D6 — Argo is the other writer)', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'k8s', 'app.yaml'), 'utf8');
  const svc = app.split('\n---\n').find(
    (d) => /^kind: Service$/m.test(d) && d.includes('orders-api'))!;
  const argoApp = fs.readFileSync(
    path.join(__dirname, '..', 'k8s', 'argo-application.yaml'), 'utf8');
  const installer = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'cdk', 'lib', 'app-installer.ts'), 'utf8');

  /** YAML with comment lines removed.
   *
   *  REQUIRED for any not-toContain assertion against a manifest. The comments in these files
   *  deliberately NAME the wrong values they exist to warn about -- an invented annotation, a
   *  prerequisite-violating attribute -- so a naive substring check matches the explanation
   *  rather than the configuration and fails for the wrong reason. This repo already carries the
   *  same lesson in a comment-stripped SQL test (AGENTS.md bug class 16). */
  const stripComments = (y: string): string =>
    y.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const svcConfig = stripComments(svc);

  test('the Service is LBC-managed with ip targets, cross-zone and zonal shift', () => {
    // Each of these is load-bearing and each is invisible to synth — Kubernetes owns this
    // object, so CloudFormation reports success either way.
    expect(svc).toContain('loadBalancerClass: service.k8s.aws/nlb');
    // `external` = the LBC. The legacy `nlb` meant the IN-TREE controller, which cannot enable
    // any of the three attributes below.
    expect(svc).toContain('aws-load-balancer-type: "external"');
    // ip targets: with `instance` targets, draining an AZ at the load balancer just makes
    // kube-proxy hop to a pod in another AZ, so a shift reports ACTIVE and moves nothing.
    expect(svc).toContain('aws-load-balancer-nlb-target-type: "ip"');
    // BOTH attributes in ONE annotation — they are both load-balancer attributes. An earlier
    // draft invented a separate `...-attributes-zonal-shift-config` annotation, which does not
    // exist; an unknown annotation is silently IGNORED, so the NLB would come up without the
    // opt-in and StartZonalShift would fail with ResourceNotFound.
    const attrs = svc.match(/aws-load-balancer-attributes: (\S+)/);
    expect(attrs).not.toBeNull();
    expect(attrs![1]).toContain('load_balancing.cross_zone.enabled=true');
    expect(attrs![1]).toContain('zonal_shift.config.enabled=true');
    expect(svcConfig).not.toContain('attributes-zonal-shift-config');
  });

  test('the documented zonal-shift prerequisite is EXPLICITLY satisfied', () => {
    // Per "Enable zonal shift for your Network Load Balancer": with cross-zone enabled, every
    // attached target group must have connection termination for unhealthy targets DISABLED.
    //
    // THE FIRST VERSION OF THIS TEST GUARDED NOTHING. It claimed disabled was the NLB default
    // and asserted the ABSENCE of `deregistration_delay.connection_termination.enabled` -- a
    // key that DOES NOT EXIST. Both halves were wrong: the NLB docs say "Connection
    // termination is enabled by default", and the real attribute is
    // target_health_state.unhealthy.connection_termination.enabled. The LBC created the
    // target group with the enabled default and CreateListener was rejected LIVE
    // (2026-09-02 12:49, "not compatible with zonal shift") while this test was green --
    // the fourth green-for-the-wrong-reason in this feature, and the second to reach the
    // cluster. The disable must be EXPLICIT in the target-group attributes.
    const tgAttrs = svc.match(/aws-load-balancer-target-group-attributes: (\S+)/);
    expect(tgAttrs).not.toBeNull();
    expect(tgAttrs![1])
      .toContain('target_health_state.unhealthy.connection_termination.enabled=false');
    // Protocol must be TCP or TLS, and the target type must not be alb. Both hold here.
    expect(svc).toContain('protocol: TCP');
  });

  test('the brownout gray window exists: HTTP health checks + client-IP preservation pinned off', () => {
    // BROWNOUT FEATURE (design D2/D3, phase3 R1/R4). Two Service-side facts make the gray
    // fault possible, and both are invisible to synth -- Kubernetes owns this object.
    //
    // (1) HTTP health checks on /health. This pins the CHECK'S OWN CONTRACT, and since
    // 2026-09-04 it is a contract about the check STAYING GREEN, not failing: at 800ms
    // +/- 400ms the check's single shaped hop tops out ~1.24s against the 2s timeout, so
    // 3/3 targets held healthy through both live runs. The path matters more than the
    // timeout here -- /health makes no database call, so a DB-path fault cannot pull a
    // degraded pod out of the target group and turn gray into connection refusals. A TCP
    // check would give the same green verdict for the wrong reason (a handshake cannot be
    // failed by latency below absurdity), which is why the protocol is still pinned.
    const hc = (k: string) => {
      const m = svcConfig.match(new RegExp(`aws-load-balancer-healthcheck-${k}: "([^"]+)"`));
      return m && m[1];
    };
    expect(hc('protocol')).toBe('HTTP');
    expect(hc('path')).toBe('/health');
    expect(hc('interval')).toBe('10');
    expect(hc('healthy-threshold')).toBe('3');
    expect(hc('unhealthy-threshold')).toBe('3');
    expect(hc('success-codes')).toBe('200');
    // The LBC docs claim this annotation is IGNORED ("the controller currently ignores
    // the timeout configuration"); our vendored LBC HONORS it -- the deployed TG read
    // timeout=2s (live, 2026-09-03). Severity (800ms) is calibrated against THAT 2s,
    // and T6 pins the pairing.
    expect(hc('timeout')).toBe('2');

    // (2) preserve_client_ip pinned FALSE -- the scoping mechanism itself. With it off,
    // EVERY pod response (health checks AND client data) is addressed to the NLB's ENI
    // IPs, so the brownout's single Sources entry shapes exactly the pod<->NLB path and
    // the DB path (same subnets -- CIDR exclusion impossible) is untouched. false is the
    // LBC default for ip targets TODAY (read live 2026-09-02); pinned so a default change
    // cannot silently re-scope the fault. Same ONE-annotation rule as the other TG attrs.
    const tgAttrs = svcConfig.match(/aws-load-balancer-target-group-attributes: (\S+)/);
    expect(tgAttrs![1]).toContain('preserve_client_ip.enabled=false');
  });

  test('the app pod tolerates unreachable/not-ready for the FULL power-fault window', () => {
    // Live finding 2026-09-02 21:24-21:40 UTC: at ~5 min the default 300s tolerations let
    // taint eviction kill the faulted AZ's pod, DEREGISTERING its target -- the chart line
    // GAPPED (no targets = no data) instead of holding at 0 for the full 15-minute fault.
    // 900s > 15 min keeps the pod registered-unhealthy for the whole black window. The
    // BROWNOUT never taints the node at all (kubelet Lease rides on seconds of delay), so
    // this only changes the black beat's shape.
    const dep = app.split('\n---\n').find(
      (d) => /^kind: Deployment$/m.test(d) && d.includes('orders-api'))!;
    const depConfig = stripComments(dep);
    for (const taint of ['node.kubernetes.io/unreachable', 'node.kubernetes.io/not-ready']) {
      expect(depConfig).toContain(`key: ${taint}`);
    }
    expect(depConfig.match(/tolerationSeconds: 900/g)?.length).toBe(2);
    // NoExecute is the effect these taints evict with -- tolerating a different effect
    // would leave the 300s defaults in force while this test stayed green.
    expect(depConfig.match(/effect: NoExecute/g)?.length).toBe(2);
  });

  test('Argo ignores only CONTROLLER-written Service fields, never the spec', () => {
    // The Service is inside the Argo-managed chart and the Application has selfHeal: true, so
    // the LBC's writes look like drift. Excluding them stops Argo churning an object whose
    // loadBalancerClass is immutable — churn there means tearing the NLB down and recreating
    // it repeatedly, which on the chart reads as intermittent zonal outages.
    // Parsed by structure rather than with a YAML library: this file has no yaml import and
    // adding a dependency for one assertion is not worth it. Each entry is delimited by its
    // `- group:` line, so slicing between them is unambiguous.
    const entries = argoApp
      .slice(argoApp.indexOf('ignoreDifferences:'))
      .split(/\n    - group:/)
      .slice(1);
    const svcEntry = entries.find((e) => /kind: Service/.test(e));
    expect(svcEntry).toBeDefined();
    const pointersOf = (entry: string): string[] =>
      [...entry.matchAll(/^\s+- (\/\S+)$/gm)].map((m) => m[1]).sort();
    expect(pointersOf(svcEntry!)).toEqual(['/metadata/finalizers', '/status/loadBalancer']);
    // The spec is the DESIRED state and Argo must keep enforcing it. Excluding /spec would let
    // the live Service drift away from ip targets with Argo still reporting Synced.
    for (const ptr of pointersOf(svcEntry!)) {
      expect({ ptr, excludesSpec: ptr.startsWith('/spec') })
        .toEqual({ ptr, excludesSpec: false });
    }
    // And the bug-class-12 HPA path must not have drifted while this list was edited.
    const hpaEntry = entries.find((e) => /kind: HorizontalPodAutoscaler/.test(e))!;
    expect(pointersOf(hpaEntry)).toContain('/spec/behavior/scaleDown/selectPolicy');
    expect(pointersOf(hpaEntry)).not.toContain('/spec/minReplicas');
  });

  test('the installer deletes the old Service CONDITIONALLY, immediately before the apply', () => {
    // loadBalancerClass is IMMUTABLE, so `kubectl apply` of the new spec over the in-tree
    // Service fails with "field is immutable" — server-side apply does not help, because this
    // is immutability rather than a conflict. The Service must be deleted and recreated.
    expect(installer).toContain('kubectl -n demo delete svc orders-api');
    // CONDITIONAL: a one-time migration, not an outage on every deploy. Guarded on the live
    // object already having a loadBalancerClass.
    expect(installer).toContain('jsonpath={.spec.loadBalancerClass}');
    // D6 ORDERING: the delete must sit immediately before the apply that both publishes the new
    // chart and creates the new Service. With selfHeal: true, a gap lets Argo recreate from a
    // CACHED OLD chart version — bringing the in-tree Service back, or leaving two controllers
    // fighting over one object. Neither errors; the migration just silently reverts.
    const deleteAt = installer.indexOf('kubectl -n demo delete svc orders-api');
    const applyAt = installer.indexOf('kubectl apply --server-side --force-conflicts -f /tmp/manifest.yaml');
    expect({ deleteBeforeApply: deleteAt < applyAt }).toEqual({ deleteBeforeApply: true });
    // And after the LBC pass, so the webhook exists to inject the class on recreate.
    const lbcAt = installer.indexOf('LBC_MANIFEST_S3_URI');
    expect({ lbcBeforeDelete: lbcAt < deleteAt }).toEqual({ lbcBeforeDelete: true });
  });
});

describe('cluster-wide pod log shipping (fluent-bit)', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const shipper = () => read('k8s', 'fluent-bit.yaml');
  const namespaces = () => read('k8s', 'namespaces.yaml');

  test('the image is the mirrored ARM64 CHILD digest, matching images.json exactly', () => {
    // THE CROSS-FILE CONTRACT, and AGENTS.md bug class 10. The mirror copies linux/arm64
    // only, which pushes the CHILD manifest -- so the multi-platform INDEX digest never
    // lands in ECR. Referencing the index here would fail as a pull timeout, which reads
    // as a network fault on nodes that genuinely have no internet route. Same shape as the
    // karpenter-controller pin.
    const mirror = JSON.parse(read('src', 'mirror', 'images.json')) as {
      images: Array<{ name: string; tag: string; digest: string; arm64Digest: string }>;
    };
    const entry = mirror.images.find((i) => i.name === 'aws-for-fluent-bit');
    expect(entry).toBeDefined();
    expect(shipper()).toContain(
      `image: \${FLUENTBIT_IMAGE_REPO}:${entry!.tag}@${entry!.arm64Digest}`,
    );
    // Two-sided: the INDEX digest must appear nowhere in the manifest.
    expect(shipper()).not.toContain(entry!.digest);
  });

  test('the shipper namespace is privileged, because baseline FORBIDS hostPath', () => {
    // A log shipper must mount /var/log from the host, and the BASELINE Pod Security
    // Standards profile forbids hostPath volumes -- AWS's EKS guidance says so outright.
    // The `demo` namespace enforces baseline, so placing this DaemonSet there admits the
    // OBJECT and rejects every POD: 0/0 ready, no logs, and no error beyond a pod event,
    // which is indistinguishable from a bad IAM grant. Pin all three halves.
    expect(shipper()).toContain('hostPath:');
    expect(shipper()).toContain('namespace: ${LOGGING_NAMESPACE}');
    // The namespace it names is declared, and declared privileged.
    const loggingDoc = namespaces().slice(namespaces().indexOf('name: logging'));
    expect(loggingDoc).toContain('pod-security.kubernetes.io/enforce: privileged');
    // And it is NOT the baseline-enforcing app namespace.
    expect(shipper()).not.toContain('namespace: ${APP_NAMESPACE}');
  });

  test('the DaemonSet holds NO Kubernetes RBAC at all', () => {
    // ARCC (Aristotle 509 / AWS-446): "Avoid granting DaemonSets excessive cluster-wide
    // Kubernetes permissions. As DaemonSets run on all nodes, a container breakout on any
    // node may allow an attacker to get hold of these permissions." The stock install
    // grants cluster-wide pod read for the `kubernetes` metadata filter; the path-regex
    // parser replaces it, so there is nothing to grant. This is the test that stops a
    // future reader "helpfully" adding the ClusterRole back.
    expect(shipper()).toContain('kind: DaemonSet');
    expect(shipper()).not.toContain('kind: ClusterRole');
    expect(shipper()).not.toContain('kind: ClusterRoleBinding');
    expect(shipper()).not.toContain('kubernetes.io/serviceaccount');
    // No `kubernetes` filter either -- that is the thing that would need the RBAC.
    expect(shipper()).not.toMatch(/Name\s+kubernetes/);
    // The parser that makes that possible must still be wired.
    expect(shipper()).toContain('Parser                k8s_container_path');
  });

  test('log_stream_template respects the record-accessor separator rule', () => {
    // Fluent Bit's record_accessor library can only parse a template where a variable is
    // followed by `.` or `,`. `$namespace-$pod` is silently invalid and falls back to the
    // prefix, collapsing every container into one stream. Dots are load-bearing.
    expect(shipper()).toContain('log_stream_template   $namespace.$pod.$container');
    // A fallback is REQUIRED: the plugin needs log_stream_name or log_stream_prefix set,
    // and a stream under it is the visible signal the path regex stopped matching.
    expect(shipper()).toMatch(/log_stream_prefix\s+unparsed\./);
    // auto_create_group false is what keeps logs:CreateLogGroup out of the role.
    expect(shipper()).toMatch(/auto_create_group\s+false/);
  });

  test('collection is CLUSTER-WIDE and excludes only the shipper itself', () => {
    // The point of cluster-wide is cross-component correlation during a failover: the app's
    // failures, Argo CD's reconciliation and the LBC's target registration in ONE queryable
    // group. A namespace-scoped glob would quietly re-narrow it.
    expect(shipper()).toContain('Path                  /var/log/containers/*.log');
    // Self-exclusion, or the shipper's own stderr becomes its own input and loops.
    expect(shipper()).toMatch(/Exclude_Path\s+\/var\/log\/containers\/fluent-bit-\*/);
    // Path_Key is what feeds the parser that replaces the Kubernetes API.
    expect(shipper()).toContain('Path_Key              file');
  });

  test('the shipper region comes from APP_REGION, never the runner AWS_REGION', () => {
    // render-manifest.py substitutes from os.environ, and AWS_REGION is set there to the
    // PIPELINE RUNNER's region. Using it would point the standby's shipper at the primary
    // region's CloudWatch Logs endpoint -- logs would land in the wrong region's group, or
    // not at all, and the standby is the region ARC switches TO.
    expect(shipper()).toContain('region                ${APP_REGION}');
    expect(shipper()).not.toContain('${AWS_REGION}');
  });

  test('fluent-bit is installed in BOTH regions, not just the primary', () => {
    // The two runInstaller manifest lists genuinely differ (the secondary omits the schema
    // Job), so they are edited independently and a one-line addition lands in one region.
    // The standby is the region ARC switches TO: shipping only there after a failover means
    // the failover itself was never observed.
    const tasksJson = JSON.parse(read('.projen', 'tasks.json')) as {
      tasks: Record<string, { steps?: Array<{ exec?: string }> }>;
    };
    const execs = Object.values(tasksJson.tasks)
      .flatMap((t) => t.steps ?? [])
      .map((s) => s.exec ?? '')
      .filter((e) => e.includes('render-manifest.py'));
    const withShipper = execs.filter((e) => e.includes('k8s/fluent-bit.yaml'));
    expect(withShipper).toHaveLength(2);
    // And it must be applied AFTER the namespaces that declare `logging`, since
    // `kubectl apply -f` on a concatenated manifest does not sort by kind.
    for (const e of withShipper) {
      expect(e.indexOf('k8s/namespaces.yaml')).toBeLessThan(e.indexOf('k8s/fluent-bit.yaml'));
    }
  });

  test('the shipper role can do NOTHING but append to its own log group', () => {
    // The conventional attachment is CloudWatchAgentServerPolicy, which carries
    // logs:CreateLogGroup, cloudwatch:PutMetricData, ec2:DescribeTags and ssm:GetParameter
    // on "*" -- exactly the "excessive AWS permissions on a DaemonSet" shape ARCC warns
    // about. Derived from the SYNTHESIZED template so it fails if the construct widens,
    // and two-sided so it also fails if the grant disappears entirely.
    for (const region of REGIONS) {
      const template = synthAll().get(`${APP_ID}-${regionSuffix(region)}`)!;
      const policies = template.findResources('AWS::IAM::Policy');
      const shipperPolicies = Object.values(policies).filter((p: any) =>
        JSON.stringify(p.Properties?.Roles ?? '').includes('FluentBit'),
      );
      expect(shipperPolicies).toHaveLength(1);
      const statements = shipperPolicies[0].Properties.PolicyDocument.Statement as Array<{
        Action: string | string[];
      }>;
      const actions = statements.flatMap((s) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      );
      expect(actions.sort()).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
      // No managed policy on the role either -- that is the other way the over-grant
      // arrives, and it would not show up in the inline policy above.
      const roles = template.findResources('AWS::IAM::Role');
      const shipperRole = Object.entries(roles).find(([id]) => id.includes('FluentBitShipperRole'));
      expect(shipperRole).toBeDefined();
      expect(shipperRole![1].Properties.ManagedPolicyArns ?? []).toEqual([]);
      // Trust is StringEquals on the exact service account, never StringLike: a wildcard
      // `sub` is a privilege-escalation path out of any compromised pod in the namespace.
      const trust = JSON.stringify(shipperRole![1].Properties.AssumeRolePolicyDocument);
      expect(trust).toContain('StringEquals');
      expect(trust).not.toContain('StringLike');
    }
  });
});
