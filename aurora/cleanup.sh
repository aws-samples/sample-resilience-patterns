#!/bin/bash
set -euo pipefail

PROJECT="${PROJECT:-aurora}"
PRIMARY_REGION="${PRIMARY_REGION:-us-east-1}"
SECONDARY_REGION="${SECONDARY_REGION:-us-west-2}"
GLOBAL_CLUSTER_ID="${PROJECT}-global-cluster"
REGIONS="${PRIMARY_REGION} ${SECONDARY_REGION}"

# Explicit stack lists from CDK app (only these stacks will be touched)
# VPC stacks are separate — deleted last after all ENIs have released
NON_VPC_PRIMARY="${PROJECT}-chaos-primary ${PROJECT}-reconciliation-primary ${PROJECT}-monitoring-primary \
${PROJECT}-loadgen ${PROJECT}-failover-plan ${PROJECT}-dns \
${PROJECT}-aurora-app-primary ${PROJECT}-schema ${PROJECT}-db-primary ${PROJECT}-bootstrap"
NON_VPC_SECONDARY="${PROJECT}-chaos-secondary ${PROJECT}-reconciliation-secondary ${PROJECT}-monitoring-secondary \
${PROJECT}-aurora-app-secondary ${PROJECT}-db-secondary"
VPC_STACKS_PRIMARY="${PROJECT}-vpc-peering ${PROJECT}-vpc-primary"
VPC_STACKS_SECONDARY="${PROJECT}-vpc-secondary"

echo "🧹 Cleaning up ${PROJECT} stacks..."

# --- Collect VPC IDs and RDS resource IDs from stacks ---
stack_resources() {
  local stack=$1 region=$2 type=$3
  aws cloudformation describe-stack-resources --stack-name "${stack}" --region "${region}" \
    --query "StackResources[?ResourceType=='${type}'].PhysicalResourceId" --output text 2>/dev/null || echo ""
}

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

# --- Phase 0: Delete canary Lambda functions directly (starts ENI release immediately) ---
echo "Phase 0: Deleting canary Lambdas to start ENI release..."
for region in ${REGIONS}; do
  vpc_id=$([ "${region}" = "${PRIMARY_REGION}" ] && echo "${VPC_ID_PRIMARY}" || echo "${VPC_ID_SECONDARY}")
  [ -z "${vpc_id}" ] && continue
  for fn in $(aws lambda list-functions --region "${region}" \
    --query "Functions[?VpcConfig.VpcId=='${vpc_id}' && starts_with(FunctionName,'cwsyn-')].FunctionName" --output text 2>/dev/null || echo ""); do
    echo "  Deleting: ${fn} (${region})"
    aws lambda delete-function --function-name "${fn}" --region "${region}" 2>/dev/null || true &
  done
done
wait

# --- Phase 1: Delete synthetics stacks FIRST (starts ENI release timer) ---
echo "Phase 1: Deleting synthetics stacks first..."
aws cloudformation delete-stack --stack-name "${PROJECT}-synthetics-primary" --region "${PRIMARY_REGION}" 2>/dev/null || true &
aws cloudformation delete-stack --stack-name "${PROJECT}-synthetics-secondary" --region "${SECONDARY_REGION}" 2>/dev/null || true &
wait
aws cloudformation wait stack-delete-complete --stack-name "${PROJECT}-synthetics-primary" --region "${PRIMARY_REGION}" 2>/dev/null || true &
aws cloudformation wait stack-delete-complete --stack-name "${PROJECT}-synthetics-secondary" --region "${SECONDARY_REGION}" 2>/dev/null || true &
wait

# --- Phase 2: Delete all other non-VPC stacks + nuke RDS ---
echo "Phase 2: Deleting remaining stacks + RDS..."
for stack in ${NON_VPC_PRIMARY}; do
  aws cloudformation delete-stack --stack-name "${stack}" --region "${PRIMARY_REGION}" 2>/dev/null || true &
