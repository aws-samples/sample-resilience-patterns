#!/usr/bin/env bash
#
# Deploy one CloudFormation stack using a template URL pointing at content
# previously uploaded by the `deploy:s3` projen task. Always uses
# --template-url so the 51200-byte local body limit never applies.
#
# `aws cloudformation deploy` does NOT support --template-url, so we drive
# change-sets directly: create-change-set → wait → execute-change-set →
# poll-until-transitioning → wait-terminal. An empty change-set is treated
# as success (matches the old --no-fail-on-empty-changeset behavior).
#
# Required env:
#   AWS_REGION          Target region for this deploy. The assets bucket
#                       also lives in this region — content is uploaded to
#                       one bucket per region during the upload phase.
#   STACK_NAME          Physical CFN stack name.
#   TEMPLATE_NAME       Base name (no extension) of the top-level template
#                       inside the S3 prefix. The green skeleton has a single
#                       stack ($PROJECT_NAME-demo); multi-region demos add more
#                       (e.g. $PROJECT_NAME-<region>, $PROJECT_NAME-peering) via
#                       additional deployStackStep calls in deploy-tasks.ts (M5).
#   ASSETS_BUCKET       Bucket in $AWS_REGION populated by the upload phase.
#   ASSETS_PREFIX       Matching key prefix. Trailing slash added if missing.
#
# Optional env:
#   STACK_PARAMETERS    Caller-supplied CFN params, one per line as
#                       `Key=Value` (newline-separated, NOT space).
#                       Values may contain commas, spaces, and any other
#                       character except newline and the first '='. The
#                       script converts them into a JSON parameters file
#                       (so CLI shorthand parsing never sees the values).
#                       AssetsBucketName / AssetsBucketPrefix are always
#                       appended automatically.
#   OUTPUTS_FILE        Dotenv file for stack outputs. the CI consumes
#                       this via `artifacts: reports: dotenv:`.
#                       Defaults to dist/$STACK_NAME.env.
#   OUTPUTS_PREFIX      Prefix prepended to every exported key so multi-job
#                       dotenv merges don't collide (e.g. DESTA_APIURL vs
#                       DESTB_APIURL). Defaults to "" (no prefix).
#   CAPABILITIES        Override `--capabilities`. Default:
#                         CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND
#   CHANGESET_PREFIX    Prefix for the generated change-set name.
#                       Defaults to "ci".
#   CLEANUP_ON_FAILURE  If "true", delete the uploaded S3 prefix when the
#                       deploy fails. The orchestrator (deploy-all.sh) sets
#                       this; individual per-stack CI jobs leave it off
#                       since the prefix is shared.

set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${STACK_NAME:?STACK_NAME is required}"
: "${TEMPLATE_NAME:?TEMPLATE_NAME is required}"
: "${ASSETS_BUCKET:?ASSETS_BUCKET is required}"
: "${ASSETS_PREFIX:?ASSETS_PREFIX is required}"

OUTPUTS_FILE="${OUTPUTS_FILE:-dist/${STACK_NAME}.env}"
OUTPUTS_PREFIX="${OUTPUTS_PREFIX:-}"
CAPABILITIES="${CAPABILITIES:-CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND}"
CHANGESET_PREFIX="${CHANGESET_PREFIX:-ci}"
STACK_PARAMETERS="${STACK_PARAMETERS:-}"
CLEANUP_ON_FAILURE="${CLEANUP_ON_FAILURE:-false}"
ROLE_ARN="${ROLE_ARN:-}"

case "$ASSETS_PREFIX" in
  */) ;;
  *)  ASSETS_PREFIX="${ASSETS_PREFIX}/" ;;
esac

# Regional S3 endpoint. The assets bucket is deployed per-region and
# $AWS_REGION is the stack's home region — which, by construction, is also
# the region the bucket lives in. Virtual-hosted style is the most
# compatible form for cross-feature S3 requests (CloudFormation included).
TEMPLATE_URL="https://${ASSETS_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${ASSETS_PREFIX}${TEMPLATE_NAME}.json"

# ---- helpers ----------------------------------------------------------------

describe_status() {
  aws cloudformation describe-stacks \
    --region "$AWS_REGION" --stack-name "$STACK_NAME" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo ""
}

cleanup_on_failure() {
  if [ "$CLEANUP_ON_FAILURE" = "true" ]; then
    echo "Cleaning up s3://$ASSETS_BUCKET/$ASSETS_PREFIX after failure"
    aws s3 rm "s3://$ASSETS_BUCKET/$ASSETS_PREFIX" --recursive || true
  fi
}

# ---- change-set type --------------------------------------------------------

INITIAL_STATUS="$(describe_status)"

