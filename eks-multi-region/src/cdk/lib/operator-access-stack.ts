import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { Construct } from 'constructs';
import { Cockpit } from './constructs/cockpit/cockpit';
import { DEMO_METRIC_NAMESPACE } from './constructs/observability/metric-namespace';
import { AZ_COUNT, OBSERVER_CIDR, REGIONS } from '../regions';

export interface OperatorAccessStackProps extends cdk.StackProps {
  readonly appId: string;
  readonly regionName: string;
  /**
   * PDD 2026-08-31-chaos-status-page. When true (default from app.ts), and only in the
   * us-west-2 stack, the status+chaos Cockpit construct is instantiated behind this
   * access door's ALB. Off => no cockpit resources (empty synth diff).
   */
  readonly enableCockpit?: boolean;
  /**
   * The observer VPC CIDR (defaults to {@link OBSERVER_CIDR}). It is the ONLY source the
   * ALB admits: the operator reaches this door exclusively through the third-region
   * observer bastion, which peers into this region's VPC and port-forwards over SSM.
   */
  readonly observerCidr?: string;
}

/**
 * The operator access door (step 12) — ONE PER REGION.
 *
 * Goal 1's proof (ARC scales the standby Deployment 2->4 and Argo CD declines to revert
 * it) lives in the Argo UI, and nothing inside the VPC is reachable from the internet:
 * the EKS endpoint is private-only, every load balancer is internal, and there is no
 * public bastion. This stack is what makes the proof VISIBLE — an INTERNAL ALB whose
 * only ingress is the observer VPC CIDR, load-balancing to the Kubernetes-owned
 * argocd-server internal NLB as IP targets.
 *
 * HOW THE OPERATOR REACHES IT. There is no public front door. A third-region "observer"
 * VPC (see ObserverStack) holds a bastion with no public IP and no inbound rules, peered
 * to both workload VPCs; `build/tunnel.sh` opens an SSM port-forward
 * (AWS-StartPortForwardingSessionToRemoteHost) from a laptop to this ALB's DNS name on
 * port 80. The tunnel follows the same private path a real in-VPC client would, so what
 * the operator sees is exactly what the observer sees.
 *
 * PER REGION because the ALB binds to one VPC in one region and the claim is about the
 * STANDBY, so both regions' Argo UIs must be watchable.
 *
 * DEPLOYS AFTER THE INSTALLER PHASES (factory Phase 6, like `dns`): the argocd NLB is
 * KUBERNETES-owned — the in-tree controller creates it when the installer applies
 * k8s/argocd-config.yaml — so its ENI ip addresses arrive here as a CfnParameter off
 * the dotenv rail, discovered by the installer and resolved by the runner.
 */
export class OperatorAccessStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OperatorAccessStackProps) {
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
    const vpcId = new cdk.CfnParameter(this, 'VpcId', {
      type: 'String',
      description: `VPC id of the ${props.regionName} RegionStack (the ALB attaches here).`,
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

    // ---- the operator access door's own load balancer --------------------------------
    //
    // An INTERNAL ALB. It carries the Argo CD watch streams and, in the standby, the
    // cockpit's /cockpit* rule. It is reached only from the observer bastion over an SSM
    // port-forward, so its single ingress source is the observer VPC CIDR.
    const albSg = new ec2.SecurityGroup(this, 'AccessAlbSg', {
      vpc,
      // NO `->` IN THIS STRING. EC2 accepts security group descriptions only from
      // `a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*` -- and `>` is not in it. An arrow here
      // synthesizes, validates against the resource schema, and then fails the CREATE with
      // "Invalid security group description", rolling the whole stack back. A test now
      // checks every SG description in every stack.
      description: `observer bastion access to the ${props.regionName} argocd access door`,
      allowAllOutbound: true,
    });
    // THE SOURCE IS THE OBSERVER VPC CIDR — the only network path in.
    //
    // The bastion in the third-region observer VPC peers into this region's VPC and
    // opens an SSM port-forward to this ALB on port 80. Traffic therefore arrives from
    // the observer CIDR over the peering connection. There is no CloudFront, no signed
    // cookie, and no world-open rule: an operator who is not on the bastion cannot reach
    // this door at all.
    const observerCidr = props.observerCidr ?? OBSERVER_CIDR;
    albSg.addIngressRule(
      ec2.Peer.ipv4(observerCidr),
      ec2.Port.tcp(80),
      'observer bastion (via VPC peering + SSM port-forward)',
    );

    const alb = new elbv2.ApplicationLoadBalancer(this, 'AccessAlb', {
      vpc,
      vpcSubnets: { subnets: vpc.isolatedSubnets },
      internetFacing: false,
      securityGroup: albSg,
      // Argo's UI holds long-lived watch streams open to live-update its resource tree.
      // The 60s default would drop them every minute and the tree would stop moving;
      // this is why the ALB can show replicas going 2 -> 4 live.
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
    // `/cockpit*` ApplicationListenerRule to it. PDD 2026-08-31-chaos-status-page.
    const listener = alb.addListener('AccessListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [argoTargets],
      // open:false, and this is NOT a detail. The CDK default is TRUE, which silently
      // adds an "Allow from anyone on port 80" 0.0.0.0/0 rule ALONGSIDE the scoped rule
      // above -- caught here only because a test asserts the ingress list has exactly
      // one entry. The ALB is internal and its subnets have no internet-gateway route, so
      // it was not reachable, but a world-open rule on a security group is a finding
      // regardless and would have shipped invisibly.
      open: false,
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'Internal ALB DNS name. build/tunnel.sh port-forwards to this over SSM.',
    });

    // PDD 2026-08-31-chaos-status-page, Step 0. The status+chaos cockpit is hosted ONLY
    // in the standby (us-west-2) access door — the observer must not share fate with the
    // region it watches (the primary is the likely failover source). Gated by BOTH the
    // west-region guard and the enableCockpit flag: either false => no cockpit resources,
    // so every other region's synth and the flag-off synth are byte-identical to today.
    if ((props.enableCockpit ?? true) && props.regionName === REGIONS[1].name) {
      // The cockpit's scoped ARNs arrive as CfnParameters off the dotenv rail, replacing
      // the runtime cloudformation:DescribeStacks discovery the handler once used.
      //
      // DECLARED INSIDE THIS GUARD ON PURPOSE. These parameters exist only in the STANDBY
      // access-door template, because that is the only stack that builds a Cockpit.
      // Hoisting them out would declare them in the PRIMARY template too, where the deploy
      // step supplies nothing — and an unsupplied parameter with no default fails the
      // changeset. A parameter declared here and NOT threaded in .projenrc.ts breaks the
      // DEPLOY, not the build; both directions are pinned by the derived-contract test in
      // test/cockpit.test.ts.
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
        // DEPLOY, not the build.
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
        // test as every other cockpit parameter (both directions).
        appNlbArn: cockpitParam('AppNlbArn',
          'App NLB ARN — scopes the arc-zonal-shift:ResourceIdentifier condition key.'),
        azNameIdPairs: cockpitParam('AzNameIdPairs',
          'AZ name=id pairs (us-east-2a=use2-az1,...). awayFrom needs the ID; FIS uses the name.'),
      });
    }
  }
}
