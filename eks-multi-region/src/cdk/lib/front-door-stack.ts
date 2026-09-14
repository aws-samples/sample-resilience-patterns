import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { Cockpit } from './constructs/cockpit/cockpit';
import { DEMO_METRIC_NAMESPACE } from './constructs/observability/metric-namespace';
import { AZ_COUNT, REGIONS } from '../regions';

/**
 * The CloudFrontSigner PROD trusted-signer account (step 12).
 *
 * CFS's legacy trusted-signer integration: this AWS account's CloudFront key pair signs
 * the cookies the /sign endpoint mints after Midway auth + a Bindle check, and putting
 * the account in the default behavior's TrustedSigners makes CloudFront reject every
 * request that does not carry them. The value comes from CloudFrontSignerConstructs
 * (lib/cloudfront_signer.ts, CONFIGURATION_MAP.PROD) and MUST stay paired with the
 * /sign endpoint constant in build/render-403.py — a prod endpoint with a gamma signer
 * (or vice versa) yields cookies CloudFront rejects, indistinguishable on stage from a
 * failed onboarding.
 *
 * Chosen over the TRUSTED_KEY_GROUPS variant deliberately: key groups need an RSA key
 * pair provisioned into Secrets Manager by a custom-resource Lambda (the
 * StartupsIdentity shape). The trusted-signer variant is zero additional machinery,
 * and it is what the vended construct's PROD path does.
 */
const CFS_TRUSTED_SIGNER_ACCOUNT = '076938169600';

export interface FrontDoorStackProps extends cdk.StackProps {
  readonly appId: string;
  readonly regionName: string;
  /**
   * PDD 2026-08-31-chaos-status-page. When true (default from app.ts), and only in the
   * us-west-2 stack, the status+chaos Cockpit construct is instantiated behind this
   * front door's ALB + distribution. Off => no cockpit resources (empty synth diff).
   */
  readonly enableCockpit?: boolean;
}

/**
 * The Midway-gated front door (step 12) — ONE PER REGION.
 *
 * Goal 1's proof (ARC scales the standby Deployment 2→4 and Argo CD declines to revert
 * it) lives in the Argo UI, and before this stack nothing inside the VPC was reachable
 * from outside it: the EKS endpoint is private-only, every load balancer is internal,
 * and there is no bastion. This stack is what makes the proof VISIBLE — a CloudFront
 * distribution whose default behavior requires CloudFrontSigner-signed cookies
 * (Midway auth + Bindle authorization) and whose origin is a CloudFront VPC origin
 * reaching the internal argocd-server NLB over a service-managed ENI. No public
 * subnets; the VPC's internet gateway is attached but UNROUTED (see RegionStack).
 *
 * PER REGION because a VPC origin binds to one load balancer in one region, and the
 * claim is about the STANDBY — so both regions' Argo UIs must be watchable. Whether a
 * single distribution can hold VPC origins in two regions is undocumented and has no
 * offline verification path (`create-vpc-origin` has no --dry-run); one-per-region is
 * the shape that certainly works. If the shared form is confirmed on a live account,
 * collapsing to one distribution halves the per-deployer CFS onboarding — a
 * post-deploy optimisation, deliberately not a prerequisite (plan.md, verification
 * round 2, item 1).
 *
 * DEPLOYS AFTER THE INSTALLER PHASES (factory Phase 6, like `dns`): the argocd NLB is
 * KUBERNETES-owned — the in-tree controller creates it when the installer applies
 * k8s/argocd-config.yaml — so its ARN and DNS name arrive here as CfnParameters off
 * the dotenv rail, discovered by the installer and resolved by the runner.
 *
 * THE CFS SESSION HANDSHAKE this stack encodes:
 *   1. Uncookied GET → default behavior's TrustedSigners rejects → 403
 *   2. Custom error response serves /error/403.html from the S3 origin
 *   3. That page's JS redirects to CFS, which does Midway + the Bindle check
 *   4. CFS redirects back with policy/kpid/exp/sig; the page sets the four
 *      CloudFront-* cookies and replays the original URL
 *   5. Every subsequent request passes the signature check into the VPC origin
 *
 * The /error/* behavior is deliberately UNGATED — a gated error page cannot be served
 * to the unauthenticated user who needs it, and gating it infinite-loops the redirect.
 * That is safe because the bucket holds exactly one public artifact: the bounce page.
 *
 * FAIL-CLOSED: the signed-cookie requirement is CloudFront's own enforcement, live from
 * the moment this stack deploys — NOT something the manual CFS onboarding turns on.
 * Before onboarding, every request 403s and CFS refuses the unknown domain; after
 * onboarding but before the Bindle grant, CFS authenticates and then denies. The worst
 * case of skipping runbook prerequisite 8 is an unreachable site, never an exposed one.
 *
 * KNOWN DEVIATION, recorded rather than hidden: on the default *.cloudfront.net
 * certificate CloudFront FIXES the security policy at TLSv1 and ignores any
 * MinimumProtocolVersion — so the SAX-01 "TLS endpoint uses a TLS1.2+ security policy"
 * exit criterion is not strictly satisfiable without a custom domain, which was
 * rejected for redeployability (per-account cross-team DNS delegation; plan.md round 2
 * item 4). Viewers still NEGOTIATE TLS 1.2/1.3; only the floor is lower. Payloads are
 * synthetic demo data (SAX-08 scope note), and flipping to a custom domain restores
 * the strict policy if this ever fronts anything real.
 */
