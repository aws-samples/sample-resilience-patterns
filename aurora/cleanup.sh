#!/bin/bash
set -euo pipefail

PROJECT="${PROJECT:-aurora}"
PRIMARY_REGION="${PRIMARY_REGION:-us-east-1}"
SECONDARY_REGION="${SECONDARY_REGION:-us-west-2}"
GLOBAL_CLUSTER_ID="${PROJECT}-global-cluster"
REGIONS="${PRIMARY_REGION} ${SECONDARY_REGION}"

# Explicit stack list from CDK app (only these stacks will be touched)
PRIMARY_STACKS="${PROJECT}-chaos-primary ${PROJECT}-reconciliation-primary ${PROJECT}-monitoring-primary ${PROJECT}-loadgen ${PROJECT}-synthetics-primary ${PROJECT}-failover-plan ${PROJECT}-dns ${PROJECT}-aurora-app-primary ${PROJECT}-schema ${PROJECT}-db-primary ${PROJECT}-vpc-peering ${PROJECT}-vpc-primary ${PROJECT}-bootstrap"
SECONDARY_STACKS="${PROJECT}-chaos-secondary ${PROJECT}-reconciliation-secondary ${PROJECT}-monitoring-secondary ${PROJECT}-synthetics-secondary ${PROJECT}-aurora-app-secondary ${PROJECT}-db-secondary ${PROJECT}-vpc-secondary"

echo "🧹 Cleaning up ${PROJECT} stacks..."

# --- Helper: get physical resource IDs from a stack by resource type ---
stack_resources() {
  local stack=$1 region=$2 type=$3
  aws cloudformation describe-stack-resources --stack-name "${stack}" --region "${region}" \
    --query "StackResources[?ResourceType=='${type}'].PhysicalResourceId" --output text 2>/dev/null || echo ""
}

