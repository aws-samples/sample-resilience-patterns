#!/bin/bash
set -euo pipefail

PROJECT="${PROJECT:-aurora}"
PRIMARY_REGION="${PRIMARY_REGION:-us-east-1}"
SECONDARY_REGION="${SECONDARY_REGION:-us-west-2}"
GLOBAL_CLUSTER_ID="${PROJECT}-global-cluster"
REGIONS="${PRIMARY_REGION} ${SECONDARY_REGION}"

# Explicit stack lists from CDK app (only these stacks will be touched)
# Non-RDS stacks: deleted in parallel in Branch A
NON_RDS_PRIMARY="${PROJECT}-chaos-primary ${PROJECT}-reconciliation-primary ${PROJECT}-monitoring-primary \
${PROJECT}-loadgen ${PROJECT}-failover-plan ${PROJECT}-dns \
${PROJECT}-aurora-app-primary ${PROJECT}-schema ${PROJECT}-bootstrap"
NON_RDS_SECONDARY="${PROJECT}-chaos-secondary ${PROJECT}-reconciliation-secondary ${PROJECT}-monitoring-secondary \
${PROJECT}-aurora-app-secondary"
# RDS stacks: deleted LAST in Branch B (after RDS pipeline drains the cluster)
RDS_STACKS="${PROJECT}-db-primary:${PRIMARY_REGION} ${PROJECT}-db-secondary:${SECONDARY_REGION}"
VPC_STACKS_PRIMARY="${PROJECT}-vpc-peering ${PROJECT}-vpc-primary"
VPC_STACKS_SECONDARY="${PROJECT}-vpc-secondary"

echo "🧹 Cleaning up ${PROJECT} stacks..."

# --- Helpers ---
stack_resources() {
  local stack=$1 region=$2 type=$3
  aws cloudformation describe-stack-resources --stack-name "${stack}" --region "${region}" \
    --query "StackResources[?ResourceType=='${type}'].PhysicalResourceId" --output text 2>/dev/null || echo ""
}

stack_status() {
  local stack=$1 region=$2
  aws cloudformation describe-stacks --stack-name "${stack}" --region "${region}" \
    --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "GONE"
}

# Delete a stack with automatic --retain-resources fallback for DELETE_FAILED retries.
# Skips already-deleted stacks. Safe to call on stacks that don't exist.
delete_stack_robust() {
  local stack=$1 region=$2
  local s
  s=$(stack_status "${stack}" "${region}")
  [ "${s}" = "GONE" ] && return 0
  if [ "${s}" = "DELETE_FAILED" ]; then
    local failed_res
    failed_res=$(aws cloudformation describe-stack-events --stack-name "${stack}" --region "${region}" \
      --query "StackEvents[?ResourceStatus=='DELETE_FAILED' && LogicalResourceId!='${stack}'].LogicalResourceId" \
      --output text 2>/dev/null | tr '\t' '\n' | sort -u | tr '\n' ' ')
    if [ -n "${failed_res}" ]; then
      aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" \
        --retain-resources ${failed_res} 2>/dev/null || true
    else
      aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" 2>/dev/null || true
    fi
  else
    aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" 2>/dev/null || true
  fi
  aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${region}" 2>/dev/null || true
}

