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
#
# A DELETE_FAILED is retried with a PLAIN delete first: EKS (and RDS) reject a
# delete with a 409 while an internal update is still settling, and that clears
# within a minute or two. e2e iteration 6 (2026-09-15) hit exactly that on the
# EKS cluster; the old code went straight to --retain-resources, which left an
# ACTIVE cluster outside any stack -- its ENIs pinned the subnets, and the next
# deploy would have collided on the cluster name.
#
# For the REGION stacks the first delete always fails on the VPC, and retaining is
# never the answer: the VPC "has dependencies" that no stack owns -- see
# drain_cluster_externals. So a region stack gets drain + plain re-delete, and a
# second failure is reported with the resources that failed and counted (the script
# exits non-zero), never retained. Only the other stacks keep the retain fallback.
FAILED_STACKS=""
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
        case "$stack" in
          "$PROJECT-region-"*)
            echo "  retry  $region $stack (DELETE_FAILED -> drain what the cluster left in the VPC, then plain re-delete)"
            drain_cluster_externals "$region"
            ;;
          *)
            echo "  retry  $region $stack (DELETE_FAILED -> plain re-delete after 90s; transient 409s clear)"
            sleep 90
            ;;
        esac
        aws cloudformation delete-stack --region "$region" --stack-name "$stack"
        if aws cloudformation wait stack-delete-complete --region "$region" --stack-name "$stack" 2>/dev/null; then
          continue
        fi
        status=$(aws cloudformation describe-stacks --region "$region" --stack-name "$stack" \
          --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo GONE)
        [ "$status" = "DELETE_FAILED" ] || continue
        case "$stack" in
          "$PROJECT-region-"*)
            echo "  FAIL   $region $stack still DELETE_FAILED after the drain; resources:" >&2
            aws cloudformation describe-stack-resources --region "$region" --stack-name "$stack" \
              --query "StackResources[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId,PhysicalResourceId,ResourceStatusReason]" \
              --output text >&2 || true
            FAILED_STACKS="$FAILED_STACKS $region:$stack"
            ;;
          *)
            echo "  retry  $region $stack (DELETE_FAILED again -> retain failed resources)"
            failed=$(aws cloudformation describe-stack-resources --region "$region" --stack-name "$stack" \
              --query "StackResources[?ResourceStatus=='DELETE_FAILED'].LogicalResourceId" --output text)
            # shellcheck disable=SC2086
            aws cloudformation delete-stack --region "$region" --stack-name "$stack" --retain-resources $failed
            aws cloudformation wait stack-delete-complete --region "$region" --stack-name "$stack" || {
              echo "  WARN   $region $stack still present; inspect manually" >&2
              FAILED_STACKS="$FAILED_STACKS $region:$stack"
            }
            ;;
        esac
      fi
    fi
  done
}

