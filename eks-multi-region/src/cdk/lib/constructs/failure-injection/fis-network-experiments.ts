import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/** Fault types {@link FisNetworkExperiments} can generate. */
export type FisFault = 'latency' | 'packet-loss' | 'memory-stress' | 'power-interruption' | 'brownout';

/** Generic FIS target selector — decouples from the source's hardcoded ASG/RDS. */
export interface FisTarget {
  /** FIS resource type, e.g. `aws:ec2:instance` / `aws:ecs:task`. */
  readonly resourceType: string;
  /** Resource tag filters (e.g. `{ demo: 'my-demo' }`). */
  readonly resourceTags: Record<string, string>;
}

/**
 * Props for {@link FisNetworkExperiments}.
 *
 * SECOND, opt-in (heavier) failure-injection mechanism (failure-injection-changeset §5):
 * a generalized distillation of multi-az's `FaultInjectionStack`
 * (`fault-injection-stack.ts`). L1/`Cfn*` only — `aws-cdk-lib/aws-fis` has no L2.
 */
export interface FisNetworkExperimentsProps {
  /** AZs to create per-AZ experiment templates for (one set of faults per AZ). */
  readonly availabilityZones: string[];
  /**
   * Generic target selector. Filtered additionally by `Placement.AvailabilityZone`
   * per AZ. (Source hardcoded `IAutoScalingGroup` + `rds.DatabaseCluster`.)
   */
  readonly target: FisTarget;
  /**
   * Fault types to generate.
   * @default ['latency','packet-loss','memory-stress']
   */
  readonly faults?: FisFault[];
  /**
   * Egress hostnames for network faults (e.g. a DB endpoint). Source passed the RDS
   * cluster endpoint hostname.
   * @default []
   */
  readonly networkSources?: string[];
  /**
   * Latency injected by the latency fault.
   * @default Duration.millis(100)
   */
  readonly delay?: cdk.Duration;
  /**
   * Packet loss percent.
   * @default 10
   */
  readonly packetLossPercent?: number;
  /**
   * Percentage of node memory the memory-stress fault consumes.
   *
   * REQUIRED by AWSFIS-Run-Memory-Stress. This fault REPLACED cpu-stress, which could not
   * be made to move availability at all: that document already defaults to CPU=0 (all
   * stressors) at LoadPercent=100, and this app is I/O bound on Aurora rather than CPU
   * bound, so it ran flat out and changed nothing. Memory pressure has a mechanism that
   * does reach the app -- the kubelet evicts pods under MemoryPressure -- and it arrives
   * over the same already-proven SSM path, needing no new IAM and no cluster-endpoint
   * change.
   * @default 85
   */
  readonly memoryStressPercent?: number;
  /**
   * Per-experiment duration.
   * @default Duration.minutes(60)
   */
  readonly duration?: cdk.Duration;
  /**
   * CloudWatch alarm to auto-stop a running experiment (SAFETY DEFAULT). Strongly
   * recommended; sourced from the observability pattern. When supplied, the
   * experiment's `stopConditions` references this alarm's ARN. When omitted, falls back
   * to `[{ source: 'none' }]` — the recipe instructs builders to ALWAYS set one (the
   * source's `none` lets a 60-min experiment run unbounded — unsafe for a template).
   */
  readonly stopConditionAlarm?: cloudwatch.IAlarm;
  /** Log group for FIS experiment logs (created if omitted). */
  readonly logGroupName?: string;
  /** Log group retention. @default RetentionDays.ONE_WEEK */
  readonly logGroupRetention?: logs.RetentionDays;
  /** FIS log schema version. @default 2 */
  readonly logSchemaVersion?: number;
  /**
   * NIC name for network faults.
   * @default 'ens5'
   */
  readonly networkInterface?: string;
  /**
   * IAM role(s) that PROVISION instances — the `power-interruption` fault's
   * Pause-Instance-Launches target (`aws:ec2:api-insufficient-instance-capacity-error`
   * targets `aws:iam:role` by explicit ARN; it does not support tag targeting). For this
   * demo that is the Karpenter controller role: with the AZ's instances stopped, Karpenter
   * would otherwise replace them and heal the AZ before the operator acts. The ASG
   * relaunch path is blocked separately by Pause-ASG-Scaling. When omitted, the
   * power-interruption template simply carries no launch-pause action.
   */
  readonly instanceProvisioningRoleArns?: string[];
  /**
   * Egress destinations for the `brownout` fault — its OWN Sources list, deliberately
   * separate from {@link networkSources}. The region-wide faults shape latency toward the
   * DATABASE; the brownout shapes it toward the pod↔NLB data-plane path and must carry NO
   * database endpoint, or the amplified DB round trips put the zone through the 50%
   * guardrail (breached live at 500ms, 2026-09-01). Domain names are supported — the SSM
   * document resolves them on-host via dig at experiment start.
   *
   * REQUIRED when `faults` includes `'brownout'` (constructor throws otherwise): an empty
   * Sources shapes nothing while the experiment reports success — the recurring
   * "reports success, injected nothing" failure (docs/lessons.md #22).
   */
  readonly brownoutSources?: string[];
  /**
   * Brownout base delay. Calibrated against the LIVE 2s HTTP health-check timeout: our
   * vendored LBC HONORS the timeout annotation (read back from the target group
   * 2026-09-03, contradicting the LBC docs' "controller ignores the timeout" claim).
   *
   * The check pays ONE shaped hop, so at 800ms +/- 400ms its RTT tops out ~1.24s and
   * ALWAYS passes -- 3/3 targets stayed healthy through both live runs at this severity.
   * That is the intended state, not a shortfall: clients pay ~2.8 hops (p90 ~2,240ms
   * measured), which lands the faulted zone at ~66% client-perceived availability with
   * zero errors. An earlier version of this comment claimed the checks flap; they cannot,
   * and the retraction is recorded in docs/runbook.md. The superseded 2,500ms (calibrated
   * to a 6s timeout that turned out not to exist) pinned the zone SOLID unhealthy in ~40s,
   * proven live 2026-09-03 13:29 UTC -- a black shape from the gray fault.
   * @default Duration.millis(800)
   */
  readonly brownoutDelay?: cdk.Duration;
  /**
   * Brownout jitter. Jitter is the mechanism, not a garnish: it spreads the client latency
   * distribution across the SLO bar, which is what makes the faulted zone read ~66% rather
   * than 0% and stay visibly distinct from the black fault.
   * @default Duration.millis(400)
   */
  readonly brownoutJitter?: cdk.Duration;
  /**
   * Percent of flows the brownout shapes (the SSM document's FlowsPercent). A future
   * subtlety knob: at 100 every flow in the AZ is slow; lower values degrade a fraction.
   * @default 100
   */
  readonly brownoutFlowsPercent?: number;
}

