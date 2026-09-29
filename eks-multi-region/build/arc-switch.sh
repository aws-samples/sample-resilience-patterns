#!/usr/bin/env bash
#
# Execute an ARC Region switch plan against the CORRECT regional endpoint.
#
# ── THE MISTAKE THIS EXISTS TO PREVENT ──────────────────────────────────────────────────
#
# `start-plan-execution` takes TWO regions and they are not the same thing:
#
#   --target-region   the SEMANTIC target. Per the CLI: "the Region that traffic will be
#                     shifted to or FROM, depending on the action."
#   --region          the API ENDPOINT the call goes to.
#
# ARC runs on a regional data plane, and AWS is explicit about which endpoint to use:
# "Region switch plans are executed from the Region being ACTIVATED. This design eliminates
# dependencies on the impacted Region during the switch."
#
# For `activate` those two coincide, so nothing goes wrong. For `deactivate` they are
# DIFFERENT REGIONS:
#
#   deactivate --target-region us-east-2   =  shift traffic AWAY from us-east-2
#                                          =  us-west-2 is being ACTIVATED
#                                          =  the call must go to the us-west-2 endpoint
#
# The natural thing to type is `--region` equal to `--target-region`. For a deactivate that
# points the call at the region you are abandoning — which in a real event is the impaired
# one. It is the single dependency the regional data plane exists to remove, and it fails
# exactly when it matters and never in a practice run against a healthy primary.
#
# NO LONGER ON THE PATH: the plan is activePassive with a single `activate` workflow, so
# --target-region is always the region being activated and the endpoint always coincides
# with it. The deactivate trap is documented above because the script still guards it and
# because anyone reading an older runbook will reach for `deactivate` first.
#
# ── Usage ───────────────────────────────────────────────────────────────────────────────
#
#   bash build/arc-switch.sh <activate|deactivate> <target-region> <plan-arn> [--execute]
#
# Prints the derived call and EXITS WITHOUT RUNNING unless --execute is passed. A failover
# is not something to trigger by a mistyped argument.
#
# Optional env:
#   ARC_REGIONS   CSV of the two regions in the plan. Defaults to the demo's pair.
#   ARC_MODE      graceful | ungraceful. Default graceful.
#   ARC_COMMENT   Free text recorded on the execution.

set -euo pipefail

ARC_REGIONS="${ARC_REGIONS:-us-east-2,us-west-2}"
ARC_MODE="${ARC_MODE:-graceful}"
ARC_COMMENT="${ARC_COMMENT:-}"

usage() {
  echo "usage: $0 <activate|deactivate> <target-region> <plan-arn> [--execute]" >&2
  exit 2
}

[ "$#" -ge 3 ] || usage
ACTION="$1"
TARGET_REGION="$2"
PLAN_ARN="$3"
EXECUTE="${4:-}"

case "$ACTION" in
  activate) ;;
  deactivate)
    echo "ERROR: this plan has NO deactivate workflow. It is activePassive with a SINGLE" >&2
    echo "       activate workflow (2026-08-26), so ACTIVATING one region deactivates the" >&2
    echo "       other as one sequenced cutover. Fail over with:" >&2
    echo "         $0 activate <standby-region> <plan-arn> --execute" >&2
    echo "       and fail back by naming the other region. StartPlanExecution would" >&2
    echo "       otherwise reject a deactivate with no matching workflow." >&2
    exit 2
    ;;
  *)
    echo "ERROR: action must be 'activate' or 'deactivate', got '$ACTION'." >&2
    echo "  (postRecovery is a valid API action but is not part of this runbook.)" >&2
    exit 2
    ;;
esac

# ---- derive the endpoint region --------------------------------------------
#
# This is the whole point of the script, and it is deliberately a pure function of
# (action, target, region-pair) so it can be tested without an AWS account.

IFS=',' read -ra REGIONS <<< "$ARC_REGIONS"
if [ "${#REGIONS[@]}" -ne 2 ]; then
  echo "ERROR: ARC_REGIONS must name exactly two regions, got '$ARC_REGIONS'." >&2
  exit 2
fi
R0="$(echo "${REGIONS[0]}" | xargs)"
R1="$(echo "${REGIONS[1]}" | xargs)"

if [ "$TARGET_REGION" != "$R0" ] && [ "$TARGET_REGION" != "$R1" ]; then
  echo "ERROR: target region '$TARGET_REGION' is not one of the plan's regions ($R0, $R1)." >&2
  echo "  A typo here would otherwise be sent to the API as a valid-looking request." >&2
  exit 2
fi

other_region() {
  if [ "$1" = "$R0" ]; then echo "$R1"; else echo "$R0"; fi
}

if [ "$ACTION" = activate ]; then
  # Activating the target: the target IS the region coming up.
  ACTIVATING_REGION="$TARGET_REGION"
else
  # Deactivating the target: the OTHER region is the one coming up.
  ACTIVATING_REGION="$(other_region "$TARGET_REGION")"
fi
ENDPOINT_REGION="$ACTIVATING_REGION"

# Belt and braces. If a future edit ever makes the endpoint the region being stood down,
# fail rather than issue the call — that is the failure this script exists to prevent, and
# it must not be reachable by a refactor.
if [ "$ACTION" = deactivate ] && [ "$ENDPOINT_REGION" = "$TARGET_REGION" ]; then
  echo "ERROR: derived endpoint equals the region being deactivated. Refusing." >&2
  exit 1
fi

cat <<SUMMARY
ARC Region switch
  action:            $ACTION
  --target-region:   $TARGET_REGION   (traffic shifted $([ "$ACTION" = activate ] && echo "TO" || echo "AWAY FROM") this region)
  region ACTIVATED:  $ACTIVATING_REGION
  API endpoint:      $ENDPOINT_REGION   <-- the region being ACTIVATED, per ARC's regional data plane
  mode:              $ARC_MODE
  plan:              $PLAN_ARN
SUMMARY

if [ "$EXECUTE" != "--execute" ]; then
  echo
  echo "DRY RUN. Re-run with --execute as the 4th argument to start the execution."
  echo "Command that would run:"
  echo "  aws arc-region-switch start-plan-execution --region $ENDPOINT_REGION \\"
  echo "    --plan-arn $PLAN_ARN --target-region $TARGET_REGION --action $ACTION --mode $ARC_MODE"
  exit 0
fi

set -- \
  --region "$ENDPOINT_REGION" \
  --plan-arn "$PLAN_ARN" \
  --target-region "$TARGET_REGION" \
  --action "$ACTION" \
  --mode "$ARC_MODE"
[ -n "$ARC_COMMENT" ] && set -- "$@" --comment "$ARC_COMMENT"

echo
echo "Starting execution..."
EXEC_ID="$(aws arc-region-switch start-plan-execution "$@" --query executionId --output text)"
echo "executionId: $EXEC_ID"
echo
# Read progress from the REGIONAL data plane, not the global view. AWS: "if there are
# impairments in a Region, the global dashboard might not show all your plan data... rely
# only on the Regional executions dashboard during operational events."
echo "Follow progress (regional data plane):"
echo "  aws arc-region-switch get-plan-execution --region $ENDPOINT_REGION \\"
echo "    --plan-arn $PLAN_ARN --execution-id $EXEC_ID"
echo
echo "There is NO approval gate: the plan runs straight through from here. The"
echo "start-plan-execution call above WAS the authorization -- the plan carries no"
echo "automatic triggers, so nothing can start it but a human."
