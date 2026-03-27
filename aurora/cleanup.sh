#!/bin/bash
set -euo pipefail

PROJECT="${PROJECT:-aurora}"
PRIMARY_REGION="${PRIMARY_REGION:-us-east-1}"
SECONDARY_REGION="${SECONDARY_REGION:-us-west-2}"
GLOBAL_CLUSTER_ID="${PROJECT}-global-cluster"
REGIONS="${PRIMARY_REGION} ${SECONDARY_REGION}"

echo "🧹 Cleaning up ${PROJECT} stacks..."

# --- Phase 1: Fire delete on all stacks + nuke RDS directly (all parallel) ---
echo "Phase 1: Deleting everything..."
for region in ${REGIONS}; do
  for stack in $(aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE \
    --region "${region}" --query "StackSummaries[?starts_with(StackName,'${PROJECT}-') && StackName!='${PROJECT}-bootstrap'].StackName" --output text 2>/dev/null); do
    echo "  Stack: ${stack} (${region})"
    aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" 2>/dev/null || true &
  done
  # Kill DB instances directly
  for inst in $(aws rds describe-db-instances --region "${region}" \
    --query "DBInstances[?contains(DBClusterIdentifier,'${PROJECT}')].DBInstanceIdentifier" --output text 2>/dev/null); do
    echo "  Instance: ${inst} (${region})"
    aws rds delete-db-instance --db-instance-identifier "${inst}" --skip-final-snapshot --region "${region}" 2>/dev/null || true &
  done