export class FrontDoorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FrontDoorStackProps) {
    super(scope, id, props);

    // build/deploy-stack.sh appends these to EVERY deploy unconditionally and
    // CloudFormation rejects a changeset carrying parameters the template does not
    // declare. Required in every deployable stack.
    new cdk.CfnParameter(this, 'AssetsBucketName', {
      type: 'String',
      description: 'S3 bucket holding the synthesized templates and asset objects.',
    });
    new cdk.CfnParameter(this, 'AssetsBucketPrefix', {
      type: 'String',
      description: 'Run-scoped key prefix inside the assets bucket.',
    });

    // The argocd-server NLB's own ENI addresses, off the dotenv rail like the DNS
    // stack's alias targets. The ALB below load-balances to these as IP targets.
    //
    // IPs, not the DNS name: an ALB target group cannot target a hostname. And these
    // specific IPs because an internal NLB's ENI addresses are FIXED for its lifetime,
    // whereas pod IPs change on every restart and node IPs churn under Karpenter -- and
    // ARC adds nodes during the very failover this demo exists to run.
    const nlbIps = new cdk.CfnParameter(this, 'ArgoNlbIps', {
      type: 'CommaDelimitedList',
      description: `Private IPs of the ${props.regionName} argocd-server internal NLB ENIs.`,
    });
    // NOTE: there is deliberately NO VpcCidr parameter any more. The ALB ingress
    // source is the CloudFront origin-facing prefix list (see the SG below) -- the
    // VPC CIDR was the wrong source and its parameter would be dead weight that the
    // deploy step still has to thread. Removing a CfnParameter REQUIRES removing the
    // value the deploy passes, or CloudFormation rejects the changeset with
    // "Parameters: [VpcCidr] do not exist in the template".
    const vpcId = new cdk.CfnParameter(this, 'VpcId', {
      type: 'String',
      description: `VPC id of the ${props.regionName} RegionStack (the proxy attaches here).`,
    });
    const subnetIds = new cdk.CfnParameter(this, 'IsolatedSubnetIds', {
      type: 'CommaDelimitedList',
      description: `Private-isolated subnet ids of the ${props.regionName} RegionStack.`,
    });
    const subnetAzs = new cdk.CfnParameter(this, 'IsolatedSubnetAzs', {
      type: 'CommaDelimitedList',
      description: 'Availability zones matching IsolatedSubnetIds, in the same order.',
    });