/**
 * SECOND, opt-in FIS construct: generates per-AZ `fis.CfnExperimentTemplate`s for
 * network latency, packet loss, and CPU stress, targeting resources by a generic
 * `{ resourceType, resourceTags }` selector + per-AZ `Placement.AvailabilityZone` filter.
 *
 * Cleaned-up, generalized distillation of multi-az `fault-injection-stack.ts`. Key
 * reusability changes vs the source:
 *   1. Generic `{ resourceType, resourceTags }` target (source hardcoded ASG/RDS).
 *   2. `stopConditionAlarm` SAFETY DEFAULT (source shipped `stopConditions: none`).
 *   3. `faults` list is opt-in (default all three).
 *   4. Carries forward the `addOverride` casing fix for `logGroupArn`.
 *   5. Keeps the hardened FIS service role (6 AWS-managed FIS policies + scoped CWL
 *      policy + SourceAccount/SourceArn assume conditions).
 *
 * **Inert at deploy** (failure-injection-changeset §6): creating a `CfnExperimentTemplate`
 * injects NOTHING — faults only occur when an experiment is *started*
 * (`fis:StartExperiment`). Never instantiated by the always-on green skeleton.
 */
export class FisNetworkExperiments extends Construct {
  public readonly latencyExperiments: fis.CfnExperimentTemplate[] = [];
  public readonly packetLossExperiments: fis.CfnExperimentTemplate[] = [];
  public readonly memoryStressExperiments: fis.CfnExperimentTemplate[] = [];
  public readonly powerInterruptionExperiments: fis.CfnExperimentTemplate[] = [];
  public readonly brownoutExperiments: fis.CfnExperimentTemplate[] = [];
  /**
   * Per-AZ experiment templates keyed EXPLICITLY by AZ name, per fault.
   *
   * WHY THIS EXISTS RATHER THAN LETTING CONSUMERS ZIP THE ARRAYS ABOVE. Those arrays are
   * pushed in `props.availabilityZones` order, so a consumer CAN pair them by index -- and a
   * single-AZ fault selected by the wrong index injects into the wrong AZ, reports success,
   * and moves a different line on the chart than the one the operator was told about. This
   * repo has already lost a day to selecting an identifier by list position instead of by
   * matching a field (docs/lessons.md #18 and #19), so the pairing is built HERE, beside the
   * loop that creates it, and consumers read the name.
   */
  public readonly templatesByAz: Record<string, Record<string, string>> = {};