done
# Detach + kill clusters
for arn in $(aws rds describe-global-clusters --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" --region "${PRIMARY_REGION}" \
  --query "GlobalClusters[0].GlobalClusterMembers[].DBClusterArn" --output text 2>/dev/null || echo ""); do
  [ -z "${arn}" ] || [ "${arn}" = "None" ] && continue
  aws rds remove-from-global-cluster --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" \
    --db-cluster-identifier "${arn}" --region "${PRIMARY_REGION}" 2>/dev/null || true
done
for region in ${REGIONS}; do
  for cluster in $(aws rds describe-db-clusters --region "${region}" \
    --query "DBClusters[?contains(DBClusterIdentifier,'${PROJECT}')].DBClusterIdentifier" --output text 2>/dev/null); do
    echo "  Cluster: ${cluster} (${region})"
    aws rds delete-db-cluster --db-cluster-identifier "${cluster}" --skip-final-snapshot --region "${region}" 2>/dev/null || true &
  done
done
aws rds delete-global-cluster --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" --region "${PRIMARY_REGION}" 2>/dev/null || true
wait

# --- Phase 2: Wait for all async deletes (stacks + RDS in parallel) ---
echo "Phase 2: Waiting..."
for region in ${REGIONS}; do
  for stack in $(aws cloudformation list-stacks --stack-status-filter DELETE_IN_PROGRESS \
    --region "${region}" --query "StackSummaries[?starts_with(StackName,'${PROJECT}-')].StackName" --output text 2>/dev/null); do
    aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${region}" 2>/dev/null || true &
  done
  for cluster in $(aws rds describe-db-clusters --region "${region}" \
    --query "DBClusters[?contains(DBClusterIdentifier,'${PROJECT}')].DBClusterIdentifier" --output text 2>/dev/null); do
    echo "  Waiting for cluster ${cluster}..."
    aws rds wait db-cluster-deleted --db-cluster-identifier "${cluster}" --region "${region}" 2>/dev/null || true &
  done
done
wait
aws rds delete-global-cluster --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" --region "${PRIMARY_REGION}" 2>/dev/null || true

# --- Phase 3: Pre-clear all blockers, then retry failed stacks in parallel ---
echo "Phase 3: Retrying failed stacks..."
for attempt in 1 2 3 4 5; do
  failed_list=""
  for region in ${REGIONS}; do
    for stack in $(aws cloudformation list-stacks --stack-status-filter DELETE_FAILED \
      --region "${region}" --query "StackSummaries[?starts_with(StackName,'${PROJECT}-')].StackName" --output text 2>/dev/null); do
      failed_list="${failed_list} ${stack}:${region}"
    done
  done
  [ -z "${failed_list}" ] && break
  echo "  [attempt ${attempt}] $(echo ${failed_list} | wc -w | tr -d ' ') stacks"

  # Pre-clear: wait for any remaining RDS clusters
  for region in ${REGIONS}; do
    for cluster in $(aws rds describe-db-clusters --region "${region}" \
      --query "DBClusters[?contains(DBClusterIdentifier,'${PROJECT}')].DBClusterIdentifier" --output text 2>/dev/null); do
      echo "    Waiting for cluster ${cluster}..."
      aws rds delete-db-cluster --db-cluster-identifier "${cluster}" --skip-final-snapshot --region "${region}" 2>/dev/null || true
      aws rds wait db-cluster-deleted --db-cluster-identifier "${cluster}" --region "${region}" 2>/dev/null || true &
    done
  done
  wait

  # Pre-clear: force-detach + delete all ENIs in all VPCs
  for entry in ${failed_list}; do
    stack="${entry%%:*}"; region="${entry##*:}"
    vpc_id=$(aws cloudformation describe-stacks --stack-name "${stack}" --region "${region}" \
      --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text 2>/dev/null || echo "")
    [ -z "${vpc_id}" ] && continue
    for eni in $(aws ec2 describe-network-interfaces --filters Name=vpc-id,Values="${vpc_id}" \
      --region "${region}" --query "NetworkInterfaces[].NetworkInterfaceId" --output text 2>/dev/null); do
      attach_id=$(aws ec2 describe-network-interfaces --network-interface-ids "${eni}" \
        --region "${region}" --query "NetworkInterfaces[0].Attachment.AttachmentId" --output text 2>/dev/null || echo "None")
      [ "${attach_id}" != "None" ] && [ -n "${attach_id}" ] && \
        aws ec2 detach-network-interface --attachment-id "${attach_id}" --force --region "${region}" 2>/dev/null || true
    done
  done
  # Wait for ENIs to detach then delete
  sleep 15
  for entry in ${failed_list}; do
    stack="${entry%%:*}"; region="${entry##*:}"
    vpc_id=$(aws cloudformation describe-stacks --stack-name "${stack}" --region "${region}" \
      --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text 2>/dev/null || echo "")
    [ -z "${vpc_id}" ] && continue
    for eni in $(aws ec2 describe-network-interfaces --filters Name=vpc-id,Values="${vpc_id}" Name=status,Values=available \
      --region "${region}" --query "NetworkInterfaces[].NetworkInterfaceId" --output text 2>/dev/null); do
      aws ec2 delete-network-interface --network-interface-id "${eni}" --region "${region}" 2>/dev/null || true
    done
  done

  # Retry all failed stacks in parallel
  for entry in ${failed_list}; do
    stack="${entry%%:*}"; region="${entry##*:}"
    (
      aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" 2>/dev/null || true
      aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${region}" 2>/dev/null || true
      # If still failed, retain and move on
      s=$(aws cloudformation describe-stacks --stack-name "${stack}" --region "${region}" \
        --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "GONE")
      if [ "${s}" = "DELETE_FAILED" ]; then
        res=$(aws cloudformation describe-stack-events --stack-name "${stack}" --region "${region}" \
          --query "StackEvents[?ResourceStatus=='DELETE_FAILED' && LogicalResourceId!='${stack}'].LogicalResourceId" --output text 2>/dev/null || echo "")
        [ -n "${res}" ] && aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" --retain-resources ${res} 2>/dev/null || true
        aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${region}" 2>/dev/null || true
      fi
    ) &
  done
  wait
done

# --- Phase 4: Bootstrap ---
echo "Phase 4: Bootstrap..."
aws cloudformation delete-stack --stack-name "${PROJECT}-bootstrap" --region "${PRIMARY_REGION}" 2>/dev/null || true
aws cloudformation wait stack-delete-complete --stack-name "${PROJECT}-bootstrap" --region "${PRIMARY_REGION}" 2>/dev/null || true

rm -rf cdk.out cdk.out.*/
echo "✅ Cleanup complete"
