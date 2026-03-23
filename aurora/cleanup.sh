#!/bin/bash
set -euo pipefail

PROJECT="${PROJECT:-aurora}"
PRIMARY_REGION="${PRIMARY_REGION:-us-east-1}"
SECONDARY_REGION="${SECONDARY_REGION:-us-west-2}"

echo "🧹 Cleaning up ${PROJECT} stacks..."

delete_stack() {
  local stack=$1 region=$2
  echo "  Deleting ${stack} in ${region}..."
  aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" 2>/dev/null || true
  aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${region}" 2>/dev/null || true
}

delete_parallel() {
  local stack=$1
  delete_stack "${stack}" "${PRIMARY_REGION}" &
  delete_stack "${stack}" "${SECONDARY_REGION}" &
  wait
}

# 1. Delete stuck stacks
for region in ${PRIMARY_REGION} ${SECONDARY_REGION}; do
  for status in ROLLBACK_COMPLETE ROLLBACK_FAILED; do
    stacks=$(aws cloudformation list-stacks --stack-status-filter "${status}" --region "${region}" \
      --query "StackSummaries[?starts_with(StackName,'${PROJECT}')].StackName" --output text 2>/dev/null || true)
    for s in ${stacks}; do
      echo "  Force-deleting stuck stack: ${s} (${status}) in ${region}"
      aws cloudformation delete-stack --stack-name "${s}" --region "${region}" 2>/dev/null || true
    done
  done
done

# 2. Chaos
echo "Destroying chaos stacks..."
delete_stack "${PROJECT}-chaos-primary" "${PRIMARY_REGION}" &
delete_stack "${PROJECT}-chaos-secondary" "${SECONDARY_REGION}" &
wait

# 3. Reconciliation
echo "Destroying reconciliation stacks..."
delete_stack "${PROJECT}-reconciliation-primary" "${PRIMARY_REGION}" &
delete_stack "${PROJECT}-reconciliation-secondary" "${SECONDARY_REGION}" &
wait

# 4. Monitoring
echo "Destroying monitoring stacks..."
delete_stack "${PROJECT}-monitoring-primary" "${PRIMARY_REGION}" &
delete_stack "${PROJECT}-monitoring-secondary" "${SECONDARY_REGION}" &
wait

# 5. Load gen
echo "Destroying loadgen stack..."
delete_stack "${PROJECT}-loadgen" "${PRIMARY_REGION}"

# 6. Synthetics
echo "Destroying synthetics stacks..."
delete_stack "${PROJECT}-synthetics-primary" "${PRIMARY_REGION}" &
delete_stack "${PROJECT}-synthetics-secondary" "${SECONDARY_REGION}" &
wait

# 7. Failover plan
echo "Destroying failover plan..."
delete_stack "${PROJECT}-failover-plan" "${PRIMARY_REGION}"

# 8. DNS
echo "Destroying DNS stack..."
delete_stack "${PROJECT}-dns" "${PRIMARY_REGION}"

# 9. App stacks
echo "Destroying app stacks..."
delete_stack "${PROJECT}-aurora-app-primary" "${PRIMARY_REGION}" &
delete_stack "${PROJECT}-aurora-app-secondary" "${SECONDARY_REGION}" &
wait

# 10. Schema
echo "Destroying schema stack..."
delete_stack "${PROJECT}-schema" "${PRIMARY_REGION}"

# 12. Database — detach all members from global cluster, then delete
echo "Detaching all clusters from global cluster..."
GLOBAL_CLUSTER_ID="${PROJECT}-global-cluster"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Get all member ARNs from the global cluster
for member_arn in $(aws rds describe-global-clusters --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" --region "${PRIMARY_REGION}" --query "GlobalClusters[0].GlobalClusterMembers[].DBClusterArn" --output text 2>/dev/null || echo ""); do
  if [ -n "${member_arn}" ] && [ "${member_arn}" != "None" ]; then
    echo "  Detaching ${member_arn}..."
    aws rds remove-from-global-cluster \
      --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" \
      --db-cluster-identifier "${member_arn}" \
      --region "${PRIMARY_REGION}" 2>/dev/null || true
  fi
done
echo "Waiting for detach to complete..."
sleep 60

aws rds delete-global-cluster --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" --region "${PRIMARY_REGION}" 2>/dev/null || true

echo "Destroying database secondary..."
delete_stack "${PROJECT}-db-secondary" "${SECONDARY_REGION}"

echo "Destroying database primary..."
delete_stack "${PROJECT}-db-primary" "${PRIMARY_REGION}"

# 14. VPC peering
echo "Destroying VPC peering..."
delete_stack "${PROJECT}-vpc-peering" "${PRIMARY_REGION}"

# 15. VPCs
echo "Destroying VPC stacks..."
delete_stack "${PROJECT}-vpc-primary" "${PRIMARY_REGION}"
delete_stack "${PROJECT}-vpc-secondary" "${SECONDARY_REGION}"

# 16. Bootstrap
echo "Destroying bootstrap stack..."
delete_stack "${PROJECT}-bootstrap" "${PRIMARY_REGION}"

# 17. Clean local artifacts
echo "Cleaning local cdk.out directories..."
rm -rf cdk.out cdk.out.*/

echo "✅ Cleanup complete"
