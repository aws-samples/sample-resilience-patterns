#!/usr/bin/env bash
# regional-affinity cleanup: delete the sample's five stacks in both Regions, unattended, and wait
# until they are gone. Safe to re-run after a failure. Exits 0 when nothing is left and 1 when a
# stack remains, after printing why it did not delete.
#
# Deletion order (members of a wave are deleted concurrently):
#   1. records                              its records carry the health checks the plan vended
#   2. plan                                 the Region switch plan, its health checks, the private zone
#   3. region-<first>, region-<second>, data
# Wave 3 takes the longest, about 20 minutes: Lambda releases the probe's network interfaces slowly.
# Every log group, the table and its replica belong to a stack, so nothing is left outside them.
#
# Usage: PROJECT=<prefix> REGIONS=<first>,<second> cleanup.sh [aws-profile|-]   (- or empty: default credentials)
set -euo pipefail
PROFILE="${1:-}"; [[ "$PROFILE" == "-" ]] && PROFILE=""
PROJECT="${PROJECT:-regional-affinity}"
IFS=, read -r R1 R2 <<< "${REGIONS:-us-east-1,us-east-2}"
aws() { command aws --no-cli-pager ${PROFILE:+--profile "$PROFILE"} "$@"; }

ACCT=$(aws sts get-caller-identity --query Account --output text) || { echo "no valid AWS credentials"; exit 1; }
echo "cleanup: project $PROJECT in account $ACCT, Regions $R1 and $R2"

state() { # state <region> <stack>: its status, or GONE
  aws cloudformation describe-stacks --region "$1" --stack-name "$2" --query 'Stacks[0].StackStatus' --output text 2>/dev/null \
    || echo GONE
}

start() { # start <region> <stack>: request the deletion when the stack exists
  local st; st=$(state "$1" "$2")
  if [[ "$st" == GONE ]]; then echo "== [$1] $2: absent"; return 0; fi
  echo "== [$1] delete $2 ($st)"
  aws cloudformation delete-stack --region "$1" --stack-name "$2"
}

finish() { # finish <region> <stack>: wait for the deletion, request it once more on DELETE_FAILED
  local attempt st
  for attempt in 1 2; do
    aws cloudformation wait stack-delete-complete --region "$1" --stack-name "$2" 2>/dev/null || true
    st=$(state "$1" "$2")
    [[ "$st" == GONE ]] && { echo "   [$1] $2 deleted"; return 0; }
    echo "   [$1] $2 is $st after attempt $attempt:"
    aws cloudformation describe-stack-events --region "$1" --stack-name "$2" --max-items 40 \
      --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId,ResourceStatusReason]" --output text \
      | sort -u | head -5 | sed 's/^/      /'
    if [[ $attempt == 1 ]]; then
      sleep 20
      aws cloudformation delete-stack --region "$1" --stack-name "$2"
    fi
  done
  return 1
}

wave() { # wave <region>:<stack> ...: request every deletion, then wait for each
  local item failed=0
  for item in "$@"; do start "${item%%:*}" "${item#*:}"; done
  for item in "$@"; do finish "${item%%:*}" "${item#*:}" || failed=1; done
  return "$failed"
}

failed=0
wave "$R1:$PROJECT-records" || failed=1
wave "$R1:$PROJECT-plan" || failed=1
wave "$R1:$PROJECT-region-$R1" "$R2:$PROJECT-region-$R2" "$R1:$PROJECT-data" || failed=1

if [[ $failed != 0 ]]; then
  echo "cleanup: some stacks remain (see above); fix the cause and run cleanup again"
  exit 1
fi
echo "cleanup: every $PROJECT stack is gone"
