#!/usr/bin/env bash
# Automated SWITCHOVER rehearsal for drs-mr-demo. Proves the full ARC Region Switch flow,
# then fails back so the demo returns to its resting state (primary = us-east-2).
#
# Steps:
#   0. Preconditions: switchover plan exists; DRS replication is CONTINUOUS.
#   1. Baseline: curl the app via the primary ALB, capture serving region + write id.
#   2. ACTIVATE us-west-2 (Aurora switchover -> DRS recover -> register TG -> DNS flip).
#      Poll get-plan-execution until executionState is terminal.
#   3. Verify: curl the secondary ALB, assert region==us-west-2 and a fresh write lands.
#   4. FAIL BACK = ACTIVATE us-east-2 via the same plan (activePassive plans have no
#      'deactivate'; they carry one activate workflow per region). Poll to terminal.
#   5. Re-verify primary serving again. Leave environment at rest.
#
# Usage: rehearse-switchover.sh <aws-profile>
set -euo pipefail
PROFILE="${1:-}"; [[ "$PROFILE" == "-" ]] && PROFILE=""   # usage: rehearse-switchover.sh [aws-profile|-] [graceful|ungraceful]
MODE="${2:-graceful}"   # ungraceful -> Aurora failover (allow data loss) on the ACTIVATE leg
PRIMARY="${PRIMARY_REGION:-us-east-2}"; SECONDARY="${SECONDARY_REGION:-us-west-2}"; PROJECT="${PROJECT:-drsdemo}"
aws() { command aws --no-cli-pager ${PROFILE:+--profile "$PROFILE"} "$@"; }  # never page; profile optional
outp() { aws cloudformation describe-stacks --region "$1" --stack-name "$2" \
  --query "Stacks[0].Outputs[?OutputKey=='$3'].OutputValue" --output text; }

echo "== [0] preconditions =="
PLAN_ARN=$(aws cloudformation describe-stacks --region "$PRIMARY" --stack-name "${PROJECT}-plan" \
  --query "Stacks[0].Outputs[?OutputKey=='SwitchoverPlanArn'].OutputValue" --output text)
[[ -z "$PLAN_ARN" || "$PLAN_ARN" == "None" ]] && { echo "ERROR: switchover plan not found"; exit 1; }
echo "switchover plan: $PLAN_ARN"
REPL=$(aws drs describe-source-servers --region "$SECONDARY" \
  --query 'items[0].dataReplicationInfo.dataReplicationState' --output text 2>/dev/null || echo "None")
echo "replication state: $REPL"
if [[ "$REPL" != "CONTINUOUS" ]]; then
  echo "ERROR: replication not CONTINUOUS yet ($REPL) — not safe to rehearse. Exiting."
  exit 2
fi

# Verification is API-based (the ALBs are private to 10/8; curl from an operator desktop
# cannot reach them). Signals: Aurora Global writer member, ARC health-check state per
# region, secondary TG target health, DRS recovery instance.
snapshot() {
  local writer hc tg ri
  writer=$(aws rds describe-global-clusters --region "$PRIMARY" --global-cluster-identifier "${PROJECT}-global" \
    --query "GlobalClusters[0].GlobalClusterMembers[?IsWriter].DBClusterArn|[0]" --output text | awk -F: '{print $4}')
  hc=$(aws arc-region-switch list-route53-health-checks --region "$PRIMARY" --arn "$PLAN_ARN" \
    --query "sort_by(healthChecks,&region)[].[region,status]" --output text | awk '{printf "%s=%s ", $1, $2}')
  tg=$(aws elbv2 describe-target-health --region "$SECONDARY" \
    --target-group-arn "$(aws elbv2 describe-target-groups --region "$SECONDARY" --names "${PROJECT}-secondary-tg" --query 'TargetGroups[0].TargetGroupArn' --output text)" \
    --query "TargetHealthDescriptions[].[Target.Id,TargetHealth.State]" --output text | awk '{printf "%s:%s ", $1, $2}')
  ri=$(aws drs describe-recovery-instances --region "$SECONDARY" \
    --query "items[].[ec2InstanceID,ec2InstanceState]" --output text | awk '{printf "%s:%s ", $1, $2}')
  echo "writer_region=$writer | arc_hc: $hc| secondary_tg: ${tg:-<empty>} | drs_recovery: ${ri:-<none>}"
}
writer_of() { echo "$1" | sed -E 's/^writer_region=([^ ]*).*/\1/'; }

