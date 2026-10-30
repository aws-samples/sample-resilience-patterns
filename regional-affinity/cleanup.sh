#!/usr/bin/env bash
# regional-affinity cleanup: delete the sample's five stacks in both Regions, unattended, and wait
# until they are gone. Safe to re-run after a failure. Exits 0 when nothing is left and 1 when a
# stack remains, could not be checked, or is not this sample's, after printing why.
#
# Deletion order (members of a wave are deleted concurrently):
#   1. records                              its records carry the health checks the plan vended
#   2. plan                                 the Region switch plan, its health checks, the private zone
#   3. region-<first>, region-<second>, data
# Wave 3 takes the longest, about 20 minutes: Lambda releases the probe's network interfaces slowly.
# Every log group, the table and its replica belong to a stack, so cleanup leaves nothing behind
# except two things outside the stacks. DynamoDB keeps a system backup of the deleted table, named
# <table>$DeletedTableBackup, for 35 days at no charge, because point-in-time recovery is on. And the
# CDK asset files (the Lambda code zips) stay in the bootstrap bucket's file assets.
#
# A stack is deleted only when it carries the tag sample=regional-affinity, which bin/app.ts puts on
# every stack: a PROJECT prefix that happens to match another application's stack names must not
# delete that application. A stack without the tag is reported and left alone, and cleanup exits 1.
# Stacks deployed before the tag existed get it on their next deploy (make deploy).
#
# A lookup that fails for any reason other than "stack does not exist" (no permission, an expired
# session, throttling) counts as a stack that remains: cleanup never reports a stack as gone that it
# could not see.
#
# Usage: PROJECT=<prefix> REGIONS=<first>,<second> cleanup.sh [aws-profile|-]   (- or empty: default credentials)
set -euo pipefail
PROFILE="${1:-}"; [[ "$PROFILE" == "-" ]] && PROFILE=""
PROJECT="${PROJECT:-regional-affinity}"
REGIONS="${REGIONS:-us-east-1,us-east-2}"
TAG_KEY=sample           # the tag bin/app.ts puts on every stack (lib/names.ts SAMPLE_TAG)
TAG_VALUE=regional-affinity
aws() { command aws --no-cli-pager ${PROFILE:+--profile "$PROFILE"} "$@"; }

# PROJECT prefixes every stack name; it can come from a workflow input, so check its shape (the same
# rule as checkProject in lib/names.ts: 2 to 24 lowercase letters, digits and hyphens, ending in a
# letter or digit).
if [[ ! "$PROJECT" =~ ^[a-z][a-z0-9-]{0,22}[a-z0-9]$ ]]; then
  echo "PROJECT must be 2 to 24 lowercase letters, digits and hyphens, starting with a letter and ending with a letter or digit (got \"$PROJECT\")"
  exit 1
fi
# Both Regions, spelled like us-east-1. A lone Region, a space after the comma or a third Region
# would otherwise turn into stack names that match nothing, and cleanup would report success.
IFS=, read -r R1 R2 EXTRA <<< "$REGIONS"
REGION_SHAPE='^[a-z]+(-[a-z]+)+-[0-9]+$'
if [[ -n "$EXTRA" || ! "$R1" =~ $REGION_SHAPE || ! "$R2" =~ $REGION_SHAPE || "$R1" == "$R2" ]]; then
  echo "REGIONS must name two different Regions, such as us-east-1,us-east-2 (got \"$REGIONS\")"
  exit 1
fi

ACCT=$(aws sts get-caller-identity --query Account --output text) || { echo "no valid AWS credentials"; exit 1; }
echo "cleanup: project $PROJECT in account $ACCT, Regions $R1 and $R2"

# describe <region> <stack>: sets ST to the stack's status, GONE when it does not exist, or ERROR when
# the lookup itself failed (printed to stderr), and TAG to the value of the sample tag (empty if none).
# One call returns both, so the tag checked is the tag of the stack whose status was read.
describe() {
  local out why
  ST=ERROR; TAG=
  if out=$(aws cloudformation describe-stacks --region "$1" --stack-name "$2" \
      --query "Stacks[0].[StackStatus,Tags[?Key=='$TAG_KEY'].Value|[0]]" --output text 2>&1); then
    read -r ST TAG <<< "$out"
    [[ "$TAG" == None ]] && TAG=
  elif [[ "$out" == *"does not exist"* ]]; then
    ST=GONE
  else
    why=${out#"${out%%[![:space:]]*}"}  # the CLI starts its error with a blank line
    echo "   [$1] $2: describe-stacks failed, so the stack is counted as remaining: ${why%%$'\n'*}" >&2
  fi
  return 0
}

# start <region> <stack>: request the deletion of a stack that exists and is this sample's.
# Returns 0 when a deletion is under way, 10 when there is nothing to delete, 1 when the stack
# remains for any other reason (the reason is printed). Nothing waits for a stack that returns 1.
start() {
  describe "$1" "$2"
  case "$ST" in
    GONE) echo "== [$1] $2: absent"; return 10 ;;
    ERROR) return 1 ;;
  esac
  if [[ "$TAG" != "$TAG_VALUE" ]]; then
    echo "== [$1] $2 ($ST) is not tagged $TAG_KEY=$TAG_VALUE, so it is not this sample's and is left alone." >&2
    echo "   If it is, run make deploy once to add the tag, then run cleanup again." >&2
    return 1
  fi
  echo "== [$1] delete $2 ($ST)"
  aws cloudformation delete-stack --region "$1" --stack-name "$2" \
    || { echo "   [$1] $2: delete-stack was rejected, so the stack remains" >&2; return 1; }
}

finish() { # finish <region> <stack>: wait for the deletion, request it once more on DELETE_FAILED
  local attempt
  for attempt in 1 2; do
    aws cloudformation wait stack-delete-complete --region "$1" --stack-name "$2" 2>/dev/null || true
    describe "$1" "$2"
    [[ "$ST" == GONE ]] && { echo "   [$1] $2 deleted"; return 0; }
    [[ "$ST" == ERROR ]] && return 1
    echo "   [$1] $2 is $ST after attempt $attempt:"
    aws cloudformation describe-stack-events --region "$1" --stack-name "$2" --max-items 40 \
      --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId,ResourceStatusReason]" --output text \
      | sort -u | head -5 | sed 's/^/      /'
    if [[ $attempt == 1 ]]; then
      sleep 20
      aws cloudformation delete-stack --region "$1" --stack-name "$2" \
        || { echo "   [$1] $2: delete-stack was rejected, so the stack remains" >&2; return 1; }
    fi
  done
  return 1
}

wave() { # wave <region>:<stack> ...: request every deletion, then wait for each stack that has one under way
  local item rc failed=0 waiting=()
  for item in "$@"; do
    start "${item%%:*}" "${item#*:}" && rc=0 || rc=$?
    case "$rc" in
      0) waiting+=("$item") ;;
      10) ;;
      *) failed=1 ;;
    esac
  done
  for item in ${waiting[@]+"${waiting[@]}"}; do finish "${item%%:*}" "${item#*:}" || failed=1; done
  return "$failed"
}

failed=0
wave "$R1:$PROJECT-records" || failed=1
wave "$R1:$PROJECT-plan" || failed=1
wave "$R1:$PROJECT-region-$R1" "$R2:$PROJECT-region-$R2" "$R1:$PROJECT-data" || failed=1

if [[ $failed != 0 ]]; then
  echo "cleanup: some stacks remain, could not be checked or are not this sample's (see above); fix the cause and run cleanup again"
  exit 1
fi
echo "cleanup: every $PROJECT stack is gone"
