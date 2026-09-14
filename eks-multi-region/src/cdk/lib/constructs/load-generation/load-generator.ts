import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { DEMO_METRIC_NAMESPACE, DEMO_METRIC_NAMESPACE_ENV_VAR } from '../observability/metric-namespace.js';

/**
 * The generic base-container build context vendored alongside this construct
 * (`constructs/src/load-generation/container/`). A demo overrides it via
 * {@link LoadGeneratorProps.workloadDirectory} to drop its own locustfile + helper
 * modules. The Dockerfile `COPY . .` makes overlays ride along without changing the
 * cross-provider build path (changeset §3d).
 *
 * Resolved relative to `__dirname` exactly as the other vendored-asset constructs do
 * (`peering-mesh.ts` / `inject-api.ts`); projen runs `cdk synth` via ts-node in CJS and
 * the library build emits the same `__dirname` reference, so a vendored copy under a
 * demo's `src/cdk/lib/constructs/load-generation/` finds its sibling `container/`.
 */
const DEFAULT_CONTAINER_DIR = path.join(__dirname, 'container');

/**
 * Properties for {@link LoadGenerator} (changeset §2).
 *
 * Generic extraction of five-nines `ClientWorkloadStack` with the CloudFront
 * prefix-list ingress, the dual-region hedging, and the execute-api specifics
 * stripped out. Target wiring (URL/path/method/extra env), rate controls, Fargate
 * sizing, and architecture are all props; the architecture prop drives BOTH the image
 * platform AND the task `runtimePlatform` so they can never drift (the
 * client-workload-stack.ts:153-158 failure mode).
 */
export interface LoadGeneratorProps {
  /** VPC to run the Locust Fargate service in. */
  readonly vpc: ec2.IVpc;

  /**
   * Subnet selection for the task. Default PRIVATE_WITH_EGRESS. Demos on a
   * fully-isolated VPC (no NAT) must pass PRIVATE_ISOLATED and provide ECR /
   * ECR_DOCKER / CLOUDWATCH_LOGS VPC endpoints (changeset §5c).
   */
  readonly taskSubnets?: ec2.SubnetSelection;

  // ---- target (system-under-test) -----------------------------------------
  /** Primary target base URL. A CDK token (ApiGateway url / ALB DNS) is fine. */
  readonly targetUrl: string;
  /** Path the default task hits. Default '/'. */
  readonly targetPath?: string;
  /** HTTP method the default task uses. Default 'GET'. */
  readonly httpMethod?: string;
  /** Extra env vars injected into the container (multi-endpoint demos). */
  readonly extraTargets?: { [envVarName: string]: string };

  // ---- rate controls (Locust user count x wait time) ----------------------
  readonly users?: number;
  readonly spawnRate?: number;
  readonly minWaitSeconds?: number;
  readonly maxWaitSeconds?: number;
  readonly requestTimeoutSeconds?: number;

  // ---- observability -------------------------------------------------------
  /**
   * EMF namespace the container emits into. MUST equal the observability
   * dashboard's namespace AND be in the same region as this task's log group.
   * Defaults to the shared {@link DEMO_METRIC_NAMESPACE} constant. C3: the
   * construct injects this into the container under the env var name
   * `DEMO_METRIC_NAMESPACE` (NOT `EMF_NAMESPACE`) so the base locustfile and the
   * observability Python helper read the same variable.
   */
  readonly emfNamespace?: string;
  /** Log group name. Default `/<construct-id>/loadgen`. */
  readonly logGroupName?: string;
  readonly logRetention?: logs.RetentionDays;

  // ---- Fargate sizing / arch ----------------------------------------------
  readonly cpu?: number;
  readonly memoryLimitMiB?: number;
  readonly desiredCount?: number;
  /**
   * Image + task arch. Default ARM64. The image `platform` and the task
   * `runtimePlatform.cpuArchitecture` are BOTH derived from this so they can
   * never drift (client-workload-stack.ts:153-158).
   */
  readonly architecture?: ecs.CpuArchitecture;

  // ---- workload definition -------------------------------------------------
  /**
   * Build context for the container. Default: the vendored base-container dir
   * (changeset §3). A demo overrides this to point at its own dir that
   * adds/overrides locustfile.py + helper modules.
   */
  readonly workloadDirectory?: string;

  // ---- web UI --------------------------------------------------------------
  /**
   * Expose the Locust web UI behind an internal ALB. Default false (headless,
   * `--headless` run controlled by users/spawnRate).
   */
  readonly exposeWebUi?: boolean;
}

/**
 * On-demand Locust-on-Fargate load generator (changeset §2).
 *
 * ONE {@link ecr_assets.DockerImageAsset} is the single source of truth for both CI
 * providers' container-build paths (changeset §4): GitLab builds it via kaniko+crane,
 * GitHub via `cdk deploy`/`cdk-assets`. The Dockerfile carries NO `--platform` — the
 * platform comes from the asset, derived from {@link LoadGeneratorProps.architecture}.
 */