if [ -z "$INITIAL_STATUS" ]; then
  CS_TYPE=CREATE
else
  case "$INITIAL_STATUS" in
    REVIEW_IN_PROGRESS) CS_TYPE=CREATE ;;
    # A CREATE that rolled back leaves a corpse CloudFormation refuses to update
    # ("is in ROLLBACK_COMPLETE state and can not be updated") -- so a re-run after a
    # fixed first deploy fails at the changeset, far from the original cause. The
    # stack never succeeded and the rollback already destroyed its resources; delete
    # the record and recreate. (Live case: the first region-stack deploy raced an
    # AccessEntry against the EKS cluster, 2026-08-26.)
    ROLLBACK_COMPLETE)
      echo "Stack $STACK_NAME is a CREATE-rollback corpse; deleting the record before recreate"
      aws cloudformation delete-stack --region "$AWS_REGION" --stack-name "$STACK_NAME"
      aws cloudformation wait stack-delete-complete --region "$AWS_REGION" --stack-name "$STACK_NAME"
      CS_TYPE=CREATE
      ;;
    # A half-deleted stack cannot be updated, and its live resources are whatever a
    # failed teardown left behind -- deploying onto that is never right. Name the
    # fix (cleanup.sh drains what the cluster's controllers left in the VPC) instead
    # of surfacing CloudFormation's "can not be updated" from CreateChangeSet.
    DELETE_FAILED|DELETE_IN_PROGRESS)
      echo "Stack $STACK_NAME is $INITIAL_STATUS; run cleanup.sh to finish the teardown before deploying" >&2
      exit 1
      ;;
    *)                  CS_TYPE=UPDATE ;;
  esac
fi

CHANGESET_NAME="${CHANGESET_PREFIX}-$(date +%s)-${RANDOM}"

# Build a JSON parameters file. This sidesteps the AWS CLI shorthand parser
# entirely, so values with commas, quotes, or spaces pass through cleanly.
# Caller-supplied pairs come first; AssetsBucket* are appended unconditionally
# because package.py rewrote nested templates to require them.
PARAMS_FILE="dist/${STACK_NAME}.params.json"
mkdir -p "$(dirname "$PARAMS_FILE")"

{
  # %b interprets \n (and any other backslash escape) as a real byte.
  # Callers supply STACK_PARAMETERS either as a true multiline string
  # (CI YAML block scalar) or as a single line with \n escapes
  # (projen task exec steps) — both end up as newline-separated here.
  printf '%b\n' "$STACK_PARAMETERS"
  printf 'AssetsBucketName=%s\n' "$ASSETS_BUCKET"
  printf 'AssetsBucketPrefix=%s\n' "$ASSETS_PREFIX"
} | python3 -c '
import json
import sys

params = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line.strip():
        continue
    # Split on the FIRST = only; value may contain more = chars.
    if "=" not in line:
        print(f"Malformed STACK_PARAMETERS line (missing =): {line!r}", file=sys.stderr)
        sys.exit(1)
    key, _, value = line.partition("=")
    params.append({"ParameterKey": key.strip(), "ParameterValue": value})
json.dump(params, sys.stdout)
' > "$PARAMS_FILE"

echo "Deploying $STACK_NAME to $AWS_REGION ($CS_TYPE)"
echo "  template:   $TEMPLATE_URL"
echo "  changeset:  $CHANGESET_NAME"
echo "  params:     $PARAMS_FILE"
echo "  initial:    ${INITIAL_STATUS:-<stack does not exist>}"

# ---- create change-set ------------------------------------------------------

# shellcheck disable=SC2086  # CAPABILITIES intentionally word-split
ROLE_ARN_FLAG=""
if [ -n "$ROLE_ARN" ]; then
  ROLE_ARN_FLAG="--role-arn $ROLE_ARN"
fi

aws cloudformation create-change-set \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGESET_NAME" \
  --change-set-type "$CS_TYPE" \
  --template-url "$TEMPLATE_URL" \
  --parameters "file://$PARAMS_FILE" \
  --capabilities $CAPABILITIES \
  $ROLE_ARN_FLAG \
  >/dev/null

# Wait for change-set creation. The waiter fails when a change-set completes
# empty (no diffs) — we detect that via describe-change-set and call it done.
set +e
aws cloudformation wait change-set-create-complete \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGESET_NAME"
WAIT_RC=$?
set -e