done
for stack in ${NON_VPC_SECONDARY}; do
  aws cloudformation delete-stack --stack-name "${stack}" --region "${SECONDARY_REGION}" 2>/dev/null || true &
done
for entry in ${RDS_INSTANCES}; do
  inst="${entry%%:*}"; region="${entry##*:}"
  echo "  Instance: ${inst} (${region})"
  aws rds delete-db-instance --db-instance-identifier "${inst}" --skip-final-snapshot --region "${region}" 2>/dev/null || true &
done
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

# --- Phase 2: Wait for non-VPC stacks + RDS ---
echo "Phase 3: Waiting for stacks + RDS..."
for stack in ${NON_VPC_PRIMARY}; do
  aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${PRIMARY_REGION}" 2>/dev/null || true &
done
for stack in ${NON_VPC_SECONDARY}; do
  aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${SECONDARY_REGION}" 2>/dev/null || true &
done
# Wait for instances first, then re-issue cluster deletes, then wait for clusters
for entry in ${RDS_INSTANCES}; do
  inst="${entry%%:*}"; region="${entry##*:}"
  aws rds wait db-instance-deleted --db-instance-identifier "${inst}" --region "${region}" 2>/dev/null || true &
done
wait
for entry in ${RDS_CLUSTERS}; do
  cluster="${entry%%:*}"; region="${entry##*:}"
  aws rds delete-db-cluster --db-cluster-identifier "${cluster}" --skip-final-snapshot --region "${region}" 2>/dev/null || true
done
for entry in ${RDS_CLUSTERS}; do
  cluster="${entry%%:*}"; region="${entry##*:}"
  echo "  Waiting for cluster ${cluster}..."
  aws rds wait db-cluster-deleted --db-cluster-identifier "${cluster}" --region "${region}" 2>/dev/null || true &
done
wait
aws rds delete-global-cluster --global-cluster-identifier "${GLOBAL_CLUSTER_ID}" --region "${PRIMARY_REGION}" 2>/dev/null || true

# --- Phase 3: Clean ENIs then delete VPC stacks ---
echo "Phase 4: Cleaning ENIs and deleting VPC stacks..."
for region in ${REGIONS}; do
  vpc_id=$([ "${region}" = "${PRIMARY_REGION}" ] && echo "${VPC_ID_PRIMARY}" || echo "${VPC_ID_SECONDARY}")
  [ -z "${vpc_id}" ] && continue
  # Wait until VPC has zero ENIs (up to 30 min — Synthetics Lambda ENIs can take this long)
  for _ in $(seq 1 180); do
    enis=$(aws ec2 describe-network-interfaces --filters Name=vpc-id,Values="${vpc_id}" \
      --region "${region}" --query "NetworkInterfaces[].NetworkInterfaceId" --output text 2>/dev/null || echo "")
    [ -z "${enis}" ] && break
    for eni in ${enis}; do
      aws ec2 delete-network-interface --network-interface-id "${eni}" --region "${region}" 2>/dev/null || true
    done
    sleep 10
  done
done
# Now delete VPC stacks (ENIs are gone, SGs/subnets should delete cleanly)
for stack in ${VPC_STACKS_PRIMARY}; do
  aws cloudformation delete-stack --stack-name "${stack}" --region "${PRIMARY_REGION}" 2>/dev/null || true &
done
for stack in ${VPC_STACKS_SECONDARY}; do
  aws cloudformation delete-stack --stack-name "${stack}" --region "${SECONDARY_REGION}" 2>/dev/null || true &
done
wait
for stack in ${VPC_STACKS_PRIMARY}; do
  aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${PRIMARY_REGION}" 2>/dev/null || true &
done
for stack in ${VPC_STACKS_SECONDARY}; do
  aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${SECONDARY_REGION}" 2>/dev/null || true &
done
wait

rm -rf cdk.out cdk.out.*/
echo "✅ Cleanup complete"
