#!/usr/bin/env bash
# Tear down everything eks-multi-region created. Idempotent: safe to run against a partial
# deploy, a failed deploy, or an account where nothing exists.
#
# Order is the deploy rail's dependency graph reversed. Two orderings are load-bearing:
#   * the Aurora GLOBAL cluster (globaldata, primary) cannot delete while it still has a
#     secondary member (secondarydb, standby), so secondarydb goes first and we WAIT;
#   * the region stacks (EKS + VPC) go last, because every other stack references their
#     outputs and an EKS cluster with dependents still attached fails to delete.
# The stack names MIRROR the deploy rail in .projen/tasks.json; test/topology.test.ts pins
# the two lists against each other.
#
# Env: ASSETS_BUCKET_PREFIX (required), PROJECT_NAME (default eks-mr-demo), regions.
set -euo pipefail

PROJECT="${PROJECT_NAME:-eks-mr-demo}"
PRIMARY="${PRIMARY_REGION:-us-east-2}"
SECONDARY="${SECONDARY_REGION:-us-west-2}"
OBSERVER="${OBSERVER_REGION:-us-east-1}"
: "${ASSETS_BUCKET_PREFIX:?ASSETS_BUCKET_PREFIX is required (the prefix the deploy used)}"
MIRROR_PREFIX="${MIRROR_PREFIX:-$PROJECT/mirror}"

echo "cleanup: project=$PROJECT regions=$PRIMARY,$SECONDARY,$OBSERVER assets=$ASSETS_BUCKET_PREFIX-*"

# ---- helpers -----------------------------------------------------------------------------
stack_exists() { aws cloudformation describe-stacks --region "$1" --stack-name "$2" >/dev/null 2>&1; }

# Start deleting a stack; no-op if absent. DELETE_FAILED stacks are retried once with
# --retain-resources on whatever failed, so a stuck stack does not block everything else.
begin_delete() {
  local region="$1" stack="$2"
  if ! stack_exists "$region" "$stack"; then echo "  skip   $region $stack (absent)"; return 0; fi
  echo "  delete $region $stack"
  aws cloudformation delete-stack --region "$region" --stack-name "$stack"
}

# Wait for a set of "region:stack" entries to finish deleting.
wait_deleted() {
  local entry region stack status
  for entry in "$@"; do
    region="${entry%%:*}"; stack="${entry#*:}"
    stack_exists "$region" "$stack" || continue
    echo "  wait   $region $stack"
    if ! aws cloudformation wait stack-delete-complete --region "$region" --stack-name "$stack" 2>/dev/null; then
      status=$(aws cloudformation describe-stacks --region "$region" --stack-name "$stack" \
        --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo GONE)
      if [ "$status" = "DELETE_FAILED" ]; then
        echo "  retry  $region $stack (DELETE_FAILED -> retain failed resources)"
        failed=$(aws cloudformation describe-stack-resources --region "$region" --stack-name "$stack" \
          --query "StackResources[?ResourceStatus=='DELETE_FAILED'].LogicalResourceId" --output text)
        # shellcheck disable=SC2086
        aws cloudformation delete-stack --region "$region" --stack-name "$stack" --retain-resources $failed
        aws cloudformation wait stack-delete-complete --region "$region" --stack-name "$stack" || \
          echo "  WARN   $region $stack still present; inspect manually" >&2
      fi
    fi
  done
}

delete_wave() {  # begin every entry, then wait for all -- one wave in parallel
  local e; for e in "$@"; do begin_delete "${e%%:*}" "${e#*:}"; done; wait_deleted "$@"
}

# ---- 1. leaf stacks: operator access, ARC plan, DNS, load gen, standby access ------------
delete_wave \
  "$PRIMARY:$PROJECT-access-$PRIMARY" \
  "$SECONDARY:$PROJECT-access-$SECONDARY" \
  "$PRIMARY:$PROJECT-failover" \
  "$PRIMARY:$PROJECT-dns" \
  "$PRIMARY:$PROJECT-loadgen" \
  "$SECONDARY:$PROJECT-standbyaccess"

# ---- 2. observer VPC (its peerings to the workload VPCs go with it) ----------------------
delete_wave "$OBSERVER:$PROJECT-observer"

# ---- 3. Aurora: secondary member FIRST, then the global cluster ---------------------------
delete_wave "$SECONDARY:$PROJECT-secondarydb"
delete_wave "$PRIMARY:$PROJECT-globaldata"

# ---- 4. workload peering, then the two region stacks (EKS + VPC; slowest) ----------------
delete_wave "$PRIMARY:$PROJECT-peering"
delete_wave "$PRIMARY:$PROJECT-region-$PRIMARY" "$SECONDARY:$PROJECT-region-$SECONDARY"

# ---- 5. non-CloudFormation residue -------------------------------------------------------
# Mirror ECR repositories (created by build/mirror-images.sh, not by a stack).
for r in "$PRIMARY" "$SECONDARY"; do
  for repo in $(aws ecr describe-repositories --region "$r" \
      --query "repositories[?starts_with(repositoryName, '$MIRROR_PREFIX/') || starts_with(repositoryName, '$PROJECT/')].repositoryName" \
      --output text 2>/dev/null); do
    echo "  ecr    $r $repo"
    aws ecr delete-repository --region "$r" --repository-name "$repo" --force >/dev/null
  done
done

# Assets buckets (created by `make buckets`), the observer region's included -- the
# observer template is read from that bucket. Empty, then delete.
for r in "$PRIMARY" "$SECONDARY" "$OBSERVER"; do
  b="$ASSETS_BUCKET_PREFIX-$r"
  if aws s3api head-bucket --bucket "$b" --region "$r" 2>/dev/null; then
    echo "  s3     $b"
    aws s3 rm "s3://$b" --recursive --region "$r" --quiet || true
    aws s3api delete-bucket --bucket "$b" --region "$r"
  fi
done

echo "cleanup: done"
