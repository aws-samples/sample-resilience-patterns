#!/bin/bash
set -euo pipefail

PROJECT="${PROJECT:-aurora}"
PRIMARY_REGION="${PRIMARY_REGION:-us-east-1}"
SECONDARY_REGION="${SECONDARY_REGION:-us-west-2}"
GLOBAL_CLUSTER_ID="${PROJECT}-global-cluster"

echo "🧹 Cleaning up ${PROJECT} stacks..."

# --- Helpers ---

delete_stack() {
  local stack=$1 region=$2
  echo "  Deleting ${stack} in ${region}..."
  aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" 2>/dev/null || true
  aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${region}" 2>/dev/null || true
}

stack_exists() {
  local status
  status=$(aws cloudformation describe-stacks --stack-name "$1" --region "$2" --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "GONE")
  [ "${status}" != "GONE" ]
}

# --- Phase 1: Delete all leaf stacks in parallel ---
echo "Phase 1: Leaf stacks..."
for s in \
  "${PROJECT}-chaos-primary:${PRIMARY_REGION}" \
  "${PROJECT}-chaos-secondary:${SECONDARY_REGION}" \
  "${PROJECT}-reconciliation-primary:${PRIMARY_REGION}" \
  "${PROJECT}-reconciliation-secondary:${SECONDARY_REGION}" \
  "${PROJECT}-monitoring-primary:${PRIMARY_REGION}" \
  "${PROJECT}-monitoring-secondary:${SECONDARY_REGION}" \
  "${PROJECT}-loadgen:${PRIMARY_REGION}" \
  "${PROJECT}-synthetics-primary:${PRIMARY_REGION}" \
  "${PROJECT}-synthetics-secondary:${SECONDARY_REGION}"; do
  stack="${s%%:*}"; region="${s##*:}"
  aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" 2>/dev/null || true &
done
wait
# Wait for all to finish
for s in \
  "${PROJECT}-chaos-primary:${PRIMARY_REGION}" \
  "${PROJECT}-chaos-secondary:${SECONDARY_REGION}" \
  "${PROJECT}-reconciliation-primary:${PRIMARY_REGION}" \
  "${PROJECT}-reconciliation-secondary:${SECONDARY_REGION}" \
  "${PROJECT}-monitoring-primary:${PRIMARY_REGION}" \
  "${PROJECT}-monitoring-secondary:${SECONDARY_REGION}" \
  "${PROJECT}-loadgen:${PRIMARY_REGION}" \
  "${PROJECT}-synthetics-primary:${PRIMARY_REGION}" \
  "${PROJECT}-synthetics-secondary:${SECONDARY_REGION}"; do
  stack="${s%%:*}"; region="${s##*:}"
  aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${region}" 2>/dev/null || true &
done
wait
echo "  Leaf stacks done"

# --- Phase 2: Failover plan + app stacks in parallel ---
echo "Phase 2: Failover plan + apps..."
for s in \
  "${PROJECT}-failover-plan:${PRIMARY_REGION}" \
  "${PROJECT}-aurora-app-primary:${PRIMARY_REGION}" \
  "${PROJECT}-aurora-app-secondary:${SECONDARY_REGION}"; do
  stack="${s%%:*}"; region="${s##*:}"
  aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" 2>/dev/null || true &
done
wait
for s in \
  "${PROJECT}-failover-plan:${PRIMARY_REGION}" \
  "${PROJECT}-aurora-app-primary:${PRIMARY_REGION}" \
  "${PROJECT}-aurora-app-secondary:${SECONDARY_REGION}"; do
  stack="${s%%:*}"; region="${s##*:}"
  aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${region}" 2>/dev/null || true &
done
wait
echo "  Apps done"

# --- Phase 3: DNS + schema in parallel ---
echo "Phase 3: DNS + schema..."
aws cloudformation delete-stack --stack-name "${PROJECT}-dns" --region "${PRIMARY_REGION}" 2>/dev/null || true &
aws cloudformation delete-stack --stack-name "${PROJECT}-schema" --region "${PRIMARY_REGION}" 2>/dev/null || true &
wait
aws cloudformation wait stack-delete-complete --stack-name "${PROJECT}-dns" --region "${PRIMARY_REGION}" 2>/dev/null || true &
aws cloudformation wait stack-delete-complete --stack-name "${PROJECT}-schema" --region "${PRIMARY_REGION}" 2>/dev/null || true &
wait
echo "  DNS + schema done"

# --- Phase 4: Nuke databases via RDS API (bypass CloudFormation) ---
echo "Phase 4: Databases (aggressive)..."

# Delete all Aurora instances directly — no detach wait needed
for region in ${PRIMARY_REGION} ${SECONDARY_REGION}; do
  for inst in $(aws rds describe-db-instances --region "${region}" \
    --query "DBInstances[?contains(DBClusterIdentifier,'${PROJECT}')].DBInstanceIdentifier" --output text 2>/dev/null); do
    echo "  Deleting instance ${inst} in ${region}"
    aws rds delete-db-instance --db-instance-identifier "${inst}" --skip-final-snapshot --region "${region}" 2>/dev/null || true &
  done
