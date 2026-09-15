#!/usr/bin/env bash
#
# Lint the SYNTHESIZED CloudFormation templates in cdk.out/.
#
# WHY THIS EXISTS
# ---------------
# `cdk synth` validates the CDK object graph. It does NOT validate the template it
# produces, and CloudFormation only rejects some errors at CreateChangeSet -- i.e. mid
# deploy, after the rail has spent minutes on earlier phases. Three separate defects
# reached a live deploy on 2026-08-31 behind a completely green synth:
#
#   1. `Fn::GetAtt [Plan, 'Route53HealthChecks.Regions']` -- nested attribute path that
#      is not in the resource's readOnlyProperties.  (rolled the stack back)
#   2. A `CfnCondition` doing `Fn::Equals` on `Fn::GetAtt [Plan, PlanHealthChecks]` --
#      Conditions may not reference resources.       (failed at CreateChangeSet)
#   3. A CfnParameter declared but never threaded through the deploy scripts.
#
# cfn-lint inspects the emitted template, and it catches #2 as `E8003` -- verified by
# re-breaking the template and watching it fire. That is the point of this gate: move
# template-level errors from "phase 9 of a live deploy" to "before the push".
#
# ARGUMENT ORDER IS LOAD-BEARING -- DO NOT REORDER
# -----------------------------------------------
# cfn-lint's `--ignore-checks` is VARIADIC, so it keeps consuming words until the next
# flag. Placed IMMEDIATELY BEFORE the file list it eats the template paths as check
# names, lints NOTHING, and reports
#
#     E1001 'Resources' is a required property
#     None:1:1
#
# which is a gate that is red for the wrong reason -- and the obvious "fix" for that
# noise is to relax it, leaving a gate that is green while checking nothing at all.
#
# Measured 2026-08-31 on cfn-lint 1.45.0, three forms:
#   `--ignore-checks E3018 <files>`                        -> lints NOTHING  (broken)
#   `--ignore-checks E3018 --non-zero-exit-code error <f>`  -> lints 11       (works, by luck:
#                                                             the next flag terminates it)
#   `<files> --ignore-checks E3018 ...`                     -> lints 11       (works always)
#
# So the second form is only correct ACCIDENTALLY -- delete or reorder the flag that
# happens to sit between, and it silently starts checking nothing. Files first is the only
# form that cannot break. The None:1:1 guard below is the backstop if this regresses.
#
set -euo pipefail

OUT_DIR="${CDK_OUT_DIR:-cdk.out}"

# cfn-lint's registry schema for AWS::ARCRegionSwitch::Plan rejects a ReportConfiguration
# shape that DEPLOYED SUCCESSFULLY (verified against the 2026-08-29 template that reached
# CREATE_COMPLETE, which cfn-lint flags identically). It is a schema gap in the linter,
# not a defect in the template. Keep this list SHORT and justify every entry.
IGNORE_CHECKS="E3018"

# Warnings are reported but do not fail the gate: the repo carries 27 of them (W2001
# unused parameters, W3005 redundant DependsOn) that are stylistic. Errors fail.
FAIL_LEVEL="error"

if ! command -v cfn-lint >/dev/null 2>&1; then
  # Deliberately NOT fatal by default. This runs inside `projen build`, which the CI
  # build job also runs; hard-failing here would break CI on any image without cfn-lint
  # and block deploys for a lint tool. Set CFN_LINT_REQUIRED=1 to make it fatal (do that
  # in CI once the image is known to install it).
  echo "=====================================================================" >&2
  echo "WARNING: cfn-lint not found -- SYNTHESIZED TEMPLATES WERE NOT LINTED." >&2
  echo "  This gate catches template errors that cdk synth cannot see and that" >&2
  echo "  CloudFormation only rejects mid-deploy. Install it with:" >&2
  echo "    pip install --user cfn-lint      (or: uvx cfn-lint)" >&2
  echo "=====================================================================" >&2
  if [ "${CFN_LINT_REQUIRED:-0}" = "1" ]; then
    echo "CFN_LINT_REQUIRED=1 and cfn-lint is absent -- failing." >&2
    exit 1
  fi
  exit 0
fi

# An empty glob would make this script pass while linting nothing, so count first and
# treat zero templates as a failure rather than a success.
shopt -s nullglob
TEMPLATES=("$OUT_DIR"/*.template.json)
shopt -u nullglob

if [ "${#TEMPLATES[@]}" -eq 0 ]; then
  echo "ERROR: no *.template.json found in $OUT_DIR/ -- nothing was linted." >&2
  echo "  This gate runs AFTER synth; if synth ran, templates must exist." >&2
  exit 1
fi

echo "cfn-lint: checking ${#TEMPLATES[@]} synthesized template(s) in $OUT_DIR/"

set +e
# TEMPLATES FIRST, FLAGS AFTER -- see the argument-order note at the top of this file.
LINT_OUT="$(cfn-lint "${TEMPLATES[@]}" \
  --ignore-checks "$IGNORE_CHECKS" \
  --non-zero-exit-code "$FAIL_LEVEL" 2>&1)"
LINT_RC=$?
set -e

[ -n "$LINT_OUT" ] && printf '%s\n' "$LINT_OUT"

# The signature of "cfn-lint was handed no files": it falls back to empty input and
# complains that Resources is missing, with no filename. If that appears, the invocation
# above is broken -- fail regardless of the exit code, because this gate reporting
# success while checking nothing is the worst possible outcome.
if printf '%s' "$LINT_OUT" | grep -q "None:1:1"; then
  echo "ERROR: cfn-lint reported 'None:1:1' -- it linted NO template." >&2
  echo "  Almost certainly the variadic --ignore-checks swallowed the file list." >&2
  echo "  Templates must be passed BEFORE the flags." >&2
  exit 1
fi

if [ "$LINT_RC" -ne 0 ]; then
  echo "ERROR: cfn-lint found template errors (exit $LINT_RC)." >&2
  echo "  These are errors cdk synth cannot catch and CloudFormation rejects at deploy." >&2
  exit 1
fi

echo "cfn-lint: ${#TEMPLATES[@]} template(s) clean (errors only; warnings shown above)."
