import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { AppInstaller } from './app-installer';
import { AuroraMember } from './aurora-member';
import { FluentBitIam } from './fluentbit-iam';
import { KarpenterIam } from './karpenter-iam';
import { LbcIam } from './lbc-iam';
import { APP_RECORD_NAME, AZ_COUNT, KUBERNETES_VERSION, PRIMARY_REGION, REGIONS } from '../regions';
import { AuroraObservability } from './aurora-observability';
import { APP_NAMESPACE } from '../k8s';
import { AllowedCidrSecurityGroup } from './constructs/auth';
import {
  FailureInjectionParameter,
  FisNetworkExperiments,
} from './constructs/failure-injection';
import { RegionalNetwork } from './constructs/networking';
import { DemoObservability } from './constructs/observability';
import { DEMO_METRIC_NAMESPACE } from './constructs/observability/metric-namespace';

export interface RegionStackProps extends cdk.StackProps {
  /** Application id prefix, e.g. `eks-mr-demo`. Used for region-unique resource names. */
  readonly appId: string;
  /** This stack's AWS region, e.g. `us-east-2`. Also used to suffix the dashboard name. */
  readonly regionName: string;
  /** Default VPC CIDR for this region; overridable at deploy time via the CfnParameter. */
  readonly defaultVpcCidr: string;
  /**
   * Create the PRIMARY Aurora member in this stack. True for the primary region only.
   *
   * The secondary member deliberately lives in its own stack (SecondaryDbStack) because
   * it can only be created after the global cluster exists, and the global cluster is
   * created after this stack.
   */
  readonly withPrimaryDatabase?: boolean;
  /**
   * Region to replicate the database credentials secret into. Primary region only, and
   * only meaningful alongside `withPrimaryDatabase`.
   *
   * The secondary Aurora member inherits its credentials by replication and declares
   * none of its own, so it has no secret. Replicating gives the standby region a LOCAL
   * copy to read, instead of a cross-region read back into the region it may be failing
   * away from.
   */
  readonly replicateSecretToRegion?: string;
  /**
   * CIDRs of the OTHER regions' VPCs, which this region is peered with.
   *
   * Needed because the load generator lives in one region and follows DNS to whichever
   * region is currently active, so requests arrive here from a peer VPC. See the node
   * security group rule for why that is not automatic.
   */
  readonly peerVpcCidrs?: readonly string[];
}

/**
 * One per region. STEP 1 scope: the three always-on constructs ONLY.
 *
 * EKS (step 2), the Aurora member (step 1b) and the app workload (step 3) land here in
 * later increments. Keeping this step to the baseline is deliberate — it proves the
 * retopology and the deploy parameter contract on their own, before anything else can
 * confound a failure.
 */
export class RegionStack extends cdk.Stack {
  /** The regional VPC, for later increments to attach to. */
  public readonly network: RegionalNetwork;
  /** Deploy-time VPC CIDR parameter, retained so later increments can reference it. */
  public readonly vpcCidr: cdk.CfnParameter;