export class LoadGenerator extends Construct {
  /** ARM64-by-default Locust container; single source of truth for both CI providers. */
  public readonly image: ecr_assets.DockerImageAsset;
  /** The ECS service (ALB-fronted when exposeWebUi, else plain Fargate). */
  public readonly service: ecs.FargateService;
  /** CloudWatch log group the awslogs driver ships EMF stdout to. */
  public readonly logGroup: logs.LogGroup;
  public readonly logGroupName: string;
  /** Internal ALB facets — only populated when exposeWebUi. */
  public readonly loadBalancer?: elbv2.IApplicationLoadBalancer;
  public readonly loadBalancerDnsName?: string;
  public readonly loadBalancerArn?: string;

  constructor(scope: Construct, id: string, props: LoadGeneratorProps) {
    super(scope, id);

    const arch = props.architecture ?? ecs.CpuArchitecture.ARM64;
    const platform =
      arch === ecs.CpuArchitecture.ARM64
        ? ecr_assets.Platform.LINUX_ARM64
        : ecr_assets.Platform.LINUX_AMD64;

    // SINGLE SOURCE OF TRUTH (changeset §4e). No --platform in the Dockerfile.
    this.image = new ecr_assets.DockerImageAsset(this, 'LoadGenImage', {
      directory: props.workloadDirectory ?? DEFAULT_CONTAINER_DIR,
      platform,
    });

    this.logGroup = new logs.LogGroup(this, 'LoadGenLogs', {
      logGroupName: props.logGroupName ?? `/${id}/loadgen`,
      retention: props.logRetention ?? logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.logGroupName = this.logGroup.logGroupName;

    const environment: Record<string, string> = {
      TARGET_URL: props.targetUrl,
      TARGET_PATH: props.targetPath ?? '/',
      HTTP_METHOD: props.httpMethod ?? 'GET',
      REQUEST_TIMEOUT: String(props.requestTimeoutSeconds ?? 5),
      // C3: env var name standardized to DEMO_METRIC_NAMESPACE (shared with the
      // observability Python helper); value defaults to the shared constant.
      [DEMO_METRIC_NAMESPACE_ENV_VAR]: props.emfNamespace ?? DEMO_METRIC_NAMESPACE,
      MIN_WAIT: String(props.minWaitSeconds ?? 0.5),
      MAX_WAIT: String(props.maxWaitSeconds ?? 1.0),
      // Headless run controls (ignored by the web UI when exposeWebUi).
      LOCUST_USERS: String(props.users ?? 10),
      LOCUST_SPAWN_RATE: String(props.spawnRate ?? 10),
      LOCUST_WEB_UI: props.exposeWebUi ? 'true' : 'false',
      ...(props.extraTargets ?? {}),
    };

    const runtimePlatform: ecs.RuntimePlatform = {
      cpuArchitecture: arch,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    };
    const logDriver = ecs.LogDrivers.awsLogs({
      logGroup: this.logGroup,
      streamPrefix: 'loadgen',
    });

    if (props.exposeWebUi) {
      const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadGenLB', {
        vpc: props.vpc,
        internetFacing: false,
        vpcSubnets: props.taskSubnets,
      });
      const svc = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'LoadGen', {
        vpc: props.vpc,
        cpu: props.cpu ?? 512,
        memoryLimitMiB: props.memoryLimitMiB ?? 1024,
        desiredCount: props.desiredCount ?? 1,
        minHealthyPercent: 100,
        loadBalancer,
        taskSubnets: props.taskSubnets,
        runtimePlatform,
        taskImageOptions: {
          image: ecs.ContainerImage.fromDockerImageAsset(this.image),
          containerPort: 8089,
          environment,
          logDriver,
        },
      });
      svc.targetGroup.configureHealthCheck({ path: '/', healthyHttpCodes: '200' });
      this.service = svc.service;
      this.loadBalancer = loadBalancer;
      this.loadBalancerDnsName = loadBalancer.loadBalancerDnsName;
      this.loadBalancerArn = loadBalancer.loadBalancerArn;
    } else {
      // Headless: plain FargateService; the container runs `locust --headless`
      // with users/spawn-rate from env (the entrypoint honors them).
      const taskDef = new ecs.FargateTaskDefinition(this, 'LoadGenTask', {
        cpu: props.cpu ?? 512,
        memoryLimitMiB: props.memoryLimitMiB ?? 1024,
        runtimePlatform,
      });
      taskDef.addContainer('loadgen', {
        image: ecs.ContainerImage.fromDockerImageAsset(this.image),
        environment,
        logging: logDriver,
      });
      this.service = new ecs.FargateService(this, 'LoadGen', {
        cluster: new ecs.Cluster(this, 'Cluster', { vpc: props.vpc }),
        taskDefinition: taskDef,
        desiredCount: props.desiredCount ?? 1,
        vpcSubnets: props.taskSubnets,
      });
    }
  }
}
