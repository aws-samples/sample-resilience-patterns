import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { DEMO_METRIC_NAMESPACE } from './metric-namespace.js'; // shared constant (changeset §4)

export interface DemoObservabilityProps {
  /** Logical demo name; used for dashboard + alarm naming. e.g. "MyResilienceDemo". */
  readonly demoName: string;

  /**
   * EMF metric namespace the workload emits into. MUST match the namespace the
   * EMF helper writes (changeset §4 — the shared constant eliminates the brittle string
   * coupling called out in five-nines AGENTS.md:40). Defaults to DEMO_METRIC_NAMESPACE.
   */
  readonly metricNamespace?: string;

  /**
   * Region where EMF metrics actually land (the log group's region). Every metric and
   * every widget is stamped with this so cross-region math expressions resolve, and the
   * dashboard SHOULD be deployed into this region. Defaults to cdk.Aws.REGION.
   * (See the five-nines dashboard-region-must-equal-EMF-region gotcha — changeset §5.)
   */
  readonly metricsRegion?: string;

  /** Default metric period. Defaults to 1 minute. (five-nines PERIOD, dashboard-stack.ts:8) */
  readonly period?: cdk.Duration;

  /**
   * Baseline client-availability alarm threshold (percent). Default 99.
   * Built from ClientSuccess/ClientError; sits in INSUFFICIENT_DATA until the workload
   * emits, then OK, so the stack deploys green with no workload.
   */
  readonly availabilityAlarmThreshold?: number;

  /** Create the baseline alarm. Default true. No SNS action by default (demo-safe). */
  readonly createBaselineAlarms?: boolean;

  /** Optional markdown appended under the header TextWidget (e.g. Locust deep-links). */
  readonly headerMarkdown?: string;
}

/**
 * Always-on, hand-rolled observability baseline over GA `aws-cdk-lib/aws-cloudwatch`
 * ONLY (changeset §2; research OQ1 — deliberately NOT @cdklabs/multi-az-observability).
 *
 * Creates a named dashboard with a header + a client-perceived-availability graph, ONE
 * baseline alarm (treatMissingData NOT_BREACHING, no SNS action) so an idle/empty demo
 * deploys green, and a dashboard-URL CfnOutput. Every metric and widget is stamped with
 * `metricsRegion` so dashboard region == EMF/log-group region (changeset §5).
 */
export class DemoObservability extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly availabilityAlarm?: cloudwatch.Alarm;

  private readonly namespace: string;
  private readonly metricsRegion: string;
  private readonly period: cdk.Duration;

  constructor(scope: Construct, id: string, props: DemoObservabilityProps) {
    super(scope, id);

    this.namespace = props.metricNamespace ?? DEMO_METRIC_NAMESPACE;
    this.metricsRegion = props.metricsRegion ?? cdk.Aws.REGION;
    this.period = props.period ?? cdk.Duration.minutes(1);
    const threshold = props.availabilityAlarmThreshold ?? 99;

    // --- Dashboard (named, always created) --------------------------------
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: props.demoName,
      periodOverride: cloudwatch.PeriodOverride.INHERIT, // mirror five-nines (dashboard-stack.ts:65-68)
    });

    // Row 1: header (generalized from dashboard-stack.ts:71-74)
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        width: 24,
        height: 2,
        markdown: `## ${props.demoName} — Observability\n\n${props.headerMarkdown ?? ''}`,
      }),
    );

    // Row 2: placeholder client-availability graph (generalized from dashboard-stack.ts:87-100)
    const clientAvailability = this.availabilityExpr(
      this.metric('ClientSuccess'),
      this.metric('ClientError'),
      'Client-Perceived Availability %',
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Client-Perceived Availability %',
        width: 24,
        height: 6,
        region: this.metricsRegion, // widget region == EMF region (changeset §5)
        left: [clientAvailability],
        leftYAxis: { min: 0, max: 100 },
      }),
    );

    // --- Baseline alarm (fills the gap five-nines left: it had ZERO alarms) ----
    if (props.createBaselineAlarms ?? true) {
      this.availabilityAlarm = new cloudwatch.Alarm(this, 'ClientAvailabilityAlarm', {
        alarmName: `${props.demoName}-ClientAvailability`,
        alarmDescription: `Client-perceived availability below ${threshold}% for ${props.demoName}.`,
        metric: clientAvailability,
        threshold,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 5,
        datapointsToAlarm: 3,
        // NOT_BREACHING: an idle/empty demo never false-alarms; stack is green on deploy.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        // NO SNS action by default — demos are interactive; actions are opt-in.
      });
    }

    // --- Dashboard-URL output (generalized from dashboard-stack.ts:763-768) -----
    //
    // THE STACK'S OWN REGION, not metricsRegion: the Dashboard RESOURCE lives where the
    // stack deploys, while its widgets may read metrics cross-region (metricsRegion).
    // With the two decoupled (2026-08-27), a metricsRegion-based URL would point the
    // standby's link at a console region where the dashboard does not exist.
    new cdk.CfnOutput(this, 'DashboardUrl', {
      description: `CloudWatch dashboard for ${props.demoName}`,
      value:
        `https://${cdk.Aws.REGION}.console.aws.amazon.com/cloudwatch/home` +
        `?region=${cdk.Aws.REGION}#dashboards:name=${props.demoName}`,
    });
  }

  /** Append a custom-metric time-series row (demo authors extend the baseline). */
  public addMetricRow(title: string, metrics: cloudwatch.IMetric[]): void {
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title,
        width: 24,
        height: 6,
        region: this.metricsRegion,
        left: metrics,
      }),
    );
  }

  /**
   * A metric in this demo's namespace, stamped with region + period.
   * Generalized from five-nines regionMetric/clientMetric (dashboard-stack.ts:956-975):
   * pass `dimensions` for a per-region (or other-dimensioned) metric, omit for client/fleet.
   */
  public metric(
    name: string,
    dimensions?: Record<string, string>,
    statistic: string = 'Sum',
  ): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: this.namespace,
      metricName: name,
      dimensionsMap: dimensions,
      period: this.period,
      statistic,
      region: this.metricsRegion, // the load-bearing line (changeset §5)
    });
  }

  /**
   * Availability math expression `100 * s / (s + e)`.
   * Lifted (generalized) from dashboard-stack.ts:977-991.
   */
  public availabilityExpr(
    success: cloudwatch.IMetric,
    error: cloudwatch.IMetric,
    label: string,
  ): cloudwatch.MathExpression {
    return new cloudwatch.MathExpression({
      expression: '100 * s / (s + e)',
      usingMetrics: { s: success, e: error },
      period: this.period,
      label,
    });
  }
}