# --- Collect VPC IDs and RDS resource IDs from stacks before deleting ---
VPC_ID_PRIMARY=$(aws cloudformation describe-stacks --stack-name "${PROJECT}-vpc-primary" --region "${PRIMARY_REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text 2>/dev/null || echo "")
VPC_ID_SECONDARY=$(aws cloudformation describe-stacks --stack-name "${PROJECT}-vpc-secondary" --region "${SECONDARY_REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text 2>/dev/null || echo "")

RDS_INSTANCES=""
RDS_CLUSTERS=""
for stack_region in "${PROJECT}-db-primary:${PRIMARY_REGION}" "${PROJECT}-db-secondary:${SECONDARY_REGION}"; do
  stack="${stack_region%%:*}"; region="${stack_region##*:}"
  for inst in $(stack_resources "${stack}" "${region}" "AWS::RDS::DBInstance"); do
    RDS_INSTANCES="${RDS_INSTANCES} ${inst}:${region}"
  done
  for cluster in $(stack_resources "${stack}" "${region}" "AWS::RDS::DBCluster"); do
    RDS_CLUSTERS="${RDS_CLUSTERS} ${cluster}:${region}"
  done
done

# --- Phase 0: Stop canaries + remove VPC config from Lambdas (triggers ENI cleanup) ---
echo "Phase 0: Stopping canaries and detaching Lambdas from VPCs..."
for region in ${REGIONS}; do
  for canary in $(aws synthetics describe-canaries --region "${region}" \
    --query "Canaries[].Name" --output text 2>/dev/null); do
    # Only stop canaries whose Lambda is in our VPCs
    fn_arn=$(aws synthetics get-canary --name "${canary}" --region "${region}" \
      --query "Canary.EngineArn" --output text 2>/dev/null || echo "")
    if [ -n "${fn_arn}" ]; then
      fn_vpc=$(aws lambda get-function-configuration --function-name "${fn_arn}" --region "${region}" \
        --query "VpcConfig.VpcId" --output text 2>/dev/null || echo "")
      vpc_id=$([ "${region}" = "${PRIMARY_REGION}" ] && echo "${VPC_ID_PRIMARY}" || echo "${VPC_ID_SECONDARY}")
      if [ "${fn_vpc}" = "${vpc_id}" ]; then
        echo "  Stopping canary: ${canary} (${region})"
        aws synthetics stop-canary --name "${canary}" --region "${region}" 2>/dev/null || true
      fi
    fi
  done
done
# Wait for canaries to stop
sleep 10
for region in ${REGIONS}; do
  vpc_id=$([ "${region}" = "${PRIMARY_REGION}" ] && echo "${VPC_ID_PRIMARY}" || echo "${VPC_ID_SECONDARY}")
  [ -z "${vpc_id}" ] && continue
  for fn in $(aws lambda list-functions --region "${region}" \
    --query "Functions[?VpcConfig.VpcId=='${vpc_id}'].FunctionName" --output text 2>/dev/null); do
    echo "  Detaching: ${fn} (${region})"
    aws lambda update-function-configuration --function-name "${fn}" --vpc-config SubnetIds=[],SecurityGroupIds=[] --region "${region}" 2>/dev/null || true &
  done
done
wait

# --- Phase 1: Fire delete on ALL stacks + nuke RDS (all parallel) ---
echo "Phase 1: Deleting everything..."
for stack in ${PRIMARY_STACKS}; do
  aws cloudformation delete-stack --stack-name "${stack}" --region "${PRIMARY_REGION}" 2>/dev/null || true &
done
for stack in ${SECONDARY_STACKS}; do
  aws cloudformation delete-stack --stack-name "${stack}" --region "${SECONDARY_REGION}" 2>/dev/null || true &
done
# Kill RDS instances from stacks
for entry in ${RDS_INSTANCES}; do
  inst="${entry%%:*}"; region="${entry##*:}"
  echo "  Instance: ${inst} (${region})"
  aws rds delete-db-instance --db-instance-identifier "${inst}" --skip-final-snapshot --region "${region}" 2>/dev/null || true &
done
# Detach from global cluster + kill clusters
for arn in $(aws rds describe-global-clusters --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" --region "${PRIMARY_REGION}" \
  --query "GlobalClusters[0].GlobalClusterMembers[].DBClusterArn" --output text 2>/dev/null || echo ""); do
  [ -z "${arn}" ] || [ "${arn}" = "None" ] && continue
  aws rds remove-from-global-cluster --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" \
    --db-cluster-identifier "${arn}" --region "${PRIMARY_REGION}" 2>/dev/null || true
done
for entry in ${RDS_CLUSTERS}; do
  cluster="${entry%%:*}"; region="${entry##*:}"
  echo "  Cluster: ${cluster} (${region})"
  aws rds delete-db-cluster --db-cluster-identifier "${cluster}" --skip-final-snapshot --region "${region}" 2>/dev/null || true &
done
aws rds delete-global-cluster --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" --region "${PRIMARY_REGION}" 2>/dev/null || true
wait

# --- Phase 2: Wait for stacks + RDS in parallel ---
echo "Phase 2: Waiting..."
for stack in ${PRIMARY_STACKS}; do
  aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${PRIMARY_REGION}" 2>/dev/null || true &
done
for stack in ${SECONDARY_STACKS}; do
  aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${SECONDARY_REGION}" 2>/dev/null || true &
done
for entry in ${RDS_CLUSTERS}; do
  cluster="${entry%%:*}"; region="${entry##*:}"
  echo "  Waiting for cluster ${cluster}..."
  aws rds wait db-cluster-deleted --db-cluster-identifier "${cluster}" --region "${region}" 2>/dev/null || true &
done
wait
aws rds delete-global-cluster --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" --region "${PRIMARY_REGION}" 2>/dev/null || true

# --- Phase 3: Clean all VPC ENIs (force-detach + wait until gone) ---
echo "Phase 3: Cleaning ENIs..."
for region in ${REGIONS}; do
  vpc_id=$([ "${region}" = "${PRIMARY_REGION}" ] && echo "${VPC_ID_PRIMARY}" || echo "${VPC_ID_SECONDARY}")
  [ -z "${vpc_id}" ] && continue
  # Force-detach all
  for eni in $(aws ec2 describe-network-interfaces --filters Name=vpc-id,Values="${vpc_id}" \
    --region "${region}" --query "NetworkInterfaces[].NetworkInterfaceId" --output text 2>/dev/null); do
    attach_id=$(aws ec2 describe-network-interfaces --network-interface-ids "${eni}" \
      --region "${region}" --query "NetworkInterfaces[0].Attachment.AttachmentId" --output text 2>/dev/null || echo "None")
    [ "${attach_id}" != "None" ] && [ -n "${attach_id}" ] && \
      aws ec2 detach-network-interface --attachment-id "${attach_id}" --force --region "${region}" 2>/dev/null || true
  done
  # Loop until all ENIs are deleted
  for _ in $(seq 1 18); do  # 18 × 10s = 3 min max
    enis=$(aws ec2 describe-network-interfaces --filters Name=vpc-id,Values="${vpc_id}" \
      --region "${region}" --query "NetworkInterfaces[].NetworkInterfaceId" --output text 2>/dev/null)
    [ -z "${enis}" ] && break
    for eni in ${enis}; do
      aws ec2 delete-network-interface --network-interface-id "${eni}" --region "${region}" 2>/dev/null || true
    done
    sleep 10
  done &
done
wait

# --- Phase 4: Retry DELETE_FAILED stacks in parallel ---
echo "Phase 4: Retrying failed stacks..."
for attempt in 1 2 3 4 5; do
  failed_list=""
  for stack in ${PRIMARY_STACKS}; do
    s=$(aws cloudformation describe-stacks --stack-name "${stack}" --region "${PRIMARY_REGION}"       --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "GONE")
    [ "${s}" = "DELETE_FAILED" ] && failed_list="${failed_list} ${stack}:${PRIMARY_REGION}"
  done
  for stack in ${SECONDARY_STACKS}; do
    s=$(aws cloudformation describe-stacks --stack-name "${stack}" --region "${SECONDARY_REGION}"       --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "GONE")
    [ "${s}" = "DELETE_FAILED" ] && failed_list="${failed_list} ${stack}:${SECONDARY_REGION}"
  done
  [ -z "${failed_list}" ] && break
  echo "  [attempt ${attempt}] $(echo ${failed_list} | wc -w | tr -d ' ') stacks"

  # Clean ENIs before retrying (canary ENIs may have appeared since Phase 3)
  for region in ${REGIONS}; do
    vpc_id=$([ "${region}" = "${PRIMARY_REGION}" ] && echo "${VPC_ID_PRIMARY}" || echo "${VPC_ID_SECONDARY}")
    [ -z "${vpc_id}" ] && continue
    for eni in $(aws ec2 describe-network-interfaces --filters Name=vpc-id,Values="${vpc_id}" Name=status,Values=available \
      --region "${region}" --query "NetworkInterfaces[].NetworkInterfaceId" --output text 2>/dev/null); do
      aws ec2 delete-network-interface --network-interface-id "${eni}" --region "${region}" 2>/dev/null || true
    done
  done

  for entry in ${failed_list}; do
    stack="${entry%%:*}"; region="${entry##*:}"
    (
      aws cloudformation delete-stack --stack-name "${stack}" --region "${region}" 2>/dev/null || true
      aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${region}" 2>/dev/null || true
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
  sleep 5
done

rm -rf cdk.out cdk.out.*/
echo "✅ Cleanup complete"
