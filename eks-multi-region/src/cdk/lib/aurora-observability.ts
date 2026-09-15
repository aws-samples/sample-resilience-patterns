import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { DemoObservability } from './constructs/observability';
import { REGIONS, recordSetIdentifier } from '../regions';

export interface AuroraObservabilityProps {
  /** The existing baseline — role 1 is REUSED from it, never rebuilt (OBS-002, rule 6). */
  readonly observability: DemoObservability;
  /** Primary Aurora cluster identifier, for the dashboard corroboration rows. */
  readonly dbClusterIdentifier: string;
}

/**
 * The three-alarm split (step 5, OBS-002). Extends the vendored `DemoObservability` by
 * COMPOSITION — it does not subclass and does not re-implement (rule 6: one
 * observability system).
 *
 * Three alarms, three distinct jobs, and conflating any two breaks the demo:
 *
 *   1. DECISION SIGNAL — the operator's reason to act. Wired to NOTHING (C-001: a
 *      human approves the failover). Reused verbatim from the baseline.
 *   2. FIS GUARDRAIL — step 6's stopConditionAlarm. Catastrophic-only, threshold
 *      STRICTLY below the decision threshold so it cannot fire first and
 *      self-terminate the injection before the operator has decided anything.
 *   3. APPLICATION HEALTH — step 8's `associatedAlarms`, one per Region DIMENSION.
 *      Measures where traffic actually lands; recovery = the standby's alarm
 *      reaching OK after the switch.
 *
 * PLACEMENT — one deliberate deviation from the OBS-002 changeset, forced by Option A.
 * The changeset had every RegionStack instantiate this extension. That was written
 * before the load-generator decision: under Option A there is ONE load generator, in
 * the primary region, and it is the demo's ONLY metric emitter (the app emits nothing).
 * EMF metrics materialize in the region of the LOG GROUP, so every metric this demo
 * has — including `RegionSuccess{Region=us-west-2}` — lives in us-east-2, and
 * CloudWatch alarms cannot read across regions. An instance of this construct in the
 * secondary region would be alarms over a namespace nothing ever writes: the
 * "UI field nothing supplies" defect, in alarm form. So this construct is instantiated
 * in the PRIMARY RegionStack only, and carries the app-health alarms for BOTH Region
 * dimensions. Step 8 consumes them by ARN, which is region-qualified, so ARC reads
 * them from anywhere.
 *
 * EXPECTED STATE ON STAGE: decision OK, guardrail OK, primary app health OK — and the
 * STANDBY app health in ALARM, deliberately. Its missing-data mode is BREACHING and no
 * traffic lands in Oregon until the failover flips DNS, so it opens red and its
 * transition to OK IS the measured recovery. Narrate it; do not "fix" it.
 */
export class AuroraObservability extends Construct {
  /** Role 1 — pass-through to the baseline alarm. Operator-watched; wired to nothing. */
  public readonly decisionAlarm: cloudwatch.Alarm;
  /** Role 2 — step 6's stopConditionAlarm. */
  public readonly guardrailAlarm: cloudwatch.Alarm;
  /** Role 3 — step 8's associatedAlarms, keyed by region name. */
  public readonly appHealthAlarms: Map<string, cloudwatch.Alarm>;

  constructor(scope: Construct, id: string, props: AuroraObservabilityProps) {
    super(scope, id);

    const obs = props.observability;

    // Role 1 — reuse, never rebuild. The baseline's defaults (99, 5-of-3,
    // NOT_BREACHING, no action) already say "sustained, not a blip; a telemetry gap
    // must not masquerade as a decision".
    if (!obs.availabilityAlarm) {
      throw new Error(
        'AuroraObservability requires the baseline ClientAvailabilityAlarm — ' +
        'it IS the decision signal. Do not disable createBaselineAlarms here.',
      );
    }
    this.decisionAlarm = obs.availabilityAlarm;

    // Role 2 — the guardrail. SAME availability expression as role 1, so the two are
    // strictly comparable and 50 < 99 provably cannot trip first. BREACHING: total
    // telemetry loss also stops the injection. 2-of-2 consecutive: a genuine collapse
    // stops FIS fast, no M-of-N smoothing.
    this.guardrailAlarm = new cloudwatch.Alarm(this, 'GuardrailAlarm', {
      alarmName: `${cdk.Stack.of(this).stackName}-ClientAvailabilityGuardrail`,
      alarmDescription:
        'FIS stop condition: client availability collapsed below 50%. ' +
        'Strictly below the 99% decision threshold so it cannot fire first.',
      metric: obs.availabilityExpr(
        obs.metric('ClientSuccess'),
        obs.metric('ClientError'),
        'Client-Perceived Availability % (guardrail)',
      ),
      threshold: 50,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      // No action: FIS consumes alarm STATE as a stop condition, not SNS.
    });

    // Role 3 — application health, one alarm per Region DIMENSION (both live HERE —
    // see the placement note above). BREACHING: no telemetry in a region means that
    // region is not serving, which for the recovery measure is the truth.
    this.appHealthAlarms = new Map(
      REGIONS.map((r) => [
        r.name,
        new cloudwatch.Alarm(this, `AppHealth${recordSetIdentifier(r.name)}`, {
          alarmName: `${cdk.Stack.of(this).stackName}-AppHealth-${r.name}`,
          alarmDescription:
            `Availability of traffic served BY ${r.name} (Region dimension), ` +
            'read by the ARC plan as an application-health alarm. OK == serving.',
          metric: obs.availabilityExpr(
            obs.metric('RegionSuccess', { Region: r.name }),
            obs.metric('RegionError', { Region: r.name }),
            `Availability % served by ${r.name}`,
          ),
          threshold: 99,
          comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
          evaluationPeriods: 3,
          datapointsToAlarm: 3,
          treatMissingData: cloudwatch.TreatMissingData.BREACHING,
          // No action: ARC reads alarm state, not SNS.
        }),
      ]),
    );

    // Dashboard corroboration rows — operator context, NOT decision inputs. Native
    // AWS/RDS metrics that RDS itself emits (no dependency on anything we deploy):
    // replica lag sharpens a dependency-latency read, commit latency a write-path one.
    // The source's AuroraWriterActive confirmation row is deliberately ABSENT: it is a
    // custom metric emitted by an RPO-monitor Lambda this demo did not vendor, and a
    // widget over a metric nothing emits is the defect class this repo keeps finding.
    const rdsMetric = (name: string, statistic: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: name,
        dimensionsMap: { DBClusterIdentifier: props.dbClusterIdentifier },
        period: cdk.Duration.minutes(1),
        statistic,
      });
    obs.addMetricRow('Aurora corroboration — replica lag (ms)', [
      rdsMetric('AuroraReplicaLag', 'Maximum'),
    ]);
    obs.addMetricRow('Aurora corroboration — commit latency (ms)', [
      rdsMetric('CommitLatency', 'Average'),
    ]);
  }
}
