"""The AZ-dimensioned availability family — emitter-side copy of the metric names.

Decision D1. The CloudWatch dimension name equals the metric prefix, matching the two
families that already exist (``Region`` -> ``Region*``, ``Op`` -> ``Op*``). Spelling it
``AZ`` would break the invariant AND, being a different string to CloudWatch, would draw
nothing at all.

WHY THIS FILE EXISTS AS A SEPARATE MODULE
-----------------------------------------
So ``locustfile.py`` can IMPORT these names instead of hand-typing them. The ``Region*`` and
``Op*`` families work today only because three independently hand-typed literals happen to
match — in ``locustfile.py``, in the cockpit ``handler.py``, and in the TypeScript
``metric-namespace.ts``. That arrangement is one careless edit away from a silently empty
chart, and D1 forbids repeating it for ``Az``.

WHY IT IS A COPY RATHER THAN THE SINGLE SOURCE
----------------------------------------------
The authority is ``src/cdk/lib/constructs/observability/metric-namespace.ts``. Three
consumers need these names and NO import can reach all three (decision D7):

* this module -> imported by ``locustfile.py``. Same directory, so a real import.
* ``src/cdk/lib/constructs/cockpit/lambda/handler.py`` -> the chart reader. It CANNOT import
  this module: the Lambda asset is ``lambda.Code.fromAsset(.../'lambda')``, i.e. that
  directory alone, so nothing under ``src/locust/`` is on its ``sys.path``. An
  ``import az_metrics`` there passes synth and every local test, then raises
  ``ModuleNotFoundError`` on the first cockpit invocation.
* ``metric-namespace.ts`` -> TypeScript; consumed by the CDK dashboard rows.

Do NOT "fix" this by copying the file into ``lambda/``. That trades one hand-typed literal
for a fourth file that the drift-test pattern then has to police.

THE CONTROL
-----------
A DERIVED CONTRACT TEST — ``'the Az metric-name contract'`` in ``test/topology.test.ts`` —
parses the literals out of all three files and asserts they agree. Nothing type-checks a
CloudWatch metric string, so a case flip compiles, deploys green, and leaves the AZ chart
lines permanently empty. That presents as a broken load generator, not as a naming bug.
Two-way coverage would be WORSE than none: it would certify the wrong pair and make the gap
look closed (D7c).

If you change a name here, change it in the other two files in the SAME commit. The test
will tell you if you don't.
"""

AZ_DIMENSION = "Az"
AZ_SUCCESS = "AzSuccess"
AZ_ERROR = "AzError"
AZ_LATENCY = "AzLatency"

#: Requests that were BOTH non-error AND answered within :data:`AZ_SLO_MS`. The numerator of
#: the cockpit's client-perceived availability chart (2026-09-03).
#:
#: A SEPARATE counter rather than a redefinition of ``AzSuccess``. Three reasons, in order of
#: how badly each would hurt:
#:
#: 1. ``Client*`` and ``Region*`` feed ALARMS -- the decision signal and the ARC
#:    application-health alarms. ``Az*`` feeds charts only. Keeping the SLO measure inside the
#:    Az family is what makes it impossible for a latency SLO to trip the decision alarm or
#:    to shift Route 53 on a single-AZ fault.
#: 2. Both lines can then be drawn together, and their DIVERGENCE is the gray-failure thesis:
#:    "responded" stays at 100% while "responded within 2s" falls. One redefined line just
#:    moves a number and loses the contrast.
#: 3. Every recorded demo and screenshot taken before this change stays comparable.
AZ_SLO_SUCCESS = "AzSloSuccess"

#: The bar, in milliseconds. Non-error responses slower than this do not count as available.
#:
#: TWO-SIDED, and both ends are measured rather than chosen (test: 'the SLO threshold sits
#: INSIDE the measurable band'):
#:
#: * CEILING -- ``locustfile.REQUEST_TIMEOUT`` (5s) abandons the request and scores it an
#:   ERROR, so no success is ever observed slower than 5s. A threshold at or above that
#:   classifies nothing and the chart silently degenerates to the plain error rate. A 10s
#:   bar was proposed on 2026-09-03 and is precisely this trap.
#: * FLOOR -- quiet-window p90 is ~90ms and the observed MAXIMUM was 109ms (live us-east-2c,
#:   2026-09-03 16:27-16:32). Too close and healthy traffic breaches at rest.
#:
#: 2000ms sits ~18x above the quiet maximum and 2.5x under the error wall. Calibrated against
#: the measured brownout distribution (p50 1,839ms / p90 2,242ms at 800ms +/- 400ms), where it
#: reads ~69% for the faulted zone -- unmistakably degraded, and distinct from both 100% and
#: the 0%/no-data of an AZ whose instances have stopped.
#:
#: It coincidentally equals the NLB health-check timeout, and that coincidence is the LESSON,
#: not a coupling: the health check pays ONE shaped network hop and passes, the customer pays
#: about three and fails. Same bar, two verdicts. The two constants are pinned by separate
#: tests on purpose -- moving the health-check timeout must NOT drag the SLO with it.
#:
#: NOT env-overridable. The emitter classifies with it and the chart PRINTS it as an axis
#: label, and those two live in different deployables -- an override would let the label
#: describe a definition the data was not built with.
AZ_SLO_MS = 2000


def slo_success(success: bool, latency_ms: float) -> int:
    """1 when the request counts toward client-perceived availability, else 0.

    Available means BOTH conditions: it did not error, and it answered within
    :data:`AZ_SLO_MS`. An error never counts however fast it failed; a success does not
    count if the customer waited too long for it.

    Lives HERE, in a module that imports nothing, so a test can exercise it in a bare
    ``python3`` subprocess with neither locust nor boto3 installed. Inline in
    ``locustfile.py`` it would only ever be reachable by a source grep, and a source grep
    cannot tell ``<=`` from ``<``.

    The boundary is INCLUSIVE: exactly AZ_SLO_MS is within the bar.
    """
    return 1 if success and latency_ms <= AZ_SLO_MS else 0


#: Response field names carrying the serving AZ (decision D2). Mirrors the verified
#: ``REGION_FIELDS = ("region", "written_from_region")`` pair in ``locustfile.py`` — reads
#: answer with ``az``, writes with ``written_from_az``.
#:
#: ONE spelling per field. ``region_of`` never raises and ``REGION_FIELDS`` is a list, so
#: listing both candidate spellings "to be safe" is tempting — and that is exactly how a
#: mismatch survives instead of being caught.
AZ_FIELDS = ("az", "written_from_az")