    // Fixed-length arrays via Fn.select, NOT the raw list tokens: fromVpcAttributes given
    // a list token can only materialize ONE synthetic subnet because CDK cannot know a
    // token's length. Selecting AZ_COUNT elements keeps the LENGTH synth-time while the
    // VALUES stay deploy-time tokens. Same pattern as SecondaryDbStack.
    const indices = Array.from({ length: AZ_COUNT }, (_, i) => i);
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'RegionVpc', {
      vpcId: vpcId.valueAsString,
      availabilityZones: indices.map((i) => cdk.Fn.select(i, subnetAzs.valueAsList)),
      isolatedSubnetIds: indices.map((i) => cdk.Fn.select(i, subnetIds.valueAsList)),
    });

    // The 403 bounce page's home. SSE-S3 rather than KMS — CloudFront cannot serve
    // KMS-encrypted objects through OAC without key-policy work this page does not
    // justify. The page itself is uploaded by the deploy rail (Phase 7) AFTER this
    // stack exists, because its content carries the per-deployer Bindle id; a
    // BucketDeployment custom resource would bake one deployer's Bindle into the
    // template. autoDeleteObjects so teardown is not blocked by a non-empty bucket.
    const errorBucket = new s3.Bucket(this, 'ErrorBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---- the front door's own load balancer -----------------------------------------
    //
    // An ALB, and THIS is what makes a VPC origin possible at all. AWS: "To be used as a
    // VPC origin, a Network Load Balancer must have a security group attached to it" --
    // the in-tree Kubernetes service controller creates NLBs without one, and an NLB
    // created without security groups can never be given them afterwards. An ALB always
    // has a security group by construction, so the constraint simply does not apply.
    //
    // TWO WITHDRAWN DESIGNS, recorded because both look reasonable and neither works:
    //
    //   1. Lambda reverse proxy behind an OAC-signed Function URL. OAC signs SigV4 over
    //      the ORIGIN's host, so forwarding the viewer Host (ALL_VIEWER, which this UI
    //      wants) invalidates every signature -- the Function URL 403s BEFORE invoking,
    //      which reads as an auth failure rather than a config error. Worse, AWS states
    //      "Lambda doesn't support unsigned payloads" for PUT/POST through OAC: the
    //      viewer must send x-amz-content-sha256, which no browser does. Argo's API is
    //      gRPC-Web over POST, so login could never have succeeded. Proven live
    //      2026-08-26: the proxy logged ZERO invocations.
    //   2. That same Lambda as an ALB target. Worse again -- an ALB Lambda target caps
    //      request AND response at 1 MB (Argo's JS bundle exceeds it) and "WebSockets are
    //      not supported. Upgrade requests are rejected with an HTTP 400 code."
    //
    // The ALB has none of those limits: full HTTP semantics, POST, WebSocket, no payload
    // signing, no size cap.
    const albSg = new ec2.SecurityGroup(this, 'FrontDoorAlbSg', {
      vpc,
      // NO `->` IN THIS STRING. EC2 accepts security group descriptions only from
      // `a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*` -- and `>` is not in it. An arrow here
      // synthesizes, validates against the resource schema, and then fails the CREATE with
      // "Invalid security group description", rolling the whole stack back. Cost a deploy
      // attempt on 2026-08-26; a test now checks every SG description in every stack.
      description: `CloudFront VPC origin to the ${props.regionName} argocd front door`,
      allowAllOutbound: true,
    });
    // THE SOURCE IS THE CLOUDFRONT ORIGIN-FACING PREFIX LIST, NOT THE VPC CIDR.
    //
    // The first deploy of this ALB used the VPC CIDR with a comment asserting it was
    // "the tightest source expressible at synth time". That reasoning was WRONG and
    // cost the front door outright: VPC-origin traffic does not present a source
    // address inside this VPC's CIDR, so the ALB saw RequestCount = 0 and CloudFront
    // returned 504 (no answer at all -- a 503 would have meant the ALB answered).
    // The documented sources for VPC-origin traffic are the service-managed
    // CloudFront-VPCOrigins-Service-SG (not expressible at synth time -- it is created
    // when the first VPC origin deploys) or the origin-facing managed prefix list,
    // which IS stable and per-region:
    //
    //   com.amazonaws.global.cloudfront.origin-facing
    //     us-east-2: pl-b6a144df     us-west-2: pl-82a045eb
    //
    // Both ids verified live in this account on 2026-08-26. Hardcoding them is safe:
    // AWS-managed prefix list ids are fixed per region, not per account.
    const CLOUDFRONT_ORIGIN_FACING: Record<string, string> = {
      'us-east-2': 'pl-b6a144df',
      'us-west-2': 'pl-82a045eb',
    };
    const prefixListId = CLOUDFRONT_ORIGIN_FACING[props.regionName];
    if (!prefixListId) {
      throw new Error(
        `no CloudFront origin-facing prefix list id known for ${props.regionName} -- `
        + 'look it up (com.amazonaws.global.cloudfront.origin-facing) and add it',
      );
    }
    albSg.addIngressRule(
      ec2.Peer.prefixList(prefixListId),
      ec2.Port.tcp(80),
      'CloudFront origin-facing range',
    );

    const alb = new elbv2.ApplicationLoadBalancer(this, 'FrontDoorAlb', {
      vpc,
      vpcSubnets: { subnets: vpc.isolatedSubnets },
      internetFacing: false,
      securityGroup: albSg,
      // Argo's UI holds long-lived watch streams open to live-update its resource tree.
      // The 60s default would drop them every minute and the tree would stop moving;
      // this is why the ALB can show replicas going 2 -> 4 live and the withdrawn
      // buffered proxy could not.
      idleTimeout: cdk.Duration.seconds(3600),
    });

    // AZ_COUNT targets, matching the number of subnets the Kubernetes NLB was created in.
    // Fn.select over a list token cannot know the token's length, so the COUNT is fixed
    // at synth time while the VALUES stay deploy-time -- the same reason the VPC above is
    // rebuilt from AZ_COUNT Fn.selects. The installer asserts it emits exactly this many
    // IPs, so a mismatch fails in the phase that discovers them rather than here.
    const argoTargets = new elbv2.ApplicationTargetGroup(this, 'ArgoTargets', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: Array.from(
        { length: AZ_COUNT },
        (_, i) => new elbv2Targets.IpTarget(cdk.Fn.select(i, nlbIps.valueAsList)),
      ),
      // argocd-server serves /healthz unauthenticated. 200-399 because the server
      // redirects to /login when unauthenticated and a redirect is a healthy origin.
      healthCheck: { path: '/healthz', healthyHttpCodes: '200-399' },
      deregistrationDelay: cdk.Duration.seconds(10),
    });
    // Captured (was a bare `alb.addListener(...)`) so the Cockpit construct can attach a
    // `/cockpit*` ApplicationListenerRule to it in Step 1. PDD 2026-08-31-chaos-status-page.
    const listener = alb.addListener('FrontDoorListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [argoTargets],
      // open:false, and this is NOT a detail. The CDK default is TRUE, which silently
      // adds an "Allow from anyone on port 80" 0.0.0.0/0 rule ALONGSIDE the scoped rule
      // above -- caught here only because a test asserted the ingress list had exactly
      // one entry. The ALB is internal and its subnets have no internet-gateway route, so
      // it was not reachable, but a world-open rule on a security group is a finding
      // regardless and would have shipped invisibly.
      open: false,
    });

    // TLS terminates at CloudFront; the hop from the VPC origin ENI to the ALB is plain
    // HTTP inside private-isolated subnets with no internet route.
    const argoOrigin = origins.VpcOrigin.withApplicationLoadBalancer(alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${props.appId} ${props.regionName} operator front door (CFS-gated Argo CD UI)`,
      defaultBehavior: {
        origin: argoOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // A live UI over WebSocket, not a cacheable site: no caching, and the origin
        // request must carry every header, cookie and query string the viewer sent —
        // Argo's session cookie and the WebSocket Upgrade negotiation included.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
      additionalBehaviors: {
        // UNGATED (no trusted signers): the bounce page must be servable to the
        // unauthenticated user the 403 flow exists for.
        'error/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(errorBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
      errorResponses: [
        {
          // The trusted-signer rejection. responseHttpStatus stays 403 (not 200):
          // masking it would make every genuine auth failure read as success in logs.
          httpStatus: 403,
          responseHttpStatus: 403,
          responsePagePath: '/error/403.html',
          // The bounce page must not be cached as the response for the original URL,
          // or a user returning WITH cookies can be served the stale bounce.
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // The gate itself. The Distribution L2 exposes only trustedKeyGroups, so the
    // legacy account-number TrustedSigners goes on via the L1 escape hatch — the
    // generated CfnDistribution type pins the CFN shape as Array<string>.
    const cfnDist = distribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnDist.addPropertyOverride('DistributionConfig.DefaultCacheBehavior.TrustedSigners', [
      CFS_TRUSTED_SIGNER_ACCOUNT,
    ]);

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'Onboard THIS domain at cloudfrontsigner.ninjas.security.a2z.com (runbook prerequisite 8).',
    });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    // Phase 7 uploads the rendered 403 page here — the bucket name is a generated
    // physical name only this stack knows.
    new cdk.CfnOutput(this, 'ErrorBucketName', { value: errorBucket.bucketName });

    // PDD 2026-08-31-chaos-status-page, Step 0. The status+chaos cockpit is hosted ONLY
    // in the standby (us-west-2) front door — the observer must not share fate with the
    // region it watches (the primary is the likely failover source). Gated by BOTH the
    // west-region guard and the enableCockpit flag: either false => no cockpit resources,
    // so every other region's synth and the flag-off synth are byte-identical to today.
    // Step 0 construct is inert; `listener` is captured now so Step 1 can attach the
    // /cockpit* rule without re-touching this block.
    if ((props.enableCockpit ?? true) && props.regionName === REGIONS[1].name) {
      // STEP 5: the cockpit's scoped ARNs arrive as CfnParameters off the dotenv rail,
      // replacing the runtime cloudformation:DescribeStacks discovery the handler used.
      //
      // DECLARED INSIDE THIS GUARD ON PURPOSE. These parameters exist only in the STANDBY
      // front-door template, because that is the only stack that builds a Cockpit. Hoisting
      // them out would declare them in the PRIMARY template too, where the deploy step
      // supplies nothing — and an unsupplied parameter with no default fails the changeset.
      // The mirror hazard is the one AGENTS.md calls bug class 4: a parameter declared here
      // and NOT threaded in .projenrc.ts breaks the DEPLOY, not the build. Both directions
      // are pinned by the derived-contract test in test/cockpit.test.ts.
      const cockpitParam = (id: string, description: string): string =>
        new cdk.CfnParameter(this, id, { type: 'String', description }).valueAsString;

      new Cockpit(this, 'Cockpit', {
        appId: props.appId,
        primaryRegion: REGIONS[0].name,
        standbyRegion: REGIONS[1].name,
        listener,
        metricNamespace: DEMO_METRIC_NAMESPACE,
        planArn: cockpitParam('PlanArn',
          'ARC Region switch plan ARN. Scopes StartPlanExecution to exactly this plan.'),
        primaryKnobParam: cockpitParam('PrimaryKnobParam',
          `Error-rate SSM parameter name in ${REGIONS[0].name}.`),
        standbyKnobParam: cockpitParam('StandbyKnobParam',
          `Error-rate SSM parameter name in ${REGIONS[1].name}.`),
        fisRoleArn: cockpitParam('FisRoleArn',
          'FIS service role ARN. iam:PassRole is scoped to exactly this role.'),
        fisPacketLossTemplateIds: cockpitParam('FisPacketLossTemplateIds',
          'Comma-separated per-AZ packet-loss FIS template ids.'),
        fisLatencyTemplateIds: cockpitParam('FisLatencyTemplateIds',
          'Comma-separated per-AZ latency FIS template ids (400ms; moves availability on reads).'),
        // PAIRED az=templateId, for the single-AZ fault. Threaded in the SAME change as the
        // grant and the env below: a CfnParameter declared but never supplied breaks the
        // DEPLOY, not the build (AGENTS.md bug class 4).
        fisLatencyTemplatesByAz: cockpitParam('FisLatencyTemplatesByAz',
          'az=templateId pairs for the single-AZ latency fault.'),
        fisPacketLossTemplatesByAz: cockpitParam('FisPacketLossTemplatesByAz',
          'az=templateId pairs for the single-AZ packet-loss fault.'),
        fisPowerTemplatesByAz: cockpitParam('FisPowerTemplatesByAz',
          'az=templateId pairs for the single-AZ power-interruption fault.'),
        fisBrownoutTemplatesByAz: cockpitParam('FisBrownoutTemplatesByAz',
          'az=templateId pairs for the single-AZ brownout (gray) fault.'),
        primaryClusterName: cockpitParam('PrimaryClusterName',
          `EKS cluster name in ${REGIONS[0].name} (the FIS target set's cluster).`),
        primaryNodeGroupName: cockpitParam('PrimaryNodeGroupName',
          `Managed node group name in ${REGIONS[0].name} (arming tags its instances).`),
        // STEP 10: the zonal-shift control. Both ride the same derived deploy-contract
        // test as every other cockpit parameter (bug class 4, both directions).
        appNlbArn: cockpitParam('AppNlbArn',
          'App NLB ARN — scopes the arc-zonal-shift:ResourceIdentifier condition key.'),
        azNameIdPairs: cockpitParam('AzNameIdPairs',
          'AZ name=id pairs (us-east-2a=use2-az1,...). awayFrom needs the ID; FIS uses the name.'),
      });
    }
  }
}
