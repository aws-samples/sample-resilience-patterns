#!/usr/bin/env bash
# Every stack the deploy rail owns must be in a *_COMPLETE state, in its own region.
# A rail that "finished" with one stack in ROLLBACK_COMPLETE is not a deploy. The stack
# list and regions here MIRROR the rail in .projen/tasks.json; test/topology.test.ts pins
# the two against each other so they cannot drift.
set -euo pipefail

PROJECT="${PROJECT_NAME:-eks-mr-demo}"
PRIMARY="${PRIMARY_REGION:-us-east-2}"
SECONDARY="${SECONDARY_REGION:-us-west-2}"
OBSERVER="${OBSERVER_REGION:-us-east-1}"

# region:stack, in deploy order.
STACKS=(
  "$PRIMARY:$PROJECT-region-$PRIMARY"
  "$SECONDARY:$PROJECT-region-$SECONDARY"
  "$PRIMARY:$PROJECT-peering"
  "$PRIMARY:$PROJECT-globaldata"
  "$SECONDARY:$PROJECT-secondarydb"
  "$OBSERVER:$PROJECT-observer"
  "$PRIMARY:$PROJECT-dns"
  "$PRIMARY:$PROJECT-loadgen"
  "$PRIMARY:$PROJECT-failover"
  "$SECONDARY:$PROJECT-standbyaccess"
  "$PRIMARY:$PROJECT-access-$PRIMARY"
  "$SECONDARY:$PROJECT-access-$SECONDARY"
)

bad=0
for entry in "${STACKS[@]}"; do
  region="${entry%%:*}"; stack="${entry#*:}"
  status=$(aws cloudformation describe-stacks --region "$region" --stack-name "$stack" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "MISSING")
  case "$status" in
    CREATE_COMPLETE|UPDATE_COMPLETE) printf '  ok    %-11s %-40s %s\n' "$region" "$stack" "$status" ;;
    *) printf '  FAIL  %-11s %-40s %s\n' "$region" "$stack" "$status"; bad=$((bad+1)) ;;
  esac
done

if [ "$bad" -ne 0 ]; then
  echo "verify: $bad stack(s) not in a *_COMPLETE state" >&2
  exit 1
fi
echo "verify: all ${#STACKS[@]} stacks complete"