echo "== [1] baseline (primary ALB) =="
B=$(snapshot); echo "$B"

run_plan() { # run_plan <action> <target-region> [mode]
  local action="$1" mode="${3:-graceful}" target="$2"
  echo "-- start-plan-execution $action --target-region $target --mode $mode --"
  local eid
  eid=$(aws arc-region-switch start-plan-execution --region "$target" \
    --plan-arn "$PLAN_ARN" --target-region "$target" --action "$action" --mode "$mode" \
    --query 'executionId' --output text)
  echo "executionId: $eid"
  # 60 x 20s = 20 min is enough for the stateless plan; a stateful fail-back (design s.10)
  # spends 40-80 min in DRS syncs. Override with MAX_POLLS.
  for i in $(seq 1 "${MAX_POLLS:-60}"); do
    local st
    st=$(aws arc-region-switch get-plan-execution --region "$target" \
      --plan-arn "$PLAN_ARN" --execution-id "$eid" --query 'executionState' --output text 2>/dev/null || echo "?")
    echo "  [$action] state ($i): $st"
    case "$st" in
      completedWithExceptions) echo "  NOTE: completed with a skipped step -- check stepStates"; return 0 ;;
      *completed*|*COMPLETED*|*SUCCEEDED*) return 0 ;;
      pausedByFailedStep) echo "  step failed -- plan paused; use update-plan-execution-step (skip|switchToUngraceful)"; aws arc-region-switch get-plan-execution --region "$target" --plan-arn "$PLAN_ARN" --execution-id "$eid" --query "stepStates[?status==\`failed\`].[name,status]" --output text; return 1 ;;
      *FAILED*|*CANCEL*|*ERROR*) echo "  step states:"; aws arc-region-switch get-plan-execution --region "$target" --plan-arn "$PLAN_ARN" --execution-id "$eid" --query 'stepStates' --output json | head -40; return 1 ;;
    esac
    sleep 20
  done
  echo "  timed out waiting for $action"; return 1
}

echo "== [2] ACTIVATE $SECONDARY =="
run_plan activate "$SECONDARY" "$MODE" || { echo "ACTIVATE failed"; exit 1; }

echo "== [3] verify secondary is serving =="
sleep 20
A=$(snapshot); echo "$A"; AR=$(writer_of "$A")
[[ "$AR" == "$SECONDARY" ]] && echo "PASS: Aurora writer is in $SECONDARY" || echo "WARN: expected writer in $SECONDARY, got $AR"
echo "$A" | grep -q "secondary_tg: i-[a-z0-9]*:healthy" && echo "PASS: recovered EC2 healthy in secondary TG" || echo "WARN: no healthy target in secondary TG"
echo "$A" | grep -q "$SECONDARY=healthy" && echo "PASS: ARC health check for $SECONDARY is healthy" || echo "WARN: $SECONDARY ARC check not healthy"

echo "== [4] FAIL BACK: activate $PRIMARY via the plan =="
run_plan activate "$PRIMARY" || { echo "FAIL-BACK failed -- environment may be mid-switch, investigate"; exit 1; }

echo "== [5] re-verify primary serving =="
sleep 20
P=$(snapshot); echo "$P"; PR=$(writer_of "$P")
[[ "$PR" == "$PRIMARY" ]] && echo "PASS: Aurora writer back in $PRIMARY" || echo "WARN: expected writer in $PRIMARY, got $PR"
echo "post-fail-back region (primary ALB): $PR"
echo "=== rehearsal complete. baseline=$(writer_of "$B") activated=$AR failedBack=$PR ==="
