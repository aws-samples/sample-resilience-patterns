/**
 * Step 12 — the Midway-gated front door (CloudFrontSigner + CloudFront VPC origin).
 *
 * These tests encode the security contract, not just the topology. The front door is
 * only safe because THREE things hold simultaneously: the default behavior requires
 * CFS-signed cookies, the /error/* path does NOT (so the unauthenticated bounce page
 * is servable), and the internet gateway the VPC origins require carries no routes.
 * Any one of them silently wrong is either an exposed distribution or an unreachable
 * one that looks like a backend outage.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { FrontDoorStack } from '../src/cdk/lib/front-door-stack';
import { RegionStack } from '../src/cdk/lib/region-stack';
import { AZ_COUNT, REGIONS, frontDoorSuffix, regionSuffix } from '../src/cdk/regions';
import { makeSynthesizer } from '../src/cdk/synthesizer';

const APP_ID = 'eks-mr-demo';

let cachedFd: Map<string, Template> | undefined;
const frontDoorTemplates = (): Map<string, Template> => {
  if (cachedFd) return cachedFd;
  const app = new cdk.App({ analyticsReporting: false });
  // Construct EVERY stack before the first Template.fromStack: fromStack synthesizes
  // the app, and adding a stack after synth throws ConstructTreeModifiedAfterSynth.
  const stacks = REGIONS.map((region) => {
    const name = `${APP_ID}-${frontDoorSuffix(region)}`;
    return [
      region.name,
      new FrontDoorStack(app, name, {
        stackName: name,
        synthesizer: makeSynthesizer(),
        env: { region: region.name },
        appId: APP_ID,
        regionName: region.name,
      }),
    ] as const;
  });
  cachedFd = new Map(stacks.map(([r, s]) => [r, Template.fromStack(s)]));
  return cachedFd;
};

describe('front door distribution (step 12)', () => {
  it('gates the DEFAULT behavior on the CFS prod trusted signer, in both regions', () => {
    // This is the access control. Without TrustedSigners on the default behavior the
    // distribution serves the Argo UI to anyone on the internet the moment it deploys
    // -- the exact opposite of fail-closed. The account number is CFS PROD
    // (CloudFrontSignerConstructs CONFIGURATION_MAP.PROD); only cookies minted by that
    // account's key pair pass, and CFS mints them only after Midway + a Bindle check.
    for (const [, t] of frontDoorTemplates()) {
      const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0];
      const cfg = dist.Properties.DistributionConfig;
      expect(cfg.DefaultCacheBehavior.TrustedSigners).toEqual(['076938169600']);
      expect(cfg.DefaultCacheBehavior.ViewerProtocolPolicy).toBe('redirect-to-https');
    }
  });

  it('leaves /error/* UNGATED and gates nothing else', () => {
    // The bounce page must be servable to the unauthenticated user the 403 flow
    // exists for -- gating it infinite-loops the redirect. Ungated behaviors are an
    // ALLOWLIST of exactly one pattern: error/*. Any OTHER ungated behavior is an extra
    // hole in the CFS gate.
    //
    // HISTORY: PDD 2026-08-31-chaos-status-page briefly added an ungated /health beacon
    // for the cockpit's active-region pill, and this test was widened to admit it. It was
    // REMOVED after checking the live account: this ALB's default action is the Argo
    // target group, so /health reached argocd-server rather than the app -- an ungated
    // path into the Argo server that answered the wrong question anyway. The pill is now
    // derived from observed traffic (handler.py::_region_traffic). Keep this allowlist at
    // one entry; widening it needs the same scrutiny.
    const UNGATED_ALLOWLIST = new Set(['error/*']);
    for (const [, t] of frontDoorTemplates()) {
      const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0];
      const cfg = dist.Properties.DistributionConfig;
      const behaviors = cfg.CacheBehaviors ?? [];
      const patterns = behaviors.map((b: any) => b.PathPattern).sort();
      expect(patterns).toEqual(['error/*']);
      for (const b of behaviors) {
        expect(UNGATED_ALLOWLIST.has(b.PathPattern)).toBe(true);
        expect(b.TrustedSigners).toBeUndefined();
      }
      // The gate on the DEFAULT behavior is untouched by the cockpit.
      expect(cfg.DefaultCacheBehavior.TrustedSigners).toEqual(['076938169600']);
    }
  });

  it('serves the CFS bounce on 403 without masking the status or caching it', () => {
    for (const [, t] of frontDoorTemplates()) {
      const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0];
      const cfg = dist.Properties.DistributionConfig;
      expect(cfg.CustomErrorResponses).toEqual([
        // ResponseCode stays 403 (not 200) so genuine auth failures do not read as
        // success; ErrorCachingMinTTL 0 so a user returning WITH cookies is not
        // served the stale bounce as the cached response for their original URL.
        { ErrorCode: 403, ResponseCode: 403, ResponsePagePath: '/error/403.html', ErrorCachingMinTTL: 0 },
      ]);
    }
  });

  it('fronts argocd with an internal ALB as the CloudFront VPC origin', () => {
    // WHY AN ALB. AWS: "To be used as a VPC origin, a Network Load Balancer must have a
    // security group attached to it." The in-tree Kubernetes service controller creates
    // NLBs without one, an NLB created without security groups can never be given them,
    // and EKS exposes no cloud-config flag to change that. Live-proven 2026-08-26:
    //   Security group is required. Associate a security group with Network Load Balancer
    // An ALB always has a security group by construction, so the requirement is satisfied
    // trivially rather than worked around.
    //
    // TWO WITHDRAWN DESIGNS, both asserted ABSENT below because both look reasonable:
    //   1. Lambda behind an OAC-signed Function URL. OAC signs SigV4 over the ORIGIN's
    //      host, so ALL_VIEWER -- which this UI wants -- forwards the viewer Host and
    //      invalidates every signature; the URL 403s BEFORE invoking, which reads as an
    //      auth failure rather than a config error. And AWS states Lambda "doesn't support
    //      unsigned payloads" for POST through OAC: the viewer must supply
    //      x-amz-content-sha256, which no browser does, and Argo's API is gRPC-Web over
    //      POST. Live-proven: the proxy logged ZERO invocations.
    //   2. That same Lambda as an ALB target. Worse: 1 MB request AND response caps
    //      (Argo's bundle exceeds it) and "WebSockets are not supported. Upgrade requests
    //      are rejected with an HTTP 400 code."
    for (const [regionName, t] of frontDoorTemplates()) {
      // Neither withdrawn design may creep back.
      expect(Object.keys(t.findResources('AWS::Lambda::Url'))).toHaveLength(0);
      const oacs = Object.values(
        t.findResources('AWS::CloudFront::OriginAccessControl'),
      ) as any[];
      expect(
        oacs.some(
          (o) =>
            o.Properties.OriginAccessControlConfig.OriginAccessControlOriginType === 'lambda',
        ),
      ).toBe(false);

      // The VPC origin is back, and there is exactly one.
      expect(Object.keys(t.findResources('AWS::CloudFront::VpcOrigin'))).toHaveLength(1);

      const albs = Object.values(
        t.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'),
      ) as any[];
      expect(albs).toHaveLength(1);
      const alb = albs[0].Properties;
      expect(alb.Type).toBe('application');
      expect(alb.Scheme).toBe('internal');
      expect(alb.Subnets).toHaveLength(AZ_COUNT);
      expect(JSON.stringify(alb.Subnets)).toContain('IsolatedSubnetIds');
      // Argo's UI holds watch streams open to live-update its resource tree; the 60s
      // default would drop them every minute and the tree would stop moving mid-demo.
      const idle = (alb.LoadBalancerAttributes ?? []).find(
        (a: any) => a.Key === 'idle_timeout.timeout_seconds',
      );
      expect(idle).toBeDefined();
      expect(Number(idle.Value)).toBeGreaterThan(60);

      // IP targets from the installer's NLB ENI addresses -- NOT pod IPs (they change on
      // every restart) and NOT node IPs (Karpenter replaces nodes, and ARC adds more
      // during the failover this demo exists to run).
      const tgs = Object.values(
        t.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'),
      ) as any[];
      // The Argo IP target group is the front door's origin. PDD 2026-08-31 adds a
      // SECOND target group in us-west-2 (the cockpit's LAMBDA target), so select the IP
      // one by type rather than assuming it is the only group.
      const ipTgs = tgs.filter((g) => g.Properties.TargetType === 'ip');
      expect(ipTgs).toHaveLength(1);
      const tg = ipTgs[0].Properties;
      expect(tg.TargetType).toBe('ip');
      expect(tg.Targets).toHaveLength(AZ_COUNT);
      expect(JSON.stringify(tg.Targets)).toContain('ArgoNlbIps');

      // Ingress is the CLOUDFRONT ORIGIN-FACING PREFIX LIST on one port and nothing
      // else. The first deploy used the VPC CIDR and the front door 504'd with
      // RequestCount = 0 on the ALB: VPC-origin traffic does not present a source
      // inside the VPC CIDR. The documented sources are the service-managed
      // CloudFront-VPCOrigins-Service-SG (not expressible at synth time) or this
      // per-region managed prefix list, whose ids are fixed per region.
      const expectedPl = regionName === 'us-east-2' ? 'pl-b6a144df' : 'pl-82a045eb';
      // CDK renders prefix-list peers as a STANDALONE AWS::EC2::SecurityGroupIngress
      // resource, not inline SecurityGroupIngress on the SG -- assert that shape.
      const rules = Object.values(
        t.findResources('AWS::EC2::SecurityGroupIngress'),
      ) as any[];
      const albRules = rules.filter((r) =>
        JSON.stringify(r.Properties.GroupId ?? '').includes('FrontDoorAlbSg'),
      );
      expect(albRules).toHaveLength(1);
      const rule = albRules[0].Properties;
      expect(rule.FromPort).toBe(80);
      expect(rule.ToPort).toBe(80);
      expect(rule.SourcePrefixListId).toBe(expectedPl);
      // The wrong source must not creep back in alongside the right one.
      expect(rule.CidrIp).toBeUndefined();
      // And the ALB SG itself carries NO inline ingress -- the prefix-list rule above
      // is the entire admission set.
      const sgs = Object.values(t.findResources('AWS::EC2::SecurityGroup')) as any[];
      const albSg = sgs.find((s) =>
        (s.Properties.GroupDescription ?? '').includes('argocd front door'),
      );
      expect(albSg).toBeDefined();
      expect(albSg.Properties.SecurityGroupIngress).toBeUndefined();
      // The parameter is gone from the template entirely -- a declared-but-unused
      // VpcCidr would still be threaded by the deploy step (or worse, threaded against
      // a template that no longer declares it, which fails the changeset).
      expect(t.toJSON().Parameters?.VpcCidr).toBeUndefined();
    }
  });

  it('the withdrawn Lambda proxy source is GONE, not merely unreferenced', () => {
    // A dormant handler invites a future session to wire it back up, and the reason it
    // cannot work is a documented AWS constraint rather than a bug someone could fix.
    expect(fs.existsSync(path.join(__dirname, '..', 'src', 'frontdoor', 'proxy'))).toBe(false);
  });

  it('keeps the error bucket private in every dimension', () => {
    for (const [, t] of frontDoorTemplates()) {
      t.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    }
  });
});

describe('the unrouted internet gateway (step 12)', () => {
  // CloudFront VPC origins require an IGW ATTACHED to the VPC -- a static flag
  // CloudFront checks, with traffic never flowing through it. The safety property is
  // that NO route references it: one route to an IGW turns "attached but inert" into
  // "this subnet is public", and the zero-egress posture the whole endpoint
  // architecture is built on quietly ends.
  const regionTemplates = (): Template[] => {
    const app = new cdk.App({ analyticsReporting: false });
    // Construct-all-then-synth, same reason as frontDoorTemplates.
    const stacks = REGIONS.map((region) => {
      const name = `${APP_ID}-${regionSuffix(region)}`;
      return new RegionStack(app, name, {
        stackName: name,
        synthesizer: makeSynthesizer(),
        env: { region: region.name },
        appId: APP_ID,
        regionName: region.name,
        defaultVpcCidr: region.cidr,
        withPrimaryDatabase: region.name === REGIONS[0].name,
        peerVpcCidrs: [],
      });
    });
    return stacks.map((s) => Template.fromStack(s));
  };

  it('attaches exactly one IGW per region VPC, with ZERO routes referencing it', () => {
    for (const t of regionTemplates()) {
      const igws = t.findResources('AWS::EC2::InternetGateway');
      expect(Object.keys(igws)).toHaveLength(1);
      // No route in the template may reference ANY gateway. Asserted over all routes
      // rather than routes-to-this-IGW so a NAT gateway route would fail it too.
      const routes = Object.values(t.findResources('AWS::EC2::Route'));
      const gatewayRoutes = routes.filter((r) => r.Properties?.GatewayId !== undefined);
      expect(gatewayRoutes).toHaveLength(0);
      const nats = t.findResources('AWS::EC2::NatGateway');
      expect(Object.keys(nats)).toHaveLength(0);
    }
  });
});

describe('argocd-config.yaml (step 12)', () => {
  const configYaml = fs.readFileSync(
    path.join(__dirname, '..', 'k8s', 'argocd-config.yaml'),
    'utf8',
  );

  it('populates server.insecure and declares the internal LB Service, nothing else', () => {
    expect(configYaml).toMatch(/^ {2}server\.insecure: "true"$/m);
    // The Service must be INTERNAL and select upstream's server pods.
    expect(configYaml).toMatch(/aws-load-balancer-internal: "true"/);
    expect(configYaml).toMatch(/aws-load-balancer-type: "nlb"/);
    expect(configYaml).toMatch(/app\.kubernetes\.io\/name: argocd-server$/m);
    // Port contract with the FrontDoorStack's http-only:80 VPC origin.
    expect(configYaml).toMatch(/port: 80\n {6}targetPort: 8080/);
    // No Namespace declaration -- k8s/namespaces.yaml is the single owner (the
    // Argo-owned-namespace hazard from the goal 1 review).
    expect(configYaml).not.toMatch(/^kind: Namespace$/m);
  });

  it('renders AFTER argocd-install.yaml in every pass-1 list', () => {
    // `kubectl apply -f` processes documents in order; the populated
    // argocd-cmd-params-cm only wins because it comes after upstream's EMPTY one.
    // Reversed, the setting silently disappears and the front door loops or 502s.
    // Same defect class as the namespace ordering.
    const tasks = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
    ) as { tasks: Record<string, { steps?: Array<{ exec?: string }> }> };
    const execs = (tasks.tasks.deploy.steps ?? []).map((s) => s.exec ?? '');
    const renders = execs.filter((e) => e.includes('render-manifest.py k8s/namespaces.yaml'));
    expect(renders.length).toBeGreaterThanOrEqual(REGIONS.length);
    for (const e of renders) {
      const install = e.indexOf('src/argo/argocd-install.yaml');
      const config = e.indexOf('k8s/argocd-config.yaml');
      expect(install).toBeGreaterThan(-1);
      expect(config).toBeGreaterThan(install);
    }
  });
});

describe('the 403 bounce page pipeline (step 12)', () => {
  const templatePath = path.join(__dirname, '..', 'src', 'frontdoor', '403.html');
  const renderer = path.join(__dirname, '..', 'build', 'render-403.py');

  it('substitutes the prod /sign endpoint and the Bindle id from the environment', () => {
    const out = execSync(`python3 ${renderer} ${templatePath}`, {
      encoding: 'utf8',
      env: { ...process.env, CFS_BINDLE_ID: 'amzn1.bindle.resource.test123' },
    });
    expect(out).toContain('https://cloudfrontsigner.ninjas.security.a2z.com/sign?encodedTargetUrl=');
    expect(out).toContain('amzn1.bindle.resource.test123');
    expect(out).not.toContain('INSERT-SERVICE-ENDPOINT-HERE');
    expect(out).not.toContain('INSERT-BINDLE-ID-HERE');
  });

  it('renders a fail-closed SENTINEL when CFS_BINDLE_ID is unset, with a warning', () => {
    const env = { ...process.env };
    delete env.CFS_BINDLE_ID;
    const out = execSync(`python3 ${renderer} ${templatePath} 2>/dev/null`, {
      encoding: 'utf8',
      env,
    });
    // The sentinel is a Bindle that cannot exist, so CFS refuses onboarding and the
    // distribution stays LOCKED for everyone rather than open to anyone.
    expect(out).toContain('amzn1.bindle.UNSET-SEE-RUNBOOK-PREREQUISITE-8');
  });

  it('REFUSES a template whose tokens have drifted', () => {
    // A template missing its token renders a page that redirects nowhere, and the
    // symptom is an auth flow that hangs -- far from this file. Fail at build time.
    const drifted = path.join(__dirname, 'drifted-403.html');
    fs.writeFileSync(
      drifted,
      fs.readFileSync(templatePath, 'utf8').replace('INSERT-BINDLE-ID-HERE', 'oops'),
    );
    try {
      expect(() =>
        execSync(`python3 ${renderer} ${drifted} 2>/dev/null`, { encoding: 'utf8' }),
      ).toThrow();
    } finally {
      fs.unlinkSync(drifted);
    }
  });

  it('pairs the trusted-signer account with the /sign endpoint (cross-file contract)', () => {
    // The endpoint mints cookies with the key pair of the trusted-signer account. A
    // prod endpoint with a gamma signer -- or either edited alone -- yields cookies
    // CloudFront rejects, indistinguishable on stage from a failed onboarding. The two
    // constants live in different files with nothing else checking them: the exact
    // shape that produced six earlier defects in this project.
    const stackSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cdk', 'lib', 'front-door-stack.ts'),
      'utf8',
    );
    const rendererSrc = fs.readFileSync(renderer, 'utf8');
    expect(stackSrc).toContain("const CFS_TRUSTED_SIGNER_ACCOUNT = '076938169600';");
    expect(rendererSrc).toContain(
      'CFS_SERVICE_ENDPOINT = "https://cloudfrontsigner.ninjas.security.a2z.com/sign"',
    );
  });
});

describe('the argocd NLB dotenv rail (step 12)', () => {
  const tasks = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '.projen', 'tasks.json'), 'utf8'),
  ) as { tasks: Record<string, { steps?: Array<{ exec?: string }> }> };
  const deployExecs = (tasks.tasks.deploy.steps ?? []).map((s) => s.exec ?? '');

  it('resolves the NLB ARN with an actual describe-load-balancers invocation and aborts on empty', () => {
    // Asserting on the REAL invocation lines plus the abort branch, not a substring of
    // the whole task -- a toContain over the full text passes mutations that keep the
    // words in a comment or an echo (the crane-copy lesson).
    REGIONS.forEach((r, i) => {
      const step = deployExecs.find(
        (e) => e.includes(`dist/argo-nlb-${i}.env`) && e.includes(`--region ${r.name}`),
      );
      expect(step).toBeDefined();
      // The real lookup: DNSName->ARN listing piped through the captured endpoint.
      expect(step).toMatch(
        new RegExp(
          'AARN=\\$\\(aws elbv2 describe-load-balancers --region ' +
            r.name +
            '\\s+--query "LoadBalancers\\[\\]\\.\\[DNSName,LoadBalancerArn\\]"',
        ),
      );
      // The abort branch: an empty ARN must stop the deploy HERE, not three phases
      // later as an empty CfnParameter the frontdoor stack rejects far from the cause.
      expect(step).toContain('if test -z "$AARN"; then');
      expect(step).toContain(`no load balancer in ${r.name} matches the argocd endpoint`);
      expect(step).toMatch(new RegExp(`ARGO_NLB_ARN_${i}=%s`));
      expect(step).toMatch(new RegExp(`ARGO_NLB_DNS_${i}=%s`));
    });
  });

  it('uploads the rendered 403 page to both error buckets in Phase 7', () => {
    const upload = deployExecs.find((e) => e.includes('render-403.py'));
    expect(upload).toBeDefined();
    // The actual render invocation, then one actual s3 cp per region bucket.
    expect(upload).toContain('python3 build/render-403.py src/frontdoor/403.html > dist/403.html');
    REGIONS.forEach((r, i) => {
      expect(upload).toContain(
        `aws s3 cp dist/403.html "s3://$FRONTDOOR_${i}_ERRORBUCKETNAME/error/403.html" --region ${r.name}`,
      );
    });
    // And it must run AFTER both frontdoor stack deploys -- the buckets are theirs.
    const uploadIdx = deployExecs.indexOf(upload!);
    REGIONS.forEach((r) => {
      const deployIdx = deployExecs.findIndex((e) =>
        e.includes(`STACK_NAME="$PROJECT_NAME-${frontDoorSuffix(r)}"`),
      );
      expect(deployIdx).toBeGreaterThan(-1);
      expect(deployIdx).toBeLessThan(uploadIdx);
    });
  });

  it('captures the argocd endpoint in the installer with its own fail-loud branch', () => {
    // The installer buildspec is synthesized into the region templates; assert on the
    // template text so a silently-dropped poll block fails here, not on a live run.
    const app = new cdk.App({ analyticsReporting: false });
    const name = `${APP_ID}-${regionSuffix(REGIONS[0])}`;
    const t = Template.fromStack(
      new RegionStack(app, name, {
        stackName: name,
        synthesizer: makeSynthesizer(),
        env: { region: REGIONS[0].name },
        appId: APP_ID,
        regionName: REGIONS[0].name,
        defaultVpcCidr: REGIONS[0].cidr,
        withPrimaryDatabase: true,
        peerVpcCidrs: [],
      }),
    );
    const projects = Object.values(t.findResources('AWS::CodeBuild::Project'));
    // The BuildSpec property is a JSON document string; PARSE it and assert on the
    // command text kubectl actually runs, so escape-level artifacts cannot make a
    // wrong assertion pass (or a right one fail).
    const specs = projects
      .map((p) => p.Properties?.Source?.BuildSpec)
      .filter((s): s is string => typeof s === 'string' && s.includes('ARGOCD_LB_SERVICE_NAME'));
    expect(specs).toHaveLength(1);
    const parsed = JSON.parse(specs[0]) as { phases: { build: { commands: string[] } } };
    const cmd = parsed.phases.build.commands.find((c) => c.includes('ARGOCD_ENDPOINT_S3_URI'));
    expect(cmd).toBeDefined();
    // Gated: a run without a front door stays a no-op.
    expect(cmd).toContain('if [ -n "$ARGOCD_ENDPOINT_S3_URI" ]; then');
    // The capture is a REAL kubectl read of the LB Service, not prose.
    expect(cmd).toContain('kubectl get svc -n "$ARGOCD_NAMESPACE" "$ARGOCD_LB_SERVICE_NAME"');
    // Fail-loud: a Service that never gets a hostname stops the deploy in the build.
    expect(cmd).toContain('argocd Service never received a load balancer hostname.');
    expect(cmd).toContain('exit 1');
  });
});
