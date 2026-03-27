#!/bin/bash
set -euo pipefail

PROJECT="${PROJECT:-aurora}"
PRIMARY_REGION="${PRIMARY_REGION:-us-east-1}"
SECONDARY_REGION="${SECONDARY_REGION:-us-west-2}"
GLOBAL_CLUSTER_ID="${PROJECT}-global-cluster"

echo "🧹 Cleaning up ${PROJECT} stacks..."

# --- Phase 1: Nuke all CloudFormation stacks (fire-and-forget) ---
echo "Phase 1: Deleting all stacks..."
for region in ${PRIMARY_REGION} ${SECONDARY_REGION}; do
  for stack in $(aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE \
    --region "${region}" --query "StackSummaries[?starts_with(StackName,'${PROJECT}-') && StackName!='${PROJECT}-bootstrap'].StackName" --output text 2>/dev/null); do
    echo "  ${stack} (${region})"
    aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" 2>/dev/null || true &
  done
done
wait

# --- Phase 2: Nuke RDS directly (don't wait for CloudFormation) ---
echo "Phase 2: Force-deleting RDS..."
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

# --- Phase 3: Wait for everything to finish ---
echo "Phase 3: Waiting for deletes..."
# Wait for stacks
for region in ${PRIMARY_REGION} ${SECONDARY_REGION}; do
  for stack in $(aws cloudformation list-stacks --stack-status-filter DELETE_IN_PROGRESS \
    --region "${region}" --query "StackSummaries[?starts_with(StackName,'${PROJECT}-')].StackName" --output text 2>/dev/null); do
    aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${region}" 2>/dev/null || true &
  done
done
# Wait for RDS clusters to be fully gone
for region in ${PRIMARY_REGION} ${SECONDARY_REGION}; do
  for cluster in $(aws rds describe-db-clusters --region "${region}" \
    --query "DBClusters[?contains(DBClusterIdentifier,'${PROJECT}')].DBClusterIdentifier" --output text 2>/dev/null); do
    echo "  Waiting for cluster ${cluster}..."
    aws rds wait db-cluster-deleted --db-cluster-identifier "${cluster}" --region "${region}" 2>/dev/null || true &
  done
done
wait
# Delete global cluster (may need clusters gone first)
aws rds delete-global-cluster --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" --region "${PRIMARY_REGION}" 2>/dev/null || true

# --- Phase 4: Retry DELETE_FAILED stacks ---
echo "Phase 4: Retrying failed stacks..."
for attempt in 1 2 3; do
  failed_stacks=""
  for region in ${PRIMARY_REGION} ${SECONDARY_REGION}; do
    for stack in $(aws cloudformation list-stacks --stack-status-filter DELETE_FAILED \
      --region "${region}" --query "StackSummaries[?starts_with(StackName,'${PROJECT}-')].StackName" --output text 2>/dev/null); do
      failed_stacks="yes"
      echo "  [attempt ${attempt}] ${stack} (${region})"

      # Clean orphan ENIs (force-detach, wait, delete)
      vpc_id=$(aws cloudformation describe-stacks --stack-name "${stack}" --region "${region}" \
        --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text 2>/dev/null || echo "")
      if [ -n "${vpc_id}" ]; then
        for eni in $(aws ec2 describe-network-interfaces --filters Name=vpc-id,Values="${vpc_id}" \
          --region "${region}" --query "NetworkInterfaces[].NetworkInterfaceId" --output text 2>/dev/null); do
          attach_id=$(aws ec2 describe-network-interfaces --network-interface-ids "${eni}" \
            --region "${region}" --query "NetworkInterfaces[0].Attachment.AttachmentId" --output text 2>/dev/null || echo "None")
          if [ "${attach_id}" != "None" ] && [ -n "${attach_id}" ]; then
            aws ec2 detach-network-interface --attachment-id "${attach_id}" --force --region "${region}" 2>/dev/null || true
          fi
        done
        # Wait for ENIs to become available then delete
        for _ in 1 2 3 4 5 6; do
          remaining=$(aws ec2 describe-network-interfaces --filters Name=vpc-id,Values="${vpc_id}" \
            --region "${region}" --query "length(NetworkInterfaces[])" --output text 2>/dev/null || echo "0")
          [ "${remaining}" = "0" ] && break
          sleep 10
          for eni in $(aws ec2 describe-network-interfaces --filters Name=vpc-id,Values="${vpc_id}" Name=status,Values=available \
            --region "${region}" --query "NetworkInterfaces[].NetworkInterfaceId" --output text 2>/dev/null); do
            aws ec2 delete-network-interface --network-interface-id "${eni}" --region "${region}" 2>/dev/null || true
          done
        done
      fi

      # Try plain delete
      aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" 2>/dev/null || true
      aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${region}" 2>/dev/null || true

      # If still failed, retain problematic resources
      status2=$(aws cloudformation describe-stacks --stack-name "${stack}" --region "${region}" \
        --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "GONE")
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

# --- Phase 5: Bootstrap ---
echo "Phase 5: Bootstrap..."
aws cloudformation delete-stack --stack-name "${PROJECT}-bootstrap" --region "${PRIMARY_REGION}" 2>/dev/null || true
aws cloudformation wait stack-delete-complete --stack-name "${PROJECT}-bootstrap" --region "${PRIMARY_REGION}" 2>/dev/null || true

rm -rf cdk.out cdk.out.*/
echo "✅ Cleanup complete"