# Resources that Kubernetes CONTROLLERS created inside the cluster's VPC. No stack owns
# them, and they outlive the cluster: once CloudFormation has deleted the EKS cluster,
# nothing is left running to reconcile them away, so they pin the VPC and the region
# stack ends DELETE_FAILED on "The vpc has dependencies" -- every time, on every
# teardown, not only after a failed run (e2e run 9, 2026-09-15: both regions).
#   * Karpenter's nodes: EC2 instances it launched for the NodePool (the managed
#     nodegroup's nodes are stack-owned and go with the nodegroup). Tagged
#     karpenter.sh/nodepool + kubernetes.io/cluster/<cluster>=owned.
#   * The AWS Load Balancer Controller's NLBs (one per Service of type LoadBalancer:
#     orders-api, argocd-server), their target groups, and its security groups (one
#     managed SG per NLB plus the shared backend SG). Tagged elbv2.k8s.aws/cluster.
#   * The EKS-created cluster security group, which EKS leaves behind when a node ENI
#     still references it. Tagged aws:eks:cluster-name.
# Selection is BY THOSE TAGS, which the controllers write themselves, so a renamed
# Service or a second NodePool is still swept; the runner's IAM grants for these deletes
# are conditioned on the same tag keys (docs/iam/github-actions-role-policy.json), and
# test/topology.test.ts pins the two sets of keys to each other. Only meaningful once
# the cluster is gone: while it runs, Karpenter replaces terminated nodes and the LBC
# recreates deleted NLBs -- which is why this lives in the DELETE_FAILED path and not
# before the stack delete. Idempotent: nothing found -> nothing done.
drain_cluster_externals() {
  local region="$1"
  local cluster="$PROJECT-$region" ids arns sg pass
  if [ "$(aws eks describe-cluster --region "$region" --name "$cluster" --query 'cluster.status' --output text 2>/dev/null || echo ABSENT)" != "ABSENT" ]; then
    echo "  drain  $region $cluster still exists; its controllers would recreate what we delete -- skipping" >&2
    return 0
  fi
  # Karpenter nodes.
  ids=$(aws ec2 describe-instances --region "$region" \
    --filters "Name=tag-key,Values=karpenter.sh/nodepool" "Name=tag:kubernetes.io/cluster/$cluster,Values=owned" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
  if [ -n "$ids" ]; then
    echo "  drain  $region karpenter nodes: $ids -> terminate"
    # shellcheck disable=SC2086
    aws ec2 terminate-instances --region "$region" --instance-ids $ids >/dev/null
  fi
  # Load Balancer Controller NLBs and target groups: list all, keep those tagged for
  # this cluster (describe-tags takes up to 20 ARNs per call).
  arns=$(lbc_tagged "$region" "$cluster" \
    "$(aws elbv2 describe-load-balancers --region "$region" --query 'LoadBalancers[].LoadBalancerArn' --output text)")
  local arn; for arn in $arns; do
    echo "  drain  $region ${arn##*loadbalancer/} -> delete"
    aws elbv2 delete-load-balancer --region "$region" --load-balancer-arn "$arn"
  done
  arns=$(lbc_tagged "$region" "$cluster" \
    "$(aws elbv2 describe-target-groups --region "$region" --query 'TargetGroups[].TargetGroupArn' --output text)")
  for arn in $arns; do
    echo "  drain  $region ${arn##*targetgroup/} -> delete"
    aws elbv2 delete-target-group --region "$region" --target-group-arn "$arn"
  done
  # Their ENIs release a minute or two after the NLB and the instances go.
  if [ -n "$ids$arns" ]; then
    # shellcheck disable=SC2086
    [ -z "$ids" ] || aws ec2 wait instance-terminated --region "$region" --instance-ids $ids
    for pass in $(seq 1 40); do
      [ "$(aws ec2 describe-network-interfaces --region "$region" \
            --filters "Name=description,Values=ELB net/k8s-*" \
            --query 'NetworkInterfaces[].NetworkInterfaceId' --output text | wc -w)" -eq 0 ] && break
      sleep 15
    done
  fi
  # Security groups: the LBC's and the EKS cluster SG. Their rules reference each
  # other, so delete in passes until none is left rather than ordering them by hand.
  for pass in 1 2 3 4 5; do
    ids=$(aws ec2 describe-security-groups --region "$region" \
      --filters "Name=tag:elbv2.k8s.aws/cluster,Values=$cluster" --query 'SecurityGroups[].GroupId' --output text
      aws ec2 describe-security-groups --region "$region" \
      --filters "Name=tag:aws:eks:cluster-name,Values=$cluster" --query 'SecurityGroups[].GroupId' --output text)
    ids=$(echo "$ids" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
    [ -n "$ids" ] || break
    for sg in $ids; do
      if aws ec2 delete-security-group --region "$region" --group-id "$sg" 2>/dev/null; then
        echo "  drain  $region $sg -> deleted"
      fi
    done
    sleep 10
  done
  [ -z "$ids" ] || echo "  WARN   $region security groups still present after 5 passes: $ids" >&2
}

# Filter a whitespace-separated list of ELBv2 ARNs down to those tagged
# elbv2.k8s.aws/cluster=<cluster>. describe-tags accepts at most 20 ARNs per call.
lbc_tagged() {
  local region="$1" cluster="$2" all="$3" batch
  [ -n "$all" ] || return 0
  echo "$all" | tr -s '[:space:]' '\n' | sed '/^$/d' | xargs -n 20 | while read -r batch; do
    # shellcheck disable=SC2086
    aws elbv2 describe-tags --region "$region" --resource-arns $batch \
      --query "TagDescriptions[?Tags[?Key=='elbv2.k8s.aws/cluster' && Value=='$cluster']].ResourceArn" --output text
  done | tr -s '[:space:]' ' '
}

# A retained EKS cluster is not a leak you can live with: the next deploy creates a
# cluster with the SAME name and EKS refuses. Delete any cluster the rail would
# name, whether or not a stack still owns it (idempotent: absent -> no-op).
sweep_eks() {
  # Two statements on purpose: bash expands every word of a `local` line BEFORE the
  # builtin assigns any of them, so `local region="$1" name="$PROJECT-$region"` reads
  # an unset $region and aborts under set -u (e2e run 9, masked by the step's || true).
  local region="$1"
  local name="$PROJECT-$region" status
  status=$(aws eks describe-cluster --region "$region" --name "$name" --query 'cluster.status' --output text 2>/dev/null || echo ABSENT)
  case "$status" in
    ABSENT|DELETING) return 0 ;;
  esac
  echo "  eks    $region $name ($status, orphaned) -> delete"
  local ng; for ng in $(aws eks list-nodegroups --region "$region" --cluster-name "$name" --query 'nodegroups[]' --output text 2>/dev/null); do
    aws eks delete-nodegroup --region "$region" --cluster-name "$name" --nodegroup-name "$ng" >/dev/null
    aws eks wait nodegroup-deleted --region "$region" --cluster-name "$name" --nodegroup-name "$ng"
  done
  aws eks delete-cluster --region "$region" --name "$name" >/dev/null
  aws eks wait cluster-deleted --region "$region" --name "$name"
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
# A cluster the stack no longer owns (DELETE_SKIPPED after a retain) must go FIRST:
# its ENIs pin the stack's subnets and security group, so the stack delete would
# fail on them again. A cluster the stack still owns is left to CloudFormation.
# The CLI applies --query PER PAGE (bug class 25), so count client-side with wc,
# never with length(@): a two-page stack yields "0\n0" and an exact compare fails.
for r in "$PRIMARY" "$SECONDARY"; do
  owned=$(aws cloudformation list-stack-resources --region "$r" --stack-name "$PROJECT-region-$r" \
    --query "StackResourceSummaries[?ResourceType=='AWS::EKS::Cluster' && ResourceStatus!='DELETE_SKIPPED'].LogicalResourceId" \
    --output text 2>/dev/null | wc -w)
  [ "$owned" -eq 0 ] || continue
  sweep_eks "$r" || echo "  WARN   orphaned EKS cluster $PROJECT-$r in $r could not be deleted (deployer needs eks:DeleteCluster); delete it manually" >&2
done
delete_wave "$PRIMARY:$PROJECT-region-$PRIMARY" "$SECONDARY:$PROJECT-region-$SECONDARY"
for r in "$PRIMARY" "$SECONDARY"; do
  sweep_eks "$r" || echo "  WARN   orphaned EKS cluster $PROJECT-$r in $r could not be deleted (deployer needs eks:DeleteCluster); delete it manually" >&2
done

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

# ---- 6. nothing may remain --------------------------------------------------------------
# A stack left behind is a hard failure, not a warning: run 9 deployed onto a
# DELETE_FAILED region stack because the pre-flight step tolerated this script's exit
# code. Idempotent success (nothing existed) still exits 0.
for r in "$PRIMARY" "$SECONDARY" "$OBSERVER"; do
  left=$(aws cloudformation list-stacks --region "$r" \
    --stack-status-filter CREATE_COMPLETE CREATE_FAILED CREATE_IN_PROGRESS ROLLBACK_COMPLETE ROLLBACK_FAILED \
      UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE UPDATE_ROLLBACK_FAILED DELETE_FAILED DELETE_IN_PROGRESS REVIEW_IN_PROGRESS \
    --query "StackSummaries[?starts_with(StackName, '$PROJECT-')].StackName" --output text | tr -s '[:space:]' ' ')
  [ -z "${left// /}" ] || FAILED_STACKS="$FAILED_STACKS $r:$left"
done
if [ -n "${FAILED_STACKS// /}" ]; then
  echo "cleanup: FAILED -- stacks remain:$FAILED_STACKS" >&2
  exit 1
fi
echo "cleanup: done"
