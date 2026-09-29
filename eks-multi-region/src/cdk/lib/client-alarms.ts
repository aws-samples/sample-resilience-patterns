import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { DemoObservability } from './constructs/observability';
import { REGIONS, recordSetIdentifier } from '../regions';

export interface ClientAlarmsProps {
  /** The baseline the decision alarm is REUSED from, never rebuilt (OBS-002, rule 6). */
  readonly observability: DemoObservability;
}

/**
 * The alarms over the client's view of the demo (step 5, OBS-002). Extends the vendored
 * `DemoObservability` by COMPOSITION — it does not subclass and does not re-implement
 * (rule 6: one observability system).
 *
 * Two alarm roles, two distinct jobs:
 *
 *   1. DECISION SIGNAL — the operator's reason to act. Wired to NOTHING (C-001: a
 *      human approves the failover). Reused verbatim from the baseline.
 *   2. APPLICATION HEALTH — step 8's `associatedAlarms`, one per Region DIMENSION.
 *      Measures where traffic actually lands; recovery = the standby's alarm
 *      reaching OK after the switch.
 *
 * THERE IS NO FIS GUARDRAIL ANY MORE. An earlier revision carried a third alarm at 50%
 * availability as the stop condition on every FIS experiment. It was removed together
 * with the load generator's move to the observer region: FIS requires a stop-condition
 * alarm to live in the experiment's region (us-east-2), and this construct now lives
 * where the client metrics land (us-east-1). Every experiment is bounded instead by its
 * fixed 15-minute duration and the cockpit's Stop button. The guardrail's only live
 * firings had been the trap the runbook warns about — the demo healing itself before the
 * operator had decided anything — so nothing the demo relies on was lost.
 *
 * PLACEMENT. This construct is instantiated in the LOAD GENERATOR's stack, in the
 * OBSERVER region, and nowhere else. The load generator is the demo's ONLY metric
 * emitter (the app emits nothing), EMF metrics materialize in the region of the LOG
 * GROUP, and CloudWatch alarms cannot read across regions — so the alarms have to sit
 * with the emitter. Dashboards CAN read across regions, which is why both workload
 * regions' dashboards stay where they are and point their widgets here. Step 8 consumes
 * the app-health alarms by ARN, which is region-qualified, so ARC reads them from
 * anywhere.
 *
 * EXPECTED STATE ON STAGE: decision OK, primary app health OK — and the STANDBY app
 * health in ALARM, deliberately. Its missing-data mode is BREACHING and no traffic lands
 * in Oregon until the failover flips DNS, so it opens red and its transition to OK IS
 * the measured recovery. Narrate it; do not "fix" it.
 */
export class ClientAlarms extends Construct {
  /** Role 1 — pass-through to the baseline alarm. Operator-watched; wired to nothing. */
  public readonly decisionAlarm: cloudwatch.Alarm;
  /** Role 2 — step 8's associatedAlarms, keyed by region name. */
  public readonly appHealthAlarms: Map<string, cloudwatch.Alarm>;

  constructor(scope: Construct, id: string, props: ClientAlarmsProps) {
    super(scope, id);

    const obs = props.observability;

    // Role 1 — reuse, never rebuild. The baseline's defaults (99, 3-of-5,
    // NOT_BREACHING, no action) already say "sustained, not a blip; a telemetry gap
    // must not masquerade as a decision".
    if (!obs.availabilityAlarm) {
      throw new Error(
        'ClientAlarms requires the baseline ClientAvailabilityAlarm — ' +
        'it IS the decision signal. Do not disable createBaselineAlarms here.',
      );
    }
    this.decisionAlarm = obs.availabilityAlarm;

    // Role 2 — application health, one alarm per Region DIMENSION (both live HERE —
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
  }
}
