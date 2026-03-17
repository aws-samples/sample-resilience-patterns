#!/bin/bash
set -euo pipefail

# Destroy all s3mrap stacks in correct dependency order, then the bootstrap stack.
# Usage: ./cleanup.sh [ACCOUNT_ID] [PROFILE]

PROJECT="${PROJECT:-s3mrap}"
PRIMARY_REGION="${PRIMARY_REGION:-us-east-1}"
SECONDARY_REGION="${SECONDARY_REGION:-us-west-2}"
ACCOUNT_ID="${1:-${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null)}}"
PROFILE_ARG=""
if [ -n "${2:-${AWS_PROFILE:-}}" ]; then
  PROFILE_ARG="--profile ${2:-$AWS_PROFILE}"
fi

PREFIX="${PROJECT}"

delete_stack() {
  local stack=$1 region=$2
  local status
  status=$(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" $PROFILE_ARG --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "GONE")

  if [ "$status" = "GONE" ] || [ "$status" = "DELETE_COMPLETE" ]; then
    echo "  SKIP:  $stack ($region) - already gone"
    return 0
  fi

  if [ "$status" = "ROLLBACK_COMPLETE" ] || [ "$status" = "ROLLBACK_FAILED" ]; then
    echo "  DEL:  $stack ($region) - deleting stuck stack ($status)"
    aws cloudformation delete-stack --stack-name "$stack" --region "$region" $PROFILE_ARG
    aws cloudformation wait stack-delete-complete --stack-name "$stack" --region "$region" $PROFILE_ARG 2>/dev/null || \
      aws cloudformation delete-stack --stack-name "$stack" --region "$region" --deletion-mode FORCE_DELETE_STACK $PROFILE_ARG 2>/dev/null || true
    return 0
  fi

  echo "  DEL:  $stack ($region) - deleting ($status)"
  aws cloudformation delete-stack --stack-name "$stack" --region "$region" $PROFILE_ARG
  aws cloudformation wait stack-delete-complete --stack-name "$stack" --region "$region" $PROFILE_ARG
}

delete_parallel() {
  local pids=()
  while [ $# -gt 0 ]; do
    local stack=$1 region=$2
    shift 2
    delete_stack "$stack" "$region" &
    pids+=($!)
  done
  local failed=0
  for pid in "${pids[@]}"; do
    wait "$pid" || failed=1
  done
  return $failed
}

echo "=== S3 MRAP Cleanup ==="
echo "Project: $PREFIX"
echo "Regions: $PRIMARY_REGION, $SECONDARY_REGION"
echo ""

echo "Step 1/5: Destroy failover + monitoring (parallel)"
delete_parallel \
  "${PREFIX}-failover" "$PRIMARY_REGION" \
  "${PREFIX}-monitoring-primary" "$PRIMARY_REGION" \
  "${PREFIX}-monitoring-secondary" "$SECONDARY_REGION"

echo "Step 2/5: Destroy routing lambdas (parallel)"
delete_parallel \
  "${PREFIX}-routing-primary" "$PRIMARY_REGION" \
  "${PREFIX}-routing-secondary" "$SECONDARY_REGION"

echo "Step 3/5: Destroy global routing"
delete_stack "${PREFIX}-global-routing" "$PRIMARY_REGION"

echo "Step 4/5: Destroy buckets (parallel)"
delete_parallel \
  "${PREFIX}-bucket-primary" "$PRIMARY_REGION" \
  "${PREFIX}-bucket-secondary" "$SECONDARY_REGION"

echo "Step 5/7: Destroy KMS stacks (parallel)"
delete_parallel \
  "${PREFIX}-kms-replica" "$SECONDARY_REGION" \
  "${PREFIX}-kms" "$PRIMARY_REGION"

echo "Step 6/7: Destroy bootstrap stack"
delete_stack "${PROJECT}-bootstrap" "$PRIMARY_REGION"

echo ""
echo "Step 7/7: Clean up orphaned S3 buckets"
for bucket in "${PROJECT}-${PRIMARY_REGION}-${ACCOUNT_ID}" "${PROJECT}-${SECONDARY_REGION}-${ACCOUNT_ID}" "${PROJECT}-codebuild-${ACCOUNT_ID}"; do
  if aws s3api head-bucket --bucket "$bucket" $PROFILE_ARG 2>/dev/null; then
    echo "  DEL: s3://$bucket (orphaned)"
    aws s3 rb "s3://$bucket" --force $PROFILE_ARG 2>/dev/null || true
  fi
done

echo ""
echo "OK: All stacks destroyed"

echo ""
echo "Step 7: Clean local CDK output"
rm -rf cdk.out cdk.out.* 2>/dev/null
echo "  OK: Removed cdk.out directories"