EMPTY_CHANGESET=false
if [ "$WAIT_RC" -ne 0 ]; then
  DESC=$(aws cloudformation describe-change-set \
            --region "$AWS_REGION" \
            --stack-name "$STACK_NAME" \
            --change-set-name "$CHANGESET_NAME" \
            --query '{Status:Status,StatusReason:StatusReason}' \
            --output json)
  if echo "$DESC" | grep -qE "(didn't contain changes|No updates|The submitted information didn't contain changes)"; then
    echo "No changes to deploy — treating empty change-set as success."
    EMPTY_CHANGESET=true
    aws cloudformation delete-change-set \
      --region "$AWS_REGION" \
      --stack-name "$STACK_NAME" \
      --change-set-name "$CHANGESET_NAME" >/dev/null 2>&1 || true
    # An empty CREATE leaves a REVIEW_IN_PROGRESS stack shell behind —
    # clean it up so the next run starts fresh.
    if [ "$CS_TYPE" = "CREATE" ]; then
      aws cloudformation delete-stack \
        --region "$AWS_REGION" \
        --stack-name "$STACK_NAME" >/dev/null 2>&1 || true
    fi
  else
    echo "Change-set creation failed:" >&2
    echo "$DESC" >&2
    cleanup_on_failure
    exit 1
  fi
fi

# ---- execute + wait ---------------------------------------------------------

if [ "$EMPTY_CHANGESET" = false ]; then
  echo "Executing change-set $CHANGESET_NAME"
  aws cloudformation execute-change-set \
    --region "$AWS_REGION" \
    --stack-name "$STACK_NAME" \
    --change-set-name "$CHANGESET_NAME"

  # Before waiting for the terminal state, poll until the stack's status
  # actually transitions away from its prior value. Without this, a wait
  # against a stack that was already in CREATE_COMPLETE / UPDATE_COMPLETE
  # can race and return before CFN has switched it to _IN_PROGRESS,
  # producing a false success.
  echo "Waiting for stack to begin transitioning from ${INITIAL_STATUS:-<none>}"
  while true; do
    CURRENT="$(describe_status)"
    if [ -n "$CURRENT" ] && [ "$CURRENT" != "${INITIAL_STATUS:-}" ]; then
      echo "Stack transitioned to: $CURRENT"
      break
    fi
    sleep 5
  done

  set +e
  if [ "$CS_TYPE" = "CREATE" ]; then
    aws cloudformation wait stack-create-complete \
      --region "$AWS_REGION" --stack-name "$STACK_NAME"
    WAIT_RC=$?
  else
    aws cloudformation wait stack-update-complete \
      --region "$AWS_REGION" --stack-name "$STACK_NAME"
    WAIT_RC=$?
  fi
  set -e

  if [ "$WAIT_RC" -ne 0 ]; then
    FINAL="$(describe_status)"
    echo "Stack reached non-successful terminal state: ${FINAL:-<gone>}" >&2
    cleanup_on_failure
    exit 1
  fi
fi

# ---- capture outputs --------------------------------------------------------

STACK_STATUS="$(describe_status)"
case "$STACK_STATUS" in
  CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE)
    mkdir -p "$(dirname "$OUTPUTS_FILE")"
    aws cloudformation describe-stacks \
      --region "$AWS_REGION" \
      --stack-name "$STACK_NAME" \
      --query 'Stacks[0].Outputs' \
      --output json \
      | python3 -c "
import json, os, shlex, sys
prefix = os.environ.get('OUTPUTS_PREFIX', '')
outputs = json.load(sys.stdin) or []
for o in outputs:
    key = (prefix + '_' if prefix else '') + o['OutputKey'].upper()
    value = o['OutputValue'].replace('\n', ' ')
    # SHELL-QUOTE the value. This file is consumed by \`. dist/<stack>.env\`, i.e. SOURCED
    # by bash, so an unquoted value containing any shell metacharacter is EXECUTED rather
    # than assigned. That is not hypothetical: the failover stack's PlanHealthChecks output
    # was emitted with '|' separators and sourcing it ran the second entry as a command --
    # 'Z10195162...:us-west-2:808a9bb3...: command not found' -- which failed the deploy at
    # the NEXT phase, with the error naming a health check id and no hint that quoting was
    # the problem. Spaces, ';', '&', '\$', backticks and '(' are all the same hazard.
    # shlex.quote is exact: it single-quotes and escapes embedded single quotes.
    # NOTE: safe because nothing consumes these files as a CI dotenv artifact
    # (which strips no quotes) -- they are only ever sourced. Re-check if that changes.
    print(f'{key}={shlex.quote(value)}')
" > "$OUTPUTS_FILE"
    echo "Stack outputs written to $OUTPUTS_FILE"
    ;;
  "")
    echo "Stack $STACK_NAME not present after deploy (empty CREATE); no outputs to capture."
    ;;
  *)
    echo "Unexpected stack status: $STACK_STATUS" >&2
    cleanup_on_failure
    exit 1
    ;;
esac
