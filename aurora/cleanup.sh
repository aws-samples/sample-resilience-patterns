#!/bin/bash
set -euo pipefail

PROJECT="${PROJECT:-aurora}"
PRIMARY_REGION="${PRIMARY_REGION:-us-east-1}"
SECONDARY_REGION="${SECONDARY_REGION:-us-west-2}"
GLOBAL_CLUSTER_ID="${PROJECT}-global-cluster"

echo "🧹 Cleaning up ${PROJECT} stacks..."

# --- Nuke all CloudFormation stacks (fire-and-forget) ---
echo "Phase 1: Deleting all stacks..."
for region in ${PRIMARY_REGION} ${SECONDARY_REGION}; do
  for stack in $(aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE \
    --region "${region}" --query "StackSummaries[?starts_with(StackName,'${PROJECT}-') && StackName!='${PROJECT}-bootstrap'].StackName" --output text 2>/dev/null); do
    echo "  ${stack} (${region})"
    aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" 2>/dev/null || true &
  done
done
wait

# --- Nuke RDS directly (don't wait for CloudFormation) ---
echo "Phase 2: Force-deleting RDS..."
# Kill instances
for region in ${PRIMARY_REGION} ${SECONDARY_REGION}; do
  for inst in $(aws rds describe-db-instances --region "${region}" \
    --query "DBInstances[?contains(DBClusterIdentifier,'${PROJECT}')].DBInstanceIdentifier" --output text 2>/dev/null); do
    echo "  Instance: ${inst}"
    aws rds delete-db-instance --db-instance-identifier "${inst}" --skip-final-snapshot --region "${region}" 2>/dev/null || true &
  done
done
wait

# Detach + kill clusters
for arn in $(aws rds describe-global-clusters --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" --region "${PRIMARY_REGION}" \
  --query "GlobalClusters[0].GlobalClusterMembers[].DBClusterArn" --output text 2>/dev/null || echo ""); do
  [ -z "${arn}" ] || [ "${arn}" = "None" ] && continue
  aws rds remove-from-global-cluster --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" \
    --db-cluster-identifier "${arn}" --region "${PRIMARY_REGION}" 2>/dev/null || true
done
for region in ${SECONDARY_REGION} ${PRIMARY_REGION}; do
  for cluster in $(aws rds describe-db-clusters --region "${region}" \
    --query "DBClusters[?contains(DBClusterIdentifier,'${PROJECT}')].DBClusterIdentifier" --output text 2>/dev/null); do
    echo "  Cluster: ${cluster}"
    aws rds delete-db-cluster --db-cluster-identifier "${cluster}" --skip-final-snapshot --region "${region}" 2>/dev/null || true &
  done
done
aws rds delete-global-cluster --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" --region "${PRIMARY_REGION}" 2>/dev/null || true
wait

# --- Wait for all stacks to finish deleting ---
echo "Phase 3: Waiting for stack deletes..."
for region in ${PRIMARY_REGION} ${SECONDARY_REGION}; do
  for stack in $(aws cloudformation list-stacks --stack-status-filter DELETE_IN_PROGRESS \
    --region "${region}" --query "StackSummaries[?starts_with(StackName,'${PROJECT}-')].StackName" --output text 2>/dev/null); do
    aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${region}" 2>/dev/null || true &
  done
done
wait

# --- Retry any DELETE_FAILED stacks until clean ---
echo "Phase 4: Retrying failed stacks..."
for attempt in 1 2 3; do
  failed_stacks=""
  for region in ${PRIMARY_REGION} ${SECONDARY_REGION}; do
    for stack in $(aws cloudformation list-stacks --stack-status-filter DELETE_FAILED \
      --region "${region}" --query "StackSummaries[?starts_with(StackName,'${PROJECT}-')].StackName" --output text 2>/dev/null); do
      failed_stacks="yes"
      echo "  [attempt ${attempt}] ${stack} (${region})"
      # Clean orphan ENIs
      vpc_id=$(aws cloudformation describe-stacks --stack-name "${stack}" --region "${region}" \
        --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text 2>/dev/null || echo "")
      if [ -n "${vpc_id}" ]; then
        for eni in $(aws ec2 describe-network-interfaces --filters Name=vpc-id,Values="${vpc_id}" \
          --region "${region}" --query "NetworkInterfaces[].NetworkInterfaceId" --output text 2>/dev/null); do
          aws ec2 detach-network-interface --attachment-id "$(aws ec2 describe-network-interfaces --network-interface-ids "${eni}" \
            --region "${region}" --query "NetworkInterfaces[0].Attachment.AttachmentId" --output text 2>/dev/null)" \
            --force --region "${region}" 2>/dev/null || true
          aws ec2 delete-network-interface --network-interface-id "${eni}" --region "${region}" 2>/dev/null || true
        done
        sleep 5
      fi
      # Try plain delete first (blockers may be gone now)
      aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" 2>/dev/null || true
      aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${region}" 2>/dev/null || true
      # If still failed, retain the problematic resources
      local status2
      status2=$(aws cloudformation describe-stacks --stack-name "${stack}" --region "${region}" --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "GONE")
      if [ "${status2}" = "DELETE_FAILED" ]; then
        failed_res=$(aws cloudformation describe-stack-events --stack-name "${stack}" --region "${region}" \
          --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].LogicalResourceId" --output text 2>/dev/null || echo "")
        if [ -n "${failed_res}" ]; then
          aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" --retain-resources ${failed_res} 2>/dev/null || true
          aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${region}" 2>/dev/null || true
        fi
      fi
    done
  done
  [ -z "${failed_stacks}" ] && break
  sleep 10
done

# --- Bootstrap ---
echo "Phase 5: Bootstrap..."
aws cloudformation delete-stack --stack-name "${PROJECT}-bootstrap" --region "${PRIMARY_REGION}" 2>/dev/null || true
aws cloudformation wait stack-delete-complete --stack-name "${PROJECT}-bootstrap" --region "${PRIMARY_REGION}" 2>/dev/null || true

# --- Local artifacts ---
rm -rf cdk.out cdk.out.*/

echo "✅ Cleanup complete"