  public readonly role: iam.IRole;
  public readonly logGroup: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: FisNetworkExperimentsProps) {
    super(scope, id);

    const faults = props.faults ?? ['latency', 'packet-loss', 'memory-stress'];
    const networkInterface = props.networkInterface ?? 'ens5';
    const logSchemaVersion = props.logSchemaVersion ?? 2;
    const delay = props.delay ?? cdk.Duration.millis(100);
    const packetLossPercent = props.packetLossPercent ?? 10;
    const memoryStressPercent = props.memoryStressPercent ?? 85;
    const duration = props.duration ?? cdk.Duration.minutes(60);
    const sources = (props.networkSources ?? []).join(',');
    const durationIso = `PT${duration.toMinutes()}M`;
    const durationSeconds = duration.toSeconds().toString();
    const brownoutDelay = props.brownoutDelay ?? cdk.Duration.millis(800);
    const brownoutJitter = props.brownoutJitter ?? cdk.Duration.millis(400);
    const brownoutFlowsPercent = props.brownoutFlowsPercent ?? 100;
    const brownoutSources = (props.brownoutSources ?? []).join(',');
    if (faults.includes('brownout') && !brownoutSources) {
      // FAIL AT SYNTH, not at demo time: the SSM document requires Sources, and an empty
      // list would shape NOTHING while the experiment reports success -- the recurring
      // "reports success, injected nothing" failure mode (docs/lessons.md #22).
      throw new Error("faults includes 'brownout' but brownoutSources is empty");
    }

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: props.logGroupName,
      retention: props.logGroupRetention ?? logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Scoped CloudWatch Logs managed policy (fault-injection-stack.ts:111-160).
    const cloudWatchManagedPolicy = new iam.ManagedPolicy(this, 'CwManagedPolicy', {
      description: 'Allows FIS to write CWL',
      statements: [
        new iam.PolicyStatement({
          actions: [
            'logs:CreateLogStream',
            'logs:PutLogEvents',
            'logs:DescribeLogGroups',
            'logs:DescribeLogStreams',
          ],
          effect: iam.Effect.ALLOW,
          resources: [cdk.Fn.sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:*')],
        }),
        new iam.PolicyStatement({
          actions: [
            'logs:GetDelivery',
            'logs:GetDeliverySource',
            'logs:PutDeliveryDestination',
            'logs:GetDeliveryDestinationPolicy',
            'logs:DeleteDeliverySource',
            'logs:PutDeliveryDestinationPolicy',
            'logs:CreateDelivery',
            'logs:GetDeliveryDestination',
            'logs:PutDeliverySource',
            'logs:DeleteDeliveryDestination',
            'logs:DeleteDeliveryDestinationPolicy',
            'logs:DeleteDelivery',
          ],
          effect: iam.Effect.ALLOW,
          resources: [
            cdk.Fn.sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:delivery:*'),
            cdk.Fn.sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:delivery-source:*'),
            cdk.Fn.sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:delivery-destination:*'),
          ],
        }),
        new iam.PolicyStatement({
          actions: [
            'logs:DescribeDeliveryDestinations',
            'logs:DescribeDeliverySources',
            'logs:DescribeDeliveries',
            'logs:CreateLogDelivery',
          ],
          effect: iam.Effect.ALLOW,
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['logs:PutResourcePolicy', 'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups'],
          effect: iam.Effect.ALLOW,
          resources: [cdk.Fn.sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:*')],
        }),
      ],
    });

    // Hardened FIS service role: 6 AWS-managed FIS policies + scoped CWL policy
    // (fault-injection-stack.ts:164-200).
    const role = new iam.Role(this, 'FisRole', {
      description: 'The IAM role used by FIS',
      assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSFaultInjectionSimulatorEC2Access'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSFaultInjectionSimulatorECSAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSFaultInjectionSimulatorEKSAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSFaultInjectionSimulatorNetworkAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSFaultInjectionSimulatorRDSAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSFaultInjectionSimulatorSSMAccess'),
        cloudWatchManagedPolicy,
      ],
    });
    // SourceAccount / SourceArn assume conditions (fault-injection-stack.ts:182-200).
    const cfnRole = role.node.defaultChild as iam.CfnRole;
    cfnRole.assumeRolePolicyDocument = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: ['fis.amazonaws.com'] },
          Action: 'sts:AssumeRole',
          Condition: {
            StringEquals: { 'aws:SourceAccount': cdk.Fn.ref('AWS::AccountId') },
            ArnLike: {
              'aws:SourceArn': cdk.Fn.sub('arn:${AWS::Partition}:fis:${AWS::Region}:${AWS::AccountId}:experiment/*'),
            },
          },
        },
      ],
    };
    this.role = role;
    // POWER-INTERRUPTION grants, inline and ADDITIVE. The docs-published policy for the
    // AZ Availability: Power Interruption scenario requires `ec2:InjectApiError` for the
    // two insufficient-instance-capacity actions, conditioned on `ec2:FisActionId` — it
    // is not safe to assume the managed FIS policies above carry it (their content is
    // not readable from this account's ReadOnly role, verified 2026-09-02), and an
    // additive inline grant costs nothing when they do. `tag:GetResources` is FIS's
    // tag-based target resolution; `autoscaling:Describe*` resolves the ASG target.
    // None of the three declare a resource type, so `*` with conditions is the ONLY
    // authorizable form (bug class 22c / IAM resource-type scoping lesson).
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'PowerInterruptionInjectApiError',
      actions: ['ec2:InjectApiError'],
      resources: ['*'],
      conditions: {
        'ForAnyValue:StringEquals': {
          'ec2:FisActionId': [
            'aws:ec2:api-insufficient-instance-capacity-error',
            'aws:ec2:asg-insufficient-instance-capacity-error',
          ],
        },
      },
    }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'PowerInterruptionTargetResolution',
      actions: ['tag:GetResources', 'autoscaling:DescribeAutoScalingGroups'],
      resources: ['*'], // neither action declares a resource type
    }));

    // SAFETY DEFAULT: derive stopConditions from the alarm (NOT 'none').
    const stopConditions: fis.CfnExperimentTemplate.ExperimentTemplateStopConditionProperty[] =
      props.stopConditionAlarm
        ? [{ source: 'aws:cloudwatch:alarm', value: props.stopConditionAlarm.alarmArn }]
        : [{ source: 'none' }];

    // Loop AZs x faults, building a CfnExperimentTemplate each.
    props.availabilityZones.forEach((azName, i) => {
      // Populated per fault at the bottom of this iteration -- see the assignments after each
      // template is created. Declared here so the key exists even if a fault is skipped.
      this.templatesByAz[azName] = this.templatesByAz[azName] ?? {};
      const targets: Record<string, fis.CfnExperimentTemplate.ExperimentTemplateTargetProperty> = {
        oneAZ: {
          resourceType: props.target.resourceType,
          selectionMode: 'ALL',
          resourceTags: props.target.resourceTags,
          filters: [{ path: 'Placement.AvailabilityZone', values: [azName] }],
        },
      };

      if (faults.includes('latency')) {
        this.latencyExperiments.push(
          this.buildExperiment(`Az${i}Latency`, {
            roleArn: role.roleArn,
            description: `Adds network latency in ${azName}`,
            actions: {
              addLatency: {
                actionId: 'aws:ssm:send-command',
                parameters: {
                  documentArn: cdk.Fn.sub('arn:${AWS::Partition}:ssm:${AWS::Region}::document/AWSFIS-Run-Network-Latency-Sources'),
                  documentParameters: JSON.stringify({
                    Interface: networkInterface,
                    DelayMilliseconds: delay.toMilliseconds().toString(),
                    JitterMilliseconds: '10',
                    Sources: sources,
                    TrafficType: 'egress',
                    InstallDependencies: 'True',
                    DurationSeconds: durationSeconds,
                  }),
                  duration: durationIso,
                },
                targets: { Instances: 'oneAZ' },
              },
            },
            targets,
            stopConditions,
            tags: { Name: `Add Latency to ${azName}` },
            logConfiguration: {
              cloudWatchLogsConfiguration: { logGroupArn: this.logGroup.logGroupArn },
              logSchemaVersion,
            },
          }),
        );
        // Pair by NAME, recorded beside the creation loop -- never left to index order.
        this.templatesByAz[azName]['latency'] = this.latencyExperiments[this.latencyExperiments.length - 1].ref;
      }

      if (faults.includes('brownout')) {
        // THE GRAY AZ FAULT (design 2026-09-02): the SAME latency document, aimed at the
        // pod<->NLB path instead of the database. With client-IP preservation disabled on
        // the target group, every pod response -- health checks AND client data -- is
        // addressed to the NLB's ENI IPs, and `brownoutSources` (the app record, resolved
        // on-host by dig at experiment start) names exactly those IPs. So the zone's client
        // responses slow visibly while the DB path -- which shares these subnets and can
        // never be excluded by CIDR -- is untouched by construction. The health checks ride
        // the same path but pay only ONE shaped hop, so they keep PASSING: the platform
        // reports the zone healthy while ~a third of its customers are outside the 2s SLO
        // bar. Nothing stops, nothing evicts, no line snaps to 0: degradation with a
        // judgment call, beside (never replacing) the power interruption's black beat.
        this.brownoutExperiments.push(
          this.buildExperiment(`Az${i}Brownout`, {
            roleArn: role.roleArn,
            description: `Brownout (pod-to-NLB latency) in ${azName}`,
            actions: {
              addLatency: {
                actionId: 'aws:ssm:send-command',
                parameters: {
                  documentArn: cdk.Fn.sub('arn:${AWS::Partition}:ssm:${AWS::Region}::document/AWSFIS-Run-Network-Latency-Sources'),
                  documentParameters: JSON.stringify({
                    Interface: networkInterface,
                    DelayMilliseconds: brownoutDelay.toMilliseconds().toString(),
                    JitterMilliseconds: brownoutJitter.toMilliseconds().toString(),
                    Sources: brownoutSources,
                    FlowsPercent: brownoutFlowsPercent.toString(),
                    TrafficType: 'egress',
                    InstallDependencies: 'True',
                    DurationSeconds: durationSeconds,
                  }),
                  duration: durationIso,
                },
                targets: { Instances: 'oneAZ' },
              },
            },
            targets,
            stopConditions,
            tags: { Name: `Brownout in ${azName}` },
            logConfiguration: {
              cloudWatchLogsConfiguration: { logGroupArn: this.logGroup.logGroupArn },
              logSchemaVersion,
            },
          }),
        );
        // Pair by NAME, recorded beside the creation loop -- never left to index order.
        this.templatesByAz[azName]['brownout'] = this.brownoutExperiments[this.brownoutExperiments.length - 1].ref;
      }

      if (faults.includes('packet-loss')) {
        this.packetLossExperiments.push(
          this.buildExperiment(`Az${i}PacketLoss`, {
            roleArn: role.roleArn,
            description: `Drops packets in ${azName}`,
            actions: {
              packetLoss: {
                actionId: 'aws:ssm:send-command',
                parameters: {
                  documentArn: cdk.Fn.sub('arn:${AWS::Partition}:ssm:${AWS::Region}::document/AWSFIS-Run-Network-Packet-Loss-Sources'),
                  documentParameters: JSON.stringify({
                    Interface: networkInterface,
                    LossPercent: packetLossPercent.toString(),
                    Sources: sources,
                    TrafficType: 'egress',
                    InstallDependencies: 'True',
                    DurationSeconds: durationSeconds,
                  }),
                  duration: durationIso,
                },
                targets: { Instances: 'oneAZ' },
              },
            },
            targets,
            stopConditions,
            tags: { Name: `Add Packet Loss to ${azName}` },
            logConfiguration: {
              cloudWatchLogsConfiguration: { logGroupArn: this.logGroup.logGroupArn },
              logSchemaVersion,
            },
          }),
        );
        // Pair by NAME, recorded beside the creation loop -- never left to index order.
        this.templatesByAz[azName]['packet-loss'] = this.packetLossExperiments[this.packetLossExperiments.length - 1].ref;
      }

      if (faults.includes('memory-stress')) {
        this.memoryStressExperiments.push(
          this.buildExperiment(`Az${i}MemoryStress`, {
            roleArn: role.roleArn,
            description: `Runs memory stress in ${azName}`,
            actions: {
              memoryStress: {
                actionId: 'aws:ssm:send-command',
                parameters: {
                  documentArn: cdk.Fn.sub('arn:${AWS::Partition}:ssm:${AWS::Region}::document/AWSFIS-Run-Memory-Stress'),
                  // Percent is REQUIRED by AWSFIS-Run-Memory-Stress (unlike the CPU
                  // document, where every knob was optional and already maxed).
                  documentParameters: JSON.stringify({
                    Percent: memoryStressPercent.toString(),
                    Workers: '1',
                    DurationSeconds: durationSeconds,
                    InstallDependencies: 'True',
                  }),
                  duration: durationIso,
                },
                targets: { Instances: 'oneAZ' },
              },
            },
            targets,
            stopConditions,
            tags: { Name: `Add memory stress to ${azName}` },
            logConfiguration: {
              cloudWatchLogsConfiguration: { logGroupArn: this.logGroup.logGroupArn },
              logSchemaVersion,
            },
          }),
        );
        // Pair by NAME, recorded beside the creation loop -- never left to index order.
        this.templatesByAz[azName]['memory-stress'] = this.memoryStressExperiments[this.memoryStressExperiments.length - 1].ref;
      }

      if (faults.includes('power-interruption')) {
        // THE AZ IMPAIRMENT (design 2026-09-02) -- modeled on the FIS "AZ Availability:
        // Power Interruption" scenario, re-targeted to this demo's tag scheme and with the
        // scenario's `aws:arc:start-zonal-autoshift` recovery action ABSENT: the operator's
        // zonal shift from the cockpit IS the recovery beat, and FIS auto-shifting five
        // minutes in would steal it. (The docs-published scenario JSON does not carry the
        // autoshift action either -- the console adds it -- so authoring from that shape
        // strips it by construction; the synth test pins the absence anyway.)
        //
        // Four actions, and each is load-bearing:
        //  * stopInstances stops every ARMED instance in the AZ (ChaosAllowed=true covers
        //    BOTH the managed-node-group and Karpenter nodes, so the scenario's two
        //    separate stop actions collapse into one) and restarts them after `duration`.
        //  * pauseAsgScaling blocks the MNG's AWS-owned ASG from replacing them in-AZ --
        //    without it the ASG heals the AZ within minutes and the chart recovers WITHOUT
        //    the operator's shift. The ASG is tagged at ARM time (cockpit), since
        //    CloudFormation cannot tag an EKS-owned ASG.
        //  * pauseInstanceLaunches blocks the Karpenter controller role's launches in the
        //    AZ -- the Karpenter half of the same heal-race.
        //  * pauseNetworkConnectivity blackholes the AZ's tagged subnets for TWO MINUTES
        //    (the scenario's own value): long enough to force timeouts and DNS refresh,
        //    short enough that regional-service DNS recovers while the AZ stays dark.
        //
        // RDS/ElastiCache/EBS scenario actions are deliberately NOT carried: the region
        // story owns Aurora, and the others have no targets here. Target resolution stays
        // at the default FAIL mode -- a zero-target start dies loudly 1-3s in and the
        // cockpit's post-start GetExperiment check surfaces it (never a silent skip).
        const powerActions: Record<string, fis.CfnExperimentTemplate.ExperimentTemplateActionProperty> = {
          stopInstances: {
            actionId: 'aws:ec2:stop-instances',
            parameters: {
              completeIfInstancesTerminated: 'true',
              startInstancesAfterDuration: durationIso,
            },
            targets: { Instances: 'oneAZ' },
          },
          pauseAsgScaling: {
            actionId: 'aws:ec2:asg-insufficient-instance-capacity-error',
            parameters: {
              availabilityZoneIdentifiers: azName,
              duration: durationIso,
              percentage: '100',
            },
            targets: { AutoScalingGroups: 'armedAsgs' },
          },
          pauseNetworkConnectivity: {
            actionId: 'aws:network:disrupt-connectivity',
            parameters: { duration: 'PT2M', scope: 'all' },
            targets: { Subnets: 'oneAzSubnets' },
          },
        };
        const powerTargets: Record<string, fis.CfnExperimentTemplate.ExperimentTemplateTargetProperty> = {
          oneAZ: targets.oneAZ,
          armedAsgs: {
            resourceType: 'aws:ec2:autoscaling-group',
            selectionMode: 'ALL',
            resourceTags: props.target.resourceTags,
          },
          oneAzSubnets: {
            resourceType: 'aws:ec2:subnet',
            selectionMode: 'ALL',
            // Synth-time tag rather than the arm gesture: subnets are static
            // infrastructure. The per-AZ filter bounds the blip to THIS template's zone.
            //
            // These are NOT "the node subnets" -- an earlier version of this comment said
            // so and it cost hours on 2026-09-04. The private-isolated tier is shared by
            // the nodes AND the Aurora DB subnet group, so this blackhole cuts the
            // faulted zone's DATABASE instance too. That is survivable only because each
            // regional member now runs one instance per AZ (see AuroraMember); with the
            // single-instance cluster it replaced, faulting the writer's zone took the
            // whole region to 0.00% and FIS's own guardrail halted the experiment.
            resourceTags: { AzImpairmentPower: 'DisruptSubnet' },
            filters: [{ path: 'AvailabilityZone', values: [azName] }],
          },
        };
        if (props.instanceProvisioningRoleArns?.length) {
          powerActions.pauseInstanceLaunches = {
            actionId: 'aws:ec2:api-insufficient-instance-capacity-error',
            parameters: {
              availabilityZoneIdentifiers: azName,
              duration: durationIso,
              percentage: '100',
            },
            targets: { Roles: 'provisioningRoles' },
          };
          powerTargets.provisioningRoles = {
            resourceType: 'aws:iam:role',
            selectionMode: 'ALL',
            resourceArns: props.instanceProvisioningRoleArns,
          };
        }
        this.powerInterruptionExperiments.push(
          this.buildExperiment(`Az${i}PowerInterruption`, {
            roleArn: role.roleArn,
            description: `AZ power interruption in ${azName} (stop instances, pause scaling, 2-min network blip)`,
            actions: powerActions,
            targets: powerTargets,
            stopConditions,
            tags: { Name: `AZ power interruption in ${azName}` },
            logConfiguration: {
              cloudWatchLogsConfiguration: { logGroupArn: this.logGroup.logGroupArn },
              logSchemaVersion,
            },
          }),
        );
        // Pair by NAME, recorded beside the creation loop -- never left to index order.
        this.templatesByAz[azName]['power-interruption'] = this.powerInterruptionExperiments[this.powerInterruptionExperiments.length - 1].ref;
      }
    });
  }

  /**
   * Build one experiment template + carry forward the multi-az casing fix for
   * `logGroupArn` (fault-injection-stack.ts:268-269): the CDK L1 lower-cases the prop,
   * so re-set the PascalCase `LogGroupArn` and clear the camelCase one.
   */
  private buildExperiment(
    id: string,
    props: fis.CfnExperimentTemplateProps,
  ): fis.CfnExperimentTemplate {
    const exp = new fis.CfnExperimentTemplate(this, `${id}Template`, props);
    exp.addOverride('Properties.LogConfiguration.CloudWatchLogsConfiguration.LogGroupArn', this.logGroup.logGroupArn);
    exp.addOverride('Properties.LogConfiguration.CloudWatchLogsConfiguration.logGroupArn', undefined);
    return exp;
  }
}