# Collect VPC IDs (needed in Phase 3 for ENI sweep)
VPC_ID_PRIMARY=$(aws cloudformation describe-stacks --stack-name "${PROJECT}-vpc-primary" --region "${PRIMARY_REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text 2>/dev/null || echo "")
VPC_ID_SECONDARY=$(aws cloudformation describe-stacks --stack-name "${PROJECT}-vpc-secondary" --region "${SECONDARY_REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text 2>/dev/null || echo "")

# Collect RDS instance + cluster IDs by region (grouped so each cluster pipeline is self-contained)
PRIMARY_CLUSTERS=$(stack_resources "${PROJECT}-db-primary" "${PRIMARY_REGION}" "AWS::RDS::DBCluster")
PRIMARY_INSTANCES=$(stack_resources "${PROJECT}-db-primary" "${PRIMARY_REGION}" "AWS::RDS::DBInstance")
SECONDARY_CLUSTERS=$(stack_resources "${PROJECT}-db-secondary" "${SECONDARY_REGION}" "AWS::RDS::DBCluster")
SECONDARY_INSTANCES=$(stack_resources "${PROJECT}-db-secondary" "${SECONDARY_REGION}" "AWS::RDS::DBInstance")

# --- Phase 0: Delete canary Lambdas + synthetics stacks FIRST (starts ENI release timer) ---
echo "Phase 0: Deleting canary Lambdas and synthetics stacks (both regions, parallel)..."
for region in ${REGIONS}; do
  vpc_id=$([ "${region}" = "${PRIMARY_REGION}" ] && echo "${VPC_ID_PRIMARY}" || echo "${VPC_ID_SECONDARY}")
  [ -z "${vpc_id}" ] && continue
  for fn in $(aws lambda list-functions --region "${region}" \
    --query "Functions[?VpcConfig.VpcId=='${vpc_id}' && starts_with(FunctionName,'cwsyn-')].FunctionName" \
    --output text 2>/dev/null || echo ""); do
    echo "  Deleting Lambda: ${fn} (${region})"
    aws lambda delete-function --function-name "${fn}" --region "${region}" 2>/dev/null || true &
  done
done
aws cloudformation delete-stack --stack-name "${PROJECT}-synthetics-primary" --region "${PRIMARY_REGION}" 2>/dev/null || true &
aws cloudformation delete-stack --stack-name "${PROJECT}-synthetics-secondary" --region "${SECONDARY_REGION}" 2>/dev/null || true &
wait
aws cloudformation wait stack-delete-complete --stack-name "${PROJECT}-synthetics-primary" --region "${PRIMARY_REGION}" 2>/dev/null || true &
aws cloudformation wait stack-delete-complete --stack-name "${PROJECT}-synthetics-secondary" --region "${SECONDARY_REGION}" 2>/dev/null || true &
wait

# --- Phase 1: TWO PARALLEL BRANCHES (non-RDS stacks + RDS pipeline) ---
echo "Phase 1: Running Branch A (non-RDS stacks) and Branch B (RDS pipeline) in parallel..."

# -----------------------------------------------------------------------------
# Branch A: Delete all non-RDS stacks in parallel across both regions.
# These stacks don't depend on the RDS cluster/global cluster, so they can tear
# down concurrently with the RDS pipeline in Branch B. They DO reference VPC
# resources (SGs, subnets) so they must finish before Phase 3 VPC deletes.
# -----------------------------------------------------------------------------
branch_a() {
  echo "  [A] Deleting non-RDS stacks in parallel..."
  for stack in ${NON_RDS_PRIMARY}; do
    (delete_stack_robust "${stack}" "${PRIMARY_REGION}") &
  done
  for stack in ${NON_RDS_SECONDARY}; do
    (delete_stack_robust "${stack}" "${SECONDARY_REGION}") &
  done
  wait
  echo "  [A] Non-RDS stacks done."
}

# -----------------------------------------------------------------------------
# Branch B: RDS pipeline. Each cluster pipeline is internally serial (AWS
# enforces ordering), but the two cluster pipelines (primary + secondary) run
# in parallel with each other, then join for delete-global-cluster and RDS
# stack deletes.
#
# Per-cluster pipeline (AWS-enforced serial ordering):
#   remove-from-global-cluster
#     → delete-db-instance (all instances in cluster, parallel within cluster)
#     → wait db-instance-deleted
#     → delete-db-cluster
#     → wait db-cluster-deleted
# -----------------------------------------------------------------------------

# Drain one cluster: remove from global, delete all its instances, wait, delete cluster, wait.
drain_cluster() {
  local region=$1 cluster_id=$2
  shift 2
  local instances="$*"

  echo "  [B:${region}] Draining cluster ${cluster_id}..."

  # Step 1: Remove from global cluster (idempotent — ignore if already removed)
  local cluster_arn
  cluster_arn=$(aws rds describe-db-clusters --db-cluster-identifier "${cluster_id}" --region "${region}" \
    --query "DBClusters[0].DBClusterArn" --output text 2>/dev/null || echo "")
  if [ -n "${cluster_arn}" ] && [ "${cluster_arn}" != "None" ]; then
    local in_global
    in_global=$(aws rds describe-db-clusters --db-cluster-identifier "${cluster_id}" --region "${region}" \
      --query "DBClusters[0].GlobalClusterIdentifier" --output text 2>/dev/null || echo "")
    if [ -n "${in_global}" ] && [ "${in_global}" != "None" ]; then
      echo "  [B:${region}] Removing ${cluster_id} from global cluster..."
      aws rds remove-from-global-cluster --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" \
        --db-cluster-identifier "${cluster_arn}" --region "${PRIMARY_REGION}" 2>/dev/null || true
      # Wait for cluster to actually detach (polling; AWS takes a few seconds)
      for _ in $(seq 1 30); do
        in_global=$(aws rds describe-db-clusters --db-cluster-identifier "${cluster_id}" --region "${region}" \
          --query "DBClusters[0].GlobalClusterIdentifier" --output text 2>/dev/null || echo "")
        [ -z "${in_global}" ] || [ "${in_global}" = "None" ] && break
        sleep 2
      done
    fi
  fi

  # Step 2: Delete all instances in this cluster (parallel within cluster)
  for inst in ${instances}; do
    echo "  [B:${region}] Deleting instance ${inst}..."
    aws rds delete-db-instance --db-instance-identifier "${inst}" --skip-final-snapshot \
      --region "${region}" 2>/dev/null || true &
  done
  wait

  # Step 3: Wait for all instances deleted
  for inst in ${instances}; do
    aws rds wait db-instance-deleted --db-instance-identifier "${inst}" --region "${region}" 2>/dev/null || true &
  done
  wait
  echo "  [B:${region}] Instances deleted for ${cluster_id}."

  # Step 4: Delete the cluster
  echo "  [B:${region}] Deleting cluster ${cluster_id}..."
  aws rds delete-db-cluster --db-cluster-identifier "${cluster_id}" --skip-final-snapshot \
    --region "${region}" 2>/dev/null || true

  # Step 5: Wait for cluster deleted
  aws rds wait db-cluster-deleted --db-cluster-identifier "${cluster_id}" --region "${region}" 2>/dev/null || true
  echo "  [B:${region}] Cluster ${cluster_id} deleted."
}

branch_b() {
  echo "  [B] Starting RDS pipeline (both clusters parallel)..."

  # Run primary + secondary cluster pipelines in parallel
  if [ -n "${PRIMARY_CLUSTERS}" ]; then
    (drain_cluster "${PRIMARY_REGION}" "${PRIMARY_CLUSTERS}" ${PRIMARY_INSTANCES}) &
  fi
  if [ -n "${SECONDARY_CLUSTERS}" ]; then
    (drain_cluster "${SECONDARY_REGION}" "${SECONDARY_CLUSTERS}" ${SECONDARY_INSTANCES}) &
  fi
  wait

  # Join: delete global cluster (now empty)
  echo "  [B] Deleting global cluster ${GLOBAL_CLUSTER_ID}..."
  aws rds delete-global-cluster --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" \
    --region "${PRIMARY_REGION}" 2>/dev/null || true

  # Delete the now-empty RDS CFN stacks in parallel. Resources are already gone,
  # so CFN just updates its state — fast and reliable.
  echo "  [B] Deleting RDS CFN stacks (empty shells)..."
  for entry in ${RDS_STACKS}; do
    stack="${entry%%:*}"; region="${entry##*:}"
    (delete_stack_robust "${stack}" "${region}") &
  done
  wait
  echo "  [B] RDS pipeline done."
}

# Fire both branches, wait for both to finish
branch_a &
BRANCH_A_PID=$!
branch_b &
BRANCH_B_PID=$!
wait "${BRANCH_A_PID}"
wait "${BRANCH_B_PID}"
echo "Phase 1 complete."

# --- Phase 2: Retry any remaining DELETE_FAILED non-VPC stacks (defensive safety net) ---
echo "Phase 2: Retrying any DELETE_FAILED non-VPC stacks..."
for stack in ${NON_RDS_PRIMARY}; do
  [ "$(stack_status "${stack}" "${PRIMARY_REGION}")" = "DELETE_FAILED" ] && \
    (delete_stack_robust "${stack}" "${PRIMARY_REGION}") &
done
for stack in ${NON_RDS_SECONDARY}; do
  [ "$(stack_status "${stack}" "${SECONDARY_REGION}")" = "DELETE_FAILED" ] && \
    (delete_stack_robust "${stack}" "${SECONDARY_REGION}") &
done
for entry in ${RDS_STACKS}; do
  stack="${entry%%:*}"; region="${entry##*:}"
  [ "$(stack_status "${stack}" "${region}")" = "DELETE_FAILED" ] && \
    (delete_stack_robust "${stack}" "${region}") &
done
wait

# --- Phase 3: Clean ENIs and delete VPC stacks (both regions parallel) ---
echo "Phase 3: Cleaning ENIs and deleting VPC stacks..."
PHASE3_START=$(date +%s)
for attempt in $(seq 1 999); do
  remaining=""
  for stack in ${VPC_STACKS_PRIMARY}; do
    s=$(stack_status "${stack}" "${PRIMARY_REGION}")
    [ "${s}" != "GONE" ] && remaining="${remaining} ${stack}:${PRIMARY_REGION}"
  done
  for stack in ${VPC_STACKS_SECONDARY}; do
    s=$(stack_status "${stack}" "${SECONDARY_REGION}")
    [ "${s}" != "GONE" ] && remaining="${remaining} ${stack}:${SECONDARY_REGION}"
  done
  [ -z "${remaining}" ] && break

  elapsed=$(( $(date +%s) - PHASE3_START ))
  if [ ${elapsed} -gt 5400 ]; then echo "  Phase 3 time limit (90 min) reached"; break; fi
  echo "  [attempt ${attempt}] $(echo ${remaining} | wc -w | tr -d ' ') VPC stacks remaining"

  # Sweep ENIs in both regions in parallel
  all_enis_gone=true
  for region in ${REGIONS}; do
    vpc_id=$([ "${region}" = "${PRIMARY_REGION}" ] && echo "${VPC_ID_PRIMARY}" || echo "${VPC_ID_SECONDARY}")
    [ -z "${vpc_id}" ] && continue
    for _ in $(seq 1 12); do  # 12 × 10s = 2 min per attempt
      enis=$(aws ec2 describe-network-interfaces --filters Name=vpc-id,Values="${vpc_id}" \
        --region "${region}" --query "NetworkInterfaces[].NetworkInterfaceId" --output text 2>/dev/null || echo "")
      [ -z "${enis}" ] && break
      for eni in ${enis}; do
        aws ec2 delete-network-interface --network-interface-id "${eni}" --region "${region}" 2>/dev/null || true
      done
      sleep 10
    done
    remaining_enis=$(aws ec2 describe-network-interfaces --filters Name=vpc-id,Values="${vpc_id}" \
      --region "${region}" --query "length(NetworkInterfaces[])" --output text 2>/dev/null || echo "0")
    [ "${remaining_enis}" != "0" ] && all_enis_gone=false
  done

  if [ "${all_enis_gone}" = "true" ] || [ "${attempt}" = "1" ]; then
    for entry in ${remaining}; do
      stack="${entry%%:*}"; region="${entry##*:}"
      aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" 2>/dev/null || true &
    done
    wait
    for entry in ${remaining}; do
      stack="${entry%%:*}"; region="${entry##*:}"
      aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${region}" 2>/dev/null || true &
    done
    wait
  fi
done

rm -rf cdk.out cdk.out.*/

# --- Final verification: fail if any stacks remain ---
echo "Verifying cleanup..."
# Build (stack, region) pairs explicitly — no double-region iteration
VERIFY_PAIRS=""
for stack in ${NON_RDS_PRIMARY} ${VPC_STACKS_PRIMARY} ${PROJECT}-synthetics-primary; do
  VERIFY_PAIRS="${VERIFY_PAIRS} ${stack}:${PRIMARY_REGION}"
done
for stack in ${NON_RDS_SECONDARY} ${VPC_STACKS_SECONDARY} ${PROJECT}-synthetics-secondary; do
  VERIFY_PAIRS="${VERIFY_PAIRS} ${stack}:${SECONDARY_REGION}"
done
for entry in ${RDS_STACKS}; do
  VERIFY_PAIRS="${VERIFY_PAIRS} ${entry}"
done

leftover=""
for entry in ${VERIFY_PAIRS}; do
  stack="${entry%%:*}"; region="${entry##*:}"
  s=$(stack_status "${stack}" "${region}")
  [ "${s}" != "GONE" ] && leftover="${leftover} ${stack}(${region}:${s})"
done
if [ -n "${leftover}" ]; then
  echo "❌ Cleanup incomplete — stacks remaining:${leftover}"
  exit 1
fi
echo "✅ Cleanup complete — all stacks deleted"