done
wait

# Wait for all instances to be gone
for region in ${PRIMARY_REGION} ${SECONDARY_REGION}; do
  for inst in $(aws rds describe-db-instances --region "${region}" \
    --query "DBInstances[?contains(DBClusterIdentifier,'${PROJECT}')].DBInstanceIdentifier" --output text 2>/dev/null); do
    echo "  Waiting for ${inst}..."
    aws rds wait db-instance-deleted --db-instance-identifier "${inst}" --region "${region}" 2>/dev/null || true &
  done
done
wait
echo "  Instances gone"

# Detach clusters from global cluster
for member_arn in $(aws rds describe-global-clusters --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" --region "${PRIMARY_REGION}" \
  --query "GlobalClusters[0].GlobalClusterMembers[].DBClusterArn" --output text 2>/dev/null || echo ""); do
  [ -z "${member_arn}" ] || [ "${member_arn}" = "None" ] && continue
  echo "  Detaching ${member_arn}"
  aws rds remove-from-global-cluster --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" \
    --db-cluster-identifier "${member_arn}" --region "${PRIMARY_REGION}" 2>/dev/null || true
done

# Delete clusters directly
for region in ${SECONDARY_REGION} ${PRIMARY_REGION}; do
  for cluster in $(aws rds describe-db-clusters --region "${region}" \
    --query "DBClusters[?contains(DBClusterIdentifier,'${PROJECT}')].DBClusterIdentifier" --output text 2>/dev/null); do
    echo "  Deleting cluster ${cluster} in ${region}"
    aws rds delete-db-cluster --db-cluster-identifier "${cluster}" --skip-final-snapshot --region "${region}" 2>/dev/null || true &
  done
done
wait

# Delete global cluster
aws rds delete-global-cluster --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" --region "${PRIMARY_REGION}" 2>/dev/null || true

# Wait for clusters to be gone
for region in ${SECONDARY_REGION} ${PRIMARY_REGION}; do
  for cluster in $(aws rds describe-db-clusters --region "${region}" \
    --query "DBClusters[?contains(DBClusterIdentifier,'${PROJECT}')].DBClusterIdentifier" --output text 2>/dev/null); do
    echo "  Waiting for ${cluster}..."
    aws rds wait db-cluster-deleted --db-cluster-identifier "${cluster}" --region "${region}" 2>/dev/null || true &
  done
done
wait
echo "  Clusters gone"

# Now delete DB CloudFormation stacks with retain (resources already gone)
aws cloudformation delete-stack --stack-name "${PROJECT}-db-secondary" --region "${SECONDARY_REGION}" \
  --retain-resources SecondaryClusterAF0232D7 SecondaryClusterSubnets7349025E 2>/dev/null || true &
aws cloudformation delete-stack --stack-name "${PROJECT}-db-primary" --region "${PRIMARY_REGION}" \
  --retain-resources GlobalCluster PrimaryCluster20EA3E97 PrimaryClusterSubnetsE1B4E9AB 2>/dev/null || true &
wait
aws cloudformation wait stack-delete-complete --stack-name "${PROJECT}-db-secondary" --region "${SECONDARY_REGION}" 2>/dev/null || true &
aws cloudformation wait stack-delete-complete --stack-name "${PROJECT}-db-primary" --region "${PRIMARY_REGION}" 2>/dev/null || true &
wait
echo "  DB stacks gone"

# --- Phase 5: VPC peering + ENIs + VPCs ---
echo "Phase 5: Networking..."
delete_stack "${PROJECT}-vpc-peering" "${PRIMARY_REGION}"

# Clean orphan Lambda ENIs
for region in ${PRIMARY_REGION} ${SECONDARY_REGION}; do
  suffix=$([ "${region}" = "${PRIMARY_REGION}" ] && echo "primary" || echo "secondary")
  VPC_ID=$(aws cloudformation describe-stacks --stack-name "${PROJECT}-vpc-${suffix}" --region "${region}" \
    --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text 2>/dev/null || echo "")
  if [ -n "${VPC_ID}" ]; then
    for eni in $(aws ec2 describe-network-interfaces --filters Name=vpc-id,Values="${VPC_ID}" Name=status,Values=available \
      --region "${region}" --query "NetworkInterfaces[].NetworkInterfaceId" --output text 2>/dev/null); do
      echo "  Deleting orphan ENI ${eni} in ${region}"
      aws ec2 delete-network-interface --network-interface-id "${eni}" --region "${region}" 2>/dev/null || true
    done
  fi
done

delete_stack "${PROJECT}-vpc-primary" "${PRIMARY_REGION}" &
delete_stack "${PROJECT}-vpc-secondary" "${SECONDARY_REGION}" &
wait
echo "  Networking done"

# --- Phase 6: Bootstrap ---
echo "Phase 6: Bootstrap..."
delete_stack "${PROJECT}-bootstrap" "${PRIMARY_REGION}"

# --- Cleanup local artifacts ---
rm -rf cdk.out cdk.out.*/

echo "✅ Cleanup complete"