  constructor(scope: Construct, id: string, props: RegionStackProps) {
    super(scope, id, props);

    // build/deploy-stack.sh appends AssetsBucketName + AssetsBucketPrefix to EVERY
    // deploy unconditionally, and CloudFormation REJECTS a changeset carrying a
    // parameter the template does not declare. The synthesizer only emits the implied
    // params when a stack happens to own file assets — which this one does not — so
    // without these two declarations the first deploy fails with
    //   Parameters: [AssetsBucketName, AssetsBucketPrefix] do not exist in the template
    // `npx cdk synth` cannot catch that. Carried verbatim from the green DemoStack.
    const assetsBucketName = new cdk.CfnParameter(this, 'AssetsBucketName', {
      type: 'String',
      description: 'S3 bucket holding the synthesized templates and asset objects.',
    });
    new cdk.CfnParameter(this, 'AssetsBucketPrefix', {
      type: 'String',
      description: 'Key prefix inside AssetsBucketName (trailing slash required).',
    });

    // Deploy-time CIDR so the SAME template deploys to any region. deploy-tasks.ts
    // threads REGION_<i>_VPC_CIDR into this parameter.
    //
    // NOTE: the AllowedCidr parameter is OWNED by AllowedCidrSecurityGroup — it creates
    // the parameter and calls overrideLogicalId('AllowedCidr') internally. This stack
    // MUST NOT declare its own, or the logical id collides.
    this.vpcCidr = new cdk.CfnParameter(this, 'VpcCidr', {
      type: 'String',
      default: props.defaultVpcCidr,
    });

    // 1) Networking — regional isolated VPC, deploy-time CIDR.
    this.network = new RegionalNetwork(this, 'Network', {
      vpcCidr: this.vpcCidr.valueAsString,
      // Explicit rather than the construct's internal default: SecondaryDbStack needs
      // this count at synth time to build fixed-length subnet arrays from the imported
      // VPC. One constant, both sides.
      azCount: AZ_COUNT,
      // No internet gateway. The old CloudFront VPC-origin front door required an IGW
      // ATTACHED to the VPC (a static "can receive traffic from the internet" flag); that
      // front door is gone, replaced by the observer bastion + internal ALB reached over
      // SSM, so the VPC stays fully isolated with no IGW at all.
      includeInternetGateway: false,
      // REQUIRED for EKS in fully-private subnets, not an optimisation.
      //
      // These subnets have no NAT and no internet ROUTE, so without these endpoints
      // the managed node group cannot register with the cluster or pull images and the
      // node group creation simply times out — a slow, opaque failure with no useful
      // error. AWS documents ec2 + ecr.api + ecr.dkr + s3 as the minimum for nodes to
      // JOIN, plus sts (node registration and IRSA) and logs (CloudWatch). The S3
      // GATEWAY endpoint — which carries the actual image layers — is already on by
      // default in RegionalNetwork.
      //
      // `elasticloadbalancing` IS here (last member below), and it was not always. The
      // in-tree Kubernetes service controller that used to provision this NLB runs on the
      // AWS-managed control plane, not as a pod in this VPC, so it never egressed through
      // these endpoints and the endpoint was deliberately absent. The single-AZ /
      // zonal-shift feature replaces it with the AWS Load Balancer Controller, which runs
      // IN-CLUSTER: it calls the ELB API from these isolated subnets to manage the NLB and
      // its target groups. Without the endpoint that call fails as a connect timeout
      // inside the controller pod and the Service simply never provisions an NLB.
      interfaceEndpoints: [
        ec2.InterfaceVpcEndpointAwsService.EC2,
        ec2.InterfaceVpcEndpointAwsService.ECR,
        ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
        ec2.InterfaceVpcEndpointAwsService.STS,
        ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
        // Required by the APP, not by the cluster: every pod reads the database
        // credentials from Secrets Manager at startup. In a subnet with no NAT and no
        // internet route that call has nowhere to go without this endpoint, and it
        // fails as a connect timeout inside the pod — so the pods come up, pass a health
        // probe that makes no database call, get registered behind the load balancer and
        // then return 500 on every real request. Healthy-looking and useless.
        //
        // KMS is deliberately NOT here. The credentials secret uses the AWS-managed
        // `aws/secretsmanager` key, and Secrets Manager performs the decrypt itself
        // server-side; the caller never calls KMS. If the secret is ever switched to a
        // customer-managed key, BOTH a kms:Decrypt grant and this endpoint become
        // necessary — that combination fails as "Access to KMS is not allowed", which
        // reads like an IAM problem and is half a networking one. There is a test
        // asserting the secret carries no KmsKeyId so that switch cannot happen quietly.
        ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        // Required by the IN-VPC INSTALLER (AppInstaller), which applies the Kubernetes
        // manifests because the cluster API endpoint is private and the CI runner sits
        // outside this VPC.
        //
        // `eks` — the build calls `aws eks update-kubeconfig`, which reads the cluster
        // endpoint and CA certificate from the EKS API. Note this is the EKS CONTROL API,
        // not the cluster's own API server: the latter is reached over its private ENIs
        // and needs no endpoint, just a security group rule.
        ec2.InterfaceVpcEndpointAwsService.EKS,
        // `codebuild` — how a VPC-attached build reaches the CodeBuild service without a
        // NAT gateway. AWS documents this endpoint as removing the NAT requirement, while
        // CodeBuild's general VPC guidance still recommends a NAT; those two pages do not
        // obviously agree, and only a live run settles it. Recorded as the main open risk
        // of the private-endpoint approach.
        ec2.InterfaceVpcEndpointAwsService.CODEBUILD,
        // The SSM trio, required by STEP 6 rather than by anything shipped yet, and added
        // now because it is the same defect this VPC has already produced twice.
        //
        // The failure injection reaches nodes with `aws:ssm:send-command`, which only
        // works if the SSM agent on each node has REGISTERED with Systems Manager. In a
        // subnet with no NAT and no internet route that registration needs `ssm`,
        // `ssmmessages` and `ec2messages`. Without them the agent never comes online, the
        // nodes simply do not appear as managed instances, and the injection resolves zero
        // targets — reporting success having done nothing, exactly like the node group
        // that could not join and the Service that stayed pending.
        ec2.InterfaceVpcEndpointAwsService.SSM,
        ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
        ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
        // Required by the REPLICA REPORTER CronJob (k8s/app.yaml): it publishes the
        // orders-api desired/ready replica counts as CloudWatch metrics so the cockpit
        // can render them — the cockpit Lambda is no-VPC and cannot reach the private
        // Kubernetes API endpoint itself, so something IN-cluster must cross the
        // boundary. This is the METRICS endpoint (`monitoring`), distinct from
        // CLOUDWATCH_LOGS above; without it PutMetricData from the isolated subnets
        // hangs as a connect timeout — the same healthy-looking-and-useless failure as
        // the Secrets Manager case. Each region's reporter publishes to its OWN region's
        // CloudWatch: a regional interface endpoint serves only its own region's API, so
        // cross-region publishing is not an option here and the cockpit reads both
        // regions instead.
        ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
        // Required by the AWS Load Balancer Controller, which runs as a POD in these
        // isolated subnets (unlike the in-tree service controller it replaces, which ran
        // on the AWS-managed control plane). It calls the ELB API to create and manage the
        // app NLB and its target groups. One edit reaches BOTH regions because RegionStack
        // is instantiated per region in app.ts, and the controller ships to both clusters
        // because AppInstaller applies the same k8s/app.yaml in each.
        ec2.InterfaceVpcEndpointAwsService.ELASTIC_LOAD_BALANCING,
      ],
    });

    // Subnet tag the in-tree service controller needs to place an INTERNAL load
    // balancer. Without it, a Service of type LoadBalancer finds no eligible subnet and
    // stays <pending> indefinitely — the Service exists, nothing serves it, and nothing
    // in CloudFormation reports a problem because Kubernetes owns that object.
    //
    // Applied to the network SUBTREE with a resource-type filter, NOT by iterating
    // `vpc.isolatedSubnets`. ParameterizedVpc creates raw `CfnSubnet` resources and then
    // exposes the VPC through `Vpc.fromVpcAttributes`, so `vpc.isolatedSubnets` returns
    // IMPORTED subnet objects that are not the real constructs — `Tags.of()` on them is a
    // silent no-op. The first version of this did exactly that and produced zero tags
    // with no error; only reading the synthesized template caught it.
    cdk.Tags.of(this.network).add('kubernetes.io/role/internal-elb', '1', {
      includeResourceTypes: ['AWS::EC2::Subnet'],
    });

    // 2) Auth baseline — always-on CIDR lockdown so nothing is ever public. The
    //    construct owns the console-rotatable AllowedCidr parameter (deny-all default).
    const baselineSg = new AllowedCidrSecurityGroup(this, 'BaselineSg', {
      vpc: this.network.vpc,
    });

    // 3) Observability. Both props are load-bearing and were a coherence-review finding
    //    (C-1), so they are stated explicitly rather than left to defaults:
    //
    //    - demoName is REGION-SUFFIXED. The green stub used `${appId}-demo`, which is
    //      identical in both regions and would produce COLLIDING dashboard names once
    //      there is more than one region.
    //    - metricsRegion is the PRIMARY region in both stacks — see the inline comment
    //      on the prop. An earlier revision used Aws.REGION per stack and shipped a
    //      standby dashboard whose widgets queried a CloudWatch nothing writes to.
    const obs = new DemoObservability(this, 'Observability', {
      demoName: `${props.appId}-${props.regionName}`,
      // THE PRIMARY REGION, IN BOTH STACKS — codifying the 2026-08-27 finding. The load
      // generator is the demo's ONLY metrics emitter, it runs in the primary region, and
      // EMF metrics materialize in the region of the emitter's log group — including
      // every Region=us-west-2 series. Failover moves where requests are SERVED, not
      // where the emitter writes. The previous value (this.region) left the standby
      // dashboard structurally empty: its widgets queried a CloudWatch namespace nothing
      // ever writes, and the comment here claimed the widgets would "fill after a
      // failover", which was wrong and discovered mid-demo. Dashboard widgets support
      // cross-region metrics; alarms do NOT, which is why the alarm gate below stays
      // primary-only.
      metricsRegion: PRIMARY_REGION,
      // The baseline ClientAvailability alarm only where client metrics can EXIST.
      // Under Option A the load generator — the demo's only EMF emitter; the app
      // emits nothing — runs in the primary region, and EMF metrics materialize in
      // the region of the log group. In the secondary this alarm would sit in
      // INSUFFICIENT_DATA for the life of the demo: an alarm over a namespace
      // nothing ever writes, which is a gray box on stage that invites exactly the
      // wrong question. The dashboard stays (its regional widgets fill after a
      // failover is narrated); the alarm goes.
      createBaselineAlarms: props.regionName === PRIMARY_REGION,
    });

    // Read-vs-write split (step 4c follow-up, 2026-08-26). Goal 2's on-stage
    // signature is writes failing while reads succeed — the aggregate availability
    // graph shows a park at ~75% without saying WHY. This row says why: two
    // availability lines from the Op-dimensioned family the locustfile emits
    // (OpSuccess/OpError, Op ∈ {read, write} — NEW names, so the alarm's Client*
    // identities are untouched). On a healthy failover both lines recover; with the
    // write path broken, the write line parks at 0 while the read line sits at 100 —
    // the runbook §6 "verify writes recover, not just reads" check, on the dashboard.
    //
    // BOTH REGIONS' dashboards, stamped with the PRIMARY metrics region — the same
    // 2026-08-27 correction as metricsRegion above. The earlier primary-only gate
    // reasoned from "EMF lands in the emitter's region", which is true, but the right
    // conclusion is cross-region widgets, not a bare standby dashboard: mid-demo the
    // standby dashboard is exactly the one on screen, and it showed nothing.
    {
      obs.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Availability by path — reads vs writes',
          width: 24,
          height: 6,
          region: PRIMARY_REGION,
          // Inline rather than obs.availabilityExpr: that helper hardcodes the metric
          // ids `s`/`e`, and two expressions sharing one GraphWidget collide on them
          // (CannotShareSameIdForDifferentMetrics — synth catches it, found 2026-08-26).
          left: [
            new cloudwatch.MathExpression({
              expression: '100 * rs / (rs + re)',
              usingMetrics: {
                rs: obs.metric('OpSuccess', { Op: 'read' }),
                re: obs.metric('OpError', { Op: 'read' }),
              },
              label: 'Read path availability %',
              // Match the construct's 1-minute convention; without this the expression
              // defaults to 5m and CDK warns it is overriding the child metric periods.
              period: cdk.Duration.minutes(1),
            }),
            new cloudwatch.MathExpression({
              expression: '100 * ws / (ws + we)',
              usingMetrics: {
                ws: obs.metric('OpSuccess', { Op: 'write' }),
                we: obs.metric('OpError', { Op: 'write' }),
              },
              label: 'Write path availability %',
              // Match the construct's 1-minute convention; without this the expression
              // defaults to 5m and CDK warns it is overriding the child metric periods.
              period: cdk.Duration.minutes(1),
            }),
          ],
          leftYAxis: { min: 0, max: 100 },
        }),
      );
    }

    // 4) AUTHORED: EKS control plane, L1.
    //
    // L1 rather than the `eks.Cluster` L2 deliberately. At the pinned aws-cdk-lib
    // 2.248.0 the L2 requires an `ILayerVersion kubectlLayer` prop and no
    // `@aws-cdk/lambda-layer-kubectl-*` package is installed; the older layer packages
    // are deprecated. Taking the L2 path would add a NEW dependency (breaking the
    // pinned-cdkVersion posture) plus a kubectl-provider custom resource. L1 keeps the
    // stack a pure declaration. If a future need genuinely requires the L2, SAY SO and
    // stop rather than bumping silently.
    const clusterRole = new iam.Role(this, 'ClusterRole', {
      assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
      ],
    });

    const isolatedSubnetIds = this.network.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    }).subnetIds;

    const cluster = new eks.CfnCluster(this, 'Cluster', {
      name: `${props.appId}-${props.regionName}`,
      roleArn: clusterRole.roleArn,
      // PINNED. Unset, EKS picks its current default at create time, so the same
      // template yields a different Kubernetes version months later — and Karpenter's
      // support matrix is version-bound. See KUBERNETES_VERSION in regions.ts.
      version: KUBERNETES_VERSION,
      resourcesVpcConfig: {
        subnetIds: isolatedSubnetIds,
        securityGroupIds: [baselineSg.securityGroup.securityGroupId],
        // Private-only endpoint: reachability stays gated by the AllowedCidr baseline.
        endpointPublicAccess: false,
        endpointPrivateAccess: true,
      },
      accessConfig: {
        // MANDATORY, and the CFN default is the broken value.
        //
        // Clusters created through the EKS API, the SDKs or CloudFormation default to
        // `CONFIG_MAP`; only the console defaults to `API_AND_CONFIG_MAP`. Under
        // CONFIG_MAP, EKS **access entries do nothing** — and the ARC Region switch EKS
        // scaling block needs an access entry for its execution role, because IAM lets
        // it CALL EKS while Kubernetes RBAC is what lets it act INSIDE the cluster.
        // Leaving this unset means synth is green, the deploy succeeds, plan evaluation
        // may pass (the IAM permissions really are correct) and the failover's scaling
        // step fails at execution time. The only alternative is the legacy aws-auth
        // ConfigMap, which needs kubectl → the L2 → the dependency rejected above.
        //
        // API_AND_CONFIG_MAP rather than API: keeps a manual break-glass path alongside
        // access entries. The EKS transition is one-way
        // (CONFIG_MAP → API_AND_CONFIG_MAP → API), so this is easier to widen than undo.
        authenticationMode: 'API_AND_CONFIG_MAP',
        // FALSE, and this is a deliberate reversal of the step 2 choice.
        //
        // When true, the cluster-creator principal — the CI deploy role, assumed by a
        // runner on the public internet — gets a standing cluster-admin access entry. With
        // the API endpoint private that grant is INERT (the runner cannot reach the API
        // server), so it buys nothing while remaining a live path the moment anyone widens
        // the endpoint. The only principal that needs cluster access is the in-VPC
        // installer, which gets its own access entry.
        //
        // Break-glass is unaffected: access entries are created through the EKS control
        // API, which IS reachable from anywhere, so an operator can grant themselves one
        // and then reach the API server from inside the VPC. Nothing here is a one-way
        // door except the property itself — changing it later REPLACES the cluster, which
        // is why it is being set now, while nothing is deployed.
        bootstrapClusterCreatorAdminPermissions: false,
      },
    });

    // 5) AUTHORED: managed node group.
    //
    // ARM64 / GRAVITON, and the architecture is FORCED by the build, not chosen for cost.
    //
    // The application image is built by kaniko on the shared GitLab runner fleet, which
    // is arm64 (`tags: ['arch:arm64']`). kaniko CANNOT cross-build: its --custom-platform
    // flag rewrites the platform recorded in the image config without changing what the
    // build produces (GoogleContainerTools/kaniko#1587, #2127). So an image built there
    // contains arm64 binaries whatever it claims. Scheduled onto an x86_64 node it fails
    // with `exec format error` in CrashLoopBackOff — nothing in the build, the synth or
    // the CloudFormation deploy says a word.
    //
    // This REPLACES the AL2023_x86_64_STANDARD / m5.large pairing from step 2, which was
    // written before there was an image to run and would have failed on first contact
    // with a pod. The alternative fix — pinning the container build job to an amd64
    // runner — depends on a runner tag this fleet may not offer, and could not be
    // verified from here; the node architecture is entirely within our control.
    //
    // amiType matters for step 6: the standard EKS-optimized AL2023 AMI is
    // what the shipped FIS network faults reach via aws:ssm:send-command, together with
    // AmazonSSMManagedInstanceCore on the node role below. The arm64 variant is the same
    // AMI family, so that property is unchanged — but it is an ASSERTION carried over
    // from step 2 and still wants confirming against a live node before step 6 relies on
    // it. A later swap to Bottlerocket or a custom AMI must re-verify it too.
    const nodeRole = new iam.Role(this, 'NodeRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        'AmazonEKSWorkerNodePolicy',
        'AmazonEKS_CNI_Policy',
        'AmazonEC2ContainerRegistryReadOnly',
        'AmazonSSMManagedInstanceCore',
      ].map((n) => iam.ManagedPolicy.fromAwsManagedPolicyName(n)),
    });

    // IMDS HOP LIMIT 2, VIA A LAUNCH TEMPLATE -- codifying the 2026-08-27 live hot-fix.
    //
    // EKS managed node groups default to HttpPutResponseHopLimit=1, and pods on the pod
    // network need TWO hops to reach IMDSv2. With no IRSA (deliberate -- see the secret
    // grant below), the pods' ONLY credential source is the node role via IMDS, so hop
    // limit 1 means boto3 finds no credentials at all: the app 500s every request with
    // "Unable to locate credentials" while probes (which make no AWS call) stay green.
    // The Karpenter EC2NodeClass already sets 2 (k8s/karpenter-nodepool.yaml); this
    // brings the managed nodes into line. NOTE: adding/changing the launch template
    // ROLLS THE NODE GROUP on deploy (node replacement, pods rescheduled).
    const nodeLaunchTemplate = new ec2.CfnLaunchTemplate(this, 'NodeLaunchTemplate', {
      launchTemplateData: {
        metadataOptions: {
          httpTokens: 'required',
          httpPutResponseHopLimit: 2,
        },
      },
    });

    // LOGICAL ID 'NodesV2', DELIBERATELY NOT 'Nodes'. The EKS API refuses to ADD a
    // launch template to an existing node group -- attempt 13 failed live with
    // "A LaunchTemplate cannot be added to a Nodegroup after it has already been
    // created" (synth cannot see this; only an update against a live node group can).
    // Changing the logical ID makes CloudFormation REPLACE the node group: the new one
    // is created WITH the template first, then the old one is drained and deleted in
    // the cleanup phase. No nodegroupName is set, so EKS generates a fresh name and
    // there is no name collision during the overlap.
    const nodeGroup = new eks.CfnNodegroup(this, 'NodesV2', {
      clusterName: cluster.ref,
      nodeRole: nodeRole.roleArn,
      subnets: isolatedSubnetIds,
      launchTemplate: {
        id: nodeLaunchTemplate.ref,
        version: nodeLaunchTemplate.attrLatestVersionNumber,
      },
      amiType: 'AL2023_ARM_64_STANDARD',
      // Graviton. Note the enum spelling asymmetry in the EKS API, which is easy to get
      // wrong by pattern-matching: the x86 value lowercases the arch
      // (`AL2023_x86_64_STANDARD`) while the arm value does not and carries an extra
      // underscore (`AL2023_ARM_64_STANDARD`). Verified against
      // aws-cdk-lib/aws-eks NodegroupAmiType rather than inferred.
      // t4g.large: Graviton BURSTABLE — same 8 GiB and the SAME 29-pod ENI ceiling as the
      // m7g.large it replaced, ~18% cheaper, and this tier is idle-mostly (the system
      // controllers + two app pods; surge lands on Karpenter). Sizing is bound by POD
      // SLOTS, not CPU: these two nodes host the whole system tier (Argo CD ~8 pods, LBC,
      // Karpenter, CoreDNS, metrics-server, chart-repo, replica-reporter) plus two of the
      // three anti-affinity app pods — a .medium's 8-pod ENI cap cannot hold that without
      // CNI prefix delegation, so the cost lever is the burstable family, not the size.
      instanceTypes: ['t4g.large'],
      // A warm-standby floor in both regions.
      //
      // maxSize is headroom for an OPERATOR or a node autoscaler, NOT for ARC. The ARC
      // plan's EKSResourceScaling step scales the Deployment through the `scale`
      // subresource; it never asks this node group for anything, so a larger maxSize gives
      // that step nothing on its own. An earlier version of this comment claimed otherwise.
      //
      // Under Option C the surge lands on Karpenter-provisioned nodes instead (step 11),
      // which is what makes AWS's own description of the scaling block — "leveraging your
      // node auto-scaler to increase node capacity if necessary" — actually true here.
      scalingConfig: { minSize: 2, maxSize: 6, desiredSize: 2 },
    });

    // ── Karpenter IAM, instance profile and discovery tags (step 11a) ────────────────────
    //
    // Option C: the managed node group above carries BASELINE capacity; Karpenter provisions
    // the SURGE that ARC's failover scale-up needs. The two coexist by design — AWS's FAQ
    // calls the mixed model the common case: "NodePools are designed to work alongside
    // static capacity management solutions like EKS Managed Node Groups."
    //
    // Only IAM and tagging live here. The controller install (11b) and the
    // EC2NodeClass/NodePool (11c) are Kubernetes objects applied by the in-VPC installer,
    // and the app's pod anti-affinity (11d) MUST NOT land before those — required
    // anti-affinity with no node autoscaler would leave ARC's third and fourth replicas
    // Pending forever, breaking the failover this demo exists to show.
    const karpenter = new KarpenterIam(this, 'Karpenter', {
      // The LITERAL name, deliberately: KarpenterIam also uses this value as an IAM
      // condition map KEY (aws:ResourceTag/kubernetes.io/cluster/<name>), and CDK
      // refuses tokens as map keys (KeyMustResolveToString). The dependency the
      // literal fails to carry is restored explicitly below.
      clusterName: cluster.name!,
      oidcIssuerUrl: cluster.attrOpenIdConnectIssuerUrl,
      networkScope: this.network,
    });
    // REQUIRED, not belt-and-suspenders: the construct's AccessEntry create handler
    // calls EKS by name, and with only a literal string CloudFormation sees no edge --
    // it raced the ~10-minute cluster creation and 404'd the whole first live deploy
    // (rollback, 2026-08-26). This orders every Karpenter resource behind the cluster;
    // none of them is on the critical path before the cluster exists anyway.
    karpenter.node.addDependency(cluster);

    // 5b) AUTHORED: the application image, and the permission its pods need.
    //
    // This is what closes the defect that stopped Phase 5: the demo is a multi-region
    // EKS demo whose premise is that degrading EKS nodes degrades what clients see, and
    // until there is a workload on these clusters, injecting a node fault moves nothing a
    // client can observe.
    //
    // The asset is declared in BOTH region stacks on purpose. build/container-plan.sh
    // dedups by content hash, so one image is BUILT, while each stack resolves
    // `imageUri` against its OWN region's ECR registry — which is what the pod in that
    // region must pull from.
    const appImage = new ecrAssets.DockerImageAsset(this, 'AppImage', {
      directory: path.join(__dirname, '..', '..', 'app'),
      // MUST match the node group's architecture — see the node group comment. Declaring
      // it here is what puts `linux/arm64` into the asset manifest and therefore onto
      // kaniko's command line.
      platform: ecrAssets.Platform.LINUX_ARM64,
    });

    // Pods have no IAM identity of their own: this cluster has no OIDC provider and no
    // IRSA (deliberately — that would need the EKS L2 and the kubectl-layer dependency
    // step 2 rejected). So a pod's credentials are the NODE's, and the secret grant has
    // to land on the node role.
    //
    // ON EVERY NODE ROLE, not just the managed node group's. Codifies the 2026-08-27
    // live hot-fix (inline policy demo-db-secret-read): anti-affinity plus a rollout
    // restart — or ARC's Day 2 scale-up, which is the whole demo — puts pods on
    // KARPENTER nodes, and a pod there fails with AccessDeniedException exactly when
    // the scaling matters. The statement is built once and applied to both roles so
    // they cannot drift.
    //
    // Scoped to this one secret by NAME with a wildcard for the 6-character suffix
    // Secrets Manager appends. The app looks the secret up by name rather than ARN,
    // because the secondary region reads a REPLICA whose name matches but whose ARN does
    // not — one policy shape, one manifest and one image then work in both regions.
    const dbSecretRead = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        cdk.Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          resourceName: `${props.appId}/db-credentials-*`,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    });
    nodeRole.addToPrincipalPolicy(dbSecretRead);
    // The Karpenter surge nodes carry the SAME grant — see the block comment above.
    karpenter.nodeRole.addToPrincipalPolicy(dbSecretRead);

    // The replica-reporter CronJob (k8s/app.yaml) publishes orders-api replica counts
    // via the node role over IMDS, exactly like the app reads its DB secret. BOTH node
    // roles need it: the reporter pod schedules wherever there is room, including
    // Karpenter surge nodes. `cloudwatch:PutMetricData` declares NO resource type
    // (bug class: an ARN-scoped statement would authorize nothing), so the scope is the
    // `cloudwatch:namespace` condition key instead — writes are confined to the demo's
    // own metric namespace.
    const putDemoMetrics = new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': DEMO_METRIC_NAMESPACE } },
    });
    nodeRole.addToPrincipalPolicy(putDemoMetrics);
    karpenter.nodeRole.addToPrincipalPolicy(putDemoMetrics);

    new cdk.CfnOutput(this, 'AppImageUri', {
      value: appImage.imageUri,
      description: 'Region-local ECR URI the app pods pull. Substituted into k8s/app.yaml.',
    });
    new cdk.CfnOutput(this, 'AppNamespace', { value: APP_NAMESPACE });

    // 5c) AUTHORED: the in-VPC manifest installer.
    //
    // The cluster API endpoint is private, so this is what actually applies the
    // Deployment, Service and schema Job. See AppInstaller for the full reasoning.
    const installer = new AppInstaller(this, 'Installer', {
      vpc: this.network.vpc,
      cluster,
      clusterName: `${props.appId}-${props.regionName}`,
      assetsBucketName: assetsBucketName.valueAsString,
    });
    new cdk.CfnOutput(this, 'InstallerProjectName', {
      value: installer.project.projectName,
      description: 'CodeBuild project the deploy task starts to apply the manifests.',
    });
    // POST-FAILOVER CLEANUP IS NOT HERE — deliberately. A RestoreSteadyStateFn Lambda
    // (target of an ARC postRecovery workflow) lived here for one commit, was deployed
    // and executed live (2026-08-27), then removed by operator decision in favor of
    // build/restore-steady-state.sh, which starts THIS installer project with a cleanup
    // buildspec override. See runbook §7b.
    // The EKS-managed cluster security group is what managed-node-group instances
    // actually carry, so it is the peer Aurora must admit — NOT the baseline SG passed to
    // resourcesVpcConfig, which applies to the control-plane ENIs. Exported because the
    // SECONDARY region's Aurora member lives in its own stack and cannot reference this.
    new cdk.CfnOutput(this, 'EksClusterSecurityGroupId', {
      value: cluster.attrClusterSecurityGroupId,
      description: 'SG carried by node-group instances; Aurora must allow 5432 from it.',
    });

    // 6) Primary Aurora member — PRIMARY REGION ONLY.
    //
    // The secondary member is NOT here. A member joins a global cluster by declaring
    // globalClusterIdentifier, which requires the global cluster to already exist, and
    // the global cluster adopts this primary. So the order is forced:
    //   RegionStack(primary) → GlobalDataStack → SecondaryDbStack
    // Putting the secondary member in this stack would place it at deploy position 2,
    // ahead of the global cluster it needs. See SecondaryDbStack.
    if (props.withPrimaryDatabase) {
      const member = new AuroraMember(this, 'PrimaryDb', {
        vpc: this.network.vpc,
        namePrefix: props.appId,
        // No joinGlobalClusterId: this is the SOURCE cluster. GlobalDataStack adopts it
        // via sourceDbClusterIdentifier. Setting globalClusterIdentifier here instead
        // reintroduces a CloudFormation delete-time 404 race.
      });

      // WITHOUT THIS THE APP CANNOT REACH THE DATABASE AT ALL.
      //
      // rds.DatabaseCluster creates its own security group that admits nothing; the L2
      // grants no ingress unless asked. Nothing in synth, the build or the deploy
      // notices — the pods start, pass a health probe that makes no database call, get
      // registered behind the load balancer, and every real request times out at the
      // connect. Using Peer.securityGroupId rather than importing the SG keeps this a
      // pure ingress rule on Aurora's own group and leaves the EKS-managed group alone.
      member.cluster.connections.allowDefaultPortFrom(
        ec2.Peer.securityGroupId(cluster.attrClusterSecurityGroupId),
        'EKS node group to Aurora',
      );

      // Replicate the credentials secret into the secondary region.
      //
      // The secret exists only here: a member that JOINS a global cluster inherits its
      // credentials by replication and declares no master username or password, so the
      // secondary region has no secret of its own. Without a replica the standby's pods
      // would have to read this region's secret cross-region — which makes the failover
      // TARGET depend on the region it is failing away from, at exactly the moment ARC
      // scales that region up and starts new pods. That is the wrong direction for a
      // resilience demo, and it is the kind of dependency that only bites during the
      // event it is supposed to survive.
      //
      // Reached through AuroraMember.credentialsSecret rather than `cluster.secret`.
      // `cluster.secret` is a SecretTargetAttachment, so casting it to CfnSecret compiles
      // and then silently drops the assignment — the property never appears in the
      // template. A test asserting ReplicaRegions is what caught that.
      if (props.replicateSecretToRegion) {
        const secretResource = member.credentialsSecret!.node
          .defaultChild as secretsmanager.CfnSecret;
        secretResource.replicaRegions = [{ region: props.replicateSecretToRegion }];
      }
      new cdk.CfnOutput(this, 'DbClusterArn', {
        value: member.cluster.clusterArn,
        description: 'Adopted by GlobalDataStack as the global cluster source.',
      });
      new cdk.CfnOutput(this, 'DbClusterIdentifier', {
        value: member.cluster.clusterIdentifier,
      });
      new cdk.CfnOutput(this, 'DbReaderEndpoint', {
        value: member.cluster.clusterReadEndpoint.hostname,
        description: 'Local read endpoint — reads stay in-region, across two AZ readers.',
      });
      new cdk.CfnOutput(this, 'DbSecretArn', {
        value: member.cluster.secret!.secretArn,
      });
      // The NAME, not the ARN, is what the app uses — see the grant above and
      // src/app/common.py. Emitted so both regions' manifests substitute one value.
      new cdk.CfnOutput(this, 'DbSecretName', {
        value: `${props.appId}/db-credentials`,
        description: 'Secret name, identical in the primary and its replica region.',
      });

      // 5b) The three-alarm split (step 5, OBS-002) — PRIMARY ONLY, inside the
      // withPrimaryDatabase gate because (a) the corroboration rows need the primary
      // cluster identifier and (b) every metric the alarms read lives in this region:
      // the load generator here is the demo's only emitter, and CloudWatch alarms
      // cannot read across regions. See AuroraObservability's placement note for why
      // this deliberately deviates from the OBS-002 changeset's per-region wiring.
      const auroraObs = new AuroraObservability(this, 'AuroraObservability', {
        observability: obs,
        dbClusterIdentifier: member.cluster.clusterIdentifier,
      });
      // ARNs onto the dotenv rail for the singleton stacks that consume alarm STATE:
      // the guardrail is step 6's FIS stopConditionAlarm; the app-health pair is
      // step 8's associatedAlarms. The decision alarm is exported for the runbook's
      // console deep-link ONLY — wiring it to anything is the C-001 violation.
      new cdk.CfnOutput(this, 'GuardrailAlarmArn', {
        value: auroraObs.guardrailAlarm.alarmArn,
        description: 'FIS stop condition (step 6). Fires only on catastrophic collapse.',
      });
      new cdk.CfnOutput(this, 'DecisionAlarmArn', {
        value: auroraObs.decisionAlarm.alarmArn,
        description: 'Operator decision signal. Wired to NOTHING by design (C-001).',
      });
      REGIONS.forEach((r, i) => {
        new cdk.CfnOutput(this, `AppHealthAlarmArn${i}`, {
          value: auroraObs.appHealthAlarms.get(r.name)!.alarmArn,
          description: `ARC associatedAlarms (step 8): availability served by ${r.name}.`,
        });
      });

      // 5c) FAILURE INJECTION (step 6) — the FIS half, PRIMARY REGION ONLY.
      //
      // The gray failure is scoped to us-east-2 by design: the secondary is the healthy
      // region the operator switches TO, and injecting there would remove the thing the
      // demo is switching to. Everything below is INERT AT DEPLOY — an FIS experiment
      // TEMPLATE injects nothing until someone calls fis:StartExperiment.
      //
      // L2/L3 — per-AZ FIS templates targeting the EKS NODES.
      //
      // AZ LIST: Fn.getAzs/Fn.select over AZ_COUNT, NOT `Stack.of(this).availabilityZones`.
      // That property was verified offline and is wrong here in two different ways: with
      // account+region it returns the literal strings ['dummy1a','dummy1b','dummy1c']
      // (a Placement.AvailabilityZone filter for `dummy1a` resolves ZERO targets, so the
      // injection is a silent no-op), and with region only — which is what app.ts passes —
      // it returns just TWO tokens, quietly covering 2 of our 3 AZs and making a
      // "region-wide" blast radius narrower than advertised. Fn::GetAZs resolves at
      // DEPLOY time to the real AZ names, and is the same list ParameterizedVpc placed
      // the subnets across, so the templates and the nodes cannot disagree.
      const azList = cdk.Fn.getAzs(cdk.Aws.REGION);
      const fis = new FisNetworkExperiments(this, 'Fis', {
        availabilityZones: Array.from({ length: AZ_COUNT }, (_, i) =>
          cdk.Fn.select(i, azList),
        ),
        // Tag-selected, and the tag is applied EXTERNALLY at arm time by
        // build/start-region-wide-injection.sh. That is deliberate: managed-node-group
        // instances are owned by an AWS-managed ASG and CDK cannot tag them, and making
        // tagging the arming gesture means an un-armed experiment resolves no targets
        // and does nothing.
        target: {
          resourceType: 'aws:ec2:instance',
          resourceTags: { ChaosAllowed: 'true' },
        },
        // L2 collapses into L3: egress latency toward the database dependency rather
        // than a separate storage-fault construct. The PRIMARY cluster's writer endpoint
        // is used rather than the Aurora GLOBAL writer endpoint — the global endpoint
        // only exists after the globaldata stack, which deploys AFTER this one, and
        // while the primary holds the writer both names resolve to the same address.
        // The injection window is before the failover by definition.
        //
        // BOTH endpoints, and the READER is not optional. The app splits its traffic:
        // writes go to the writer endpoint and reads go to `cluster-ro-*` (common.py,
        // and the DbReaderEndpoint output above). A writer-only Sources list therefore
        // reaches reads ONLY when both names happen to resolve to the same instance —
        // true for a single-instance cluster, which is exactly why the 2026-09-01
        // latency calibration appeared to work. On a cluster with a separate reader the
        // same templates would leave every read untouched while still reporting success,
        // and the calibrated read amplification (~12.3x) is measured on the read path,
        // so the shipped severity values would silently stop meaning anything.
        networkSources: [
          member.cluster.clusterEndpoint.hostname,
          member.cluster.clusterReadEndpoint.hostname,
        ],
        // F-003: the GUARDRAIL (50%), never the decision signal (99%). A stop condition
        // on the decision signal would halt the experiment the moment the operator got
        // their reason to act, and the demo would heal itself before the human decided.
        stopConditionAlarm: auroraObs.guardrailAlarm,
        // 15 MINUTES, matched to the zonal shift's default lifetime rather than left at
        // something demo-length-agnostic. A zonal shift is temporary by design (ARC caps a
        // customer-initiated shift at 72h and requires an expiry up front), and the cockpit
        // defaults it to 15m. If the fault outlived the shift, the shift would expire
        // mid-experiment: availability would recover and then sag again with no operator
        // action, which on stage reads as the shift having FAILED rather than expired. The
        // two lifetimes must be equal or the fault must be the shorter of the pair.
        //
        // 30 minutes -- the previous value -- was also longer than any demo segment, so a
        // stopped-and-forgotten experiment kept injecting well past the discussion of it.
        duration: cdk.Duration.minutes(15),
        // 'DEFAULT' — a sentinel the SSM document understands, NOT a device name.
        //
        // The construct defaults to the literal 'ens5', which is a guess: AL2023 on
        // Graviton may or may not name the primary ENA device that, and a wrong name
        // makes the latency and packet-loss faults a NO-OP that still reports success.
        // AWS's own document reference removes the guess entirely — "Interface: Optional.
        // ALL and DEFAULT values are supported. The default is DEFAULT, which will target
        // the primary network interface for the Operating System." So the agent resolves
        // the interface on the host and nothing here has to know the instance family.
        networkInterface: 'DEFAULT',
        // SEVERITY IS CALIBRATED TO THE APP'S TIMEOUTS, not left at the construct
        // defaults. Every fault on the cockpit's menu must be able to force the failover
        // DECISION, so each must move CLIENT-PERCEIVED AVAILABILITY, so each must push a
        // request past a timeout (common.py: connect_timeout=3s, read_timeout=5s, the
        // latter also the server-side statement_timeout).
        //
        // The construct defaults do NOT do that. Measured live 2026-09-01:
        //   100ms delay -> read p90   97ms -> 1,325ms, write p90 13ms -> 330ms, ZERO errors
        //   10% loss    -> read p90 ~1,100ms sustained,                         ZERO errors
        // Both were real injections. Neither failed one request: a slow request still
        // succeeds, and TCP retransmits absorb 10% loss completely.
        //
        // A fault's delay is AMPLIFIED by the database round trips per request, which that
        // same measurement gives directly: reads ~12.3x (+1,228ms per 100ms), writes ~3.2x
        // (+317ms per 100ms). Reads therefore cross the 5s read timeout at ~399ms of
        // injected delay; writes not until ~1.56s.
        //
        // SEVERITY HAS A CEILING AS WELL AS A FLOOR, found live at 14:47 UTC 2026-09-01 by
        // overshooting it. At 500ms EVERY read failed (availability 0%, read p90 pinned at
        // 5,012ms = the timeout clipping it), which breached the 50%
        // ClientAvailabilityGuardrail, and FIS halted the experiment on its own stop
        // condition ~3 minutes in: "Experiment halted by stop condition." The demo healed
        // itself before an operator could decide anything -- precisely what the F-003 note
        // above guards against, reached from the other direction.
        //
        // Usable window:  50% guardrail  <  target  <  ~99% decision alarm.
        // The band is landed by putting the amplified p90 JUST UNDER the timeout, so only
        // the SLOW TAIL of the round-trip distribution crosses it. At 400ms the amplified
        // p90 is ~4.9s (inside 5s), so reads slower than p90 fail and the rest do not;
        // writes (~3.0x measured, not the 3.2x modelled) sit near 1.2s and stay healthy.
        delay: cdk.Duration.millis(400),
        // 25%, calibrated between two live results: 10% was absorbed COMPLETELY by TCP
        // retransmission (zero errors), and 60% was never measured because the latency
        // overshoot proved the guardrail ceiling first -- 60% loss would near-certainly
        // blow through it the same way. 25% is the conservative step: enough to defeat
        // retransmission on the slow tail and to threaten the 3s connect timeout, low
        // enough to stay above the guardrail. Loss is the STOCHASTIC lever, so its band
        // comes from per-request variance rather than from a distribution edge.
        packetLossPercent: 25,
        // THE FOURTH FAULT: the AZ impairment. Stated explicitly (with the construct's
        // default three) because the default list predates it. Pause-Instance-Launches
        // needs the role that PROVISIONS instances -- Karpenter's controller. Without
        // blocking it, Karpenter replaces the stopped AZ's nodes within minutes and the
        // heal-race erases the beat the fault exists to create; the MNG's ASG is blocked
        // by the template's asg-insufficient-instance-capacity action (tagged at arm
        // time -- CloudFormation cannot tag an EKS-owned ASG).
        faults: ['latency', 'packet-loss', 'memory-stress', 'power-interruption', 'brownout'],
        instanceProvisioningRoleArns: [karpenter.controllerRole.roleArn],
        // THE FIFTH FAULT: the brownout -- the GRAY single-AZ beat (2026-09-02 design).
        // Same latency document, aimed at the pod<->NLB path instead of the database.
        //
        // Sources is the app record -- a SYNTH-TIME CONSTANT -- and that choice is
        // load-bearing three ways:
        //  * The NLB is Kubernetes-created, so its DNS name exists only after the
        //    installer runs, which is AFTER this stack deploys: threading the captured
        //    name in would leave the first deploy's template empty. The private-zone
        //    record aliases the ACTIVE region's NLB and the SSM document resolves it
        //    on-host via dig at experiment START, when it exists and points here (the
        //    fault menu is already primary-only-while-active).
        //  * With preserve_client_ip pinned off (k8s/app.yaml), every pod response --
        //    health checks AND client data -- is addressed to the NLB's ENI IPs, which
        //    is exactly what the record resolves to: one entry, whole path, nothing else.
        //  * The DB path is EXCLUDED BY CONSTRUCTION: Aurora's ENIs live in these same
        //    subnets, so CIDR exclusion is impossible -- naming the one legitimate
        //    destination is the only clean scope. 500ms on the DB path breached the 50%
        //    guardrail live (2026-09-01); a brownout that leaked into it would repeat that.
        //
        // SEVERITY, live-recalibrated 2026-09-03. Our vendored LBC HONORS the health-check
        // timeout annotation -- the target group reads timeout=2s (verified post-deploy),
        // contradicting the LBC docs' "controller currently ignores the timeout" claim the
        // first calibration (2,500ms) was built on. At 2,500ms the fault is NOT gray:
        // proven live 13:29 UTC, us-east-2c pinned SOLID unhealthy ~40s after tc landed
        // (every jittered check blew the 2s timeout) and the NLB routed around it inside a
        // minute -- a black shape, story over in 60 seconds.
        //
        // The same run measured CLIENT amplification empirically: p90 hit 8.7s at 2,500ms
        // of delay, i.e. a request pays ~3 shaped round trips, not one.
        //
        // 800ms +/- 400ms, and the FLAP THIS COMMENT ONCE PROMISED DOES NOT HAPPEN.
        // Retracted 2026-09-04 after two live runs at this exact severity
        // (EXPXEWF6Dbb2B6qiug, EXPhWdkgP52mRngRvz): the health check pays ONE shaped hop,
        // not 2-3, so its RTT tops out ~1.24s against the 2s timeout and 3/3 targets stay
        // HEALTHY for the whole window with zero errors. Clients pay ~2.8x: p90 ~2,240ms,
        // under the 5s read timeout, which puts the faulted zone at ~66% client-perceived
        // availability (measured) while the other two hold at 100%.
        //
        // The asymmetry is a CONSTRAINT, not a miss: a flap needs ~1,800-2,000ms of delay,
        // which puts client p90 at ~5.0-5.6s -- past the read timeout. Flapping checks and
        // surviving clients are mutually exclusive, so green-check-plus-slow-client IS the
        // target state. Two-sided and pinned by test; the runbook's triage now says to read
        // the p90 tile when the sag is missing, not to look for a flap.
        brownoutSources: [APP_RECORD_NAME],
        brownoutDelay: cdk.Duration.millis(800),
        brownoutJitter: cdk.Duration.millis(400),
        // MEMORY stress REPLACED cpu-stress on the fault menu. cpu-stress had no severity
        // knob left -- AWSFIS-Run-CPU-Stress already defaults to CPU=0 (all stressors) at
        // LoadPercent=100 -- and it still moved nothing, because this app is I/O bound on
        // Aurora rather than CPU bound. Memory pressure has a mechanism that reaches the
        // app: the kubelet evicts pods once the node crosses MemoryPressure, and evicted
        // pods fail real requests. It arrives over the same proven SSM path, so it needs no
        // new IAM and no cluster-endpoint change. 85% of node memory is the starting point;
        // like the other two it needs live calibration against the SAME two-sided window
        // (above the 50% guardrail, below the ~99% decision alarm).
      });

      // Template ids for the wrapper that starts every per-AZ experiment together —
      // the region-wide fan. The construct is per-AZ by design; starting them as a
      // group is what makes the blast radius a region rather than one sick AZ.
      new cdk.CfnOutput(this, 'FisLatencyTemplateIds', {
        value: cdk.Fn.join(',', fis.latencyExperiments.map((e) => e.ref)),
        description: 'Per-AZ latency experiment templates (start together).',
      });
      new cdk.CfnOutput(this, 'FisPacketLossTemplateIds', {
        value: cdk.Fn.join(',', fis.packetLossExperiments.map((e) => e.ref)),
        description: 'Per-AZ packet-loss experiment templates (start together).',
      });
      // PAIRED az=templateId, for the SINGLE-AZ fault. The unpaired lists above are all the
      // region-wide fan needs -- it starts every template together, so order is irrelevant. A
      // single-AZ fault must start the template for ONE NAMED AZ, and picking that by list
      // position would inject into a different AZ than the operator was told about: the fault
      // reports success and a different line moves on the chart. Paired by name at the source
      // (FisNetworkExperiments.templatesByAz).
      new cdk.CfnOutput(this, 'FisLatencyTemplatesByAz', {
        value: cdk.Fn.join(',', Object.entries(fis.templatesByAz)
          .filter(([, byFault]) => byFault.latency)
          .map(([az, byFault]) => `${az}=${byFault.latency}`)),
        description: 'az=templateId pairs for the single-AZ latency fault.',
      });
      new cdk.CfnOutput(this, 'FisPacketLossTemplatesByAz', {
        value: cdk.Fn.join(',', Object.entries(fis.templatesByAz)
          .filter(([, byFault]) => byFault['packet-loss'])
          .map(([az, byFault]) => `${az}=${byFault['packet-loss']}`)),
        description: 'az=templateId pairs for the single-AZ packet-loss fault.',
      });
      new cdk.CfnOutput(this, 'FisPowerTemplatesByAz', {
        value: cdk.Fn.join(',', Object.entries(fis.templatesByAz)
          .filter(([, byFault]) => byFault['power-interruption'])
          .map(([az, byFault]) => `${az}=${byFault['power-interruption']}`)),
        description: 'az=templateId pairs for the single-AZ power-interruption fault.',
      });
      new cdk.CfnOutput(this, 'FisBrownoutTemplatesByAz', {
        value: cdk.Fn.join(',', Object.entries(fis.templatesByAz)
          .filter(([, byFault]) => byFault.brownout)
          .map(([az, byFault]) => `${az}=${byFault.brownout}`)),
        description: 'az=templateId pairs for the single-AZ brownout (gray) fault.',
      });
      // The power-interruption template's 2-minute network blip targets subnets by THIS
      // tag + a per-AZ filter. Applied as a synth-time aspect over the network construct
      // (raw CfnSubnets -- taggable L1s) rather than at arm time: subnets are static
      // infrastructure, and the per-AZ filter in each template bounds the blip to the
      // faulted zone. The network is isolated-only, so this reaches exactly the demo
      // VPC's subnets and nothing else.
      cdk.Tags.of(this.network).add('AzImpairmentPower', 'DisruptSubnet', {
        includeResourceTypes: ['AWS::EC2::Subnet'],
      });
      new cdk.CfnOutput(this, 'FisMemoryStressTemplateIds', {
        value: cdk.Fn.join(',', fis.memoryStressExperiments.map((e) => e.ref)),
        description: 'Per-AZ CPU-stress experiment templates (start together).',
      });
      new cdk.CfnOutput(this, 'NodeGroupName', {
        // THE BARE NODE GROUP NAME, not the CloudFormation Ref.
        //
        // `AWS::EKS::Nodegroup`'s Ref is the physical id `<clusterName>/<nodegroupName>`,
        // and NOTHING accepts that: `eks describe-nodegroup --nodegroup-name` rejects it
        // with "The nodegroup name parameter contains invalid characters. It should conform
        // to the regular expression ^[0-9A-Za-z][A-Za-z0-9-_]*" because of the slash.
        // Proven live 2026-09-01 — the cockpit threaded this value, every stack deployed
        // green, and FIS arming failed at runtime with exactly that message.
        //
        // build/start-region-wide-injection.sh has the same requirement (it passes this to
        // describe-nodegroup) and its docstring points operators at this output, so the
        // composite form was a latent trap there too.
        value: cdk.Fn.select(1, cdk.Fn.split('/', nodeGroup.ref)),
        description: 'Managed node group NAME (no cluster prefix) — arming tags its instances.',
      });
      // The FIS SERVICE role, exported so a caller that starts these templates can scope
      // its `iam:PassRole` to this EXACT role rather than a name prefix. FIS requires the
      // caller to pass it, which makes PassRole the one privilege-escalation-adjacent
      // grant in the cockpit's role — and a name-prefix wildcard on a generated role name
      // is the loosest part of that grant. Threading the real ARN closes it.
      new cdk.CfnOutput(this, 'FisRoleArn', {
        value: fis.role.roleArn,
        description: 'FIS service role. Consumers scope iam:PassRole to exactly this ARN.',
      });
      // AZ name -> ID map for the zonal-shift control. The two halves of the AZ story
      // disagree on identifier type for the SAME zone: the FIS templates above filter by
      // AZ NAME (us-east-2a), but StartZonalShift.awayFrom takes the AZ ID (use2-az1).
      // The name->ID mapping is ACCOUNT-SPECIFIC — AWS shuffles it per account — so it
      // cannot be hardcoded and cannot be derived by string rule. It is looked up live at
      // deploy time (a real DescribeAvailabilityZones against the real account) and
      // threaded as explicit name=id PAIRS, never as two positional lists: positional
      // correlation across the dotenv rail is the silent-mis-binding shape that cost this
      // project a day (bug class 19). A wrong pairing here mis-binds awayFrom SILENTLY —
      // the shift reports ACTIVE and drains a different AZ than the fault is degrading —
      // so build/verify-zonal-shift-azs.py re-derives the map live post-deploy and fails
      // the deploy loudly on any divergence (bug class 18).
      const azMap = new cr.AwsCustomResource(this, 'AzNameIdMap', {
        onUpdate: {
          service: 'EC2',
          action: 'describeAvailabilityZones',
          parameters: {
            Filters: [{ Name: 'region-name', Values: [this.region] }],
          },
          physicalResourceId: cr.PhysicalResourceId.of(`az-map-${this.region}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['ec2:DescribeAvailabilityZones'],
            // DescribeAvailabilityZones declares no resource type, so it cannot be
            // resource-scoped (the fis:List* shape, bug class 22c).
            resources: ['*'],
          }),
        ]),
      });
      new cdk.CfnOutput(this, 'AzNameIdPairs', {
        value: cdk.Fn.join(',', Array.from({ length: AZ_COUNT }, (_, i) =>
          cdk.Fn.join('=', [
            azMap.getResponseField(`AvailabilityZones.${i}.ZoneName`),
            azMap.getResponseField(`AvailabilityZones.${i}.ZoneId`),
          ]))),
        description: 'AZ name=id pairs (e.g. us-east-2a=use2-az1). StartZonalShift.awayFrom '
          + 'needs the ID; FIS filters by the name. Verified live post-deploy by '
          + 'build/verify-zonal-shift-azs.py (bug classes 18/19).',
      });
      new cdk.CfnOutput(this, 'EncryptionKeyArn', { value: member.encryptionKey.keyArn });
    }

    // Outputs later increments consume via the dotenv → CfnParameter path. Region is
    // emitted now because every downstream stack keys its parameters off it.
    new cdk.CfnOutput(this, 'Region', { value: this.region });
    new cdk.CfnOutput(this, 'VpcId', { value: this.network.vpc.vpcId });

    // Karpenter values the installer (11b) and the EC2NodeClass (11c) need. Exported so
    // they travel the same CfnOutput -> dotenv rail as every other deploy-time value,
    // rather than being reconstructed by string-building an ARN in a script.
    // AWS Load Balancer Controller IRSA (single-AZ / zonal-shift feature). REUSES Karpenter's
    // OIDC provider: IAM allows exactly one per issuer URL, so creating a second here fails
    // the deploy with EntityAlreadyExists -- a message that reads like a stack-naming problem.
    //
    // Installed in BOTH regions, not just the primary. AppInstaller is instantiated inside
    // THIS per-region stack and applies the same k8s/app.yaml to each cluster, so the moment
    // the app Service carries LBC annotations the standby needs the controller too or its
    // Service never provisions an NLB -- and the standby is the region ARC switches TO.
    const lbc = new LbcIam(this, 'Lbc', {
      clusterName: cluster.name!,
      oidcProviderArn: karpenter.oidcProviderArn,
      oidcIssuerUrl: cluster.attrOpenIdConnectIssuerUrl,
    });

    // Cluster-wide pod log shipping. Installed in BOTH regions: the standby is the region
    // ARC switches TO, so it must already be shipping logs when it starts serving -- adding
    // collection after a failover means the failover itself was never observed.
    //
    // REUSES Karpenter's OIDC provider, like LbcIam, because IAM allows exactly one per
    // issuer URL. Owns its own log group so the grant cannot drift from its target.
    const fluentBit = new FluentBitIam(this, 'FluentBit', {
      appId: props.appId,
      clusterName: cluster.name!,
      oidcProviderArn: karpenter.oidcProviderArn,
      oidcIssuerUrl: cluster.attrOpenIdConnectIssuerUrl,
    });

    new cdk.CfnOutput(this, 'FluentBitRoleArn', { value: fluentBit.shipperRole.roleArn });
    new cdk.CfnOutput(this, 'PodLogGroupName', { value: fluentBit.logGroup.logGroupName });
    new cdk.CfnOutput(this, 'FluentBitImageRepo', {
      value: `${cdk.Aws.ACCOUNT_ID}.dkr.ecr.${cdk.Aws.REGION}.amazonaws.com/eks-mr-demo/mirror/aws-for-fluent-bit`,
    });

    new cdk.CfnOutput(this, 'KarpenterControllerRoleArn', {
      value: karpenter.controllerRole.roleArn,
    });
    new cdk.CfnOutput(this, 'KarpenterInstanceProfile', {
      value: karpenter.instanceProfile.ref,
    });
    new cdk.CfnOutput(this, 'KarpenterNodeRoleArn', { value: karpenter.nodeRole.roleArn });
    // The EKS-owned CLUSTER security group. The EC2NodeClass selects it BY ID because
    // CloudFormation cannot tag a group EKS owns -- and it must be this one specifically,
    // since the NodePort 30000-32767 ingress rules live here. A surge pod on a node with any
    // other group would be unreachable by the in-tree load balancer.
    new cdk.CfnOutput(this, 'KarpenterSecurityGroupId', {
      value: cluster.attrClusterSecurityGroupId,
    });
    // The mirror repository for the controller image, assembled here rather than in a shell
    // script so the account and region come from the deploying stack instead of being
    // string-built at deploy time.
    // The mirror PREFIX, for manifests that repoint several images at once (Argo CD's
    // install references argocd, redis and dex). KarpenterImageRepo below is the same idea
    // at finer granularity -- a full repo path including the image name. Both exist because
    // Karpenter's manifest was rendered before this prefix did; the prefix is the better
    // pattern for anything referencing more than one image.
    new cdk.CfnOutput(this, 'MirrorRegistry', {
      value: `${cdk.Aws.ACCOUNT_ID}.dkr.ecr.${cdk.Aws.REGION}.amazonaws.com/eks-mr-demo/mirror`,
    });
    new cdk.CfnOutput(this, 'KarpenterImageRepo', {
      value: `${cdk.Aws.ACCOUNT_ID}.dkr.ecr.${cdk.Aws.REGION}.amazonaws.com/eks-mr-demo/mirror/karpenter-controller`,
    });
    // Load Balancer Controller values the installer needs. Same CfnOutput -> dotenv rail.
    new cdk.CfnOutput(this, 'LbcControllerRoleArn', { value: lbc.controllerRole.roleArn });
    new cdk.CfnOutput(this, 'LbcImageRepo', {
      value: `${cdk.Aws.ACCOUNT_ID}.dkr.ecr.${cdk.Aws.REGION}.amazonaws.com/eks-mr-demo/mirror/aws-load-balancer-controller`,
    });
    // The controller CANNOT discover these in a private cluster: with no reachable IMDS it
    // cannot infer the cluster name, the VPC or the region, and it exits at startup naming
    // the missing flag -- which reads as a bad image rather than missing configuration.
    new cdk.CfnOutput(this, 'LbcVpcId', { value: this.network.vpc.vpcId });
    new cdk.CfnOutput(this, 'VpcCidrOut', { value: this.vpcCidr.valueAsString });
    // SecondaryDbStack imports this region's VPC from these three rather than calling
    // Vpc.fromLookup, which would need account credentials at SYNTH time — credentials
    // the build stage deliberately does not have. Order of the two lists must match.
    new cdk.CfnOutput(this, 'IsolatedSubnetIds', {
      value: cdk.Fn.join(',', isolatedSubnetIds),
    });
    new cdk.CfnOutput(this, 'IsolatedSubnetAzs', {
      value: cdk.Fn.join(
        ',',
        this.network.vpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }).availabilityZones,
      ),
    });
    // Route tables the cross-region peering mesh adds peer routes to. The deploy task
    // threads these into the peering stack as REGION_<i>_ROUTETABLEIDS.
    new cdk.CfnOutput(this, 'RouteTableIds', {
      value: cdk.Fn.join(',', this.network.peeringRouteTableIds),
      description: 'Non-public subnet route tables; the peering mesh adds peer routes here.',
    });
    // The ARC plan's EksClusterProperty requires clusterArn — the ARN attribute, NOT
    // the cluster name. Its schema takes a MINIMUM of two clusters, satisfied by the
    // two-region topology.
    new cdk.CfnOutput(this, 'EksClusterArn', { value: cluster.attrArn });
    new cdk.CfnOutput(this, 'EksClusterName', { value: cluster.ref });

    // ---- L1 failure-injection knob (step 6) — BOTH REGIONS -------------------------
    //
    // The app-cooperative error-rate knob, and the reliable stage default for the gray
    // failure: deterministic, instant, and region-wide by construction because it is ONE
    // regional SSM parameter that the whole regional fleet reads. Seeded "0", so it is
    // inert at deploy.
    //
    // IN BOTH REGIONS, which deviates from the changeset's primary-only wiring, for two
    // reasons. First the mechanical one: `render-manifest.py` treats an explicitly EMPTY
    // placeholder as missing and refuses to emit the manifest, so the standby needs a
    // real parameter name — and pointing it at a name that does not exist would make
    // every standby request pay a failed SSM call before falling back to zero. Second,
    // after a failover Oregon IS the primary, so a demo that wants to inject there (or
    // fail back) needs a dial that exists. A dial set to zero is not an injection; the
    // things that actually inject — the FIS templates below — stay primary-only.
    const knob = new FailureInjectionParameter(this, 'Failure', {
      demoName: `${props.appId}-${props.regionName}`,
    });
    // The pods run under the NODE role (this demo has no IRSA), so that is the principal
    // that must be able to read the parameter. Without this grant error_rate.py swallows
    // the AccessDenied and returns 0 forever — the operator turns the knob and nothing
    // happens, with every deploy still green. The `ssm` interface endpoint added in step
    // 3b is what gives the isolated subnets a route to make the call at all.
    knob.grantRead(nodeRole);
    new cdk.CfnOutput(this, 'ErrorRateParamName', {
      value: knob.parameterName,
      description: 'L1 SSM error-rate knob. Read by the app via ERROR_RATE_PARAM.',
    });

    // ---- cross-region client reachability -----------------------------------------
    //
    // WITHOUT THIS RULE EVERY CROSS-REGION REQUEST TIMES OUT, with nothing else wrong.
    //
    // The load generator runs in ONE region and follows DNS to whichever region is
    // currently active, so after a failover its requests arrive here from the peer VPC.
    // Peering carries the packets. What stops them is the node security group, and the
    // reason is not obvious:
    //
    //   The in-tree Kubernetes service controller — the only one on this cluster —
    //   creates Network Load Balancers with INSTANCE targets exclusively. For instance
    //   target groups, CLIENT IP PRESERVATION IS ON BY DEFAULT. So the node does not see
    //   the load balancer's private address as the source; it sees the ORIGINAL CLIENT
    //   address, which lives in the peer region's CIDR. A rule admitting the load
    //   balancer is therefore not sufficient — the peer CIDR itself has to be admitted,
    //   on the NodePort range the Service is published on.
    //
    // AWS states the requirement plainly: "If your load balancer preserves client IP
    // addresses, add a rule that accepts traffic from the IP addresses of approved
    // clients on the traffic port."
    //
    // Turning client IP preservation off would be the alternative, but the in-tree
    // controller exposes no annotation for it — that is an AWS Load Balancer Controller
    // feature, and installing that controller is the dependency step 2 rejected.
    //
    // Declared as a parameter rather than a constant so a deploy-time CIDR override
    // (REGION_<i>_VPC_CIDR) can be matched here too, instead of silently drifting.
    if (props.peerVpcCidrs?.length) {
      const peerCidrs = new cdk.CfnParameter(this, 'PeerVpcCidrs', {
        type: 'CommaDelimitedList',
        default: props.peerVpcCidrs.join(','),
        description: 'CIDRs of peered VPCs in other regions, allowed to reach NodePorts.',
      });
      props.peerVpcCidrs.forEach((_, i) => {
        new ec2.CfnSecurityGroupIngress(this, `PeerNodePortIngress${i}`, {
          groupId: cluster.attrClusterSecurityGroupId,
          ipProtocol: 'tcp',
          // The Kubernetes default service NodePort range. The load balancer forwards to
          // a port in this range on the node, and with client IP preservation the source
          // address on that hop is the original cross-region client.
          fromPort: 30000,
          toPort: 32767,
          cidrIp: cdk.Fn.select(i, peerCidrs.valueAsList),
          description: 'Cross-region client to NodePort (client IP preservation is on)',
        });
      });
    }

    // ---- SAME-VPC client reachability (step 4c) -------------------------------------
    //
    // The load generator's Fargate task lives in THIS VPC's isolated subnets and hits
    // the same NLB — and client IP preservation applies identically: the node sees the
    // task's address in this VPC's own CIDR, not the load balancer's. The in-tree
    // controller MAY manage node-security-group client rules for the NLBs it creates,
    // but that behaviour cannot be verified offline, and if it does not, the demo's own
    // traffic source times out with peering, DNS and every health check green — the
    // exact failure shape the peer rule above exists for. A redundant rule is harmless;
    // a missing one is a silent timeout. This also deterministically admits the NLB
    // health checks, which source from load balancer node addresses inside this CIDR.
    new ec2.CfnSecurityGroupIngress(this, 'LocalNodePortIngress', {
      groupId: cluster.attrClusterSecurityGroupId,
      ipProtocol: 'tcp',
      fromPort: 30000,
      toPort: 32767,
      cidrIp: this.vpcCidr.valueAsString,
      description: 'Same-VPC client to NodePort (client IP preservation is on)',
    });
  }
}
