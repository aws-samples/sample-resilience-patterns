/**
 * The single source of truth (changeset §4, detailed-design C3) for the EMF metric
 * namespace shared across the observability construct, the Python EMF helper, and the
 * load-gen container env var.
 *
 * MUST match the value the workload's EMF helper writes. Consumed as the default for
 * {@link DemoObservabilityProps.metricNamespace}. The Python helper reads the same value
 * from the `DEMO_METRIC_NAMESPACE` env var (C3 — that exact env var name), which the CDK
 * stack injects onto the load-gen container so the running value is authoritative and the
 * literals only matter as defaults.
 *
 * This replaces the the predecessor project pattern of two files independently hardcoding their
 * namespace string (the brittle coupling called out in the predecessor project).
 */
export const DEMO_METRIC_NAMESPACE = 'MyResilienceDemo';

/**
 * The env var name the CDK stack injects onto the load-gen / app container and the Python
 * EMF helper reads (detailed-design C3). Standardized as `DEMO_METRIC_NAMESPACE`
 * (NOT `EMF_NAMESPACE`) — observability owns the namespace concept.
 */
export const DEMO_METRIC_NAMESPACE_ENV_VAR = 'DEMO_METRIC_NAMESPACE';

/**
 * The AZ-dimensioned availability family (single-AZ / zonal-shift feature, decision D1).
 *
 * NAMING INVARIANT: the CloudWatch dimension name equals the metric prefix, matching the
 * two families that already exist — `Region` → `Region*`, `Op` → `Op*`. So dimension `Az`
 * gives `AzSuccess` / `AzError` / `AzLatency`. Do not spell it `AZ`; that breaks the
 * invariant and, being a different string to CloudWatch, silently draws nothing.
 *
 * THIS IS THE AUTHORITY. Three consumers read these names and NONE of them can share this
 * module by import (decision D7):
 *   1. `src/locust/az_metrics.py` — the emitter's copy, imported by `locustfile.py`.
 *   2. `.../cockpit/lambda/handler.py` — the chart reader. It CANNOT import the Python copy:
 *      its asset is `lambda.Code.fromAsset(.../'lambda')`, so a module living under
 *      `src/locust/` is not on its `sys.path`. An `import az_metrics` there passes synth and
 *      every local test, then raises ModuleNotFoundError on the first invocation.
 *   3. This file — consumed by the CDK dashboard rows.
 *
 * Because no import can span all three, the control is a DERIVED CONTRACT TEST that parses
 * the literals out of all three files and asserts they agree ('the Az metric-name contract'
 * in test/topology.test.ts). Nothing type-checks a CloudWatch metric string: a case flip
 * compiles, deploys green, and leaves the AZ chart lines permanently empty — which reads as
 * a broken load generator, not as a naming bug. Two-way coverage is worse than none, because
 * it certifies the wrong pair and makes the gap look closed (D7c).
 */
export const AZ_DIMENSION = 'Az';

/** @see AZ_DIMENSION — the metric names for the `Az` family. Prefix MUST equal the dimension. */
export const AZ_METRICS = {
  success: 'AzSuccess',
  error: 'AzError',
  latency: 'AzLatency',
  /**
   * Non-error AND answered within {@link AZ_SLO_MS} — the numerator of the cockpit's
   * client-perceived availability chart (2026-09-03).
   *
   * Deliberately a SEPARATE counter from `success`, not a redefinition of it. `Client*` and
   * `Region*` feed ALARMS (the 50% FIS stop condition; the ARC application-health alarms);
   * `Az*` feeds charts only. Keeping the latency-aware measure inside the Az family is what
   * makes it impossible for an SLO definition to re-arm the FIS guardrail or shift Route 53
   * on a single-AZ fault.
   */
  sloSuccess: 'AzSloSuccess',
} as const;

/**
 * The client-perceived availability bar, in milliseconds — a non-error response slower than
 * this does not count as available.
 *
 * Two-sided and both ends MEASURED, not chosen (test: 'the SLO threshold sits INSIDE the
 * measurable band'). Ceiling: the loadgen's REQUEST_TIMEOUT (5s) already scores anything
 * slower as an error, so a bar at or above it classifies nothing — the 10s bar proposed on
 * 2026-09-03 is exactly that trap. Floor: the quiet-window maximum was 109ms live, so a bar
 * near it makes healthy traffic breach at rest.
 *
 * 2000ms reads ~69% for a zone under the calibrated brownout (measured p50 1,839ms /
 * p90 2,242ms), which is visibly degraded and still distinct from a stopped AZ.
 *
 * It equals the NLB health-check timeout by coincidence, and that is the teaching point
 * rather than a coupling — the health check pays one shaped hop and passes, the customer pays
 * about three and fails. Pinned by a separate test from the health-check annotation so moving
 * one cannot silently drag the other.
 */
export const AZ_SLO_MS = 2000;
